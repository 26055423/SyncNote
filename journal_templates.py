"""User-owned notebook sections, templates and phrases; no public publication."""
import json,time,uuid

class JournalError(Exception):
 def __init__(self,text,code=400):self.text,self.code=text,code

def initialize(db):
 db.executescript('''CREATE TABLE IF NOT EXISTS trade_note_sections(person TEXT NOT NULL,ticket TEXT NOT NULL,sections TEXT NOT NULL,PRIMARY KEY(person,ticket),FOREIGN KEY(person,ticket) REFERENCES trade_notes(person,ticket) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS journal_templates(id TEXT PRIMARY KEY,person TEXT NOT NULL,name TEXT NOT NULL,sections TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,last_used REAL NOT NULL DEFAULT 0,updated REAL NOT NULL,UNIQUE(person,name));
 CREATE INDEX IF NOT EXISTS journal_templates_owner ON journal_templates(person);
 CREATE TABLE IF NOT EXISTS journal_phrases(id TEXT PRIMARY KEY,person TEXT NOT NULL,text TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,last_used REAL NOT NULL DEFAULT 0,updated REAL NOT NULL,UNIQUE(person,text));
 CREATE INDEX IF NOT EXISTS journal_phrases_owner ON journal_phrases(person);
 CREATE TABLE IF NOT EXISTS journal_public(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,sections TEXT NOT NULL,phrases TEXT NOT NULL DEFAULT '[]',summary TEXT NOT NULL DEFAULT '',symbol TEXT NOT NULL DEFAULT '',timeframe TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,uses INTEGER NOT NULL DEFAULT 0,favorites INTEGER NOT NULL DEFAULT 0,hidden INTEGER NOT NULL DEFAULT 0,published REAL NOT NULL,updated REAL NOT NULL);
 CREATE INDEX IF NOT EXISTS journal_public_owner ON journal_public(owner);
 CREATE TABLE IF NOT EXISTS journal_public_refs(id TEXT PRIMARY KEY,public_id TEXT NOT NULL,person TEXT NOT NULL,created REAL NOT NULL,UNIQUE(public_id,person));
 CREATE TABLE IF NOT EXISTS journal_public_favs(public_id TEXT NOT NULL,person TEXT NOT NULL,created REAL NOT NULL,PRIMARY KEY(public_id,person));''')
 for table,column,definition in (('journal_templates','phrases',"TEXT NOT NULL DEFAULT '[]'"),
                                 ('journal_templates','pinned','INTEGER NOT NULL DEFAULT 0'),
                                 ('journal_phrases','pinned','INTEGER NOT NULL DEFAULT 0')):
  if column not in [row[1] for row in db.execute('PRAGMA table_info(%s)'%table)]:
   db.execute('ALTER TABLE %s ADD COLUMN %s %s'%(table,column,definition))

def evidence_list(value,template=False):
 """章节下的图表证据：只保留标识、说明与当时的快照，模板里一律清空。"""
 if value is None or template:return []
 if not isinstance(value,list) or len(value)>10:raise JournalError('每个章节最多 10 条证据')
 out=[]
 for item in value:
  if not isinstance(item,dict):raise JournalError('证据格式不正确')
  ident=item.get('id');caption=item.get('caption','');drawing=item.get('drawing_id','');timeframe=item.get('timeframe','')
  anchor=item.get('anchor_ms')
  if not isinstance(ident,str) or not 1<=len(ident)<=64:raise JournalError('证据编号不正确')
  if not isinstance(caption,str) or len(caption)>200:raise JournalError('证据说明最多 200 字')
  if not isinstance(drawing,str) or len(drawing)>120:raise JournalError('证据图形编号不正确')
  if not isinstance(timeframe,str) or len(timeframe)>16:raise JournalError('证据周期不正确')
  if anchor is not None and (isinstance(anchor,bool) or not isinstance(anchor,(int,float))):raise JournalError('证据时间不正确')
  snapshot=item.get('snapshot')
  if snapshot is not None and not isinstance(snapshot,dict):raise JournalError('证据快照不正确')
  out.append({'id':ident,'caption':caption.strip(),'drawing_id':drawing,'timeframe':timeframe,'anchor_ms':int(anchor) if isinstance(anchor,(int,float)) and not isinstance(anchor,bool) else None,'snapshot':snapshot})
 return out

VERDICTS=('yes','no','unclear','na')

