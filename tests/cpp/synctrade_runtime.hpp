// Synthetic MT5/journal boundary for executing the production command handler.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>
using string=std::string;using ushort=unsigned short;using uchar=unsigned char;using uint=unsigned int;using datetime=std::int64_t;
template<class T> int ArraySize(const std::vector<T>& v){return static_cast<int>(v.size());}
template<class T> int ArrayResize(std::vector<T>& v,int n){v.resize(n);return n;}
template<class A,class B> auto MathMax(A a,B b){return std::max<std::common_type_t<A,B>>(a,b);}
template<class A,class B> auto MathMin(A a,B b){return std::min<std::common_type_t<A,B>>(a,b);}
double MathAbs(double d){return std::abs(d);}double MathRound(double d){return std::round(d);}double MathFloor(double d){return std::floor(d);}bool MathIsValidNumber(double d){return std::isfinite(d);}
template<class T> string IntegerToString(T n){return std::to_string(n);}
string DoubleToString(double d,int digits){std::ostringstream out;if(digits>=0)out<<std::fixed<<std::setprecision(digits);else out<<std::setprecision(-digits);out<<d;return out.str();}
int StringLen(const string& s){return static_cast<int>(s.size());}ushort StringGetCharacter(const string& s,int i){return static_cast<unsigned char>(s.at(i));}void StringSetCharacter(string& s,int i,ushort c){s.at(i)=static_cast<char>(c);}
string StringSubstr(const string& s,int start,int length=-1){return s.substr(start,length<0?string::npos:length);}string CharToString(int c){return string(1,static_cast<char>(c));}
int StringFind(const string& s,const string& part,int start=0){auto p=s.find(part,start);return p==string::npos?-1:static_cast<int>(p);}int StringCompare(const string& a,const string& b){return a.compare(b);}double StringToDouble(const string& s){return std::stod(s);}std::int64_t StringToInteger(const string& s){return std::stoll(s);}
template<class T> void ZeroMemory(T& v){v=T{};}template<class... T> void Print(T...){ }

