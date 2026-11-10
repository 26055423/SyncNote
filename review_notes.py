"""Independent review notes. Trades are optional links; old ticket URLs remain valid."""
import json,time,uuid
import bars,chart,journal,journal_templates
from http_errors import Error
from trade_time import utc_trade
from review_service import review_market_source

def dump(value):return json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'))

def available(db):
 return bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='review_notes'").fetchone())

def migrate(db):
 db.executescript('''CREATE TABLE review_notes(id TEXT PRIMARY KEY,person TEXT NOT NULL REFERENCES users(id),ticket TEXT,primary_ticket TEXT,body TEXT NOT NULL,tags TEXT NOT NULL,sections TEXT NOT NULL,scene TEXT NOT NULL,document TEXT,created REAL NOT NULL,updated REAL NOT NULL,UNIQUE(person,primary_ticket),FOREIGN KEY(person,ticket) REFERENCES trade_keys(person,ticket));
 CREATE INDEX review_notes_owner ON review_notes(person,updated DESC);''')
 rows=db.execute('SELECT person,ticket FROM trade_notes UNION SELECT person,ticket FROM chart_states').fetchall()
 for row in rows:
  if db.execute('SELECT 1 FROM trade_keys WHERE person=? AND ticket=?',tuple(row)).fetchone():ensure_trade(db,*row)

def get(db,person,ident):
 row=db.execute('SELECT * FROM review_notes WHERE person=? AND id=?',(person,str(ident))).fetchone()
 if not row:raise Error('笔记不存在',404)
 return {**dict(row),'tags':json.loads(row['tags']),'sections':json.loads(row['sections']),'scene':json.loads(row['scene']),'document':json.loads(row['document']) if row['document'] else None}

def ensure_trade(db,person,ticket):
 old=db.execute('SELECT id FROM review_notes WHERE person=? AND primary_ticket=?',(person,str(ticket))).fetchone()
 if old:return get(db,person,old['id'])
 review=journal.review(db,person,ticket,db.execute('SELECT * FROM broker_clocks WHERE person=?',(person,)).fetchone(),utc_trade)
 trade=review['trade']
 row=db.execute('SELECT n.*,s.sections FROM trade_notes n LEFT JOIN trade_note_sections s ON s.person=n.person AND s.ticket=n.ticket WHERE n.person=? AND n.ticket=?',(person,str(ticket))).fetchone()
 note={'body':row['body'],'tags':json.loads(row['tags']),'sections':json.loads(row['sections'] or '[]'),'updated':row['updated']} if row else {}
 saved=chart.state(db,person,ticket)
 anchor=int((review.get('opened') or trade.get('closed') or time.time())*1000)
 scene={'source':review_market_source(db,person,trade),'symbol':trade.get('symbol',''),'anchor_ms':anchor,'timeframe':'15','layout':'4','replay_ms':None}
 ident=uuid.uuid4().hex;now=note.get('updated') or (saved or {}).get('updated') or time.time()
 db.execute('INSERT INTO review_notes VALUES(?,?,?,?,?,?,?,?,?,?,?)',(ident,person,str(ticket),str(ticket),note.get('body',''),dump(note.get('tags',[])),dump(note.get('sections',[])),dump(scene),dump(saved['document']) if saved else None,now,now))
 return get(db,person,ident)

def sync_legacy(db,person,ticket,note=None,document=None,write_document=False):
 if not available(db):return
 saved=ensure_trade(db,person,ticket)
 if note is not None:db.execute('UPDATE review_notes SET body=?,tags=?,sections=?,updated=? WHERE id=?',(note['body'],dump(note['tags']),dump(note['sections']),note['updated'],saved['id']))
 if write_document:db.execute('UPDATE review_notes SET document=?,updated=? WHERE id=?',(dump(document) if document else None,time.time(),saved['id']))

