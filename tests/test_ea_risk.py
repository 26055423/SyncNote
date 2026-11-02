"""Execute the actual SyncTradeRisk.mqh with MT5 history/filesystem failure doubles.

The risk algorithm and journal parser are production code; only MQL primitive
widths and platform calls are adapted. HashHex is a deterministic API double,
so this suite checks chain validation, not the platform's SHA-256 primitive.
"""
import os,subprocess,tempfile,unittest
from pathlib import Path
from test_ea_history import compiler_environment,cpp_source
ROOT=Path(__file__).resolve().parents[1]
class RiskRuntimeTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  command,environment,msvc=compiler_environment();cls.temp=tempfile.TemporaryDirectory(prefix='synctrade-risk-');cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);source=folder/'risk.cpp';cls.exe=folder/('risk.exe' if os.name=='nt' else 'risk')
  runtime=(ROOT/'tests/cpp/synctrade_risk_runtime.hpp').read_text(encoding='utf-8-sig')
  module=cpp_source((ROOT/'bridge/SyncTradeRisk.mqh').read_text(encoding='utf-8-sig'))
  # MQL SEEK_END has the C runtime's same numeric value; no algorithm substitution.
  module=module.replace('SEEK_END','SEEK_END_MQL')
  scenarios=(ROOT/'tests/cpp/synctrade_risk_scenarios.cpp').read_text(encoding='utf-8-sig')
  source.write_text(runtime+'\n'+module+'\n'+scenarios,encoding='utf-8')
  command+=([str(source),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'risk.obj')] if msvc else [str(source),'-o',str(cls.exe)])
  result=subprocess.run(command,env=environment,cwd=folder,capture_output=True,text=True,timeout=90)
  if result.returncode:raise AssertionError('Actual risk module failed to compile:\n'+result.stdout+result.stderr)
 def scenario(self,name):
  result=subprocess.run([str(self.exe),name],capture_output=True,text=True,timeout=30)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertIn('Risk production module scenario passed',result.stdout)
 def test_all_entries_costs_and_boundary(self):self.scenario('loss_entries')
 def test_symbol_scope_and_deposit_exclusion(self):self.scenario('loss_scope')
 def test_history_getters_and_numeric_fail_closed(self):self.scenario('loss_failures')
 def test_metadata_errors_are_not_treated_as_empty_state(self):self.scenario('metadata_failures')
 def test_reservations_survive_restart_and_unknown_results(self):self.scenario('quota_restart')
 def test_release_is_durable_and_days_are_isolated(self):self.scenario('quota_release_day')
 def test_accounts_servers_and_file_locks(self):self.scenario('quota_accounts_lock')
 def test_unsent_old_account_reservation_can_be_released_after_switch(self):self.scenario('quota_account_switch_release')
 def test_corrupted_and_unreadable_journal(self):self.scenario('journal_corruption')
 def test_partial_write_flush_and_release_failures(self):self.scenario('journal_write_failures')
if __name__=='__main__':unittest.main()
