/* 对外分享页：只渲染一笔交易的冻结快照（摘要 + 笔记 + 一张收盘价折线）。 */
(function () {
  'use strict';

  var root = document.getElementById('share-root');
  var token = (location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/) || [])[1] || '';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function money(value) {
    var n = Number(value);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function stamp(seconds) {
    var n = Number(seconds);
    if (!isFinite(n) || n <= 0) return '—';
    var d = new Date(n * 1000);
    var pad = function (v) { return String(v).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function sideText(side) {
    return side === 'sell' ? '卖出' : side === 'buy' ? '买入' : String(side || '—');
  }

  /** 收盘价折线 + 开/平仓标记；timeframe 优先 M5，没有就 M1。 */
  function drawChart(charts, trade) {
    var order = ['M5', 'M1', 'M15', 'H1'];
    var tf = order.filter(function (key) { return charts && charts[key] && charts[key].length > 1; })[0];
    if (!tf) return '';
    var rows = charts[tf];
    var width = 820, height = 260, padL = 8, padR = 64, padT = 12, padB = 22;
    var closes = rows.map(function (row) { return Number(row[4]); });
    // 开/平仓价可能落在收盘价区间之外，把它俩也算进纵轴，否则标记会画到画布外。
    var bounds = closes.slice();
    [Number(trade && trade.price_open), Number(trade && trade.price_close)].forEach(function (price) {
      if (isFinite(price) && price > 0) bounds.push(price);
    });
    var min = Math.min.apply(null, bounds), max = Math.max.apply(null, bounds);
    if (!(max > min)) { max = min + 1; }
    var t0 = Number(rows[0][0]), t1 = Number(rows[rows.length - 1][0]);
    var span = Math.max(1, t1 - t0);
    var x = function (time) { return padL + (time - t0) / span * (width - padL - padR); };
    var y = function (price) { return padT + (max - price) / (max - min) * (height - padT - padB); };

    var points = rows.map(function (row, i) {
      var time = Number(row[0]) + (i === 0 ? 0 : 0);
      return x(time).toFixed(1) + ',' + y(closes[i]).toFixed(1);
    }).join(' ');

    var marks = '';
    var entry = Number(trade && trade.price_open), exit = Number(trade && trade.price_close);
    var opened = Number(trade && trade.opened), closed = Number(trade && trade.closed);
    if (isFinite(entry) && opened >= t0 && opened <= t1) {
      var mx = x(opened), my = y(entry);
      marks += '<line x1="' + mx.toFixed(1) + '" y1="' + padT + '" x2="' + mx.toFixed(1) + '" y2="' + (height - padB) + '" stroke="var(--accent)" stroke-dasharray="3 3" opacity=".7"/>'
        + '<circle cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="3.5" fill="var(--accent)"/>'
        + '<text x="' + (mx + 6).toFixed(1) + '" y="' + (my - 6).toFixed(1) + '" fill="var(--accent)" font-size="11">开仓 ' + money(entry) + '</text>';
    }
    if (isFinite(exit) && closed >= t0 && closed <= t1) {
      var nx = x(closed), ny = y(exit);
      marks += '<line x1="' + nx.toFixed(1) + '" y1="' + padT + '" x2="' + nx.toFixed(1) + '" y2="' + (height - padB) + '" stroke="var(--red)" stroke-dasharray="3 3" opacity=".7"/>'
        + '<circle cx="' + nx.toFixed(1) + '" cy="' + ny.toFixed(1) + '" r="3.5" fill="var(--red)"/>'
        + '<text x="' + Math.min(width - padR - 6, Math.max(6, nx - 78)).toFixed(1) + '" y="' + Math.min(height - padB - 4, Math.max(padT + 10, ny + 16)).toFixed(1) + '" fill="var(--red)" font-size="11">平仓 ' + money(exit) + '</text>';
    }

    var grid = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (ratio) {
      var price = max - (max - min) * ratio;
      var gy = y(price).toFixed(1);
      grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (width - padR) + '" y2="' + gy + '" stroke="var(--line)" opacity=".55"/>'
        + '<text x="' + (width - padR + 6) + '" y="' + (Number(gy) + 3.5) + '" fill="var(--muted)" font-size="10">' + money(price) + '</text>';
    });

    return '<svg class="share-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(tf) + ' 收盘价走势">'
      + grid
      + '<polyline fill="none" stroke="var(--text)" stroke-width="1.2" points="' + points + '"/>'
      + marks
      + '<text x="' + padL + '" y="' + (height - 6) + '" fill="var(--muted)" font-size="10">' + stamp(t0) + '</text>'
      + '<text x="' + (width - padR) + '" y="' + (height - 6) + '" fill="var(--muted)" font-size="10" text-anchor="end">' + stamp(t1) + '</text>'
      + '</svg>';
  }

  function render(data) {
    var trade = data.trade || {};
    var note = data.note || {};
    var profit = Number(trade.profit);
    var profitText = isFinite(profit) ? (profit >= 0 ? '+' : '') + money(profit) : '—';
    var profitClass = isFinite(profit) && profit < 0 ? 'down' : 'up';
    var author = (data.author && data.author.name) ? data.author.name : '同频用户';
    var tags = Array.isArray(note.tags) ? note.tags : [];
    var body = (note.body || '').trim();

    root.innerHTML = ''
      + '<article class="share-card">'
      + '  <div class="share-title">'
      + '    <h1>' + esc(trade.symbol || '交易') + ' · ' + esc(sideText(trade.side)) + '</h1>'
      + '    <span class="profit ' + profitClass + '">' + esc(profitText) + ' USD</span>'
      + '  </div>'
      + '  <div class="share-kv">'
      + '    <div><span>手数</span><b>' + esc(trade.volume != null ? trade.volume : '—') + '</b></div>'
      + '    <div><span>开仓价</span><b>' + money(trade.price_open) + '</b></div>'
      + '    <div><span>平仓价</span><b>' + money(trade.price_close) + '</b></div>'
      + '    <div><span>开仓时间</span><b>' + esc(stamp(trade.opened)) + '</b></div>'
      + '    <div><span>平仓时间</span><b>' + esc(stamp(trade.closed)) + '</b></div>'
      + '    <div><span>分享者</span><b>' + esc(author) + '</b></div>'
      + '  </div>'
      + '</article>'
      + '<article class="share-card">' + drawChart(data.charts, trade) + '</article>'
      + '<article class="share-card">'
      + '  <h2 style="margin:0 0 10px;font-size:15px">复盘笔记</h2>'
      + (body ? '<p class="share-note">' + esc(body) + '</p>' : '<p class="muted">作者没有填写笔记。</p>')
      + (tags.length ? '<div class="share-tags">' + tags.map(function (tag) { return '<span>' + esc(tag) + '</span>'; }).join('') + '</div>' : '')
      + '</article>'
      + '<p class="share-foot">这条链接只包含这一笔交易的摘要、笔记和 K 线，不包含账户、持仓或其它交易。'
      + '作者随时可以撤销。<br>由 <a href="/">同频</a> 提供。</p>';
    document.title = (trade.symbol || '复盘') + ' 复盘分享 · 同频';
  }

  function fail(message) {
    root.innerHTML = '<p class="share-error">' + esc(message) + '</p><p class="share-foot">链接可能已被作者取消，或者地址不完整。</p>';
  }

  if (!token) { fail('链接地址不完整。'); return; }
  fetch('/api/public/review?token=' + encodeURIComponent(token), { credentials: 'omit' })
    .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
    .then(function (result) {
      if (!result.ok) { fail(result.body && result.body.error ? result.body.error : '链接不存在或已被取消。'); return; }
      render(result.body);
    })
    .catch(function () { fail('加载失败，请稍后再试。'); });
})();
