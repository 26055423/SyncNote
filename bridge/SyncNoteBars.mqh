// Read-only, bounded recent-bar scheduler. No server coverage is inferred from CopyRates.
#ifndef SYNCNOTE_BARS_V2
#define SYNCNOTE_BARS_V2
#include "SyncNoteJson.mqh"
#define SNB_GAP_LIMIT 256
#define SNB_RECENT_SECONDS 604800
#define SNB_SCAN 0
#define SNB_DELTA 1
#define SNB_REPAIR 2
int SNBarsTfSeconds(const int idx){int s[]={60,300,900,3600};return s[idx];}
string SNBarsTfName(const int idx){string n[]={"M1","M5","M15","H1"};return n[idx];}

class CSyncNoteBars
{
private:
 string m_scope,m_account,m_server,m_symbol;
 long m_scan[4],m_tail[4],m_delta[4],m_retry[4],m_repair[4],m_probe[4],m_seen[4];
 long m_from[4][SNB_GAP_LIMIT],m_to[4][SNB_GAP_LIMIT];
 int m_count[4],m_last[4],m_round;
 long Floor(const int tf,const long now){int p=SNBarsTfSeconds(tf);return ((MathMax(1,now-SNB_RECENT_SECONDS)+p-1)/p)*p;}
 long Target(const int tf,const long now){int p=SNBarsTfSeconds(tf);return now/p*p-p;}
 void Remove(const int tf,const int at)
 {
  for(int j=at;j<m_count[tf]-1;j++){m_from[tf][j]=m_from[tf][j+1];m_to[tf][j]=m_to[tf][j+1];}
  m_count[tf]--;
 }
 void Add(const int tf,long from,long to)
 {
  if(to<from)return;int p=SNBarsTfSeconds(tf),at=0;
  while(at<m_count[tf]&&m_to[tf][at]+p<from)at++;
  while(at<m_count[tf]&&m_from[tf][at]<=to+p)
  {from=MathMin(from,m_from[tf][at]);to=MathMax(to,m_to[tf][at]);Remove(tf,at);}
  // Fragmentation overflow retains a conservative superset, never false coverage.
  if(m_count[tf]>=SNB_GAP_LIMIT)
  {from=MathMin(from,m_from[tf][0]);to=MathMax(to,m_to[tf][m_count[tf]-1]);m_count[tf]=0;at=0;}
  for(int j=m_count[tf];j>at;j--){m_from[tf][j]=m_from[tf][j-1];m_to[tf][j]=m_to[tf][j-1];}
  m_from[tf][at]=from;m_to[tf][at]=to;m_count[tf]++;
 }
 void Refresh(const int tf,const long now)
 {
  long floor=Floor(tf,now),target=Target(tf,now);int p=SNBarsTfSeconds(tf);
  for(int j=m_count[tf]-1;j>=0;j--)
  {if(m_to[tf][j]<floor)Remove(tf,j);else m_from[tf][j]=MathMax(floor,m_from[tf][j]);}
  if(target>m_seen[tf])Add(tf,MathMax(floor,m_seen[tf]+p),target);
  m_seen[tf]=target;
 }
public:
 void Begin(const string scope,const string account,const string server,const string symbol,const long now)
 {
  m_scope=scope;m_account=account;m_server=server;m_symbol=symbol;m_round=0;
  for(int tf=0;tf<4;tf++)
  {
   m_count[tf]=0;m_scan[tf]=Target(tf,now);m_seen[tf]=m_scan[tf];m_tail[tf]=0;m_probe[tf]=0;
   m_delta[tf]=now+60;m_retry[tf]=0;m_repair[tf]=now+600;m_last[tf]=-1;
   Add(tf,Floor(tf,now),m_scan[tf]);
  }
 }
 bool Next(const long now,int &tf,long &from,long &to,int &kind)
 {
  for(int n=0;n<4;n++)
  {
   int i=(m_round+n)%4;Refresh(i,now);int p=SNBarsTfSeconds(i);long floor=Floor(i,now),target=Target(i,now);
   bool scan=m_scan[i]>=floor&&now>=m_retry[i];
   bool repair=m_scan[i]<floor&&m_count[i]>0&&now>=m_repair[i];
   bool delta=now>=m_delta[i];
   if(delta&&(m_last[i]!=SNB_DELTA||(!scan&&!repair)))
   {
    kind=SNB_DELTA;to=target;
    from=MathMax(floor,MathMax(to-1999*p,m_tail[i]>0?m_tail[i]-2*p:to-2*p));
   }
   else if(scan){kind=SNB_SCAN;to=MathMin(m_scan[i],target);from=MathMax(floor,to-1999*p);}
   else if(repair)
   {
    int gap=m_count[i]-1;
    if(m_probe[i]>0){while(gap>=0&&m_from[i][gap]>m_probe[i])gap--;if(gap<0)gap=m_count[i]-1;}
    kind=SNB_REPAIR;to=MathMin(target,m_to[i][gap]);
    if(m_probe[i]>=m_from[i][gap])to=MathMin(to,m_probe[i]);
    from=MathMax(m_from[i][gap],to-1999*p);
   }
   else continue;
   if(to<from)continue;
   tf=i;m_last[i]=kind;m_round=(i+1)%4;return true;
  }
  return false;
 }
 void Failed(const int tf,const int kind,const long now)
 {
  if(kind==SNB_DELTA)m_delta[tf]=now+60;
  else if(kind==SNB_REPAIR)m_repair[tf]=now+600;
  else m_retry[tf]=now+30;
 }
 // Called only AFTER a matching successful server ACK, for real validated rows.
 void Confirm(const int tf,const long from,const long to)
 {
  int p=SNBarsTfSeconds(tf);
  for(int j=m_count[tf]-1;j>=0;j--)
  {
   long a=m_from[tf][j],b=m_to[tf][j];if(b<from||a>to)continue;
   if(from<=a&&to>=b)Remove(tf,j);
   else if(from<=a)m_from[tf][j]=to+p;
   else if(to>=b)m_to[tf][j]=from-p;
   else if(m_count[tf]<SNB_GAP_LIMIT)
   {m_to[tf][j]=from-p;Add(tf,to+p,b);}
   // A full gap array may retain already confirmed interior rows; it cannot lose holes.
  }
  m_tail[tf]=MathMax(m_tail[tf],to);
 }
 void Acknowledged(const int tf,const int kind,const long from,const long now)
 {
  if(kind==SNB_SCAN){m_scan[tf]=from-SNBarsTfSeconds(tf);m_retry[tf]=0;}
  else if(kind==SNB_REPAIR){m_probe[tf]=from-SNBarsTfSeconds(tf);m_repair[tf]=now+600;}
  else m_delta[tf]=now+60;
 }
 bool InitialChecked(const long now){for(int i=0;i<4;i++)if(m_scan[i]>=Floor(i,now))return false;return true;}
 int Gaps(){int n=0;for(int i=0;i<4;i++)n+=m_count[i];return n;}
 long ScanCursor(const int tf){return m_scan[tf];}
 long Tail(const int tf){return m_tail[tf];}
 bool Unconfirmed(const int tf,const long stamp){for(int j=0;j<m_count[tf];j++)if(m_from[tf][j]<=stamp&&m_to[tf][j]>=stamp)return true;return false;}
 string State()
 {
  string b="SYNCNOTE_BARS_2\n"+m_scope+"\n"+m_account+"\n"+m_server+"\n"+m_symbol+"\n";
  for(int i=0;i<4;i++)
  {
   b+=IntegerToString(m_scan[i])+"\n"+IntegerToString(m_tail[i])+"\n"+IntegerToString(m_seen[i])+"\n"+IntegerToString(m_probe[i])+"\n"+IntegerToString(m_count[i])+"\n";
   for(int j=0;j<m_count[i];j++)b+=IntegerToString(m_from[i][j])+"\n"+IntegerToString(m_to[i][j])+"\n";
  }
  return b+SNJHash(b)+"\n";
 }
 bool Load(const string text,const long now)
 {
  string f[];int count=StringSplit(text,'\n',f);if(count<27||f[count-1]!="")return false;
  if(f[0]!="SYNCNOTE_BARS_2"||f[1]!=m_scope||f[2]!=m_account||f[3]!=m_server||f[4]!=m_symbol)return false;
  string b="";for(int i=0;i<count-2;i++)b+=f[i]+"\n";if(SNJHash(b)!=f[count-2])return false;
  // Validate the whole checkpoint before touching any live progress.
  int at=5;long v;
  for(int tf=0;tf<4;tf++)
  {
   for(int j=0;j<4;j++){if(at>=count-2||!SNJSignedPositive(f[at++],v)||v>now)return false;}
   if(at>=count-2||!SNJSignedPositive(f[at++],v)||v>SNB_GAP_LIMIT)return false;
   int gaps=(int)v;long last=0;
   for(int j=0;j<gaps;j++)
   {
    long a,z;int p=SNBarsTfSeconds(tf);
    if(at+1>=count-2||!SNJSignedPositive(f[at++],a)||!SNJSignedPositive(f[at++],z)||a>z||z>now||a%p!=0||z%p!=0||a<=last)return false;
    last=z;
   }
  }
  if(at!=count-2)return false;
  at=5;
  for(int tf=0;tf<4;tf++)
  {
   SNJSignedPositive(f[at++],m_scan[tf]);SNJSignedPositive(f[at++],m_tail[tf]);SNJSignedPositive(f[at++],m_seen[tf]);SNJSignedPositive(f[at++],m_probe[tf]);
   SNJSignedPositive(f[at++],v);m_count[tf]=(int)v;
   for(int j=0;j<m_count[tf];j++){SNJSignedPositive(f[at++],m_from[tf][j]);SNJSignedPositive(f[at++],m_to[tf][j]);}
   Refresh(tf,now);m_delta[tf]=0;m_repair[tf]=now+600;m_retry[tf]=0;m_last[tf]=-1;
  }
  return true;
 }
};

