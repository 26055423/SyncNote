"""Explicit historical bar jobs preserve source identity and honest missing evidence."""
import sqlite3,sys,unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars,bar_sync_jobs as jobs,market_symbols,sync_history

NOW=1701000000//3600*3600
class RangeJobs(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row;self.addCleanup(self.db.close)
  self.db.execute('CREATE TABLE mt5_links(user_id TEXT PRIMARY KEY,token_hash TEXT,account_key TEXT,updated REAL)')
  bars.initialize(self.db);market_symbols.initialize(self.db);jobs.initialize(self.db)
  self.db.execute('CREATE TABLE broker_clocks(person TEXT PRIMARY KEY,broker TEXT,offset INTEGER,observed_from REAL,observed_to REAL)')
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
 def test_latest_job_with_same_timestamp_uses_insertion_order_not_random_id(self):
  counter=[0]
  def token(size):
   counter[0]+=1
   if size==16:return 'f'*32 if counter[0]==1 else '0'*32
   return format(counter[0],'024x')
  with patch('bar_sync_jobs.secrets.token_hex',side_effect=token):
   old=self.create()
   jobs.cancel(self.db,'owner',{'job_id':old['job_id']},NOW)
   new=self.create()
  self.assertGreater(old['job_id'],new['job_id'])
  latest=jobs.status(self.db,'owner','NAS100')['job']
  self.assertEqual(latest['job_id'],new['job_id'])
  self.assertEqual(latest['status'],'waiting')
 def test_broker_clock_uses_shared_offset_and_does_not_include_next_day(self):
  bars.set_source_offset(self.db,'srv:Broker-A',10800,NOW)
  self.create(begin=NOW-86400,end=NOW)
  segment=self.poll()
  self.assertEqual(segment['from_server'],NOW-86400+10800)
  self.assertEqual(segment['to_server'],NOW+10800-60)
 def local_create(self,symbol='USTEC',sample=None):
  sample={'server_time_ms':NOW*1000,'server_offset_sec':0} if sample is None else sample
  return jobs.create(self.db,'owner',self.identity|{'website_user_id':'owner','transport':'synctrade','symbol':symbol,'from':NOW-3600,'to':NOW,'clock_sample':sample},NOW)['job']
 def test_browser_clock_sample_maps_unknown_broker_ranges_before_first_binding(self):
  self.db.execute('DELETE FROM mt5_links');self.db.execute('DELETE FROM feeds')
  self.local_create(sample={'server_time_ms':NOW*1000,'server_offset_sec':7200})
  segment=self.local_poll()
  self.assertEqual(segment['from_server'],NOW-3600+7200)
  self.assertEqual(segment['to_server'],NOW+7200-60)
 def test_stale_browser_clock_is_rejected_before_binding(self):
  self.db.execute('DELETE FROM mt5_links');self.db.execute('DELETE FROM feeds')
  with self.assertRaises(jobs.JobError):self.local_create(sample={'server_time_ms':(NOW-1000)*1000,'server_offset_sec':7200})
  self.assertEqual(self.db.execute('SELECT count(*) FROM mt5_links').fetchone()[0],0)
  with self.assertRaises(jobs.JobError):self.local_create(sample={'server_time_ms':NOW*1000,'server_offset_sec':999999})
  self.assertEqual(self.db.execute('SELECT count(*) FROM mt5_links').fetchone()[0],0)
 def test_local_status_does_not_show_an_old_bound_accounts_job(self):
  self.local_create()
  self.assertIsNone(jobs.status(self.db,'owner','USTEC','synctrade','another-account')['job'])
 def local_poll(self):return jobs.local_poll(self.db,'owner',self.identity|{'website_user_id':'owner'},NOW)['job']
 def local_body(self,segment,rows=None):return self.body(segment,rows)|{'website_user_id':'owner'}
 def test_first_browser_range_sync_binds_account_without_note_or_history_upload(self):
  self.db.execute('DELETE FROM mt5_links')
  self.db.execute('DELETE FROM feeds')
  self.db.execute('DELETE FROM mt5_symbol_catalogs')
  job=self.local_create()
  linked=self.db.execute("SELECT * FROM mt5_links WHERE user_id='owner'").fetchone()
  self.assertIsNone(linked['token_hash']);self.assertEqual(linked['account_key'],self.key)
  self.assertEqual(bars.feed_of(self.db,'owner')['source'],'srv:Broker-A')
  self.assertEqual(self.local_poll()['job_id'],job['job_id'])
  self.assertEqual(self.db.execute('SELECT count(*) FROM mt5_symbol_catalogs').fetchone()[0],0)
 def test_browser_create_never_rebinds_an_existing_account(self):
  other_key=sync_history.account_key('Broker-B','9999')
  body={'website_user_id':'owner','transport':'synctrade','account':'9999','server':'Broker-B','account_key':other_key,'symbol':'USTEC','from':NOW-3600,'to':NOW}
  with self.assertRaises(jobs.JobError):jobs.create(self.db,'owner',body,NOW)
  self.assertEqual(bars.feed_of(self.db,'owner')['account_key'],self.key)
  self.assertEqual(self.db.execute('SELECT count(*) FROM bar_sync_jobs').fetchone()[0],0)
 def test_invalid_browser_create_does_not_create_a_binding(self):
  self.db.execute('DELETE FROM mt5_links');self.db.execute('DELETE FROM feeds')
  body=self.identity|{'website_user_id':'other','transport':'synctrade','symbol':'USTEC','from':NOW-3600,'to':NOW}
  with self.assertRaises(jobs.JobError):jobs.create(self.db,'owner',body,NOW)
  self.assertEqual(self.db.execute('SELECT count(*) FROM mt5_links').fetchone()[0],0)
  with self.assertRaises(jobs.JobError):jobs.create(self.db,'owner',body|{'website_user_id':'owner','from':NOW+1},NOW)
  self.assertEqual(self.db.execute('SELECT count(*) FROM mt5_links').fetchone()[0],0)
 def test_browser_jobs_need_no_syncnote_token_or_cloud_catalog(self):
  self.db.execute("UPDATE mt5_links SET token_hash=NULL WHERE user_id='owner'")
  job=self.local_create()
  self.assertEqual(job['transport'],'synctrade')
  self.assertEqual(jobs.status(self.db,'owner','USTEC','synctrade')['job']['job_id'],job['job_id'])
  self.assertIsNone(jobs.status(self.db,'owner','USTEC')['job'])
  while segment:=self.local_poll():
   body=self.local_body(segment)
   ack=jobs.local_result(self.db,'owner',body,NOW)
   self.assertEqual(jobs.local_result(self.db,'owner',body,NOW),ack)
  self.assertEqual(jobs.status(self.db,'owner','USTEC','synctrade')['job']['status'],'completed')
  self.assertEqual(self.db.execute("SELECT DISTINCT source FROM bars WHERE symbol='USTEC'").fetchone()[0],'srv:Broker-A')
 def test_browser_and_ea_channels_cannot_claim_or_ack_each_others_jobs(self):
  local=self.local_create();self.assertIsNone(self.poll())
  cloud=self.create();local_segment=self.local_poll();cloud_segment=self.poll()
  self.assertEqual(local_segment['job_id'],local['job_id']);self.assertEqual(cloud_segment['job_id'],cloud['job_id'])
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,self.body(local_segment),NOW)
  with self.assertRaises(jobs.JobError):jobs.local_result(self.db,'owner',self.local_body(cloud_segment),NOW)
  self.assertEqual(self.db.execute('SELECT count(*) FROM bars').fetchone()[0],0)
 def test_browser_scope_checks_website_account_and_bound_feed_before_write(self):
  with self.assertRaises(jobs.JobError):jobs.create(self.db,'owner',self.identity|{'website_user_id':'other','transport':'synctrade','symbol':'USTEC','from':NOW-3600,'to':NOW},NOW)
  self.local_create();segment=self.local_poll();body=self.local_body(segment)
  with self.assertRaises(jobs.JobError):jobs.local_result(self.db,'owner',body|{'website_user_id':'other'},NOW)
  with self.assertRaises(jobs.JobError):jobs.local_poll(self.db,'owner',self.identity|{'website_user_id':'owner','server':'Broker-B','account_key':sync_history.account_key('Broker-B','1234')},NOW)
  other=bars.ensure_feed(self.db,'Broker-B','9999',NOW)
  self.db.execute('UPDATE mt5_links SET account_key=? WHERE user_id=?',(other['account_key'],'owner'))
  with self.assertRaises(jobs.JobError):jobs.local_result(self.db,'owner',body,NOW)
  self.assertEqual(self.db.execute('SELECT count(*) FROM bars').fetchone()[0],0)
 def test_browser_cancel_blocks_late_result_and_note_revoke_does_not_revoke_local_data(self):
  job=self.local_create();segment=self.local_poll()
  with self.assertRaises(jobs.JobError):jobs.cancel(self.db,'owner',{'job_id':job['job_id']},NOW)
  self.db.execute("UPDATE mt5_links SET token_hash=NULL WHERE user_id='owner'")
  # SyncNote authorization is independent of the local browser connection.
  self.assertIsNotNone(self.local_poll())
  jobs.cancel(self.db,'owner',{'job_id':job['job_id'],'transport':'synctrade'},NOW)
  with self.assertRaises(jobs.JobError):jobs.local_result(self.db,'owner',self.local_body(segment),NOW)
  self.assertIsNone(self.local_poll())
 def test_existing_database_jobs_migrate_to_syncnote_transport(self):
  self.create()
  columns=[row[1] for row in self.db.execute('PRAGMA table_info(bar_sync_jobs)')]
  selected=','.join(column for column in columns if column!='transport')
  self.db.execute('ALTER TABLE bar_sync_jobs RENAME TO old_jobs')
  self.db.execute('CREATE TABLE bar_sync_jobs AS SELECT '+selected+' FROM old_jobs')
  self.db.execute('DROP TABLE old_jobs')
  jobs.initialize(self.db)
  self.assertEqual(self.db.execute('SELECT transport FROM bar_sync_jobs').fetchone()[0],'syncnote')
  self.assertEqual(jobs.status(self.db,'owner')['job']['transport'],'syncnote')
 def test_wrong_segment_scope_or_invalid_rows_roll_back(self):
  self.create();segment=self.poll();body=self.body(segment)
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,body|{'symbol':'XAUUSD'},NOW)
  body['bars'][0][1]=-1
  with self.assertRaises(jobs.JobError):jobs.result(self.db,self.link,body,NOW)
  self.assertEqual(self.db.execute('SELECT count(*) FROM bars').fetchone()[0],0)
  self.assertEqual(jobs.status(self.db,'owner')['job']['processed_segments'],0)

if __name__=='__main__':unittest.main()
