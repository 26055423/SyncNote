#property strict
#property version "1.100"
#property description "Read-only MT5 uploader for Tongpin. Never sends trade orders."
input string WebsiteURL="";
input string ConnectionCode="";
input int SyncSeconds=5;
input int HistoryDays=365;
string ActiveCode="";
ulong pendingDeals[];
ulong historyTickets[];
int historyCursor=0;
datetime lastHistoryRefresh=0;
string ReviewJob="";int ReviewAttempts=0;
string Q(string s){StringReplace(s,"\\","\\\\");StringReplace(s,"\"","\\\"");StringReplace(s,"\r","\\r");StringReplace(s,"\n","\\n");StringReplace(s,"\t","\\t");return "\""+s+"\"";}
string N(double n){return DoubleToString(n,8);}
string Target(ENUM_ORDER_TYPE type,string symbol,double volume,double opened,double price){double result=0;if(price<=0||!OrderCalcProfit(type,symbol,volume,opened,price,result))return "null";return N(result);}
void RefreshHistory(){
 if(!HistorySelect(TimeCurrent()-MathMax(1,HistoryDays)*86400,TimeCurrent()))return;
 ArrayResize(historyTickets,0);
 for(int i=0;i<HistoryDealsTotal();i++){ulong ticket=HistoryDealGetTicket(i);long entry=HistoryDealGetInteger(ticket,DEAL_ENTRY);if(entry==DEAL_ENTRY_OUT||entry==DEAL_ENTRY_OUT_BY){int n=ArraySize(historyTickets);ArrayResize(historyTickets,n+1);historyTickets[n]=ticket;}}
 historyCursor=0;lastHistoryRefresh=TimeCurrent();
}
string ClosedTrade(ulong ticket){
 if(!HistoryDealSelect(ticket))return "";
 long type=HistoryDealGetInteger(ticket,DEAL_TYPE),entry=HistoryDealGetInteger(ticket,DEAL_ENTRY);
 if((type!=DEAL_TYPE_BUY&&type!=DEAL_TYPE_SELL)||(entry!=DEAL_ENTRY_OUT&&entry!=DEAL_ENTRY_OUT_BY))return "";
 ulong position=(ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
 string symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);
 double volume=HistoryDealGetDouble(ticket,DEAL_VOLUME),closed=HistoryDealGetDouble(ticket,DEAL_PRICE),profit=HistoryDealGetDouble(ticket,DEAL_PROFIT)+HistoryDealGetDouble(ticket,DEAL_COMMISSION)+HistoryDealGetDouble(ticket,DEAL_SWAP)+HistoryDealGetDouble(ticket,DEAL_FEE);
 datetime when=(datetime)HistoryDealGetInteger(ticket,DEAL_TIME);
 if(!HistorySelectByPosition(position))return "";
 double remaining=0,average=0,entryFees=0;datetime started=0;bool unsupported=false;
 for(int j=0;j<HistoryDealsTotal();j++){
  ulong d=HistoryDealGetTicket(j);if(d==ticket)break;
  long e=HistoryDealGetInteger(d,DEAL_ENTRY);
  double v=HistoryDealGetDouble(d,DEAL_VOLUME),price=HistoryDealGetDouble(d,DEAL_PRICE);
  if(e==DEAL_ENTRY_INOUT){unsupported=true;break;}
  if(e==DEAL_ENTRY_IN){if(remaining<=0)started=(datetime)HistoryDealGetInteger(d,DEAL_TIME);average=(average*remaining+price*v)/(remaining+v);remaining+=v;entryFees+=HistoryDealGetDouble(d,DEAL_COMMISSION)+HistoryDealGetDouble(d,DEAL_FEE);}
  else if(e==DEAL_ENTRY_OUT||e==DEAL_ENTRY_OUT_BY){if(remaining>0)entryFees*=MathMax(0,remaining-v)/remaining;remaining=MathMax(0,remaining-v);}
 }
 if(unsupported||remaining<=0||average<=0)return "";
 profit+=entryFees*MathMin(1,volume/remaining);
 return "{\"ticket\":"+Q((string)ticket)+",\"symbol\":"+Q(symbol)+",\"side\":"+Q(type==DEAL_TYPE_SELL?"buy":"sell")+",\"volume\":"+N(volume)+",\"open\":"+N(average)+",\"close\":"+N(closed)+",\"profit\":"+N(profit)+",\"opened_server\":"+(string)((long)started)+",\"closed\":"+(string)((long)when)+"}";
}
string EventForDeal(ulong ticket){
 if(!HistoryDealSelect(ticket))return "";
 long type=HistoryDealGetInteger(ticket,DEAL_TYPE),entry=HistoryDealGetInteger(ticket,DEAL_ENTRY);
 if(type!=DEAL_TYPE_BUY&&type!=DEAL_TYPE_SELL)return "";
 bool opening=entry==DEAL_ENTRY_IN;
 if(entry==DEAL_ENTRY_INOUT)return "";
 string kind=opening?"open":"close",symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);
 string text=(opening?(type==DEAL_TYPE_BUY?"买入 ":"卖出 "):"平仓 ")+symbol+" · "+DoubleToString(HistoryDealGetDouble(ticket,DEAL_VOLUME),2)+" 手";
 return "{\"key\":"+Q("deal-"+(string)ticket)+",\"kind\":"+Q(kind)+",\"text\":"+Q(text)+"}";
}

