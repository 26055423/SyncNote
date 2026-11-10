"""Idempotent adoption of the pre-migration schema; no import-time IO."""
import hashlib,secrets,time
import auth_security,device_pairing,journal,sync_history,bars,market_symbols,bar_sync_jobs,market,chart,groups,dm
from social import migrate_friends

def baseline(db):
 db.executescript('''
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,nickname TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '',bio TEXT NOT NULL DEFAULT '',password TEXT NOT NULL,allow_follow INTEGER NOT NULL DEFAULT 1,share_data INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS follows(follower TEXT NOT NULL REFERENCES users(id),target TEXT NOT NULL REFERENCES users(id),created REAL NOT NULL,PRIMARY KEY(follower,target),CHECK(follower<>target));
 CREATE TABLE IF NOT EXISTS friend_edges(a TEXT NOT NULL REFERENCES users(id),b TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL,requested_by TEXT NOT NULL,created REAL NOT NULL,decided REAL,
   a_deleted INTEGER NOT NULL DEFAULT 0,b_deleted INTEGER NOT NULL DEFAULT 0,a_blocked INTEGER NOT NULL DEFAULT 0,b_blocked INTEGER NOT NULL DEFAULT 0,
   a_hide INTEGER NOT NULL DEFAULT 0,b_hide INTEGER NOT NULL DEFAULT 0,a_mute INTEGER NOT NULL DEFAULT 0,b_mute INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY(a,b),CHECK(a<b));
 CREATE TABLE IF NOT EXISTS mt5_links(user_id TEXT PRIMARY KEY REFERENCES users(id),token_hash TEXT UNIQUE,account_key TEXT,updated REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS snapshots(person TEXT PRIMARY KEY,payload TEXT NOT NULL,updated REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS trades(person TEXT NOT NULL,ticket TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(person,ticket));
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,person TEXT NOT NULL,event_key TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created REAL NOT NULL,UNIQUE(person,event_key));
 CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,person TEXT NOT NULL,text TEXT NOT NULL,created REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS mt5_bindings(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS presence(user_id TEXT PRIMARY KEY,updated REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS social_notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,recipient TEXT NOT NULL,actor TEXT NOT NULL,created REAL NOT NULL,seen INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS registration_invite(id INTEGER PRIMARY KEY CHECK(id=1),code TEXT NOT NULL,updated REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY AUTOINCREMENT,code_hash TEXT NOT NULL UNIQUE,batch TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',created REAL NOT NULL,expires REAL NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,used_by TEXT,used_at REAL);
  CREATE INDEX IF NOT EXISTS idx_invites_hash ON invites(code_hash);
 CREATE TABLE IF NOT EXISTS broker_clocks(person TEXT PRIMARY KEY,broker TEXT NOT NULL,offset INTEGER,observed_from REAL NOT NULL,observed_to REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY,window REAL NOT NULL,attempts INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(target);
 CREATE INDEX IF NOT EXISTS idx_events_person ON events(person,id);
 CREATE INDEX IF NOT EXISTS idx_messages_person ON messages(person,id);
 ''')
 db.execute('INSERT OR IGNORE INTO registration_invite VALUES(1,?,?)',(secrets.token_hex(6).upper(),time.time()))
 if 'sudo_until' not in [r[1] for r in db.execute('PRAGMA table_info(sessions)')]:db.execute('ALTER TABLE sessions ADD COLUMN sudo_until REAL NOT NULL DEFAULT 0')
 if 'code_plain' not in [r[1] for r in db.execute('PRAGMA table_info(invites)')]:db.execute("ALTER TABLE invites ADD COLUMN code_plain TEXT NOT NULL DEFAULT ''")
 if not db.execute('SELECT 1 FROM invites LIMIT 1').fetchone():
  legacy=db.execute('SELECT code FROM registration_invite WHERE id=1').fetchone()
  if legacy:
   code=''.join(ch for ch in str(legacy[0]).upper() if ch.isalnum())
   db.execute('INSERT INTO invites(code_hash,batch,note,created,expires) VALUES(?,?,?,?,0)',(hashlib.sha256(code.encode()).hexdigest(),'legacy','迁移前的通用邀请码',time.time()))
 if 'onboarding_step' not in [r[1] for r in db.execute('PRAGMA table_info(users)')]:db.execute('ALTER TABLE users ADD COLUMN onboarding_step INTEGER NOT NULL DEFAULT 4')
 if 'locked' not in [r[1] for r in db.execute('PRAGMA table_info(users)')]:db.execute('ALTER TABLE users ADD COLUMN locked INTEGER NOT NULL DEFAULT 0')
 if 'share_reviews' not in [r[1] for r in db.execute('PRAGMA table_info(users)')]:db.execute('ALTER TABLE users ADD COLUMN share_reviews INTEGER NOT NULL DEFAULT 0')
 if 'auto_history_sync' not in [r[1] for r in db.execute('PRAGMA table_info(users)')]:db.execute('ALTER TABLE users ADD COLUMN auto_history_sync INTEGER NOT NULL DEFAULT 0')
 for _col in ('a_deleted','b_deleted','a_blocked','b_blocked','a_hide','b_hide','a_mute','b_mute'):
  if _col not in [r[1] for r in db.execute('PRAGMA table_info(friend_edges)')]:
   db.execute('ALTER TABLE friend_edges ADD COLUMN '+_col+' INTEGER NOT NULL DEFAULT 0')
 auth_security.initialize(db)
 device_pairing.initialize(db)
 journal.initialize(db)
 sync_history.initialize(db)
 bars.initialize(db)
 market_symbols.initialize(db)
 bar_sync_jobs.initialize(db)
 market.initialize(db)
 chart.initialize_legacy(db)
 groups.initialize(db)
 dm.initialize(db)

 if not db.execute("SELECT 1 FROM security_config WHERE key='sessions-30days'").fetchone():
  db.execute('UPDATE sessions SET expires=? WHERE expires>?',(time.time()+2592000,time.time()))
  db.execute("INSERT INTO security_config VALUES('sessions-30days')")
 migrate_friends(db)
