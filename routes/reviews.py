"""Reviews HTTP endpoints."""
import time
import bars,chart,journal,review_notes
from social import visible
from review_service import review_market_source
from trade_time import utc_trade
from http_errors import Error

def get_chart_entry(self,db,u,q):
 uid=u['id']
 independent,delivery=review_notes.resolve(db,uid,q)
 if independent:return self.reply(review_notes.entry(db,uid,independent,delivery))
 ticket=str(q.get('ticket',[''])[0]);target=q.get('person',[uid])[0];share=q.get('share',[''])[0]
 row=None
 if share:
  if not share.isdigit():raise Error('消息不存在，或不是发给你的',404)
  row=chart.share_row(db,uid,int(share));target=row['owner'];ticket=row['ticket']
 owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
 if not owner:raise Error('用户不存在',404)
 if not row and target!=uid and not (visible(db,uid,target) and owner['share_reviews']):raise Error('对方未分享复盘，或你们还不是好友',403)
 review=journal.review(db,target,ticket,db.execute('SELECT * FROM broker_clocks WHERE person=?',(target,)).fetchone(),utc_trade)
 note=journal.notes(db,target)['notes'].get(str(ticket)) if (target==uid or row or owner['share_reviews']) else None
 # 分享切片优先：收件人看到的是分享人当时那个窗口，而不是他后来改过的存档。
 view=chart.share_view(row) if row else None
 # 分享时冻结的笔记优先：收件人看到的是分享当时的内容。
 if row:note=(view or {}).get('note')
 stored=chart.state(db,target,str(ticket))
 if row:
  stored={'document':view['document'],'updated':row['created'],'source':'share'} if view and view.get('document') else None
 share_info=({'id':row['id'],'message':row['message'],'created':row['created'],'seen':bool(row['seen']),
    'anchor_ms':(view or {}).get('anchor_ms'),'timeframe':(view or {}).get('timeframe'),'layout':(view or {}).get('layout')} if row else None)
 # bars 里存的是券商墙钟，交易/复盘时间戳是 UTC：把偏移一起给前端，标注才能压准 K 线。
 clock_row=db.execute('SELECT offset FROM broker_clocks WHERE person=?',(target,)).fetchone()
 bar_offset=int(clock_row['offset']) if clock_row and isinstance(clock_row['offset'],(int,float)) else 0
 review['market_source']=review_market_source(db,target,review['trade'])
 independent=review_notes.ensure_trade(db,uid,ticket) if not row and target==uid else None
 if independent and independent['ticket']!=str(ticket):return self.reply(review_notes.entry(db,uid,independent))
 return self.reply({'note_id':independent['id'] if independent else None,'scene':independent['scene'] if independent else None,'mode':'shared' if row else 'owner' if target==uid else 'viewer','owner':{'id':owner['id'],'name':owner['nickname'],'avatar':owner['avatar']},'read_only':target!=uid,'share':share_info,'review':review,'note':note,'chart':stored,'bar_offset':bar_offset})

def get_chart_bars(self,db,u,q):
 uid=u['id']
 # 一笔交易 = 一个 feed = 一个 source；只返回该 source 的 K 线，
 # 缺口原样返回（前端留白/提示），绝不拿别的 source 补。
 ticket=str(q.get('ticket',[''])[0]);target=q.get('person',[uid])[0];share=q.get('share',[''])[0]
 row=None
 if share:
  if not share.isdigit():raise Error('消息不存在，或不是发给你的',404)
  row=chart.share_row(db,uid,int(share));target=row['owner'];ticket=row['ticket']
 owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
 if not owner:raise Error('用户不存在',404)
 if not row and target!=uid and not (visible(db,uid,target) and owner['share_reviews']):raise Error('对方未分享复盘，或你们还不是好友',403)
 independent,delivery=review_notes.resolve(db,uid,q)
 trade=({'symbol':independent['scene']['symbol']} if independent else journal.trade(db,target,ticket))
 source=independent['scene']['source'] if independent else review_market_source(db,target,trade)
 read_now=min(time.time(),independent['scene']['replay_ms']/1000) if delivery and independent and independent['scene'].get('replay_ms') else time.time()
 if not source:raise Error('这笔交易没有行情来源，暂时只能看复盘快照',404)
 symbol=str(trade.get('symbol') or '');tf=q.get('tf',['M15'])[0]
 counted=bool(q.get('limit'))
 if q.get('before') and q.get('after'):raise Error('只能指定一个翻页方向')
 if (q.get('before') or q.get('after')) and not counted:raise Error('翻页需指定 limit')
 if counted:
  try:
   limit=int(q['limit'][0]);before=int(q['before'][0]) if q.get('before') else None;after=int(q['after'][0]) if q.get('after') else None
  except ValueError:raise Error('根数或翻页时间不正确')
  if limit<1 or any(cursor is not None and not 1<=cursor<=32535215999 for cursor in (before,after)):raise Error('根数或翻页时间不正确')
  try:
   payload=bars.following_utc(db,source,symbol,tf,after,limit,read_now) if after is not None else bars.latest_utc(db,source,symbol,tf,limit,read_now,before)
  except bars.BarsError as error:raise Error(error.text,error.code)
 else:
  try:
   start=int(q.get('from',['0'])[0]);end=int(q.get('to',['0'])[0])
  except ValueError:raise Error('时间范围不正确')
  if end<=start:raise Error('时间范围不正确')
  try:payload=bars.read_utc(db,source,symbol,tf,start,end,read_now)
  except bars.BarsError as error:raise Error(error.text,error.code)
 feed=db.execute('SELECT server,account FROM feeds WHERE source=? LIMIT 1',(source,)).fetchone()
 payload['feed']={'source':source,'server':(feed['server'] if feed else ''),'account':(feed['account'] if feed and not independent else '')}
 payload['symbol_label']=str(trade.get('symbol') or '')
 return self.reply(payload)

