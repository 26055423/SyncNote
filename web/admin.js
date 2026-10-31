/* 管理后台逻辑：先过 sudo，再管邀请码。所有请求都走同源 Cookie。 */

const $ = (id) => document.getElementById(id);

/* 两个页签：用户 / 邀请码 */
function showTab(name) {
  const target = name === 'users' ? 'users' : 'invites';
  for (const pane of document.querySelectorAll('.tab-pane')) {
    pane.hidden = pane.dataset.pane !== target;
  }
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('is-active', button.dataset.tab === target);
  }
  try {
    localStorage.setItem('sn-admin-tab', target);
  } catch {
    /* 忽略 */
  }
}

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}
showTab((() => {
  try {
    return localStorage.getItem('sn-admin-tab') || 'users';
  } catch {
    return 'users';
  }
})());

async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const type = response.headers.get('Content-Type') || '';
  const data = type.includes('application/json') ? await response.json() : {};
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(id, visible) {
  const node = $(id);
  if (node) node.hidden = !visible;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function fmtTime(seconds) {
  if (!seconds) return '—';
  const date = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const stateText = { unused: '未使用', used: '已使用', expired: '已过期', revoked: '已作废' };
let current = [];
const unusedCodes = () => current.filter((row) => row.state === 'unused' && row.code).map((row) => row.code);

function renderRows(invites) {
  const body = $('rows');
  body.innerHTML = '';
  show('list-empty', invites.length === 0);
  for (const item of invites) {
    const tr = document.createElement('tr');
    const cells = [item.batch || '—', item.note || '—'];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }

    const codeCell = document.createElement('td');
    if (item.code) {
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = item.code;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ghost';
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        await copyText(item.code);
        copy.textContent = '已复制';
        setTimeout(() => { copy.textContent = '复制'; }, 1200);
      });
      codeCell.appendChild(code);
      codeCell.appendChild(copy);
    } else {
      codeCell.textContent = item.state === 'used' ? '（已使用，明文已清除）' : '—';
      codeCell.className = 'muted';
    }
    tr.appendChild(codeCell);
    const stateCell = document.createElement('td');
    const state = document.createElement('span');
    state.className = `state ${item.state}`;
    state.textContent = stateText[item.state] || item.state;
    stateCell.appendChild(state);
    tr.appendChild(stateCell);

    for (const text of [item.used_name || '—', fmtTime(item.created), item.expires ? fmtTime(item.expires) : '永久']) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }

    const actionCell = document.createElement('td');
    if (item.state === 'unused') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.textContent = '作废';
      button.addEventListener('click', async () => {
        if (!confirm('确定作废这个邀请码？')) return;
        try {
          await call('/api/admin/invites/revoke', { id: item.id });
          await load();
        } catch (error) {
          show('list-error', true);
          $('list-error').textContent = error.message;
        }
      });
      actionCell.appendChild(button);
    }
    tr.appendChild(actionCell);
    body.appendChild(tr);
  }
}

