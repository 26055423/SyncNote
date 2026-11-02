/**
 * 个人中心 →「图表偏好」：主题 / 显示时区 / 图表语言。
 *
 * 和交易台的「账户」浮层写同一份 `localStorage['sn-ui.v1']`，
 * 所以两边改完立刻一致（刷新页面生效；主题会即时写到 <html data-theme>）。
 * 时区列表的真源是 web/chart-src/src/lib/zones.ts，这里只镜像 id 与短名。
 */
(function () {
  const KEY = 'sn-ui.v1';
  const ZONES = [
    ['auto', '自动（跟随系统）'],
    ['Asia/Shanghai', '北京 UTC+8'],
    ['Etc/UTC', 'UTC'],
    ['America/New_York', '纽约（美东）'],
    ['Europe/London', '伦敦'],
    ['Europe/Berlin', '法兰克福'],
    ['Asia/Tokyo', '东京'],
    ['Asia/Dubai', '迪拜'],
    ['Asia/Singapore', '新加坡'],
    ['Australia/Sydney', '悉尼'],
  ];

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      return {};
    }
  };
  const save = (patch) => {
    const next = { ...read(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    if (next.theme === 'light' || next.theme === 'dark') document.documentElement.dataset.theme = next.theme;
    return next;
  };

  document.addEventListener('DOMContentLoaded', () => {
    const theme = document.getElementById('pref-theme');
    const zone = document.getElementById('pref-timezone');
    const locale = document.getElementById('pref-locale');
    const note = document.getElementById('pref-feedback');
    if (!theme || !zone || !locale) return;

    zone.innerHTML = ZONES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');

    const current = read();
    theme.value = current.theme === 'light' ? 'light' : 'dark';
    locale.value = current.chartLocale === 'en' ? 'en' : 'zh-Hans';
    zone.value = ZONES.some(([id]) => id === current.timezone) ? current.timezone : 'auto';

    const applied = () => {
      note.textContent = '已保存到本机。回到交易台刷新一次即可看到效果。';
      note.classList.remove('is-error');
    };
    theme.onchange = () => {
      save({ theme: theme.value });
      applied();
    };
    zone.onchange = () => {
      save({ timezone: zone.value });
      applied();
    };
    locale.onchange = () => {
      save({ chartLocale: locale.value });
      applied();
    };
  });
})();
