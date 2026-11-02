// 全站共享的本机偏好：主题 / 显示时区。api.js 在 history/profile/board/auth 之前加载，
// 所以旧页面也能和交易台用同一个时区、同一套深浅色。
(function () {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('sn-ui.v1') || '{}') || {}; } catch { prefs = {}; }
  const theme = prefs.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;

  const fallback = 'Asia/Shanghai';
  let zone = typeof prefs.timezone === 'string' && prefs.timezone ? prefs.timezone : fallback;
  if (zone === 'auto') {
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || fallback; } catch { zone = fallback; }
  }

  function partsOf(seconds) {
    const p = {};
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      for (const part of fmt.formatToParts(new Date(Number(seconds) * 1000))) {
        if (part.type !== 'literal') p[part.type] = part.value;
      }
    } catch { /* 时区坏了就返回空，调用方显示待校准 */ }
    return p;
  }

  window.syncnoteZone = zone;
  window.syncnoteStamp = (seconds) => {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '时间待校准';
    const p = partsOf(seconds);
    return p.year ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : '时间待校准';
  };
  window.syncnoteTime = (seconds) => {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
    const p = partsOf(seconds);
    return p.year ? `${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}` : '—';
  };
  window.syncnoteDateKey = (seconds) => {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '';
    const p = partsOf(seconds);
    return p.year ? `${p.year}-${p.month}-${p.day}` : '';
  };
  window.syncnoteMonthKey = (seconds) => window.syncnoteDateKey(seconds).slice(0, 7);
  window.syncnoteLogin = () => {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace('/login?next=' + next);
  };
})();

// Read requests may retry across a short proxy interruption. Writes never retry.
window.syncnoteAPI=async function(path,data){
 const writing=data!==undefined;
 for(let attempt=0;attempt<(writing?1:3);attempt++){
  let response;
  try{response=await fetch(path,{cache:'no-store',headers:{Accept:'application/json',...(writing?{'Content-Type':'application/json'}:{})},...(writing?{method:'POST',body:JSON.stringify(data)}:{})});}
  catch(e){if(!writing&&attempt<2){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}throw Error('网络连接中断，请稍后重试');}
  if(response.status===401){window.syncnoteLogin();throw Error('登录已过期，请重新登录');}
  const isJSON=(response.headers.get('Content-Type')||'').includes('application/json');
  if(!isJSON){
   if(!writing&&attempt<2&&[200,502,503,504].includes(response.status)){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}
   throw Error(response.status===403?'请求被公网访问保护拦截，请刷新页面后重试':'网站连接暂时异常（HTTP '+response.status+'），请稍后重试');
  }
  let value;try{value=await response.json();}catch{throw Error('网站返回的数据不完整，请稍后重试');}
  if(!response.ok){if(!writing&&attempt<2&&[502,503,504].includes(response.status)){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}throw Error(value.error||'请求失败（HTTP '+response.status+'）');}
  return value;
 }
};
