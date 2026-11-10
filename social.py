"""Friendship and visibility policy shared by domain routes."""

def friend_pair(x,y):
 """好友关系用无序对存：字典序小的当 a，保证 (A,B) 只有一行。"""
 return (x,y) if x<y else (y,x)

def friend_edge(db,x,y):
 a,b=friend_pair(x,y)
 return db.execute('SELECT * FROM friend_edges WHERE a=? AND b=?',(a,b)).fetchone()

def edge_state(db,uid,target):
 """从 uid 视角看这条关系：微信式的单向状态位。没有关系返回 None。"""
 row=friend_edge(db,uid,target)
 if not row:return None
 side='a' if row['a']==uid else 'b'
 other='b' if side=='a' else 'a'
 return {'status':row['status'],'requested_by':row['requested_by'],
   'i_deleted':bool(row[side+'_deleted']),'they_deleted':bool(row[other+'_deleted']),
   'i_blocked':bool(row[side+'_blocked']),'they_blocked':bool(row[other+'_blocked']),
   'i_hide':bool(row[side+'_hide']),'they_hide':bool(row[other+'_hide']),
   'i_mute':bool(row[side+'_mute']),'they_mute':bool(row[other+'_mute'])}

def are_friends(db,x,y):
 """是否还是「好友」：已通过，且双方都没删、没拉黑。"""
 if x==y:return True
 st=edge_state(db,x,y)
 if not st or st['status']!='accepted':return False
 return not (st['i_deleted'] or st['they_deleted'] or st['i_blocked'] or st['they_blocked'])

def can_chat(db,x,y):
 """能不能收发消息：好友 + 没删 + 没拉黑。"""
 return are_friends(db,x,y)

def relation(db,uid,target):
 """none / friend / incoming / outgoing / blocked（我拉黑）/ blocked_me / self。"""
 if uid==target:return 'self'
 st=edge_state(db,uid,target)
 if not st:return 'none'
 if st['i_blocked']:return 'blocked'
 if st['they_blocked']:return 'blocked_me'
 if st['status']=='pending':
  return 'outgoing' if st['requested_by']==uid else 'incoming'
 if st['status']=='accepted':
  if st['i_deleted']:return 'deleted'
  if st['they_deleted']:return 'deleted_me'
  return 'friend'
 return 'none'

def friends_of(db,uid):
 """我的好友列表：微信式——只按「我这侧」的删除/拉黑过滤。

 对方删了我，我这一侧还看得到他（和他的头像），但内容与消息都不可用；
 我删了对方，我自己列表里就没了。
 """
 return db.execute("SELECT u.* FROM friend_edges f JOIN users u ON u.id=CASE WHEN f.a=? THEN f.b ELSE f.a END WHERE (f.a=? OR f.b=?) AND f.status='accepted' AND (CASE WHEN f.a=? THEN f.a_deleted ELSE f.b_deleted END)=0 AND (CASE WHEN f.a=? THEN f.a_blocked ELSE f.b_blocked END)=0 ORDER BY f.decided DESC",(uid,uid,uid,uid,uid)).fetchall()

def blocked_of(db,uid):
 """我拉黑的人。"""
 return db.execute("SELECT u.* FROM friend_edges f JOIN users u ON u.id=CASE WHEN f.a=? THEN f.b ELSE f.a END WHERE (f.a=? OR f.b=?) AND ((f.a=? AND f.a_blocked=1) OR (f.b=? AND f.b_blocked=1)) ORDER BY f.decided DESC",(uid,uid,uid,uid,uid)).fetchall()

def friend_requests(db,uid):
 """待通过的申请：(incoming, outgoing)。被对方拉黑/申请方已删的不再展示。"""
 incoming=[];outgoing=[]
 rows=db.execute("SELECT f.*,CASE WHEN f.a=? THEN f.b ELSE f.a END AS other FROM friend_edges f WHERE f.status='pending' AND (f.a=? OR f.b=?)",(uid,uid,uid)).fetchall()
 for r in rows:
  other=r['other']
  st=edge_state(db,uid,other)
  if not st:continue
  if st['i_blocked'] or st['they_blocked']:continue
  u=db.execute('SELECT * FROM users WHERE id=?',(other,)).fetchone()
  if not u:continue
  item={k:u[k] for k in u.keys()};item['asked']=r['created']
  if r['requested_by']==uid:outgoing.append(item)
  else:incoming.append(item)
 return incoming,outgoing

def migrate_friends(db):
 """老 follows 关系搬进 friend_edges：互关→好友，单向→待对方通过。幂等。"""
 rows=db.execute('SELECT follower,target,created FROM follows').fetchall()
 pairs={}
 for r in rows:pairs.setdefault(friend_pair(r['follower'],r['target']),[]).append((r['follower'],r['created']))
 moved=0
 for (a,b),edges in pairs.items():
  if db.execute('SELECT 1 FROM friend_edges WHERE a=? AND b=?',(a,b)).fetchone():continue
  mutual=len(edges)>=2
  stamp=min(e[1] for e in edges)
  db.execute('INSERT INTO friend_edges(a,b,status,requested_by,created,decided) VALUES(?,?,?,?,?,?)',
    (a,b,'accepted' if mutual else 'pending',edges[0][0],stamp,stamp if mutual else None))
  moved+=1
 return moved

def visible(db,uid,target):
 """能不能看对方的交易数据：本人，或好友且没删没拉黑、对方开了分享、且对方没对我隐藏。"""
 if uid==target:return True
 if not are_friends(db,uid,target):return False
 st=edge_state(db,uid,target)
 if st['they_hide']:return False
 row=db.execute('SELECT share_data FROM users WHERE id=?',(target,)).fetchone()
 return bool(row and row['share_data'])

def review_visible(db,uid,target):
 """复盘可见性：在 visible 的基础上再加对方「分享复盘」开关。"""
 if uid==target:return True
 if not visible(db,uid,target):return False
 row=db.execute('SELECT share_reviews FROM users WHERE id=?',(target,)).fetchone()
 return bool(row and row['share_reviews'])
