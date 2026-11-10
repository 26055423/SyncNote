"""SQLite snapshot/restore for deployment. Stop the service before restoring."""
import argparse,os,sqlite3,tempfile
from pathlib import Path

def copy_database(source,destination,restore=False):
 source=Path(source).resolve();destination=Path(destination).resolve()
 if source==destination:raise ValueError('Source and destination must differ')
 if not source.is_file():raise ValueError('Source database does not exist')
 if destination.exists() and not restore:raise ValueError('Backup destination already exists')
 metadata=(destination if restore and destination.exists() else source).stat()
 destination.parent.mkdir(parents=True,exist_ok=True)
 fd,name=tempfile.mkstemp(prefix='.sqlite-backup-',dir=destination.parent);os.close(fd)
 staging=Path(name)
 try:
  reader=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)
  writer=sqlite3.connect(staging)
  try:
   reader.backup(writer)
   if writer.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Database integrity check failed')
  finally:writer.close();reader.close()
  os.chmod(staging,metadata.st_mode & 0o777 if restore else 0o600)
  # Windows 没有 geteuid/chown：只有 POSIX 上以 root 运行才需要把副本还回原属主。
  if hasattr(os,'geteuid') and os.geteuid()==0:os.chown(staging,metadata.st_uid,metadata.st_gid)
  os.replace(staging,destination)
  if restore:
   for suffix in ('-wal','-shm'):Path(str(destination)+suffix).unlink(missing_ok=True)
 finally:staging.unlink(missing_ok=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('source');parser.add_argument('destination');parser.add_argument('--restore',action='store_true')
 args=parser.parse_args();copy_database(args.source,args.destination,args.restore)
