"""Feature ablation and paired calendar-block bootstrap on a fixed sample."""
import argparse
import collections
import datetime as dt
import html
import json
from pathlib import Path
import random
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tools import breakout_research as research

INITIAL_VARIANTS = {
 'full':tuple(range(7)),
 'no_speed':(0,2,3,4,5,6),
 'no_momentum':(0,3,4,5,6),
 'no_background':(0,1,2,3,4),
 'no_initial_position':(1,2,3,4,5,6),
 'only_position':(0,),
}
UPDATE_VARIANTS = {
 'full':tuple(range(10)),
 'initial_only':tuple(range(7)),
 'no_speed':(0,2,3,4,5,6,7,8,9),
 'no_momentum':(0,3,4,5,6,7,8,9),
 'no_background':(0,1,2,3,4,7,8,9),
 'no_worst_position':(0,1,2,3,4,5,6,7,9),
 'no_standing':tuple(range(9)),
 'no_latest_position':(0,1,2,3,4,5,6,8,9),
 'latest_position_only':tuple(range(8)),
 'only_position':(7,),
}
NAMES = {'full':'完整模型','average':'平均概率基准','trend':'H4 方向基准','distance':'目标距离线性基准','no_speed':'去掉速度','no_momentum':'去掉速度与推进效率','no_background':'去掉 H4/D1 背景','initial_only':'仅初始特征','no_worst_position':'去掉期间最不利位置','no_standing':'去掉站稳比例','no_latest_position':'去掉最新位置','latest_position_only':'初始特征加最新位置','no_initial_position':'去掉初始位置','only_position':'仅当前相对位置'}

def distance_prior(position, reward, failure, unresolved):
 # A diagnostic barrier-distance heuristic, not a finite-horizon price law.
 q = max(1e-9,min(1-1e-9,(position+failure)/(reward+failure)))
 return [(1-unresolved)*q,(1-unresolved)*(1-q),unresolved]

def stage_events(sample, case, stage):
 events = []
 for e in sample:
  label = e['outcomes'][case]
  if label not in research.LABELS:
   continue
  if stage=='initial':
   events.append(dict(e,label=label))
  elif case in e['updates']:
   events.append(dict(e,label=label,decision=e['decision']+900,x=e['updates'][case]))
 return events

def walk_forward(events, variants, progress=None, targets=(1.,.5)):
 years = sorted({dt.datetime.fromtimestamp(e['decision'],dt.timezone.utc).year for e in events})
 predictions,folds = [],[]
 for year in years[2:]:
  start = int(dt.datetime(year,1,1,tzinfo=dt.timezone.utc).timestamp())
  end = int(dt.datetime(year+1,1,1,tzinfo=dt.timezone.utc).timestamp())
  train = [e for e in events if e['end']<start-21600]
  test = [e for e in events if start<=e['decision']<end]
  if len(train)<100 or len(test)<20:
   continue
  if progress:
   progress(str(year)+' train='+str(len(train))+' test='+str(len(test)))
  average = research.prior(train)
  trend = {flag:research.prior([e for e in train if (e['x'][5]>0)==flag]) for flag in (False,True)}
  fold = [{'decision':e['decision'],'end':e['end'],'direction':e['direction'],'label':e['label'],'year':year,'probabilities':{'average':average,'trend':trend[e['x'][5]>0],'distance':distance_prior(e['x'][7] if len(e['x'])>7 else e['x'][0],*targets,average[2])}} for e in test]
  for name,columns in variants.items():
   reduced = [dict(e,x=[e['x'][j] for j in columns]) for e in train]
   model = research.fit(reduced)
   for e,row in zip(test,fold):
    row['probabilities'][name] = research.predict(model,[e['x'][j] for j in columns])
  predictions.extend(fold)
  folds.append({'year':year,'train':len(train),'test':len(test),'metrics':summarize(fold)})
 return predictions,folds

