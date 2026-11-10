"""Authoritative raw-deal reconstructions and isolated compatibility summaries."""
import json,time

def initialize(db):
 db.executescript('''
 CREATE TABLE IF NOT EXISTS trade_keys(person TEXT NOT NULL,ticket TEXT NOT NULL,PRIMARY KEY(person,ticket));
 CREATE TABLE IF NOT EXISTS legacy_trades(person TEXT NOT NULL,ticket TEXT NOT NULL,payload TEXT NOT NULL,updated REAL NOT NULL,transport TEXT NOT NULL,PRIMARY KEY(person,ticket));
 CREATE TRIGGER IF NOT EXISTS trades_identity AFTER INSERT ON trades BEGIN INSERT OR IGNORE INTO trade_keys VALUES(NEW.person,NEW.ticket); END;
 CREATE TRIGGER IF NOT EXISTS legacy_trades_identity AFTER INSERT ON legacy_trades BEGIN INSERT OR IGNORE INTO trade_keys VALUES(NEW.person,NEW.ticket); END;
 INSERT OR IGNORE INTO trade_keys SELECT person,ticket FROM trades;
 INSERT OR IGNORE INTO trade_keys SELECT person,ticket FROM legacy_trades;
 CREATE VIEW IF NOT EXISTS trade_records AS SELECT person,ticket,payload FROM trades UNION ALL SELECT l.person,l.ticket,l.payload FROM legacy_trades l WHERE NOT EXISTS(SELECT 1 FROM trades t WHERE t.person=l.person AND t.ticket=l.ticket);
 ''')

def store_legacy(db,person,trade,transport):
 payload=dict(trade,legacy=True,history_origin='legacy-summary')
 db.execute('INSERT INTO legacy_trades VALUES(?,?,?,?,?) ON CONFLICT(person,ticket) DO UPDATE SET payload=excluded.payload,updated=excluded.updated,transport=excluded.transport',(person,str(trade['ticket']),json.dumps(payload,ensure_ascii=False,allow_nan=False),time.time(),transport))

def lookup(db,person,ticket):
 return db.execute('SELECT payload FROM trade_records WHERE person=? AND ticket=?',(person,str(ticket))).fetchone()

def history_rows(db,person):
 # Never mix summary trades with reconstructed deals in the primary history.
 table='trades' if db.execute('SELECT 1 FROM trades WHERE person=? LIMIT 1',(person,)).fetchone() else 'legacy_trades'
 return db.execute('SELECT payload FROM '+table+' WHERE person=?',(person,)).fetchall()

def migrate_legacy(db):
 initialize(db)
 # Rebuild parents without renaming old tables: note sections keep their FK target.
 for table in ('trade_notes','trade_reviews'):
  sql=db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()[0]
  if 'REFERENCES trades(' in sql:
   db.execute(sql.replace(table,table+'_new',1).replace('REFERENCES trades(','REFERENCES trade_keys('))
   db.execute('INSERT INTO '+table+'_new SELECT * FROM '+table)
   db.execute('DROP TABLE '+table)
   db.execute('ALTER TABLE '+table+'_new RENAME TO '+table)
 for row in db.execute('SELECT person,ticket,payload FROM trades').fetchall():
  payload=json.loads(row['payload'])
  if payload.get('source')=='syncnote-history.v1':continue
  store_legacy(db,row['person'],dict(payload,ticket=row['ticket']),'migration')
  db.execute('DELETE FROM trades WHERE person=? AND ticket=?',(row['person'],row['ticket']))