def clean_scene(value,allow_unscoped=False):
 if not isinstance(value,dict):raise Error('请先打开一张历史图表')
 view=json.loads(chart.clean_snapshot(value))
 source=value.get('source');symbol=value.get('symbol')
 if not (allow_unscoped and source is None) and (not isinstance(source,str) or not 1<=len(source)<=200):raise Error('图表缺少行情轨道')
 if not isinstance(symbol,str) or not 1<=len(symbol)<=64:raise Error('图表缺少品种')
 if value.get('timeframe') not in ('1','5','15','30','60','240','1D'):raise Error('图表周期不正确')
 replay=value.get('replay_ms')
 if replay is not None and (isinstance(replay,bool) or not isinstance(replay,int) or not 0<replay<=chart.MAX_ANCHOR_MS):raise Error('回放进度不正确')
 cursor=value.get('replay_cursor_ms')
 if cursor is not None and (isinstance(cursor,bool) or not isinstance(cursor,int) or not 0<cursor<=chart.MAX_ANCHOR_MS or replay is None or cursor>=replay):raise Error('回放光标不正确')
 return {k:view.get(k) for k in ('anchor_ms','timeframe','layout','range')}|{'source':source,'symbol':symbol,'replay_ms':replay,'replay_cursor_ms':cursor}

def save(db,person,data):
 ident=data.get('id');old=get(db,person,ident) if ident else None
 ticket=data.get('ticket',old['ticket'] if old else None) or None
 if ticket is not None:
  ticket=str(ticket);journal.trade(db,person,ticket)
 body=data.get('body',old['body'] if old else '');tags=data.get('tags',old['tags'] if old else [])
 if not isinstance(body,str) or len(body)>10000:raise Error('笔记最多 10000 字')
 if not isinstance(tags,list) or len(tags)>12 or any(not isinstance(t,str) or not 1<=len(t.strip())<=40 for t in tags):raise Error('分类最多 12 个，每个不超过 40 字')
 sections=journal_templates.sections(data.get('sections',old['sections'] if old else []))
 scene=clean_scene(data['scene'],bool(old and old['primary_ticket'])) if 'scene' in data else old['scene'] if old else clean_scene(None)
 if ticket and ticket!=(old or {}).get('ticket') and journal.trade(db,person,ticket).get('symbol')!=scene['symbol']:raise Error('请选择当前品种的订单')
 document=data.get('document',old['document'] if old else None)
 if document is not None:chart.clean_snapshot({**scene,'document':document})
 if len(dump({'sections':sections,'document':document}).encode())>chart.MAX_STATE_BYTES:raise Error('笔记与画线过大',413)
 now=time.time();ident=ident or uuid.uuid4().hex
 db.execute('INSERT INTO review_notes VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ticket=excluded.ticket,body=excluded.body,tags=excluded.tags,sections=excluded.sections,scene=excluded.scene,document=excluded.document,updated=excluded.updated',(ident,person,ticket,old['primary_ticket'] if old else None,body.strip(),dump(list(dict.fromkeys(t.strip() for t in tags))),dump(sections),dump(scene),dump(document) if document else None,old['created'] if old else now,now))
 if old and old['primary_ticket']:
  journal.save(db,person,{'ticket':old['primary_ticket'],'body':body,'tags':tags,'sections':sections})
  if document is not None:chart.save_state(db,person,old['primary_ticket'],document)
  elif 'document' in data:chart.clear_state(db,person,old['primary_ticket'])
 return {'ok':True,'note':get(db,person,ident)}

def listing(db,person,q):
 query=str(q.get('q',[''])[0])[:100]
 try:offset=max(0,int(q.get('offset',['0'])[0]))
 except ValueError:raise Error('分页不正确')
 rows=db.execute('SELECT id,ticket,body,sections,scene,updated FROM review_notes WHERE person=? AND (body LIKE ? OR sections LIKE ? OR scene LIKE ?) ORDER BY updated DESC,id LIMIT 51 OFFSET ?',(person,*(['%'+query+'%']*3),offset)).fetchall()
 items=[]
 for row in rows[:50]:
  scene=json.loads(row['scene']);sections=json.loads(row['sections'])
  items.append({'id':row['id'],'ticket':row['ticket'],'title':(row['body'] or next((s.get('body') or s.get('title') for s in sections if s.get('body') or s.get('title')),''))[:80],'scene':scene,'updated':row['updated']})
 return {'items':items,'has_more':len(rows)>50}

def resolve(db,uid,q):
 share=q.get('share',[''])[0]
 if share:
  if not share.isdigit():raise Error('消息不存在',404)
  row=chart.share_row(db,uid,int(share));view=chart.share_view(row) or {};note=view.get('note')
  if isinstance(note,dict) and note.get('id') and note.get('scene'):
   return {**note,'person':row['owner'],'document':view.get('document')},row
  return None,None
 ident=q.get('note',[''])[0]
 return (get(db,uid,ident),None) if ident else (None,None)

