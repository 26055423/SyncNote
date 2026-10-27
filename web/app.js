const $ = s => document.querySelector(s);
let members=[{id:'me',name:'本人',device:'Mac'},{id:'friend',name:'朋友',device:'Windows'}];
let names = Object.fromEntries(members.map(m=>[m.id,m.name]));
const esc = x => String(x ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed = n => (n>=0?'+':'') + money(n);
const timeLabel = t => new Date(t*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
function savedPreference(key,fallback){try{return localStorage.getItem(key)??fallback;}catch{return fallback;}}
function savePreference(key,value){try{localStorage.setItem(key,String(value));}catch{}}
let volume=Math.max(0,Math.min(1,Number(savedPreference('board-volume',.8))));
if(!Number.isFinite(volume))volume=.8;
$('#volume').value=Math.round(volume*100);$('#volume-value').textContent=Math.round(volume*100)+'%';
$('#volume').addEventListener('input',e=>{volume=Number(e.target.value)/100;$('#volume-value').textContent=e.target.value+'%';savePreference('board-volume',volume);});
$('#volume').addEventListener('change',()=>{if(sound)beep();});
let mt5Presence=new Map(),socialSeen=new Set();
let state=null, demo=false, filter='all', audio=null, sound=savedPreference('board-sound','off')==='on', seen=new Set(), initialized=false, demoSequence=0;
let viewer='me';
let notificationSubjects=new Set();
function updateSender(){ $('#sender-label').textContent=`以${names[viewer]}身份留言`; }
function soundLabel(){const b=$('#sound');b.setAttribute('aria-pressed',String(sound));b.textContent=!sound?'开启交易池记录提醒':audio?.state==='running'?'交易池记录提醒已开启':'提醒已开启 · 点击页面启用声音';}
function ensureAudio(){if(!audio||audio.state==='closed'){audio=new (window.AudioContext||window.webkitAudioContext)();audio.onstatechange=soundLabel;}return audio;}
function activateSound(){if(!sound)return Promise.resolve();try{const ctx=ensureAudio();soundLabel();return ctx.resume().then(soundLabel).catch(soundLabel);}catch{soundLabel();$('#sound').textContent='当前浏览器不支持声音';return Promise.resolve();}}
function beep(){
 if(!sound||volume<=0)return;
 if(!audio||audio.state!=='running'){activateSound();return;}
 [0,.23,.46].forEach((delay,i)=>{const o=audio.createOscillator(),g=audio.createGain();o.type='triangle';o.frequency.value=[660,880,1100][i];g.gain.setValueAtTime(0,audio.currentTime+delay);g.gain.linearRampToValueAtTime(Math.max(.001,volume*.7),audio.currentTime+delay+.02);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+delay+.2);o.connect(g);g.connect(audio.destination);o.start(audio.currentTime+delay);o.stop(audio.currentTime+delay+.22);});
}
$('#sound').onclick=()=>{sound=!sound;savePreference('board-sound',sound?'on':'off');soundLabel();if(sound){activateSound().then(()=>{if(sound)beep();});if(state?.notifications?.length){socialSeen=new Set();render();}}};
// Browser autoplay permission is separate from the saved preference.
function restoreSoundAfterGesture(e){if(sound&&e.isTrusted&&!e.target.closest?.('#sound'))activateSound();}
document.addEventListener('pointerdown',restoreSoundAfterGesture);document.addEventListener('keydown',restoreSoundAfterGesture);
soundLabel();if(sound)activateSound();
// MT5 arrivals use upload heartbeats, never browser presence.
function mt5Arrivals(next,self,notify){
 const now=next.now,joined=[],allowed=new Set();
 for(const member of next.members||[]){
  if(member.id===self||member.can_view===false)continue;
  allowed.add(member.id);
  const entry=next.snapshots?.[member.id],fresh=!!entry&&now-entry.updated<=45&&entry.data.online!==false;
  let previous=mt5Presence.get(member.id);
  if(!previous){
   const lastActive=entry?(entry.data.online===false?now:entry.updated):-Infinity;
   mt5Presence.set(member.id,{lastActive,offline:!fresh&&now-lastActive>=180});continue;
  }
  if(fresh){if(previous.offline&&notify)joined.push(member.id);previous.lastActive=entry.updated;previous.offline=false;}
  else if(now-previous.lastActive>=180)previous.offline=true;
 }
 for(const id of mt5Presence.keys())if(!allowed.has(id))mt5Presence.delete(id);
 return joined;
}
function sample(){const now=Date.now()/1000;return {now,members,snapshots:{me:{updated:now,data:{balance:10000,equity:10126.8,history:[{ticket:'DEMO-090',symbol:'XAUUSD',side:'buy',volume:.1,open:2620,close:2635,profit:150,closed:now-7200}],currency:'USD',positions:[{ticket:'DEMO-101',symbol:'XAUUSD',side:'buy',volume:.1,open:2651.2,current:2663.88,profit:126.8,sl:2643,tp:2678,sl_profit:-82,tp_profit:268}]}},friend:{updated:now,data:{balance:12500,equity:12572.4,history:[{ticket:'DEMO-190',symbol:'XAUUSD',side:'sell',volume:.05,open:2630,close:2638,profit:-40,closed:now-10800}],currency:'USD',positions:[{ticket:'DEMO-201',symbol:'XAUUSD',side:'buy',volume:.05,open:2649.4,current:2663.88,profit:72.4,sl:2640,tp:2680,sl_profit:-47,tp_profit:153}]}}},events:[{id:2,person:'friend',kind:'open',text:'买入 XAUUSD · 0.05 手 · 开仓价 2649.40',created:now-180},{id:1,person:'me',kind:'modify',text:'XAUUSD · 止损调整至 2643.00',created:now-600},{id:0,person:'me',kind:'close',text:'平仓 XAUUSD · 0.10 手 · 盈利 +150.00 USD',created:now-7200}],messages:[{id:1,person:'friend',text:'这笔等回调确认后入场，止损放在前低下面。',created:now-150},{id:2,person:'me',text:'收到。我也在看黄金，先观察这段走势。',created:now-120}]};}
$('#demo').onclick=()=>{demo=!demo;$('#demo').textContent=demo?'退出演示':'查看演示';$('#demo').setAttribute('aria-pressed',demo);initialized=false;seen=new Set();mt5Presence.clear();if(demo){state=sample();render();}else{state=null;refresh();}};
function targetCell(p, kind){
 const price=p[kind], amount=p[kind+'_profit'];
 if(!price) return '<span class="target-unset">未设置</span>';
 const known=typeof amount==='number'&&Number.isFinite(amount);
 return `<span class="target-price">${money(price)}</span><span class="target-result ${known?(amount>=0?'positive':'negative'):''}">${known?'预计 '+signed(amount):'预计盈亏待同步'}</span>`;
}
function account(member){
 const person=member.id,entry=state.snapshots[person],d=entry?.data,age=entry?Date.now()/1000-entry.updated:Infinity;
 const watching=demo || (!!entry && age<=45 && d.online!==false);
 const status=member.can_view===false?'未开放':watching?'盯盘':'休息';
 const ps=d?.positions||[], profit=ps.reduce((n,p)=>n+p.profit,0);
 return `<article class="account"><div class="account-head"><div class="person"><div class="avatar ${person!==viewer?'friend':''}">${avatarMarkup(member.avatar,member.name.slice(0,1))}</div><div><h2>${esc(member.name)}</h2><small>MT5${d?' · '+esc(d.currency||'USD'):''}</small></div></div><span class="status ${watching?'online':''}" title="${demo?'演示状态':entry?'按 MT5 最后同步时间判断':'尚未收到 MT5 同步'}">状态 · ${status}</span></div><div class="metrics"><div class="metric"><span>账户净值</span><strong>${d?money(d.equity):'—'}</strong><small>${d?esc(d.currency||'USD'):member.can_view===false?'数据未开放':'等待同步'}</small></div><div class="metric"><span>账户余额</span><strong>${d?money(d.balance):'—'}</strong><small>${d?esc(d.currency||'USD'):member.can_view===false?'数据未开放':'等待同步'}</small></div><div class="metric"><span>持仓浮动盈亏</span><strong class="${d?(profit>=0?'positive':'negative'):''}">${d?signed(profit):'—'}</strong><small>${ps.length} 笔持仓</small></div></div><div class="history-link-row"><span>${entry?'最后同步 '+new Date(entry.updated*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'等待同步'}</span>${member.can_view===false?'<span class="locked-data">交易数据未开放</span>':`<a class="record-link" href="/history?person=${encodeURIComponent(person)}">查看交易记录</a>`}</div></article>`;
}
function pool(){
 const positions=members.flatMap(m=>(state.snapshots[m.id]?.data.positions||[]).map(p=>({...p,member:m,updated:state.snapshots[m.id].updated,currency:state.snapshots[m.id].data.currency||'USD'})));
 positions.sort((a,b)=>b.profit-a.profit || a.member.id.localeCompare(b.member.id) || String(a.ticket).localeCompare(String(b.ticket))); 
 $('#pool-count').textContent=positions.length+' 笔持仓 · '+new Set(positions.map(p=>p.member.id)).size+' 人';
 function rows(ps){return ps.map(p=>`<tr class="${p.member.id===viewer?'own-position':''}"><td><b>${esc(p.member.name)}</b>${p.member.id===viewer?'<span class="own-label">我的订单</span>':''}<span class="ticket">${demo?'演示数据':Date.now()/1000-p.updated>15?'数据过期 · 待确认':'持仓中'}</span></td><td><b>${esc(p.symbol)}</b> <span class="side ${p.side==='sell'?'sell':''}">${p.side==='sell'?'卖出':'买入'}</span><span class="ticket">#${esc(p.ticket)}</span></td><td>${esc(p.volume)}</td><td>${money(p.open)}</td><td>${targetCell(p,'sl')}</td><td>${targetCell(p,'tp')}</td><td class="${p.profit>=0?'positive':'negative'}">${signed(p.profit)}<span class="ticket">${esc(p.currency)}</span></td></tr>`).join('');}
 $('#pool').innerHTML=positions.length?`<div class="table-wrap"><table><thead><tr><th>所属成员</th><th>品种 / 方向</th><th>手数</th><th>开仓价</th><th>止损 / 预计盈亏</th><th>止盈 / 预计盈亏</th><th>浮动盈亏</th></tr></thead><tbody>${rows(positions)}</tbody></table></div>`:`<div class="empty pool-empty"><strong>当前交易池为空</strong>${Object.keys(state.snapshots).length?'目前没有收到未平仓订单':'尚未接入 MT5，当前无订单数据'} · 开仓后订单会出现在这里</div>`;
}
function render(){
 if(state.user?.onboarding_step<4){location.replace('/welcome');return;} if(state.user){viewer=state.user.id;$('#self-name').textContent=state.user.nickname;const selfAvatar=avatarMarkup(state.user.avatar,state.user.nickname.slice(0,1));if($('#self-avatar').innerHTML!==selfAvatar)$('#self-avatar').innerHTML=selfAvatar;$('#self-username').textContent='@'+state.user.username;}
 if(state.members){members=state.members;names=Object.fromEntries(members.map(m=>[m.id,m.name]));}
 if(!names[viewer])viewer=members[0]?.id||'me';
 updateSender();
 $('#accounts').innerHTML=members.map(account).join('');$('#accounts').setAttribute('aria-busy','false');pool();
 const activity=state.events.filter(e=>e.kind==='open'||e.kind==='close').slice(0,12);
 $('#notice').classList.toggle('demo',demo);
 const tickerHTML=`<span class="ticker-label">${demo?'演示动态':'交易动态'}</span><div class="ticker-window"><div class="ticker-track ${activity.length?'moving':''}">${activity.length?activity.map(e=>`<span class="ticker-item"><b>${esc(names[e.person]||e.person)}${e.kind==='open'?'开仓了':'平仓了'}</b><span>${esc(e.text)}</span><time>${timeLabel(e.created)}</time></span>`).join(''):`<span class="ticker-item">${demo?'演示模式 · 暂无交易动态':'暂无开仓或平仓动态，等待 MT5 同步'}</span>`}</div></div>`;
 if($('#notice').innerHTML!==tickerHTML)$('#notice').innerHTML=tickerHTML;

 const msgs=$('#messages'), atBottom=msgs.scrollHeight-msgs.scrollTop-msgs.clientHeight<60, old=msgs.innerHTML;
 const html=state.messages.length?state.messages.map(m=>`<div class="message ${m.person===viewer?'mine':''}"><div class="message-meta">${esc(m.name||names[m.person]||m.person)} · ${timeLabel(m.created)}</div><p>${esc(m.text)}</p></div>`).join(''):'<div class="empty"><strong>还没有留言</strong>记录思路，也聊聊交易</div>';
 if(old!==html){msgs.innerHTML=html;if(atBottom||!old)msgs.scrollTop=msgs.scrollHeight;}
 $('#message').placeholder=demo?'演示留言只保留在本次演示中…':'聊聊这笔交易，或留下一点想法…';
 if(initialized){const incoming=state.events.filter(e=>notificationSubjects.has(e.person)&&!seen.has(e.id)&&(e.kind==='open'||e.kind==='close'));if(incoming.length){const a=$('#alert');a.hidden=false;a.textContent=`${names[incoming[0].person]||incoming[0].person}${incoming[0].kind==='open'?'开仓了':'平仓了'} · ${incoming[0].text}${incoming.length>1?'（另有 '+(incoming.length-1)+' 条新动态）':''}`;beep();clearTimeout(window.alertTimer);window.alertTimer=setTimeout(()=>a.hidden=true,12000);}}
 const social=state.notifications||[];const joined=mt5Arrivals(state,viewer,initialized&&!demo);
 const badge=$('#self-profile .profile-entry');if(badge)badge.textContent=social.length?'个人中心 · '+social.length+' 条新关注':'个人中心';
 const socialNew=social.filter(n=>!socialSeen.has(n.id));
 if((initialized&&joined.length)||socialNew.length){const a=$('#alert');a.hidden=false;a.textContent=socialNew.length?socialNew[0].nickname+'关注了你，去个人中心查看并回关':(names[joined[0]]||'交易伙伴')+'的 MT5 已连接，开始盯盘';beep();clearTimeout(window.alertTimer);window.alertTimer=setTimeout(()=>a.hidden=true,12000);}
 socialSeen=new Set(social.map(n=>n.id));
 seen=new Set(state.events.map(e=>e.id));notificationSubjects=new Set(members.filter(m=>m.can_view!==false).map(m=>m.id));initialized=true;
}
let refreshPending=false;
function loadingBoard(message){
 $('#accounts').setAttribute('aria-busy','true');
 $('#accounts').innerHTML=loadingAccounts;
 $('#notice').innerHTML=`<span class="ticker-label">交易动态</span><div class="ticker-window"><span class="ticker-placeholder">${esc(message)}</span></div>`;
 $('#pool-count').textContent='正在同步';
 $('#pool').innerHTML=`<div class="empty pool-empty">${esc(message)}</div>`;
 $('#messages').innerHTML='';
 $('#sender-label').textContent='正在确认账户';
 $('#message-form button').disabled=true;
}
const loadingAccounts=$('#accounts').innerHTML;
$('#message-form button').disabled=true;
async function refresh(){
 if(demo||refreshPending)return;
 refreshPending=true;
 try{const r=await fetch('/api/state?view=board',{cache:'no-store'});if(r.status===401){location.replace('/login');return;}if(!r.ok)throw new Error();const next=await r.json();if(demo)return;state=next;render();$('#message-form button').disabled=false;}
 catch{state=null;initialized=false;loadingBoard('暂时无法读取数据，正在重试…');}
 finally{refreshPending=false;}
}
$('#message-form').onsubmit=async e=>{e.preventDefault();const input=$('#message'), text=input.value.trim();if(!text)return;const b=e.target.querySelector('button');b.disabled=true;$('#form-error').textContent='';try{if(demo){state.messages.push({id:'demo-'+(++demoSequence),person:viewer,text,created:Date.now()/1000});render();}else{const r=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({person:viewer,text})});const result=await r.json();if(r.status===401){location.replace('/login');return;}if(!r.ok)throw new Error(result.error);await refresh();}input.value='';$('#messages').scrollTop=$('#messages').scrollHeight;}catch(err){$('#form-error').textContent=err.message||'发送失败，请重试';}finally{b.disabled=false;}};
refresh();setInterval(refresh,2000);

const memberHeightObserver=new ResizeObserver(entries=>{const height=entries[0]?.borderBoxSize?.[0]?.blockSize ?? $('#accounts').getBoundingClientRect().height;$('.workspace').style.setProperty('--member-column-height',height+'px');});
memberHeightObserver.observe($('#accounts'));
