import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const journalSource = readFileSync(new URL('../web/journal-ui.js', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('../web/history.js', import.meta.url), 'utf8');
const fixtureTime = Date.UTC(2026, 10, 5, 12) / 1000;
const trade = (ticket, day, profit = 1) => ({ ticket, symbol: 'XAUUSD', side: 'buy', volume: 0.01, open: 4000, close: 4001, profit, closed: Date.UTC(2026, 10, day, 10) / 1000 });
function element() {
  return {
    _html: '', textContent: '', value: '', hidden: false, dataset: {}, attrs: {}, children: new Map(),
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); } },
    set innerHTML(value) { this._html = value; this.children.clear(); }, get innerHTML() { return this._html; },
    setAttribute(name, value) { this.attrs[name] = value; },
    querySelectorAll(selector) {
      if (!this.children.has(selector)) {
        const attr = selector.slice(1, -1), key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const matches = [...this._html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))];
        this.children.set(selector, matches.map(match => Object.assign(element(), { dataset: { [key]: match[1] } })));
      }
      return this.children.get(selector);
    },
  };
}
async function fixture({ person = '', state, notes = {}, canView = true, stateRead, journalRead } = {}) {
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  node('review-filters').innerHTML = '<button data-review-filter="all"></button><button data-review-filter="reviewed"></button><button data-review-filter="unreviewed"></button>';
  const rows = [trade('written', 5), trade('drawing-only', 5), trade('empty-note', 5), trade('yesterday', 4), trade('other-month', -2)];
  let value = state || { user: { id: 'owner' }, members: [{ id: 'owner', name: '本人', can_view: true, can_review: true, reviewed: ['written', 'drawing-only'] }], snapshots: { owner: { updated: fixtureTime, data: { currency: 'USD', history: rows } } }, reviewed: ['written', 'drawing-only'] };
  let calls = [];
  const window = { syncnoteDateKey: t => t == null ? '' : new Date(t * 1000).toISOString().slice(0, 10), syncnoteStamp: t => t == null ? '待校准' : String(t),
    async syncnoteAPI(path) { calls.push(path); if (path === '/api/state') return stateRead ? stateRead() : structuredClone(value); return journalRead ? journalRead() : { can_view: canView, notes, categories: ['执行良好'] }; } };
  const context = vm.createContext({ window, document: { querySelector: selector => node(selector.slice(1)), getElementById: node },
    location: { search: person ? '?person=' + encodeURIComponent(person) : '', href: '' }, URLSearchParams, console, setInterval() {},
    Date: class extends Date { static now() { return fixtureTime * 1000; } } });
  vm.runInContext(journalSource, context);vm.runInContext(historySource, context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, window, node, rows, calls, update(next) { value = next; }, state: () => value,
    filter(name) { node('review-filters').querySelectorAll('[data-review-filter]').find(b => b.dataset.reviewFilter === name).onclick(); },
    day(day) { node('calendar').querySelectorAll('[data-day]').find(b => b.dataset.day === day).onclick(); },
    async refresh() { await vm.runInContext('refresh()', context); } };
}

test('calendar, list and classification count use authoritative reviews, including drawings without notes', async () => {
  const f = await fixture({ notes: { written: { body: '说明', tags: ['执行良好'] }, 'empty-note': { body: '', tags: [] } } });
  const list = f.node('trade-list').innerHTML;
  assert.match(list, /is-reviewed[^>]*data-review="drawing-only">✓ 已复盘/);
  assert.match(list, /is-unreviewed[^>]*data-review="empty-note">○ 未复盘/);
  assert.match(f.node('calendar').innerHTML, /data-day="2026-11-05"[^]*?已复盘 2[^]*?未复盘 1/);
  assert.match(f.node('selected-day-summary').innerHTML, /已复盘 2 笔[^]*未复盘 1 笔/);
  assert.match(f.node('mistake-groups').innerHTML, /5 笔 · 2 笔已复盘/);
  assert.equal(f.node('review-filters').hidden, false);
});

test('review filters intersect day, month and classification instead of expanding to all dates', async () => {
  const f = await fixture({ notes: { written: { body: '说明', tags: ['执行良好'] }, yesterday: { body: '昨天', tags: ['执行良好'] } } });
  f.filter('unreviewed');
  assert.match(f.node('trade-list').innerHTML, /data-review="empty-note"/);
  assert.doesNotMatch(f.node('trade-list').innerHTML, /data-review="written"|data-review="yesterday"/);
  f.window.tradeJournal.filter = '执行良好';f.window.renderJournal();
  assert.match(f.node('trade-list').innerHTML, /当前日期和筛选条件下/);
  f.filter('all');assert.match(f.node('trade-list').innerHTML, /data-review="written"/);
  assert.doesNotMatch(f.node('trade-list').innerHTML, /data-review="yesterday"/);
  f.day('2026-11-04');assert.equal(f.window.tradeJournal.filter, '执行良好');
  assert.match(f.node('trade-list').innerHTML, /data-review="yesterday"/);
  f.node('clear-day').onclick();assert.match(f.node('trade-list').innerHTML, /data-review="written"/);
  assert.match(f.node('trade-list').innerHTML, /data-review="yesterday"/);
});