def summarize(rows):
 if not rows:
  return {}
 return {name:research.metrics([(e['label'],e['probabilities'][name]) for e in rows]) for name in rows[0]['probabilities']}

def loss(label, probabilities, metric):
 if metric=='brier':
  return sum((p-(label==k))**2 for k,p in zip(research.LABELS,probabilities))
 import math
 return -math.log(max(1e-12,probabilities[research.LABELS.index(label)]))

def calendar_block(t, unit):
 day = dt.datetime.fromtimestamp(t,dt.timezone.utc).date()
 if unit=='month':
  return day.strftime('%Y-%m')
 return (day-dt.timedelta(days=day.weekday())).isoformat()

def quantile(values, p):
 values = sorted(values)
 position = (len(values)-1)*p
 lo = int(position)
 hi = min(lo+1,len(values)-1)
 return values[lo]+(values[hi]-values[lo])*(position-lo)

def bootstrap(rows, comparator, unit, repetitions=2000, seed=20261113):
 if not rows:
  return None
 # Each draw uses entire paired blocks, stratified within each test year.
 blocks = collections.defaultdict(lambda:collections.defaultdict(lambda:[0,0.,0.]))
 for row in rows:
  group = blocks[row['year']][calendar_block(row['decision'],unit)]
  group[0] += 1
  for j,metric in enumerate(('brier','log_loss'),1):
   group[j] += loss(row['label'],row['probabilities'][comparator],metric)-loss(row['label'],row['probabilities']['full'],metric)
 strata = [list(groups.values()) for _,groups in sorted(blocks.items())]
 rng,draws = random.Random(seed),[[],[]]
 for _ in range(repetitions):
  total,n = [0.,0.],0
  for groups in strata:
   for _ in groups:
    count,brier,log_loss = rng.choice(groups)
    n += count
    total[0] += brier
    total[1] += log_loss
  for j in range(2):
   draws[j].append(total[j]/n)
 overall = [sum(g[j] for groups in strata for g in groups)/len(rows) for j in (1,2)]
 return {'unit':unit,'blocks':sum(map(len,strata)),'blocks_by_year':{str(y):len(v) for y,v in blocks.items()},'n':len(rows),'repetitions':repetitions,'seed':seed,'difference':'comparator loss minus full loss; positive favors full','metrics':{metric:{'gain':overall[j],'ci95':[quantile(draws[j],.025),quantile(draws[j],.975)]} for j,metric in enumerate(('brier','log_loss'))}}

def stability(sample, repetitions=2000, progress=None):
 results = {}
 for case in ('main','near','far'):
  results[case] = {}
  for stage,variants in [('initial',INITIAL_VARIANTS),('after_15m',UPDATE_VARIANTS)]:
   if progress:
    progress(case+' '+stage)
   events = stage_events(sample['events'],case,stage)
   rows,folds = walk_forward(events,variants,progress,{'main':(1.,.5),'near':(.8,.4),'far':(1.2,.6)}[case])
   scores = summarize(rows)
   comparisons = {name:{unit:bootstrap(rows,name,unit,repetitions) for unit in ('week','month')} for name in scores if name!='full'}
   directions = {str(direction):summarize([r for r in rows if r['direction']==direction]) for direction in (-1,1)}
   results[case][stage] = {'n':len(rows),'columns':{k:list(v) for k,v in variants.items()},'metrics':scores,'folds':folds,'directions':directions,'comparisons':comparisons,'predictions':rows}
 return {'schema':'syncnote-breakout-stability.v1','data':sample['data'],'method':{'fit':'same 35-step model and annual expanding splits as first experiment; each ablation retrained on same event sample','bootstrap':'paired occupied calendar weeks/months resampled within each test year; event-weighted score difference','uncertainty':'conditional on fitted historical models; no retraining within bootstrap, no independent-market replication','multiplicity':'pointwise percentile 95% intervals, not adjusted for multiple comparisons; exploratory evidence','distance_baseline':'q=clip((current position+failure)/(reward+failure)); probabilities [(1-u)q,(1-u)(1-q),u], u from historical training prior only; heuristic, not exact finite-horizon law; added after inspecting first ablations','standing':'fraction of three M5 closes outside boundary, not continuous dwell time','worst_position':'minimum favorable-direction distance from boundary during first 15m; not peak-to-trough drawdown','selection':'same original complete-window, nonoverlap, target-touch exclusions; three target sets are correlated','training_uncertainty':'fixed 35 optimization steps retained; contribution is specific to this model and correlated features'},'results':results}

