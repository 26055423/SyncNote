const $=s=>document.querySelector(s),register=location.pathname==='/register',next=(new URLSearchParams(location.search).get('next')||'').trim(),afterLogin=v=>(next.startsWith('/')&&!next.startsWith('//')?next:(v.user.onboarding_step<4?'/welcome':'/'));
if(register){document.title='注册 · 同频';$('#auth-title').textContent='创建你的交易账号';$('#auth-intro').textContent='目前仅接受邀请注册，请向管理员获取邀请码。';$('#invite-field').hidden=false;$('#invite-code').required=true;$('#nickname-field').hidden=true;$('#confirm-field').hidden=false;$('#nickname').required=false;$('#confirm-password').required=true;$('#password').autocomplete='new-password';$('#auth-submit').textContent='注册并进入';}
const adminMode=next==='/admin';
if(adminMode){
  document.title='管理员登录 · 同频';
  $('#auth-title').textContent='管理员登录';
  $('#auth-intro').textContent='这里进入管理后台，仅限管理员本人。登录后还需要再验证一次密码。';
  const badge=document.createElement('p');badge.className='admin-badge';badge.textContent='管理后台 · 仅管理员';
  document.querySelector('.auth-panel').prepend(badge);
  document.body.classList.add('admin-login');
  $('#auth-switch').hidden=true;
}
$('#auth-switch').innerHTML=register?'已有账号？<a href="/login">去登录</a>':'还没有账号？<a href="/register">先注册</a>';
fetch('/api/me').then(r=>{if(r.ok)r.json().then(v=>location.replace(afterLogin(v)));}).catch(()=>{});
$('#auth-form').onsubmit=async e=>{e.preventDefault();const b=$('#auth-submit');$('#auth-error').textContent='';if(b.disabled)return;b.disabled=true;b.textContent=register?'正在注册…':'正在登录…';try{let v;if(register){v=await Registration.submit(Registration.validate());}else v=await window.SharedLogin.authenticate({username:$('#username').value,password:$('#password').value});location.replace(afterLogin(v));}catch(err){$('#auth-error').textContent=register?Registration.message(err):(err.message||'连接失败，请重试');}finally{b.disabled=false;b.textContent=register?'注册并进入':'登录';}};

if(register){Registration.prepare($('#auth-form'));window.SharedLogin.showChallenge()}
