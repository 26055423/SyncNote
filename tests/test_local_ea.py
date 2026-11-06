"""Source download includes only declared MQL files; no credentials or gateway state."""
import hashlib,json,posixpath,re,sys,tempfile,unittest,zipfile
from io import BytesIO
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from local_ea import source_package

class SourcePackageTests(unittest.TestCase):
 def fixture(self,folder,entry='#include "lib/wire.mqh"\n'):
  root=Path(folder);bridge=root/'bridge';(bridge/'lib').mkdir(parents=True)
  (bridge/'SyncNoteLocal.mq5').write_text(entry,encoding='utf-8')
  (bridge/'lib'/'wire.mqh').write_text('// protocol\n',encoding='utf-8')
  for name in ('LOCAL_README.md','LOCAL_PROTOCOL.md'):(bridge/name).write_text('public instructions',encoding='utf-8')
  (bridge/'private.key').write_text('must never ship',encoding='utf-8')
  return root
 def note_fixture(self,folder,entry='#include "lib/new-bars.mqh"\n'):
  root=Path(folder);bridge=root/'bridge';(bridge/'lib'/'nested').mkdir(parents=True)
  (bridge/'SyncNote.mq5').write_text(entry,encoding='utf-8')
  (bridge/'lib'/'new-bars.mqh').write_text('# include "nested/clock.mqh"\n',encoding='utf-8')
  (bridge/'lib'/'nested'/'clock.mqh').write_text('// synthetic read-only helper\n',encoding='utf-8')
  for name in ('SyncNote_README.md','SYNCNOTE_PROTOCOL.md'):(bridge/name).write_text('public instructions',encoding='utf-8')
  return root
 def test_package_manifest_and_allowlist(self):
  with tempfile.TemporaryDirectory() as folder:
   root=self.fixture(folder);data=source_package(root)
   self.assertEqual(data,source_package(root))
   with zipfile.ZipFile(BytesIO(data)) as archive:
    self.assertEqual(set(archive.namelist()),{'SyncNoteLocal/'+n for n in ('SyncNoteLocal.mq5','lib/wire.mqh','LOCAL_README.md','LOCAL_PROTOCOL.md','SOURCE_MANIFEST.json')})
    manifest=json.loads(archive.read('SyncNoteLocal/SOURCE_MANIFEST.json'))
    for name,digest in manifest['files'].items():self.assertEqual(hashlib.sha256(archive.read('SyncNoteLocal/'+name)).hexdigest(),digest)
 def test_include_cannot_escape_source_directory(self):
  with tempfile.TemporaryDirectory() as folder:
   root=self.fixture(folder,'#include "../outside.mqh"\n');(root/'outside.mqh').write_text('private',encoding='utf-8')
   with self.assertRaises(ValueError):source_package(root)
 def test_include_cannot_ship_non_source(self):
  with tempfile.TemporaryDirectory() as folder:
   root=self.fixture(folder,'#include "private.key"\n')
   with self.assertRaises(ValueError):source_package(root)
 def test_syncnote_new_headers_are_collected_recursively(self):
  with tempfile.TemporaryDirectory() as folder:
   root=self.note_fixture(folder)
   with zipfile.ZipFile(BytesIO(source_package(root,'syncnote'))) as archive:
    expected={'SyncNote/'+name for name in ('SyncNote.mq5','lib/new-bars.mqh','lib/nested/clock.mqh','SyncNote_README.md','SYNCNOTE_PROTOCOL.md','SOURCE_MANIFEST.json')}
    self.assertEqual(set(archive.namelist()),expected)
    manifest=json.loads(archive.read('SyncNote/SOURCE_MANIFEST.json'))
    for name,digest in manifest['files'].items():self.assertEqual(hashlib.sha256(archive.read('SyncNote/'+name)).hexdigest(),digest)
 def test_actual_syncnote_download_contains_every_local_header_and_current_bytes(self):
  root=Path(__file__).resolve().parents[1]
  with zipfile.ZipFile(BytesIO(source_package(root,'syncnote'))) as archive:
   manifest=json.loads(archive.read('SyncNote/SOURCE_MANIFEST.json'))
   self.assertEqual(manifest['entry'],'SyncNote.mq5')
   self.assertIn('SyncNoteHistory.mqh',manifest['files']);self.assertIn('SyncNoteJson.mqh',manifest['files'])
   for name,digest in manifest['files'].items():
    body=archive.read('SyncNote/'+name)
    self.assertEqual(body,(root/'bridge'/name).read_bytes())
    self.assertEqual(hashlib.sha256(body).hexdigest(),digest)
    if not name.endswith(('.mq5','.mqh')):continue
    for dependency in re.findall(r'^\s*#\s*include\s+"([^"\r\n]+)"',body.decode('utf-8-sig'),re.M):
     included=posixpath.normpath(posixpath.join(posixpath.dirname(name),dependency.replace('\\','/')))
     self.assertIn('SyncNote/'+included,archive.namelist(),name+' dependency missing: '+dependency)
 def test_syncnote_rejects_trade_declaration_and_existing_forbidden_operations(self):
  for source in ('CTrade trader;\n','void Test(){OrderSend(request,result);}\n','void Test(){OrderSendAsync(request,result);}\n','void Test(){SocketCreate();}\n','#import "synthetic.dll"\n#import\n','# import "synthetic.dll"\n# import\n'):
   with self.subTest(source=source),tempfile.TemporaryDirectory() as folder:
    root=self.note_fixture(folder,source)
    with self.assertRaises(ValueError):source_package(root,'syncnote')
 def test_syncnote_rejects_angle_includes_in_entry_and_recursive_headers(self):
  for source in ('#include <Trade/Trade.mqh>\n','# include <new-helper.mqh>\n'):
   with self.subTest(source=source),tempfile.TemporaryDirectory() as folder:
    root=self.note_fixture(folder,source)
    with self.assertRaises(ValueError):source_package(root,'syncnote')
  with tempfile.TemporaryDirectory() as folder:
   root=self.note_fixture(folder)
   (root/'bridge'/'lib'/'nested'/'clock.mqh').write_text('#include <hidden-helper.mqh>\n',encoding='utf-8')
   with self.assertRaises(ValueError):source_package(root,'syncnote')
 def test_other_product_keeps_system_include_behavior(self):
  for product,entry,folder_name in (('legacy','SyncNoteLocal.mq5','SyncNoteLocal'),('synctrade','SyncTrade.mq5','SyncTrade')):
   with self.subTest(product=product),tempfile.TemporaryDirectory() as folder:
    root=self.fixture(folder,'#include <Trade/Trade.mqh>\nCTrade trader;\n')
    if product=='synctrade':
     (root/'bridge'/entry).write_text('#include <Trade/Trade.mqh>\nCTrade trader;\n',encoding='utf-8')
     for name in ('SyncTrade_README.md','SYNCNOTE_PROTOCOL.md'):(root/'bridge'/name).write_text('public instructions',encoding='utf-8')
    with zipfile.ZipFile(BytesIO(source_package(root,product))) as archive:self.assertIn(folder_name+'/'+entry,archive.namelist())

if __name__=='__main__':unittest.main()
