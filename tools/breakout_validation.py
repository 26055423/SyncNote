"""Freeze candidates and evaluate new time ranges or held-out broker samples."""
import argparse
import collections
import datetime as dt
import hashlib
import html
import json
import math
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tools import breakout_research as research
from tools import breakout_stability as stability

PRIMARY = 'after_15m'
VARIANTS = {'full':tuple(range(10)),'only_position':(7,)}

def digest(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def code_hashes():
 return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (Path(research.__file__),Path(stability.__file__),Path(__file__))}

def instant(text):
 return int(dt.datetime.fromisoformat(text.replace('Z','+00:00')).timestamp())

def check_sample(sample):
 if sample.get('schema')!='syncnote-breakout-events.v1':
  raise ValueError('Expected syncnote-breakout-events.v1')
 data = sample['data']
 if data.get('time_basis')!='UTC':
  raise ValueError('UTC event sample required')
 seen = set()
 as_of = instant(data['as_of'])
 for event in sample['events']:
  decision = event['decision']
  if decision in seen or event['end']!=decision+21600 or event['end']>as_of or event['direction'] not in (-1,1):
   raise ValueError('Invalid, duplicate, or unfinished event')
  seen.add(decision)
  if len(event['x'])!=7 or any(not math.isfinite(v) for v in event['x']):
   raise ValueError('Invalid initial features')
  for case,values in event['updates'].items():
   if len(values)!=10 or values[:7]!=event['x'] or any(not math.isfinite(v) for v in values):
    raise ValueError('Invalid update features')
   if event['outcomes'].get(case) not in research.LABELS:
    raise ValueError('Update must represent a surviving valid event')
 return as_of

def fit_candidates(events):
 if len(events)<100:
  return None
 candidates = {}
 for name,columns in VARIANTS.items():
  candidates[name] = research.fit([dict(e,x=[e['x'][j] for j in columns]) for e in events])
 return {'train':len(events),'last_label_end':max(e['end'] for e in events),'average':research.prior(events),'models':candidates}

def freeze(sample, frozen_at=None):
 observed = check_sample(sample)
 frozen_at = int(time.time() if frozen_at is None else frozen_at)
 if frozen_at<observed:
  raise ValueError('Cannot backdate a freeze before the observed sample')
 events = stability.stage_events(sample['events'],'main',PRIMARY)
 forward = fit_candidates([e for e in events if e['end']<frozen_at-21600])
 if forward is None:
  raise ValueError('Need at least 100 labeled training survivors')
 first_year = dt.datetime.fromtimestamp(min(e['decision'] for e in events),dt.timezone.utc).year
 last_year = dt.datetime.fromtimestamp(frozen_at,dt.timezone.utc).year
 annual = {}
 for year in range(first_year+2,last_year+2):
  cutoff = int(dt.datetime(year,1,1,tzinfo=dt.timezone.utc).timestamp())-21600
  model = fit_candidates([e for e in events if e['end']<cutoff])
  if model:
   annual[str(year)] = model
 bundle = {'schema':'syncnote-breakout-frozen.v1','frozen_at':frozen_at,'frozen_utc':research.stamp(frozen_at),'training_source':sample['data']['source'],'training_symbol':sample['data']['symbol'],'training_sample_sha256':digest(sample),'code_sha256':code_hashes(),'spec':{'case':'main','stage':PRIMARY,'reward_atr':1.,'failure_atr':.5,'horizon_seconds':21600,'embargo_seconds':21600,'min_evaluation_events':200,'min_evaluation_days':180,'primary_comparison':'only_position versus distance, Brier','secondary_comparison':'full versus distance, Brier; log loss and calibration diagnostic','bootstrap_repetitions':2000,'bootstrap_seed':20261113,'distance':'q=clip((position+0.5)/1.5); unresolved rate from training only','future':'events must start at least 6h after freeze; fixed all-history models, no updating','transfer':'different broker, same symbol; annual models trained only before test year; correlated underlying market is not independent future evidence','stopping':'below 200 events or 180 days: descriptive only; no confirmatory intervals','selection':'original complete-M1-window and target-touch filters; retrospective frozen-model replay, not a live timestamped forecast log'},'columns':{name:list(columns) for name,columns in VARIANTS.items()},'forward':forward,'annual':annual}
 bundle['id'] = digest(bundle)
 return bundle

