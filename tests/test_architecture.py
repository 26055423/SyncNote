"""Lifecycle, upgrade atomicity, and legacy/authoritative storage boundaries."""
import json,os,socket,sqlite3,subprocess,sys,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import database,migrations,trade_store,journal,chart,groups,dm,ea_hub
from app_runtime import Runtime
from app_bootstrap import baseline

class Architecture(unittest.TestCase):
 def folder(self):
  folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
  return Path(folder.name)/'data'/'board.sqlite3'

 def test_import_does_not_create_data_or_start_workers(self):
  path=self.folder()
  script="import threading; before=set(threading.enumerate()); import app_server; assert set(threading.enumerate())==before; assert not app_server.DATA.exists(); assert app_server.HUB.thread is None"
  run=subprocess.run([sys.executable,'-c',script],env={**os.environ,'DATA_DIR':str(path.parent),'EA_HUB_ENABLE':'1'},capture_output=True,text=True)
  self.assertEqual(run.returncode,0,run.stderr)

 def legacy(self,path):
  path.parent.mkdir()
  with database.connect(path,migration=True) as db:
   db.execute('PRAGMA foreign_keys=OFF');db.execute('BEGIN')
   baseline(db)
   # Model the real pre-upgrade foreign keys, including their child section rows.
   for name in ('trade_notes','trade_reviews'):
    sql=db.execute('SELECT sql FROM sqlite_master WHERE name=?',(name,)).fetchone()[0]
    db.execute('DROP TABLE '+name)
    db.execute(sql.replace('REFERENCES trade_keys(','REFERENCES trades('))
   for uid in ('a','b','late'):
    db.execute('INSERT INTO users(id,username,nickname,password,created) VALUES(?,?,?,?,1)',(uid,uid,uid,'fixture'))
   db.execute('INSERT INTO trades VALUES(?,?,?)',('a','old',json.dumps({'ticket':'old','closed':1700000000,'closed_server':1700000000,'time_basis':'utc','open':10})))
   journal.save(db,'a',{'ticket':'old','body':'old note','tags':[],'sections':[{'id':'s','title':'Section','body':'retained'}]})
   db.execute("INSERT INTO trade_reviews VALUES('a','old','ready','{}',1)")
   db.execute("INSERT INTO review_shares(id,owner,ticket,recipient,message,created,seen,snapshot,note_snapshot) VALUES(42,'a','old','b','old card',1,1,'','')")
   db.execute("INSERT INTO groups(id,name,owner,code,created) VALUES('g','Group','a','G',1)")
   db.execute("INSERT INTO group_members VALUES('g','a','owner',1,0)")
   db.execute("INSERT INTO group_members VALUES('g','b','member',1,0)")
   db.execute("INSERT INTO group_messages(group_id,person,kind,ticket,text,created,snapshot,note_snapshot) VALUES('g','a','trade','old','original group',1,'','null')")
   db.execute('PRAGMA user_version=2')

 def test_upgrade_preserves_notes_links_and_is_idempotent(self):
  path=self.folder();self.legacy(path)
  self.assertEqual(migrations.migrate(path),5)
  self.assertEqual(migrations.migrate(path),5)
  with database.connect(path) as db:
   self.assertEqual(db.execute('SELECT count(*) FROM schema_migrations').fetchone()[0],3)
   self.assertEqual(db.execute('SELECT count(*) FROM trades').fetchone()[0],0)
   self.assertEqual(db.execute('SELECT count(*) FROM legacy_trades').fetchone()[0],1)
   self.assertTrue(journal.trade(db,'a','old')['legacy'])
   self.assertEqual(journal.notes(db,'a')['notes']['old']['sections'][0]['body'],'retained')
   original=chart.share_view(chart.share_row(db,'b',42))
   journal.save(db,'a',{'ticket':'old','body':'changed','tags':[]})
   self.assertEqual(chart.share_view(chart.share_row(db,'b',42)),original)
   self.assertEqual(original['note']['body'],'old note')
   groups.join(db,'late','G')
   sid=groups.open_trade(db,'g','late',1)['share']
   self.assertIsNone(chart.share_view(chart.share_row(db,'late',sid))['note'])
   self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
   self.assertEqual(db.execute('SELECT count(*) FROM legacy_review_shares').fetchone()[0],1)

 def test_failed_migration_rolls_back_schema_data_and_ledger(self):
  path=self.folder()
  def fail(db):
   db.executescript('CREATE TABLE example(id); INSERT INTO example VALUES(1);')
   raise RuntimeError('synthetic failure')
  with self.assertRaisesRegex(RuntimeError,'synthetic'):migrations.migrate(path,[(3,'fails',fail)])
  with database.connect(path) as db:
   self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],0)
   self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='example'").fetchone())
   self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='schema_migrations'").fetchone())
  migrations.migrate(path)
  with database.connect(path) as db:db.execute('PRAGMA user_version=999')
  with self.assertRaisesRegex(RuntimeError,'newer'):migrations.migrate(path)

 def test_legacy_cannot_overwrite_authoritative_history(self):
  path=self.folder();migrations.migrate(path)
  with database.connect(path) as db:
   trade_store.store_legacy(db,'a',{'ticket':'old','open':5},'snapshot')
   self.assertEqual(len(trade_store.history_rows(db,'a')),1)
   db.execute('INSERT INTO trades VALUES(?,?,?)',('a','new',json.dumps({'ticket':'new','open':10,'source':'syncnote-history.v1'})))
   trade_store.store_legacy(db,'a',{'ticket':'new','open':99},'ea-hub')
   self.assertEqual(journal.trade(db,'a','new')['open'],10)
   self.assertEqual([json.loads(r[0])['ticket'] for r in trade_store.history_rows(db,'a')],['new'])
   self.assertEqual(journal.trade(db,'a','old')['open'],5,'legacy deep links still resolve')

 def test_connection_context_closes_after_commit_and_rollback(self):
  path=self.folder();path.parent.mkdir()
  with database.connect(path) as db:db.execute('CREATE TABLE sample(id)')
  with self.assertRaises(sqlite3.ProgrammingError):db.execute('SELECT 1')
  with self.assertRaises(ValueError):
   with database.connect(path) as failed:
    failed.execute('INSERT INTO sample VALUES(1)');raise ValueError()
  with database.connect(path) as db:self.assertEqual(db.execute('SELECT count(*) FROM sample').fetchone()[0],0)

 def test_runtime_releases_listeners_and_pending_connections(self):
  path=self.folder();migrations.migrate(path)
  hub=ea_hub.Hub(lambda:database.connect(path))
  with patch.object(ea_hub,'HUB_PORT',0),patch.object(ea_hub,'HUB_HOST','127.0.0.1'):
   for _ in range(2):
    runtime=Runtime(lambda:database.connect(path),hub,hub_enabled=True,catalog_delay=60)
    with runtime:
     port=hub.server.sockets[0].getsockname()[1]
     client=socket.create_connection(('127.0.0.1',port),timeout=2)
     self.addCleanup(client.close)
    import traceback
    self.assertIsNone(hub._failure,"".join(traceback.format_exception(hub._failure)) if hub._failure else "")
    client.settimeout(2)
    try:self.assertEqual(client.recv(1),b'')
    except ConnectionResetError:pass  # TCP may reset a socket closed before hello.
    finally:client.close()
    self.assertFalse(hub.thread.is_alive());self.assertFalse(runtime.worker.is_alive())
    with self.assertRaises(OSError):socket.create_connection(('127.0.0.1',port),timeout=.2)

 def test_repeated_direct_shares_freeze_content_and_absence(self):
  from routes.reviews import get_chart_entry
  class Response:
   def reply(self,value):return value
  path=self.folder();self.legacy(path);migrations.migrate(path)
  with database.connect(path) as db:
   chart.share(db,'a','old',['b'],'empty',note=None)
   first=db.execute('SELECT max(id) FROM review_shares').fetchone()[0]
   doc={'version':1,'charts':[{'drawings':[{'id':'new'}]}]}
   chart.save_state(db,'a','old',doc)
   note=journal.save(db,'a',{'ticket':'old','body':'new content','tags':[]})['note']
   chart.share(db,'a','old',['b'],'second',{'anchor_ms':1700000000000,'document':doc},note)
   second=db.execute('SELECT max(id) FROM review_shares').fetchone()[0]
   self.assertNotEqual(first,second)
   entry=get_chart_entry(Response(),db,{'id':'b'},{'share':[str(first)]})
   self.assertIsNone(entry['note']);self.assertIsNone(entry['chart'])
   self.assertEqual(entry['share']['message'],'empty')
   other=get_chart_entry(Response(),db,{'id':'b'},{'share':[str(second)]})
   self.assertEqual(other['note']['body'],'new content')
   self.assertEqual(other['chart']['document'],doc)
   chart.mark_seen(db,'b',first)
   self.assertFalse(chart.share_row(db,'b',second)['seen'])
   with self.assertRaises(chart.ChartError):chart.share_row(db,'late',second)
   with self.assertRaises(sqlite3.IntegrityError):db.execute("UPDATE review_snapshots SET message='changed'")

 def test_group_cards_share_original_snapshot_and_enforce_current_membership(self):
  path=self.folder();self.legacy(path);migrations.migrate(path)
  with database.connect(path) as db:
   before=[r['id'] for r in chart.inbox(db,'b')['items']]
   first=groups.share_trade(db,'a','g','old',{'anchor_ms':1700000000000},'first')
   second=groups.share_trade(db,'a','g','old',{'anchor_ms':1700000060000},'second')
   self.assertEqual([r['id'] for r in chart.inbox(db,'b')['items']],before)
   groups.join(db,'late','G')
   for uid in ('b','late'):
    one=groups.open_trade(db,'g',uid,first['id'])['share']
    two=groups.open_trade(db,'g',uid,second['id'])['share']
    self.assertNotEqual(one,two)
    self.assertEqual(chart.share_view(chart.share_row(db,uid,one))['anchor_ms'],1700000000000)
    self.assertEqual(chart.share_row(db,uid,two)['message'],'second')
   cards=groups.messages(db,'g','b')
   self.assertNotEqual(cards[-1]['share'],cards[-2]['share'])
   groups.recall(db,'g','a',first['id'])
   with self.assertRaises(chart.ChartError):chart.share_row(db,'late',one)
   groups.leave(db,'late','g')
   with self.assertRaises(chart.ChartError):chart.share_row(db,'late',two)
   self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])

 def test_backup_includes_wal_and_restores_schema(self):
  from tools.database_backup import copy_database
  path=self.folder();migrations.migrate(path)
  backup=path.parent/'backup.sqlite3'
  writer=sqlite3.connect(path);self.addCleanup(writer.close)
  writer.execute('CREATE TABLE original(value)');writer.execute('INSERT INTO original VALUES(7)');writer.commit()
  copy_database(path,backup)
  writer.execute('DROP TABLE original');writer.commit();writer.close()
  copy_database(backup,path,restore=True)
  with database.connect(path) as db:self.assertEqual(db.execute('SELECT value FROM original').fetchone()[0],7)

if __name__=='__main__':unittest.main()