def table(headers, rows):
 return '<table><tr>'+''.join('<th>'+html.escape(str(x))+'</th>' for x in headers)+'</tr>'+''.join('<tr>'+''.join('<td>'+html.escape(str(x))+'</td>' for x in row)+'</tr>' for row in rows)+'</table>'

def render(report):
 css = (Path(__file__).resolve().parents[1]/'web/chart-src/src/styles.css').read_text(encoding='utf-8')
 tokens = ':root {'+css.split(':root {',1)[1].split('}',1)[0]+'}'
 styles = tokens+'body{background:var(--bg);color:var(--text);font:16px/1.65 system-ui;max-width:1150px;margin:32px auto;padding:0 20px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid var(--line);padding:8px;text-align:left}th,details{background:var(--panel)}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{padding:12px;cursor:pointer}svg{max-width:900px;width:100%;height:auto}svg text{fill:var(--text);font-size:13px}'
 parts = ['<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>突破模型：特征与稳定性</title><style>'+styles+'</style><h1>突破模型：特征与稳定性</h1><p>删掉一项信息后重新训练，且使用完全相同的事件、标签与年份。评分越低越好。区间表示对固定样本外预测按周/月分块抽样的不确定性，未做多重比较修正。</p><p>正的改善量表示完整模型优于比较模型；区间跨过零表示贡献尚不清楚。有关联的特征可能互相替代，不能解释为因果关系。</p><p>距离基准按当前位置在上下目标间的比例分配延续/失败概率，未决比例只来自训练数据。这是诊断用启发式，并非六小时价格定律。它在第一轮消融后加入，仍属探索性比较。</p>']
 overview = []
 for stage,data in report['results']['main'].items():
  if not data['metrics']:
   continue
  overview.append(['刚突破' if stage=='initial' else '15 分钟后',data['n']]+['%.5f'%data['metrics'][name]['brier'] for name in ('average','full','only_position','distance')])
 parts.append('<h2>主参数：先看简单基准</h2>'+table(['时刻','样本','平均基准 Brier','完整模型','仅当前位置模型','目标距离基准'],overview)+'<p>完整模型相对于平均基准的改善，必须进一步与位置和距离基准比较，才能讨论是否有额外的运动信息。两个时刻筛选的样本群体不同，不能直接比较绝对评分。</p>')
 for case,stages in report['results'].items():
  parts.append('<h2>'+{'main':'主目标 1 / 0.5 ATR','near':'较近目标 0.8 / 0.4 ATR','far':'较远目标 1.2 / 0.6 ATR'}[case]+'</h2>')
  for stage,result in stages.items():
   parts.append('<details'+(' open' if case=='main' else '')+'><summary>'+('刚突破时' if stage=='initial' else '15 分钟后仍未结束')+'：'+str(result['n'])+' 个样本外事件</summary>')
   rows = []
   for name,m in result['metrics'].items():
    comparison = result['comparisons'].get(name)
    gains = []
    for unit in ('week','month'):
     b = comparison[unit]['metrics']['brier'] if comparison else None
     gains.append(('%+.5f [%+.5f, %+.5f]'%(b['gain'],*b['ci95'])) if b else '—')
    rows.append([NAMES[name],'%.5f'%m['brier'],'%.5f'%m['log_loss'],*gains])
   parts.append(table(['模型','Brier','Log loss','完整模型改善：周块 95% 区间','月块 95% 区间'],rows))
   if result['comparisons']:
    values = [(name,value['month']['metrics']['brier']) for name,value in result['comparisons'].items()]
    span = max(.005,max(abs(x) for _,v in values for x in v['ci95']))*1.15
    center,scale = 540,220/span
    svg = '<svg viewBox="0 0 820 '+str(45+len(values)*32)+'" role="img" aria-label="月块抽样的 Brier 改善区间"><line x1="540" x2="540" y1="5" y2="'+str(20+len(values)*32)+'" stroke="var(--line-strong)"/>'
    for i,(name,value) in enumerate(values):
     y = 22+32*i
     lo,hi = [center+x*scale for x in value['ci95']]
     svg += '<text x="5" y="'+str(y+5)+'">'+NAMES[name]+'</text><line x1="'+str(lo)+'" x2="'+str(hi)+'" y1="'+str(y)+'" y2="'+str(y)+'" stroke="var(--accent)" stroke-width="3"/><circle cx="'+str(center+value['gain']*scale)+'" cy="'+str(y)+'" r="4" fill="var(--good)"><title>'+NAMES[name]+'：'+str(value)+'</title></circle>'
    parts.append(svg+'<text x="320" y="'+str(40+len(values)*32)+'">左：完整模型较差　｜　零　｜　右：完整模型较好</text></svg>')
   yearly = []
   for f in result['folds']:
    m = f['metrics']
    yearly.append([f['year'],f['test'],'%.5f'%m['full']['brier'],'%.5f'%m['average']['brier'],'%.5f'%m['distance']['brier'],'%+.5f'%(m['average']['brier']-m['full']['brier']),'%+.5f'%(m['distance']['brier']-m['full']['brier'])])
   parts.append('<h3>逐年表现</h3>'+table(['年份','样本','完整模型 Brier','平均基准','距离基准','相对平均改善','相对距离改善'],yearly))
   parts.append('<h3>方向检查</h3>'+table(['突破方向','样本','完整模型 Brier','平均基准','距离基准'],[['向上' if d=='1' else '向下',m['full']['n'],'%.5f'%m['full']['brier'],'%.5f'%m['average']['brier'],'%.5f'%m['distance']['brier']] for d,m in result['directions'].items() if m]))
   parts.append('</details>')
 brief = dict(report,results={case:{stage:{k:v for k,v in data.items() if k!='predictions'} for stage,data in stages.items()} for case,stages in report['results'].items()})
 parts.append('<p>最不利位置不等于峰谷回撤；站稳比例不等于连续停留时间。区间只反映占用周/月块中的事件评分，未覆盖重新训练、选模型、行情缺口或新市场带来的不确定性。没有交易成本或盈利验证。</p><details><summary>完整方法与数值（逐事件预测另存于 JSON）</summary><pre>'+html.escape(json.dumps(brief,ensure_ascii=False,indent=2))+'</pre></details></html>')
 return ''.join(parts)

def main():
 parser = argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--events-json')
 parser.add_argument('--render-json')
 parser.add_argument('--output-json')
 parser.add_argument('--html')
 parser.add_argument('--repetitions',type=int,default=2000)
 args = parser.parse_args()
 if args.repetitions<100:
  parser.error('At least 100 bootstrap repetitions required')
 if args.render_json:
  report = json.loads(Path(args.render_json).read_text(encoding='utf-8'))
 elif args.events_json:
  sample = json.loads(Path(args.events_json).read_text(encoding='utf-8'))
  if sample.get('schema')!='syncnote-breakout-events.v1':
   parser.error('Expected syncnote-breakout-events.v1')
  report = stability(sample,args.repetitions,lambda s:print(s,file=sys.stderr,flush=True))
 else:
  parser.error('--events-json or --render-json required')
 if args.output_json:
  Path(args.output_json).write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
 if args.html:
  Path(args.html).write_text(render(report),encoding='utf-8')
 if not args.output_json and not args.render_json:
  print(json.dumps(report,ensure_ascii=False,allow_nan=False))

if __name__=='__main__':
 main()
