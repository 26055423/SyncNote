"""Explicit historical bar jobs preserve source identity and honest missing evidence."""
import sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars,bar_sync_jobs as jobs,market_symbols,sync_history

NOW=1701000000//3600*3600
class RangeJobs(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row;self.addCleanup(self.db.close)
  self.db.execute('CREATE TABLE mt5_links(user_id TEXT PRIMARY KEY,token_hash TEXT,account_key TEXT,updated REAL)')
  bars.initialize(self.db);market_symbols.initialize(self.db);jobs.initialize(self.db)
  self.key=sync_history.account_key('Broker-A','1234')
  self.db.execute('INSERT INTO mt5_links VALUES(?,?,?,?)',('owner','token-A',self.key,1))
  self.link=self.db.execute('SELECT * FROM mt5_links WHERE user_id=?',('owner',)).fetchone()
  bars.ensure_feed(self.db,'Broker-A','1234',NOW)
  self.identity={'account':'1234','server':'Broker-A','account_key':self.key}
  market_symbols.ingest(self.db,self.link,self.identity|{'catalog_id':'first','offset':0,'total':2,'symbols':[{'symbol':'NAS100'},{'symbol':'XAUUSD'}]},NOW)
 def create(self,symbol='NAS100',begin=NOW-86400,end=NOW):return jobs.create(self.db,'owner',{'symbol':symbol,'from':begin,'to':end},NOW)['job']
 def poll(self):return jobs.poll(self.db,self.link,self.identity,NOW)['job']
 def body(self,segment,rows=None,error=''):
  if rows is None:
   p=jobs.PERIODS[segment['tf']];rows=[[t,100,102,99,101,10] for t in range(segment['from_server'],segment['to_server']+1,p)]
  return self.identity|{k:segment[k] for k in ('job_id','segment_id','symbol','tf','from_server','to_server')}|{'bars':rows,'error':error}
 def finish(self,empty=False):
  while segment:=self.poll():jobs.result(self.db,self.link,self.body(segment,[] if empty else None,'empty_window' if empty else ''),NOW)
 def test_segments_are_fair_bounded_closed_and_end_exclusive(self):
  job=self.create(begin=NOW-7*86400)
  seen=[]
  for _ in range(4):
   segment=self.poll();seen.append(segment['tf']);p=jobs.PERIODS[segment['tf']]
   self.assertLessEqual((segment['to_server']-segment['from_server'])//p+1,2000)
   self.assertEqual(segment['to_server']+p,NOW)
   jobs.result(self.db,self.link,self.body(segment),NOW)
  self.assertEqual(seen,list(jobs.PERIODS))
  self.assertEqual(job['total_segments'],10)
 def test_exact_result_retry_is_idempotent_and_full_history_completes(self):
  self.create();segment=self.poll();body=self.body(segment)
  self.assertEqual(self.poll(),segment)
  first=jobs.result(self.db,self.link,body,NOW)
  self.assertEqual(jobs.result(self.db,self.link,body,NOW),first)
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,body|{'bars':[]},NOW)
  self.finish();state=jobs.status(self.db,'owner','NAS100')['job']
  self.assertEqual(state['status'],'completed');self.assertEqual(state['processed_segments'],4)
  self.assertGreater(state['bars_received'],0)
  self.assertEqual(self.db.execute('SELECT DISTINCT source FROM bars').fetchall()[0][0],'srv:Broker-A')
 def test_empty_weekend_remains_partial_and_never_registers_empty_coverage(self):
  self.create();self.finish(True)
  state=jobs.status(self.db,'owner')['job'];self.assertEqual(state['status'],'partial');self.assertEqual(state['bars_received'],0)
  self.assertEqual(self.db.execute('SELECT count(*) FROM bar_coverage').fetchone()[0],0)
 def test_partial_rows_import_without_swallowing_missing_slots(self):
  self.create();segment=self.poll();body=self.body(segment);body['bars']=body['bars'][1::2]
  ack=jobs.result(self.db,self.link,body|{'error':'partial_window'},NOW)
  self.assertEqual(ack['accepted'],len(body['bars']))
  first=segment['from_server']
  self.assertFalse(self.db.execute('SELECT 1 FROM bar_coverage WHERE from_t<=? AND to_t>=?',(first,first)).fetchone())
 def test_cancel_revoke_and_wrong_owner_cannot_write_late_data(self):
  job=self.create();segment=self.poll()
  with self.assertRaises(jobs.JobError):jobs.cancel(self.db,'other',{'job_id':job['job_id']},NOW)
  jobs.cancel(self.db,'owner',{'job_id':job['job_id']},NOW)
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,self.body(segment),NOW)
  self.assertEqual(self.db.execute('SELECT count(*) FROM bars').fetchone()[0],0)
  self.create();segment=self.poll();self.db.execute("UPDATE mt5_links SET token_hash='rotated' WHERE user_id='owner'")
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,self.body(segment),NOW)
  self.assertIsNone(jobs.status(self.db,'owner')['job'])
 def test_catalog_range_and_active_job_validation(self):
  with self.assertRaises(jobs.JobError):self.create('USTEC')
  with self.assertRaises(jobs.JobError):self.create(begin=NOW-366*86400)
  with self.assertRaises(jobs.JobError):self.create(end=NOW+3600)
  self.create()
  with self.assertRaises(jobs.JobError):self.create('XAUUSD')
 def test_broker_clock_uses_shared_offset_and_does_not_include_next_day(self):
  bars.set_source_offset(self.db,'srv:Broker-A',10800,NOW)
  self.create(begin=NOW-86400,end=NOW)
  segment=self.poll()
  self.assertEqual(segment['from_server'],NOW-86400+10800)
  self.assertEqual(segment['to_server'],NOW+10800-60)
 def test_wrong_segment_scope_or_invalid_rows_roll_back(self):
  self.create();segment=self.poll();body=self.body(segment)
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,body|{'symbol':'XAUUSD'},NOW)
  body['bars'][0][1]=-1
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,body,NOW)
  self.assertEqual(self.db.execute('SELECT count(*) FROM bars').fetchone()[0],0)
  self.assertEqual(jobs.status(self.db,'owner')['job']['processed_segments'],0)

if __name__=='__main__':unittest.main()
