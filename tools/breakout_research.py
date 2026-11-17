"""Read-only native-bar breakout experiment; standard library only."""
import argparse
import bisect
import collections
import datetime as dt
import html
import json
import math
from pathlib import Path
import sqlite3
import sys
import time

LABELS = ('continue', 'fail', 'unresolved')
FEATURES = ('penetration', 'speed', 'efficiency', 'wick', 'width', 'h4_trend', 'd1_trend')

def stamp(t):
 return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat()

def atr(rows, count=14):
 if len(rows) < count+1:
  return None
 return sum(max(b[2]-b[3],abs(b[2]-a[4]),abs(b[3]-a[4])) for a,b in zip(rows[-count-1:-1],rows[-count:]))/count

def first_touch(rows, boundary, direction, scale, reward=1., failure=.5):
 for row in rows:
  high = direction*((row[2] if direction==1 else row[3])-boundary)
  low = direction*((row[3] if direction==1 else row[2])-boundary)
  win,lose = high>=reward*scale, low<=-failure*scale
  if win and lose:
   return 'ambiguous',row[0]+60
  if win or lose:
   return ('continue' if win else 'fail'),row[0]+60
 return 'unresolved',rows[-1][0]+60

def probabilities(logits):
 values = [math.exp(v-max(logits)) for v in logits]
 return [v/sum(values) for v in values]

def fit(train, epochs=35):
 n,d = len(train),len(train[0]['x'])
 means = [sum(e['x'][j] for e in train)/n for j in range(d)]
 scales = [max(1e-6,math.sqrt(sum((e['x'][j]-means[j])**2 for e in train)/n)) for j in range(d)]
 xs = [[1.]+[max(-8.,min(8.,(e['x'][j]-means[j])/scales[j])) for j in range(d)] for e in train]
 counts = collections.Counter(e['label'] for e in train)
 weights = [[math.log((counts[k]+1)/(n+3))]+[0.]*d for k in LABELS]
 for _ in range(epochs):
  gradients = [[0.]*(d+1) for _ in LABELS]
  for e,x in zip(train,xs):
   ps = probabilities([sum(a*b for a,b in zip(w,x)) for w in weights])
   for k in range(3):
    error = ps[k]-(e['label']==LABELS[k])
    for j in range(d+1):
     gradients[k][j] += error*x[j]
  for k in range(3):
   for j in range(d+1):
    weights[k][j] -= .3*(gradients[k][j]/n+(.02*weights[k][j] if j else 0.))
 return means,scales,weights

def predict(model, values):
 means,scales,weights = model
 x = [1.]+[max(-8.,min(8.,(v-m)/s)) for v,m,s in zip(values,means,scales)]
 return probabilities([sum(a*b for a,b in zip(w,x)) for w in weights])

def prior(events):
 counts = collections.Counter(e['label'] for e in events)
 return [(counts[k]+1)/(len(events)+3) for k in LABELS]

def metrics(pairs):
 if not pairs:
  return None
 bins = []
 for i in range(5):
  group = [(y,p) for y,p in pairs if i/5<=p[0]<(i+1)/5 or (i==4 and p[0]==1)]
  if group:
   bins.append({'range':[i/5,(i+1)/5],'n':len(group),'predicted':sum(p[0] for _,p in group)/len(group),'observed':sum(y=='continue' for y,_ in group)/len(group)})
 return {'n':len(pairs),'log_loss':sum(-math.log(max(1e-12,p[LABELS.index(y)])) for y,p in pairs)/len(pairs),'brier':sum(sum((v-(y==k))**2 for k,v in zip(LABELS,p)) for y,p in pairs)/len(pairs),'continuation_calibration':bins}

