"""Execute the actual MQL pager under native C++ with a synthetic MT5 API.

Only language/API compatibility is adapted. No history pagination or context
algorithm is reimplemented. MetaEditor compilation remains a separate check.
"""
import json,os,re,shutil,sqlite3,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import sync_history

def cpp_source(text):
 text=re.sub(r'^\s*#include "[^"\n]+"\s*$', '',text,flags=re.M)
 text=re.sub(r'\b([A-Za-z_]\w*)\s+((?:\w+\[\]\s*,\s*)*\w+\[\])(?=\s*[;=])',lambda m:'std::vector<'+m[1]+'> '+m[2].replace('[]',''),text)
 # MQL long is 64-bit even on Windows, where native C++ long is 32-bit.
 text=re.sub(r'\bulong\b','std::uint64_t',text)
 text=re.sub(r'\blong\b','std::int64_t',text)
 text=text.replace('"%I64u"','"%llu"')
 return text

def compiler_environment():
 for name in ('g++','clang++'):
  found=shutil.which(name)
  if found:return [found,'-std=c++17'],os.environ.copy(),False
 if os.name=='nt':
  patterns=[Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Microsoft Visual Studio',Path(os.environ.get('ProgramFiles(x86)','C:/Program Files (x86)'))/'Microsoft Visual Studio']
  vcvars=next((p for base in patterns if base.exists() for p in base.glob('*/**/VC/Auxiliary/Build/vcvars64.bat')),None)
  if vcvars:
   result=subprocess.run(f'cmd.exe /d /c call "{vcvars}" >nul && set',capture_output=True,text=True,check=True)
   environment=os.environ.copy()
   for line in result.stdout.splitlines():
    if '=' in line and not line.startswith('='):
     key,value=line.split('=',1);environment[key]=value
   compiler=shutil.which('cl.exe',path=environment.get('Path',environment.get('PATH','')))
   if compiler:return [compiler,'/nologo','/EHsc','/std:c++17','/utf-8'],environment,True
 raise unittest.SkipTest('A native C++ compiler (MSVC, GCC or Clang) is required for MQL history runtime tests')

class HistoryRuntimeTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  command,environment,msvc=compiler_environment()
  cls.temp=tempfile.TemporaryDirectory(prefix='syncnote-history-runtime-')
  cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);source=folder/'history.cpp';cls.executable=folder/('history.exe' if os.name=='nt' else 'history')
  fragments=[(ROOT/'tests/cpp/history_runtime.hpp').read_text(encoding='utf-8')]
  for name in ('SyncNoteJson.mqh','SyncNoteHistory.mqh'):fragments.append(cpp_source((ROOT/'bridge'/name).read_text(encoding='utf-8-sig')))
  fragments.append((ROOT/'tests/cpp/history_scenarios.cpp').read_text(encoding='utf-8'))
  source.write_text('\n'.join(fragments),encoding='utf-8')
  command+=([str(source),'/Fe:'+str(cls.executable),'/Fo:'+str(folder/'history.obj')] if msvc else [str(source),'-o',str(cls.executable)])
  result=subprocess.run(command,env=environment,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError('MQL compatibility harness compilation failed:\n'+result.stdout+'\n'+result.stderr)

 def scenario(self,name):
  result=subprocess.run([str(self.executable),name],capture_output=True,text=True,check=True)
  return json.loads(result.stdout)

 def ingest(self,result):
  db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;self.addCleanup(db.close)
  db.execute('CREATE TABLE trades(person TEXT,ticket TEXT,payload TEXT,PRIMARY KEY(person,ticket))');sync_history.initialize(db)
  account='1001';server='Synthetic-Demo';ack=None
  for index,page in enumerate(result['pages']):
   body={'schema':sync_history.SCHEMA,'account':account,'server':server,'account_key':sync_history.account_key(server,account),'currency':'USD',
    'batch_id':'runtime-page-'+str(index),'server_offset_sec':10800,'time_basis':'broker_server','range':{'from_server':1700000000,'to_server':1700003600},
    'deals':page['deals'],'checkpoint':{'through_server':page['through_server'],'last_deal_ticket':page['deals'][-1]['deal_ticket'] if page['deals'] else '0','window_complete':not page['has_more']}}
   ack=sync_history.ingest(db,'synthetic-review-user',body)
  return db,ack

 def test_actual_emitter_provides_origin_and_server_derives_trade(self):
  result=self.scenario('normal');db,ack=self.ingest(result)
  self.assertEqual(ack['closed_trades_updated'],1)
  self.assertEqual(ack['summary_warnings'],0)
  trade=json.loads(db.execute('SELECT payload FROM trades').fetchone()[0])
  self.assertEqual((trade['open'],trade['close'],trade['profit']),(2400,2410,100))
  self.assertEqual(result['queries'],1)
  self.assertLessEqual(result['max_queries_per_pump'],1)
  for row in result['pages'][0]['deals']:
   self.assertEqual((row['position_context_status'],row['position_first_deal_ticket'],row['position_first_time_msc_server']),('available','501',1700000001000))

 def test_position_lookup_mutates_selection_without_losing_other_positions(self):
  result=self.scenario('many_positions');db,ack=self.ingest(result)
  self.assertEqual(db.execute('SELECT count(*) FROM trades').fetchone()[0],4)
  self.assertEqual(len(result['pages'][0]['deals']),8)
  self.assertEqual(result['queries'],4)
  self.assertLessEqual(result['max_queries_per_pump'],1)

 def test_unavailable_and_oversize_context_never_forge_an_origin(self):
  for scenario,status in (('unavailable','unavailable'),('too_large','too_large')):
   with self.subTest(scenario=scenario):
    result=self.scenario(scenario);db,ack=self.ingest(result)
    self.assertEqual(db.execute('SELECT count(*) FROM trades').fetchone()[0],0)
    self.assertEqual(ack['summary_warnings'],2)
    for row in result['pages'][0]['deals']:
     self.assertEqual((row['position_context_status'],row['position_first_deal_ticket'],row['position_first_time_msc_server']),(status,'0',0))

 def test_origin_outside_range_is_disclosed_but_raw_window_is_not_expanded(self):
  result=self.scenario('outside');db,ack=self.ingest(result)
  self.assertEqual(len(result['pages'][0]['deals']),1)
  self.assertEqual(result['pages'][0]['deals'][0]['position_first_deal_ticket'],'501')
  self.assertEqual(db.execute('SELECT count(*) FROM trades').fetchone()[0],0)
  self.assertEqual(ack['issues'][0]['status'],'context_unverified')

 def test_same_second_pagination_preserves_large_tickets_and_coverage(self):
  result=self.scenario('same_second');self.assertEqual(len(result['pages']),2)
  self.assertEqual(result['pages'][0]['through_server'],1699999999)
  self.assertEqual(result['pages'][1]['through_server'],1700003600)
  ids=[row['deal_ticket'] for page in result['pages'] for row in page['deals']]
  self.assertEqual(ids,[str(9007199254740993+i) for i in range(150)])
  db,ack=self.ingest(result)
  self.assertEqual(db.execute('SELECT count(*) FROM mt5_raw_deals').fetchone()[0],150)
  self.assertEqual(result['queries'],0)

 def test_account_switch_during_context_read_rejects_page(self):
  result=self.scenario('account_change')
  self.assertIn('ACCOUNT_CHANGED',result.get('error',''))
  self.assertNotIn('pages',result)

 def test_timestamp_read_failure_on_resume_cannot_skip_a_deal_or_ack_the_window(self):
  result=self.scenario('timestamp_failure_resume')
  self.assertIn('HISTORY_TIMESTAMP_FAILED',result.get('error',''))
  self.assertEqual(result['completed_pages'],1)
  self.assertNotIn('pages',result)

 def test_account_switch_during_empty_select_cannot_ack_an_empty_window(self):
  result=self.scenario('account_change_empty_select')
  self.assertIn('ACCOUNT_CHANGED',result.get('error',''))
  self.assertEqual(result['completed_pages'],0)
  self.assertNotIn('pages',result)

if __name__=='__main__':unittest.main()
