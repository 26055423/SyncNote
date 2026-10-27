(() => {
  /**
   * 交易记录页的复盘分类面板。
   *
   * 复盘本身已经搬到 /chart（Vela 图表 + 画线 + 作业分享），这里只保留：
   * 笔记分类的聚合、「同类问题」筛选，以及筛选状态的记忆。
   */
  const el = id => document.getElementById(id);
  const escape = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => Number(n).toFixed(2);
  const api = (path, data) => window.tongpinAPI(path, data);
  let notes = {}, categories = [];

  window.tradeJournal = {
    filter: '',
    canView: false,
    async load(person, own) {
      const r = await api('/api/journal?person=' + encodeURIComponent(person));
      this.canView = r.can_view;
      if (!r.can_view && !own) { this.filter = ''; }
      notes = r.notes;
      categories = [...new Set([...r.categories, ...Object.values(notes).flatMap(n => n.tags)])];
    },
    note(id) { return notes[id]; },
    render(rows, own) {
      el('mistake-panel').hidden = !own;
      if (!own) return;
      const byTicket = new Map(rows.map(t => [String(t.ticket), t])), counts = Object.create(null);
      for (const [id, n] of Object.entries(notes)) {
        if (!byTicket.has(id)) continue;
        for (const tag of n.tags) (counts[tag] ??= []).push(id);
      }
      const entries = Object.entries(counts).sort((a, b) => b[1].length - a[1].length);
      el('mistake-groups').innerHTML = `<button class="issue-card ${!this.filter ? 'selected' : ''}" data-filter=""><b>全部交易</b><span>${rows.length} 笔 · ${Object.keys(notes).filter(id => byTicket.has(id)).length} 笔已复盘</span></button>` + entries.map(([tag, ids]) => `<button class="issue-card ${this.filter === tag ? 'selected' : ''}" data-filter="${escape(tag)}"><b>${escape(tag)}</b><span>${ids.length} 笔交易</span><small>关联交易净盈亏 ${money(ids.reduce((n, id) => n + byTicket.get(id).profit, 0))}</small></button>`).join('');
      el('mistake-groups').querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { this.filter = b.dataset.filter; window.renderJournal(); });
      el('mistake-empty').hidden = entries.length > 0;
    },
    matches(t) { return !this.filter || notes[String(t.ticket)]?.tags.includes(this.filter); },
  };
})();