def evaluate(events):
 years = sorted({dt.datetime.fromtimestamp(e['decision'],dt.timezone.utc).year for e in events})
 pooled = {k:[] for k in ('model','average','trend')}
 folds = []
 for year in years[2:]:
  start = int(dt.datetime(year,1,1,tzinfo=dt.timezone.utc).timestamp())
  end = int(dt.datetime(year+1,1,1,tzinfo=dt.timezone.utc).timestamp())
  train = [e for e in events if e['end']<start-21600]
  test = [e for e in events if start<=e['decision']<end]
  if len(train)<100 or len(test)<20:
   continue
  model,average = fit(train),prior(train)
  trend = {flag:prior([e for e in train if (e['x'][5]>0)==flag]) for flag in (False,True)}
  fold = {k:[] for k in pooled}
  for e in test:
   for name,p in [('model',predict(model,e['x'])),('average',average),('trend',trend[e['x'][5]>0])]:
    pair = (e['label'],p)
    fold[name].append(pair)
    pooled[name].append(pair)
  folds.append({'year':year,'train':len(train),'test':len(test),'metrics':{k:metrics(v) for k,v in fold.items()}})
 return {'folds':folds,'pooled':{k:metrics(v) for k,v in pooled.items()}}

def extract(db, source, symbol, repo, now=None):
 sys.path.insert(0,str(repo))
 import bars
 import trade_time
 now = int(time.time() if now is None else now)
 offset = trade_time.offset_for(db,source)
 series,times = {},{}
 for tf in ('M5','H1','H4','D1'):
  wall = [list(r) for r in db.execute('SELECT t,o,h,l,c FROM bars WHERE source=? AND symbol=? AND tf=? ORDER BY t',(source,symbol,tf))]
  rows = bars.to_utc({'bars':wall},offset)['bars']
  series[tf] = [r for r in rows if r[0]+bars.TF_SECONDS[tf]<=now]
  times[tf] = [r[0]+bars.TF_SECONDS[tf] for r in series[tf]]
 stats = collections.Counter()
 events,free_after = [],0
 m5 = series['M5']
 for i in range(15,len(m5)):
  row = m5[i]
  decision = row[0]+300
  if decision<free_after:
   continue
  h = bisect.bisect_right(times['H1'],row[0])
  history = series['H1'][max(0,h-25):h]
  if len(history)<25 or history[-1][0]+3600<row[0]-3600:
   continue
  up,down = max(r[2] for r in history[-24:]),min(r[3] for r in history[-24:])
  previous = m5[i-1][4]
  direction = 1 if previous<=up<row[4] else -1 if previous>=down>row[4] else 0
  if not direction:
   continue
  stats['candidates'] += 1
  scale,small = atr(history),atr(m5[i-15:i])
  if not scale or not small or any(m5[j][0]-m5[j-1][0]!=300 for j in range(i-14,i+1)):
   stats['missing_context'] += 1
   continue
  background = []
  for tf in ('H4','D1'):
   j = bisect.bisect_right(times[tf],decision)
   past = series[tf][max(0,j-15):j]
   a = atr(past)
   if not a or decision-times[tf][j-1]>4*86400:
    break
   background.append(direction*(past[-1][4]-past[-4][4])/a)
  if len(background)!=2:
   stats['missing_context'] += 1
   continue
  boundary = up if direction==1 else down
  wall = [list(r) for r in db.execute("SELECT t,o,h,l,c FROM bars WHERE source=? AND symbol=? AND tf='M1' AND t>=? AND t<? ORDER BY t",(source,symbol,decision+offset,decision+21600+offset))]
  minutes = bars.to_utc({'bars':wall},offset)['bars']
  free_after = decision+21600
  if len(minutes)!=360 or any(r[0]!=decision+j*60 for j,r in enumerate(minutes)) or decision+21600>now:
   stats['missing_outcome'] += 1
   continue
  travel = sum(abs(m5[j][4]-m5[j-1][4]) for j in range(i-2,i+1))
  x = [direction*(row[4]-boundary)/scale,direction*(row[4]-m5[i-3][4])/(3*small),abs(row[4]-m5[i-3][4])/max(travel,1e-12),((row[2]-row[4]) if direction==1 else (row[4]-row[3]))/max(row[2]-row[3],1e-12),(up-down)/scale]+background
  event = {'decision':decision,'end':decision+21600,'direction':direction,'x':x,'outcomes':{},'updates':{}}
  after = m5[i+1:i+4]
  valid_update = len(after)==3 and all(r[0]==decision+j*300 for j,r in enumerate(after))
  for name,reward,failure in [('main',1.,.5),('near',.8,.4),('far',1.2,.6)]:
   label,touched = first_touch(minutes,boundary,direction,scale,reward,failure)
   # M5 confirmation is delayed: exclude targets touched within that candle.
   if direction*((row[2] if direction==1 else row[3])-boundary)>=reward*scale:
    label = 'already_resolved'
   event['outcomes'][name] = label
   if valid_update and label in LABELS and touched>decision+900:
    penetration = direction*(after[-1][4]-boundary)/scale
    adverse = min(direction*((r[3] if direction==1 else r[2])-boundary)/scale for r in after)
    outside = sum(direction*(r[4]-boundary)>0 for r in after)/3
    event['updates'][name] = x+[penetration,adverse,outside]
  events.append(event)
 stats['complete_windows'] = len(events)
 return events,{'source':source,'symbol':symbol,'time_basis':'UTC','offset_seconds':offset,'as_of':stamp(now),'series':{tf:{'rows':len(v),'first':stamp(v[0][0]) if v else None,'last':stamp(v[-1][0]) if v else None} for tf,v in series.items()},'exclusions':dict(stats)}