function renderUsers(users) {
  const body = $('user-rows');
  body.innerHTML = '';
  show('user-empty', users.length <= 1);
  for (const user of users) {
    const tr = document.createElement('tr');
    for (const text of [user.username, user.nickname || '—', fmtTime(user.created)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    const synced = document.createElement('td');
    synced.textContent = user.synced ? fmtTime(user.synced) : '—';
    synced.className = 'muted';
    tr.appendChild(synced);

    const reviews = document.createElement('td');
    reviews.textContent = String(user.reviews ?? 0);
    tr.appendChild(reviews);

    const state = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `state ${user.locked ? 'expired' : user.role === 'admin' ? 'unused' : 'used'}`;
    badge.textContent = user.locked ? '已锁定' : user.role === 'admin' ? '管理员' : '正常';
    state.appendChild(badge);
    tr.appendChild(state);

    const action = document.createElement('td');
    if (user.role !== 'admin') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = user.locked ? 'primary' : 'ghost';
      button.textContent = user.locked ? '解锁' : '锁定';
      button.addEventListener('click', async () => {
        if (!user.locked && !confirm(`锁定 ${user.username}？会立即下线并禁止登录。`)) return;
        show('user-error', false);
        try {
          await call('/api/admin/users/lock', { id: user.id, locked: !user.locked });
          await load();
        } catch (error) {
          show('user-error', true);
          $('user-error').textContent = error.message;
        }
      });
      action.appendChild(button);
    }
    tr.appendChild(action);
    body.appendChild(tr);
  }
}

async function load() {
  show('list-error', false);
  try {
    const data = await call('/api/admin/invites');
    unlock();
    current = data.invites || [];
    renderRows(current);
    try {
      const people = await call('/api/admin/users');
      renderUsers(people.users || []);
    } catch (error) {
      show('user-error', true);
      $('user-error').textContent = error.message;
    }
  } catch (error) {
    if (error.status === 401) {
      location.replace('/login?next=/admin');
      return;
    }
    if (error.status === 403) {
      lock();
      return;
    }
    if (error.status === 404) {
      $('lock').hidden = true;
      $('panel').hidden = true;
      document.querySelector('.admin-main').insertAdjacentHTML('beforeend', '<p class="error">页面不存在。</p>');
      return;
    }
    show('list-error', true);
    $('list-error').textContent = error.message;
  }
}

function lock() {
  show('lock', true);
  show('panel', false);
  $('sudo-password').focus();
}

function unlock() {
  show('lock', false);
  show('panel', true);
}

$('sudo-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  show('sudo-error', false);
  try {
    await call('/api/admin/sudo', { password: $('sudo-password').value });
    $('sudo-password').value = '';
    await load();
  } catch (error) {
    show('sudo-error', true);
    $('sudo-error').textContent = error.message;
  }
});

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  show('create-error', false);
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const data = await call('/api/admin/invites', {
      count: Number($('count').value),
      note: $('note').value,
      expires_days: Number($('days').value),
    });
    const list = $('fresh-list');
    list.innerHTML = '';
    for (const code of data.codes) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = code;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ghost';
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        await copyText(code);
        copy.textContent = '已复制';
        setTimeout(() => { copy.textContent = '复制'; }, 1200);
      });
      li.appendChild(span);
      li.appendChild(copy);
      list.appendChild(li);
    }
    show('fresh', true);
    show('create-hint', true);
    await load();
  } catch (error) {
    show('create-error', true);
    $('create-error').textContent = error.message;
    if (error.status === 403) lock();
  } finally {
    button.disabled = false;
  }
});

$('copy-all').addEventListener('click', async () => {
  const codes = [...document.querySelectorAll('#fresh-list li span')].map((node) => node.textContent.trim());
  await copyText(codes.join('\n'));
  $('copy-all').textContent = '已复制';
  setTimeout(() => { $('copy-all').textContent = '复制全部'; }, 1200);
});

$('copy-unused').addEventListener('click', async () => {
  const codes = unusedCodes();
  if (!codes.length) {
    show('list-error', true);
    $('list-error').textContent = '没有未使用的邀请码';
    return;
  }
  await copyText(codes.join('\n'));
  $('copy-unused').textContent = `已复制 ${codes.length} 个`;
  setTimeout(() => { $('copy-unused').textContent = '复制全部未使用'; }, 1600);
});

$('download').addEventListener('click', () => {
  const codes = unusedCodes();
  if (!codes.length) {
    show('list-error', true);
    $('list-error').textContent = '没有未使用的邀请码';
    return;
  }
  const stampNow = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${stampNow.getFullYear()}${pad(stampNow.getMonth() + 1)}${pad(stampNow.getDate())}`;
  const body = [`# 同频邀请码 ${day}（共 ${codes.length} 个，一次性使用）`, ...codes, ''].join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
  link.download = `syncnote-invites-${day}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 3000);
});

$('refresh').addEventListener('click', () => void load());
$('refresh-users').addEventListener('click', () => void load());

void load();
