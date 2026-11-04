// SyncTrade (SyncNote Pro) - local trading and read-only history export.
// Windows 8+ MT5 only; system Ws2_32.dll + bcrypt.dll + kernel32.dll; no custom DLL.
// No MT5 password/account credential is read, accepted from the web, or uploaded.
// Trading is OFF by default; live trading requires separate local consent and durable caps.
#property copyright "SyncTrade"
#property version "1.102"
#property strict
#property description "Windows localhost EA. Default read-only; live trading needs explicit opt-in and caps."

#include "SyncNoteLocalJson.mqh"
#include "SyncNoteLocalSocket.mqh"
#include "SyncNoteHistory.mqh"
#include "SyncTradeRisk.mqh"

input string InpAllowedOrigin="https://sync-trade.top"; // Exact HTTPS website origin, no trailing slash
input string InpSymbol="XAUUSD";                      // Exact broker symbol, suffix included
input bool InpAllowTrading=false;                    // Explicit local opt-in for all trading
input bool InpAllowRealTrading=false;                 // Allow a REAL account (needs the two caps below)
input double InpRealMaxLots=0.05;                     // Real account: max lots per order (0 = block real trading)
input int InpRealMaxOrdersPerDay=5;                   // Real account: max new market/pending commands per broker day
input double InpMaxOrderLots=0.10;                   // Maximum market order / partial close lots
input double InpMaxSymbolLots=1.00;                  // Maximum gross exposure on selected symbol
input int InpMaxDeviationPoints=20;                  // Maximum requested deviation in broker points
input int InpMaxSpreadPoints=100;                    // 0 disables this additional local spread gate
input long InpMagic=26055423;                        // Magic assigned to new website orders
input bool InpManageOwnMagicOnly=true;               // Close/cancel/modify only this EA's magic
input bool InpAllowNettingManage=false;               // Explicit netting-position management and pending-order consent
input bool InpAllowClose=true;
input bool InpAllowCancel=true;
input bool InpAllowModify=true;
input bool InpAllowPending=true;                       // Allow limit/stop pending orders
input double InpMaxDailyLoss=0.0;                      // Daily realized-loss cap in account currency (0 disables)
input double InpMaxPendingDeviationPct=1.5;            // Pending price must stay within this % of the mid
input int InpBarPushMs=100;                            // Current-bar push interval (50..1000ms); lower = smoother candles
input int InpTickPushMs=100;                           // Tick push interval (50..1000ms); lower = smoother price

#define LOCAL_PORT 18765
#define LOCAL_VERSION "1.102"
#define JOURNAL_MAX 10000
#define PAIR_TTL_MS 120000

string g_account="",g_server="",g_epoch="",g_instance="",g_token="";
string g_pair_code="";
ulong g_pair_until=0;
int g_pair_attempts=0,g_pending_peer=-1,g_session_peer=-1;
ulong g_pending_until=0;
ulong g_last_tick=0,g_last_snapshot=0,g_last_command=0,g_last_bar=0;
bool g_bar_dirty=true;
int g_bar_push_ms=100,g_tick_push_ms=100;
CSyncTradeRisk g_risk;
bool g_risk_ok=false;
bool g_force_snapshot=true,g_journal_ok=false,g_account_stable=false;
int g_journal=INVALID_HANDLE;
string g_journal_path="";
int g_digits=5;
long g_offset=0;
string g_button_allow="SyncTrade.Allow",g_button_revoke="SyncTrade.Revoke";

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
   string symbol;
   int digits;
   bool range_mode;
   bool loaded;
   long from_server;
   long to_server;
   long output_offset;
   int limit;
   int next;
   string rows;
   MqlRates rates[];
};
LocalBarsJob g_bars_job;
// At most one history page is queued. MT5 history selection is deferred until after
// WsPump, so a history request never executes the expensive selector in LocalMessage.
struct LocalHistoryJob
{
   bool active;
   bool started;
   int peer;
   string request_id;
   string account;
   string server;
   string epoch;
   long from_server;
   long to_server;
   string cursor;
   int limit;
};
LocalHistoryJob g_history_job;
CSyncNoteHistory g_history_export;
ulong g_history_defer_until=0;

bool LocalDemo() { return AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_DEMO; }
bool LocalReal() { return AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_REAL; }
bool LocalHedging() { return AccountInfoInteger(ACCOUNT_MARGIN_MODE)==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING; }
// 净额账户上，持仓是所有来源合并的，magic 归属无法证明：默认只允许开新仓。
bool LocalManageAllowed() { return LocalHedging() || InpAllowNettingManage; }
bool LocalCanTrade()
{
   if(!InpAllowTrading || !g_journal_ok || !g_account_stable || !g_risk_ok || !g_risk.Healthy()) return false;
   long margin=AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   if(margin!=ACCOUNT_MARGIN_MODE_RETAIL_HEDGING && margin!=ACCOUNT_MARGIN_MODE_RETAIL_NETTING && margin!=ACCOUNT_MARGIN_MODE_EXCHANGE) return false;
   // 对冲、净额都允许开新仓；净额下 close/modify 的归属无法证明，另由 LocalManageAllowed 把关。
   if(LocalDemo()) return true;
   // 实盘：必须单独开关 + 单笔/每日上限都有效，否则一律只读。
   return LocalReal() && InpAllowRealTrading && InpRealMaxLots>0 && InpRealMaxOrdersPerDay>0;
}
string JsonBool(const bool value) { return value ? "true" : "false"; }
string CapabilitiesJson()
{
   if(!LocalCanTrade()) return "[]";
   string capabilities="[\"market\"";
   if(InpAllowClose && LocalManageAllowed()) capabilities+=",\"close\"";
   if(InpAllowCancel) capabilities+=",\"cancel\"";
   if(InpAllowModify && LocalManageAllowed()) capabilities+=",\"modify\"";
   // Keep the old UI label while granting only the explicit supported actions.
   if(InpAllowPending && LocalManageAllowed()) capabilities+=",\"pending\",\"limit\",\"stop\"";
   return capabilities+"]";
}