def research(db, source, symbol, repo):
 events,info = extract(db,source,symbol,repo)
 return from_events(events,info)

def from_events(events, info):
 results = {}
 for name in ('main','near','far'):
  initial,updated,excluded = [],[],collections.Counter()
  for e in events:
   label = e['outcomes'][name]
   if label not in LABELS:
    excluded[label] += 1
    continue
   initial.append(dict(e,label=label))
   if name in e['updates']:
    updated.append(dict(e,label=label,decision=e['decision']+900,x=e['updates'][name]))
  survivor_times = {e['decision']-900 for e in updated}
  matched = [e for e in initial if e['decision'] in survivor_times]
  results[name] = {'counts':dict(collections.Counter(e['label'] for e in initial)),'excluded':dict(excluded),'initial':evaluate(initial),'survivors_initial':evaluate(matched),'after_15m':evaluate(updated)}
 return {'schema':'syncnote-breakout-research.v1','data':info,'features':list(FEATURES),'update_features':['penetration_15m','worst_excursion_15m','outside_close_fraction_15m'],'method':{'boundary':'previous 24 closed H1, frozen at confirmation M5 open','decision':'M5 close','horizon_seconds':21600,'atr':'14-period arithmetic mean true range; frozen per event','training':'expanding annual window, 6h embargo; train-only scaling and clipping; 35 full-batch steps, learning rate 0.3, L2 0.02','calibration':'out-of-sample bins only, no recalibration','selection':'6h nonoverlap, complete M1 windows; same-minute double touch and pre-confirmation target touch excluded','survivor_comparison':'both survivor models train on historical 15m survivors; initial features alone versus initial plus update features, evaluated at 15m','costs':'not modeled'},'results':results}

