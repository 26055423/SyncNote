// SyncNote: history-only uploader. Pure MQL5; no DLLs, local listener, or trading.
#property strict
#property copyright "SyncNote"
#property version "1.001"
#property description "Read-only history and review charts. HTTPS only; no DLL and no trading permissions required."
#include "SyncNoteHistory.mqh"

input string WebsiteURL="https://sync-trade.top";
input string ConnectionCode="";
input int SyncSeconds=15;
input int HistoryDays=365;
input int OverlapSeconds=3600;
input int ReconcileHours=24; // Periodically replay the whole configured range for older corrections.

CSyncNoteHistory g_snh;
string g_sn_origin="",g_sn_account="",g_sn_server="",g_sn_key="",g_sn_state_path="",g_sn_binding_path="";
string g_sn_cursor="",g_sn_pending="",g_sn_batch="";
long g_sn_from=0,g_sn_to=0,g_sn_completed=0,g_sn_last_full=0;
bool g_sn_full_run=false,g_sn_paused=false;
ulong g_sn_next_upload=0,g_sn_retry_after=0,g_sn_last_paint=0;
int g_sn_failures=0,g_sn_ack_batches=0;
string g_sn_review_ticket="",g_sn_review_symbol="";
long g_sn_review_opened=0,g_sn_review_closed=0;
int g_sn_review_attempts=0;

