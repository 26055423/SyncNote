"""Execute the actual SyncNote OnTimer function with deterministic MT5/IO doubles."""
import re,subprocess,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_ea_history import compiler_environment,cpp_source
ROOT=Path(__file__).resolve().parents[1]

class SyncNoteTimerTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  source=(ROOT/'bridge/SyncNote.mq5').read_text(encoding='utf-8-sig')
  start=source.index('void OnTimer()');end=source.index('void OnTradeTransaction',start)
  timer=cpp_source(source[start:end])
  command,env,msvc=compiler_environment()
  cls.temp=tempfile.TemporaryDirectory(prefix='syncnote-timer-');cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);path=folder/'timer.cpp';cls.exe=folder/'timer.exe'
  path.write_text(r'''
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
using string=std::string;
using ulong=std::uint64_t;
template<class A,class B> auto MathMax(A a,B b){return std::max<decltype(a+b)>(a,b);}
bool g_sn_paused=false,bound=true,UploadBars=true,g_sn_bf_inited=false;
ulong tick=10000,g_sn_last_paint=0,g_sn_retry_after=0,g_sn_next_upload=0,g_sn_bf_next=0;
int g_sn_bf_tf=-1;
int SyncSeconds=15,g_sn_ack_batches=0,bar_calls=0,history_calls=0,pauses=0,pair_calls=0,forming_calls=0;
bool quote_due=false;
string g_sn_review_ticket="",g_sn_pending="",g_sn_sync_scope="scope",g_sn_token="synthetic-authorized-token";
struct History {
 bool busy=false,ready=false,failed=false;
 bool Failed(){return failed;} string Error(){return "failed";}
 void Reset(){busy=ready=failed=false;}
 bool Busy(){return busy;} bool Ready(){return ready;}
 void Pump(int){if(busy){busy=false;ready=true;}}
} g_snh;
ulong GetTickCount64(){return tick;}
bool SNStillBound(){return bound;}
void SNPause(string){g_sn_paused=true;pauses++;}
void SNPaint(){}
void SNPairPump(){pair_calls++;}
void SNBackoff(string){g_sn_retry_after=tick+3000;}
void SNTryReview(){g_sn_review_ticket="";}
void SNStartRange(){g_snh.busy=true;}
void SNBuildPending(){g_sn_pending="page";}
void SNUploadPending(){history_calls++;g_sn_ack_batches++;g_sn_pending="";g_snh.Reset();g_sn_next_upload=tick+15000;}
bool SNSymbolsPump(){return false;}
bool SNRangePump(){return false;}
void SNBarsInit(string){g_sn_bf_inited=true;}
bool SNBarsPump(){if(g_sn_ack_batches<1)throw std::runtime_error("unbound bar upload");bar_calls++;return true;}
bool SNFormingPump(ulong){
 if(g_sn_ack_batches<1)throw std::runtime_error("unbound forming upload");
 if(!quote_due)return false;
 quote_due=false;forming_calls++;return true;
}
void check(bool value,const char* why){if(!value)throw std::runtime_error(why);}
''' +timer+r'''
int main(int argc,char** argv){try {
 string name=argc>1?argv[1]:"";
 if(name=="unpaired"){
  g_sn_token="";OnTimer();check(pair_calls==1&&history_calls==0&&bar_calls==0,"unpaired EA must only request pairing, never upload history or bars");
 }else if(name=="first_binding"){
  OnTimer();check(history_calls==1&&bar_calls==0&&g_sn_ack_batches==1,"first request must bind history, never bars");
  tick+=200;OnTimer();check(bar_calls==1&&g_sn_bf_inited,"bars run after the exact history ACK");
 }else if(name=="due_history"){
  g_sn_ack_batches=1;g_sn_bf_inited=true;OnTimer();check(history_calls==1&&bar_calls==0,"due history has priority over a due bar task");
 }else if(name=="disabled"){
  UploadBars=false;OnTimer();tick+=200;OnTimer();check(history_calls==1&&bar_calls==0,"turning off bars must keep history working");
 }else if(name=="account_change"){
  bound=false;OnTimer();check(pauses==1&&history_calls==0&&bar_calls==0,"account switch must stop all requests");
 }else if(name=="fair_schedule"){
  for(int i=0;i<1500;i++){OnTimer();tick+=200;}
  check(history_calls>=15&&bar_calls>=15,"history and continuing bars both make progress");
 }else if(name=="backoff"){
  g_sn_retry_after=tick+3000;g_sn_ack_batches=1;quote_due=true;
  OnTimer();check(history_calls==0&&bar_calls==0&&forming_calls==1,"history backoff must not delay the live quote");
  tick+=200;OnTimer();check(history_calls==0&&bar_calls==0&&forming_calls==1,"no extra upload without a new quote");
 }else throw std::runtime_error("unknown test");
 std::cout<<"ok";return 0;
 }catch(const std::exception& e){std::cerr<<e.what();return 1;}}
''',encoding='utf-8')
  command+=([str(path),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'timer.obj')] if msvc else [str(path),'-o',str(cls.exe)])
  result=subprocess.run(command,env=env,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)

 def scenario(self,name):
  result=subprocess.run([str(self.exe),name],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
  self.assertEqual(result.stdout,'ok')
 def test_first_binding_before_bars(self):self.scenario('first_binding')
 def test_unpaired_never_uploads_account_data(self):self.scenario('unpaired')
 def test_due_history_precedes_bars(self):self.scenario('due_history')
 def test_disabled_bars_keeps_history(self):self.scenario('disabled')
 def test_account_change_stops_requests(self):self.scenario('account_change')
 def test_history_and_incremental_bars_both_continue(self):self.scenario('fair_schedule')
 def test_backoff_does_not_perform_io(self):self.scenario('backoff')

if __name__=='__main__':unittest.main()
