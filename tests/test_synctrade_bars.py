"""Production range preparation and deferred reads with synthetic MT5 history."""
import json,re,subprocess,tempfile,unittest
from pathlib import Path
from test_ea_history import compiler_environment,cpp_source
from test_synctrade_commands import function
ROOT=Path(__file__).resolve().parents[1]
class RangeLoading(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  source=(ROOT/'bridge/SyncTrade.mq5').read_text(encoding='utf-8-sig')
  struct=re.search(r'struct LocalBarsJob\s*\{.*?\};',source,re.S).group()
  support=r'''
using ENUM_TIMEFRAMES=int;
constexpr int PERIOD_CURRENT=0,SERIES_SYNCHRONIZED=1,SYMBOL_DIGITS=99;
struct MqlRates{std::int64_t time;double open=10,high=11,low=9,close=10;std::int64_t tick_volume=1;};
struct Peer{bool authenticated=true;std::vector<int> tx;int tx_offset=0;}g_local_peers[1];
struct HistoryJob{bool active=false;}g_history_job;
string g_symbol="NAS100",last_error="";std::int64_t g_offset=0,requested_from=0;int count_result=1;
bool synced=false;
bool SymbolSelect(const string&,bool){return true;}
int LocalTf(const string& tf){return tf=="1m"?60:0;}
int PeriodSeconds(int tf){return tf;}
bool SeriesInfoInteger(const string&,int,int){return synced;}
void LocalError(int,const string& code,const string&,const string&="");
'''.replace('const string&=""','const string& rid=""')+r'''
void LocalError(int,const string& code,const string&,const string& rid){last_error=code;}
string IdentityFields(){return "\"account_id\":\"1001\"";}
int CopyRates(const string&,int,std::int64_t from,std::int64_t,std::vector<MqlRates>& rows){requested_from=from;rows.clear();if(count_result>0){MqlRates row;row.time=from;rows.push_back(row);}return count_result;}
int CopyRates(const string&,int,int,int,std::vector<MqlRates>&){return -1;}
'''
  main=r'''
int main(int argc,char** argv){
 string kind=argv[1];if(kind=="empty")count_result=0;if(kind=="unavailable")count_result=-1;
 string js;std::getline(std::cin,js);if(!JsonValidateFlat(js))return 2;
 BeginBars(0,js);bool queued=g_bars_job.active;
 for(int i=0;i<3&&g_bars_job.active;i++)PumpBars();
 std::cout<<"{\"queued\":"<<(queued?"true":"false")<<",\"from\":"<<requested_from<<",\"error\":"<<JStr(last_error)<<",\"response\":"<<(fake_reply.empty()?"null":fake_reply)<<"}";
}
'''
  cls.temp=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.temp.cleanup);folder=Path(cls.temp.name);cpp=folder/'range.cpp';cls.exe=folder/'range.exe'
  cpp.write_text('\n'.join([(ROOT/'tests/cpp/synctrade_runtime.hpp').read_text(),cpp_source((ROOT/'bridge/SyncNoteLocalJson.mqh').read_text(encoding='utf-8-sig')),support,cpp_source(struct),'LocalBarsJob g_bars_job;',cpp_source(function(source,'BeginBars')),cpp_source(function(source,'PumpBars')),main]),encoding='utf-8')
  command,env,msvc=compiler_environment();command+=([str(cpp),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'range.obj')] if msvc else [str(cpp),'-o',str(cls.exe)])
  result=subprocess.run(command,env=env,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)
 def read(self,kind='range',ranged=True):
  body={'request_id':'range-1','symbol':'NAS100','tf':'1m','limit':2000 if ranged else 300}
  if ranged:body.update(from_server=60000,to_server=60120)
  return json.loads(subprocess.run([str(self.exe),kind],input=json.dumps(body),capture_output=True,text=True,check=True).stdout)
 def test_explicit_range_loads_unready_history_without_clipping_requested_start(self):
  result=self.read();self.assertTrue(result['queued']);self.assertEqual(result['from'],60000);self.assertEqual(result['response']['bars'][0][0],60000)
 def test_live_bootstrap_keeps_synchronized_series_guard(self):
  result=self.read(ranged=False);self.assertFalse(result['queued']);self.assertEqual(result['error'],'HISTORY_UNAVAILABLE')
 def test_empty_range_is_distinct_from_history_not_ready(self):
  self.assertEqual(self.read('empty')['response']['bars'],[])
  self.assertEqual(self.read('unavailable')['error'],'HISTORY_UNAVAILABLE')
if __name__=='__main__':unittest.main()