def verify(bundle):
 expected = dict(bundle)
 identifier = expected.pop('id',None)
 if bundle.get('schema')!='syncnote-breakout-frozen.v1' or digest(expected)!=identifier:
  raise ValueError('Frozen artifact integrity check failed')
 if bundle['code_sha256']!=code_hashes():
  raise ValueError('Research code changed since freeze; use the matching code, do not silently refit')

def forecast(event, fitted, bundle):
 if fitted['last_label_end']>=event['decision']-21600:
  raise ValueError('Training labels overlap evaluation time')
 p = {'average':fitted['average'],'distance':stability.distance_prior(event['x'][7],1.,.5,fitted['average'][2])}
 for name,model in fitted['models'].items():
  p[name] = research.predict(model,[event['x'][j] for j in bundle['columns'][name]])
 return {'decision':event['decision'],'end':event['end'],'direction':event['direction'],'label':event['label'],'year':dt.datetime.fromtimestamp(event['decision'],dt.timezone.utc).year,'probabilities':p}

def evaluate(bundle, sample, mode='future'):
 verify(bundle)
 check_sample(sample)
 if sample['data']['symbol']!=bundle['training_symbol']:
  raise ValueError('Symbol mismatch: this fixed experiment is for the same gold symbol')
 source = sample['data']['source']
 if mode=='transfer' and source==bundle['training_source']:
  raise ValueError('Transfer requires a different broker')
 if mode=='future' and source!=bundle['training_source']:
  raise ValueError('Use transfer mode for a different broker')
 rows,excluded = [],collections.Counter()
 for event in stability.stage_events(sample['events'],'main',PRIMARY):
  # Compare raw event start, not the 15m feature update time.
  if mode=='future' and event['decision']-900<bundle['frozen_at']+21600:
   excluded['already_observed_or_embargo'] += 1
   continue
  year = str(dt.datetime.fromtimestamp(event['decision'],dt.timezone.utc).year)
  fitted = bundle['forward'] if mode=='future' else bundle['annual'].get(year)
  if fitted is None:
   excluded['no_earlier_training_model'] += 1
   continue
  rows.append(forecast(event,fitted,bundle))
 scores = stability.summarize(rows)
 days = (max(r['decision'] for r in rows)-min(r['decision'] for r in rows))/86400 if rows else 0
 enough = len(rows)>=bundle['spec']['min_evaluation_events'] and days>=bundle['spec']['min_evaluation_days']
 intervals = {}
 if enough:
  # bootstrap's full key is the tested candidate; comparator stays distance.
  for candidate in ('only_position','full'):
   paired = [dict(r,probabilities={'full':r['probabilities'][candidate],'distance':r['probabilities']['distance']}) for r in rows]
   intervals[candidate] = {unit:stability.bootstrap(paired,'distance',unit,bundle['spec']['bootstrap_repetitions'],bundle['spec']['bootstrap_seed']) for unit in ('week','month')}
 return {'schema':'syncnote-breakout-validation.v1','frozen_id':bundle['id'],'mode':mode,'status':'ready_for_fixed_sample_comparison' if enough else 'insufficient_new_sample','source':source,'symbol':sample['data']['symbol'],'as_of':sample['data']['as_of'],'evaluation_sample_sha256':digest(sample),'n':len(rows),'span_days':days,'criteria':bundle['spec'],'exclusions':dict(excluded),'metrics':scores,'intervals':intervals,'years':{str(y):stability.summarize([r for r in rows if r['year']==y]) for y in sorted({r['year'] for r in rows})},'directions':{str(d):stability.summarize([r for r in rows if r['direction']==d]) for d in (-1,1)},'predictions':rows,'limitations':'Frozen retrospective replay with original complete-window selection; no timestamped live forecasts, trading costs, or independent-market proof. Repeated interim reads do not justify early confirmatory conclusions.'}

