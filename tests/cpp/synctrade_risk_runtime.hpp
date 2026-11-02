// Platform API double only. The risk implementation is loaded verbatim from bridge/.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
using string=std::string;using uint=unsigned int;using ushort=unsigned short;using datetime=std::int64_t;
constexpr int INVALID_HANDLE=-1,FILE_READ=1,FILE_WRITE=2,FILE_BIN=4,FILE_ANSI=8,CP_UTF8=65001,CHAR_VALUE=1,SEEK_END_MQL=2;
constexpr int ACCOUNT_LOGIN=1,ACCOUNT_SERVER=2;
constexpr int DEAL_TYPE_BUY=0,DEAL_TYPE_SELL=1,DEAL_TYPE_BALANCE=2,DEAL_TYPE_CREDIT=3,DEAL_TYPE_CHARGE=4,DEAL_TYPE_CORRECTION=5,DEAL_TYPE_BONUS=6,DEAL_TYPE_COMMISSION=7,DEAL_TYPE_COMMISSION_DAILY=8,DEAL_TYPE_COMMISSION_MONTHLY=9,DEAL_TYPE_COMMISSION_AGENT_DAILY=10,DEAL_TYPE_COMMISSION_AGENT_MONTHLY=11,DEAL_TYPE_INTEREST=12,DEAL_TAX=13;
constexpr int DEAL_ENTRY_IN=0,DEAL_ENTRY_OUT=1,DEAL_ENTRY_INOUT=2,DEAL_ENTRY_OUT_BY=3;
constexpr int DEAL_TYPE=1,DEAL_ENTRY=2,DEAL_TIME=3,DEAL_SYMBOL=4,DEAL_PROFIT=5,DEAL_SWAP=6,DEAL_COMMISSION=7,DEAL_FEE=8;
std::int64_t login=1001,broker_now=20000LL*86400+3600;string server="Risk-Demo";
int last_error=0,fail_property=-1,fail_ticket_index=-1;
bool fail_select=false,fail_open=false,fail_write=false,fail_flush=false,fail_read=false,fail_seek=false,fail_tell=false,fail_size=false,fail_count=false;
struct MockFile{string bytes;bool locked=false;};
struct Handle{string path;std::size_t position=0;};
std::map<string,MockFile> disk;std::map<int,Handle> handles;int next_handle=1;string last_path;
struct Deal{std::uint64_t ticket;int type,entry;string symbol="XAUUSD";double profit=0,swap=0,commission=0,fee=0;std::int64_t time=broker_now;};
std::vector<Deal> deals;std::vector<std::size_t> selection;
void require(bool yes,const char* message){if(!yes)throw std::runtime_error(message);}
void ResetLastError(){last_error=0;}int GetLastError(){return last_error;}
std::int64_t AccountInfoInteger(int){return login;}string AccountInfoString(int){return server;}datetime TimeTradeServer(){return broker_now;}
bool MathIsValidNumber(double value){return std::isfinite(value);}
int StringLen(const string& s){return static_cast<int>(s.size());}
ushort StringGetCharacter(const string& s,int i){return static_cast<unsigned char>(s.at(i));}
string ShortToString(ushort c){return string(1,static_cast<char>(c));}
template<class T>string IntegerToString(T n){return std::to_string(n);}
std::int64_t StringToInteger(const string& s){try{return std::stoll(s);}catch(...){return 0;}}
int StringFind(const string& s,const string& needle,int from=0){auto p=s.find(needle,static_cast<std::size_t>(std::max(0,from)));return p==string::npos?-1:static_cast<int>(p);}
string StringSubstr(const string& s,int from,int count=-1){return s.substr(from,count<0?string::npos:count);}
// SHA-256 API is outside this harness; deterministic content digests exercise the
// actual module's hash-chain comparison and corruption/failure behavior.
string HashHex(const string& s){std::ostringstream o;for(int i=0;i<4;i++)o<<std::hex<<std::setw(16)<<std::setfill('0')<<static_cast<std::uint64_t>(std::hash<string>{}(s+std::to_string(i)));return o.str();}
bool FolderCreate(const string&){return true;}
int FileOpen(const string& path,int,int,int){last_path=path;if(fail_open||disk[path].locked){last_error=70;return INVALID_HANDLE;}disk[path].locked=true;int h=next_handle++;handles[h]={path,0};return h;}
void FileClose(int h){auto it=handles.find(h);if(it!=handles.end()){disk[it->second.path].locked=false;handles.erase(it);}}
std::uint64_t FileTell(int h){if(fail_tell){last_error=76;return 0;}return handles.at(h).position;}
std::uint64_t FileSize(int h){if(fail_size){last_error=77;return 0;}return disk.at(handles.at(h).path).bytes.size();}
bool FileSeek(int h,std::int64_t offset,int origin){if(fail_seek){last_error=71;return false;}auto& r=handles.at(h);r.position=static_cast<std::size_t>((origin==SEEK_END_MQL?disk.at(r.path).bytes.size():0)+offset);return true;}
int FileReadInteger(int h,int){if(fail_read){last_error=72;return 0;}auto& r=handles.at(h);auto& bytes=disk.at(r.path).bytes;if(r.position>=bytes.size()){last_error=73;return 0;}return static_cast<unsigned char>(bytes[r.position++]);}
uint FileWriteString(int h,const string& s,int n){auto& r=handles.at(h);auto& bytes=disk.at(r.path).bytes;int count=fail_write?n/2:n;if(fail_write)last_error=74;bytes.replace(r.position,count,s.substr(0,count));r.position+=count;return count;}
void FileFlush(int){if(fail_flush)last_error=75;}
bool HistorySelect(datetime from,datetime to){if(fail_select){last_error=80;return false;}selection.clear();for(std::size_t i=0;i<deals.size();i++)if(deals[i].time>=from&&deals[i].time<=to)selection.push_back(i);return true;}
int HistoryDealsTotal(){if(fail_count){last_error=81;return 0;}return static_cast<int>(selection.size());}
std::uint64_t HistoryDealGetTicket(int i){return i==fail_ticket_index?0:deals.at(selection.at(i)).ticket;}
Deal* get(std::uint64_t ticket){for(auto& d:deals)if(d.ticket==ticket)return &d;return nullptr;}
bool HistoryDealGetInteger(std::uint64_t ticket,int property,std::int64_t& out){auto d=get(ticket);if(!d||property==fail_property)return false;if(property==DEAL_TYPE)out=d->type;else if(property==DEAL_ENTRY)out=d->entry;else if(property==DEAL_TIME)out=d->time;else return false;return true;}
bool HistoryDealGetString(std::uint64_t ticket,int property,string& out){auto d=get(ticket);if(!d||property==fail_property||property!=DEAL_SYMBOL)return false;out=d->symbol;return true;}
bool HistoryDealGetDouble(std::uint64_t ticket,int property,double& out){auto d=get(ticket);if(!d||property==fail_property)return false;if(property==DEAL_PROFIT)out=d->profit;else if(property==DEAL_SWAP)out=d->swap;else if(property==DEAL_COMMISSION)out=d->commission;else if(property==DEAL_FEE)out=d->fee;else return false;return true;}
