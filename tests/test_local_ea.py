"""Source download includes only declared MQL files; no credentials or gateway state."""
import hashlib,json,sys,tempfile,unittest,zipfile
from io import BytesIO
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from local_ea import source_package

class SourcePackageTests(unittest.TestCase):
 def fixture(self,folder,entry='#include "lib/wire.mqh"\n'):
  root=Path(folder);bridge=root/'bridge';(bridge/'lib').mkdir(parents=True)
  (bridge/'TongpinLocal.mq5').write_text(entry,encoding='utf-8')
  (bridge/'lib'/'wire.mqh').write_text('// protocol\n',encoding='utf-8')
  for name in ('LOCAL_README.md','LOCAL_PROTOCOL.md'):(bridge/name).write_text('public instructions',encoding='utf-8')
  (bridge/'private.key').write_text('must never ship',encoding='utf-8')
  return root
 def test_package_manifest_and_allowlist(self):
  with tempfile.TemporaryDirectory() as folder:
   root=self.fixture(folder);data=source_package(root)
   self.assertEqual(data,source_package(root))
   with zipfile.ZipFile(BytesIO(data)) as archive:
    self.assertEqual(set(archive.namelist()),{'TongpinLocal/'+n for n in ('TongpinLocal.mq5','lib/wire.mqh','LOCAL_README.md','LOCAL_PROTOCOL.md','SOURCE_MANIFEST.json')})
    manifest=json.loads(archive.read('TongpinLocal/SOURCE_MANIFEST.json'))
    for name,digest in manifest['files'].items():self.assertEqual(hashlib.sha256(archive.read('TongpinLocal/'+name)).hexdigest(),digest)
 def test_include_cannot_escape_source_directory(self):
  with tempfile.TemporaryDirectory() as folder:
   root=self.fixture(folder,'#include "../outside.mqh"\n');(root/'outside.mqh').write_text('private',encoding='utf-8')
   with self.assertRaises(ValueError):source_package(root)
 def test_include_cannot_ship_non_source(self):
  with tempfile.TemporaryDirectory() as folder:
   root=self.fixture(folder,'#include "private.key"\n')
   with self.assertRaises(ValueError):source_package(root)

if __name__=='__main__':unittest.main()