def render(report, audit=None):
 css = (Path(__file__).resolve().parents[1]/'web/chart-src/src/styles.css').read_text(encoding='utf-8')
 tokens = ':root {'+css.split(':root {',1)[1].split('}',1)[0]+'}'
 styles = tokens+'body{background:var(--bg);color:var(--text);font:16px/1.7 system-ui;max-width:1000px;margin:32px auto;padding:0 20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--line);padding:8px;text-align:left}details{background:var(--panel);padding:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}'
 rows = [[stability.NAMES[k],v['n'],'%.5f'%v['brier'],'%.5f'%v['log_loss']] for k,v in report['metrics'].items()]
 sections = ['<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>固定模型独立复验</title><style>'+styles+'</style><h1>固定模型独立复验</h1><p>状态：'+('达到预设样本门槛，可做固定样本比较' if report['intervals'] else '尚无足够新样本，不能给出复验结论')+'</p><p>有效新事件 '+str(report['n'])+'；跨度 '+str(round(report['span_days'],1))+' 天。预设门槛为 200 个事件及 180 天。已分析过的旧历史不会作为未来新样本。</p><p>主比较：仅当前位置模型与距离基准；完整模型作为次要比较。模型已固定，不利用复验标签重新训练或调参。其他券商历史采用该年份之前的训练模型，跨券商同标的仍是相关市场，不能当成独立未来行情。</p>',stability.table(['模型','样本','Brier','Log loss'],rows)]
 if audit:
  sections.append('<h2>服务器已有数据</h2>'+stability.table(['券商','品种','周期','根数','首根 UTC','末根 UTC'],[[r['source'],r['symbol'],r['tf'],r['n'],r['first_utc'],r['last_utc']] for r in audit['series']]))
 brief = {k:v for k,v in report.items() if k!='predictions'}
 sections.append('<details><summary>固定规则与结果</summary><pre>'+html.escape(json.dumps(brief,ensure_ascii=False,indent=2))+'</pre></details></html>')
 return ''.join(sections)

def write_new(path, value):
 with Path(path).open('x',encoding='utf-8') as out:
  out.write(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False))

def main():
 parser = argparse.ArgumentParser(description=__doc__)
 commands = parser.add_subparsers(dest='command',required=True)
 fixed = commands.add_parser('freeze')
 fixed.add_argument('--events-json',required=True)
 fixed.add_argument('--output',required=True)
 test = commands.add_parser('evaluate')
 test.add_argument('--frozen',required=True)
 test.add_argument('--events-json',required=True)
 test.add_argument('--mode',choices=('future','transfer'),default='future')
 test.add_argument('--output',required=True)
 test.add_argument('--html')
 test.add_argument('--audit-json')
 args = parser.parse_args()
 try:
  sample = json.loads(Path(args.events_json).read_text(encoding='utf-8'))
  if args.command=='freeze':
   result = freeze(sample)
  else:
   result = evaluate(json.loads(Path(args.frozen).read_text(encoding='utf-8')),sample,args.mode)
  write_new(args.output,result)
  if args.command=='evaluate' and args.html:
   audit = json.loads(Path(args.audit_json).read_text(encoding='utf-8')) if args.audit_json else None
   Path(args.html).write_text(render(result,audit),encoding='utf-8')
 except (ValueError,FileExistsError) as error:
  parser.exit(2,str(error)+'\n')
 print(json.dumps({k:result[k] for k in ('id','status','n','frozen_utc') if k in result},ensure_ascii=False))

if __name__=='__main__':
 main()
