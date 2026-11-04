// SyncNote: history-only uploader. Pure MQL5; no DLLs, local listener, or trading.
#property strict
#property copyright "SyncNote"
#property version "1.010"
#property description "Read-only history, review charts and shared K-line track backfill. HTTPS only; no DLL and no trading permissions required."
#include "SyncNoteHistory.mqh"

input string WebsiteURL="https://sync-trade.top";
input string ConnectionCode="";
input int SyncSeconds=15;
input int HistoryDays=365;
input int OverlapSeconds=3600;
input int ReconcileHours=24; // Periodically replay the whole configured range for older corrections.
input bool UploadBars=true;   // 把历史 K 线连续回填进服务器共享数据轨道(供无 MT5 的用户复盘)
input int BarsBackfillYears=5; // 回填最多回溯多少年(夹在"最早交易"与此上限之间)

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
// --- 历史 K 线连续回填(共享数据轨道)---
// 四周期各一个游标(券商墙钟秒),从最新往回填到 floor;到 floor 或 EA 给不出更早即完成。
string g_sn_bf_state_path="";
long g_sn_bf_floor=0;                 // 回填下界(最早交易-100根 与 N 年 取较晚)
long g_sn_bf_cursor[4];               // M1/M5/M15/H1 当前游标
bool g_sn_bf_floored[4];              // 该周期已到可得边界
bool g_sn_bf_done=false,g_sn_bf_inited=false;
int g_sn_bf_tf=0;                     // 当前轮到哪个周期
ulong g_sn_bf_next=0;                 // 下次推进 K 线回填的时刻(和成交上传错开)

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
// --- 历史 K 线连续回填(共享数据轨道)---
// 对齐 SyncTrade 的 backfillBars:四周期从最新往回填满到 floor,查 coverage 跳已填(同券商复用),
// 每段 ≤2000 根,到 floor 或 EA 给不出更早即完成。纯 CopyRates+WebRequest,守只读不变量。
int SNBarsTfSeconds(const int idx){int s[]={60,300,900,3600};return s[idx];}
string SNBarsTfName(const int idx){string n[]={"M1","M5","M15","H1"};return n[idx];}
ENUM_TIMEFRAMES SNBarsTfPeriod(const int idx){ENUM_TIMEFRAMES p[]={PERIOD_M1,PERIOD_M5,PERIOD_M15,PERIOD_H1};return p[idx];}
bool SNBarsSaveState()
{
 string body="SYNCNOTE_BARS_1\n"+g_sn_key+"\n"+IntegerToString(g_sn_bf_floor)+"\n";
 for(int i=0;i<4;i++)body+=IntegerToString(g_sn_bf_cursor[i])+"\n"+(g_sn_bf_floored[i]?"1":"0")+"\n";
 body+=(g_sn_bf_done?"1":"0")+"\n";
 string checksum=SNJHash(body);if(checksum=="")return false;
 string temp=g_sn_bf_state_path+".next";
 if(!SNWriteExact(temp,body+checksum+"\n"))return false;
 return FileMove(temp,0,g_sn_bf_state_path,FILE_REWRITE);
}
void SNBarsLoadState()
{
 for(int i=0;i<4;i++){g_sn_bf_cursor[i]=0;g_sn_bf_floored[i]=false;}
 g_sn_bf_floor=0;g_sn_bf_done=false;
 if(!FileIsExist(g_sn_bf_state_path))return;
 int f=FileOpen(g_sn_bf_state_path,FILE_READ|FILE_TXT|FILE_ANSI,0,CP_UTF8);if(f==INVALID_HANDLE)return;
 string fields[];ArrayResize(fields,13);
 for(int i=0;i<13;i++){if(FileIsEnding(f)){FileClose(f);return;}fields[i]=FileReadString(f);}
 FileClose(f);
 string b="";for(int i=0;i<12;i++)b+=fields[i]+"\n";
 if(fields[0]!="SYNCNOTE_BARS_1"||fields[1]!=g_sn_key||SNJHash(b)!=fields[12])return;
 long v;if(!SNJSignedPositive(fields[2],v))return;g_sn_bf_floor=v;
 for(int i=0;i<4;i++){if(SNJSignedPositive(fields[3+i*2],v))g_sn_bf_cursor[i]=v;g_sn_bf_floored[i]=(fields[4+i*2]=="1");}
 g_sn_bf_done=(fields[11]=="1");
}
void SNBarsInit()
{
 long now=(long)TimeTradeServer();if(now<1)return;
 g_sn_bf_floor=MathMax(1,now-(long)MathMax(1,BarsBackfillYears)*365*86400);
 for(int i=0;i<4;i++){g_sn_bf_cursor[i]=now;g_sn_bf_floored[i]=false;}
 g_sn_bf_done=false;SNBarsLoadState();g_sn_bf_inited=true;
}
// 返回下一个还没填完的周期索引,没有则 -1。
int SNBarsNextTf()
{
 for(int i=0;i<4;i++)if(!g_sn_bf_floored[i]&&g_sn_bf_cursor[i]>g_sn_bf_floor)return i;
 return -1;
}
// 推进一段 K 线回填(查 coverage → CopyRates → POST backfill)。每拍最多发两个 WebRequest。
void SNBarsPump()
{
 if(!UploadBars||g_sn_bf_done||!SNStillBound())return;
 int idx=SNBarsNextTf();
 if(idx<0){if(!g_sn_bf_done){g_sn_bf_done=true;SNBarsSaveState();}return;}
 int period=SNBarsTfSeconds(idx);string tf=SNBarsTfName(idx);
 long to=g_sn_bf_cursor[idx];long from=MathMax(to-2000*period,g_sn_bf_floor);
 if(from>=to){g_sn_bf_cursor[idx]=g_sn_bf_floor;SNBarsSaveState();return;}
 string auth=",\"account_key\":"+SNJQuote(g_sn_key)+",\"account\":"+SNJQuote(g_sn_account)+",\"server\":"+SNJQuote(g_sn_server);
 // 用当前图表品种作回填品种(SyncNote 挂在哪个品种图上就填哪个)。
 string symbol=Symbol();
 // ① 查这段填过没(同券商别人填的直接跳)。失败不致命:退回按整段拉。
 // 可能有多个空洞:本轮只填最右那个,游标前移到该洞左界(advance_to),左侧其余洞下一轮再填,不丢段。
 long fetch_from=from,fetch_to=to,advance_to=from;
 string covbody="{\"symbol\":"+SNJQuote(symbol)+",\"tf\":"+SNJQuote(tf)+",\"from\":"+IntegerToString(from)+",\"to\":"+IntegerToString(to)+auth+"}";
 string covreply;int covcode=SNPost("/api/market/coverage",covbody,covreply);
 if(covcode==200)
 {
  string holesraw;long hf=0,ht=0;
  if(SNJTop(covreply,"holes",holesraw)&&holesraw=="0"){g_sn_bf_cursor[idx]=from;SNBarsSaveState();return;} // 整段已覆盖
  string hfs,hts;
  if(SNJTop(covreply,"hole_from",hfs)&&SNJTop(covreply,"hole_to",hts)&&SNJSignedPositive(hfs,hf)&&SNJSignedPositive(hts,ht)&&ht>hf)
  {fetch_from=MathMax(hf,from);fetch_to=MathMin(ht,to);advance_to=fetch_from;}
 }
 else if(covcode==401||covcode==403||covcode==409){SNPause("K 线回填鉴权被拒;核对连接码");return;}
 // ② 拉这段 K 线。
 if(!SymbolSelect(symbol,true)){g_sn_bf_floored[idx]=true;SNBarsSaveState();return;}
 MqlRates rates[];ArraySetAsSeries(rates,false);
 int count=CopyRates(symbol,SNBarsTfPeriod(idx),(datetime)fetch_from,(datetime)fetch_to,rates);
 if(count<1)
 {
  // EA 一根都给不出(MT5 没加载更早历史):这个周期到可得边界,停在此,不死等。
  // 只凭 count<1 判定——不要用"第一根晚于预期"判,否则周末/长假的正常休市缺口会被误判到底。
  g_sn_bf_floored[idx]=true;SNBarsSaveState();
  Print("SyncNote bars: ",tf," reached available floor (no bars for requested range)");
  return;
 }
 if(count>2000)count=2000;
 string rows="";
 for(int j=0;j<count;j++)
 {
  if(rows!="")rows+=",";
  rows+="["+IntegerToString((long)rates[j].time)+","+SNJNumber(rates[j].open)+","+SNJNumber(rates[j].high)+","+SNJNumber(rates[j].low)+","+SNJNumber(rates[j].close)+","+IntegerToString((long)rates[j].tick_volume)+"]";
 }
 // ③ 回填入库(连续填满;服务器 bars.ingest 幂等去重,墙钟进墙钟出)。
 string body="{\"symbol\":"+SNJQuote(symbol)+",\"tf\":"+SNJQuote(tf)+",\"from_server\":"+IntegerToString(fetch_from)+",\"to_server\":"+IntegerToString(fetch_to)+",\"bars\":["+rows+"]"+auth+"}";
 string reply;int code=SNPost("/api/market/backfill",body,reply);
 // 游标前移到 advance_to(洞左界;无洞=整段 from)。防卡:必须严格小于 to,否则退到 from。
 long next_cursor=(advance_to<to)?advance_to:from;
 if(code==200){g_sn_bf_cursor[idx]=next_cursor;SNBarsSaveState();}
 else if(code==401||code==403||code==409){SNPause("K 线回填鉴权被拒;核对连接码");}
 else Print("SyncNote bars: backfill ",tf," pending; HTTP ",code); // 不前移游标,下拍重试
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
 string bars_line="";
 if(UploadBars)
 {
  if(g_sn_bf_done)bars_line="\nK 线轨道: 已完整";
  else if(g_sn_bf_inited)
  {
   int idx=SNBarsNextTf();
   bars_line=idx<0?"\nK 线轨道: 已完整":"\nK 线轨道回填中: "+SNBarsTfName(idx)+" 已回溯到 "+TimeToString((datetime)g_sn_bf_cursor[idx],TIME_DATE);
  }
  else bars_line="\nK 线轨道: 待初始化";
 }
 Comment("SyncNote · 只读历史同步\n",g_sn_account," @ ",g_sn_server,
  "\n网站: ",g_sn_origin,"\n无交易、无 DLL、无本机监听；不上传余额/净值/实时持仓",
  "\n已确认批次: ",g_sn_ack_batches,"；历史范围: ",HistoryDays," 天",bars_line,
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
 g_sn_bf_state_path="SyncNote\\bars-"+StringSubstr(g_sn_key,0,24)+".state";
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
  // 成交历史已填完这一轮:利用间隙推进一段 K 线回填(与成交上传错开,每拍只发自己的 WebRequest)。
  if(!g_sn_bf_inited)SNBarsInit();
  if(UploadBars&&!g_sn_bf_done&&now>=g_sn_bf_next)
  {
   SNBarsPump();g_sn_bf_next=GetTickCount64()+(ulong)MathMax(3,SyncSeconds)*1000;return;
  }
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
