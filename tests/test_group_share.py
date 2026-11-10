"""Group shares reach every member while reusing the bounded review-share API."""
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chart
import groups
import journal


class GroupShare(unittest.TestCase):
 def test_more_than_twenty_members_receive_message_and_slice(self):
  db = sqlite3.connect(':memory:')
  self.addCleanup(db.close)
  db.row_factory = sqlite3.Row
  db.execute('PRAGMA foreign_keys=ON')
  db.executescript('CREATE TABLE users(id TEXT PRIMARY KEY,nickname TEXT,avatar TEXT); CREATE TABLE trades(person TEXT,ticket TEXT,payload TEXT,PRIMARY KEY(person,ticket));')
  chart.initialize(db)
  groups.initialize(db)
  journal.initialize(db)
  db.execute("INSERT INTO users VALUES('owner','Owner','')")
  group = groups.create(db, 'owner', 'Synthetic group')
  for index in range(chart.MAX_RECIPIENTS + 1):
   uid = 'member-' + str(index)
   db.execute('INSERT INTO users VALUES(?,?,?)', (uid, uid, ''))
   groups.join(db, uid, group['code'])
  db.execute("INSERT INTO trades VALUES('owner','fixture','{}')")
  snapshot = {'anchor_ms': 1700000000000, 'timeframe': '15m', 'layout': '1'}
  result = groups.share_trade(db, 'owner', group['id'], 'fixture', snapshot, 'Review this structure')
  self.assertEqual(result['sent'], chart.MAX_RECIPIENTS + 1)
  shares = db.execute('SELECT recipient,message,snapshot FROM review_share_entries').fetchall()
  self.assertEqual(len(shares), chart.MAX_RECIPIENTS + 1)
  self.assertEqual(len({row['recipient'] for row in shares}), len(shares))
  self.assertTrue(all(row['message'] == 'Review this structure' for row in shares))
  self.assertTrue(all(json.loads(row['snapshot'])['anchor_ms'] == snapshot['anchor_ms'] for row in shares))
  self.assertEqual(db.execute('SELECT count(*) FROM group_messages').fetchone()[0], 1)
  self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])

 def fixture(self):
  db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.row_factory=sqlite3.Row
  db.execute('PRAGMA foreign_keys=ON')
  db.executescript("CREATE TABLE users(id TEXT PRIMARY KEY,nickname TEXT,avatar TEXT); CREATE TABLE trades(person TEXT,ticket TEXT,payload TEXT,PRIMARY KEY(person,ticket)); INSERT INTO users VALUES('owner','Owner',''),('member','Member',''),('late','Late',''); INSERT INTO trades VALUES('owner','fixture','{}');")
  chart.initialize(db);groups.initialize(db);journal.initialize(db)
  group=groups.create(db,'owner','Synthetic group')
  groups.join(db,'member',group['code'])
  return db,group

 def save_note(self,db,body):
  return journal.save(db,'owner',{'ticket':'fixture','body':body,'tags':['方向判断'],'sections':[{'id':'direction','title':'方向','checked':True,'body':body}]})['note']

 def test_members_and_late_joiners_read_note_at_share_time(self):
  db,group=self.fixture();original=self.save_note(db,'Original review')
  chart.share(db,'owner','fixture',['member'],'Direct share',note=original)
  message=groups.share_trade(db,'owner',group['id'],'fixture',message='Group share')
  self.save_note(db,'Edited after sharing')
  groups.join(db,'late',group['code'])
  for uid in ('member','late'):
   share_id=groups.open_trade(db,group['id'],uid,message['id'])['share']
   view=chart.share_view(chart.share_row(db,uid,share_id))
   self.assertEqual(view['note'],original)
  row=db.execute('SELECT note_snapshot FROM group_messages WHERE id=?',(message['id'],)).fetchone()
  self.assertEqual(json.loads(row['note_snapshot']),original)

 def test_absent_note_stays_absent_after_owner_adds_one(self):
  db,group=self.fixture()
  message=groups.share_trade(db,'owner',group['id'],'fixture')
  self.save_note(db,'Written after sharing')
  groups.join(db,'late',group['code'])
  for uid in ('member','late'):
   share_id=groups.open_trade(db,group['id'],uid,message['id'])['share']
   self.assertIsNone(chart.share_view(chart.share_row(db,uid,share_id))['note'])

 def test_legacy_message_without_note_snapshot_remains_openable(self):
  db,group=self.fixture();original=self.save_note(db,'Legacy note')
  message=groups.share_trade(db,'owner',group['id'],'fixture')
  db.execute("UPDATE group_messages SET note_snapshot='' WHERE id=?",(message['id'],))
  groups.join(db,'late',group['code'])
  share_id=groups.open_trade(db,group['id'],'late',message['id'])['share']
  self.assertEqual(chart.share_view(chart.share_row(db,'late',share_id))['note'],original)


if __name__ == '__main__':
 unittest.main()
