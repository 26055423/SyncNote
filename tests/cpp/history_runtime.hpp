// MT5 API test double. The history pager itself is read from bridge/, not copied.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>
using string=std::string;
using uchar=unsigned char;
using ushort=unsigned short;
using uint=unsigned int;
using datetime=std::int64_t;
template<class T> int ArraySize(const std::vector<T>& v){return static_cast<int>(v.size());}
template<class T> int ArrayResize(std::vector<T>& v,int n){v.resize(n);return n;}
template<class A,class B> auto MathMax(A a,B b){return std::max<std::common_type_t<A,B>>(a,b);}
template<class A,class B> auto MathMin(A a,B b){return std::min<std::common_type_t<A,B>>(a,b);}
bool MathIsValidNumber(double d){return std::isfinite(d);}
template<class T> string IntegerToString(T n){return std::to_string(n);}
string DoubleToString(double d,int){std::ostringstream out;out<<std::setprecision(16)<<d;return out.str();}
int StringLen(const string& s){return static_cast<int>(s.size());}
ushort StringGetCharacter(const string& s,int i){return static_cast<unsigned char>(s.at(i));}
void StringSetCharacter(string& s,int i,ushort c){s.at(i)=static_cast<char>(c);}
string StringSubstr(const string& s,int start,int length=-1){return s.substr(start,length<0?string::npos:length);}
template<class... T> string StringFormat(const char* pattern,T... args){char out[256];std::snprintf(out,sizeof(out),pattern,args...);return out;}
int StringSplit(const string& text,ushort separator,std::vector<string>& parts){parts.clear();std::size_t start=0;for(;;){auto next=text.find(static_cast<char>(separator),start);parts.push_back(text.substr(start,next==string::npos?next:next-start));if(next==string::npos)break;start=next+1;}return ArraySize(parts);}
constexpr int CP_UTF8=65001,CRYPT_HASH_SHA256=1;
int StringToCharArray(const string& s,std::vector<uchar>& out,int,int,int){out.assign(s.begin(),s.end());out.push_back(0);return ArraySize(out);}
int CryptEncode(int,const std::vector<uchar>&,const std::vector<uchar>&,std::vector<uchar>&){throw std::logic_error("Cryptographic hashing is outside this history harness");}

enum IntegerProperty{DEAL_TIME_MSC,DEAL_TIME,DEAL_ORDER,DEAL_POSITION_ID,DEAL_TYPE,DEAL_ENTRY,DEAL_MAGIC,DEAL_REASON};
enum DoubleProperty{DEAL_VOLUME,DEAL_PRICE,DEAL_PROFIT,DEAL_COMMISSION,DEAL_SWAP,DEAL_FEE};
enum StringProperty{DEAL_SYMBOL,DEAL_COMMENT,DEAL_EXTERNAL_ID};
constexpr int ACCOUNT_LOGIN=1,ACCOUNT_SERVER=2,DEAL_TYPE_BUY=0,DEAL_TYPE_SELL=1;
struct FakeDeal{std::uint64_t ticket,position,order;std::int64_t stamp;int type,entry;double price=2400,volume=.1,profit=0;};
std::vector<FakeDeal> fake_deals;
std::vector<std::uint64_t> fake_selected;
std::set<std::uint64_t> fake_missing_positions;
std::set<std::uint64_t> fake_timestamp_failures;
std::int64_t fake_login=1001;
string fake_server="Synthetic-Demo";
int fake_queries=0,fake_error=0;
bool fake_change_during_query=false;
bool fake_change_during_select=false;
const FakeDeal* FakeFind(std::uint64_t ticket){for(const auto& d:fake_deals)if(d.ticket==ticket)return &d;return nullptr;}
std::int64_t AccountInfoInteger(int){return fake_login;}
string AccountInfoString(int){return fake_server;}
void ResetLastError(){fake_error=0;}
int GetLastError(){return fake_error;}
bool HistorySelect(datetime from,datetime to){fake_selected.clear();if(fake_change_during_select){fake_login++;return true;}for(const auto& d:fake_deals)if(d.stamp/1000>=from&&d.stamp/1000<=to)fake_selected.push_back(d.ticket);return true;}
bool HistorySelectByPosition(std::uint64_t position){fake_queries++;fake_selected.clear();if(fake_change_during_query)fake_login++;if(fake_missing_positions.count(position)){fake_error=4401;return false;}for(const auto& d:fake_deals)if(d.position==position)fake_selected.push_back(d.ticket);return true;}
int HistoryDealsTotal(){return ArraySize(fake_selected);}
std::uint64_t HistoryDealGetTicket(int i){return i<0||i>=ArraySize(fake_selected)?0:fake_selected[i];}
bool HistoryDealSelect(std::uint64_t ticket){fake_selected.clear();if(!FakeFind(ticket)){fake_error=4401;return false;}fake_selected.push_back(ticket);return true;}
std::int64_t HistoryDealGetInteger(std::uint64_t ticket,IntegerProperty p){const auto* d=FakeFind(ticket);if(!d){fake_error=4401;return 0;}if(p==DEAL_TIME_MSC&&fake_timestamp_failures.count(ticket)){fake_error=4403;return 0;}switch(p){case DEAL_TIME_MSC:return d->stamp;case DEAL_TIME:return d->stamp/1000;case DEAL_ORDER:return static_cast<std::int64_t>(d->order);case DEAL_POSITION_ID:return static_cast<std::int64_t>(d->position);case DEAL_TYPE:return d->type;case DEAL_ENTRY:return d->entry;default:return 0;}}
bool HistoryDealGetInteger(std::uint64_t ticket,IntegerProperty p,std::int64_t& out){if(!FakeFind(ticket)||(p==DEAL_TIME_MSC&&fake_timestamp_failures.count(ticket))){fake_error=4403;return false;}out=HistoryDealGetInteger(ticket,p);return true;}
double HistoryDealGetDouble(std::uint64_t ticket,DoubleProperty p){const auto* d=FakeFind(ticket);if(!d)return 0;switch(p){case DEAL_VOLUME:return d->volume;case DEAL_PRICE:return d->price;case DEAL_PROFIT:return d->profit;default:return 0;}}
string HistoryDealGetString(std::uint64_t ticket,StringProperty p){const auto* d=FakeFind(ticket);return p==DEAL_SYMBOL&&d&&d->type<2?"XAUUSD":"";}
