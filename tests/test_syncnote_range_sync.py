"""Execute production requested-range EA code without broker or trade calls."""
import subprocess,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_ea_history import compiler_environment,cpp_source
ROOT=Path(__file__).resolve().parents[1]
class RangeSyncTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  command,env,msvc=compiler_environment();cls.temp=tempfile.TemporaryDirectory(prefix='syncnote-range-');cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);path=folder/'range.cpp';cls.exe=folder/'range.exe'
  support=(ROOT/'tests/cpp/history_runtime.hpp').read_text(encoding='utf-8')
  json=cpp_source((ROOT/'bridge/SyncNoteJson.mqh').read_text(encoding='utf-8-sig'))
  production=cpp_source((ROOT/'bridge/SyncNoteRangeSync.mqh').read_text(encoding='utf-8-sig'))
  path.write_text(support+'\n'+json+r'''
using ulong=std::uint64_t;
enum ENUM_TIMEFRAMES {PERIOD_CURRENT,PERIOD_M1=60,PERIOD_M5=300,PERIOD_M15=900,PERIOD_H1=3600};
int PeriodSeconds(ENUM_TIMEFRAMES p){return (int)p;}
struct MqlRates{datetime time;double open=100,high=102,low=99,close=101;std::int64_t tick_volume=10;};
void ArraySetAsSeries(std::vector<MqlRates>&,bool){}
string g_sn_token="token",g_sn_account="123",g_sn_server="Broker",g_sn_key="key";
int g_sn_ack_batches=1,posts=0,reads=0,pauses=0,wire=200;bool bound=true,change_read=false,wrong_ack=false;
ulong tick=10000;std::int64_t now=1800000000;int read_count=2;string selected;
std::vector<string> bodies;
ulong GetTickCount64(){return tick;}
std::int64_t TimeTradeServer(){return now;}
bool SNStillBound(){return bound;}
void SNPause(string){pauses++;}
bool SymbolSelect(string symbol,bool enable){selected=symbol;return enable;}
int CopyRates(string symbol,ENUM_TIMEFRAMES p,datetime from,datetime to,std::vector<MqlRates>& rows){reads++;if(change_read)bound=false;rows.clear();for(int i=0;i<read_count;i++){MqlRates row;row.time=from+i*(int)p;rows.push_back(row);}return read_count;}
int SNPost(string endpoint,string body,string& reply);
''' +production+r'''
string job(string symbol="NAS100",string key="key",std::int64_t to=1799999820){return "{\"ok\":true,\"job\":{\"job_id\":\"job\",\"segment_id\":\"seg\",\"symbol\":"+SNJQuote(symbol)+",\"tf\":\"M1\",\"account_key\":"+SNJQuote(key)+",\"account\":\"123\",\"server\":\"Broker\",\"from_server\":1799999760,\"to_server\":"+IntegerToString(to)+"}}";}
int SNPost(string endpoint,string body,string& reply){posts++;bodies.push_back(body);if(wire!=200)return wire;
 if(endpoint=="/api/mt5/bar-sync/poll"){reply=job();return 200;}
 if(endpoint!="/api/mt5/bar-sync/result")throw std::runtime_error("unexpected endpoint");
 reply="{\"ok\":true,\"job_id\":\"job\",\"segment_id\":\"seg\",\"account_key\":\"key\",\"symbol\":\"NAS100\",\"tf\":\"M1\",\"from_server\":1799999760,\"to_server\":1799999820,\"status\":\"running\",\"accepted\":"+IntegerToString(g_snr_sent+(wrong_ack?1:0))+"}";return 200;}
void check(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
void start(){check(SNRangePump()&&g_snr_job=="job","poll did not accept");tick=g_snr_next;}
int main(int argc,char** argv){try{string name=argc>1?argv[1]:"";
 if(name=="authorization"){g_sn_token="";check(!SNRangePump()&&posts==0,"unpaired poll");g_sn_token="token";g_sn_ack_batches=0;check(!SNRangePump()&&posts==0,"unbound poll");}
 else if(name=="validation"){check(!SNRangeAccept(job("NAS100","other")),"wrong account accepted");check(!SNRangeAccept(job("NAS100","key",now)),"forming segment accepted");check(!SNRangeAccept(job("NAS100","key",1799999821)),"unaligned segment accepted");}
 else if(name=="success"){start();SNRangePump();check(reads==1&&selected=="NAS100"&&g_snr_sent==2&&!g_snr_pending.empty(),"arbitrary symbol not read");tick=g_snr_next;SNRangePump();check(g_snr_job.empty()&&posts==2,"exact ACK did not finish segment");check(bodies[1].find("\"symbol\":\"NAS100\"")!=string::npos,"raw code missing");}
 else if(name=="empty"){read_count=0;start();for(int i=0;i<3;i++){SNRangePump();tick=g_snr_next;}check(reads==3&&g_snr_sent==0&&g_snr_pending.find("empty_window")!=string::npos,"empty range falsely complete");}
 else if(name=="unavailable"){read_count=-1;start();for(int i=0;i<11;i++){SNRangePump();check(g_snr_pending.empty()&&g_snr_job=="job"&&posts==1,"unavailable prematurely advanced");tick=g_snr_next;}SNRangePump();check(reads==12&&g_snr_pending.find("history_unavailable")!=string::npos,"unavailable retry budget missing");}
 else if(name=="partial"){read_count=1;start();for(int i=0;i<3;i++){SNRangePump();tick=g_snr_next;}check(reads==3&&g_snr_sent==1&&g_snr_pending.find("partial_window")!=string::npos,"partial range falsely complete");}
 else if(name=="ack_retry"){start();SNRangePump();string pending=g_snr_pending;tick=g_snr_next;wrong_ack=true;SNRangePump();check(g_snr_pending==pending&&g_snr_job=="job","wrong ACK dropped page");tick=g_snr_next;wire=500;SNRangePump();check(bodies[1]==bodies[2]&&g_snr_pending==pending,"retry changed payload");tick=g_snr_next;wire=200;wrong_ack=false;SNRangePump();check(g_snr_job.empty(),"valid ACK not accepted");}
 else if(name=="cancel"){start();SNRangePump();tick=g_snr_next;wire=409;SNRangePump();check(g_snr_job.empty()&&g_snr_pending.empty(),"cancelled task retained");}
 else if(name=="account_change"){start();change_read=true;SNRangePump();check(pauses==1&&posts==1&&g_snr_pending.empty(),"account changed during read leaked rows");}
 else throw std::runtime_error("unknown scenario");std::cout<<"ok";return 0;
}catch(const std::exception& e){std::cerr<<e.what();return 1;}}
''',encoding='utf-8')
  command+=([str(path),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'range.obj')] if msvc else [str(path),'-o',str(cls.exe)])
  result=subprocess.run(command,env=env,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)
 def scenario(self,name):
  result=subprocess.run([str(self.exe),name],capture_output=True,text=True);self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout,'ok')
 def test_unpaired_and_unbound_do_not_poll(self):self.scenario('authorization')
 def test_identity_alignment_and_forming_range_validation(self):self.scenario('validation')
 def test_requested_symbol_upload_and_exact_ack(self):self.scenario('success')
 def test_empty_history_is_explicit_after_bounded_retry(self):self.scenario('empty')
 def test_unavailable_history_waits_for_bounded_download(self):self.scenario('unavailable')
 def test_partial_history_is_not_complete(self):self.scenario('partial')
 def test_invalid_ack_and_http_retry_preserve_exact_page(self):self.scenario('ack_retry')
 def test_cancel_discards_pending_job(self):self.scenario('cancel')
 def test_account_change_stops_upload(self):self.scenario('account_change')
if __name__=='__main__':unittest.main()
