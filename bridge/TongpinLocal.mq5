// Tongpin Local v1 - compile this open source EA yourself in MetaEditor.
// Windows MT5 only; system Ws2_32.dll + bcrypt.dll; no Python or custom DLL.
// No MT5 password/account credential is read, accepted from the web, or uploaded.
// Trading is OFF by default and this initial release rejects ALL real accounts.
#property copyright "Tongpin / SyncNote"
#property version "1.000"
#property strict
#property description "Windows localhost WebSocket EA. Default read-only; demo-only trading. Allow system DLL imports."

#include "TongpinLocalJson.mqh"
#include "TongpinLocalSocket.mqh"

input string InpAllowedOrigin="https://sync-trade.top"; // Exact HTTPS website origin, no trailing slash
input string InpSymbol="XAUUSD";                      // Exact broker symbol, suffix included
input bool InpAllowTrading=false;                    // Explicit local opt-in; demo accounts only
input double InpMaxOrderLots=0.10;                   // Maximum market order / partial close lots
input double InpMaxSymbolLots=1.00;                  // Maximum gross exposure on selected symbol
input int InpMaxDeviationPoints=20;                  // Maximum requested deviation in broker points
input int InpMaxSpreadPoints=100;                    // 0 disables this additional local spread gate
input long InpMagic=26055423;                        // Magic assigned to new website orders
input bool InpManageOwnMagicOnly=true;               // Close/cancel/modify only this EA's magic
input bool InpAllowClose=true;
input bool InpAllowCancel=true;
input bool InpAllowModify=true;

#define LOCAL_PORT 18765
#define LOCAL_VERSION "0.100"
#define JOURNAL_MAX 10000
#define PAIR_TTL_MS 120000

string g_account="",g_server="",g_epoch="",g_instance="",g_token="";
string g_pair_code="";
ulong g_pair_until=0;
int g_pair_attempts=0,g_pending_peer=-1,g_session_peer=-1;
ulong g_pending_until=0;
ulong g_last_tick=0,g_last_snapshot=0,g_last_command=0;
bool g_force_snapshot=true,g_journal_ok=false,g_account_stable=false;
int g_journal=INVALID_HANDLE;
string g_journal_path="";
int g_digits=5;
long g_offset=0;
string g_button_allow="TongpinLocal.Allow",g_button_revoke="TongpinLocal.Revoke";

struct LocalCommandEntry
{
   string id;
   string fingerprint;
   string state;
   string result;
   ulong broker_order;
   ulong broker_deal;
};
LocalCommandEntry g_commands[];

struct LocalBarsJob
{
   bool active;
   int peer;
   string request_id;
   string tf;
   int limit;
   int next;
   string rows;
   MqlRates rates[];
};
LocalBarsJob g_bars_job;

