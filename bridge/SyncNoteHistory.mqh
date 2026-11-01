// Shared read-only MT5 history pager. Pure MQL5; no network, DLL, or trade execution.
// MT5 HistorySelect can block internally: budgets bound our loops, not broker IO.
#ifndef SYNCNOTE_HISTORY_COMMON
#define SYNCNOTE_HISTORY_COMMON
#include "SyncNoteJson.mqh"
#define SNH_SLICE_LIMIT 1024
#define SNH_PAGE_LIMIT 100

class CSyncNoteHistory
{
private:
 int m_stage,m_limit,m_sort,m_emit,m_first,m_total;
 long m_from,m_to,m_window_from,m_window_to,m_after_msc,m_through;
 ulong m_after_ticket;
 string m_account,m_server,m_error,m_json,m_next;
 bool m_more;
 ulong m_tickets[];
 long m_stamps[];
 ulong m_context_positions[],m_context_tickets[];
 long m_context_stamps[];
 string m_context_status[];
 bool Bound()
 {
  return IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))==m_account&&AccountInfoString(ACCOUNT_SERVER)==m_server;
 }
 int ContextIndex(const ulong position)
 {
  for(int i=0;i<ArraySize(m_context_positions);i++)if(m_context_positions[i]==position)return i;
  return -1;
 }
 void CacheContext(const ulong position)
 {
  // Per-page cache, at most one new position query per Pump. Selecting by
  // position replaces MT5's selected list; page tickets are already detached.
  int index=ArraySize(m_context_positions);
  ArrayResize(m_context_positions,index+1);ArrayResize(m_context_tickets,index+1);
  ArrayResize(m_context_stamps,index+1);ArrayResize(m_context_status,index+1);
  m_context_positions[index]=position;m_context_tickets[index]=0;
  m_context_stamps[index]=0;m_context_status[index]="unavailable";
  if(!HistorySelectByPosition(position))return;
  int total=HistoryDealsTotal();
  if(total>SNH_SLICE_LIMIT){m_context_status[index]="too_large";return;}
  ulong first_ticket=0;long first_stamp=0;
  for(int i=0;i<total;i++)
  {
   ulong ticket=HistoryDealGetTicket(i);long kind=0,stamp=0,owner=0;
   if(ticket==0||!HistoryDealGetInteger(ticket,DEAL_TYPE,kind))return;
   if(kind!=DEAL_TYPE_BUY&&kind!=DEAL_TYPE_SELL)continue;
   if(!HistoryDealGetInteger(ticket,DEAL_TIME_MSC,stamp)||stamp<1||
      !HistoryDealGetInteger(ticket,DEAL_POSITION_ID,owner)||(ulong)owner!=position)return;
   if(first_ticket==0||Before(stamp,ticket,first_stamp,first_ticket))
   {first_ticket=ticket;first_stamp=stamp;}
  }
  if(first_ticket==0)return;
  m_context_tickets[index]=first_ticket;m_context_stamps[index]=first_stamp;
  m_context_status[index]="available";
 }
 bool IsAfter(const long stamp,const ulong ticket)
 {
  return stamp>m_after_msc||(stamp==m_after_msc&&ticket>m_after_ticket);
 }
 bool Before(const long a_time,const ulong a_ticket,const long b_time,const ulong b_ticket)
 {
  return a_time<b_time||(a_time==b_time&&a_ticket<b_ticket);
 }
 string Cursor(const long start,const long end,const long after,const ulong ticket)
 {
  return "snh1|"+IntegerToString(m_from)+"|"+IntegerToString(m_to)+"|"+IntegerToString(start)+"|"+IntegerToString(end)+"|"+IntegerToString(after)+"|"+SNJUlong(ticket);
 }
 void Fail(const string reason){m_error=reason;m_stage=-1;}
 void Finish()
 {
  int count=m_emit;bool remains=m_first+count<m_total;
  m_through=remains?m_window_from-1:m_window_to;
  m_more=remains||m_window_to<m_to;
  if(remains&&count>0)
  {
   int last=m_first+count-1;m_next=Cursor(m_window_from,m_window_to,m_stamps[last],m_tickets[last]);
  }
  else if(m_window_to<m_to)
  {
   long start=m_window_to+1;m_next=Cursor(start,MathMin(m_to,start+86399),0,0);
  }
  else m_next="";
  m_json+="]";m_stage=3;
 }
 string DealJson(const ulong ticket)
 {
  if(!HistoryDealSelect(ticket)){Fail("HISTORY_CHANGED: selected deal disappeared; retry same cursor");return "";}
  long stamp=HistoryDealGetInteger(ticket,DEAL_TIME_MSC);
  long kind=HistoryDealGetInteger(ticket,DEAL_TYPE);
  ulong position=(ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
  int context=(kind==DEAL_TYPE_BUY||kind==DEAL_TYPE_SELL)?ContextIndex(position):-1;
  string context_status=context>=0?m_context_status[context]:"unavailable";
  ulong first_ticket=context>=0?m_context_tickets[context]:0;
  long first_stamp=context>=0?m_context_stamps[context]:0;
  // Broker changes after the origin query must never produce a future anchor.
  if(first_stamp>stamp){Fail("HISTORY_CONTEXT_CHANGED: retry same cursor");return "";}
  string symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);
  double values[]={HistoryDealGetDouble(ticket,DEAL_VOLUME),HistoryDealGetDouble(ticket,DEAL_PRICE),HistoryDealGetDouble(ticket,DEAL_PROFIT),HistoryDealGetDouble(ticket,DEAL_COMMISSION),HistoryDealGetDouble(ticket,DEAL_SWAP),HistoryDealGetDouble(ticket,DEAL_FEE)};
  for(int i=0;i<ArraySize(values);i++)if(!MathIsValidNumber(values[i])){Fail("NON_FINITE_DEAL: raw deal requires manual inspection; cursor not advanced");return "";}
  return "{\"deal_ticket\":"+SNJQuote(SNJUlong(ticket))+",\"order_ticket\":"+SNJQuote(SNJUlong((ulong)HistoryDealGetInteger(ticket,DEAL_ORDER)))+
   ",\"position_id\":"+SNJQuote(SNJUlong(position))+
   ",\"position_context_status\":"+SNJQuote(context_status)+
   ",\"position_first_deal_ticket\":"+SNJQuote(SNJUlong(first_ticket))+
   ",\"position_first_time_msc_server\":"+IntegerToString(first_stamp)+
   ",\"time_msc_server\":"+IntegerToString(stamp)+",\"time_server\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_TIME))+
   ",\"type\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_TYPE))+",\"entry\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_ENTRY))+
   ",\"symbol\":"+SNJQuote(symbol)+",\"volume\":"+SNJNumber(values[0])+",\"price\":"+SNJNumber(values[1])+
   ",\"profit\":"+SNJNumber(values[2])+",\"commission\":"+SNJNumber(values[3])+",\"swap\":"+SNJNumber(values[4])+",\"fee\":"+SNJNumber(values[5])+
   ",\"magic\":"+SNJQuote(IntegerToString(HistoryDealGetInteger(ticket,DEAL_MAGIC)))+
   ",\"reason\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_REASON))+",\"comment\":"+SNJQuote(HistoryDealGetString(ticket,DEAL_COMMENT))+
   ",\"external_id\":"+SNJQuote(HistoryDealGetString(ticket,DEAL_EXTERNAL_ID))+"}";
 }