bool NewOrderAction(const string action)
{
   return action=="market" || action=="limit" || action=="stop";
}

// 挂单价格语义：方向和距离都要对，挡掉大部分手滑。
bool PendingSideValid(const string action,const bool buy,const double price,const MqlTick &tick)
{
   if(price<=0 || tick.bid<=0 || tick.ask<=0) return false;
   double distance=(double)SymbolInfoInteger(InpSymbol,SYMBOL_TRADE_STOPS_LEVEL)*SymbolInfoDouble(InpSymbol,SYMBOL_POINT);
   if(action=="limit") return buy ? price<tick.ask && tick.ask-price>=distance : price>tick.bid && price-tick.bid>=distance;
   if(action=="stop") return buy ? price>tick.ask && price-tick.ask>=distance : price<tick.bid && tick.bid-price>=distance;
   return false;
}
string IdentityFields()
{
   return "\"product\":\"SyncTrade\",\"features\":[\"history\"],\"instance_id\":"+JStr(g_instance)+",\"account_id\":"+JStr(g_account)+",\"server\":"+JStr(g_server)+",\"epoch\":"+JStr(g_epoch)+
      ",\"demo\":"+JsonBool(LocalDemo())+",\"hedging\":"+JsonBool(LocalHedging())+",\"netting_manage\":"+JsonBool(InpAllowNettingManage)+",\"real_trading\":"+JsonBool(LocalReal() && InpAllowRealTrading && LocalCanTrade())+
      ",\"read_only\":"+JsonBool(!LocalCanTrade())+",\"trade_enabled\":"+JsonBool(LocalCanTrade())+",\"capabilities\":"+CapabilitiesJson()+",\"server_offset_sec\":"+IntegerToString((long)TimeTradeServer()-(long)TimeGMT())+",\"account_key\":"+JStr(HashHex(g_server+"\n"+g_account));
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
   // 按钮要在最上层、且可点击：OBJPROP_SELECTABLE 关掉只影响拖动，不影响点击；
   // ZORDER 不够时会被 Comment/其他对象盖住，看起来"点不到"。
   ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,name,OBJPROP_HIDDEN,false);
   ObjectSetInteger(0,name,OBJPROP_ZORDER,100);
   ChartRedraw();
}
void PaintStatus()
{
   string mode=!LocalCanTrade() ? "READ ONLY / 只读" : (LocalReal() ? "REAL trading enabled (caps active) / 实盘交易已开启（有上限）" : "DEMO trading enabled / 模拟交易已开启");
   string pending=g_pending_peer>=0 ? "\n网站已输入正确配对码，请核对来源及账号后点击下方【允许本次连接】。" : "";
   Comment("SyncTrade 本机 EA ",LOCAL_VERSION,"\n",mode,"\n网站来源: ",InpAllowedOrigin,
      "\n账号: ",g_account," @ ",g_server,"\n品种: ",InpSymbol,
      "\n配对码: ",g_pair_code," (",IntegerToString((long)MathMax(0,(long)(g_pair_until-GetTickCount64())/1000)),"s)",
      "\n只监听 127.0.0.1:18765; 不读取/上传交易密码",pending,
      g_journal_ok ? "" : "\n交易日志不可用，禁止交易。",
      g_risk_ok ? "" : "\n风控存储不可用，禁止交易。");
   ChartRedraw();
}
void ClearAuthorization()
{
   g_token="";g_pending_peer=-1;g_pending_until=0;g_session_peer=-1;
   g_bars_job.active=false;g_history_job.active=false;g_history_export.Reset();
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
   // Runtime folder keeps the historical name on purpose: an existing
   // commands-*.journal is the only de-duplication record, so renaming the
   // folder would orphan it and allow a command to be replayed.
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
   ClearAuthorization();g_account_stable=false;g_risk.Close();g_risk_ok=false;
   g_account=login;g_server=server;g_epoch=RandomHex(16);
   if(g_epoch=="" || !NewPairCode()) {Print("SyncTrade: cryptographic random generator unavailable");return;}
   g_journal_ok=OpenJournal();
   string risk_error;
   if(g_journal_ok) g_risk_ok=g_risk.Open(g_account,g_server,risk_error);
   if(!g_risk_ok) Print("SyncTrade: risk storage unavailable; trading disabled: ",risk_error);
   g_account_stable=(AccountInfoInteger(ACCOUNT_LOGIN)>0 && server!="");
   g_force_snapshot=true;PaintStatus();
}
void LocalOpened(const int index)
{
   // Reject additional upgraded connections. Origin authorizes the website, not the user.
   for(int i=0;i<LOCAL_PEERS;i++)
      if(i!=index && g_local_peers[i].upgraded && !g_local_peers[i].closing) {WsClose(index,1008);return;}
   WsText(index,"{\"type\":\"hello\",\"protocol\":\"tongpin-local\",\"version\":1,\"ea_version\":"+JStr(LOCAL_VERSION)+
      ",\"instance_id\":"+JStr(g_instance)+",\"pairing_required\":true,\"product\":\"SyncTrade\",\"features\":[\"history\"]}");
}
void LocalClosed(const int index)
{
   if(g_session_peer==index) {g_session_peer=-1;g_token="";NewPairCode();}
   if(g_pending_peer==index) {g_pending_peer=-1;g_pending_until=0;}
   if(g_bars_job.active && g_bars_job.peer==index) g_bars_job.active=false;
   if(g_history_job.active && g_history_job.peer==index) {g_history_job.active=false;g_history_export.Reset();}
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
   string request_id="",tf="",symbol="";double limit=300,from=0,to=0;
   JsonGetString(js,"request_id",request_id);JsonGetString(js,"tf",tf);JsonGetString(js,"symbol",symbol);
   bool ranged=JsonValuePos(js,"from_server")>=0 || JsonValuePos(js,"to_server")>=0;
   if(symbol=="") symbol=InpSymbol;
   if(!ranged && symbol!=InpSymbol) {LocalError(peer,"SYMBOL","Live bars only use the configured EA symbol",request_id);return;}
   if(StringLen(symbol)>80 || StringLen(request_id)>80 || LocalTf(tf)==PERIOD_CURRENT ||
      !JsonNumber(js,"limit",limit,ranged?2000:300) || limit<1 || limit>(ranged?2000:500) || limit!=MathFloor(limit))
   {LocalError(peer,"BARS_REQUEST","Expected symbol/tf and limit 1..500 (range: 1..2000)",request_id);return;}
   if(ranged && (JsonValuePos(js,"from_server")<0 || JsonValuePos(js,"to_server")<0 ||
      !JsonNumber(js,"from_server",from) || !JsonNumber(js,"to_server",to) || from<1 || to<from ||
      to>32535215999.0 || from!=MathFloor(from) || to!=MathFloor(to) ||
      (to-from)/PeriodSeconds(LocalTf(tf))+1>2000))
   {LocalError(peer,"BARS_RANGE","Range must contain at most 2000 period slots in broker-server seconds",request_id);return;}
   if(g_bars_job.active || g_history_job.active) {LocalError(peer,"BARS_BUSY","Wait for current bars/history response",request_id);return;}
   // Only read synchronized series; a missing series is an explicit gap, not a
   // reason to synchronously download a large archive on the trading EA thread.
   if(!SymbolSelect(symbol,true) || !SeriesInfoInteger(symbol,LocalTf(tf),SERIES_SYNCHRONIZED))
   {LocalError(peer,"HISTORY_UNAVAILABLE","Open this symbol/timeframe in MT5 to load history first",request_id);return;}
   g_bars_job.peer=peer;g_bars_job.request_id=request_id;g_bars_job.tf=tf;g_bars_job.symbol=symbol;
   g_bars_job.digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);g_bars_job.range_mode=ranged;
   g_bars_job.from_server=(long)from;g_bars_job.to_server=(long)to;g_bars_job.output_offset=ranged?0:g_offset;
   g_bars_job.next=0;g_bars_job.rows="";ArrayResize(g_bars_job.rates,0);
   g_bars_job.loaded=false;g_bars_job.limit=(int)limit;g_bars_job.active=true;
}
void BeginHistory(const int peer,const string js)
{
   string request_id="",cursor="";double from=0,to=0,limit=100;
   JsonGetString(js,"request_id",request_id);
   if(request_id=="" || StringLen(request_id)>80)
   {LocalError(peer,"REQUEST_ID","history request_id must be 1..80 characters",request_id);return;}
   if(JsonValuePos(js,"from")<0 || JsonValuePos(js,"to")<0 || !JsonGetString(js,"cursor",cursor) || StringLen(cursor)>256 ||
      !JsonNumber(js,"from",from) || !JsonNumber(js,"to",to) || !JsonNumber(js,"limit",limit,100) ||
      from<1 || to<from || to-from>3660.0*86400 || to>32535215999.0 || from!=MathFloor(from) || to!=MathFloor(to) ||
      limit<1 || limit>100 || limit!=MathFloor(limit))
   {LocalError(peer,"HISTORY_REQUEST","Expected broker-server from/to seconds, cursor string and limit 1..100",request_id);return;}
   if(g_history_job.active || g_bars_job.active)
   {LocalError(peer,"HISTORY_BUSY","Wait for current history/bars response",request_id);return;}
   g_history_job.active=true;g_history_job.started=false;g_history_job.peer=peer;
   g_history_job.request_id=request_id;g_history_job.account=g_account;g_history_job.server=g_server;g_history_job.epoch=g_epoch;
   g_history_job.from_server=(long)from;g_history_job.to_server=(long)to;g_history_job.cursor=cursor;g_history_job.limit=(int)limit;
}
void PumpHistory()
{
   if(!g_history_job.active || GetTickCount64()<g_history_defer_until) return;
   int peer=g_history_job.peer;
   if(peer<0 || peer>=LOCAL_PEERS || !g_local_peers[peer].authenticated || g_session_peer!=peer ||
      g_token=="" || g_account!=g_history_job.account || g_server!=g_history_job.server || g_epoch!=g_history_job.epoch)
   {g_history_job.active=false;g_history_export.Reset();return;}
   // Backpressure pauses export instead of filling the command/result send queue.
   if(ArraySize(g_local_peers[peer].tx)-g_local_peers[peer].tx_offset>32768) return;
   if(!g_history_job.started)
   {
      if(!g_history_export.Begin(g_history_job.from_server,g_history_job.to_server,g_history_job.cursor,g_history_job.limit))
      {
         LocalError(peer,"HISTORY_EXPORT",g_history_export.Error(),g_history_job.request_id);
         g_history_job.active=false;g_history_export.Reset();return;
      }
      g_history_job.started=true;
   }
   // The MT5 selector can itself block on first download; the module bounds the
   // serialization work, not MT5's synchronous internal network/history calls.
   g_history_export.Pump(8);
   if(g_history_export.Failed())
   {
      LocalError(peer,"HISTORY_EXPORT",g_history_export.Error(),g_history_job.request_id);
      g_history_job.active=false;g_history_export.Reset();return;
   }
   if(!g_history_export.Ready()) return;
   // AccountChanged runs before each pump. Re-check immediately before disclosure.
   if(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))!=g_account || AccountInfoString(ACCOUNT_SERVER)!=g_server)
   {AccountChanged();return;}
   string response="{\"type\":\"history\",\"request_id\":"+JStr(g_history_job.request_id)+","+IdentityFields()+
      ",\"range\":{\"from_server\":"+IntegerToString(g_history_export.FromServer())+",\"to_server\":"+IntegerToString(g_history_export.ToServer())+"}"+
      ",\"deals\":"+g_history_export.DealsJson()+",\"next_cursor\":"+JStr(g_history_export.NextCursor())+
      ",\"has_more\":"+JsonBool(g_history_export.HasMore())+",\"through_server\":"+IntegerToString(g_history_export.ThroughServer())+
      ",\"errors\":[],\"time_basis\":\"broker_server\",\"server_time_ms\":"+IntegerToString(LocalUtcMs())+"}";
   WsText(peer,response);
   g_history_job.active=false;g_history_export.Reset();
}
void PumpBars()
{
   if(!g_bars_job.active) return;
   if(!g_local_peers[g_bars_job.peer].authenticated) {g_bars_job.active=false;return;}
   if(ArraySize(g_local_peers[g_bars_job.peer].tx)-g_local_peers[g_bars_job.peer].tx_offset>32768) return;
   if(!g_bars_job.loaded)
   {
      long interval=PeriodSeconds(LocalTf(g_bars_job.tf));
      long aligned_from=g_bars_job.from_server-g_bars_job.from_server%interval;
      int count=g_bars_job.range_mode ? CopyRates(g_bars_job.symbol,LocalTf(g_bars_job.tf),(datetime)aligned_from,(datetime)g_bars_job.to_server,g_bars_job.rates) :
         CopyRates(g_bars_job.symbol,LocalTf(g_bars_job.tf),0,g_bars_job.limit,g_bars_job.rates);
      string error="";
      if(count<1) error="MT5 history is not ready";
      else if(g_bars_job.range_mode && (count>2000 || count>g_bars_job.limit)) error="Requested range exceeds limit; split it into smaller windows";
      else if(g_bars_job.range_mode && ((long)g_bars_job.rates[0].time>g_bars_job.from_server ||
         (long)g_bars_job.rates[count-1].time+interval<=g_bars_job.to_server)) error="MT5 series does not cover the requested range";
      if(error!="") {LocalError(g_bars_job.peer,"HISTORY_UNAVAILABLE",error,g_bars_job.request_id);g_bars_job.active=false;return;}
      g_bars_job.limit=count;g_bars_job.loaded=true;return;
   }
   int end=MathMin(g_bars_job.limit,g_bars_job.next+50);
   for(int i=g_bars_job.next;i<end;i++)
   {
      if(i>0) g_bars_job.rows+=",";
      g_bars_job.rows+="["+IntegerToString((long)g_bars_job.rates[i].time-g_bars_job.output_offset)+","+JNum(g_bars_job.rates[i].open,g_bars_job.digits)+","+
         JNum(g_bars_job.rates[i].high,g_bars_job.digits)+","+JNum(g_bars_job.rates[i].low,g_bars_job.digits)+","+JNum(g_bars_job.rates[i].close,g_bars_job.digits)+","+
         IntegerToString(g_bars_job.rates[i].tick_volume)+"]";
   }
   g_bars_job.next=end;
   if(end<g_bars_job.limit) return;
   string metadata="";
   if(g_bars_job.range_mode) metadata=",\"time_basis\":\"broker_server\",\"range\":{\"from_server\":"+IntegerToString(g_bars_job.from_server)+",\"to_server\":"+IntegerToString(g_bars_job.to_server)+"}";
   WsText(g_bars_job.peer,"{\"type\":\"bars\",\"request_id\":"+JStr(g_bars_job.request_id)+",\"symbol\":"+JStr(g_bars_job.symbol)+
      ",\"tf\":"+JStr(g_bars_job.tf)+",\"bars\":["+g_bars_job.rows+"],"+IdentityFields()+metadata+"}");
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
bool PendingStopsValid(const bool buy,const double price,const double sl,const double tp)
{
   if(price<=0 || !PriceValid(price) || !PriceValid(sl) || !PriceValid(tp)) return false;
   double distance=(double)SymbolInfoInteger(InpSymbol,SYMBOL_TRADE_STOPS_LEVEL)*SymbolInfoDouble(InpSymbol,SYMBOL_POINT);
   if(sl>0 && (buy ? sl>=price || price-sl<distance : sl<=price || sl-price<distance)) return false;
   if(tp>0 && (buy ? tp<=price || tp-price<distance : tp>=price || price-tp<distance)) return false;
   return true;
}
bool NettingOrderAllowed(const string action,string &error)
{
   if(LocalHedging()) return true;
   if(!InpAllowNettingManage && action!="market")
   {error="NETTING_MANAGEMENT_REQUIRED: pending orders may affect a future net position";return false;}
   for(int i=0;i<PositionsTotal();i++)
   {
      if(PositionGetTicket(i)==0) {error="Cannot verify current position ownership";return false;}
      string symbol=PositionGetString(POSITION_SYMBOL);
      if(symbol=="") {error="Cannot read current position symbol";return false;}
      if(symbol!=InpSymbol) continue;
      if(!InpAllowNettingManage || (InpManageOwnMagicOnly && PositionGetInteger(POSITION_MAGIC)!=InpMagic))
      {error="NETTING_EXPOSURE: a new order could change an existing position outside local consent";return false;}
   }
   for(int i=0;i<OrdersTotal();i++)
   {
      if(OrderGetTicket(i)==0) {error="Cannot verify current pending-order ownership";return false;}
      string symbol=OrderGetString(ORDER_SYMBOL);
      if(symbol=="") {error="Cannot read pending-order symbol";return false;}
      if(symbol!=InpSymbol) continue;
      if(!InpAllowNettingManage || (InpManageOwnMagicOnly && OrderGetInteger(ORDER_MAGIC)!=InpMagic))
      {error="NETTING_EXPOSURE: a pending order may affect this net position";return false;}
   }
   return true;
}
bool ExposureAllowed(const double volume,string &error)
{
   double exposure=0;
   for(int i=0;i<PositionsTotal();i++)
   {
      if(PositionGetTicket(i)==0) {error="Cannot read current exposure";return false;}
      string symbol=PositionGetString(POSITION_SYMBOL);
      if(symbol=="") {error="Cannot read current exposure symbol";return false;}
      if(symbol!=InpSymbol) continue;
      double amount=PositionGetDouble(POSITION_VOLUME);
      if(!MathIsValidNumber(amount) || amount<0) {error="Invalid current exposure";return false;}
      exposure+=amount;
   }
   for(int i=0;i<OrdersTotal();i++)
   {
      if(OrderGetTicket(i)==0) {error="Cannot read pending exposure";return false;}
      string symbol=OrderGetString(ORDER_SYMBOL);
      if(symbol=="") {error="Cannot read pending exposure symbol";return false;}
      if(symbol!=InpSymbol) continue;
      double amount=OrderGetDouble(ORDER_VOLUME_CURRENT);
      if(!MathIsValidNumber(amount) || amount<0) {error="Invalid pending exposure";return false;}
      exposure+=amount;
   }
   if(!MathIsValidNumber(exposure) || exposure+volume>InpMaxSymbolLots+1e-9)
   {error="Total symbol exposure exceeds local limit";return false;}
   return true;
}
bool OpeningAllowed(const string action,const double volume,string &error)
{
   if(!NewOrderAction(action)) return true;
   if(!NettingOrderAllowed(action,error) || !ExposureAllowed(volume,error)) return false;
   if(LocalReal() && (InpRealMaxLots<=0 || volume>InpRealMaxLots+1e-9))
   {error="Real account lot cap exceeded";return false;}
   return g_risk.LossAllowed(InpSymbol,InpMaxDailyLoss,error);
}
void HandleTradeCommand(const int peer,const string js)
{
   const long received_utc=LocalUtcMs();const ulong received_mono=GetTickCount64();
   string id="",action="",side="",symbol="",position="",order="",ticket="";
   JsonGetString(js,"command_id",id);JsonGetString(js,"action",action);JsonGetString(js,"side",side);JsonGetString(js,"symbol",symbol);
   JsonGetString(js,"position_ticket",position);JsonGetString(js,"order_ticket",order);JsonGetString(js,"ticket",ticket);
   if(!SafeCommandId(id)) {LocalError(peer,"COMMAND_ID","command_id must be 8..64 ASCII letters/digits/-/_");return;}
   if(!JsonKeysAllowed("type,token,account_id,server,epoch,command_id,action,side,symbol,volume,price,sl,tp,deviation,position_ticket,order_ticket,ticket,expires_at_ms"))
   {WsText(peer,CommandResult(id,"rejected","Unknown command field"));return;}
   double volume=0,sl=0,tp=0,price=0,deviation=InpMaxDeviationPoints,expires=0;
   if(!JsonNumber(js,"volume",volume)||!JsonNumber(js,"price",price)||!JsonNumber(js,"sl",sl)||!JsonNumber(js,"tp",tp)||!JsonNumber(js,"deviation",deviation,InpMaxDeviationPoints)||!JsonNumber(js,"expires_at_ms",expires))
   {WsText(peer,CommandResult(id,"rejected","Invalid numeric field"));return;}
   string payload=action+"|"+side+"|"+symbol+"|"+DoubleToString(volume,8)+"|"+DoubleToString(price,12)+"|"+DoubleToString(sl,12)+"|"+DoubleToString(tp,12)+"|"+
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
   else if(!LocalCanTrade()) error="READ_ONLY: trading needs EA opt-in and healthy journal (real accounts also need InpAllowRealTrading and caps)";
   else if(!TerminalInfoInteger(TERMINAL_CONNECTED)||!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)||!MQLInfoInteger(MQL_TRADE_ALLOWED)||!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)||!AccountInfoInteger(ACCOUNT_TRADE_EXPERT)) error="MT5 trading permissions or connection unavailable";
   else if(!LocalDeadlineValid(expires,received_utc)) error="Command expired or deadline is more than 30s ahead; check computer clock";
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
      bool buy=side=="buy";
      if(error=="" && !StopsValid(buy,sl,tp,tick)) error="SL/TP side or broker stop distance invalid";
      request.action=TRADE_ACTION_DEAL;request.type=buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      request.price=buy ? tick.ask : tick.bid;request.volume=volume;request.sl=sl;request.tp=tp;request.magic=(ulong)InpMagic;
   }
   else if(error=="" && (action=="limit" || action=="stop"))
   {
      bool buy=side=="buy";
      if(!InpAllowPending) error="Pending orders are disabled by this EA";
      else if(symbol!=InpSymbol || (side!="buy" && side!="sell") || !VolumeValid(volume)) error="Pending order symbol/side/volume invalid";
      else if(!PriceValid(price)) error="Pending price must be a positive price on the tick grid";
      else if(!PendingSideValid(action,buy,price,tick)) error="Pending price is on the wrong side of the market (buy limit < ask, buy stop > ask)";
      else if(!PendingStopsValid(buy,price,sl,tp)) error="Pending SL/TP must use the entry price and broker stop distance";
      else
      {
         // 偏离中间价太远就拒绝：防止输错一位数挂到天上去。
         double mid=(tick.bid+tick.ask)/2.0;
         if(InpMaxPendingDeviationPct>0 && mid>0 && MathAbs(price-mid)/mid*100.0>InpMaxPendingDeviationPct)
            error="Pending price deviates too far from the mid price";
         if(error=="")
         {
            request.action=TRADE_ACTION_PENDING;
            if(action=="limit") request.type=buy ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_SELL_LIMIT;
            else request.type=buy ? ORDER_TYPE_BUY_STOP : ORDER_TYPE_SELL_STOP;
            request.price=price;request.volume=volume;request.sl=sl;request.tp=tp;request.magic=(ulong)InpMagic;
            request.type_time=ORDER_TIME_GTC;request.expiration=0;request.type_filling=ORDER_FILLING_RETURN;
         }
      }
   }
   else if(error=="" && action=="close")
   {
      if(!InpAllowClose || !JsonId(js,"position_ticket",position) || !PositionSelectByTicket((ulong)StringToInteger(position))) error="Close disabled or position not found";
      else if(!LocalManageAllowed()) error="Netting account: close is disabled (ownership cannot be proven). Set InpAllowNettingManage=true to override";
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
      else if(!LocalManageAllowed()) error="Netting account: modify is disabled (ownership cannot be proven). Set InpAllowNettingManage=true to override";
      else if(PositionGetString(POSITION_SYMBOL)!=InpSymbol || (InpManageOwnMagicOnly && PositionGetInteger(POSITION_MAGIC)!=InpMagic)) error="Position is outside local ownership policy";
      else if(JsonValuePos(js,"sl")<0 || JsonValuePos(js,"tp")<0 || !StopsValid(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY,sl,tp,tick)) error="Modify requires explicit valid sl and tp (0 clears)";
      else {request.action=TRADE_ACTION_SLTP;request.position=(ulong)StringToInteger(ticket);request.sl=sl;request.tp=tp;}
   }
   else if(error=="") error="Unsupported trading action";
   request.symbol=InpSymbol;request.deviation=(ulong)MathMax(0,deviation);
   request.comment="tpl:"+StringSubstr(id,0,26);
   if(error=="" && request.action==TRADE_ACTION_DEAL && !SetFill(request)) error="No supported broker filling mode; no retry will be attempted";
   if(error=="" && !OpeningAllowed(action,volume,error) && error=="") error="New order risk check failed";
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
   bool reserved=false;
   long reserved_day=0;
   if(LocalReal() && NewOrderAction(action))
   {
      long broker_day=(long)TimeTradeServer()/86400;
      if(!g_risk.Reserve(id,broker_day,InpRealMaxOrdersPerDay,error))
      {
         g_risk_ok=g_risk.Healthy();g_commands[index].state="rejected";
         g_commands[index].result=CommandResult(id,"rejected",error);
         JournalAppend(index);WsText(peer,g_commands[index].result);return;
      }
      reserved=true;reserved_day=broker_day;
   }
   if(!JournalAppend(index))
   {
      if(reserved) {string release_error;g_risk.Release(id,release_error);g_risk_ok=g_risk.Healthy();}
      g_commands[index].state="rejected";
      g_commands[index].result=CommandResult(id,"rejected","Could not flush durable intent; order was not sent");
      WsText(peer,g_commands[index].result);return;
   }
   // Re-check consent, exposure and current losses after durable IO. Account
   // changes and failed risk reads cannot fall through to the one OrderSend.
   error="";
   if(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))!=g_account || AccountInfoString(ACCOUNT_SERVER)!=g_server)
      error="Account changed before submission";
   else if(!LocalCanTrade() || !TerminalInfoInteger(TERMINAL_CONNECTED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ||
           !MQLInfoInteger(MQL_TRADE_ALLOWED) || !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) || !AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
      error="Trading permission or risk storage changed before submission";
   else if(!OpeningAllowed(action,volume,error) && error=="") error="New order risk check failed before submission";
   if(error=="" && reserved && (long)TimeTradeServer()/86400!=reserved_day)
      error="Broker day changed before submission; order was not sent";
   if(error=="" && !LocalDeadlineReady(expires,received_utc,received_mono,LocalUtcMs(),GetTickCount64()))
      error="Command expired before submission; order was not sent";
   if(error!="")
   {
      if(reserved) {string release_error;g_risk.Release(id,release_error);g_risk_ok=g_risk.Healthy();}
      g_commands[index].state="rejected";g_commands[index].result=CommandResult(id,"rejected",error);
      JournalAppend(index);WsText(peer,g_commands[index].result);return;
   }
   g_last_command=GetTickCount64();
   bool sent=OrderSend(request,result);
   if(!sent && result.retcode==0) result.comment="Submission result unknown; MT5 error "+IntegerToString(GetLastError());
   // RETURN leaves the unfilled remainder working: keep tracking its exact order.
   // IOC cancels the remainder and may finish as a terminal partial execution.
   string state=LocalSubmissionState(result.retcode,request.type_filling);
   // A pending-placement command is done once the broker accepts the order.
   // The working order is managed separately; waiting for its future fill would
   // lock the browser out of issuing a cancel command for that same order.
   if(request.action==TRADE_ACTION_PENDING && result.retcode==10008) state="completed";
   if(reserved && state=="rejected") {string release_error;g_risk.Release(id,release_error);g_risk_ok=g_risk.Healthy();}
   g_commands[index].state=state;
   g_commands[index].broker_order=result.order;g_commands[index].broker_deal=result.deal;
   g_commands[index].result=CommandResult(id,state,result.comment,result.retcode,result.order,result.deal,result.price,result.volume);
   if(!JournalAppend(index))
   {
      // Intent is durable, outcome may not be. Keep RAM result; prohibit further trading.
      g_journal_ok=false;
      Print("SyncTrade: outcome journal flush failed; trading disabled. Inspect MT5 history.");
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
   if(type=="command") {HandleTradeCommand(peer,js);g_history_defer_until=GetTickCount64()+1000;return;}
   if(type=="history")
   {
      if(!JsonKeysAllowed(allowed+",request_id,from,to,cursor,limit")) {string rid="";JsonGetString(js,"request_id",rid);LocalError(peer,"FIELDS","Unknown history field",rid);return;}
      BeginHistory(peer,js);return;
   }
   if(type=="bars")
   {
      if(!JsonKeysAllowed(allowed+",request_id,symbol,tf,limit,from_server,to_server")) {LocalError(peer,"FIELDS","Unknown history field");return;}
      BeginBars(peer,js);return;
   }
   if(type=="command_status")
   {
      g_history_defer_until=GetTickCount64()+1000;
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
   if(!MQLInfoInteger(MQL_DLLS_ALLOWED)) {Print("SyncTrade: allow system DLL imports in EA settings");return INIT_FAILED;}
   if(StringFind(InpAllowedOrigin,"https://")!=0 || StringFind(InpAllowedOrigin,"/",8)>=0 || StringFind(InpAllowedOrigin," ")>=0 || StringFind(InpAllowedOrigin,"*")>=0)
   {Print("SyncTrade: allowed origin must be one exact https origin without path/wildcards");return INIT_PARAMETERS_INCORRECT;}
   if(!MathIsValidNumber(InpMaxOrderLots) || !MathIsValidNumber(InpMaxSymbolLots) || !MathIsValidNumber(InpRealMaxLots) ||
      !MathIsValidNumber(InpMaxDailyLoss) || !MathIsValidNumber(InpMaxPendingDeviationPct) || InpRealMaxLots<0 || InpRealMaxOrdersPerDay<0 ||
      InpMaxDailyLoss<0 || InpMaxPendingDeviationPct<0 || InpMaxOrderLots<=0 || InpMaxSymbolLots<InpMaxOrderLots ||
      InpMaxDeviationPoints<0 || InpMaxSpreadPoints<0 || InpMagic<0 || !SymbolSelect(InpSymbol,true)) return INIT_PARAMETERS_INCORRECT;
   g_digits=(int)SymbolInfoInteger(InpSymbol,SYMBOL_DIGITS);
   g_bar_push_ms=(int)MathMax(50,MathMin(1000,InpBarPushMs));
   g_tick_push_ms=(int)MathMax(50,MathMin(1000,InpTickPushMs));
   g_instance=RandomHex(16);
   if(g_instance=="") return INIT_FAILED;
   AccountChanged();
   if(g_epoch=="" || g_pair_code=="") return INIT_FAILED;
   if(!WsStart(LOCAL_PORT)) {Print("SyncTrade: cannot bind 127.0.0.1:18765; another EA may already own the port. Error=",WSAGetLastError());WsStop();return INIT_FAILED;}
   MakeButton(g_button_allow,"允许本次连接 / Allow",10);MakeButton(g_button_revoke,"撤销授权 / Revoke",185);
   // Object clicks arrive as CHARTEVENT_OBJECT_CLICK; no ChartSetInteger flag is required.
   if(!EventSetMillisecondTimer(15)) {WsStop();return INIT_FAILED;}
   PaintStatus();return INIT_SUCCEEDED;
}
void OnDeinit(const int reason)
{
   EventKillTimer();WsStop();
   g_risk.Close();g_risk_ok=false;
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
   // Let accepted commands settle before optional bars/history backfill.
   if(GetTickCount64()>=g_history_defer_until && GetTickCount64()-now<5) {PumpBars();PumpHistory();}
   if(now-g_last_tick>=(ulong)g_tick_push_ms)
   {
      g_last_tick=now;string tick=TickJson();
      for(int i=0;i<LOCAL_PEERS;i++)
         if(g_local_peers[i].authenticated && ArraySize(g_local_peers[i].tx)-g_local_peers[i].tx_offset<32768)
            WsText(i,"{\"type\":\"tick\",\"tick\":"+tick+"}");
   }
   // 当前 K 线独立于 1 秒快照节奏，按 tick 驱动高频推送，让蜡烛实时伸缩。
   // 自适应背压：发送缓冲越积压，推送间隔越长，撞上限前先降频而不是硬断。
   // <16KiB 全速；16–32KiB 间隔翻倍降频；>=32KiB 这轮让给 tick，靠下一轮补。
   if(g_bar_dirty)
   {
      bool pushed=false;
      for(int i=0;i<LOCAL_PEERS;i++)
      {
         if(!g_local_peers[i].authenticated) continue;
         int backlog=ArraySize(g_local_peers[i].tx)-g_local_peers[i].tx_offset;
         ulong interval=backlog<16384 ? (ulong)g_bar_push_ms : (ulong)g_bar_push_ms*2;
         if(backlog<32768 && now-g_last_bar>=interval) {SendCurrentBars(i);pushed=true;}
      }
      if(pushed) {g_last_bar=now;g_bar_dirty=false;}
   }
   if(g_force_snapshot || now-g_last_snapshot>=1000)
   {
      g_last_snapshot=now;g_force_snapshot=false;
      for(int i=0;i<LOCAL_PEERS;i++) if(g_local_peers[i].authenticated && ArraySize(g_local_peers[i].tx)-g_local_peers[i].tx_offset<65536)
         SendSnapshot(i);
      PaintStatus();
   }
}
void OnTick() { g_bar_dirty=true; /* 只置脏标记，网络 IO 统一在 OnTimer，避免与 OrderSend 阻塞交叉。 */ }
void OnChartEvent(const int id,const long &lparam,const double &dparam,const string &sparam)
{
   if(id!=CHARTEVENT_OBJECT_CLICK) {AccountChanged();return;}
   // 点按钮时不要先跑 AccountChanged：它可能重建配对码/重绘，把这次点击吃掉。
   // 每一步都留痕，点不动的时候看"专家"日志就知道卡在哪一层。
   long left=(g_pending_until>GetTickCount64()) ? (long)(g_pending_until-GetTickCount64()) : 0;
   if(sparam==g_button_allow)
      Print("SyncTrade: Allow clicked; pending=",g_pending_peer," left_ms=",left,
            " upgraded=",(g_pending_peer>=0 && g_pending_peer<LOCAL_PEERS ? (string)g_local_peers[g_pending_peer].upgraded : "n/a"));
   else if(sparam==g_button_revoke)
      Print("SyncTrade: Revoke clicked; token=",(g_token!=""?"set":"none"));
   else {AccountChanged();return;}
   AccountChanged();
   if(sparam==g_button_revoke)
   {ClearAuthorization();NewPairCode();ObjectSetInteger(0,g_button_revoke,OBJPROP_STATE,false);PaintStatus();return;}
   ObjectSetInteger(0,g_button_allow,OBJPROP_STATE,false);
   if(g_pending_peer<0 || g_pending_peer>=LOCAL_PEERS)
   {
      // 以前这里静默 return，看起来就是"点了没反应"：明确提示重新输码。
      Print("SyncTrade: Allow ignored - no pairing request is waiting");
      NewPairCode();PaintStatus();ChartRedraw();return;
   }
   if(GetTickCount64()>g_pending_until)
   {
      Print("SyncTrade: Allow ignored - pairing request expired");
      LocalError(g_pending_peer,"PAIR_EXPIRED","Local approval timed out");g_pending_peer=-1;g_pending_until=0;
      NewPairCode();PaintStatus();ChartRedraw();return;
   }
   if(!g_local_peers[g_pending_peer].upgraded || g_local_peers[g_pending_peer].closing)
   {
      Print("SyncTrade: Allow ignored - the website socket is gone, reconnect from the site");
      g_pending_peer=-1;g_pending_until=0;PaintStatus();ChartRedraw();return;
   }
   // The only route to issue a new session token is this local chart click.
   g_token=RandomHex(32);
   if(g_token=="") {LocalError(g_pending_peer,"RNG","Could not create session token");return;}
   int peer=g_pending_peer;g_pending_peer=-1;g_pending_until=0;
   g_session_peer=peer;g_local_peers[peer].authenticated=true;
   g_bar_dirty=true;g_last_bar=0;  // 配对后立即推一帧当前 K 线，不等下一个 tick
   WsText(peer,"{\"type\":\"paired\",\"token\":"+JStr(g_token)+","+IdentityFields()+",\"symbol\":"+JStr(InpSymbol)+"}");
   g_pair_code="--------";g_pair_until=GetTickCount64()+PAIR_TTL_MS;
   SendSnapshot(peer);PaintStatus();
   Print("SyncTrade: pairing approved for peer ",peer);
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
