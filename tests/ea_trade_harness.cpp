#include <windows.h>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

using std::uint64_t;
double MathFloor(double value) { return std::floor(value); }
enum ENUM_ORDER_TYPE_FILLING { ORDER_FILLING_FOK=0, ORDER_FILLING_IOC=1, ORDER_FILLING_RETURN=2 };
// MQL5 long/ulong are always 64 bit, whereas MSVC long is 32 bit.
#define long std::int64_t
#define ulong std::uint64_t
#define uint std::uint32_t
#define string std::string
#include "../bridge/SyncNoteLocalSafety.mqh"
#undef string
#undef uint
#undef ulong
#undef long

void expect(bool condition,const char* message) { if(!condition) throw std::runtime_error(message); }
std::int64_t precise_utc() {
 FILETIME ft{};GetSystemTimePreciseAsFileTime(&ft);
 std::uint64_t ticks=0;static_assert(sizeof(ticks)==sizeof(ft));std::memcpy(&ticks,&ft,sizeof(ticks));
 return LocalUnixMsFromFileTime(ticks);
}
// Simulate a blocking journal flush before the same final guard used immediately
// before OrderSend in SyncTrade. Broker calls must stay zero on expiry/clock jump.
struct FakeSubmit {
 std::int64_t received_utc=1000800,now_utc=received_utc;
 std::uint64_t received_mono=5000,now_mono=received_mono;
 int broker_calls=0;
 bool submit(double deadline,std::int64_t journal_ms,std::int64_t wall_adjust=0) {
  if(!LocalDeadlineValid(deadline,received_utc)) return false;
  now_utc+=journal_ms+wall_adjust;now_mono+=journal_ms;
  if(!LocalDeadlineReady(deadline,received_utc,received_mono,now_utc,now_mono)) return false;
  ++broker_calls;return true;
 }
};
int main() {
 try {
  expect(LocalSubmissionState(10010,ORDER_FILLING_RETURN)=="submitted","RETURN partial must remain pending");
  expect(LocalSubmissionState(10010,ORDER_FILLING_IOC)=="completed","IOC partial is terminal");
  expect(LocalSubmissionState(10009,ORDER_FILLING_RETURN)=="completed","Full RETURN fill must finish");
  expect(LocalSubmissionState(10008,ORDER_FILLING_RETURN)=="submitted","Placed remains pending");
  expect(LocalSubmissionState(10012,ORDER_FILLING_IOC)=="uncertain","Timeout must remain uncertain");
  expect(LocalSubmissionState(10031,ORDER_FILLING_IOC)=="uncertain","Connection error must remain uncertain");
  expect(LocalSubmissionState(0,ORDER_FILLING_IOC)=="uncertain","Missing broker result must remain uncertain");
  expect(LocalSubmissionState(10006,ORDER_FILLING_IOC)=="rejected","Reject must remain rejected");
  expect(!LocalDeadlineValid(1000500,1000800),"Subsecond-expired deadline accepted");
  expect(!LocalDeadlineValid(1000800,1000800),"Deadline boundary accepted");
  expect(LocalDeadlineValid(1030800,1000800),"Maximum accepted window rejected");
  expect(!LocalDeadlineValid(1030801,1000800),"Overlong deadline accepted");
  expect(!LocalDeadlineValid(1000801.5,1000800),"Fractional deadline accepted");
  expect(!LocalDeadlineValid(std::numeric_limits<double>::infinity(),1000800),"Infinite deadline accepted");
  expect(!LocalDeadlineValid(std::numeric_limits<double>::quiet_NaN(),1000800),"NaN deadline accepted");
  expect(!LocalDeadlineValid(1000900,0),"Missing clock accepted");
  FakeSubmit good;expect(good.submit(1001800,250)&&good.broker_calls==1,"Valid request failed");
  FakeSubmit expired;expect(!expired.submit(1001800,1000)&&expired.broker_calls==0,"Journal delay sent expired order");
  FakeSubmit subsecond;expect(!subsecond.submit(1000500,0)&&subsecond.broker_calls==0,"Already expired order sent");
  FakeSubmit rollback;expect(!rollback.submit(1001800,1500,-1400)&&rollback.broker_calls==0,"Clock rollback renewed order");
  FakeSubmit forward;expect(!forward.submit(1001800,10,1200)&&forward.broker_calls==0,"Clock forward jump sent stale order");
  expect(!LocalDeadlineReady(1001800,1000800,5000,1000900,4999),"Monotonic clock reversal accepted");
  constexpr std::uint64_t epoch=116444736000000000ULL;
  expect(LocalUnixMsFromFileTime(epoch-1)==0,"Invalid FILETIME accepted");
  expect(LocalUnixMsFromFileTime(epoch+10000)==1,"FILETIME epoch conversion wrong");
  expect(LocalUnixMsFromFileTime(epoch+10008009999ULL)==1000800,"FILETIME millisecond conversion wrong");
  auto before=precise_utc();Sleep(25);auto after=precise_utc();
  auto system_ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  expect(after>before&&after-before<500,"Native UTC clock lost subsecond precision");
  expect(std::llabs(after-system_ms)<100,"Native UTC epoch is wrong");
  std::cout<<"28 trade safety behavior checks passed; real Windows UTC advanced "<<(after-before)<<" ms.\n";
 } catch(const std::exception& e) {std::cerr<<e.what()<<"\n";return 1;}
 return 0;
}