def sections(value,template=False):
 if not isinstance(value,list) or len(value)>30:raise JournalError('章节最多 30 个')
 out=[];seen=set();total=0
 for item in value:
  if not isinstance(item,dict):raise JournalError('章节格式不正确')
  ident=item.get('id',uuid.uuid4().hex)
  title=item.get('title','');body=item.get('body','');checked=item.get('checked',False)
  group=item.get('group');verdict=item.get('verdict')
  if not isinstance(ident,str) or not 1<=len(ident)<=80 or ident in seen:raise JournalError('章节编号不正确或重复')
  if not isinstance(title,str) or not 1<=len(title.strip())<=80:raise JournalError('章节标题需为 1 至 80 字')
  if not isinstance(body,str) or len(body)>3000:raise JournalError('每个章节内容最多 3000 字')
  if not isinstance(checked,bool):raise JournalError('章节检查状态不正确')
  if group is not None:
   if not isinstance(group,str) or len(group.strip())>40:raise JournalError('分组名称最多 40 字')
   group=group.strip() or None
  # 结论和「已检查」是两件事：勾选只表示看过，符合与否单独记。
  if verdict is not None and verdict not in VERDICTS:raise JournalError('章节结论不正确')
  evidence=evidence_list(item.get('evidence'),template)
  total+=len(title)+len(body)
  if total>30000:raise JournalError('章节内容合计最多 30000 字')
  seen.add(ident)
  out.append({'id':ident,'title':title.strip(),'group':group,'body':'' if template else body.strip(),'checked':False if template else checked,'verdict':None if template else verdict,'evidence':evidence})
 return out

MAX_TEMPLATE_PHRASES=20

def phrase_list(value):
 """模板自带的常用语：纯文本数组，去重后最多 20 条。"""
 if value is None:return []
 if not isinstance(value,list) or len(value)>MAX_TEMPLATE_PHRASES:raise JournalError('模板常用语最多 %d 条'%MAX_TEMPLATE_PHRASES)
 out=[]
 for item in value:
  if not isinstance(item,str) or not 1<=len(item.strip())<=500:raise JournalError('常用语需为 1 至 500 字')
  text=item.strip()
  if text not in out:out.append(text)
 return out

def note_sections(db,person):
 return {r['ticket']:json.loads(r['sections']) for r in db.execute('SELECT ticket,sections FROM trade_note_sections WHERE person=?',(person,))}

def library(db,person):
 templates=[{'id':r['id'],'name':r['name'],'sections':json.loads(r['sections']),'phrases':json.loads(r['phrases'] or '[]'),'uses':r['uses'],'last_used':r['last_used'],'pinned':bool(r['pinned'])} for r in db.execute('SELECT * FROM journal_templates WHERE person=? ORDER BY pinned DESC,uses DESC,last_used DESC,updated DESC,id',(person,))]
 phrases=[{'id':r['id'],'text':r['text'],'uses':r['uses'],'last_used':r['last_used'],'pinned':bool(r['pinned'])} for r in db.execute('SELECT * FROM journal_phrases WHERE person=? ORDER BY pinned DESC,uses DESC,last_used DESC,updated DESC,id',(person,))]
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
 phrases=phrase_list(data['phrases']) if 'phrases' in data else None
 name=name.strip();ident=data.get('id');now=time.time()
 if ident is not None:
  if not isinstance(ident,str) or not db.execute('SELECT 1 FROM journal_templates WHERE person=? AND id=?',(person,ident)).fetchone():raise JournalError('模板不存在',404)
  duplicate=db.execute('SELECT id FROM journal_templates WHERE person=? AND name=? AND id<>?',(person,name,ident)).fetchone()
  if duplicate:raise JournalError('已有同名模板，请更换名称',409)
  if phrases is None:db.execute('UPDATE journal_templates SET name=?,sections=?,updated=? WHERE person=? AND id=?',(name,json.dumps(content,ensure_ascii=False),now,person,ident))
  else:db.execute('UPDATE journal_templates SET name=?,sections=?,phrases=?,updated=? WHERE person=? AND id=?',(name,json.dumps(content,ensure_ascii=False),json.dumps(phrases,ensure_ascii=False),now,person,ident))
 else:
  old=db.execute('SELECT id FROM journal_templates WHERE person=? AND name=?',(person,name)).fetchone()
  if old:raise JournalError('已有同名模板，请更换名称',409)
  if db.execute('SELECT count(*) FROM journal_templates WHERE person=?',(person,)).fetchone()[0]>=100:raise JournalError('个人模板最多 100 个')
  ident=uuid.uuid4().hex
  db.execute('INSERT INTO journal_templates(id,person,name,sections,phrases,updated) VALUES(?,?,?,?,?,?)',(ident,person,name,json.dumps(content,ensure_ascii=False),json.dumps(phrases or [],ensure_ascii=False),now))
 return {'ok':True,'template':next(row for row in library(db,person)['templates'] if row['id']==ident)}