bool SNBarsAcknowledged(const string reply,const int tf,const long from,const long to,const int sent,const string key,const string account,const string server,const string symbol)
{
 string raw,value,summary;long v;
 if(!SNJTop(reply,"ok",raw)||raw!="true"||!SNJTopString(reply,"tf",value)||value!=SNBarsTfName(tf)||!SNJTop(reply,"summary",summary))return false;
 if(!SNJTop(summary,"from_server",raw)||!SNJSignedPositive(raw,v)||v!=from||!SNJTop(summary,"to_server",raw)||!SNJSignedPositive(raw,v)||v!=to)return false;
 if(!SNJTop(summary,"accepted",raw)||!SNJSignedPositive(raw,v)||v!=sent||!SNJTop(summary,"dropped",raw)||raw!="0"||!SNJTop(summary,"complete",raw)||raw!="false")return false;
 if(!SNJTopString(summary,"state",value)||value!=(sent>0?"have":"pending"))return false;
 string names[]={"account_key","account","server","symbol","source"};string expected[]={key,account,server,symbol,"srv:"+server};
 for(int i=0;i<5;i++)if(SNJTop(reply,names[i],raw)&&(!SNJTopString(reply,names[i],value)||value!=expected[i]))return false;
 return true;
}

#ifndef SYNCNOTE_BARS_CORE_ONLY
// --- MT5 IO: include this header AFTER SNPost/SNStillBound/SNPause/SNWriteExact.
CSyncNoteBars g_sn_bars;
string g_sn_bf_state_path="",g_sn_bars_symbol="";
bool g_sn_bf_inited=false;
ulong g_sn_bf_next=0;
ENUM_TIMEFRAMES SNBarsTfPeriod(const int idx){ENUM_TIMEFRAMES p[]={PERIOD_M1,PERIOD_M5,PERIOD_M15,PERIOD_H1};return p[idx];}
bool SNBarsSaveState()
{
 string temp=g_sn_bf_state_path+".next";
 return SNWriteExact(temp,g_sn_bars.State())&&FileMove(temp,0,g_sn_bf_state_path,FILE_REWRITE);
}
void SNBarsInit(const string scope)
{
 long now=(long)TimeTradeServer();if(now<1||scope=="")return;
 g_sn_bars_symbol=Symbol();g_sn_bars.Begin(scope,g_sn_account,g_sn_server,g_sn_bars_symbol,now);
 g_sn_bf_state_path="SyncNote\\bars-v2-"+StringSubstr(SNJHash(scope+"\n"+g_sn_key+"\n"+g_sn_bars_symbol),0,40)+".state";
 // The old bars-*.state/SYNCNOTE_BARS_1 deep-history files are never opened.
 if(FileIsExist(g_sn_bf_state_path))
 {
  int file=FileOpen(g_sn_bf_state_path,FILE_READ|FILE_TXT|FILE_ANSI,0,CP_UTF8);
  if(file!=INVALID_HANDLE)
  {
   string text="";while(!FileIsEnding(file)&&StringLen(text)<131072)text+=FileReadString(file)+"\n";FileClose(file);
   if(!g_sn_bars.Load(text,now))Print("SyncNote bars: invalid recent checkpoint; restarting bounded scan");
  }
 }
 g_sn_bf_inited=true;
}
string SNBarsStatus()
{
 if(!g_sn_bf_inited||g_sn_ack_batches<1)return "\nK 线轨道: 等待首次成交同步确认";
 string state=g_sn_bars.InitialChecked((long)TimeTradeServer())?"最近 7 天已检查":"后台检查最近 7 天";
 return "\nK 线轨道: "+state+(g_sn_bars.Gaps()>0?"；部分空窗未确认，稍后复查":"；已确认行情持续增量同步");
}
bool SNBarsPump()
{
 if(!UploadBars||!g_sn_bf_inited||g_sn_ack_batches<1||!SNStillBound())return false;
 if(Symbol()!=g_sn_bars_symbol){SNPause("Chart symbol changed; reattach SyncNote to rebind its recent bar state");return false;}
 long now=(long)TimeTradeServer(),from,to;int tf,kind;
 if(now<1||!g_sn_bars.Next(now,tf,from,to,kind))return false;
 if(!SymbolSelect(g_sn_bars_symbol,true)){g_sn_bars.Failed(tf,kind,now);return true;}
 MqlRates rates[];ArraySetAsSeries(rates,false);
 int count=CopyRates(g_sn_bars_symbol,SNBarsTfPeriod(tf),(datetime)from,(datetime)to,rates);
 if(!SNStillBound()||Symbol()!=g_sn_bars_symbol){SNPause("Account or symbol changed during recent bar read");return true;}
 if(count<0||count>2000||count>ArraySize(rates)){g_sn_bars.Failed(tf,kind,now);return true;}
 string rows="";int sent=0,p=SNBarsTfSeconds(tf);long last=0,stamps[];ArrayResize(stamps,count);
 for(int j=0;j<count;j++)
 {
  long t=(long)rates[j].time;
  if(t<from||t>to||t%p!=0||t+p>now||t<=last||!MathIsValidNumber(rates[j].open)||!MathIsValidNumber(rates[j].high)||!MathIsValidNumber(rates[j].low)||!MathIsValidNumber(rates[j].close)||rates[j].high<MathMax(rates[j].open,rates[j].close)||rates[j].low>MathMin(rates[j].open,rates[j].close)||rates[j].high<rates[j].low||rates[j].open<=0||rates[j].close<=0||rates[j].low<=0||rates[j].tick_volume<0)continue;
  if(sent>0)rows+=",";
  rows+="["+IntegerToString(t)+","+SNJNumber(rates[j].open)+","+SNJNumber(rates[j].high)+","+SNJNumber(rates[j].low)+","+SNJNumber(rates[j].close)+","+IntegerToString((long)rates[j].tick_volume)+"]";
  last=t;stamps[sent]=t;sent++;
 }
 string body="{\"account_key\":"+SNJQuote(g_sn_key)+",\"account\":"+SNJQuote(g_sn_account)+",\"server\":"+SNJQuote(g_sn_server)+",\"symbol\":"+SNJQuote(g_sn_bars_symbol)+",\"tf\":"+SNJQuote(SNBarsTfName(tf))+",\"from_server\":"+IntegerToString(from)+",\"to_server\":"+IntegerToString(to)+",\"complete\":false,\"bars\":["+rows+"]}";
 string reply;int code=SNPost("/api/market/backfill",body,reply);
 if(!SNStillBound()||Symbol()!=g_sn_bars_symbol){SNPause("Account or symbol changed during recent bar upload");return true;}
 if(code==401||code==403||code==409){SNPause("Recent K-line authorization/account binding rejected; inspect website connection settings");return true;}
 if(code!=200||!SNBarsAcknowledged(reply,tf,from,to,sent,g_sn_key,g_sn_account,g_sn_server,g_sn_bars_symbol))
 {g_sn_bars.Failed(tf,kind,now);Print("SyncNote bars: upload not acknowledged; HTTP ",code);return true;}
 // Only the actual emitted timestamps become confirmed; absent prefix/interior/tail stay holes.
 for(int j=0;j<sent;j++)g_sn_bars.Confirm(tf,stamps[j],stamps[j]);
 g_sn_bars.Acknowledged(tf,kind,from,now);
 if(!SNBarsSaveState())Print("SyncNote bars: recent checkpoint write failed; replay remains idempotent");
 return true;
}
#endif
#endif
