"""Short-lived SQLite connections; transaction contexts also close their handle."""
import sqlite3
import time
import observability

class Connection(sqlite3.Connection):
 def __exit__(self,*args):
  try:return super().__exit__(*args)
  finally:self.close()

 def execute(self,sql,parameters=()):
  started=time.perf_counter();failed=False
  try:return super().execute(sql,parameters)
  except sqlite3.Error:
   failed=True;raise
  finally:observability.record('db.execute',time.perf_counter()-started,failed)

class MigrationConnection(Connection):
 def executescript(self,script):
  # sqlite3.executescript implicitly commits, which would break atomic migrations.
  statement=''
  for char in script:
   statement+=char
   if char==';' and sqlite3.complete_statement(statement):
    self.execute(statement);statement=''
  if statement.strip():self.execute(statement)

def connect(path,*,migration=False):
 db=sqlite3.connect(path,timeout=20,factory=MigrationConnection if migration else Connection)
 db.row_factory=sqlite3.Row
 db.execute('PRAGMA foreign_keys=ON')
 return db