def save_phrase(db,person,data):
 text=data.get('text','')
 if not isinstance(text,str) or not 1<=len(text.strip())<=500:raise JournalError('常用语需为 1 至 500 字')
 text=text.strip();pinned=1 if data.get('pinned') is True else 0
 old=db.execute('SELECT id FROM journal_phrases WHERE person=? AND text=?',(person,text)).fetchone()
 if old:
  ident=old['id'];db.execute('UPDATE journal_phrases SET pinned=? WHERE id=?',(pinned,ident))
 else:
  if db.execute('SELECT count(*) FROM journal_phrases WHERE person=?',(person,)).fetchone()[0]>=200:raise JournalError('个人常用语最多 200 条')
  ident=uuid.uuid4().hex
  db.execute('INSERT INTO journal_phrases(id,person,text,pinned,updated) VALUES(?,?,?,?,?)',(ident,person,text,pinned,time.time()))
 return {'ok':True,'phrase':next(row for row in library(db,person)['phrases'] if row['id']==ident)}

def pin_phrase(db,person,data):
 ident=data.get('id')
 if not isinstance(ident,str) or not db.execute('SELECT 1 FROM journal_phrases WHERE person=? AND id=?',(person,ident)).fetchone():raise JournalError('条目不存在',404)
 pinned=bool(data.get('pinned'))
 db.execute('UPDATE journal_phrases SET pinned=? WHERE person=? AND id=?',(1 if pinned else 0,person,ident))
 return {'ok':True,'pinned':pinned}

def pin_item(db,person,data):
 ident=data.get('id');table='journal_templates' if 'template_id' in data or data.get('kind')=='template' else 'journal_phrases'
 if 'template_id' in data:ident=data['template_id']
 if not isinstance(ident,str) or not db.execute('SELECT 1 FROM '+table+' WHERE person=? AND id=?',(person,ident)).fetchone():raise JournalError('条目不存在',404)
 pinned=bool(data.get('pinned'))
 db.execute('UPDATE '+table+' SET pinned=? WHERE person=? AND id=?',(1 if pinned else 0,person,ident))
 return {'ok':True,'pinned':pinned}

def public_list(db,person,query='',limit=50):
 rows=db.execute("SELECT p.*,u.nickname FROM journal_public p JOIN users u ON u.id=p.owner WHERE p.hidden=0 ORDER BY p.favorites DESC,p.uses DESC,p.published DESC LIMIT ?",(max(1,min(int(limit or 50),100)),)).fetchall()
 text=(query or '').strip().lower()
 out=[]
 favs={r[0] for r in db.execute('SELECT public_id FROM journal_public_favs WHERE person=?',(person,))}
 for r in rows:
  sections=json.loads(r['sections'])
  hay=' '.join([r['name'],r['summary'],r['symbol'],r['timeframe']]+[s.get('title','') for s in sections]).lower()
  if text and text not in hay:continue
  out.append({'id':r['id'],'name':r['name'],'summary':r['summary'],'symbol':r['symbol'],'timeframe':r['timeframe'],'version':r['version'],'uses':r['uses'],'favorites':r['favorites'],'owner':r['nickname'] or '', 'mine':r['owner']==person,'favorite':r['id'] in favs,'chapters':len(sections),'phrases':len(json.loads(r['phrases'] or '[]'))})
 return out

def publish(db,person,data):
 template_id=data.get('template_id');ident=data.get('id')
 name=data.get('name','')
 rows=None;phrases=[]
 if template_id:
  row=db.execute('SELECT * FROM journal_templates WHERE person=? AND id=?',(person,template_id)).fetchone()
  if not row:raise JournalError('模板不存在',404)
  rows=json.loads(row['sections']);phrases=json.loads(row['phrases'] or '[]');name=name or row['name']
 if ident:
  row=db.execute('SELECT * FROM journal_public WHERE id=?',(ident,)).fetchone()
  if not row or row['owner']!=person:raise JournalError('公开模板不存在',404)
  if rows is None:rows=json.loads(row['sections']);phrases=json.loads(row['phrases'] or '[]')
  name=name or row['name']
 if rows is None:raise JournalError('请选择要发布的模板')
 content=sections(rows,True);phrase_texts=phrase_list(phrases)
 if not content:raise JournalError('公开模板至少需要一个章节')
 if not isinstance(name,str) or not 1<=len(name.strip())<=80:raise JournalError('模板名称需为 1 至 80 字')
 name=name.strip();summary=str(data.get('summary','') or '').strip()
 if len(summary)>200:raise JournalError('简介最多 200 字')
 symbol=str(data.get('symbol','') or '').strip()
 if len(symbol)>32:raise JournalError('品种最多 32 字')
 timeframe=str(data.get('timeframe','') or '').strip()
 if len(timeframe)>16:raise JournalError('周期最多 16 字')
 now=time.time()
 if ident:
  db.execute('UPDATE journal_public SET name=?,sections=?,phrases=?,summary=?,symbol=?,timeframe=?,version=version+1,updated=? WHERE id=?',(name,json.dumps(content,ensure_ascii=False),json.dumps(phrase_texts,ensure_ascii=False),summary,symbol,timeframe,now,ident))
  version=db.execute('SELECT version FROM journal_public WHERE id=?',(ident,)).fetchone()[0]
 else:
  if db.execute('SELECT count(*) FROM journal_public WHERE owner=? AND hidden=0',(person,)).fetchone()[0]>=20:raise JournalError('最多发布 20 个模板')
  ident=uuid.uuid4().hex;version=1
  db.execute('INSERT INTO journal_public(id,owner,name,sections,phrases,summary,symbol,timeframe,published,updated) VALUES(?,?,?,?,?,?,?,?,?,?)',(ident,person,name,json.dumps(content,ensure_ascii=False),json.dumps(phrase_texts,ensure_ascii=False),summary,symbol,timeframe,now,now))
 return {'ok':True,'id':ident,'version':version}