void UploadReview(string job,string base){
 ulong ticket=(ulong)StringToInteger(job);if(ticket==0)return;
 if(ReviewJob!=job){ReviewJob=job;ReviewAttempts=0;}ReviewAttempts++;
 string error="",symbol="";datetime opened=0,closed=0;
 if(HistoryDealSelect(ticket)){
  ulong position=(ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID);symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);closed=(datetime)HistoryDealGetInteger(ticket,DEAL_TIME);
  if(HistorySelectByPosition(position)){
   double remaining=0;
   for(int i=0;i<HistoryDealsTotal();i++){
    ulong d=HistoryDealGetTicket(i);if(d==ticket)break;long e=HistoryDealGetInteger(d,DEAL_ENTRY);double v=HistoryDealGetDouble(d,DEAL_VOLUME);
    if(e==DEAL_ENTRY_IN){if(remaining<=0)opened=(datetime)HistoryDealGetInteger(d,DEAL_TIME);remaining+=v;}
    else if(e==DEAL_ENTRY_OUT||e==DEAL_ENTRY_OUT_BY)remaining=MathMax(0,remaining-v);
    else if(e==DEAL_ENTRY_INOUT){error="unsupported";break;}
   }
  }
 }
 if(opened<=0||closed<=0||symbol=="")error="trade_unavailable";
 string charts="",errors="";bool waiting=false;
 ENUM_TIMEFRAMES periods[4]={PERIOD_M1,PERIOD_M5,PERIOD_M15,PERIOD_H1};string names[4]={"M1","M5","M15","H1"};
 if(error=="")for(int n=0;n<4;n++){
  int sec=PeriodSeconds(periods[n]);string rows="",reason="";
  if((closed-opened)/sec+62>2000)reason="range_too_long";
  else{
   MqlRates rates[];ArraySetAsSeries(rates,false);
   int count=CopyRates(symbol,periods[n],opened-30*sec,closed+30*sec,rates);
   if(count<=0||rates[0].time>opened||rates[count-1].time+sec<=closed)reason="history_unavailable";
   else for(int k=0;k<count;k++){if(rows!="")rows+=",";rows+="["+(string)((long)rates[k].time)+","+N(rates[k].open)+","+N(rates[k].high)+","+N(rates[k].low)+","+N(rates[k].close)+"]";}
  }
  if(reason=="history_unavailable")waiting=true;
  if(charts!=""){charts+=",";errors+=",";}charts+=Q(names[n])+": ["+rows+"]";errors+=Q(names[n])+":"+Q(reason);
 }
 if(waiting&&ReviewAttempts<4)return;
 string body="{\"ticket\":"+Q(job)+",\"opened_server\":"+(string)((long)opened)+",\"closed_server\":"+(string)((long)closed)+",\"error\":"+Q(error)+",\"charts\":{"+charts+"},\"errors\":{"+errors+"}}";
 char bytes[],reply[];StringToCharArray(body,bytes,0,WHOLE_ARRAY,CP_UTF8);ArrayResize(bytes,ArraySize(bytes)-1);string headers;
 int code=WebRequest("POST",base+"/api/mt5/review","Content-Type: application/json\r\nAuthorization: Bearer "+ActiveCode+"\r\n",10000,bytes,reply,headers);
 if(code!=200)Print("Tongpin chart upload failed. HTTP: ",code);
}