def render(report):
 root = Path(__file__).resolve().parents[1]
 css = (root/'web/chart-src/src/styles.css').read_text(encoding='utf-8')
 tokens = ':root {'+css.split(':root {',1)[1].split('}',1)[0]+'}'
 styles = tokens+'body{background:var(--bg);color:var(--text);font:16px/1.7 system-ui;margin:32px auto;padding:0 20px;max-width:1100px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid var(--line);padding:8px;text-align:left}th,details{background:var(--panel)}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;padding:12px}svg{width:100%;height:auto;max-width:600px}svg text{fill:var(--dim);font-size:13px}h2{margin-top:32px}'
 charts = []
 for stage,title in [('initial','刚突破'),('after_15m','15 分钟后仍未结束')]:
  m = report['results']['main'][stage]['pooled']['model']
  if not m:
   continue
  svg = '<svg viewBox="0 0 440 290" role="img" aria-label="预测延续概率与实际延续比例"><line x1="40" y1="250" x2="280" y2="10" stroke="var(--line-strong)"/>'
  for i in range(6):
   x,y = 40+48*i,250-48*i
   svg += '<text x="'+str(x)+'" y="272">'+str(i*20)+'%</text><text x="0" y="'+str(y)+'">'+str(i*20)+'%</text>'
  for b in m['continuation_calibration']:
   x,y = 40+240*b['predicted'],250-240*b['observed']
   svg += '<circle cx="'+str(x)+'" cy="'+str(y)+'" r="5" fill="var(--accent)"><title>样本 '+str(b['n'])+'；预测 '+str(round(b['predicted']*100,1))+'%；实际 '+str(round(b['observed']*100,1))+'%</title></circle>'
  charts.append('<h3>'+title+'</h3>'+svg+'<text x="300" y="150">纵轴：实际比例</text><text x="300" y="175">横轴：预测概率</text></svg>')
 rows = []
 for case,result in report['results'].items():
  for stage in ('initial','survivors_initial','after_15m'):
   for name,m in result[stage]['pooled'].items():
    if m:
     rows.append('<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in (case,stage,name,m['n'],round(m['log_loss'],4),round(m['brier'],4)))+'</tr>')
 return '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>突破延续研究</title><style>'+styles+'</style><h1>'+html.escape(report['data']['symbol'])+' 突破延续研究</h1><p>按年份样本外测试。Log loss 与 Brier 越低越好；model 为逻辑回归，average 为训练期平均，trend 为 H4 同向分组基准。</p><p>initial：刚突破；survivors_initial：在 15 分钟存活群体中仅用初始特征；after_15m：同群体加入后续特征。后两者均用历史存活群体训练，表示在 15 分钟时的条件预测，不是最初模型的原样预测。</p><p>此前 24 根已收盘 H1 的高低点作为边界；在确认 M5 开始时冻结，M5 收盘确认突破。6 小时完整 M1 窗口，不重叠；缺口、同分钟双触达及确认前已触达目标剔除。main 目标为边界外 1 ATR / 内 0.5 ATR，near 为 0.8 / 0.4，far 为 1.2 / 0.6。</p><p>严格完整窗口会排除休市附近事件，结果只适用于该筛选群体；日线按原生开盘加 24 小时保守判断收盘。券商 UTC 偏移采用现有临时规则。数据末端缺少 H4/D1 时不外推填补。</p><h2>样本外评分</h2><table><tr><th>参数</th><th>特征与时刻</th><th>模型</th><th>样本</th><th>Log loss</th><th>Brier</th></tr>'+''.join(rows)+'</table><h2>概率校准</h2><p>点越接近对角线，预测概率与实际比例越接近。悬停查看各分箱样本量；小样本高概率分箱不稳定。</p>'+''.join(charts)+'<p>未计交易成本，没有订单簿证据，没有显著性或跨券商验证。未决类较少，概率尚未经过独立校准。</p><details><summary>数据、逐年结果及校准分箱</summary><pre>'+html.escape(json.dumps(report,ensure_ascii=False,indent=2))+'</pre></details></html>'

def main():
 parser = argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--database')
 parser.add_argument('--source',default='srv:EasyTradingOnlineLtd-Server')
 parser.add_argument('--symbol',default='XAUUSD')
 parser.add_argument('--repo',default=str(Path.cwd()))
 parser.add_argument('--render-json')
 parser.add_argument('--export-events',action='store_true',help='Export the fixed research event sample, without fitting models')
 parser.add_argument('--events-json',help='Analyze previously exported events locally')
 parser.add_argument('--html',help='Local HTML output path')
 args = parser.parse_args()
 if args.render_json:
  report = json.loads(Path(args.render_json).read_text())
 elif args.events_json:
  sample = json.loads(Path(args.events_json).read_text())
  report = from_events(sample['events'],sample['data'])
 else:
  if not args.database:
   parser.error('--database or --render-json required')
  db = sqlite3.connect(Path(args.database).resolve().as_uri()+'?mode=ro',uri=True,timeout=10)
  db.row_factory = sqlite3.Row
  try:
   db.execute('PRAGMA query_only=ON')
   db.execute('BEGIN')
   if args.export_events:
    events,info = extract(db,args.source,args.symbol,args.repo)
    report = {'schema':'syncnote-breakout-events.v1','data':info,'events':events}
   else:
    report = research(db,args.source,args.symbol,args.repo)
  finally:
   db.close()
 if args.html:
  Path(args.html).write_text(render(report),encoding='utf-8')
 if not args.render_json:
  print(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False))

if __name__ == '__main__':
 main()