def unpublish(db,person,data):
 ident=data.get('id')
 row=db.execute('SELECT owner FROM journal_public WHERE id=?',(ident,)).fetchone() if isinstance(ident,str) else None
 if not row or row['owner']!=person:raise JournalError('公开模板不存在',404)
 db.execute('UPDATE journal_public SET hidden=1,updated=? WHERE id=?',(time.time(),ident))
 return {'ok':True}

def import_public(db,person,data):
 ident=data.get('id')
 row=db.execute('SELECT * FROM journal_public WHERE id=? AND hidden=0',(ident,)).fetchone() if isinstance(ident,str) else None
 if not row:raise JournalError('公开模板不存在',404)
 if row['owner']==person:raise JournalError('这是你自己的模板')
 base=row['name'];name=base;index=2
 while db.execute('SELECT 1 FROM journal_templates WHERE person=? AND name=?',(person,name)).fetchone():
  name='%s %d'%(base,index);index+=1
  if index>50:raise JournalError('同名模板太多，请先整理自己的模板')
 template=save_template(db,person,{'name':name,'sections':json.loads(row['sections']),'phrases':json.loads(row['phrases'] or '[]')})['template']
 db.execute('INSERT OR IGNORE INTO journal_public_refs(id,public_id,person,created) VALUES(?,?,?,?)',(uuid.uuid4().hex,ident,person,time.time()))
 db.execute('UPDATE journal_public SET uses=uses+1 WHERE id=?',(ident,))
 return {'ok':True,'template':template}

def favorite_public(db,person,data):
 ident=data.get('id')
 row=db.execute('SELECT 1 FROM journal_public WHERE id=? AND hidden=0',(ident,)).fetchone() if isinstance(ident,str) else None
 if not row:raise JournalError('公开模板不存在',404)
 on=bool(data.get('on',True))
 if on:db.execute('INSERT OR IGNORE INTO journal_public_favs(public_id,person,created) VALUES(?,?,?)',(ident,person,time.time()))
 else:db.execute('DELETE FROM journal_public_favs WHERE public_id=? AND person=?',(ident,person))
 count=db.execute('SELECT count(*) FROM journal_public_favs WHERE public_id=?',(ident,)).fetchone()[0]
 db.execute('UPDATE journal_public SET favorites=? WHERE id=?',(count,ident))
 return {'ok':True,'favorite':on,'favorites':count}

def library_item(db,person,data,remove=False):
 choices=[(key,table) for key,table in [('template_id','journal_templates'),('phrase_id','journal_phrases')] if key in data]
 if len(choices)!=1:raise JournalError('请指定一个模板或常用语')
 key,table=choices[0];ident=data[key]
 if not isinstance(ident,str) or not db.execute('SELECT 1 FROM '+table+' WHERE person=? AND id=?',(person,ident)).fetchone():raise JournalError('条目不存在',404)
 if remove:db.execute('DELETE FROM '+table+' WHERE person=? AND id=?',(person,ident))
 else:
  prior=db.execute('SELECT last_used FROM '+table+' WHERE person=? AND id=?',(person,ident)).fetchone()
  now=time.time()
  # 防刷：5 秒内重复点同一条不重复计数。
  if not prior or now-prior['last_used']>=5:db.execute('UPDATE '+table+' SET uses=uses+1,last_used=? WHERE person=? AND id=?',(now,person,ident))
 return {'ok':True}