void Upload(){
 if(ActiveCode=="")return;
 string positions="",history="",events="";
 for(int i=0;i<PositionsTotal();i++){
  ulong t=PositionGetTicket(i);if(t==0)continue;
  string symbol=PositionGetString(POSITION_SYMBOL);bool buy=PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY;
  double v=PositionGetDouble(POSITION_VOLUME),opened=PositionGetDouble(POSITION_PRICE_OPEN),sl=PositionGetDouble(POSITION_SL),tp=PositionGetDouble(POSITION_TP);
  ENUM_ORDER_TYPE ot=buy?ORDER_TYPE_BUY:ORDER_TYPE_SELL;
  if(positions!="")positions+=",";
  positions+="{\"ticket\":"+Q((string)t)+",\"symbol\":"+Q(symbol)+",\"side\":"+Q(buy?"buy":"sell")+",\"volume\":"+N(v)+",\"open\":"+N(opened)+",\"profit\":"+N(PositionGetDouble(POSITION_PROFIT))+",\"sl\":"+N(sl)+",\"tp\":"+N(tp)+",\"sl_profit\":"+Target(ot,symbol,v,opened,sl)+",\"tp_profit\":"+Target(ot,symbol,v,opened,tp)+"}";
 }
 if(lastHistoryRefresh==0||TimeCurrent()-lastHistoryRefresh>3600)RefreshHistory();
 int next=MathMin(historyCursor+150,ArraySize(historyTickets));
 for(int i=historyCursor;i<next;i++){string h=ClosedTrade(historyTickets[i]);if(h!=""){if(history!="")history+=",";history+=h;}}
 int count=MathMin(80,ArraySize(pendingDeals));
 for(int i=0;i<count;i++){
  string e=EventForDeal(pendingDeals[i]);if(e!=""){if(events!="")events+=",";events+=e;}
  string h=ClosedTrade(pendingDeals[i]);if(h!=""){if(history!="")history+=",";history+=h;}
 }
 string body="{\"snapshot\":{\"clock\":{\"server\":"+(string)((long)TimeTradeServer())+",\"utc\":"+(string)((long)TimeGMT())+"},\"account\":"+Q((string)AccountInfoInteger(ACCOUNT_LOGIN))+",\"broker\":"+Q(AccountInfoString(ACCOUNT_SERVER))+",\"currency\":"+Q(AccountInfoString(ACCOUNT_CURRENCY))+",\"balance\":"+N(AccountInfoDouble(ACCOUNT_BALANCE))+",\"equity\":"+N(AccountInfoDouble(ACCOUNT_EQUITY))+",\"online\":"+(TerminalInfoInteger(TERMINAL_CONNECTED)?"true":"false")+",\"positions\":["+positions+"],\"history\":["+history+"]},\"events\":["+events+"]}";
 string base=WebsiteURL;while(StringLen(base)>0&&StringSubstr(base,StringLen(base)-1)=="/")base=StringSubstr(base,0,StringLen(base)-1);
 char bytes[],reply[];StringToCharArray(body,bytes,0,WHOLE_ARRAY,CP_UTF8);ArrayResize(bytes,ArraySize(bytes)-1);string responseHeaders;
 int code=WebRequest("POST",base+"/api/snapshot","Content-Type: application/json\r\nAuthorization: Bearer "+ActiveCode+"\r\n",5000,bytes,reply,responseHeaders);
 if(code==200){historyCursor=next;int left=ArraySize(pendingDeals)-count;for(int i=0;i<left;i++)pendingDeals[i]=pendingDeals[count+i];ArrayResize(pendingDeals,left);string answer=CharArrayToString(reply,0,-1,CP_UTF8);string key="\"review_ticket\": \"";int at=StringFind(answer,key);if(at>=0){at+=StringLen(key);int end=StringFind(answer,"\"",at);if(end>at)UploadReview(StringSubstr(answer,at,end-at),base);}}
 else {string detail=CharArrayToString(reply,0,-1,CP_UTF8);if(code==-1)detail="MT5 error "+(string)GetLastError();Print("Tongpin upload failed. HTTP: ",code,". ",detail);}
}
int OnInit(){ActiveCode=ConnectionCode;if(ActiveCode==""){int f=FileOpen("TongpinConnection.txt",FILE_READ|FILE_TXT|FILE_ANSI);if(f!=INVALID_HANDLE){ActiveCode=FileReadString(f);FileClose(f);}}if(ActiveCode==""){Print("Tongpin: connection assistant has not configured this terminal.");return INIT_FAILED;}EventSetTimer(MathMax(3,SyncSeconds));return INIT_SUCCEEDED;}
void OnDeinit(const int reason){EventKillTimer();}
void OnTimer(){Upload();}
void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result){if(trans.type==TRADE_TRANSACTION_DEAL_ADD&&trans.deal>0){int n=ArraySize(pendingDeals);ArrayResize(pendingDeals,n+1);pendingDeals[n]=trans.deal;}}