bool LocalDemo() { return AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_DEMO; }
bool LocalCanTrade()
{
   // Netting can merge with manual/other-EA exposure, defeating magic ownership checks.
   return InpAllowTrading && LocalDemo() && AccountInfoInteger(ACCOUNT_MARGIN_MODE)==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING && g_journal_ok && g_account_stable;
}
string JsonBool(const bool value) { return value ? "true" : "false"; }
string CapabilitiesJson()
{
   if(!LocalCanTrade()) return "[]";
   string capabilities="[\"market\"";
   if(InpAllowClose) capabilities+=",\"close\"";
   if(InpAllowCancel) capabilities+=",\"cancel\"";
   if(InpAllowModify) capabilities+=",\"modify\"";
   return capabilities+"]";
}
string IdentityFields()
{
   return "\"instance_id\":"+JStr(g_instance)+",\"account_id\":"+JStr(g_account)+",\"server\":"+JStr(g_server)+",\"epoch\":"+JStr(g_epoch)+
      ",\"demo\":"+JsonBool(LocalDemo())+",\"read_only\":"+JsonBool(!LocalCanTrade())+",\"trade_enabled\":"+JsonBool(LocalCanTrade())+",\"capabilities\":"+CapabilitiesJson();
}
void LocalError(const int peer,const string code,const string message,const string request_id="")
{
   WsText(peer,"{\"type\":\"error\",\"code\":"+JStr(code)+",\"error\":"+JStr(message)+",\"request_id\":"+JStr(request_id)+"}");
}
bool SecureEqual(const string a,const string b)
{
   int na=StringLen(a),nb=StringLen(b);int difference=na^nb;
   int n=MathMax(na,nb);
   if(n>256) return false;
   for(int i=0;i<n;i++) difference|=(i<na ? StringGetCharacter(a,i) : 0)^(i<nb ? StringGetCharacter(b,i) : 0);
   return difference==0;
}
bool NewPairCode()
{
   uchar bytes[];uint number=0;
   for(int i=0;i<16;i++)
   {
      if(!RandomBytes(bytes,4)) return false;
      number=(uint)bytes[0]|((uint)bytes[1]<<8)|((uint)bytes[2]<<16)|((uint)bytes[3]<<24);
      if(number<4200000000) break;
      if(i==15) return false;
   }
   g_pair_code=StringFormat("%08u",number%100000000);
   g_pair_until=GetTickCount64()+PAIR_TTL_MS;g_pair_attempts=0;
   return true;
}
void MakeButton(const string name,const string label,const int x)
{
   if(ObjectFind(0,name)<0) ObjectCreate(0,name,OBJ_BUTTON,0,0,0);
   ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);ObjectSetInteger(0,name,OBJPROP_YDISTANCE,150);
   ObjectSetInteger(0,name,OBJPROP_XSIZE,165);ObjectSetInteger(0,name,OBJPROP_YSIZE,30);
   ObjectSetInteger(0,name,OBJPROP_COLOR,clrWhite);ObjectSetInteger(0,name,OBJPROP_BGCOLOR,clrDarkSlateGray);
   ObjectSetString(0,name,OBJPROP_TEXT,label);
}
void PaintStatus()
{
   string mode=LocalCanTrade() ? "DEMO trading enabled / 模拟交易已开启" : "READ ONLY / 只读";
   string pending=g_pending_peer>=0 ? "\n网站已输入正确配对码，请核对来源及账号后点击下方【允许本次连接】。" : "";
   Comment("同频本机 EA ",LOCAL_VERSION,"\n",mode,"\n网站来源: ",InpAllowedOrigin,
      "\n账号: ",g_account," @ ",g_server,"\n品种: ",InpSymbol,
      "\n配对码: ",g_pair_code," (",IntegerToString((long)MathMax(0,(long)(g_pair_until-GetTickCount64())/1000)),"s)",
      "\n只监听 127.0.0.1:18765; 不读取/上传交易密码",pending,
      g_journal_ok ? "" : "\n交易日志不可用，禁止交易。");
   ChartRedraw();
}
void ClearAuthorization()
{
   g_token="";g_pending_peer=-1;g_pending_until=0;g_session_peer=-1;
   g_bars_job.active=false;
   for(int i=0;i<LOCAL_PEERS;i++)
   {
      if(g_local_peers[i].authenticated) WsClose(i,1008);
      g_local_peers[i].authenticated=false;
   }
}
int CommandFind(const string id)
{
   for(int i=ArraySize(g_commands)-1;i>=0;i--) if(g_commands[i].id==id) return i;
   return -1;
}
string CommandResult(const string id,const string state,const string error,const uint retcode=0,
                     const ulong order=0,const ulong deal=0,const double price=0,const double volume=0)
{
   return "{\"type\":\"command_result\",\"command_id\":"+JStr(id)+",\"state\":"+JStr(state)+
      ",\"ok\":"+JsonBool(state=="completed"||state=="submitted")+",\"retcode\":"+IntegerToString(retcode)+
      ",\"order\":"+JStr(IntegerToString((long)order))+",\"deal\":"+JStr(IntegerToString((long)deal))+
      ",\"price\":"+JNum(price,g_digits)+",\"volume\":"+JNum(volume,8)+",\"partial\":"+JsonBool(retcode==10010)+
      ",\"error\":"+JStr(error)+",\"server_time_ms\":"+IntegerToString(LocalUtcMs())+","+IdentityFields()+"}";
}
string CurrentResultIdentity(const string result)
{
   int start=StringFind(result,",\"server_time_ms\":");
   return start<0 ? result : StringSubstr(result,0,start)+",\"server_time_ms\":"+IntegerToString(LocalUtcMs())+","+IdentityFields()+"}";
}
ulong ResultTicket(const string result,const string key)
{
   string needle="\""+key+"\":\"";int begin=StringFind(result,needle);
   if(begin<0) return 0;
   begin+=StringLen(needle);int end=StringFind(result,"\"",begin);
   if(end<begin || end-begin>19) return 0;
   string number=StringSubstr(result,begin,end-begin);
   for(int i=0;i<StringLen(number);i++) if(StringGetCharacter(number,i)<'0'||StringGetCharacter(number,i)>'9') return 0;
   return (ulong)StringToInteger(number);
}
bool JournalAppend(const int index)
{
   if(g_journal==INVALID_HANDLE) return false;
   string row=g_commands[index].id+"\t"+g_commands[index].fingerprint+"\t"+g_commands[index].state+"\t"+g_commands[index].result+"\r\n";
   uchar encoded[];int expected=StringToCharArray(row,encoded,0,-1,CP_UTF8)-1;
   ResetLastError();FileSeek(g_journal,0,SEEK_END);
   uint wrote=FileWriteString(g_journal,row);FileFlush(g_journal);
   if(wrote!=(uint)expected || GetLastError()!=0) {g_journal_ok=false;return false;}
   return true;
}
bool OpenJournal()
{
   if(g_journal!=INVALID_HANDLE) FileClose(g_journal);
   g_journal=INVALID_HANDLE;g_journal_ok=false;ArrayResize(g_commands,0);
   FolderCreate("TongpinLocal");
   string account_hash=HashHex(g_account+"@"+g_server);
   if(account_hash=="") return false;
   g_journal_path="TongpinLocal\\commands-"+StringSubstr(account_hash,0,24)+".journal";
   // Do not share write access: a second EA instance must not bypass the account journal.
   g_journal=FileOpen(g_journal_path,FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI,0,CP_UTF8);
   if(g_journal==INVALID_HANDLE) return false;
   while(!FileIsEnding(g_journal))
   {
      string line=FileReadString(g_journal);
      if(line=="") continue;
      string parts[];
      if(StringSplit(line,9,parts)!=4 || !SafeCommandId(parts[0]) || StringLen(parts[1])!=64) return false;
      int i=CommandFind(parts[0]);
      if(i<0)
      {
         i=ArraySize(g_commands);if(i>=JOURNAL_MAX) return false;
         ArrayResize(g_commands,i+1);g_commands[i].id=parts[0];g_commands[i].fingerprint=parts[1];
      }
      if(g_commands[i].fingerprint!=parts[1]) return false;
      g_commands[i].state=parts[2];g_commands[i].result=parts[3];
      g_commands[i].broker_order=ResultTicket(parts[3],"order");g_commands[i].broker_deal=ResultTicket(parts[3],"deal");
      if(parts[2]!="intent" && parts[2]!="completed" && parts[2]!="submitted" && parts[2]!="rejected" && parts[2]!="uncertain") return false;
   }
   g_journal_ok=true;
   for(int i=0;i<ArraySize(g_commands);i++)
   {
      // Crash after durable intent may be before or after broker execution. Never replay.
      if(g_commands[i].state=="intent" || g_commands[i].state=="submitted")
      {
         g_commands[i].state="uncertain";
         g_commands[i].result=CommandResult(g_commands[i].id,"uncertain","Recovered pending command; inspect broker history. Automatic replay is prohibited.",0,g_commands[i].broker_order,g_commands[i].broker_deal);
         if(!JournalAppend(i)) return false;
      }
   }
   return true;
}
void AccountChanged()
{
   string login=IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   string server=AccountInfoString(ACCOUNT_SERVER);
   if(login==g_account && server==g_server) return;
   ClearAuthorization();g_account_stable=false;
   g_account=login;g_server=server;g_epoch=RandomHex(16);
   if(g_epoch=="" || !NewPairCode()) {Print("TongpinLocal: cryptographic random generator unavailable");return;}
   g_journal_ok=OpenJournal();
   g_account_stable=(AccountInfoInteger(ACCOUNT_LOGIN)>0 && server!="");
   g_force_snapshot=true;PaintStatus();
}
void LocalOpened(const int index)
{
   // Reject additional upgraded connections. Origin authorizes the website, not the user.
   for(int i=0;i<LOCAL_PEERS;i++)
      if(i!=index && g_local_peers[i].upgraded && !g_local_peers[i].closing) {WsClose(index,1008);return;}
   WsText(index,"{\"type\":\"hello\",\"protocol\":\"tongpin-local\",\"version\":1,\"ea_version\":"+JStr(LOCAL_VERSION)+
      ",\"instance_id\":"+JStr(g_instance)+",\"pairing_required\":true}");
}
void LocalClosed(const int index)
{
   if(g_session_peer==index) {g_session_peer=-1;g_token="";NewPairCode();}
   if(g_pending_peer==index) {g_pending_peer=-1;g_pending_until=0;}
   if(g_bars_job.active && g_bars_job.peer==index) g_bars_job.active=false;
}
string TickJson()
{
   MqlTick t;if(!SymbolInfoTick(InpSymbol,t)) return "null";
   return "{\"symbol\":"+JStr(InpSymbol)+",\"bid\":"+JNum(t.bid,g_digits)+",\"ask\":"+JNum(t.ask,g_digits)+
      ",\"time\":"+IntegerToString((long)t.time-g_offset)+",\"time_msc\":"+IntegerToString(t.time_msc-g_offset*1000)+"}";
}
string PositionsJson()
{
   string rows="[";int emitted=0;
   for(int i=0;i<PositionsTotal();i++)
   {
      ulong ticket=PositionGetTicket(i);if(ticket==0) continue;
      if(emitted++>0) rows+=",";
      string symbol=PositionGetString(POSITION_SYMBOL);int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      rows+="{\"ticket\":"+JStr(IntegerToString((long)ticket))+",\"symbol\":"+JStr(symbol)+
         ",\"side\":"+JStr(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY ? "buy" : "sell")+
         ",\"volume\":"+JNum(PositionGetDouble(POSITION_VOLUME),8)+",\"price_open\":"+JNum(PositionGetDouble(POSITION_PRICE_OPEN),digits)+
         ",\"sl\":"+JNum(PositionGetDouble(POSITION_SL),digits)+",\"tp\":"+JNum(PositionGetDouble(POSITION_TP),digits)+
         ",\"profit\":"+JNum(PositionGetDouble(POSITION_PROFIT),2)+",\"magic\":"+IntegerToString(PositionGetInteger(POSITION_MAGIC))+"}";
      if(emitted>=500) break;
   }
   return rows+"]";
}
string OrdersJson()
{
   string rows="[";int emitted=0;
   for(int i=0;i<OrdersTotal();i++)
   {
      ulong ticket=OrderGetTicket(i);if(ticket==0) continue;
      if(emitted++>0) rows+=",";
      string symbol=OrderGetString(ORDER_SYMBOL);int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      long kind=OrderGetInteger(ORDER_TYPE);
      string name=(kind==ORDER_TYPE_BUY_LIMIT ? "buy_limit" : kind==ORDER_TYPE_SELL_LIMIT ? "sell_limit" : kind==ORDER_TYPE_BUY_STOP ? "buy_stop" : kind==ORDER_TYPE_SELL_STOP ? "sell_stop" : "other");
      rows+="{\"ticket\":"+JStr(IntegerToString((long)ticket))+",\"symbol\":"+JStr(symbol)+",\"type\":"+JStr(name)+
         ",\"volume\":"+JNum(OrderGetDouble(ORDER_VOLUME_CURRENT),8)+",\"price\":"+JNum(OrderGetDouble(ORDER_PRICE_OPEN),digits)+
         ",\"sl\":"+JNum(OrderGetDouble(ORDER_SL),digits)+",\"tp\":"+JNum(OrderGetDouble(ORDER_TP),digits)+
         ",\"magic\":"+IntegerToString(OrderGetInteger(ORDER_MAGIC))+"}";
      if(emitted>=500) break;
   }
   return rows+"]";
}
void SendSnapshot(const int peer)
{
   string account="{\"login\":"+JStr(g_account)+",\"server\":"+JStr(g_server)+
      ",\"balance\":"+JNum(AccountInfoDouble(ACCOUNT_BALANCE),2)+",\"equity\":"+JNum(AccountInfoDouble(ACCOUNT_EQUITY),2)+
      ",\"margin\":"+JNum(AccountInfoDouble(ACCOUNT_MARGIN),2)+",\"free_margin\":"+JNum(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2)+
      ",\"profit\":"+JNum(AccountInfoDouble(ACCOUNT_PROFIT),2)+",\"currency\":"+JStr(AccountInfoString(ACCOUNT_CURRENCY))+"}";
   WsText(peer,"{\"type\":\"snapshot\","+IdentityFields()+",\"account\":"+account+",\"positions\":"+PositionsJson()+
      ",\"orders\":"+OrdersJson()+",\"tick\":"+TickJson()+",\"bars\":{},\"server_time_ms\":"+IntegerToString(LocalUtcMs())+"}");
}
ENUM_TIMEFRAMES LocalTf(const string tf)
{
   if(tf=="1m") return PERIOD_M1;if(tf=="5m") return PERIOD_M5;if(tf=="15m") return PERIOD_M15;if(tf=="1h") return PERIOD_H1;
   return PERIOD_CURRENT;
}
void BeginBars(const int peer,const string js)
{
   string request_id="",tf="",symbol="";double limit=300;
   JsonGetString(js,"request_id",request_id);JsonGetString(js,"tf",tf);JsonGetString(js,"symbol",symbol);
   if(symbol!="" && symbol!=InpSymbol) {LocalError(peer,"SYMBOL","Only configured EA symbol is available",request_id);return;}
   if(!JsonNumber(js,"limit",limit,300) || limit<1 || limit>500 || limit!=MathFloor(limit) || LocalTf(tf)==PERIOD_CURRENT)
   {LocalError(peer,"BARS_REQUEST","tf must be 1m/5m/15m/1h; limit 1..500",request_id);return;}
   if(StringLen(request_id)>80) {LocalError(peer,"REQUEST_ID","request_id too long");return;}
   if(g_bars_job.active) {LocalError(peer,"BARS_BUSY","Wait for current history response",request_id);return;}
   // Never wait for a large history download in the EA network event handler.
   if(!SeriesInfoInteger(InpSymbol,LocalTf(tf),SERIES_SYNCHRONIZED))
   {LocalError(peer,"HISTORY_UNAVAILABLE","Open this symbol/timeframe in MT5 to load history first",request_id);return;}
   g_bars_job.peer=peer;g_bars_job.request_id=request_id;g_bars_job.tf=tf;g_bars_job.limit=(int)limit;
   g_bars_job.next=0;g_bars_job.rows="";ArrayResize(g_bars_job.rates,0);
   int count=CopyRates(InpSymbol,LocalTf(tf),0,(int)limit,g_bars_job.rates);
   if(count<1) {LocalError(peer,"HISTORY_UNAVAILABLE","MT5 history is not ready",request_id);return;}
   g_bars_job.limit=count;g_bars_job.active=true;
}
void PumpBars()
{
   if(!g_bars_job.active) return;
   if(!g_local_peers[g_bars_job.peer].authenticated) {g_bars_job.active=false;return;}
   int end=MathMin(g_bars_job.limit,g_bars_job.next+50);
   for(int i=g_bars_job.next;i<end;i++)
   {
      if(i>0) g_bars_job.rows+=",";
      g_bars_job.rows+="["+IntegerToString((long)g_bars_job.rates[i].time-g_offset)+","+JNum(g_bars_job.rates[i].open,g_digits)+","+
         JNum(g_bars_job.rates[i].high,g_digits)+","+JNum(g_bars_job.rates[i].low,g_digits)+","+JNum(g_bars_job.rates[i].close,g_digits)+","+
         IntegerToString(g_bars_job.rates[i].tick_volume)+"]";
   }
   g_bars_job.next=end;
   if(end<g_bars_job.limit) return;
   WsText(g_bars_job.peer,"{\"type\":\"bars\",\"request_id\":"+JStr(g_bars_job.request_id)+",\"symbol\":"+JStr(InpSymbol)+
      ",\"tf\":"+JStr(g_bars_job.tf)+",\"bars\":["+g_bars_job.rows+"],"+IdentityFields()+"}");
   g_bars_job.active=false;
}
void SendCurrentBars(const int peer)
{
   string names[]={"1m","5m","15m","1h"};
   for(int i=0;i<4;i++)
   {
      ENUM_TIMEFRAMES tf=LocalTf(names[i]);
      if(!SeriesInfoInteger(InpSymbol,tf,SERIES_SYNCHRONIZED)) continue;
      MqlRates rates[];
      if(CopyRates(InpSymbol,tf,0,1,rates)!=1) continue;
      WsText(peer,"{\"type\":\"bar\",\"symbol\":"+JStr(InpSymbol)+",\"tf\":"+JStr(names[i])+
         ",\"bar_time\":"+IntegerToString((long)rates[0].time-g_offset)+",\"open\":"+JNum(rates[0].open,g_digits)+
         ",\"high\":"+JNum(rates[0].high,g_digits)+",\"low\":"+JNum(rates[0].low,g_digits)+
         ",\"close\":"+JNum(rates[0].close,g_digits)+",\"volume\":"+IntegerToString(rates[0].tick_volume)+"}");
   }
}
bool Authenticated(const int peer,const string js)
{
   string token="",account="",server="",epoch="";
   JsonGetString(js,"token",token);JsonGetString(js,"account_id",account);JsonGetString(js,"server",server);JsonGetString(js,"epoch",epoch);
   if(g_token=="" || !SecureEqual(token,g_token) || account!=g_account || server!=g_server || epoch!=g_epoch)
   {LocalError(peer,"AUTH_REQUIRED","Pair with this EA instance and current account");return false;}
   if(g_session_peer!=peer) {LocalError(peer,"AUTH_REQUIRED","Session belongs to another connection");return false;}
   g_local_peers[peer].authenticated=true;
   return true;
}
bool VolumeValid(const double volume)
{
   double minv=SymbolInfoDouble(InpSymbol,SYMBOL_VOLUME_MIN),maxv=SymbolInfoDouble(InpSymbol,SYMBOL_VOLUME_MAX),step=SymbolInfoDouble(InpSymbol,SYMBOL_VOLUME_STEP);
   if(!MathIsValidNumber(volume)||step<=0 || volume<minv-1e-9 || volume>maxv+1e-9 || volume>InpMaxOrderLots+1e-9) return false;
   return MathAbs(volume/step-MathRound(volume/step))<1e-6;
}
bool PriceValid(const double price)
{
   if(!MathIsValidNumber(price)||price<0) return false;
   if(price==0) return true;
   double step=SymbolInfoDouble(InpSymbol,SYMBOL_TRADE_TICK_SIZE);
   return step>0 && MathAbs(price/step-MathRound(price/step))<1e-5;
}
bool StopsValid(const bool buy,const double sl,const double tp,const MqlTick &tick)
{
   if(!PriceValid(sl)||!PriceValid(tp)) return false;
   double distance=(double)SymbolInfoInteger(InpSymbol,SYMBOL_TRADE_STOPS_LEVEL)*SymbolInfoDouble(InpSymbol,SYMBOL_POINT);
   double reference=buy ? tick.bid : tick.ask;
   if(sl>0 && (buy ? sl>=reference || reference-sl<distance : sl<=reference || sl-reference<distance)) return false;
   if(tp>0 && (buy ? tp<=reference || tp-reference<distance : tp>=reference || reference-tp<distance)) return false;
   return true;
}
bool SetFill(MqlTradeRequest &request)
{
   long flags=SymbolInfoInteger(InpSymbol,SYMBOL_FILLING_MODE);
   if((flags&SYMBOL_FILLING_IOC)!=0) request.type_filling=ORDER_FILLING_IOC;
   else if((flags&SYMBOL_FILLING_FOK)!=0) request.type_filling=ORDER_FILLING_FOK;
   else if(SymbolInfoInteger(InpSymbol,SYMBOL_TRADE_EXEMODE)!=SYMBOL_TRADE_EXECUTION_MARKET) request.type_filling=ORDER_FILLING_RETURN;
   else return false;
   return true;
}
void HandleTradeCommand(const int peer,const string js)
{
   string id="",action="",side="",symbol="",position="",order="",ticket="";
   JsonGetString(js,"command_id",id);JsonGetString(js,"action",action);JsonGetString(js,"side",side);JsonGetString(js,"symbol",symbol);
   JsonGetString(js,"position_ticket",position);JsonGetString(js,"order_ticket",order);JsonGetString(js,"ticket",ticket);
   if(!SafeCommandId(id)) {LocalError(peer,"COMMAND_ID","command_id must be 8..64 ASCII letters/digits/-/_");return;}
   if(!JsonKeysAllowed("type,token,account_id,server,epoch,command_id,action,side,symbol,volume,sl,tp,deviation,position_ticket,order_ticket,ticket,expires_at_ms"))
   {WsText(peer,CommandResult(id,"rejected","Unknown command field"));return;}
   double volume=0,sl=0,tp=0,deviation=InpMaxDeviationPoints,expires=0;
   if(!JsonNumber(js,"volume",volume)||!JsonNumber(js,"sl",sl)||!JsonNumber(js,"tp",tp)||!JsonNumber(js,"deviation",deviation,InpMaxDeviationPoints)||!JsonNumber(js,"expires_at_ms",expires))
   {WsText(peer,CommandResult(id,"rejected","Invalid numeric field"));return;}
   string payload=action+"|"+side+"|"+symbol+"|"+DoubleToString(volume,8)+"|"+DoubleToString(sl,12)+"|"+DoubleToString(tp,12)+"|"+
      DoubleToString(deviation,0)+"|"+position+"|"+order+"|"+ticket+"|"+DoubleToString(expires,0);
   string fingerprint=HashHex(payload);
   int existing=CommandFind(id);
   if(existing>=0)
   {
      if(g_commands[existing].fingerprint!=fingerprint) WsText(peer,CommandResult(id,"rejected","COMMAND_ID_CONFLICT: id was used with a different payload"));
      else WsText(peer,CurrentResultIdentity(g_commands[existing].result));
      return;
   }
   string error="";
   if(fingerprint=="") error="Cryptographic hash failed";
   else if(!LocalCanTrade()) error="READ_ONLY: trading requires DEMO HEDGING account, EA local opt-in and healthy journal";
   else if(!TerminalInfoInteger(TERMINAL_CONNECTED)||!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)||!MQLInfoInteger(MQL_TRADE_ALLOWED)||!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)||!AccountInfoInteger(ACCOUNT_TRADE_EXPERT)) error="MT5 trading permissions or connection unavailable";
   else if(expires<LocalUtcMs() || expires>LocalUtcMs()+30000 || expires!=MathFloor(expires)) error="Command expired or deadline is more than 30s ahead; check computer clock";
   else if(GetTickCount64()-g_last_command<500) error="Local command rate limit: wait 500ms";
   else if(symbol!="" && symbol!=InpSymbol) error="Symbol is not allowed by this EA";
   else if(deviation<0 || deviation>InpMaxDeviationPoints || deviation!=MathFloor(deviation)) error="Deviation exceeds local limit";
   else if(!PriceValid(sl)||!PriceValid(tp)) error="SL/TP must be finite non-negative prices on tick grid";
   MqlTradeRequest request;MqlTradeResult result;ZeroMemory(request);ZeroMemory(result);
   MqlTick tick;ZeroMemory(tick);
   if(error=="" && (!SymbolInfoTick(InpSymbol,tick)||tick.bid<=0||tick.ask<=0)) error="No current broker quote";
   double point=SymbolInfoDouble(InpSymbol,SYMBOL_POINT);
   if(error=="" && action=="market" && InpMaxSpreadPoints>0 && (point<=0 || (tick.ask-tick.bid)/point>InpMaxSpreadPoints)) error="Spread exceeds local limit";
   if(error=="" && action=="market")
   {
      if(symbol!=InpSymbol || (side!="buy" && side!="sell") || !VolumeValid(volume)) error="Market order symbol/side/volume invalid";
      double exposure=0;
      for(int i=0;i<PositionsTotal();i++) if(PositionGetTicket(i)>0 && PositionGetString(POSITION_SYMBOL)==InpSymbol) exposure+=PositionGetDouble(POSITION_VOLUME);
      for(int i=0;i<OrdersTotal();i++) if(OrderGetTicket(i)>0 && OrderGetString(ORDER_SYMBOL)==InpSymbol) exposure+=OrderGetDouble(ORDER_VOLUME_CURRENT);
      if(error=="" && exposure+volume>InpMaxSymbolLots+1e-9) error="Total symbol exposure exceeds local limit";
      bool buy=side=="buy";
      if(error=="" && !StopsValid(buy,sl,tp,tick)) error="SL/TP side or broker stop distance invalid";
      request.action=TRADE_ACTION_DEAL;request.type=buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      request.price=buy ? tick.ask : tick.bid;request.volume=volume;request.sl=sl;request.tp=tp;request.magic=(ulong)InpMagic;
   }
   else if(error=="" && action=="close")
   {
      if(!InpAllowClose || !JsonId(js,"position_ticket",position) || !PositionSelectByTicket((ulong)StringToInteger(position))) error="Close disabled or position not found";
      else if(PositionGetString(POSITION_SYMBOL)!=InpSymbol || (InpManageOwnMagicOnly && PositionGetInteger(POSITION_MAGIC)!=InpMagic)) error="Position is outside local ownership policy";
      else
      {
         double current=PositionGetDouble(POSITION_VOLUME);double amount=volume==0 ? current : volume;
         if(volume<0 || !VolumeValid(amount) || amount>current+1e-9) error="Close volume exceeds position/local limit or is off grid";
         long kind=PositionGetInteger(POSITION_TYPE);
         request.action=TRADE_ACTION_DEAL;request.position=(ulong)StringToInteger(position);request.volume=amount;
         request.type=kind==POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;request.price=kind==POSITION_TYPE_BUY ? tick.bid : tick.ask;
         request.magic=(ulong)PositionGetInteger(POSITION_MAGIC);
      }
   }
   else if(error=="" && action=="cancel")
   {
      if(!InpAllowCancel || !JsonId(js,"order_ticket",order) || !OrderSelect((ulong)StringToInteger(order))) error="Cancel disabled or pending order not found";
      else if(OrderGetString(ORDER_SYMBOL)!=InpSymbol || (InpManageOwnMagicOnly && OrderGetInteger(ORDER_MAGIC)!=InpMagic)) error="Order is outside local ownership policy";
      else {request.action=TRADE_ACTION_REMOVE;request.order=(ulong)StringToInteger(order);}
   }
   else if(error=="" && action=="modify")
   {
      if(!InpAllowModify || !JsonId(js,"ticket",ticket) || !PositionSelectByTicket((ulong)StringToInteger(ticket))) error="Modify disabled or position not found; pending-order modification is not supported in v1";
      else if(PositionGetString(POSITION_SYMBOL)!=InpSymbol || (InpManageOwnMagicOnly && PositionGetInteger(POSITION_MAGIC)!=InpMagic)) error="Position is outside local ownership policy";
      else if(JsonValuePos(js,"sl")<0 || JsonValuePos(js,"tp")<0 || !StopsValid(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY,sl,tp,tick)) error="Modify requires explicit valid sl and tp (0 clears)";
      else {request.action=TRADE_ACTION_SLTP;request.position=(ulong)StringToInteger(ticket);request.sl=sl;request.tp=tp;}
   }
   else if(error=="") error="Unsupported trading action";
   request.symbol=InpSymbol;request.deviation=(ulong)MathMax(0,deviation);
   request.comment="tpl:"+StringSubstr(id,0,26);
   if(error=="" && request.action==TRADE_ACTION_DEAL && !SetFill(request)) error="No supported broker filling mode; no retry will be attempted";
   if(error!="")
   {
      string rejected=CommandResult(id,"rejected",error);
      // Well-formed rejected operations are also stable under idempotent replay.
      if(g_journal_ok && fingerprint!="" && ArraySize(g_commands)<JOURNAL_MAX)
      {
         int index=ArraySize(g_commands);ArrayResize(g_commands,index+1);
         g_commands[index].id=id;g_commands[index].fingerprint=fingerprint;g_commands[index].state="rejected";
         g_commands[index].result=rejected;g_commands[index].broker_order=0;g_commands[index].broker_deal=0;
         JournalAppend(index);
      }
      WsText(peer,rejected);return;
   }
   if(ArraySize(g_commands)>=JOURNAL_MAX) {WsText(peer,CommandResult(id,"rejected","Journal capacity reached; trading disabled until reviewed"));return;}
   int index=ArraySize(g_commands);ArrayResize(g_commands,index+1);
   g_commands[index].id=id;g_commands[index].fingerprint=fingerprint;g_commands[index].state="intent";
   g_commands[index].broker_order=0;g_commands[index].broker_deal=0;
   g_commands[index].result=CommandResult(id,"uncertain","Durable intent recorded; outcome not yet known");
   if(!JournalAppend(index))
   {
      g_commands[index].state="rejected";
      g_commands[index].result=CommandResult(id,"rejected","Could not flush durable intent; order was not sent");
      WsText(peer,g_commands[index].result);return;
   }
   // Re-check target immediately before the ONLY call to OrderSend. No filling-mode retry.
   if(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))!=g_account || AccountInfoString(ACCOUNT_SERVER)!=g_server || !LocalDemo())
   {
      g_commands[index].state="rejected";g_commands[index].result=CommandResult(id,"rejected","Account changed before submission");JournalAppend(index);
      WsText(peer,g_commands[index].result);return;
   }
   g_last_command=GetTickCount64();
   bool sent=OrderSend(request,result);
   if(!sent && result.retcode==0) result.comment="Submission result unknown; MT5 error "+IntegerToString(GetLastError());
   string state="rejected";
   if(result.retcode==10009 || result.retcode==10010 || result.retcode==10025) state="completed";
   else if(result.retcode==10008) state="submitted";
   else if(result.retcode==0 || result.retcode==10011 || result.retcode==10012 || result.retcode==10031) state="uncertain";
   g_commands[index].state=state;
   g_commands[index].broker_order=result.order;g_commands[index].broker_deal=result.deal;
   g_commands[index].result=CommandResult(id,state,result.comment,result.retcode,result.order,result.deal,result.price,result.volume);
   if(!JournalAppend(index))
   {
      // Intent is durable, outcome may not be. Keep RAM result; prohibit further trading.
      g_journal_ok=false;
      Print("TongpinLocal: outcome journal flush failed; trading disabled. Inspect MT5 history.");
   }
   WsText(peer,g_commands[index].result);g_force_snapshot=true;
}
void ReconcileCommand(const int index)
{
   if(index<0 || (g_commands[index].state!="submitted" && g_commands[index].state!="uncertain")) return;
   ulong order=g_commands[index].broker_order,deal=g_commands[index].broker_deal;
   string state="";string reason="";uint code=0;double price=0,volume=0;
   // A single deal can be only one partial fill. It is never proof of full completion.
   if(order==0 && deal>0 && HistoryDealSelect(deal))
   {
      order=(ulong)HistoryDealGetInteger(deal,DEAL_ORDER);
      g_commands[index].broker_order=order;
   }
   if(order>0 && HistoryOrderSelect(order))
   {
      ENUM_ORDER_STATE order_state=(ENUM_ORDER_STATE)HistoryOrderGetInteger(order,ORDER_STATE);
      if(order_state==ORDER_STATE_FILLED)
      {
         state="completed";code=10009;reason="Exact broker order is filled";
         volume=HistoryOrderGetDouble(order,ORDER_VOLUME_INITIAL)-HistoryOrderGetDouble(order,ORDER_VOLUME_CURRENT);
         // Aggregate fill price is not inferred from requested order price or one deal.
         price=0;
      }
      else if(order_state==ORDER_STATE_CANCELED || order_state==ORDER_STATE_REJECTED || order_state==ORDER_STATE_EXPIRED)
      {
         double filled=HistoryOrderGetDouble(order,ORDER_VOLUME_INITIAL)-HistoryOrderGetDouble(order,ORDER_VOLUME_CURRENT);
         if(filled>0) {state="completed";code=10010;volume=filled;reason="Broker order terminated after partial fill";}
         else {state="rejected";code=10006;reason="Exact broker order terminated without execution";}
      }
   }
   if(state=="") return; // Absence is not evidence of failure; never resubmit.
   g_commands[index].state=state;
   g_commands[index].result=CommandResult(g_commands[index].id,state,reason,code,order,deal,price,volume);
   JournalAppend(index);
}
void LocalMessage(const int peer,const string js)
{
   AccountChanged();
   if(!JsonValidateFlat(js)) {LocalError(peer,"JSON","Expected a valid flat JSON object with unique fields");return;}
   string type="";if(!JsonGetString(js,"type",type)) {LocalError(peer,"TYPE","type is required");return;}
   if(type=="pair")
   {
      string code="";
      if(!JsonKeysAllowed("type,code") || !JsonGetString(js,"code",code)) {LocalError(peer,"PAIR","Only type and code are accepted");return;}
      if(g_token!="") {LocalError(peer,"PAIR_REVOKE_REQUIRED","An authorization already exists. Revoke on the MT5 chart to pair again.");return;}
      if(GetTickCount64()>g_pair_until || g_pair_attempts>=5) {LocalError(peer,"PAIR_LOCKED","Pairing expired or attempt limit reached; wait for next code");return;}
      g_pair_attempts++;
      if(!SecureEqual(code,g_pair_code)) {LocalError(peer,"PAIR_CODE","Incorrect pairing code");return;}
      if(g_pending_peer>=0 && g_pending_peer!=peer) {LocalError(peer,"PAIR_BUSY","Another pairing is awaiting local approval");return;}
      g_pending_peer=peer;g_pending_until=MathMin(g_pair_until,GetTickCount64()+60000);
      WsText(peer,"{\"type\":\"pair_pending\",\"message\":\"Confirm this website and account using the Allow button on the MT5 EA chart\"}");PaintStatus();return;
   }
   if(!Authenticated(peer,js)) return;
   string allowed="type,token,account_id,server,epoch";
   if(type=="command") {HandleTradeCommand(peer,js);return;}
   if(type=="bars")
   {
      if(!JsonKeysAllowed(allowed+",request_id,symbol,tf,limit")) {LocalError(peer,"FIELDS","Unknown history field");return;}
      BeginBars(peer,js);return;
   }
   if(type=="command_status")
   {
      string id="";
      if(!JsonKeysAllowed(allowed+",command_id")||!JsonGetString(js,"command_id",id)||!SafeCommandId(id)) {LocalError(peer,"COMMAND_ID","Invalid command id");return;}
      int index=CommandFind(id);
      if(index>=0) ReconcileCommand(index);
      WsText(peer,index>=0 ? CurrentResultIdentity(g_commands[index].result) : CommandResult(id,"not_found","No durable intent found; do not automatically resubmit"));return;
   }
   if(type=="ping")
   {
      string request_id="";JsonGetString(js,"request_id",request_id);
      if(!JsonKeysAllowed(allowed+",request_id")) {LocalError(peer,"FIELDS","Unknown ping field");return;}
      WsText(peer,"{\"type\":\"pong\",\"request_id\":"+JStr(request_id)+",\"server_time_ms\":"+IntegerToString(LocalUtcMs())+"}");return;
   }
   if(!JsonKeysAllowed(allowed)) {LocalError(peer,"FIELDS","Unknown request field");return;}
   if(type=="snapshot" || type=="subscribe") SendSnapshot(peer);
   else if(type=="disconnect") {ClearAuthorization();NewPairCode();PaintStatus();}
   else LocalError(peer,"TYPE","Unsupported request type");
}
int OnInit()
{
   if(!MQLInfoInteger(MQL_DLLS_ALLOWED)) {Print("TongpinLocal: allow system DLL imports in EA settings");return INIT_FAILED;}
   if(StringFind(InpAllowedOrigin,"https://")!=0 || StringFind(InpAllowedOrigin,"/",8)>=0 || StringFind(InpAllowedOrigin," ")>=0 || StringFind(InpAllowedOrigin,"*")>=0)
   {Print("TongpinLocal: allowed origin must be one exact https origin without path/wildcards");return INIT_PARAMETERS_INCORRECT;}
   if(InpMaxOrderLots<=0 || InpMaxSymbolLots<InpMaxOrderLots || InpMaxDeviationPoints<0 || InpMaxSpreadPoints<0 || InpMagic<0 || !SymbolSelect(InpSymbol,true)) return INIT_PARAMETERS_INCORRECT;
   g_digits=(int)SymbolInfoInteger(InpSymbol,SYMBOL_DIGITS);
   g_instance=RandomHex(16);
   if(g_instance=="") return INIT_FAILED;
   AccountChanged();
   if(g_epoch=="" || g_pair_code=="") return INIT_FAILED;
   if(!WsStart(LOCAL_PORT)) {Print("TongpinLocal: cannot bind 127.0.0.1:18765; another EA may already own the port. Error=",WSAGetLastError());WsStop();return INIT_FAILED;}
   MakeButton(g_button_allow,"允许本次连接 / Allow",10);MakeButton(g_button_revoke,"撤销授权 / Revoke",185);
   if(!EventSetMillisecondTimer(15)) {WsStop();return INIT_FAILED;}
   PaintStatus();return INIT_SUCCEEDED;
}
void OnDeinit(const int reason)
{
   EventKillTimer();WsStop();
   if(g_journal!=INVALID_HANDLE) {FileFlush(g_journal);FileClose(g_journal);g_journal=INVALID_HANDLE;}
   ObjectDelete(0,g_button_allow);ObjectDelete(0,g_button_revoke);Comment("");
}
void OnTimer()
{
   AccountChanged();
   ulong now=GetTickCount64();
   if(g_pending_peer>=0 && now>g_pending_until)
   {LocalError(g_pending_peer,"PAIR_EXPIRED","Local approval timed out");g_pending_peer=-1;}
   if(now>g_pair_until && g_pending_peer<0) NewPairCode();
   g_offset=(long)TimeTradeServer()-(long)TimeGMT();
   WsPump(InpAllowedOrigin,LOCAL_PORT);
   PumpBars();
   if(now-g_last_tick>=100)
   {
      g_last_tick=now;string tick=TickJson();
      for(int i=0;i<LOCAL_PEERS;i++)
         if(g_local_peers[i].authenticated && ArraySize(g_local_peers[i].tx)-g_local_peers[i].tx_offset<32768)
            WsText(i,"{\"type\":\"tick\",\"tick\":"+tick+"}");
   }
   if(g_force_snapshot || now-g_last_snapshot>=1000)
   {
      g_last_snapshot=now;g_force_snapshot=false;
      for(int i=0;i<LOCAL_PEERS;i++) if(g_local_peers[i].authenticated && ArraySize(g_local_peers[i].tx)-g_local_peers[i].tx_offset<65536)
      {SendSnapshot(i);SendCurrentBars(i);}
      PaintStatus();
   }
}
void OnTick() { /* Networking is timer-driven and remains available during quiet markets. */ }
void OnChartEvent(const int id,const long &lparam,const double &dparam,const string &sparam)
{
   AccountChanged();
   if(id!=CHARTEVENT_OBJECT_CLICK) return;
   if(sparam==g_button_revoke)
   {ClearAuthorization();NewPairCode();ObjectSetInteger(0,g_button_revoke,OBJPROP_STATE,false);PaintStatus();return;}
   if(sparam!=g_button_allow) return;
   ObjectSetInteger(0,g_button_allow,OBJPROP_STATE,false);
   if(g_pending_peer<0 || GetTickCount64()>g_pending_until || !g_local_peers[g_pending_peer].upgraded) return;
   // The only route to issue a new session token is this local chart click.
   g_token=RandomHex(32);
   if(g_token=="") {LocalError(g_pending_peer,"RNG","Could not create session token");return;}
   int peer=g_pending_peer;g_pending_peer=-1;g_pending_until=0;
   g_session_peer=peer;g_local_peers[peer].authenticated=true;
   WsText(peer,"{\"type\":\"paired\",\"token\":"+JStr(g_token)+","+IdentityFields()+",\"symbol\":"+JStr(InpSymbol)+"}");
   g_pair_code="--------";g_pair_until=GetTickCount64()+PAIR_TTL_MS;
   SendSnapshot(peer);PaintStatus();
}
void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
{
   AccountChanged();
   g_force_snapshot=true;
   string event="{\"type\":\"trade\",\"trans_type\":"+IntegerToString((long)trans.type)+",\"order\":"+JStr(IntegerToString((long)trans.order))+
      ",\"deal\":"+JStr(IntegerToString((long)trans.deal))+",\"position\":"+JStr(IntegerToString((long)trans.position))+
      ",\"symbol\":"+JStr(trans.symbol)+",\"price\":"+JNum(trans.price,g_digits)+",\"volume\":"+JNum(trans.volume,8)+"}";
   for(int i=0;i<LOCAL_PEERS;i++) if(g_local_peers[i].authenticated) WsText(i,event);
   for(int i=ArraySize(g_commands)-1;i>=0;i--)
   {
      if((g_commands[i].broker_order>0 && g_commands[i].broker_order==trans.order) ||
         (g_commands[i].broker_deal>0 && g_commands[i].broker_deal==trans.deal))
      {
         if(trans.type==TRADE_TRANSACTION_DEAL_ADD) g_commands[i].broker_deal=trans.deal;
         string before=g_commands[i].state;ReconcileCommand(i);
         if(before!=g_commands[i].state)
            for(int peer=0;peer<LOCAL_PEERS;peer++) if(g_local_peers[peer].authenticated) WsText(peer,CurrentResultIdentity(g_commands[i].result));
      }
   }
}
