"""Upgrade pre-reply chat tables without losing stored conversations."""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dm
import groups


class ChatMigration(unittest.TestCase):
 def test_existing_messages_survive_idempotent_upgrade(self):
  db = sqlite3.connect(':memory:')
  db.row_factory = sqlite3.Row
  db.execute('PRAGMA foreign_keys=ON')
  db.executescript('''
   CREATE TABLE users(id TEXT PRIMARY KEY,nickname TEXT,avatar TEXT);
   CREATE TABLE presence(user_id TEXT PRIMARY KEY,updated REAL);
   CREATE TABLE direct_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,sender TEXT,recipient TEXT,text TEXT,created REAL,read_at REAL);
   CREATE TABLE review_shares(id INTEGER PRIMARY KEY,owner TEXT,recipient TEXT,ticket TEXT,message TEXT,created REAL,seen INTEGER);
   CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT,owner TEXT,code TEXT UNIQUE,created REAL);
   CREATE TABLE group_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id TEXT,person TEXT,kind TEXT,text TEXT,ticket TEXT,created REAL);
   INSERT INTO users VALUES('a','Alice',''),('b','Bob','');
   INSERT INTO direct_messages VALUES(1,'a','b','old private message',1,NULL);
   INSERT INTO groups VALUES('g','Old group','a','TEST',1);
   INSERT INTO group_messages VALUES(1,'g','a','text','old group message',NULL,1);
  ''')
  for _ in range(2):
   dm.initialize(db)
   groups.initialize(db)
  db.execute("INSERT INTO group_members VALUES('g','a','owner',1,0)")
  db.execute("INSERT INTO group_members VALUES('g','b','member',1,0)")
  self.assertEqual(dm.thread(db, 'b', 'a')[0]['text'], 'old private message')
  self.assertIsNone(dm.thread(db, 'b', 'a')[0]['reply'])
  dm.send(db, 'b', 'a', 'new reply', True, 1)
  self.assertEqual(dm.thread(db, 'a', 'b')[-1]['reply']['text'], 'old private message')
  dm.reaction(db, 'b', 'a', 1, '👍', True, True)
  self.assertEqual(dm.thread(db, 'a', 'b')[0]['reactions'][0]['count'], 1)
  groups.post(db, 'b', 'g', 'new group reply', 1)
  self.assertEqual(groups.messages(db, 'g', 'a')[-1]['reply']['text'], 'old group message')
  groups.reaction(db, 'b', 'g', 1, '✅', True)
  groups.leave(db, 'a', 'g')
  groups.leave(db, 'b', 'g')
  self.assertEqual(db.execute('SELECT count(*) FROM group_reactions').fetchone()[0], 0)
  self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
  db.close()


if __name__ == '__main__':
 unittest.main()
