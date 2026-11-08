"""User-owned notebook sections, templates and phrases; no public publication."""
import json,time,uuid

class JournalError(Exception):
 def __init__(self,text,code=400):self.text,self.code=text,code

def initialize(db):
 db.executescript('''CREATE TABLE IF NOT EXISTS trade_note_sections(person TEXT NOT NULL,ticket TEXT NOT NULL,sections TEXT NOT NULL,PRIMARY KEY(person,ticket),FOREIGN KEY(person,ticket) REFERENCES trade_notes(person,ticket) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS journal_templates(id TEXT PRIMARY KEY,person TEXT NOT NULL,name TEXT NOT NULL,sections TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,last_used REAL NOT NULL DEFAULT 0,updated REAL NOT NULL,UNIQUE(person,name));
 CREATE INDEX IF NOT EXISTS journal_templates_owner ON journal_templates(person);
 CREATE TABLE IF NOT EXISTS journal_phrases(id TEXT PRIMARY KEY,person TEXT NOT NULL,text TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,last_used REAL NOT NULL DEFAULT 0,updated REAL NOT NULL,UNIQUE(person,text));
 CREATE INDEX IF NOT EXISTS journal_phrases_owner ON journal_phrases(person);''')

def sections(value,template=False):
 if not isinstance(value,list) or len(value)>30:raise JournalError('章节最多 30 个')
 out=[];seen=set();total=0
 for item in value:
  if not isinstance(item,dict):raise JournalError('章节格式不正确')
  ident=item.get('id',uuid.uuid4().hex)
  title=item.get('title','');body=item.get('body','');checked=item.get('checked',False)
  if not isinstance(ident,str) or not 1<=len(ident)<=80 or ident in seen:raise JournalError('章节编号不正确或重复')
  if not isinstance(title,str) or not 1<=len(title.strip())<=80:raise JournalError('章节标题需为 1 至 80 字')
  if not isinstance(body,str) or len(body)>3000:raise JournalError('每个章节内容最多 3000 字')
  if not isinstance(checked,bool):raise JournalError('章节检查状态不正确')
  total+=len(title)+len(body)
  if total>30000:raise JournalError('章节内容合计最多 30000 字')
  seen.add(ident)
  out.append({'id':ident,'title':title.strip(),'body':'' if template else body.strip(),'checked':False if template else checked})
 return out

def note_sections(db,person):
 return {r['ticket']:json.loads(r['sections']) for r in db.execute('SELECT ticket,sections FROM trade_note_sections WHERE person=?',(person,))}

def library(db,person):
 templates=[{'id':r['id'],'name':r['name'],'sections':json.loads(r['sections']),'uses':r['uses'],'last_used':r['last_used']} for r in db.execute('SELECT * FROM journal_templates WHERE person=? ORDER BY uses DESC,last_used DESC,updated DESC,id',(person,))]
 phrases=[{'id':r['id'],'text':r['text'],'uses':r['uses'],'last_used':r['last_used']} for r in db.execute('SELECT * FROM journal_phrases WHERE person=? ORDER BY uses DESC,last_used DESC,updated DESC,id',(person,))]
 # Each title counts once per meaningful trade note, not once per Save click.
 chapters={}
 for row in db.execute('SELECT s.sections,n.updated FROM trade_note_sections s JOIN trade_notes n ON n.person=s.person AND n.ticket=s.ticket WHERE s.person=?',(person,)):
  titles={section['title'] for section in json.loads(row['sections']) if section.get('checked') or section.get('body','').strip()}
  for title in titles:
   entry=chapters.setdefault(title,{'title':title,'uses':0,'last_used':0})
   entry['uses']+=1;entry['last_used']=max(entry['last_used'],row['updated'])
 ordered=sorted(chapters.values(),key=lambda item:(-item['uses'],-item['last_used'],item['title']))[:30]
 return {'templates':templates,'phrases':phrases,'chapters':ordered}

def save_template(db,person,data):
 name=data.get('name','')
 if not isinstance(name,str) or not 1<=len(name.strip())<=80:raise JournalError('模板名称需为 1 至 80 字')
 content=sections(data.get('sections'),True)
 if not content:raise JournalError('模板至少需要一个章节')
 name=name.strip();ident=data.get('id');now=time.time()
 if ident is not None:
  if not isinstance(ident,str) or not db.execute('SELECT 1 FROM journal_templates WHERE person=? AND id=?',(person,ident)).fetchone():raise JournalError('模板不存在',404)
  duplicate=db.execute('SELECT id FROM journal_templates WHERE person=? AND name=? AND id<>?',(person,name,ident)).fetchone()
  if duplicate:raise JournalError('已有同名模板，请更换名称',409)
  db.execute('UPDATE journal_templates SET name=?,sections=?,updated=? WHERE person=? AND id=?',(name,json.dumps(content,ensure_ascii=False),now,person,ident))
 else:
  old=db.execute('SELECT id FROM journal_templates WHERE person=? AND name=?',(person,name)).fetchone()
  if old:raise JournalError('已有同名模板，请更换名称',409)
  if db.execute('SELECT count(*) FROM journal_templates WHERE person=?',(person,)).fetchone()[0]>=100:raise JournalError('个人模板最多 100 个')
  ident=uuid.uuid4().hex
  db.execute('INSERT INTO journal_templates(id,person,name,sections,updated) VALUES(?,?,?,?,?)',(ident,person,name,json.dumps(content,ensure_ascii=False),now))
 return {'ok':True,'template':next(row for row in library(db,person)['templates'] if row['id']==ident)}

def save_phrase(db,person,data):
 text=data.get('text','')
 if not isinstance(text,str) or not 1<=len(text.strip())<=500:raise JournalError('常用语需为 1 至 500 字')
 text=text.strip();old=db.execute('SELECT id FROM journal_phrases WHERE person=? AND text=?',(person,text)).fetchone()
 if old:ident=old['id']
 else:
  if db.execute('SELECT count(*) FROM journal_phrases WHERE person=?',(person,)).fetchone()[0]>=200:raise JournalError('个人常用语最多 200 条')
  ident=uuid.uuid4().hex
  db.execute('INSERT INTO journal_phrases(id,person,text,updated) VALUES(?,?,?,?)',(ident,person,text,time.time()))
 return {'ok':True,'phrase':next(row for row in library(db,person)['phrases'] if row['id']==ident)}

def library_item(db,person,data,remove=False):
 choices=[(key,table) for key,table in [('template_id','journal_templates'),('phrase_id','journal_phrases')] if key in data]
 if len(choices)!=1:raise JournalError('请指定一个模板或常用语')
 key,table=choices[0];ident=data[key]
 if not isinstance(ident,str) or not db.execute('SELECT 1 FROM '+table+' WHERE person=? AND id=?',(person,ident)).fetchone():raise JournalError('条目不存在',404)
 if remove:db.execute('DELETE FROM '+table+' WHERE person=? AND id=?',(person,ident))
 else:db.execute('UPDATE '+table+' SET uses=uses+1,last_used=? WHERE person=? AND id=?',(time.time(),person,ident))
 return {'ok':True}