bool SNOriginValid(string &origin)
{
 while(StringLen(origin)>0&&StringSubstr(origin,StringLen(origin)-1)=="/")origin=StringSubstr(origin,0,StringLen(origin)-1);
 if(StringFind(origin,"https://")!=0||StringLen(origin)<9||StringLen(origin)>253)return false;
 string host=StringSubstr(origin,8);
 if(StringFind(host,"..")>=0||StringSubstr(host,0,1)=="."||StringSubstr(host,StringLen(host)-1)==".")return false;
 for(int i=0;i<StringLen(host);i++)
 {
  ushort c=StringGetCharacter(host,i);
  if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='.'||c=='-'))return false;
 }
 return true; // One user-selected exact HTTPS host; no path, userinfo, port or redirect target setting.
}
bool SNStillBound()
{
 return IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))==g_sn_account&&AccountInfoString(ACCOUNT_SERVER)==g_sn_server;
}
bool SNWriteExact(const string path,const string text)
{
 int f=FileOpen(path,FILE_WRITE|FILE_TXT|FILE_ANSI,0,CP_UTF8);if(f==INVALID_HANDLE)return false;
 uchar bytes[];int expected=StringToCharArray(text,bytes,0,-1,CP_UTF8)-1;
 ResetLastError();uint written=FileWriteString(f,text);FileFlush(f);int error=GetLastError();FileClose(f);
 return written==(uint)expected&&error==0;
}
bool SNBindToken()
{
 if(FileIsExist(g_sn_binding_path))
 {
  int f=FileOpen(g_sn_binding_path,FILE_READ|FILE_TXT|FILE_ANSI,0,CP_UTF8);if(f==INVALID_HANDLE)return false;
  string key=FileReadString(f);FileClose(f);return key==g_sn_key;
 }
 // A token hash binds to one account locally before its first request. The token itself is not persisted.
 return SNWriteExact(g_sn_binding_path,g_sn_key+"\r\n");
}
bool SNSaveState(const long from,const long to,const string cursor,const long completed,const long full)
{
 string body="SYNCNOTE_STATE_1\n"+g_sn_key+"\n"+IntegerToString(from)+"\n"+IntegerToString(to)+"\n"+cursor+"\n"+IntegerToString(completed)+"\n"+IntegerToString(full)+"\n";
 string checksum=SNJHash(body);if(checksum=="")return false;
 string temp=g_sn_state_path+".next";
 if(!SNWriteExact(temp,body+checksum+"\n"))return false;
 return FileMove(temp,0,g_sn_state_path,FILE_REWRITE);
}
bool SNLoadState()
{
 if(!FileIsExist(g_sn_state_path))return true;
 int f=FileOpen(g_sn_state_path,FILE_READ|FILE_TXT|FILE_ANSI,0,CP_UTF8);if(f==INVALID_HANDLE)return false;
 string fields[];ArrayResize(fields,8);
 for(int i=0;i<8;i++){if(FileIsEnding(f)){FileClose(f);return false;}fields[i]=FileReadString(f);}
 bool extra=!FileIsEnding(f);FileClose(f);if(extra)return false;
 string body="";for(int i=0;i<7;i++)body+=fields[i]+"\n";
 if(fields[0]!="SYNCNOTE_STATE_1"||fields[1]!=g_sn_key||SNJHash(body)!=fields[7])return false;
 long from,to,completed,full;
 if(!SNJSignedPositive(fields[2],from)||!SNJSignedPositive(fields[3],to)||!SNJSignedPositive(fields[5],completed)||!SNJSignedPositive(fields[6],full))return false;
 if((from==0)!=(to==0)||completed>32503680000||full>32503680000)return false;
 if(from>0)
 {
  if(!g_snh.Begin(from,to,fields[4],100))return false;
  g_snh.Reset();
 }
 else if(fields[4]!="")return false;
 g_sn_from=from;g_sn_to=to;g_sn_cursor=fields[4];g_sn_completed=completed;g_sn_last_full=full;
 g_sn_full_run=(g_sn_from>0&&g_sn_from<=g_sn_to-(long)MathMax(1,HistoryDays)*86400+60);
 return true;
}
void SNPause(const string reason)
{
 g_sn_paused=true;g_snh.Reset();g_sn_pending="";g_sn_batch="";g_sn_review_ticket="";
 Print("SyncNote paused: ",reason); // No connection code or response body is logged.
}
void SNBackoff(const string reason)
{
 g_sn_failures=MathMin(g_sn_failures+1,8);
 int seconds=MathMin(300,MathMax(3,SyncSeconds)*(1<<(g_sn_failures-1)));
 g_sn_retry_after=GetTickCount64()+(ulong)seconds*1000;
 Print("SyncNote: ",reason,"; retry in ",seconds," seconds (no checkpoint advanced)");
}
int SNPost(const string endpoint,const string body,string &reply)
{
 reply="";if(!SNStillBound())return -2;
 char data[],response[];int n=StringToCharArray(body,data,0,-1,CP_UTF8)-1;ArrayResize(data,n);
 string headers="",request_headers="Content-Type: application/json\r\nAuthorization: Bearer "+ConnectionCode+"\r\n";
 ResetLastError();int code=WebRequest("POST",g_sn_origin+endpoint,request_headers,5000,data,response,headers);
 if(ArraySize(response)>2097152)return -3;
 reply=CharArrayToString(response,0,ArraySize(response),CP_UTF8);return code;
}
void SNAcceptReviewJob(const string reply)
{
 string job,ticket,symbol,opened,closed;
 if(!SNJTop(reply,"review_job",job)||job=="null")return;
 string raw,value;
 if(SNJTop(job,"account",raw)&&(!SNJTopString(job,"account",value)||value!=g_sn_account))return;
 if(SNJTop(job,"server",raw)&&(!SNJTopString(job,"server",value)||value!=g_sn_server))return;
 if(SNJTop(job,"source_account_key",raw)&&(!SNJTopString(job,"source_account_key",value)||value!=g_sn_key))return;
 if(!SNJTopString(job,"ticket",ticket)||!SNJTopString(job,"symbol",symbol)||!SNJTop(job,"opened_server",opened)||!SNJTop(job,"closed_server",closed))return;
 long from,to;
 if(StringLen(ticket)<1||StringLen(ticket)>120||StringLen(symbol)<1||StringLen(symbol)>128||!SNJSignedPositive(opened,from)||!SNJSignedPositive(closed,to)||from<1||to<from)return;
 for(int i=0;i<StringLen(ticket);i++)if(StringGetCharacter(ticket,i)<32)return;
 g_sn_review_ticket=ticket;g_sn_review_symbol=symbol;g_sn_review_opened=from;g_sn_review_closed=to;g_sn_review_attempts=0;
}
void SNTryReview()
{
 if(g_sn_review_ticket==""||!SNStillBound())return;
 g_sn_review_attempts++;
 string charts="",errors="";bool waiting=false;
 ENUM_TIMEFRAMES periods[]={PERIOD_M1,PERIOD_M5,PERIOD_M15,PERIOD_H1};string names[]={"M1","M5","M15","H1"};
 bool available=SymbolSelect(g_sn_review_symbol,true);
 for(int i=0;i<4;i++)
 {
  string rows="",reason="";int seconds=PeriodSeconds(periods[i]);
  long start=g_sn_review_opened-30*seconds,end=g_sn_review_closed+30*seconds;
  if((end-start)/seconds+1>2000)reason="range_too_long";
  else if(!available)reason="symbol_unavailable";
  else
  {
   MqlRates rates[];ArraySetAsSeries(rates,false);
   int count=CopyRates(g_sn_review_symbol,periods[i],(datetime)start,(datetime)end,rates);
   if(count<1||rates[0].time>g_sn_review_opened||rates[count-1].time+seconds<=g_sn_review_closed)reason="history_unavailable";
   else if(count>2000)reason="range_too_long";
   else for(int j=0;j<count;j++)
   {
    if(rows!="")rows+=",";
    rows+="["+IntegerToString((long)rates[j].time)+","+SNJNumber(rates[j].open)+","+SNJNumber(rates[j].high)+","+SNJNumber(rates[j].low)+","+SNJNumber(rates[j].close)+"]";
   }
  }
  if(reason=="history_unavailable")waiting=true;
  if(charts!=""){charts+=",";errors+=",";}
  charts+=SNJQuote(names[i])+":"+(reason==""?"["+rows+"]":"[]");errors+=SNJQuote(names[i])+":"+SNJQuote(reason);
 }
 // At most three local attempts, then report explicit per-timeframe unavailability.
 if(waiting&&g_sn_review_attempts<3)return;
 string body="{\"ticket\":"+SNJQuote(g_sn_review_ticket)+",\"account_key\":"+SNJQuote(g_sn_key)+",\"account\":"+SNJQuote(g_sn_account)+",\"server\":"+SNJQuote(g_sn_server)+
  ",\"opened_server\":"+IntegerToString(g_sn_review_opened)+",\"closed_server\":"+IntegerToString(g_sn_review_closed)+
  ",\"charts\":{"+charts+"},\"errors\":{"+errors+"}}";
 string reply;int code=SNPost("/api/mt5/review",body,reply);
 if(code==200)g_sn_review_ticket="";
 else {Print("SyncNote: review upload pending; HTTP ",code);g_sn_review_ticket="";} // Server keeps the unacknowledged job for a later history ACK.
}
void SNStartRange()
{
 if(g_sn_from==0)
 {
  long now=(long)TimeTradeServer();if(now<1)return;
  bool full=g_sn_completed==0||g_sn_last_full==0||now-g_sn_last_full>=(long)MathMax(1,ReconcileHours)*3600;
  long from=full?MathMax(1,now-(long)HistoryDays*86400):MathMax(1,g_sn_completed-(long)OverlapSeconds);
  if(from>now)from=now;
  // Persist the planned fixed range before scanning, without advancing acknowledged progress.
  // A crash before the first ACK must not slide its oldest boundary forward on restart.
  if(!SNSaveState(from,now,"",g_sn_completed,g_sn_last_full)){SNBackoff("Could not persist planned history range");return;}
  g_sn_to=now;g_sn_from=from;
  g_sn_full_run=full;g_sn_cursor="";
 }
 if(!g_snh.Begin(g_sn_from,g_sn_to,g_sn_cursor,100))SNBackoff("Invalid persisted history request: "+g_snh.Error());
}
void SNBuildPending()
{
 if(!g_snh.Ready()||g_sn_pending!="")return;
 string deals=g_snh.DealsJson(),next=g_snh.NextCursor();
 long server_time=(long)TimeTradeServer(),utc=(long)TimeGMT();
 // Include clock metadata: rebuilding a page after restart may observe a new clock.
 // Its new batch ID is safe because raw deals are independently upserted by stable key.
 g_sn_batch=SNJHash("syncnote-history.v1\n"+g_sn_key+"\n"+IntegerToString(g_sn_from)+"\n"+IntegerToString(g_sn_to)+"\n"+g_sn_cursor+"\n"+deals+"\n"+next+"\n"+IntegerToString(server_time)+"\n"+IntegerToString(utc));
 if(g_sn_batch==""){SNBackoff("Batch hash unavailable");return;}
 string last="0";string parts[];if(next!=""&&StringSplit(next,'|',parts)==7)last=parts[6];
 g_sn_pending="{\"schema\":\"syncnote-history.v1\",\"account_key\":"+SNJQuote(g_sn_key)+",\"account\":"+SNJQuote(g_sn_account)+
  ",\"server\":"+SNJQuote(g_sn_server)+",\"currency\":"+SNJQuote(AccountInfoString(ACCOUNT_CURRENCY))+
  ",\"batch_id\":"+SNJQuote(g_sn_batch)+",\"server_offset_sec\":"+IntegerToString(server_time-utc)+
  ",\"clock\":{\"server\":"+IntegerToString(server_time)+",\"utc\":"+IntegerToString(utc)+"},\"time_basis\":\"broker_server\""+
  ",\"range\":{\"from_server\":"+IntegerToString(g_sn_from)+",\"to_server\":"+IntegerToString(g_sn_to)+"},\"deals\":"+deals+
  ",\"checkpoint\":{\"through_server\":"+IntegerToString(g_snh.ThroughServer())+",\"last_deal_ticket\":"+SNJQuote(last)+
  ",\"window_complete\":"+(g_snh.HasMore()?"false":"true")+",\"next_cursor\":"+SNJQuote(next)+"}}";
}
void SNUploadPending()
{
 if(g_sn_pending==""||!SNStillBound())return;
 string reply;int code=SNPost("/api/mt5/history-sync",g_sn_pending,reply);
 if(!SNStillBound()){SNPause("Account changed while request was in flight; reconfigure connection code before resuming");return;}
 if(code==401||code==403||code==409){SNPause("Authorization/account binding rejected; inspect website connection settings");return;}
 if(code!=200||!SNJAcknowledged(reply,g_sn_key,g_sn_batch)){SNBackoff("History upload or exact batch ACK failed; HTTP "+IntegerToString(code));return;}
 long from=g_sn_from,to=g_sn_to,completed=g_sn_completed,full=g_sn_last_full;
 string next=g_snh.NextCursor();
 if(!g_snh.HasMore()){completed=g_sn_to;if(g_sn_full_run)full=g_sn_to;from=0;to=0;next="";}
 // Durable local state is written only after an exact server ACK, before moving RAM state.
 if(!SNSaveState(from,to,next,completed,full)){SNBackoff("Could not persist acknowledged checkpoint");return;}
 g_sn_from=from;g_sn_to=to;g_sn_cursor=next;g_sn_completed=completed;g_sn_last_full=full;
 g_sn_pending="";g_sn_batch="";g_snh.Reset();g_sn_failures=0;g_sn_retry_after=0;g_sn_ack_batches++;
 g_sn_next_upload=GetTickCount64()+(ulong)MathMax(3,SyncSeconds)*1000;
 SNAcceptReviewJob(reply);
}
void SNPaint()
{
 Comment("SyncNote · 只读历史同步\n",g_sn_account," @ ",g_sn_server,
  "\n网站: ",g_sn_origin,"\n无交易、无 DLL、无本机监听；不上传余额/净值/实时持仓",
  "\n已确认批次: ",g_sn_ack_batches,"；历史范围: ",HistoryDays," 天",
  g_sn_paused?"\n已暂停：请核对账号和连接码后重新挂载。":"\nMT5 运行时自动同步；浏览器可以关闭。");
}
int OnInit()
{
 g_sn_origin=WebsiteURL;
 if(!SNOriginValid(g_sn_origin)||StringLen(ConnectionCode)<16||StringLen(ConnectionCode)>512||SyncSeconds<3||SyncSeconds>3600||HistoryDays<1||HistoryDays>3650||OverlapSeconds<60||OverlapSeconds>7*86400||ReconcileHours<1)
 {Print("SyncNote: invalid HTTPS origin, connection code or timing inputs");return INIT_PARAMETERS_INCORRECT;}
 for(int i=0;i<StringLen(ConnectionCode);i++){ushort c=StringGetCharacter(ConnectionCode,i);if(c<33||c>126){Print("SyncNote: connection code must be printable ASCII without whitespace");return INIT_PARAMETERS_INCORRECT;}}
 g_sn_account=IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));g_sn_server=AccountInfoString(ACCOUNT_SERVER);
 if(g_sn_account=="0"||g_sn_server==""){Print("SyncNote: log into an MT5 account before attaching");return INIT_FAILED;}
 // New history evidence format needs one full replay, including pages ACKed by
 // earlier builds without position-origin fields. Keep the old state recoverable.
 g_sn_key=SNJAccountKey(g_sn_server,g_sn_account);string token_hash=SNJHash(ConnectionCode),scope=SNJHash(g_sn_origin+"\n"+ConnectionCode+"\n"+IntegerToString(HistoryDays)+"\nposition-origin-v1");
 if(g_sn_key==""||token_hash==""||scope=="")return INIT_FAILED;
 FolderCreate("SyncNote");
 g_sn_binding_path="SyncNote\\binding-"+StringSubstr(token_hash,0,24)+".txt";
 g_sn_state_path="SyncNote\\history-"+StringSubstr(g_sn_key,0,24)+"-"+StringSubstr(scope,0,16)+".state";
 if(!SNBindToken()){Print("SyncNote: connection code is locally bound to another account or storage failed. Generate a new connection code.");return INIT_FAILED;}
 if(!SNLoadState()){Print("SyncNote: checkpoint invalid; safely restarting configured history range (server deduplicates)");g_sn_from=0;g_sn_to=0;g_sn_cursor="";g_sn_completed=0;g_sn_last_full=0;g_snh.Reset();}
 if(!EventSetMillisecondTimer(200))return INIT_FAILED;
 SNPaint();return INIT_SUCCEEDED;
}
void OnDeinit(const int reason){EventKillTimer();Comment("");}
void OnTimer()
{
 if(g_sn_paused)return;
 if(!SNStillBound()){SNPause("Account changed; queues cleared and old account authorization not reused");SNPaint();return;}
 ulong now=GetTickCount64();
 if(now-g_sn_last_paint>=2000){g_sn_last_paint=now;SNPaint();}
 if(now<g_sn_retry_after)return;
 if(g_sn_review_ticket!="")
 {
  SNTryReview();g_sn_retry_after=GetTickCount64()+3000;return;
 }
 if(g_snh.Failed()){string error=g_snh.Error();g_snh.Reset();SNBackoff(error);return;}
 if(!g_snh.Busy()&&!g_snh.Ready()&&g_sn_pending=="")
 {
  if(now<g_sn_next_upload)return;SNStartRange();
 }
 g_snh.Pump(32);
 if(g_snh.Ready())SNBuildPending();
 if(g_sn_pending!=""&&GetTickCount64()>=g_sn_next_upload)SNUploadPending();
}
void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
{
 // Notification only. All sources/magics are exported by the pager and overlap reconciliation.
 // Never perform network IO or history scans in the trade transaction event.
}
