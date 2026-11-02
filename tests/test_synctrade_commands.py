"""Native execution of the current SyncTrade command handler with fake MT5 IO.

The test extracts production functions, never copies their validation algorithm.
No terminal, broker connection, real file journal or order is used.
"""
import json,os,re,subprocess,tempfile,unittest
from pathlib import Path
from test_ea_history import compiler_environment,cpp_source
ROOT=Path(__file__).resolve().parents[1]

def function(source,name):
 match=re.search(r'^(?:bool|string|void|double|int|long|ulong)\s+'+re.escape(name)+r'\s*\(',source,re.M)
 if not match:raise AssertionError('Production function not found: '+name)
 start=source.find('{',match.start());depth=1;i=start+1;quote=None;comment=None
 while i<len(source) and depth:
  c=source[i];n=source[i:i+2]
  if comment=='line':
   if c=='\n':comment=None
  elif comment=='block':
   if n=='*/':comment=None;i+=1
  elif quote:
   if c=='\\':i+=1
   elif c==quote:quote=None
  elif n=='//':comment='line';i+=1
  elif n=='/*':comment='block';i+=1
  elif c in ('"',"'"):quote=c
  elif c=='{':depth+=1
  elif c=='}':depth-=1
  i+=1
 if depth:raise AssertionError('Unclosed production function '+name)
 return source[match.start():i]

class CommandHandlerTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  command,environment,msvc=compiler_environment();cls.temp=tempfile.TemporaryDirectory(prefix='synctrade-commands-');cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);cpp=folder/'commands.cpp';cls.executable=folder/('commands.exe' if os.name=='nt' else 'commands')
  source=(ROOT/'bridge/SyncTrade.mq5').read_text(encoding='utf-8-sig')
  inputs='\n'.join(re.findall(r'^input\s+(.+?;)',source,re.M))
  selected=['LocalDemo','LocalReal','LocalHedging','LocalManageAllowed','LocalCanTrade','NewOrderAction','NettingOrderAllowed','ExposureAllowed','OpeningAllowed','VolumeValid','PriceValid','StopsValid','PendingStopsValid','PendingSideValid','SetFill','HandleTradeCommand']
  fragments=[(ROOT/'tests/cpp/synctrade_runtime.hpp').read_text(encoding='utf-8'),cpp_source(inputs),cpp_source((ROOT/'bridge/SyncNoteLocalJson.mqh').read_text(encoding='utf-8-sig'))]
  policy=ROOT/'bridge/SyncNoteLocalSafety.mqh'
  if policy.exists():fragments.append(cpp_source(policy.read_text(encoding='utf-8-sig')))
  fragments.append((ROOT/'tests/cpp/synctrade_commands_support.hpp').read_text(encoding='utf-8'))
  fragments.extend(cpp_source(function(source,name)) for name in selected)
  fragments.append((ROOT/'tests/cpp/synctrade_commands_scenarios.cpp').read_text(encoding='utf-8'))
  cpp.write_text('\n'.join(fragments),encoding='utf-8')
  command+=([str(cpp),'/Fe:'+str(cls.executable),'/Fo:'+str(folder/'commands.obj')] if msvc else [str(cpp),'-o',str(cls.executable)])
  result=subprocess.run(command,env=environment,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError('Production command harness failed to compile:\n'+result.stdout+'\n'+result.stderr)

 def run_command(self,scenario='demo',**patch):
  request={'type':'command','command_id':'synthetic-command-1','action':'market','side':'buy','symbol':'XAUUSD','volume':.02,'sl':0,'tp':0,'deviation':20,'expires_at_ms':1700000010000}
  request.update(patch)
  result=subprocess.run([str(self.executable),scenario],input=json.dumps(request),capture_output=True,text=True,check=True)
  return json.loads(result.stdout)

 def test_demo_and_explicit_real_trading_reach_submission(self):
  for scenario in ('demo','real_enabled'):
   with self.subTest(scenario=scenario):
    result=self.run_command(scenario);self.assertEqual(result['sends'],1,result)
    self.assertEqual(result['result']['state'],'completed',result)

 def test_permission_real_switch_and_deadline_fail_closed(self):
  for scenario in ('trading_off','real_off','real_zero_cap','contest','permissions_off','expired','journal_failed','expires_during_flush','account_changes_during_flush'):
   with self.subTest(scenario=scenario):
    result=self.run_command(scenario);self.assertEqual(result['sends'],0,result)
    self.assertEqual(result['result']['state'],'rejected',result)

 def test_netting_market_cannot_alter_existing_manual_position(self):
  result=self.run_command('netting_manual');self.assertEqual(result['sends'],0,result)
  self.assertEqual(result['result']['state'],'rejected',result)

 def test_netting_close_and_modify_require_explicit_manage_permission(self):
  for action,payload in (('close',{'position_ticket':'7001'}),('modify',{'ticket':'7001','sl':99,'tp':103})):
   with self.subTest(action=action):
    result=self.run_command('netting_owned',action=action,**payload);self.assertEqual(result['sends'],0,result)
    self.assertEqual(result['result']['state'],'rejected',result)

 def test_pending_orders_use_return_and_stops_relative_to_entry(self):
  for action,side,price,sl,tp in (('limit','buy',99.5,99,100),('limit','sell',101.5,102,101),('stop','buy',101.5,101,102),('stop','sell',99.5,100,99)):
   with self.subTest(action=action,side=side):
    result=self.run_command(action=action,side=side,price=price,sl=sl,tp=tp)
    self.assertEqual(result['sends'],1,result)
    self.assertEqual(result['request']['type_filling'],2,result)

 def test_pending_stops_crossing_entry_are_rejected(self):
  result=self.run_command(action='limit',side='buy',price=99.5,sl=99.75,tp=101.5)
  self.assertEqual(result['sends'],0,result)
  self.assertEqual(result['result']['state'],'rejected',result)

 def test_real_risk_failures_block_before_any_broker_call(self):
  for scenario in ('real_risk_unhealthy','real_loss_unavailable','real_reserve_failed'):
   with self.subTest(scenario=scenario):
    result=self.run_command(scenario);self.assertEqual(result['sends'],0,result)
    self.assertEqual(result['result']['state'],'rejected',result)

 def test_real_reservation_is_durable_before_send_and_duplicate_is_not_resent(self):
  result=self.run_command('real_duplicate');self.assertEqual(result['sends'],1,result)
  self.assertEqual(result['events'].count('risk:reserve'),1,result)
  self.assertLess(result['events'].index('risk:reserve'),result['events'].index('send'),result)
  self.assertLess(result['events'].index('journal:intent'),result['events'].index('send'),result)
  self.assertEqual(result['reserved'],1,result)

 def test_unknown_result_keeps_reservation_but_known_rejection_releases_it(self):
  unknown=self.run_command('real_unknown_result');self.assertEqual(unknown['sends'],1,unknown)
  self.assertEqual(unknown['result']['state'],'uncertain',unknown)
  self.assertEqual(unknown['reserved'],1,unknown)
  self.assertNotIn('risk:release',unknown['events'])
  rejected=self.run_command('real_broker_rejected');self.assertEqual(rejected['sends'],1,rejected)
  self.assertEqual(rejected['result']['state'],'rejected',rejected)
  self.assertEqual(rejected['reserved'],0,rejected)
  self.assertIn('risk:release',rejected['events'])

 def test_new_manual_netting_position_during_flush_blocks_submit_and_releases(self):
  result=self.run_command('real_netting_changes_during_flush')
  self.assertEqual(result['sends'],0,result)
  self.assertEqual(result['result']['state'],'rejected',result)
  self.assertEqual(result['reserved'],0,result)
  self.assertIn('risk:release',result['events'])

 def test_broker_midnight_after_reservation_rejects_and_releases_old_day_slot(self):
  result=self.run_command('real_midnight_during_flush',expires_at_ms=1700006409500)
  self.assertEqual(result['sends'],0,result)
  self.assertEqual(result['result']['state'],'rejected',result)
  self.assertIn('day changed',result['result']['error'].lower(),result)
  self.assertEqual(result['reserved'],0,result)
  self.assertIn('risk:release',result['events'])

 def test_exposure_and_unreadable_inventory_fail_closed(self):
  for scenario in ('position_symbol_unavailable','order_symbol_unavailable','pending_exposure_limit','netting_existing_order'):
   with self.subTest(scenario=scenario):
    result=self.run_command(scenario);self.assertEqual(result['sends'],0,result)
    self.assertEqual(result['result']['state'],'rejected',result)

 def test_real_account_change_before_send_releases_the_old_reservation(self):
  result=self.run_command('real_account_changes_during_flush')
  self.assertEqual(result['sends'],0,result)
  self.assertEqual(result['result']['state'],'rejected',result)
  self.assertEqual(result['reserved'],0,result)
  self.assertIn('risk:release',result['events'])

 def test_placed_pending_completes_placement_but_placed_market_stays_submitted(self):
  pending=self.run_command('real_broker_placed',action='limit',price=99.5,sl=99,tp=100)
  self.assertEqual(pending['sends'],1,pending)
  self.assertEqual(pending['result']['retcode'],10008,pending)
  self.assertEqual(pending['result']['state'],'completed',pending)
  self.assertEqual(pending['reserved'],1,pending)
  self.assertNotIn('risk:release',pending['events'])
  market=self.run_command('real_broker_placed')
  self.assertEqual(market['sends'],1,market)
  self.assertEqual(market['result']['retcode'],10008,market)
  self.assertEqual(market['result']['state'],'submitted',market)
  self.assertEqual(market['reserved'],1,market)
  self.assertNotIn('risk:release',market['events'])

if __name__=='__main__':unittest.main()
