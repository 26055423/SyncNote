const $=s=>document.querySelector(s);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed=n=>(n>=0?'+':'')+money(n);
// 显示时区统一由 api.js 的 syncnote* 函数处理，不要在页面里再写死 +8。
const dateKey=t=>window.syncnoteDateKey?window.syncnoteDateKey(t):(t==null?'':new Date(t*1000).toISOString().slice(0,10));
const stamp=t=>window.syncnoteStamp?window.syncnoteStamp(t):(t==null?'时间待校准':new Date(t*1000).toLocaleString('zh-CN',{hour12:false}));
const nowKey=()=>dateKey(Date.now()/1000);
const openStamp=t=>{const raw=t.opened_server;return raw>0&&t.closed!=null?stamp(raw-(t.closed_server-t.closed)):'尚未同步';};
const params=new URLSearchParams(location.search),demo=false;
let person=params.get('person')||'', month=nowKey().slice(0,7), day=nowKey(), periodTouched=false, state=null, reviewFilter='all', refreshing=false, journalUnavailable=false;
$('#month-picker').value=month;
function stats(rows){return rows.reduce((s,t)=>{s.count++;s.win+=Math.max(0,t.profit);s.loss+=Math.min(0,t.profit);s.net+=t.profit;return s;},{count:0,win:0,loss:0,net:0});}
function demoState(){const now=Date.now()/1000,year=Number(month.slice(0,4)),m=Number(month.slice(5));const history=[];for(let i=1;i<=Math.min(26,new Date(year,m,0).getDate());i++){if(i%7===0)continue;for(let j=0;j<(i%3)+1;j++){const buy=(i+j)%2===0;history.push({ticket:'DEMO-'+i+'-'+j,symbol:'XAUUSD',side:buy?'buy':'sell',volume:.1,open:2650,close:2650+(buy?1:-1)*((i+j)%4===0?-8:12),profit:(i+j)%4===0?-80:120,closed:Date.UTC(year,m-1,i,6+j,15)/1000});}}return {members:[{id:'me',name:'本人'},{id:'friend',name:'朋友'}],snapshots:{me:{updated:now,data:{currency:'USD',history}},friend:{updated:now,data:{currency:'USD',history:history.map(t=>({...t,profit:t.profit*.5,volume:.05}))}}}};}
function summaryHTML(s,currency){return `<div><span>交易笔数</span><strong>${s.count}<small> 笔</small></strong></div><div><span>盈利总额</span><strong class="positive">${signed(s.win)}</strong></div><div><span>亏损总额</span><strong class="negative">${signed(s.loss)}</strong></div><div><span>净盈亏 · ${esc(currency)}</span><strong class="${s.net>=0?'positive':'negative'}">${signed(s.net)}</strong></div>`;}
function render(){
 const members=(state.members||[]).filter(m=>m.can_view!==false);if(!person)person=state.user.id;const member=members.find(m=>m.id===person);if(!member){$('#history-notice').textContent='你没有权限查看这位成员的交易数据。';for(const id of ['trade-list','calendar','month-summary','year-summary','selected-day-summary','mistake-groups'])$('#'+id).innerHTML='';$('#mistake-panel').hidden=true;$('#review-filters').hidden=true;return;}
 const name=members.find(m=>m.id===person).name,entry=state.snapshots[person],currency=entry?.data.currency||'USD',rows=entry?.data.history||[];
 $('#history-title').textContent=name+'的交易记录';document.title=name+'的交易记录 · 同频';
 const own=person===state.user.id,canReview=own?member.can_review!==false:member.can_review===true,canClassify=canReview&&window.tradeJournal.canView;
 const reviewed=new Set(canReview?(Array.isArray(member.reviewed)?member.reviewed:own&&Array.isArray(state.reviewed)?state.reviewed:[]).map(String):[]);
 const reviewCounts=items=>({done:items.filter(t=>reviewed.has(String(t.ticket))).length,pending:items.filter(t=>!reviewed.has(String(t.ticket))).length});
 if(!canReview)reviewFilter='all';
 $('#review-filters').hidden=!canReview;window.tradeJournal.render(rows,canClassify,reviewed);
 const pendingTimes=rows.filter(t=>t.closed==null),latestClosed=rows.reduce((latest,t)=>Math.max(latest,Number(t.closed)||0),0);
 const historySynced=typeof entry?.history_synced_at==='number'&&Number.isFinite(entry.history_synced_at)&&entry.history_synced_at>0?entry.history_synced_at:null;
 let notice=demo?'演示模式 · 日历和交易记录均为示例。':rows.length+' 笔云端平仓记录 · 最后历史同步：'+(historySynced?stamp(historySynced):'尚无分页同步确认')+' · 最新平仓：'+(latestClosed?stamp(latestClosed):'暂无');
 if(own&&state.user.auto_history_sync===false)notice+=' · 网页自动续传未开启';
 if(pendingTimes.length)notice+=' · '+pendingTimes.length+' 笔历史时间待校准，未计入日/月/年统计';
 if(journalUnavailable&&canReview)notice+=' · 复盘分类暂不可用，已复盘状态和交易记录照常显示，正在重试';
 $('#history-notice').classList.toggle('demo',demo);$('#history-notice').innerHTML=esc(notice)+(own?'<a class="history-sync-link" href="/chart?view=live&amp;panel=sync">前往交易台同步</a>':'');
 // 首次打开落到最新一笔成交，而不是“今天正好没单”的空页面。
 if(!periodTouched&&rows.length){
  const latest=rows.filter(t=>t.closed!=null).sort((a,b)=>b.closed-a.closed)[0];
  if(latest){month=dateKey(latest.closed).slice(0,7);day=dateKey(latest.closed);$('#month-picker').value=month;}
 }
 const monthRows=rows.filter(t=>dateKey(t.closed).startsWith(month)),yearRows=rows.filter(t=>dateKey(t.closed).startsWith(month.slice(0,4)));
 $('#month-title').textContent=month.replace('-','年')+'月';$('#year-title').textContent=month.slice(0,4)+'年';$('#month-summary').innerHTML=summaryHTML(stats(monthRows),currency);$('#year-summary').innerHTML=summaryHTML(stats(yearRows),currency);
 const [y,m]=month.split('-').map(Number),days=new Date(Date.UTC(y,m,0)).getUTCDate(),offset=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7;
 let html='<div class="calendar-pad"></div>'.repeat(offset);
 for(let i=1;i<=days;i++){const key=month+'-'+String(i).padStart(2,'0'),items=monthRows.filter(t=>dateKey(t.closed)===key),s=stats(items),counts=reviewCounts(items);html+=`<button class="calendar-day ${s.count?'has-trades':''} ${day===key?'active-day':''}" data-day="${key}" aria-pressed="${day===key}"><b>${i}</b>${s.count?`<span>${s.count} 笔</span><strong class="${s.net>=0?'positive':'negative'}">${signed(s.net)}</strong>${canReview?`<span class="calendar-review-count"><span class="reviewed-count">已复盘 ${counts.done}</span><span class="unreviewed-count">未复盘 ${counts.pending}</span></span>`:''}`:'<span class="no-trades">无交易</span>'}</button>`;}
 $('#calendar').innerHTML=html;
 const selectedRows=day?monthRows.filter(t=>dateKey(t.closed)===day):monthRows,selected=stats(selectedRows),selectedReviews=reviewCounts(selectedRows);
 $('#selected-day-summary').innerHTML=`<b>${day||month} · ${selected.count} 笔</b><div><span class="positive">盈利 ${signed(selected.win)}</span><span class="negative">亏损 ${signed(selected.loss)}</span><span class="${selected.net>=0?'positive':'negative'}">净盈亏 ${signed(selected.net)}</span></div>${canReview?`<div><span class="reviewed-count">已复盘 ${selectedReviews.done} 笔</span><span class="unreviewed-count">未复盘 ${selectedReviews.pending} 笔</span></div>`:''}`;
 $('#calendar').querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{day=b.dataset.day;periodTouched=true;render();});
 const issue=canClassify?window.tradeJournal.filter:'';
 const classifiedRows=selectedRows.filter(t=>!issue||window.tradeJournal.matches(t));
 const matchesReview=t=>reviewFilter==='all'||(reviewFilter==='reviewed')===reviewed.has(String(t.ticket));
 const datedRows=classifiedRows.filter(matchesReview),pendingRows=pendingTimes.filter(t=>(!issue||window.tradeJournal.matches(t))&&matchesReview(t));
 const list=[...datedRows.slice().sort((a,b)=>b.closed-a.closed),...pendingRows];
 const counts=reviewCounts(classifiedRows),filterCounts={all:classifiedRows.length,reviewed:counts.done,unreviewed:counts.pending};
 $('#review-filters').querySelectorAll('[data-review-filter]').forEach(b=>{const value=b.dataset.reviewFilter;b.classList.toggle('selected',value===reviewFilter);b.setAttribute('aria-pressed',String(value===reviewFilter));b.textContent=({all:'全部',reviewed:'已复盘',unreviewed:'未复盘'}[value])+' '+filterCounts[value];b.onclick=()=>{reviewFilter=value;periodTouched=true;render();};});
 $('#list-title').textContent=(day||month)+(issue?' · 分类：'+issue:'')+(reviewFilter==='all'?'':' · '+(reviewFilter==='reviewed'?'已复盘':'未复盘'))+' · 交易明细（'+datedRows.length+' 笔）'+(pendingRows.length?' · 时间待校准（'+pendingRows.length+' 笔）':'');$('#clear-day').hidden=!day;$('#clear-day').textContent=pendingTimes.length?'查看整月及待校准记录':'查看整月';
 $('#trade-list').innerHTML=list.length?`<table><thead><tr><th>交易时间 · 显示时区</th><th>品种 / 方向</th><th>手数</th><th>开仓价</th><th>平仓价</th><th class="profit-column">已实现盈亏 · ${esc(currency)}</th><th class="review-column">复盘状态</th></tr></thead><tbody>${list.map(t=>`<tr><td class="trade-times"><div><span>开仓</span> ${openStamp(t)}</div><div><span>平仓</span> ${stamp(t.closed)}</div></td><td>${esc(t.symbol)} <span class="side ${t.side==='sell'?'sell':''}">${t.side==='sell'?'卖出':'买入'}</span></td><td>${esc(t.volume)}</td><td>${money(t.open)}</td><td>${money(t.close)}</td><td class="profit-column ${t.profit>=0?'positive':'negative'}">${signed(t.profit)}</td><td class="review-column">${canReview?`<button class="review-order ${reviewed.has(String(t.ticket))?'is-reviewed':'is-unreviewed'}" data-review="${esc(t.ticket)}">${reviewed.has(String(t.ticket))?'✓ 已复盘':'○ 未复盘'}</button>`:'<span class="levels">未分享</span>'}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">当前日期和筛选条件下没有已同步的交易记录</div>';
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
function changeMonth(value){if(!/^\d{4}-\d{2}$/.test(value)||+value.slice(5)<1||+value.slice(5)>12)return;periodTouched=true;month=value;day=month===nowKey().slice(0,7)?nowKey():month+'-01';$('#month-picker').value=month;render();}
function shift(delta){let [y,m]=month.split('-').map(Number);const date=new Date(Date.UTC(y,m-1+delta,1));changeMonth(date.toISOString().slice(0,7));}
$('#prev-month').onclick=()=>shift(-1);$('#next-month').onclick=()=>shift(1);$('#this-month').onclick=()=>changeMonth(nowKey().slice(0,7));$('#month-picker').onchange=e=>changeMonth(e.target.value);$('#clear-day').onclick=()=>{day=null;periodTouched=true;render();};
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{
  if(demo){state=demoState();render();}
  else{
   const next=await window.syncnoteAPI('/api/state'),target=person||next.user.id,member=(next.members||[]).find(m=>m.id===target);
   const canLoadJournal=member&&member.can_view!==false&&member.can_review!==false;
   state=next;journalUnavailable=false;
   if(!canLoadJournal)window.tradeJournal.clear();
   render(); // Trade rows and authoritative review state never wait for the notes request.
   if(canLoadJournal){
    try{await window.tradeJournal.load(target,target===next.user.id);}
    catch{window.tradeJournal.clear();journalUnavailable=true;}
    render();
   }
  }
 }catch{
  if(!state){$('#trade-list').innerHTML='';$('#calendar').innerHTML='';$('#month-summary').innerHTML='';$('#year-summary').innerHTML='';}
  $('#history-notice').textContent=state?'连接中断，保留上次加载的历史记录，正在重试。':'连接中断，正在重试加载历史记录。';
 }finally{refreshing=false;}
}
refresh();setInterval(()=>{if(!demo)refresh();},5000);
