"""Private broker symbol snapshot ingestion, pagination and exact source isolation."""
import json,sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bars,market_symbols,sync_history

class SymbolCatalog(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row;self.addCleanup(self.db.close)
  self.db.execute('CREATE TABLE mt5_links(user_id TEXT PRIMARY KEY,token_hash TEXT,account_key TEXT,updated REAL)')
  bars.initialize(self.db);market_symbols.initialize(self.db)
  self.key=sync_history.account_key('Broker-A','1234')
  self.db.execute('INSERT INTO mt5_links VALUES(?,?,?,?)',('owner','token-A',self.key,1))
  self.link=self.db.execute('SELECT * FROM mt5_links WHERE user_id=?',('owner',)).fetchone()
 def body(self,catalog='scan-1',offset=0,total=2,symbols=None,**extra):
  rows=[{'symbol':'XAUUSD','description':'Gold','digits':2,'trade_mode':4}] if symbols is None else symbols
  return {'account':'1234','server':'Broker-A','account_key':self.key,'catalog_id':catalog,'offset':offset,'total':total,'symbols':rows,**extra}
 def upload(self,**kwargs):return market_symbols.ingest(self.db,self.link,self.body(**kwargs),10)
 def read(self,uid='owner',source='srv:Broker-A'):return market_symbols.read(self.db,uid,source)
 def test_snapshot_is_atomic_and_page_retry_is_idempotent(self):
  first=self.upload();self.assertFalse(first['complete']);self.assertEqual(first['next_offset'],1)
  self.assertFalse(self.read()['catalog_available']);self.assertEqual(self.read()['symbols'],[])
  self.assertEqual(self.upload(),first)
  second=self.upload(offset=1,symbols=[{'symbol':'NAS100.cash','description':'Nasdaq 100'}])
  self.assertTrue(second['complete']);self.assertEqual(self.upload(offset=1,symbols=[{'symbol':'NAS100.cash','description':'Nasdaq 100'}]),second)
  self.assertTrue(self.read()['catalog_available']);self.assertEqual([r['symbol'] for r in self.read()['symbols']],['NAS100.cash','XAUUSD'])
  self.assertTrue(all(not r['has_bars'] for r in self.read()['symbols']))
 def test_partial_new_snapshot_never_replaces_last_complete_snapshot(self):
  self.upload(total=1)
  self.upload(catalog='scan-2',symbols=[{'symbol':'USTEC'}])
  self.assertEqual([r['symbol'] for r in self.read()['symbols']],['XAUUSD'])
  self.upload(catalog='scan-2',offset=1,symbols=[{'symbol':'EURUSD'}])
  self.assertEqual([r['symbol'] for r in self.read()['symbols']],['EURUSD','USTEC'])
 def test_wrong_page_changed_retries_and_duplicate_symbols_do_not_advance(self):
  with self.assertRaises(market_symbols.CatalogError):self.upload(offset=1)
  self.upload()
  for request in ({'symbols':[{'symbol':'CHANGED'}]},{'offset':1,'symbols':[{'symbol':'XAUUSD'}]},{'offset':1,'total':3}):
   with self.assertRaises(market_symbols.CatalogError):self.upload(**request)
  self.assertFalse(self.read()['catalog_available'])
  self.upload(offset=1,symbols=[{'symbol':'USTEC'}])
  with self.assertRaises(market_symbols.CatalogError):self.upload(symbols=[{'symbol':'CHANGED'}])
 def test_owner_account_source_and_credential_rotation_isolation(self):
  self.upload(total=1)
  self.assertFalse(self.read(uid='other')['catalog_available'])
  self.assertEqual(self.read(source='srv:Broker-B')['symbols'],[])
  self.db.execute('UPDATE mt5_links SET account_key=? WHERE user_id=?',('another-account','owner'))
  self.assertFalse(self.read()['catalog_available'])
  self.db.execute('UPDATE mt5_links SET account_key=?,token_hash=? WHERE user_id=?',(self.key,'token-B','owner'))
  self.assertFalse(self.read()['catalog_available'])
  self.db.execute('UPDATE mt5_links SET token_hash=NULL WHERE user_id=?',('owner',))
  self.assertFalse(self.read()['catalog_available'])
 def test_catalog_merges_exact_stored_codes_without_borrowing_other_sources(self):
  self.upload(total=1)
  self.db.execute('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',('srv:Broker-A','XAUUSD','M1',1,1,2,0,1,1,1))
  self.db.execute('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',('srv:Broker-A','NAS100','M1',1,1,2,0,1,1,1))
  self.db.execute('INSERT INTO bars VALUES(?,?,?,?,?,?,?,?,?,?)',('srv:Broker-B','USTEC','M1',1,1,2,0,1,1,1))
  rows=self.read()['symbols'];self.assertEqual([r['symbol'] for r in rows],['NAS100','XAUUSD']);self.assertTrue(all(r['has_bars'] for r in rows))
  self.assertEqual(self.read(uid='other')['symbols'],[{'symbol':'NAS100','has_bars':True},{'symbol':'XAUUSD','has_bars':True}])
 def test_invalid_fields_and_identity_are_rejected(self):
  for changes in ({'total':True},{'symbols':[{'symbol':'bad\ncode'}]},{'symbols':[{'symbol':'OK','digits':999}]},{'symbols':[{'symbol':'OK','password':'leak'}]},{'catalog_id':'invalid id'}):
   with self.assertRaises(market_symbols.CatalogError):self.upload(**changes)
  changed=self.body(account='9999',account_key=sync_history.account_key('Broker-A','9999'))
  with self.assertRaises(market_symbols.CatalogError) as error:market_symbols.ingest(self.db,self.link,changed,10)
  self.assertEqual(error.exception.code,403)
 def test_empty_complete_snapshot_removes_old_directory(self):
  self.upload(total=1);self.upload(catalog='empty',total=0,symbols=[])
  self.assertTrue(self.read()['catalog_available']);self.assertEqual(self.read()['symbols'],[])

if __name__=='__main__':unittest.main()