def entry(db,uid,note,row=None):
 owner=db.execute('SELECT * FROM users WHERE id=?',(note['person'],)).fetchone()
 scene=note['scene'];trade={};charts={};opened=None
 if note.get('ticket'):
  review=journal.review(db,note['person'],note['ticket'],db.execute('SELECT * FROM broker_clocks WHERE person=?',(note['person'],)).fetchone(),utc_trade)
  trade=note.get('trade_snapshot',review['trade']);charts=review['charts'];opened=review.get('opened')
 cutoff=scene.get('replay_ms')
 if cutoff and row:charts={tf:[b for b in rows if b[0]+bars.TF_SECONDS.get(tf,60)<=cutoff/1000] for tf,rows in charts.items()}
 return {'mode':'shared' if row else 'owner','owner':{'id':owner['id'],'name':owner['nickname'],'avatar':owner['avatar']},'read_only':bool(row),'note_id':note['id'],'scene':scene,'share':{'id':row['id'],'message':row['message'],'created':row['created'],'seen':bool(row['seen']),**scene} if row else None,'note':{k:note[k] for k in ('body','tags','sections','updated')},'chart':{'document':note['document'],'updated':note['updated']},'review':{'status':'ready','trade':{**trade,'symbol':scene['symbol']},'charts':charts,'errors':{},'opened':opened,'market_source':scene['source']},'bar_offset':0}

def freeze(db,person,data):
 note=get(db,person,data.get('note_id'))
 # The dialog supplies its frozen editor content; validate without changing the saved note.
 content=data.get('note')
 if content is not None:
  if not isinstance(content,dict):raise Error('笔记格式不正确')
  body=content.get('body','');tags=content.get('tags',[])
  if not isinstance(body,str) or len(body)>10000 or not isinstance(tags,list) or len(tags)>12 or any(not isinstance(t,str) or len(t)>40 for t in tags):raise Error('笔记格式不正确')
  note={**note,'body':body,'tags':tags,'sections':journal_templates.sections(content.get('sections',[]))}
 snapshot=data.get('snapshot')
 if snapshot is not None:
  scene=clean_scene({**note['scene'],**snapshot},bool(note.get('primary_ticket')))
  if (scene['source'],scene['symbol'])!=(note['scene']['source'],note['scene']['symbol']):raise Error('分享图表与笔记不一致')
  note={**note,'scene':scene,'document':snapshot.get('document')}
 if note.get('ticket'):note['trade_snapshot']=utc_trade(journal.trade(db,person,note['ticket']),db.execute('SELECT * FROM broker_clocks WHERE person=?',(person,)).fetchone())
 snapshot={**note['scene'],'document':note['document']}
 return note,snapshot

def share(db,person,data):
 from social import can_chat
 recipients=data.get('recipients')
 if not isinstance(recipients,list) or any(not isinstance(uid,str) or not can_chat(db,person,uid) for uid in recipients):raise Error('只能分享给可聊天的好友',403)
 note,snapshot=freeze(db,person,data)
 return chart.share(db,person,note.get('ticket') or '',data.get('recipients'),data.get('message',''),snapshot,note)

def share_group(db,person,data):
 import groups
 gid=str(data.get('group',''));groups.require_member(db,gid,person)
 note,snapshot=freeze(db,person,data);message=data.get('message','')
 if not isinstance(message,str) or len(message)>chart.MAX_MESSAGE:raise Error('留言最多 500 字')
 now=time.time();ticket=note.get('ticket') or '';raw=chart.clean_snapshot(snapshot)
 sid=chart.create_snapshot(db,person,ticket,message,raw,dump(note),gid,now)
 mid=db.execute("INSERT INTO group_messages(group_id,person,kind,text,ticket,created,snapshot,note_snapshot,review_snapshot_id) VALUES(?,?,'trade',?,?,?,?,?,?)",(gid,person,message,ticket,now,raw,dump(note),sid)).lastrowid
 recipients=[r[0] for r in db.execute('SELECT user_id FROM group_members WHERE group_id=? AND user_id<>?',(gid,person))]
 for recipient in recipients:chart.deliver(db,sid,recipient)
 groups._touch(db,gid,person,now)
 return {'id':mid,'created':now,'sent':len(recipients)}
