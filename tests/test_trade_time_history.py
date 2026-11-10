"""Imported history must use its own broker, never an unrelated account snapshot."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from trade_time import utc_trade

class TradeTimeHistory(unittest.TestCase):
 def trade(self,server='EasyTradingOnlineLtd-Server'):
  return {'source':'syncnote-history.v1','server':server,'closed_server':1793835921,
          'closed':1793825121,'history_offset_seconds':10800,'time_basis':'utc',
          'time_verified':False,'time_estimated':True}

 def clock(self,broker='WebBridge',offset=0,fresh=False):
  return {'broker':broker,'offset':offset,'observed_from':1793800000 if fresh else 1700000000,
          'observed_to':1793900000 if fresh else 1700000010}

 def test_old_webbridge_clock_does_not_hide_imported_dates(self):
  result=utc_trade(self.trade(),self.clock())
  self.assertEqual(result['closed'],1793825121)
  self.assertTrue(result['time_estimated'])

 def test_even_fresh_other_broker_clock_cannot_shift_imported_history(self):
  result=utc_trade(self.trade(),self.clock(fresh=True))
  self.assertEqual(result['closed'],1793825121)
  self.assertFalse(result['time_verified'])

 def test_matching_observation_remains_the_stronger_time_evidence(self):
  result=utc_trade(self.trade(),self.clock('EasyTradingOnlineLtd-Server',10800,True))
  self.assertEqual(result['closed'],1793825121)
  self.assertTrue(result['time_verified'])

 def test_unknown_broker_uses_imported_offset_as_estimate_outside_old_observation(self):
  result=utc_trade(self.trade('Synthetic-Unknown'),self.clock('Synthetic-Unknown',0))
  self.assertEqual(result['closed'],1793825121)
  self.assertTrue(result['time_estimated'])
  self.assertFalse(result['time_verified'])

 def test_unverified_legacy_time_and_ambiguous_offsets_are_not_guessed(self):
  legacy={'closed_server':1793835921,'closed':1793835921}
  self.assertIsNone(utc_trade(legacy,self.clock())['closed'])
  for invalid in (True,10800.0,999999,None):
   trade=self.trade('Synthetic-Unknown');trade['history_offset_seconds']=invalid
   self.assertIsNone(utc_trade(trade,self.clock())['closed'])

if __name__=='__main__':unittest.main()
