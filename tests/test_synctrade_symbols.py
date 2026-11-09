"""Execute the production symbol-selection handler with synthetic MT5 IO."""
import json,os,subprocess,tempfile,unittest
from pathlib import Path
from test_ea_history import compiler_environment,cpp_source
from test_synctrade_commands import function
ROOT=Path(__file__).resolve().parents[1]

class SymbolSelectionTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  command,environment,msvc=compiler_environment()
  cls.temp=tempfile.TemporaryDirectory(prefix='synctrade-symbols-');cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);cpp=folder/'symbols.cpp';cls.executable=folder/('symbols.exe' if os.name=='nt' else 'symbols')
  source=(ROOT/'bridge/SyncTrade.mq5').read_text(encoding='utf-8-sig')
  support=r'''
string g_symbol="XAUUSD";int g_digits=2;long g_symbol_tick_msc=1;
std::uint64_t g_last_tick=1,g_last_bar=1;bool g_bar_dirty=false;
constexpr int SYMBOL_DIGITS=100;
struct BarsJob{bool active=true;int peer=0;string request_id="read-old",rows="old";std::vector<int> rates{1};}g_bars_job;
bool SymbolSelect(const string& symbol,bool){return symbol=="NAS100";}
void LocalError(int,const string& code,const string&,const string& rid=""){fake_events.push_back(code+":"+rid);}
string IdentityFields(){return "\"account_id\":\"1001\"";}
string TradeQuoteSessionsJson(){return g_symbol=="NAS100" ? "[[1,3600,86400]]" : "null";}
void SendSnapshot(int){fake_events.push_back("snapshot:"+g_symbol);}
void PaintStatus(){}
'''
  main=r'''
int main(int argc,char** argv){
 if(argc!=2)return 2;string scenario=argv[1];
 if(scenario!="ready"){LocalCommandEntry command;command.state=scenario;g_commands.push_back(command);}
 string request;std::getline(std::cin,request);if(!JsonValidateFlat(request))return 3;
 SelectSymbol(0,request);
 string events="[";for(int i=0;i<ArraySize(fake_events);i++){if(i)events+=",";events+=JStr(fake_events[i]);}events+="]";
 std::cout<<"{\"symbol\":"<<JStr(g_symbol)<<",\"bars_active\":"<<(g_bars_job.active?"true":"false")<<",\"events\":"<<events<<",\"response\":"<<(fake_reply.empty()?"null":fake_reply)<<",\"sends\":"<<fake_sends<<"}";
}
'''
  cpp.write_text('\n'.join([(ROOT/'tests/cpp/synctrade_runtime.hpp').read_text(encoding='utf-8'),cpp_source((ROOT/'bridge/SyncNoteLocalJson.mqh').read_text(encoding='utf-8-sig')),support,cpp_source(function(source,'SelectSymbol')),main]),encoding='utf-8')
  command+=([str(cpp),'/Fe:'+str(cls.executable),'/Fo:'+str(folder/'symbols.obj')] if msvc else [str(cpp),'-o',str(cls.executable)])
  result=subprocess.run(command,env=environment,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)

 def select(self,state,symbol='NAS100'):
  result=subprocess.run([str(self.executable),state],input=json.dumps({'type':'select_symbol','request_id':'switch-1','symbol':symbol}),capture_output=True,text=True,check=True)
  return json.loads(result.stdout)

 def test_unresolved_commands_block_symbol_switch_without_orders_or_read_cancellation(self):
  for state in ('intent','received','submitted','uncertain'):
   with self.subTest(state=state):
    result=self.select(state)
    self.assertEqual(result['symbol'],'XAUUSD');self.assertTrue(result['bars_active'])
    self.assertIn('COMMAND_UNRESOLVED:switch-1',result['events']);self.assertEqual(result['sends'],0)

 def test_terminal_commands_allow_switch_and_cancel_stale_reads(self):
  for state in ('ready','completed','rejected'):
   with self.subTest(state=state):
    result=self.select(state)
    self.assertEqual(result['symbol'],'NAS100');self.assertFalse(result['bars_active'])
    self.assertEqual(result['response']['symbol'],'NAS100');self.assertEqual(result['response']['request_id'],'switch-1')
    self.assertEqual(result['response']['quote_sessions'],[[1,3600,86400]])
    self.assertIn('SYMBOL_CHANGED:read-old',result['events']);self.assertEqual(result['sends'],0)

 def test_unknown_broker_code_preserves_current_symbol(self):
  result=self.select('ready','NAS100-does-not-exist')
  self.assertEqual(result['symbol'],'XAUUSD');self.assertTrue(result['bars_active'])
  self.assertIn('SYMBOL_UNAVAILABLE:switch-1',result['events']);self.assertEqual(result['sends'],0)

if __name__=='__main__':unittest.main()
