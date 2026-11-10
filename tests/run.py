"""Run each suite in its own process so HTTP fixtures cannot share app state."""
import argparse,subprocess,sys
from pathlib import Path

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('patterns',nargs='*',help='File globs inside tests/; default: test_*.py and smoke.py')
 args=parser.parse_args();folder=Path(__file__).resolve().parent
 suites=sorted({path for pattern in (args.patterns or ['test_*.py','smoke.py']) for path in folder.glob(pattern) if path.is_file() and path.suffix=='.py' and path.name!='run.py'})
 if not suites:parser.error('No matching test suites')
 failed=[]
 for path in suites:
  print('Running '+path.name,flush=True)
  if subprocess.run([sys.executable,str(path)],cwd=folder.parent).returncode:failed.append(path.name)
 print('%d suites, %d failed'%(len(suites),len(failed)),flush=True)
 if failed:print('Failed: '+', '.join(failed),flush=True)
 return bool(failed)

if __name__=='__main__':sys.exit(main())
