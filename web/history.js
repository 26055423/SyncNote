const $=s=>document.querySelector(s);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed=n=>(n>=0?'+':'')+money(n);
const dateKey=t=>t==null?'':new Date(t*1000+8*3600000).toISOString().slice(0,10);
const openStamp=t=>{const raw=t.opened_server;return raw>0&&t.closed!=null?stamp(raw-(t.closed_server-t.closed)):'尚未同步';};
const stamp=t=>t==null?'待时区校准':new Date(t*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const params=new URLSearchParams(location.search),demo=false;
let person=params.get('person')||'', month=dateKey(Date.now()/1000).slice(0,7), day=dateKey(Date.now()/1000), state=null;
$('#month-picker').value=month;
function stats(rows){return rows.reduce((s,t)=>{s.count++;s.win+=Math.max(0,t.profit);s.loss+=Math.min(0,t.profit);s.net+=t.profit;return s;},{count:0,win:0,loss:0,net:0});}
function demoState(){const now=Date.now()/1000,year=Number(month.slice(0,4)),m=Number(month.slice(5));const history=[];for(let i=1;i<=Math.min(26,new Date(year,m,0).getDate());i++){if(i%7===0)continue;for(let j=0;j<(i%3)+1;j++){const buy=(i+j)%2===0;history.push({ticket:'DEMO-'+i+'-'+j,symbol:'XAUUSD',side:buy?'buy':'sell',volume:.1,open:2650,close:2650+(buy?1:-1)*((i+j)%4===0?-8:12),profit:(i+j)%4===0?-80:120,closed:Date.UTC(year,m-1,i,6+j,15)/1000});}}return {members:[{id:'me',name:'本人'},{id:'friend',name:'朋友'}],snapshots:{me:{updated:now,data:{currency:'USD',history}},friend:{updated:now,data:{currency:'USD',history:history.map(t=>({...t,profit:t.profit*.5,volume:.05}))}}}};}
function summaryHTML(s,currency){return `<div><span>交易笔数</span><strong>${s.count}<small> 笔</small></strong></div><div><span>盈利总额</span><strong class="positive">${signed(s.win)}</strong></div><div><span>亏损总额</span><strong class="negative">${signed(s.loss)}</strong></div><div><span>净盈亏 · ${esc(currency)}</span><strong class="${s.net>=0?'positive':'negative'}">${signed(s.net)}</strong></div>`;}
function render(){
 const members=(state.members||[]).filter(m=>m.can_view!==false);if(!person)person=state.user.id;const member=members.find(m=>m.id===person);if(!member){$('#history-notice').textContent='你没有权限查看这位成员的交易数据。';$('#trade-list').innerHTML='';$('#calendar').innerHTML='';$('#month-summary').innerHTML='';$('#year-summary').innerHTML='';return;}
 const name=members.find(m=>m.id===person).name,entry=state.snapshots[person],currency=entry?.data.currency||'USD',rows=entry?.data.history||[];
 $('#history-title').textContent=name+'的交易记录';document.title=name+'的交易记录 · 同频';
 $('#history-notice').classList.toggle('demo',demo);$('#history-notice').textContent=demo?'演示模式 · 日历和交易记录均为示例。':entry?'仅统计已同步的平仓记录 · 最后同步 '+stamp(entry.updated)+(Date.now()/1000-entry.updated>15?' · 数据可能过期':''):'尚未接入 MT5 · 暂无交易记录，统计为 0。';
 const own=person===state.user.id;window.tradeJournal.render(rows,window.tradeJournal.canView);
 const pendingTimes=rows.filter(t=>t.closed==null);if(pendingTimes.length)$('#history-notice').textContent+=' · '+pendingTimes.length+' 笔历史时间待校准，未计入日/月/年统计';
 const monthRows=rows.filter(t=>dateKey(t.closed).startsWith(month)),yearRows=rows.filter(t=>dateKey(t.closed).startsWith(month.slice(0,4)));
 $('#month-title').textContent=month.replace('-','年')+'月';$('#year-title').textContent=month.slice(0,4)+'年';$('#month-summary').innerHTML=summaryHTML(stats(monthRows),currency);$('#year-summary').innerHTML=summaryHTML(stats(yearRows),currency);
 const [y,m]=month.split('-').map(Number),days=new Date(Date.UTC(y,m,0)).getUTCDate(),offset=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7;
 let html='<div class="calendar-pad"></div>'.repeat(offset);
 for(let i=1;i<=days;i++){const key=month+'-'+String(i).padStart(2,'0'),s=stats(monthRows.filter(t=>dateKey(t.closed)===key));html+=`<button class="calendar-day ${s.count?'has-trades':''} ${day===key?'active-day':''}" data-day="${key}" aria-pressed="${day===key}"><b>${i}</b>${s.count?`<span>${s.count} 笔</span><strong class="${s.net>=0?'positive':'negative'}">${signed(s.net)}</strong>`:'<span class="no-trades">无交易</span>'}</button>`;}
 $('#calendar').innerHTML=html;
 const selected=day?stats(monthRows.filter(t=>dateKey(t.closed)===day)):stats(monthRows);
 $('#selected-day-summary').innerHTML=`<b>${day||month} · ${selected.count} 笔</b><div><span class="positive">盈利 ${signed(selected.win)}</span><span class="negative">亏损 ${signed(selected.loss)}</span><span class="${selected.net>=0?'positive':'negative'}">净盈亏 ${signed(selected.net)}</span></div>`;
 $('#calendar').querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{window.tradeJournal.filter='';day=b.dataset.day;render();});
 const issue=window.tradeJournal.canView?window.tradeJournal.filter:'';
 const datedRows=issue?rows.filter(t=>window.tradeJournal.matches(t)&&t.closed!=null):(day?monthRows.filter(t=>dateKey(t.closed)===day):monthRows);
 const list=[...datedRows.slice().sort((a,b)=>b.closed-a.closed),...pendingTimes.filter(t=>!issue||window.tradeJournal.matches(t))];
 $('#list-title').textContent=(issue?'分类：'+issue+' · 全部日期':(day||month))+' · 交易明细（'+datedRows.length+' 笔）'+(pendingTimes.length?' · 时间待校准（'+pendingTimes.length+' 笔）':'');$('#clear-day').hidden=!day||!!issue;$('#clear-day').textContent=pendingTimes.length?'查看整月及待校准记录':'查看整月';
 $('#trade-list').innerHTML=list.length?`<table><thead><tr><th>交易时间 · 北京时间</th><th>品种 / 方向</th><th>手数</th><th>开仓价</th><th>平仓价</th><th class="profit-column">已实现盈亏 · ${esc(currency)}</th><th class="review-column">复盘</th></tr></thead><tbody>${list.map(t=>`<tr><td class="trade-times"><div><span>开仓</span> ${openStamp(t)}</div><div><span>平仓</span> ${stamp(t.closed)}</div></td><td>${esc(t.symbol)} <span class="side ${t.side==='sell'?'sell':''}">${t.side==='sell'?'卖出':'买入'}</span></td><td>${esc(t.volume)}</td><td>${money(t.open)}</td><td>${money(t.close)}</td><td class="profit-column ${t.profit>=0?'positive':'negative'}">${signed(t.profit)}</td><td class="review-column">${window.tradeJournal.canView?`<button class="review-order" data-review="${esc(t.ticket)}">复盘</button>`:'<span class="levels">未分享</span>'}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">这段时间没有已同步的交易记录</div>';
 $('#trade-list').querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>{const t=rows.find(t=>String(t.ticket)===b.dataset.review);if(t)openChart(t,person);});
}
window.renderJournal=render;
// 复盘跳到图表页：带上这笔交易和开仓时间，图表打开就定位到那根 K 线。
function openChart(t,person){
 const qs=new URLSearchParams({person,ticket:String(t.ticket)});
 const opened=t.closed!=null&&t.opened_server!=null&&t.closed_server!=null?t.closed-(t.closed_server-t.opened_server):t.closed;
 if(opened>0)qs.set('t',String(Math.round(opened)));
 location.href='/chart?'+qs.toString();
}
function changeMonth(value){if(!/^\d{4}-\d{2}$/.test(value)||+value.slice(5)<1||+value.slice(5)>12)return;window.tradeJournal.filter='';month=value;day=month===dateKey(Date.now()/1000).slice(0,7)?dateKey(Date.now()/1000):month+'-01';$('#month-picker').value=month;render();}
function shift(delta){let [y,m]=month.split('-').map(Number);const date=new Date(Date.UTC(y,m-1+delta,1));changeMonth(date.toISOString().slice(0,7));}
$('#prev-month').onclick=()=>shift(-1);$('#next-month').onclick=()=>shift(1);$('#this-month').onclick=()=>changeMonth(dateKey(Date.now()/1000).slice(0,7));$('#month-picker').onchange=e=>changeMonth(e.target.value);$('#clear-day').onclick=()=>{day=null;render();};
async function refresh(){try{if(demo){state=demoState();}else{const r=await fetch('/api/state',{cache:'no-store'});if(r.status===401){location.replace('/login');return;}if(!r.ok)throw Error();state=await r.json();await window.tradeJournal.load(person||state.user.id,(person||state.user.id)===state.user.id);}render();}catch{if(!state){$('#trade-list').innerHTML='';$('#calendar').innerHTML='';$('#month-summary').innerHTML='';$('#year-summary').innerHTML='';}$('#history-notice').textContent=state?'连接中断，保留上次加载的历史记录，正在重试。':'连接中断，正在重试加载历史记录。';}}
refresh();setInterval(()=>{if(!demo)refresh();},5000);
