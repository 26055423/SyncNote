"""Explicit, serialized and atomic schema upgrades (legacy schema version: 2)."""
from pathlib import Path
import time
import database

def steps():
 from app_bootstrap import baseline
 from trade_store import migrate_legacy
 from share_migrations import migrate_shares
 return ((3,'adopt baseline',baseline),(4,'isolate legacy history',migrate_legacy),(5,'immutable review snapshots',migrate_shares))

def migrate(path,plan=None):
 plan=steps() if plan is None else plan
 latest=plan[-1][0]
 Path(path).parent.mkdir(parents=True,exist_ok=True)
 with database.connect(path,migration=True) as db:
  db.execute('PRAGMA journal_mode=WAL')
  db.execute('PRAGMA foreign_keys=OFF')
  db.execute('BEGIN IMMEDIATE')
  version=db.execute('PRAGMA user_version').fetchone()[0]
  if version>latest:raise RuntimeError('Database schema is newer than this application')
  db.execute('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied REAL NOT NULL)')
  for target,name,apply in plan:
   if target<=version:continue
   apply(db)
   db.execute('INSERT INTO schema_migrations VALUES(?,?,?)',(target,name,time.time()))
   db.execute('PRAGMA user_version='+str(target))
  violations=db.execute('PRAGMA foreign_key_check').fetchall()
  if violations:raise RuntimeError('Migration foreign key check failed (%d rows)'%len(violations))
 return latest