test('another member uses that member reviews and never the viewer top-level reviews', async () => {
  const state = { user: { id: 'viewer' }, reviewed: ['friend-unreviewed'], members: [{ id: 'friend', name: '朋友', can_view: true, can_review: true, reviewed: ['friend-drawing'] }],
    snapshots: { friend: { updated: fixtureTime, data: { history: [trade('friend-drawing', 5), trade('friend-unreviewed', 5)] } } } };
  const f = await fixture({ person: 'friend', state });
  assert.match(f.node('trade-list').innerHTML, /is-reviewed[^>]*data-review="friend-drawing"/);
  assert.match(f.node('trade-list').innerHTML, /is-unreviewed[^>]*data-review="friend-unreviewed"/);
});

test('revoking review access hides statuses, filters and private classifications without a journal request', async () => {
  const f = await fixture({ notes: { written: { body: '说明', tags: ['执行良好'] } } });
  const next = structuredClone(f.state());next.members[0].can_review = false;f.update(next);
  const before = f.calls.length;await f.refresh();
  assert.deepEqual(f.calls.slice(before), ['/api/state']);
  assert.equal(f.node('review-filters').hidden, true);assert.equal(f.node('mistake-panel').hidden, true);
  assert.doesNotMatch(f.node('trade-list').innerHTML, /已复盘|未复盘|data-review=/);
  assert.doesNotMatch(f.node('calendar').innerHTML, /已复盘|未复盘/);
});

test('revoking trade access clears previously rendered private content', async () => {
  const f = await fixture();const next = structuredClone(f.state());next.members[0].can_view = false;f.update(next);await f.refresh();
  for (const id of ['trade-list','calendar','month-summary','year-summary','selected-day-summary','mistake-groups']) assert.equal(f.node(id).innerHTML, '');
  assert.equal(f.node('review-filters').hidden, true);
});

test('polling does not overlap an in-flight shared API read', async () => {
  let resolve, reads = 0;
  const f = await fixture({ stateRead: () => { reads++; return new Promise(done => { resolve = done; }); } });
  await f.refresh();await f.refresh();assert.equal(reads, 1);
  resolve(f.state());await new Promise(done => setImmediate(done));
  assert.ok(f.calls.includes('/api/journal?person=owner'));
});

test('notice reports confirmed history sync separately from snapshot and latest close time', async () => {
  const f = await fixture();const next = structuredClone(f.state());
  next.user.auto_history_sync = false;next.snapshots.owner.updated = fixtureTime - 86400;
  next.snapshots.owner.history_synced_at = fixtureTime - 30;f.update(next);await f.refresh();
  const notice = f.node('history-notice').innerHTML;
  assert.match(notice, new RegExp(`5 笔云端平仓记录 · 最后历史同步：${fixtureTime - 30}`));
  assert.match(notice, new RegExp(`最新平仓：${trade('latest', 5).closed}`));
  assert.match(notice, /网页自动续传未开启/);
  assert.match(notice, /href="\/chart\?view=live&amp;panel=sync">前往交易台同步/);
  assert.doesNotMatch(notice, /数据可能过期|尚未接入 MT5/);
});

test('missing sync confirmation never borrows snapshot or close timestamps', async () => {
  const f = await fixture();
  assert.match(f.node('history-notice').innerHTML, /最后历史同步：尚无分页同步确认/);
  const next = structuredClone(f.state());next.snapshots.owner.history_synced_at = fixtureTime;next.snapshots.owner.data.history = [];f.update(next);await f.refresh();
  assert.match(f.node('history-notice').innerHTML, new RegExp(`0 笔云端平仓记录 · 最后历史同步：${fixtureTime}`));
  assert.match(f.node('history-notice').innerHTML, /最新平仓：暂无/);
});

test('journal failure cannot block fresh trade rows or turn a drawing review into unreviewed', async () => {
  let failing = false;
  const notes = { written: { body: '原笔记', tags: ['执行良好'] } };
  const f = await fixture({ journalRead: () => { if (failing) throw new Error('temporary journal error');return { can_view: true, notes, categories: [] }; } });
  const next = structuredClone(f.state());next.snapshots.owner.data.history.push(trade('fresh-trade', 5));f.update(next);
  failing = true;await f.refresh();
  assert.match(f.node('trade-list').innerHTML, /data-review="fresh-trade"/);
  assert.match(f.node('trade-list').innerHTML, /is-reviewed[^>]*data-review="drawing-only">✓ 已复盘/);
  assert.equal(f.node('review-filters').hidden, false);
  assert.equal(f.node('mistake-panel').hidden, true);assert.equal(f.node('mistake-groups').innerHTML, '');
  assert.match(f.node('history-notice').innerHTML, /复盘分类暂不可用/);
  failing = false;await f.refresh();assert.equal(f.node('mistake-panel').hidden, false);
  assert.doesNotMatch(f.node('history-notice').innerHTML, /复盘分类暂不可用/);
});

test('initial journal failure still renders authoritative trade and review state', async () => {
  const f = await fixture({ journalRead() { throw new Error('unavailable'); } });
  assert.match(f.node('trade-list').innerHTML, /is-reviewed[^>]*data-review="drawing-only"/);
  assert.match(f.node('selected-day-summary').innerHTML, /已复盘 2 笔/);
  assert.match(f.node('history-notice').innerHTML, /5 笔云端平仓记录/);
});

test('trade rows render immediately while a journal read is still pending', async () => {
  let release;
  const f = await fixture({ journalRead: () => new Promise(resolve => { release = resolve; }) });
  assert.match(f.node('trade-list').innerHTML, /is-reviewed[^>]*data-review="drawing-only"/);
  assert.match(f.node('history-notice').innerHTML, /5 笔云端平仓记录/);
  assert.equal(f.node('mistake-panel').hidden, true);
  release({ can_view: true, notes: {}, categories: [] });await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.node('mistake-panel').hidden, false);
});
