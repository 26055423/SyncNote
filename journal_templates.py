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
''')
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

def public_chapters(db,limit=60,min_users=1):
 """全服章节词云：只回标题、分组、人数与使用笔数，不带任何用户或交易信息。"""
 rows=db.execute('SELECT s.person,s.ticket,s.sections FROM trade_note_sections s JOIN trade_notes n ON n.person=s.person AND n.ticket=s.ticket').fetchall()
 used=set();titles={}
 for row in rows:
  try:sections=json.loads(row['sections'])
  except (TypeError,ValueError):continue
  person=row['person'];ticket=row['ticket']
  for section in sections:
   title=str(section.get('title','')).strip()
   if not title:continue
   if not (section.get('checked') or str(section.get('body','')).strip()):continue
   entry=titles.setdefault(title,{'title':title,'users':set(),'uses':0,'groups':{}})
   entry['users'].add(person)
   if (person,ticket,title) not in used:
    used.add((person,ticket,title));entry['uses']+=1
   group=str(section.get('group') or '').strip()
   if group:entry['groups'][group]=entry['groups'].get(group,0)+1
 out=[]
 for entry in titles.values():
  users=len(entry['users'])
  if users<min_users:continue
  group=max(entry['groups'],key=entry['groups'].get) if entry['groups'] else None
  out.append({'title':entry['title'],'users':users,'uses':entry['uses'],'group':group})
 out.sort(key=lambda item:(-item['users'],-item['uses'],item['title']))
 return {'chapters':out[:max(1,min(int(limit or 60),100))],'total':len(out)}

def stats(db,person):
 """个人复盘统计：完成率、结论分布、最常跳过的检查项。只算真正保存过的复盘。"""
 rows=db.execute('SELECT s.sections FROM trade_note_sections s JOIN trade_notes n ON n.person=s.person AND n.ticket=s.ticket WHERE s.person=?',(person,)).fetchall()
 counts={};notes=0;verdicts={'yes':0,'no':0,'unclear':0,'na':0}
 for row in rows:
  try:sections=json.loads(row['sections'])
  except (TypeError,ValueError):continue
  meaningful=[s for s in sections if s.get('checked') or str(s.get('body','')).strip()]
  if not meaningful:continue
  notes+=1
  for section in meaningful:
   title=str(section.get('title','')).strip() or '未命名'
   entry=counts.setdefault(title,{'title':title,'total':0,'checked':0,'yes':0,'no':0,'unclear':0,'na':0})
   entry['total']+=1
   if section.get('checked'):entry['checked']+=1
   verdict=section.get('verdict')
   if verdict in verdicts:
    entry[verdict]+=1;verdicts[verdict]+=1
 titles=sorted(counts.values(),key=lambda item:(-item['total'],item['title']))[:50]
 skipped=[item for item in counts.values() if item['total']>=2]
 skipped=sorted(skipped,key=lambda item:(item['checked']/item['total'],-item['total'],item['title']))[:5]
 for item in titles+skipped:
  item['rate']=round(item['checked']/item['total'],3) if item['total'] else 0
 return {'notes':notes,'titles':titles,'skipped':skipped,'verdicts':verdicts}

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