public:
 CSyncNoteHistory(){Reset();}
 void Reset()
 {
  m_stage=0;m_limit=50;m_sort=1;m_emit=0;m_first=0;m_total=0;
  m_from=0;m_to=0;m_window_from=0;m_window_to=0;m_after_msc=0;m_after_ticket=0;m_through=0;
  m_account="";m_server="";m_error="";m_json="[";m_next="";m_more=false;
  ArrayResize(m_tickets,0);ArrayResize(m_stamps,0);
  ArrayResize(m_context_positions,0);ArrayResize(m_context_tickets,0);
  ArrayResize(m_context_stamps,0);ArrayResize(m_context_status,0);
 }
 bool Begin(const long from_server,const long to_server,const string cursor="",const int limit=50)
 {
  Reset();m_stage=4;
  if(from_server<1||to_server<from_server||to_server>4102444800||to_server-from_server>3660*86400||limit<1||limit>SNH_PAGE_LIMIT){Fail("INVALID_HISTORY_RANGE_OR_LIMIT");return false;}
  m_from=from_server;m_to=to_server;m_limit=limit;m_window_from=m_from;m_window_to=MathMin(m_to,m_from+86399);
  m_account=IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));m_server=AccountInfoString(ACCOUNT_SERVER);
  if(m_account=="0"||m_server==""){Fail("ACCOUNT_UNAVAILABLE");return false;}
  if(cursor!="")
  {
   string parts[];long values[];ArrayResize(values,5);
   if(StringSplit(cursor,'|',parts)!=7||parts[0]!="snh1"){Fail("INVALID_CURSOR");return false;}
   for(int i=0;i<5;i++)if(!SNJSignedPositive(parts[i+1],values[i])){Fail("INVALID_CURSOR_NUMBER");return false;}
   if(values[0]!=m_from||values[1]!=m_to||!SNJUnsigned(parts[6],m_after_ticket)){Fail("CURSOR_RANGE_MISMATCH");return false;}
   m_window_from=values[2];m_window_to=values[3];m_after_msc=values[4];
   if(m_window_from<m_from||m_window_to>m_to||m_window_to<m_window_from||m_window_to-m_window_from>86399||
      (m_after_msc!=0&&(m_after_msc<m_window_from*1000||m_after_msc>m_window_to*1000+999))||
      (m_after_msc==0&&m_after_ticket!=0)){Fail("CURSOR_BOUNDS");return false;}
  }
  m_stage=0;return true;
 }
 void Pump(const int budget=16)
 {
  if(!Busy())return;
  if(!Bound()){Fail("ACCOUNT_CHANGED");return;}
  int work=MathMax(1,MathMin(64,budget));
  if(m_stage==0)
  {
   // Only this block uses an index selection, and it immediately captures it.
   // Subsequent events may freely change MT5's selected history collection.
   long select_from=m_after_msc>0?MathMax(m_window_from,m_after_msc/1000):m_window_from;
   ResetLastError();
   if(!HistorySelect((datetime)select_from,(datetime)m_window_to)){Fail("HISTORY_SELECT_FAILED: "+IntegerToString(GetLastError()));return;}
   int total=HistoryDealsTotal();
   if(total>SNH_SLICE_LIMIT)
   {
    if(select_from>=m_window_to){Fail("DENSITY_LIMIT: more than 1024 deals in one server second; no records skipped");return;}
    m_window_from=select_from;m_window_to=select_from+(m_window_to-select_from)/2;
    return; // One select at most per pump, even while narrowing a dense window.
   }
   ArrayResize(m_tickets,total);ArrayResize(m_stamps,total);m_total=total;
   for(int i=0;i<total;i++)
   {
    ulong ticket=HistoryDealGetTicket(i);if(ticket==0){Fail("HISTORY_TICKET_FAILED");return;}
    m_tickets[i]=ticket;m_stamps[i]=HistoryDealGetInteger(ticket,DEAL_TIME_MSC);
   }
   if(total==0)
   {
    if(m_window_to==m_to){Finish();return;}
    m_through=m_window_to;m_window_from=m_window_to+1;m_window_to=MathMin(m_to,m_window_from+86399);m_after_msc=0;m_after_ticket=0;return;
   }
   m_sort=1;m_stage=1;return;
  }
  if(m_stage==1)
  {
   // Insertion sort advances in bounded groups. Selection has already been detached.
   for(int k=0;k<work&&m_sort<m_total;k++,m_sort++)
   {
    ulong ticket=m_tickets[m_sort];long stamp=m_stamps[m_sort];int j=m_sort-1;
    while(j>=0&&Before(stamp,ticket,m_stamps[j],m_tickets[j])){m_tickets[j+1]=m_tickets[j];m_stamps[j+1]=m_stamps[j];j--;}
    m_tickets[j+1]=ticket;m_stamps[j+1]=stamp;
   }
   if(m_sort<m_total)return;
   m_first=0;while(m_first<m_total&&!IsAfter(m_stamps[m_first],m_tickets[m_first]))m_first++;
   m_stage=2;return;
  }
  if(m_stage==2)
  {
   bool queried=false;
   for(int k=0;k<work&&m_emit<m_limit&&m_first+m_emit<m_total;k++)
   {
    int index=m_first+m_emit;ulong ticket=m_tickets[index];
    if(!HistoryDealSelect(ticket)){Fail("HISTORY_CHANGED: selected deal disappeared; retry same cursor");return;}
    long kind=HistoryDealGetInteger(ticket,DEAL_TYPE);
    ulong position=(ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
    if((kind==DEAL_TYPE_BUY||kind==DEAL_TYPE_SELL)&&position>0&&ContextIndex(position)<0)
    {
     if(queried)break;
     queried=true;CacheContext(position);
     if(!Bound()){Fail("ACCOUNT_CHANGED");return;}
    }
    // Re-select the captured ticket after a position query; never keep a list index.
    string row=DealJson(ticket);if(Failed())return;
    if(HistoryDealGetInteger(m_tickets[index],DEAL_TIME_MSC)!=m_stamps[index]){Fail("HISTORY_TIMESTAMP_CHANGED: retry same cursor");return;}
    if(m_emit>0)m_json+=",";m_json+=row;m_emit++;
   }
   if(!Bound()){Fail("ACCOUNT_CHANGED");return;}
   if(m_emit>=m_limit||m_first+m_emit>=m_total)Finish();
  }
 }
 bool Busy(){return m_stage>=0&&m_stage<=2&&m_from>0;}
 bool Ready(){return m_stage==3;}
 bool Failed(){return m_stage<0;}
 string Error(){return m_error;}
 string DealsJson(){return Ready()?m_json:"[]";}
 string NextCursor(){return m_next;}
 bool HasMore(){return m_more;}
 long ThroughServer(){return m_through;}
 long FromServer(){return m_from;}
 long ToServer(){return m_to;}
};
#endif
