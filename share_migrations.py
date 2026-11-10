"""Separate immutable review content from delivery/read state; keep old URL ids."""
import json

def initialize_schema(db):
 db.executescript('''
 CREATE TABLE IF NOT EXISTS chart_states(person TEXT NOT NULL,ticket TEXT NOT NULL,state TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(person,ticket));
 CREATE TABLE IF NOT EXISTS review_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,ticket TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created REAL NOT NULL,snapshot TEXT NOT NULL,note_snapshot TEXT NOT NULL,group_id TEXT);
 CREATE TABLE IF NOT EXISTS review_shares(id INTEGER PRIMARY KEY AUTOINCREMENT,snapshot_id INTEGER NOT NULL REFERENCES review_snapshots(id),recipient TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0,UNIQUE(snapshot_id,recipient));
 CREATE INDEX IF NOT EXISTS idx_delivery_recipient ON review_shares(recipient,seen);
 CREATE INDEX IF NOT EXISTS idx_snapshot_owner ON review_snapshots(owner,ticket);
 CREATE VIEW IF NOT EXISTS review_share_entries AS SELECT d.id,d.snapshot_id,d.recipient,d.seen,s.owner,s.ticket,s.message,s.created,s.snapshot,s.note_snapshot,s.group_id FROM review_shares d JOIN review_snapshots s ON s.id=d.snapshot_id;
 CREATE TRIGGER IF NOT EXISTS immutable_review_snapshot BEFORE UPDATE ON review_snapshots BEGIN SELECT RAISE(ABORT,'review snapshots are immutable'); END;
 ''')

def migrate_shares(db):
 import chart,journal
 columns={r[1] for r in db.execute('PRAGMA table_info(review_shares)')}
 legacy=bool(columns and 'snapshot_id' not in columns)
 if legacy:db.execute('ALTER TABLE review_shares RENAME TO legacy_review_shares')
 initialize_schema(db)
 notes_by_owner={}
 has_notes=db.execute("SELECT 1 FROM sqlite_master WHERE name='trade_notes'").fetchone()
 def freeze(row,owner,group_id=None):
  # Very old cards did not freeze content. Freeze what is still available once,
  # at migration, rather than continuing to follow future edits.
  note=row['note_snapshot'] if 'note_snapshot' in row.keys() else ''
  if not note:
   if owner not in notes_by_owner:notes_by_owner[owner]=journal.notes(db,owner)['notes'] if has_notes else {}
   note=json.dumps(notes_by_owner[owner].get(row['ticket']),ensure_ascii=False)
  body=row['snapshot'] if 'snapshot' in row.keys() else ''
  return chart.create_snapshot(db,owner,row['ticket'],row['message'] if 'message' in row.keys() else row['text'],body,note,group_id,row['created'])
 if legacy:
  for row in db.execute('SELECT * FROM legacy_review_shares ORDER BY id').fetchall():
   sid=freeze(row,row['owner'])
   db.execute('INSERT INTO review_shares(id,snapshot_id,recipient,seen) VALUES(?,?,?,?)',(row['id'],sid,row['recipient'],row['seen']))
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='group_messages'").fetchone():
  if 'review_snapshot_id' not in {r[1] for r in db.execute('PRAGMA table_info(group_messages)')}:
   db.execute('ALTER TABLE group_messages ADD COLUMN review_snapshot_id INTEGER REFERENCES review_snapshots(id)')
  db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_group_review_snapshot ON group_messages(review_snapshot_id) WHERE review_snapshot_id IS NOT NULL')
  for row in db.execute("SELECT * FROM group_messages WHERE kind='trade' AND ticket IS NOT NULL AND review_snapshot_id IS NULL").fetchall():
   sid=freeze(row,row['person'],row['group_id'])
   db.execute('UPDATE group_messages SET review_snapshot_id=? WHERE id=?',(sid,row['id']))
