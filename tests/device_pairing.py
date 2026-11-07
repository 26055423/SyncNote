"""Generated-only pairing authorization tests; no terminal or real account used."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import auth_security
import device_pairing as pair
import sync_history

class PairingTests(unittest.TestCase):
 def setUp(self):
  self.folder=tempfile.TemporaryDirectory();self.path=Path(self.folder.name)/'test.sqlite3'
  self.db=self.connect()
  self.db.executescript('''CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,nickname TEXT,locked INTEGER);
  INSERT INTO users VALUES('alice','alice','Alice',0),('bob','bob','Bob',0);
  CREATE TABLE mt5_links(user_id TEXT PRIMARY KEY,token_hash TEXT,account_key TEXT,updated REAL);''')
  auth_security.initialize(self.db);pair.initialize(self.db)
  self.db.execute('CREATE TABLE mt5_history_batches(person TEXT,account_key TEXT,updated REAL)')
  self.identity={'account':'123','server':'Synthetic-Broker','account_key':sync_history.account_key('Synthetic-Broker','123')}
 def tearDown(self):
  self.db.close();self.folder.cleanup()
 def connect(self):
  db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row;return db
 def run_call(self,method,*args):
  with self.db:return method(self.db,*args)
 def start(self):return self.run_call(pair.start,'start-test')
 def claim(self,device,user='alice'):
  return self.run_call(pair.claim,'claim-'+user,{'id':user},{'code':device['code']})
 def payload(self,device):
  status=self.run_call(pair.poll,'poll-test',{'device_secret':device['device_secret']})
  return {**self.identity,'device_secret':device['device_secret'],'claim_id':status.get('claim_id'),'allow':True}
 def assert_error(self,code,method,*args):
  with self.assertRaises(pair.PairError) as err:self.run_call(method,*args)
  self.assertEqual(err.exception.code,code)
 def test_success_requires_claim_then_local_confirmation(self):
  device=self.start();self.assertRegex(device['code'],r'^\d{8}$')
  self.assertEqual(self.run_call(pair.poll,'poll',{'device_secret':device['device_secret']})['status'],'pending')
  self.assert_error(409,pair.confirm,'confirm',{**self.identity,'device_secret':device['device_secret'],'claim_id':'fake','allow':True})
  self.claim(device);data=self.payload(device)
  self.assertEqual(self.run_call(pair.poll,'poll',data)['nickname'],'Alice')
  self.assertFalse(self.db.execute('SELECT 1 FROM mt5_links').fetchone())
  result=self.run_call(pair.confirm,'confirm',data)
  self.assertEqual(result['status'],'approved')
  self.assertEqual(self.db.execute('SELECT token_hash FROM mt5_links').fetchone()[0],pair.digest(result['token']))
  self.assertNotIn('token',self.run_call(pair.poll,'poll',data))
  stored=repr(tuple(self.db.execute('SELECT * FROM mt5_device_pairs').fetchone()))
  self.assertNotIn(device['device_secret'],stored);self.assertNotIn(device['code'],stored);self.assertNotIn(result['token'],stored)
 def test_expired_and_wrong_secret(self):
  device=self.start()
  self.assert_error(401,pair.poll,'poll',{'device_secret':'x'*48})
  with self.db:self.db.execute('UPDATE mt5_device_pairs SET expires=0')
  self.assert_error(409,pair.claim,'claim',{'id':'alice'},{'code':device['code']})
  self.assert_error(410,pair.poll,'poll',{'device_secret':device['device_secret']})
 def test_claim_cannot_be_replaced(self):
  device=self.start();self.claim(device)
  self.assert_error(409,pair.claim,'bob',{'id':'bob'},{'code':device['code']})
  self.assertEqual(self.payload(device)['claim_id'],self.payload(device)['claim_id'])
 def test_rejection_does_not_issue_credentials(self):
  device=self.start();self.claim(device);data=self.payload(device);data['allow']=False
  self.assertEqual(self.run_call(pair.confirm,'confirm',data)['status'],'rejected')
  self.assertEqual(self.run_call(pair.confirm,'confirm',data)['status'],'rejected') # Lost rejection ACK is safe to retry.
  self.assertFalse(self.db.execute('SELECT 1 FROM mt5_links').fetchone())
  data['allow']=True;self.assert_error(409,pair.confirm,'confirm',data)
 def test_account_identity_and_existing_binding(self):
  device=self.start();self.claim(device);data=self.payload(device)
  with self.assertRaises(sync_history.HistoryError):self.run_call(pair.confirm,'confirm',{**data,'account_key':'forged'})
  with self.db:self.db.execute('INSERT INTO mt5_links VALUES(?,?,?,0)',('alice','old-token','another-account'))
  self.assert_error(409,pair.confirm,'confirm',data)
  self.assertEqual(self.db.execute('SELECT token_hash FROM mt5_links').fetchone()[0],'old-token')
 def test_confirmation_idempotence_and_revocation(self):
  device=self.start();self.claim(device);data=self.payload(device)
  result=self.run_call(pair.confirm,'confirm',data)
  self.assertEqual(result,self.run_call(pair.confirm,'confirm',data))
  with self.db:self.db.execute("UPDATE mt5_links SET token_hash=NULL WHERE user_id='alice'")
  self.assert_error(410,pair.confirm,'confirm',data)
  self.assert_error(410,pair.poll,'poll',data)
 def test_lock_blocks_claim_and_confirmation(self):
  device=self.start()
  with self.db:self.db.execute("UPDATE users SET locked=1 WHERE id='alice'")
  self.assert_error(403,pair.claim,'claim',{'id':'alice'},{'code':device['code']})
  with self.db:self.db.execute("UPDATE users SET locked=0 WHERE id='alice'")
  self.claim(device);data=self.payload(device)
  with self.db:self.db.execute("UPDATE users SET locked=1 WHERE id='alice'")
  self.assert_error(403,pair.confirm,'confirm',data)
 def test_parallel_claim_has_one_winner(self):
  device=self.start()
  def claim(user):
   db=self.connect()
   try:
    with db:pair.claim(db,'parallel-'+user,{'id':user},{'code':device['code']})
    return 200
   except pair.PairError as error:return error.code
   finally:db.close()
  with concurrent.futures.ThreadPoolExecutor(2) as pool:codes=list(pool.map(claim,['alice','bob']))
  self.assertEqual(sorted(codes),[200,409])
 def test_rate_limit_persists_failed_attempts(self):
  for _ in range(5):self.assert_error(409,pair.claim,'limit-ip',{'id':'alice'},{'code':'00000000'})
  self.assert_error(429,pair.claim,'limit-ip',{'id':'alice'},{'code':'00000000'})

 def test_resolve_only_identifies_without_claim_or_claim_rate_consumption(self):
  device=self.start()
  for _ in range(8):self.assertEqual(self.run_call(pair.resolve,'resolve',{'id':'alice'},{'code':device['code']})['kind'],'syncnote')
  row=self.db.execute('SELECT status,user_id FROM mt5_device_pairs').fetchone()
  self.assertEqual(tuple(row),('pending',None))
  self.claim(device)
  self.assertEqual(self.run_call(pair.resolve,'resolve',{'id':'alice'},{'code':device['code']})['kind'],'unknown')

 def test_expired_code_is_unknown_and_status_does_not_leak_other_users(self):
  device=self.start()
  with self.db:self.db.execute('UPDATE mt5_device_pairs SET expires=0')
  self.assertEqual(self.run_call(pair.resolve,'resolve',{'id':'alice'},{'code':device['code']})['kind'],'unknown')
  self.assertEqual(pair.status(self.db,{'id':'bob'})['status'],'none')

 def test_status_keeps_long_lived_authorization_and_observes_revocation(self):
  device=self.start();self.claim(device)
  self.assertEqual(pair.status(self.db,{'id':'alice'})['status'],'claimed')
  self.run_call(pair.confirm,'confirm',self.payload(device))
  with self.db:
   self.db.execute('UPDATE mt5_device_pairs SET expires=0')
   self.db.execute('INSERT INTO mt5_history_batches VALUES(?,?,123)',('alice',self.identity['account_key']))
  status=pair.status(self.db,{'id':'alice'})
  self.assertEqual(status,{'ok':True,'status':'approved','last_sync':123})
  self.assertEqual(pair.status(self.db,{'id':'bob'})['last_sync'],None)
  with self.db:self.db.execute('UPDATE mt5_links SET token_hash=NULL')
  self.assertEqual(pair.status(self.db,{'id':'alice'})['status'],'none')

class PairingHttpTests(unittest.TestCase):
 def test_routes_auth_origin_and_unlink_revocation(self):
  with tempfile.TemporaryDirectory() as folder:
   env={**os.environ,'DATA_DIR':folder,'EA_HUB_ENABLE':'0','COOKIE_SECURE':'0','ADMIN_USERNAME':'admin','PYTHONDONTWRITEBYTECODE':'1'}
   runner="from bootstrap_admin import create_admin;create_admin('Synthetic-Password-123');import app_server as a;from http.server import ThreadingHTTPServer;s=ThreadingHTTPServer(('127.0.0.1',0),a.Handler);print(s.server_port,flush=True);s.serve_forever()"
   proc=subprocess.Popen([sys.executable,'-u','-c',runner],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
   try:
    port=proc.stdout.readline().strip();self.assertTrue(port.isdigit());base='http://127.0.0.1:'+port
    session=secrets.token_urlsafe(32)
    with sqlite3.connect(Path(folder)/'board.sqlite3') as db:
     uid=db.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
     db.execute('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,4102444800)',(hashlib.sha256(session.encode()).hexdigest(),uid))
    db.close()
    def request(endpoint,data=None,authenticated=False,origin=None):
     headers={'Content-Type':'application/json','Origin':origin or base}
     if authenticated:headers['Cookie']='tongpin_session='+session
     req=urllib.request.Request(base+'/api/mt5/'+endpoint,data=json.dumps(data).encode() if data is not None else None,headers=headers)
     try:response=urllib.request.urlopen(req,timeout=10)
     except urllib.error.HTTPError as error:response=error
     with response:return response.status,json.load(response)
    status,device=request('device/start',{});self.assertEqual(status,200)
    self.assertEqual(request('device/status')[0],401)
    self.assertEqual(request('device/resolve',{'code':device['code']})[0],401)
    self.assertEqual(request('device/resolve',{'code':device['code']},True),(200,{'ok':True,'kind':'syncnote'}))
    self.assertEqual(request('device/status',authenticated=True)[1]['status'],'none')
    self.assertEqual(request('device/claim',{'code':device['code']})[0],401)
    self.assertEqual(request('device/claim',{'code':device['code']},True,'https://evil.example')[0],403)
    self.assertEqual(request('device/claim',{'code':device['code']},True)[0],200)
    self.assertEqual(request('unlink',{},True)[0],200)
    self.assertEqual(request('device/poll',{'device_secret':device['device_secret']})[0],401)
    status,device=request('device/start',{});self.assertEqual(status,200)
    self.assertEqual(request('device/claim',{'code':device['code']},True)[0],200)
    status,claimed=request('device/poll',{'device_secret':device['device_secret']})
    self.assertEqual(status,200);self.assertEqual(claimed['username'],'admin')
    identity={'account':'123','server':'Synthetic-Broker','account_key':sync_history.account_key('Synthetic-Broker','123')}
    payload={**identity,'device_secret':device['device_secret'],'claim_id':claimed['claim_id'],'allow':True}
    status,approved=request('device/confirm',payload);self.assertEqual(status,200)
    self.assertEqual(approved['status'],'approved');self.assertEqual(request('device/confirm',payload),(200,approved))
    status,poll=request('device/poll',{'device_secret':device['device_secret']})
    self.assertEqual(status,200);self.assertEqual(poll['status'],'approved');self.assertNotIn('token',poll)
    self.assertEqual(request('unlink',{},True)[0],200)
    self.assertEqual(request('device/confirm',payload)[0],401)
    status,device=request('device/start',{});self.assertEqual(status,200)
    self.assertEqual(request('device/claim',{'code':device['code']},True)[0],200)
    status,claimed=request('device/poll',{'device_secret':device['device_secret']});self.assertEqual(status,200)
    payload.update(device_secret=device['device_secret'],claim_id=claimed['claim_id'])
    self.assertEqual(request('token',{},True)[0],200)
    self.assertEqual(request('device/confirm',payload)[0],401)
   finally:proc.terminate();proc.wait(timeout=10);proc.stdout.close()

if __name__=='__main__':unittest.main()
