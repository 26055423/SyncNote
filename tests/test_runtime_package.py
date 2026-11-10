"""Exercise the Docker runtime COPY contract without frontend source or a daemon."""
import os,shlex,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

class RuntimePackage(unittest.TestCase):
 def test_backend_and_both_ea_downloads_work_without_frontend_source(self):
  docker=(ROOT/'Dockerfile').read_text().replace(chr(92)+chr(10),' ')
  runtime=docker.split('FROM python:',1)[1]
  with tempfile.TemporaryDirectory(prefix='syncnote-runtime-') as folder:
   stage=Path(folder)
   for line in runtime.splitlines():
    parts=shlex.split(line)
    if not parts or parts[0]!='COPY' or parts[1].startswith('--from='):continue
    destination=stage/parts[-1].removeprefix('./');destination.mkdir(parents=True,exist_ok=True)
    for pattern in parts[1:-1]:
     paths=list(ROOT.glob(pattern));self.assertTrue(paths,'Empty Docker COPY: '+pattern)
     for path in paths:
      if path.is_dir():shutil.copytree(path,destination,dirs_exist_ok=True,ignore=shutil.ignore_patterns('node_modules','chart-src','__pycache__'))
      else:shutil.copy2(path,destination/path.name)
   self.assertFalse((stage/'web/chart-src').exists())
   self.assertFalse((stage/'bridge/gateway.py').exists())
   env={**os.environ,'DATA_DIR':str(stage/'data'),'EA_HUB_ENABLE':'0','PYTHONDONTWRITEBYTECODE':'1'}
   script="import app_server, journal_templates, local_ea; from pathlib import Path; assert journal_templates.SYSTEM_CHAPTERS; assert app_server.DB.is_file(); [local_ea.source_package(Path.cwd(), product) for product in local_ea.PRODUCTS]"
   result=subprocess.run([sys.executable,'-c',script],cwd=stage,env=env,capture_output=True,text=True,timeout=30)
   self.assertEqual(result.returncode,0,result.stdout+result.stderr)

if __name__=='__main__':unittest.main()
