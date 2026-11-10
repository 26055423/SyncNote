"""Bounded process-local timings. Never retain SQL, payloads, URLs or identities."""
import threading
import time
from functools import wraps
from collections import deque

_lock=threading.Lock()
_started=time.time()
_metrics={}
LABELS=('db.execute','catalog.refresh','http.get','http.post')

def http(label):
 def decorate(function):
  @wraps(function)
  def measured(handler,*args,**kwargs):
   started=time.perf_counter();handler.response_status=500
   try:return function(handler,*args,**kwargs)
   finally:record(label,time.perf_counter()-started,handler.response_status>=500)
  return measured
 return decorate

def record(label,seconds,failed=False):
 if label not in LABELS:return
 with _lock:
  item=_metrics.setdefault(label,{'count':0,'errors':0,'slow':0,'max_ms':0,'samples':deque(maxlen=512)})
  ms=round(seconds*1000,3)
  item['count']+=1;item['errors']+=int(failed);item['slow']+=int(ms>=250)
  item['max_ms']=max(item['max_ms'],ms);item['samples'].append(ms)

def snapshot():
 with _lock:
  result={}
  for label,item in _metrics.items():
   samples=sorted(item['samples'])
   result[label]={k:v for k,v in item.items() if k!='samples'}
   result[label].update(sample_count=len(samples),p50_ms=samples[(len(samples)-1)//2],p95_ms=samples[int((len(samples)-1)*.95)])
 return {'since':_started,'uptime_seconds':round(time.time()-_started),'metrics':result}
