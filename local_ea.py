"""Build the public EA source download from an explicit entry point and local includes."""
import hashlib,json,re,zipfile
from io import BytesIO
from pathlib import Path

def source_package(root):
 base=(Path(root)/'bridge').resolve()
 files={}
 def collect(relative):
  path=(base/relative).resolve()
  if base not in path.parents or path.suffix.lower() not in ('.mq5','.mqh'):
   raise ValueError('EA include must remain inside bridge and be MQL source')
  name=path.relative_to(base).as_posix()
  if name in files:return
  body=path.read_bytes()
  if len(body)>2*1024*1024:raise ValueError('EA source is too large')
  files[name]=body
  source=body.decode('utf-8-sig')
  for include in re.findall(r'^\s*#include\s+"([^"\r\n]+)"',source,re.M):
   collect((path.parent/include).relative_to(base))
 collect(Path('TongpinLocal.mq5'))
 for name in ('LOCAL_README.md','LOCAL_PROTOCOL.md'):
  files[name]=(base/name).read_bytes()
 manifest={'format':1,'entry':'TongpinLocal.mq5','files':{name:hashlib.sha256(body).hexdigest() for name,body in sorted(files.items())}}
 files['SOURCE_MANIFEST.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
 output=BytesIO()
 with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
  for name,body in sorted(files.items()):
   info=zipfile.ZipInfo('TongpinLocal/'+name,date_time=(2026,10,30,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   archive.writestr(info,body)
 return output.getvalue()
