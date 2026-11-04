"""Group shares reach every member while reusing the bounded review-share API."""
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chart
import groups


class GroupShare(unittest.TestCase):
 def test_more_than_twenty_members_receive_message_and_slice(self):
  db = sqlite3.connect(':memory:')
  self.addCleanup(db.close)
  db.row_factory = sqlite3.Row
  db.execute('PRAGMA foreign_keys=ON')
  db.executescript('CREATE TABLE users(id TEXT PRIMARY KEY,nickname TEXT,avatar TEXT); CREATE TABLE trades(person TEXT,ticket TEXT,payload TEXT);')
  chart.initialize(db)
  groups.initialize(db)
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
  shares = db.execute('SELECT recipient,message,snapshot FROM review_shares').fetchall()
  self.assertEqual(len(shares), chart.MAX_RECIPIENTS + 1)
  self.assertEqual(len({row['recipient'] for row in shares}), len(shares))
  self.assertTrue(all(row['message'] == 'Review this structure' for row in shares))
  self.assertTrue(all(json.loads(row['snapshot'])['anchor_ms'] == snapshot['anchor_ms'] for row in shares))
  self.assertEqual(db.execute('SELECT count(*) FROM group_messages').fetchone()[0], 1)
  self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])


if __name__ == '__main__':
 unittest.main()
