"""Run the production MQL safety rules as C++ plus the native Windows UTC API.

No MT5 terminal, EA mount, broker connection, or order is started. Requires MSVC.
The fixture mocks the blocking journal/broker boundary and executes the same
production deadline/classification functions instead of matching source strings.
"""
import os,subprocess,tempfile,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

class TradeSafetyTests(unittest.TestCase):
 def test_native_rules_and_precise_utc(self):
  if os.name!='nt': self.skipTest('Native EA safety harness requires Windows')
  installer=Path(os.environ.get('ProgramFiles(x86)',r'C:\Program Files (x86)'))/'Microsoft Visual Studio/Installer/vswhere.exe'
  if not installer.exists(): self.skipTest('Native EA safety harness requires MSVC (vswhere.exe not found)')
  install=subprocess.check_output([str(installer),'-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],text=True).strip()
  if not install: self.skipTest('Native EA safety harness requires MSVC x64 tools')
  vcvars=Path(install)/'VC/Auxiliary/Build/vcvars64.bat'
  if not vcvars.exists(): self.skipTest('Native EA safety harness requires MSVC x64 developer environment')
  with tempfile.TemporaryDirectory(prefix='syncnote-trade-rules-') as folder:
   root=Path(folder);exe=root/'trade_rules.exe';obj=root/'trade_rules.obj';script=root/'run.cmd'
   script.write_text('@echo off\ncall "'+str(vcvars)+'" >nul\nif errorlevel 1 exit /b 1\ncl /nologo /EHsc /std:c++17 /W4 "'+str(ROOT/'tests/ea_trade_harness.cpp')+'" /Fe:"'+str(exe)+'" /Fo:"'+str(obj)+'"\nif errorlevel 1 exit /b 1\n"'+str(exe)+'"\n',encoding='utf-8')
   result=subprocess.run(['cmd.exe','/d','/c',str(script)],cwd=folder,capture_output=True,text=True,timeout=90)
   self.assertEqual(result.returncode,0,result.stdout+result.stderr)
   self.assertIn('trade safety behavior checks passed',result.stdout)
   print(result.stdout.strip())

if __name__=='__main__':unittest.main()