enum {ACCOUNT_TRADE_MODE=1,ACCOUNT_MARGIN_MODE,ACCOUNT_LOGIN,ACCOUNT_TRADE_ALLOWED,ACCOUNT_TRADE_EXPERT,ACCOUNT_SERVER,TERMINAL_CONNECTED,TERMINAL_TRADE_ALLOWED,MQL_TRADE_ALLOWED};
enum {ACCOUNT_TRADE_MODE_DEMO=0,ACCOUNT_TRADE_MODE_CONTEST=1,ACCOUNT_TRADE_MODE_REAL=2};
enum {ACCOUNT_MARGIN_MODE_RETAIL_NETTING=0,ACCOUNT_MARGIN_MODE_EXCHANGE=1,ACCOUNT_MARGIN_MODE_RETAIL_HEDGING=2};
enum {SYMBOL_VOLUME_MIN=1,SYMBOL_VOLUME_MAX,SYMBOL_VOLUME_STEP,SYMBOL_TRADE_TICK_SIZE,SYMBOL_POINT,SYMBOL_TRADE_STOPS_LEVEL,SYMBOL_FILLING_MODE,SYMBOL_TRADE_EXEMODE};
enum {SYMBOL_FILLING_FOK=1,SYMBOL_FILLING_IOC=2,SYMBOL_TRADE_EXECUTION_MARKET=2,SYMBOL_TRADE_EXECUTION_EXCHANGE=3};
enum {ORDER_FILLING_FOK=0,ORDER_FILLING_IOC=1,ORDER_FILLING_RETURN=2};
using ENUM_ORDER_TYPE_FILLING=int;
enum {TRADE_ACTION_DEAL=1,TRADE_ACTION_PENDING=5,TRADE_ACTION_SLTP=6,TRADE_ACTION_REMOVE=8};
enum {ORDER_TYPE_BUY=0,ORDER_TYPE_SELL=1,ORDER_TYPE_BUY_LIMIT=2,ORDER_TYPE_SELL_LIMIT=3,ORDER_TYPE_BUY_STOP=4,ORDER_TYPE_SELL_STOP=5,ORDER_TIME_GTC=0};
enum {POSITION_SYMBOL=1,POSITION_VOLUME,POSITION_MAGIC,POSITION_TYPE,POSITION_TYPE_BUY=0,POSITION_TYPE_SELL=1};
enum {ORDER_SYMBOL=1,ORDER_VOLUME_CURRENT,ORDER_MAGIC};
struct MqlTick{double bid=100,ask=101;std::int64_t time=1700000000,time_msc=1700000000000LL;};
struct MqlTradeRequest{int action=0,type=0,type_filling=0,type_time=0;double volume=0,price=0,sl=0,tp=0;std::uint64_t position=0,order=0,magic=0,deviation=0;datetime expiration=0;string symbol,comment;};
struct MqlTradeResult{uint retcode=0;std::uint64_t order=0,deal=0;double price=0,volume=0;string comment;};
int fake_mode=ACCOUNT_TRADE_MODE_DEMO,fake_margin=ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;bool fake_permissions=true,fake_journal_failure=false,fake_switch_account=false,fake_manual_appears=false;std::int64_t fake_utc=1700000000000LL,fake_login=1001;std::uint64_t fake_mono=10000;int fake_flush_delay=0,fake_sends=0;uint fake_retcode=10009;
std::vector<string> fake_events;string fake_reply;MqlTradeRequest fake_request;MqlTick fake_tick;int fake_fill_flags=SYMBOL_FILLING_IOC;int fake_execution=SYMBOL_TRADE_EXECUTION_MARKET;
struct FakePosition{std::uint64_t ticket;std::int64_t magic;double volume;int side;string symbol="XAUUSD";};
std::vector<FakePosition> fake_positions;int fake_position_index=-1;
struct FakeOrder{std::uint64_t ticket;std::int64_t magic;double volume;string symbol="XAUUSD";};std::vector<FakeOrder> fake_orders;int fake_order_index=-1;
std::int64_t AccountInfoInteger(int p){if(p==ACCOUNT_TRADE_MODE)return fake_mode;if(p==ACCOUNT_MARGIN_MODE)return fake_margin;if(p==ACCOUNT_LOGIN)return fake_login;return fake_permissions;}
string AccountInfoString(int){return "Synthetic-Demo";}std::int64_t TerminalInfoInteger(int){return fake_permissions;}std::int64_t MQLInfoInteger(int){return fake_permissions;}
std::int64_t LocalUtcMs(){return fake_utc;}std::uint64_t GetTickCount64(){return fake_mono;}datetime TimeTradeServer(){return fake_utc/1000;}datetime TimeCurrent(){return TimeTradeServer();}
double SymbolInfoDouble(const string&,int p){switch(p){case SYMBOL_VOLUME_MIN:return .01;case SYMBOL_VOLUME_MAX:return 100;case SYMBOL_VOLUME_STEP:return .01;case SYMBOL_TRADE_TICK_SIZE:return .01;case SYMBOL_POINT:return .01;default:return 0;}}
std::int64_t SymbolInfoInteger(const string&,int p){if(p==SYMBOL_TRADE_STOPS_LEVEL)return 10;if(p==SYMBOL_FILLING_MODE)return fake_fill_flags;if(p==SYMBOL_TRADE_EXEMODE)return fake_execution;return 0;}
bool SymbolInfoTick(const string&,MqlTick& t){t=fake_tick;return true;}
int PositionsTotal(){return ArraySize(fake_positions);}std::uint64_t PositionGetTicket(int i){if(i<0||i>=PositionsTotal())return 0;fake_position_index=i;return fake_positions[i].ticket;}
bool PositionSelectByTicket(std::uint64_t ticket){for(int i=0;i<PositionsTotal();i++)if(fake_positions[i].ticket==ticket){fake_position_index=i;return true;}return false;}
string PositionGetString(int){return fake_positions.at(fake_position_index).symbol;}double PositionGetDouble(int){return fake_positions.at(fake_position_index).volume;}std::int64_t PositionGetInteger(int p){return p==POSITION_MAGIC?fake_positions.at(fake_position_index).magic:fake_positions.at(fake_position_index).side;}
int OrdersTotal(){return ArraySize(fake_orders);}std::uint64_t OrderGetTicket(int i){if(i<0||i>=OrdersTotal())return 0;fake_order_index=i;return fake_orders[i].ticket;}bool OrderSelect(std::uint64_t ticket){for(int i=0;i<OrdersTotal();i++)if(fake_orders[i].ticket==ticket){fake_order_index=i;return true;}return false;}string OrderGetString(int){return fake_orders.at(fake_order_index).symbol;}double OrderGetDouble(int){return fake_orders.at(fake_order_index).volume;}std::int64_t OrderGetInteger(int){return fake_orders.at(fake_order_index).magic;}
int GetLastError(){return 0;}bool OrderSend(const MqlTradeRequest& request,MqlTradeResult& result){fake_events.push_back("send");fake_request=request;fake_sends++;result.retcode=fake_retcode;result.order=9001;result.deal=9002;result.price=request.price;result.volume=request.volume;return true;}
string HashHex(const string& text){return text;}// Stable synthetic fingerprint; crypto is not under test here.
string g_account="1001",g_server="Synthetic-Demo";bool g_journal_ok=true,g_account_stable=true,g_force_snapshot=false,g_risk_ok=true;std::uint64_t g_last_command=0;int g_real_orders_day=-1,g_real_orders=0;
constexpr int JOURNAL_MAX=10000;
struct LocalCommandEntry{string id,fingerprint,state,result;std::uint64_t broker_order=0,broker_deal=0;};std::vector<LocalCommandEntry> g_commands;
int CommandFind(const string& id){for(int i=ArraySize(g_commands)-1;i>=0;i--)if(g_commands[i].id==id)return i;return -1;}
bool JournalAppend(int index){fake_events.push_back("journal:"+g_commands[index].state);fake_utc+=fake_flush_delay;fake_mono+=fake_flush_delay;if(fake_switch_account)fake_login++;if(fake_manual_appears&&g_commands[index].state=="intent")fake_positions.push_back({7002,0,.01,POSITION_TYPE_BUY});return !fake_journal_failure;}
void WsText(int,const string& text){fake_reply=text;}string CurrentResultIdentity(const string& text){return text;}