def get_chart_tracks(self,db,u,q):
 uid=u['id']
 # 视频编辑软件式的“轨道”：一个券商服务器一条轨。
 ticket=str(q.get('ticket',[''])[0]);target=q.get('person',[uid])[0];share=q.get('share',[''])[0]
 row=None
 if share:
  if not share.isdigit():raise Error('消息不存在，或不是发给你的',404)
  row=chart.share_row(db,uid,int(share));target=row['owner'];ticket=row['ticket']
 owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
 if not owner:raise Error('用户不存在',404)
 if not row and target!=uid and not (visible(db,uid,target) and owner['share_reviews']):raise Error('对方未分享复盘，或你们还不是好友',403)
 independent,delivery=review_notes.resolve(db,uid,q)
 trade={'symbol':independent['scene']['symbol']} if independent else journal.trade(db,target,ticket)
 source=independent['scene']['source'] if independent else bars.source_of_trade(trade)
 if not source:
  feed=bars.feed_of(db,target)
  source=feed['source'] if feed else None
 try:
  start=int(q.get('from',['0'])[0]);end=int(q.get('to',['0'])[0])
 except ValueError:raise Error('时间范围不正确')
 if end<=start:raise Error('时间范围不正确')
 payload=bars.tracks_utc(db,str(trade.get('symbol') or ''),source,start,end)
 payload['active_source']=source
 return self.reply(payload)

def get_reviews_inbox(self,db,u,q):
 uid=u['id']
 return self.reply(chart.inbox(db,uid))

def get_journal(self,db,u,q):
 uid=u['id']
 target=q.get('person',[uid])[0];owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone();can=bool(owner and visible(db,uid,target) and (target==uid or owner['share_reviews']))
 return self.reply({**(journal.notes(db,target) if can else {'categories':journal.DEFAULT_TAGS,'notes':{}}),'can_view':can,'editable':target==uid})

def get_journal_library(self,db,u,q):
 uid=u['id']
 return self.reply(journal.journal_templates.library(db,uid))

def get_journal_chapters(self,db,u,q):
 uid=u['id']
 return self.reply(journal.journal_templates.public_chapters(db,q.get('limit',['60'])[0]))

def get_journal_stats(self,db,u,q):
 uid=u['id']
 return self.reply(journal.journal_templates.stats(db,uid))

def get_trade_review(self,db,u,q):
 uid=u['id']
 target=q.get('person',[uid])[0];owner=db.execute('SELECT * FROM users WHERE id=?',(target,)).fetchone()
 if not owner or not visible(db,uid,target) or (target!=uid and not owner['share_reviews']):raise Error('对方未分享复盘，或你们还不是好友',403)
 return self.reply(journal.review(db,target,q.get('ticket',[''])[0],db.execute('SELECT * FROM broker_clocks WHERE person=?',(target,)).fetchone(),utc_trade))

def get_notes(self,db,u,q):
 return self.reply(review_notes.listing(db,u['id'],q))

GET={'/api/notes':get_notes,'/api/chart/entry':get_chart_entry,'/api/chart/bars':get_chart_bars,'/api/chart/tracks':get_chart_tracks,'/api/reviews/inbox':get_reviews_inbox,'/api/journal':get_journal,'/api/journal/library':get_journal_library,'/api/journal/chapters':get_journal_chapters,'/api/journal/stats':get_journal_stats,'/api/trade-review':get_trade_review}
