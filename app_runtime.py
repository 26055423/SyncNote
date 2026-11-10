"""Own the lifetime of background workers, independently of HTTP/imports."""
import os,threading,time
import bars,observability

class Runtime:
 def __init__(self,connect,hub,*,catalog_delay=5,catalog_interval=120,hub_enabled=None):
  self.connect=connect;self.hub=hub;self.delay=catalog_delay;self.interval=catalog_interval
  self.hub_enabled=os.environ.get('EA_HUB_ENABLE','1')!='0' if hub_enabled is None else hub_enabled
  self.stopped=threading.Event();self.worker=None

 def __enter__(self):
  if self.hub_enabled:self.hub.start()
  self.stopped.clear()
  self.worker=threading.Thread(target=self._catalog,name='bars-catalog',daemon=True)
  self.worker.start()
  return self

 def _catalog(self):
  if self.stopped.wait(self.delay):return
  while not self.stopped.is_set():
   started=time.perf_counter();failed=False
   try:
    with self.connect() as db:bars.refresh_catalog(db)
   except Exception as error:
    failed=True;print('catalog refresh failed:',type(error).__name__,flush=True)
   finally:observability.record('catalog.refresh',time.perf_counter()-started,failed)
   if self.stopped.wait(self.interval):return

 def __exit__(self,*args):
  self.stopped.set()
  if self.worker:self.worker.join()
  if self.hub_enabled:self.hub.stop()
