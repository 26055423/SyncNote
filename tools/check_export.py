"""Whitelist source files before sharing; never prints matched secret values."""
import ast,hashlib,json,re,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SUFFIXES={'.py','.js','.css','.html','.svg','.mq5','.c','.swift','.ps1','.md','.yaml'}
SPECIAL={'.gitignore','.dockerignore','.env.example','Dockerfile','Caddyfile.example'}
DENIED={'data','secrets','backups','logs','__pycache__','.git'}
PATTERNS={
 'private_key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'api_key':r'\bsk-[A-Za-z0-9_-]{16,}',
 'github_token':r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})',
 'embedded_credentials':r'(?i)\b(?:postgres(?:ql)?|mysql|https?)://[^\s/]+:[^\s/@]+@',
 'private_address_or_server_path':r'(?:\b192\.168\.\d+\.\d+|\b10\.\d+\.\d+\.\d+|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|/(?:vol[0-9]+|volume[0-9]+|Volumes|Users)/)',
}

def collect():
 files=[];issues=[]
 for p in sorted(ROOT.rglob('*')):
  parts=p.relative_to(ROOT).parts
  if any(x.startswith('._') or x=='.DS_Store' for x in parts):continue
  if any(x in DENIED for x in parts):
   if p.is_file():issues.append({'path':str(p.relative_to(ROOT)),'kind':'excluded_runtime_file'})
   continue
  if not p.is_file():continue
  name=str(p.relative_to(ROOT))
  if p.is_symlink():issues.append({'path':name,'kind':'symlink'});continue
  if p.suffix not in SUFFIXES and p.name not in SPECIAL:issues.append({'path':name,'kind':'unapproved_file_type'});continue
  try:text=p.read_text(encoding='utf-8')
  except UnicodeError:issues.append({'path':name,'kind':'binary_file'});continue
  for kind,pattern in PATTERNS.items():
   for m in re.finditer(pattern,text):issues.append({'path':name,'line':text.count('\n',0,m.start())+1,'kind':kind})
  if p.suffix=='.py':ast.parse(text)
  files.append({'path':name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
 return files,issues

if __name__=='__main__':
 files,issues=collect();print(json.dumps({'passed':not issues,'file_count':len(files),'bytes':sum(p['bytes'] for p in files),'issues':issues},ensure_ascii=False));sys.exit(bool(issues))
