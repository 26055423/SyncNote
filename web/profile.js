const $=s=>document.querySelector(s),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let profile=null;
const api=window.syncnoteAPI;
function feedback(form,text,error=false){const p=form.querySelector('.form-feedback');p.textContent=text;p.classList.toggle('error',error);}
function memberRow(u,relation,flags){const rel=relation||'none';const f=flags||{};const id=esc(u.id);let btn='';if(rel==='friend'){btn='<button data-target="'+id+'" data-action="friends/hide" data-on="'+(f.hide?'0':'1')+'">'+(f.hide?'允许TA看我的复盘':'不让TA看我的复盘')+'</button>'+'<button data-target="'+id+'" data-action="friends/mute" data-on="'+(f.mute?'0':'1')+'">'+(f.mute?'恢复看TA的复盘':'不看TA的复盘')+'</button>'+'<button data-target="'+id+'" data-action="friends/remove">删除好友</button>'+'<button data-target="'+id+'" data-action="friends/block">拉黑</button>';}else if(rel==='blocked'){btn='<button data-target="'+id+'" data-action="friends/unblock">解除拉黑</button>';}else if(rel==='incoming'){btn='<button data-target="'+id+'" data-action="friends/accept" class="primary">通过</button><button data-target="'+id+'" data-action="friends/reject">拒绝</button>';}else if(rel==='outgoing'){btn='<button data-target="'+id+'" data-action="friends/remove">取消申请</button>';}else if(rel==='blocked_me'){btn='<button disabled>对方已拉黑你</button>';}else if(rel==='deleted_me'||rel==='deleted'){btn='<button data-target="'+id+'" data-action="friends/request" class="primary">重新加好友</button>';}else{btn=u.allow_follow?'<button data-target="'+id+'" data-action="friends/request" class="primary">加好友</button>':'<button disabled>不接受好友申请</button>';}const note=rel==='friend'?' · 好友':rel==='outgoing'?' · 等待对方通过':rel==='incoming'?' · 申请加你为好友':rel==='blocked'?' · 已拉黑':rel==='blocked_me'?' · 对方已拉黑你':' · 已删除';return '<div class="partner-row"><div class="avatar">'+avatarMarkup(u.avatar,u.nickname.slice(0,1))+'</div><div class="partner-info"><b>'+esc(u.nickname)+'</b><small>@'+esc(u.username)+note+'</small><small>'+(u.share_data?'交易数据已开放':'交易数据未开放')+'</small></div><div class="partner-actions">'+btn+'</div></div>';}
function bind(container){container.querySelectorAll('[data-target]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const body={target:b.dataset.target};if(b.dataset.on!==undefined)body.on=b.dataset.on==='1';await api('/api/'+b.dataset.action,body);await load(false);if($('#search').value.trim().length>=2)await search();}catch(e){$('#page-feedback').textContent=e.message;}finally{b.disabled=false;}});}
async function load(fill=true){profile=await api('/api/profile');const u=profile.user;if(u.role==='admin'){ $('#invite-panel').hidden=false;await loadInvite();}$('#profile-title').textContent=u.nickname+'的个人中心';$('#profile-username').textContent='@'+u.username;if(fill){$('#nickname').value=u.nickname;$('#avatar').value=u.avatar;renderAvatarPicker();$('#bio').value=u.bio;$('#allow-follow').checked=!!u.allow_follow;$('#share-data').checked=!!u.share_data;$('#share-reviews').checked=!!u.share_reviews;}
const mt=profile.mt5;$('#assistant-status').textContent=mt.online?'✓ MT5 已连接，正在盯盘':mt.configured?'已绑定，等待 MT5 同步':'尚未连接';$('#unlink').disabled=!mt.configured;
const friends=profile.friends||[],incoming=profile.incoming||[],blocked=profile.blocked||[];$('#following-count').textContent=friends.length+' 人';$('#followers-count').textContent=incoming.length+' 个';$('#blocked-count').textContent=blocked.length+' 人';$('#following').innerHTML=friends.map(v=>memberRow(v,'friend',v)).join('')||'<p class="profile-hint">还没有好友，先在上方查找伙伴并发送好友申请。</p>';$('#followers').innerHTML=incoming.map(v=>memberRow(v,'incoming')).join('')||'<p class="profile-hint">没有待通过的好友申请。</p>';$('#blocked').innerHTML=blocked.map(v=>memberRow(v,'blocked')).join('')||'<p class="profile-hint">黑名单是空的。</p>';bind($('#following'));bind($('#followers'));bind($('#blocked'));}
function save(form,path,getData,after){form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button:not([type=button])');b.disabled=true;try{const data=getData();await api(path,data);feedback(form,'已保存');if(after)after();await load(false);}catch(err){feedback(form,err.message,true);}finally{b.disabled=false;}};}
save($('#details-form'),'/api/profile',()=>({nickname:$('#nickname').value,avatar:$('#avatar').value,bio:$('#bio').value}));save($('#settings-form'),'/api/settings',()=>({allow_follow:$('#allow-follow').checked,share_data:$('#share-data').checked,share_reviews:$('#share-reviews').checked}));
// 隐私开关不适合“改完忘了点保存”：变更后自动落库，按钮只作为显式确认。
let settingsTimer=null;
$('#settings-form').addEventListener('change',()=>{
 const form=$('#settings-form');
 if(settingsTimer)clearTimeout(settingsTimer);
 settingsTimer=setTimeout(async()=>{
  try{
   await api('/api/settings',{allow_follow:$('#allow-follow').checked,share_data:$('#share-data').checked,share_reviews:$('#share-reviews').checked});
   feedback(form,'已自动保存');
   await load(false);
  }catch(err){feedback(form,err.message,true);}
 },500);
});save($('#password-form'),'/api/password',()=>{if($('#new-password').value!==$('#confirm-password').value)throw Error('两次新密码不一致');return {current_password:$('#current-password').value,new_password:$('#new-password').value};},()=>$('#password-form').reset());
async function search(){const r=await api('/api/users?q='+encodeURIComponent($('#search').value.trim()));$('#search-results').innerHTML=r.users.map(u=>memberRow(u,u.relation)).join('')||'<p class="profile-hint">没有找到匹配用户。</p>';bind($('#search-results'));}
$('#search-form').onsubmit=async e=>{e.preventDefault();try{await search();feedback(e.target,'');}catch(err){feedback(e.target,err.message,true);}};
$('#unlink').onclick=async()=>{if(!confirm('解除后本机 EA / bridge_push 会立即断开，需要重新生成连接码才能同步。确定解除？'))return;try{await api('/api/mt5/unlink',{});await load(false);}catch(e){$('#page-feedback').textContent=e.message;}};
$('#logout').onclick=async()=>{try{await api('/api/logout',{});location.replace('/login');}catch(e){$('#page-feedback').textContent=e.message;}};
$('#assistant-panel').innerHTML=assistantPanel();if(typeof bindAssistant==='function')bindAssistant();
load().catch(e=>$('#page-feedback').textContent=e.message);setInterval(()=>load(false).catch(()=>{}),10000);

function renderAvatarPicker(){const box=$('#profile-avatar-picker');box.innerHTML=Array.from({length:12},(_,i)=>`<button type="button" class="avatar-choice ${$('#avatar').value==='avatar'+(i+1)?'selected':''}" data-avatar="avatar${i+1}" aria-label="选择头像 ${i+1}">${avatarMarkup('avatar'+(i+1))}</button>`).join('');box.querySelectorAll('[data-avatar]').forEach(b=>b.onclick=()=>{$('#avatar').value=b.dataset.avatar;renderAvatarPicker();});}

api('/api/notifications/read',{}).catch(()=>{});

async function loadInvite(){const r=await api('/api/invite');$('#current-invite').value=r.code;}
$('#copy-invite').onclick=async()=>{try{await loadInvite();await navigator.clipboard.writeText($('#current-invite').value);$('#invite-feedback').textContent='已复制最新邀请码';}catch(e){$('#invite-feedback').textContent='请选中邀请码手动复制';}};
$('#rotate-invite').onclick=async()=>{if(!confirm('更换后旧邀请码立即失效，已发出的邀请链接将无法注册。确定更换？'))return;const b=$('#rotate-invite');b.disabled=true;try{const r=await api('/api/invite/rotate',{});$('#current-invite').value=r.code;$('#invite-feedback').textContent='已更换，旧邀请码已失效';}catch(e){$('#invite-feedback').textContent=e.message;}finally{b.disabled=false;}};
