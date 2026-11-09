import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../src/backfillBars.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const require = createRequire(import.meta.url), exports = {};
vm.runInNewContext(compiled, { exports, require: (name) => name === './localTerminal' ? { localTerminal: { subscribe() { return () => {}; } } } : name === './localHistorySync' ? { historyAccountKey: async () => 'fixture-account-key' } : require(name), AbortController, console, window: { localStorage: {} } });
const { BackfillBars } = exports;
const PERIOD = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }, TF_PERIOD = { M1: 60, M5: 300, M15: 900, H1: 3600 };
const NOW_SERVER = 1800000037, RECENT = 7 * 86400;
const key = 'syncnote-backfill-v2:fixture-user:fixture-account-key:XAUUSD';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
  let now = (NOW_SERVER - 10800) * 1000, sequence = 0;
  const queries = [], reads = [], uploads = [], stored = options.stored ?? new Map(), scheduled = new Map(), terminalListeners = new Set();
  let terminalState = { phase: 'connected', instance_id: 'fixture', epoch: 'epoch', account_id: '1001', server: 'Fixture-Broker', symbol: 'XAUUSD', features: ['history'], history_ready: true, server_offset_sec: 10800, commands: [] };
  const wallNow = () => Math.floor(now / 1000) + terminalState.server_offset_sec;
  const terminal = {
    subscribe(listener) { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
    getSnapshot: () => terminalState,
    async requestReviewBars(symbol, tf, range, signal) {
      const period = PERIOD[tf], alignedFrom = Math.floor(range.from_server / period) * period;
      assert.ok(range.from_server <= range.to_server);
      assert.ok((range.to_server - range.from_server) / period + 1 <= 2000, 'inclusive EA slot bound');
      assert.ok((Math.floor(range.to_server / period) * period - alignedFrom) / period + 1 <= 2000, 'aligned CopyRates count bound');
      assert.ok(range.to_server + period <= wallNow(), 'request only closed bars');
      reads.push({ symbol, tf, range: { ...range }, signal });
      const rows = Array.from({ length: Math.floor((range.to_server - alignedFrom) / period) + 1 }, (_, index) => [alignedFrom + index * period, 1, 2, 1, 2, 1]);
      const page = { symbol, tf, range, time_basis: 'broker_server', bars: rows };
      return options.read ? options.read(page, reads.length, signal) : page;
    },
  };
  const sync = new BackfillBars({ terminal, storage: { getItem: (item) => stored.get(item) ?? null, setItem: (item, value) => stored.set(item, value) }, accountKey: async () => 'fixture-account-key', now: () => now,
    coverage: async (query, signal) => { queries.push({ ...query });return options.coverage ? options.coverage(query, queries.length, signal) : { missing: [{ from: query.from, to: query.to }] }; },
    upload: async (body, signal) => { uploads.push({ body, signal });return options.upload ? options.upload(body, uploads.length, signal) : { ok: true }; },
    schedule(callback, ms) { const id = ++sequence;scheduled.set(id, { callback, ms });return id; }, cancelSchedule(id) { scheduled.delete(id); },
  });
  const locks = [];sync.subscribe(() => locks.push(sync.getSnapshot().locked));sync.bindUser('fixture-user');
  return { sync, queries, reads, uploads, stored, scheduled, locks, wallNow, checkpoint: () => JSON.parse(stored.get(key)), advance(ms) { now += ms; },
    updateTerminal(patch) { terminalState = { ...terminalState, ...patch };for (const listener of terminalListeners) listener(); },
    async wake() { const [id, job] = [...scheduled][0];scheduled.delete(id);job.callback();await flush(); },
  };
}

test('automatic backfill is bounded to seven days, fair across periods, and never locks charts', async () => {
  const f = fixture();await f.sync.start();assert.equal(f.sync.getSnapshot().phase, 'ready');
  assert.ok(f.locks.every((value) => value === false));
  assert.deepEqual(f.reads.slice(0, 4).map((read) => read.tf), ['1m', '5m', '15m', '1h']);
  for (const read of f.reads) assert.ok(read.range.from_server >= NOW_SERVER - RECENT);
  assert.ok(f.reads.length < 20);assert.equal((f.reads[0].range.to_server - f.reads[0].range.from_server) / 60 + 1, 2000);
  assert.equal(f.checkpoint().version, 2);assert.equal(f.checkpoint().done, true);
  assert.ok([...f.scheduled.values()].every((job) => job.ms === 60000));
  assert.equal(f.sync.getSnapshot().segments, f.uploads.length);assert.equal(f.sync.getSnapshot().lastUpdated, (NOW_SERVER - 10800) * 1000);
});
test('old deep-history checkpoints stay untouched and explicit starts inspect the current head', async () => {
  const oldKey = key.replace('-v2:', '-v1:'), old = JSON.stringify({ version: 1, floor_server: NOW_SERVER - 5 * 365 * 86400, cursors: { M1: NOW_SERVER - 200 * 86400 } });
  const f = fixture({ stored: new Map([[oldKey, old]]) });await f.sync.start();assert.equal(f.stored.get(oldKey), old);
  f.advance(4 * 86400 * 1000);const before = f.reads.length;await f.sync.start();
  assert.deepEqual(f.reads.slice(before, before + 4).map((read) => read.tf), ['1m', '5m', '15m', '1h']);
  for (const read of f.reads.slice(before)) assert.ok(read.range.from_server >= f.wallNow() - RECENT);
  assert.ok(f.reads[before].range.to_server > f.reads[0].range.to_server);
});
test('stored coverage skips reads and an unavailable coverage service defers backfill', async () => {
  const covered = fixture({ coverage: async () => ({ missing: [] }) });await covered.sync.start();assert.equal(covered.reads.length, 0);assert.equal(covered.sync.getSnapshot().phase, 'ready');
  const failed = fixture({ coverage() { throw new Error('temporary coverage network error'); } });await failed.sync.start();assert.equal(failed.reads.length, 0);assert.equal(failed.sync.getSnapshot().phase, 'partial_ready');
});
test('confirmed empty ranges need a server ACK and are skipped on the next run', async () => {
  let storedRange = false;
  const f = fixture({
    coverage(q) {
      const latest = q.tf === 'M1' && q.to === Math.floor(NOW_SERVER / 60) * 60 - 60;
      return { missing: latest && !storedRange ? [{ from: q.to, to: q.to }] : [] };
    },
    read(page) { return { ...page, bars: [], confirmed_empty: true }; },
    upload(body) {
      assert.equal(body.confirmed_empty, true);
      storedRange = true;
      return { ok: true, summary: { state: 'empty', complete: true, from_server: body.from_server, to_server: body.to_server } };
    },
  });
  await f.sync.start();
  assert.equal(f.reads.length, 1);
  assert.equal(f.sync.getSnapshot().phase, 'ready');
  await f.sync.start();
  assert.equal(f.reads.length, 1);

  const rejected = fixture({
    coverage(q, call) { return { missing: call === 1 ? [{ from: q.to, to: q.to }] : [] }; },
    read(page) { return { ...page, bars: [], confirmed_empty: true }; },
    upload() { return { ok: true }; },
  });
  await rejected.sync.start();
  assert.equal(rejected.sync.getSnapshot().phase, 'partial_ready');
});
test('reconnect clears stale gaps using server coverage and skips seconds between candle starts', async () => {
  const target = Math.floor(NOW_SERVER / 60) * 60 - 60;
  const storedLater = target - 60;
  let reconnected = false;
  const f = fixture({
    read(page) {
      return !reconnected && page.tf === '1m' ? { ...page, bars: page.bars.filter(row => row[0] !== storedLater) } : page;
    },
    coverage(query) {
      if (!reconnected) return { missing: [{ from: query.from, to: query.to }] };
      return { missing: query.tf === 'M1' && query.from <= storedLater && query.to >= target
        ? [{ from: storedLater + 1, to: target - 1 }] : [] };
    },
  });
  await f.sync.start();
  assert.ok(f.checkpoint().gaps.M1.some(gap => gap.from <= storedLater && gap.to >= storedLater));
  reconnected = true;
  const reads = f.reads.length;
  await f.sync.start();
  assert.equal(f.reads.length, reads);
  assert.deepEqual(f.checkpoint().gaps.M1, []);
  assert.equal(f.sync.getSnapshot().phase, 'ready');
});
test('holes are clipped into aligned windows and a one-slot hole preserves left gaps', async () => {
  const clipped = fixture({ coverage(query) { const p = TF_PERIOD[query.tf];return { missing: [{ from: query.from - 17 * p, to: query.to + 17 * p }] }; } });await clipped.sync.start();assert.equal(clipped.sync.getSnapshot().phase, 'ready');
  for (let i = 0; i < clipped.reads.length; i += 1) { assert.ok(clipped.reads[i].range.from_server >= clipped.queries[i].from);assert.ok(clipped.reads[i].range.to_server <= clipped.queries[i].to); }
  let firstQuery, left;const point = fixture({ coverage(query, call) { if (call !== 1) return { missing: [] };firstQuery = query;left = { from: query.from + 60, to: query.from + 120 };return { missing: [left, { from: query.to, to: query.to }] }; } });
  await point.sync.start();assert.equal(point.reads.length, 1);const nextM1 = point.queries.slice(1).find((query) => query.tf === 'M1');assert.equal(nextM1.to, firstQuery.to - 60);assert.ok(nextM1.from <= left.from && nextM1.to >= left.to);
});
test('minute delta overlaps two periods from successful heads', async () => {
  const f = fixture();await f.sync.start();const previous = { ...f.checkpoint().heads }, count = f.reads.length;f.advance(60000);await f.wake();
  const next = f.reads.slice(count);assert.equal(next.length, 4);
  for (const read of next) { const tf = Object.keys(TF_PERIOD).find((item) => TF_PERIOD[item] === PERIOD[read.tf]);assert.equal(read.range.from_server, previous[tf] - 2 * PERIOD[read.tf]); }
  assert.ok(f.checkpoint().heads.M1 > previous.M1);assert.equal(f.scheduled.size, 1);
});
test('failed delta does not advance its head and retries the same missing tail', async () => {
  let fail = false;const f = fixture({ upload(body) { if (fail && body.tf === 'M1') throw new Error('failed write');return { ok: true }; } });
  await f.sync.start();const head = f.checkpoint().heads.M1;f.advance(60000);fail = true;await f.sync.delta();assert.equal(f.checkpoint().heads.M1, head);assert.equal(f.sync.getSnapshot().phase, 'partial_ready');
  const before = f.reads.length;fail = false;f.advance(60000);await f.sync.delta();assert.equal(f.reads[before].range.from_server, head - 120);assert.ok(f.checkpoint().heads.M1 > head);
});
test('overlapping delta calls share one serial operation without duplicate reads', async () => {
  let block = false, release, heldPage;const f = fixture({ read(page) { if (block && page.tf === '1m') { heldPage = page;return new Promise((resolve) => { release = resolve; }); }return page; } });
  await f.sync.start();f.advance(60000);const count = f.reads.length;block = true;const a = f.sync.delta(), b = f.sync.delta();await flush();assert.equal(f.reads.length, count + 1);
  block = false;release(heldPage);await Promise.all([a, b]);assert.equal(f.reads.length, count + 4);
});
test('stop cancels in-flight reads, late uploads and the minute timer', async () => {
  let release, heldPage;const f = fixture({ read(page) { heldPage = page;return new Promise((resolve) => { release = resolve; }); } });
  const pending = f.sync.start();await flush();const signal = f.reads[0].signal;f.sync.stop();assert.equal(signal.aborted, true);release(heldPage);await pending;assert.equal(f.uploads.length, 0);assert.equal(f.scheduled.size, 0);assert.equal(f.sync.getSnapshot().phase, 'idle');
});
test('stop also cancels a start queued before its first asynchronous step', async () => {
  const f = fixture();const pending = f.sync.start();f.sync.stop();await pending;
  assert.equal(f.reads.length, 0);assert.equal(f.uploads.length, 0);assert.equal(f.scheduled.size, 0);assert.equal(f.sync.getSnapshot().phase, 'idle');
});
test('user switch cancels old writes and an explicit pause survives automatic start', async () => {
  let release, heldPage;const f = fixture({ read(page) { heldPage = page;return new Promise((resolve) => { release = resolve; }); } });const pending = f.sync.start();await flush();f.sync.bindUser('other-user');release(heldPage);await pending;assert.equal(f.uploads.length, 0);assert.equal(f.scheduled.size, 0);
  const paused = fixture();await paused.sync.start();paused.sync.pause();const count = paused.reads.length;await paused.sync.start();await paused.sync.delta();assert.equal(paused.reads.length, count);assert.equal(paused.scheduled.size, 0);assert.equal(paused.sync.getSnapshot().phase, 'paused');await paused.sync.resume();assert.ok(paused.reads.length > count);assert.equal(paused.sync.getSnapshot().phase, 'ready');
});
test('unknown unresolved trades yield all reads without advancing successful heads', async () => {
  const f = fixture();await f.sync.start();const heads = { ...f.checkpoint().heads }, count = f.reads.length;f.updateTerminal({ commands: [{ account_id: '1001', server: 'Fixture-Broker', state: 'uncertain' }] });f.advance(60000);await f.sync.delta();assert.equal(f.reads.length, count);assert.deepEqual(f.checkpoint().heads, heads);assert.equal(f.sync.getSnapshot().phase, 'partial_ready');f.updateTerminal({ commands: [] });await f.sync.delta();assert.ok(f.reads.length > count);
});
test('empty recent windows are bounded partial data without a false historical floor', async () => {
  const f = fixture({ read(page) { return { ...page, bars: [] }; } });await f.sync.start();assert.ok(f.reads.length < 20);assert.equal(f.sync.getSnapshot().phase, 'partial_ready');assert.equal(f.sync.getSnapshot().flooredTfs.length, 0);assert.deepEqual(f.checkpoint().heads, {});
});
test('a verified recent tip survives older empty weekend windows and delta does not rescan seven days', async () => {
  let olderWeekend = true, m1Reads = 0;
  const f = fixture({ read(page) {
    if (page.tf === '1m' && ++m1Reads > 1 && olderWeekend) return { ...page, bars: [] };
    return page;
  } });
  await f.sync.start();
  const head = f.checkpoint().heads.M1;
  assert.equal(head, f.reads[0].range.to_server, 'ACKed tip must progress independently from old empty windows');
  assert.equal(f.sync.getSnapshot().phase, 'partial_ready');
  olderWeekend = false;f.advance(60000);const before = f.reads.length;
  await f.sync.delta();
  const m1 = f.reads.slice(before).filter((read) => read.tf === '1m');
  assert.equal(m1.length, 1);
  assert.equal(m1[0].range.from_server, head - 120);
  assert.ok(f.checkpoint().heads.M1 > head);
});
test('a multisegment delta cannot jump an intermediate failure after ACKing the newest tip', async () => {
  let inDelta = false, m1Uploads = 0;
  const f = fixture({ upload(body) {
    if (inDelta && body.tf === 'M1' && ++m1Uploads === 2) throw new Error('intermediate gap write failed');
    return { ok: true };
  } });
  await f.sync.start();const oldHead = f.checkpoint().heads.M1;
  f.advance(3 * 86400 * 1000);inDelta = true;
  await f.sync.delta();
  assert.equal(m1Uploads, 2, 'first tail segment must have ACKed before the middle gap fails');
  assert.equal(f.checkpoint().heads.M1, oldHead, 'newest ACK alone cannot skip the unfilled bridge');
  assert.equal(f.sync.getSnapshot().phase, 'partial_ready');
});
test('a partial recent tail cannot prove its missing prefix, while new increments keep running', async () => {
  let partial = false;
  const f = fixture({ read(page) { return partial && page.tf === '1m' ? { ...page, bars: page.bars.slice(-3) } : page; } });
  await f.sync.start();const oldHead = f.checkpoint().heads.M1;
  f.advance(10 * 60000);partial = true;await f.sync.delta();
  assert.equal(f.checkpoint().heads.M1, oldHead, 'ACKing only the newest tail must not jump its unreturned prefix');
  const tail = f.checkpoint().tail_heads.M1;
  assert.ok(tail > oldHead);assert.ok(f.checkpoint().gaps.M1.length > 0);
  assert.equal(f.sync.getSnapshot().repairUpdated, null);
  partial = false;f.advance(60000);const before = f.reads.length;await f.sync.delta();
  const recent = f.reads.slice(before).filter((read) => read.tf === '1m');
  assert.equal(recent.length, 1);assert.equal(recent[0].range.from_server, tail - 120);
  assert.equal(f.checkpoint().heads.M1, oldHead, 'the previous unproven gap remains visible in progress');
  f.advance(10 * 60000);const retryAt = f.reads.length;await f.sync.delta();
  assert.ok(f.reads.slice(retryAt).filter((read) => read.tf === '1m').length <= 2, 'one tail update plus at most one bounded old-gap retry');
  assert.equal(f.checkpoint().gaps.M1.length, 0);
  assert.ok(f.checkpoint().heads.M1 > oldHead);
  assert.equal(f.sync.getSnapshot().repairUpdated, f.sync.getSnapshot().lastUpdated);
});
test('an internal missing row also blocks main head proof despite a valid newest candle', async () => {
  let hole = false;
  const f = fixture({ read(page) { return hole && page.tf === '1m' ? { ...page, bars: page.bars.filter((_, index) => index !== 2) } : page; } });
  await f.sync.start();const head = f.checkpoint().heads.M1;f.advance(10 * 60000);hole = true;
  await f.sync.delta();assert.equal(f.checkpoint().heads.M1, head);assert.ok(f.checkpoint().gaps.M1.length > 0);
});
test('a persistent newest empty gap cannot starve an older real gap during bounded repair', async () => {
  const target = Math.floor(NOW_SERVER / 60) * 60 - 60;
  const newestGap = target - 10 * 60, olderGap = target - 30 * 60;
  let repair = false;
  const f = fixture({ read(page) {
    if (page.tf !== '1m') return page;
    return { ...page, bars: page.bars.filter((row) => row[0] !== newestGap && (repair || row[0] !== olderGap)) };
  } });
  await f.sync.start();assert.equal(f.checkpoint().gaps.M1.length, 2);
  repair = true;f.advance(10 * 60000);await f.sync.delta();
  assert.equal(f.sync.getSnapshot().repairUpdated, null, 'an empty old-gap reply is not an upload ACK');
  const before = f.reads.length;f.advance(10 * 60000);await f.sync.delta();
  assert.ok(f.reads.slice(before).some((read) => read.tf === '1m' && read.range.from_server === olderGap && read.range.to_server === olderGap));
  assert.ok(!f.checkpoint().gaps.M1.some((gap) => gap.from <= olderGap && gap.to >= olderGap));
  assert.ok(f.checkpoint().gaps.M1.some((gap) => gap.from <= newestGap && gap.to >= newestGap));
  assert.ok(f.sync.getSnapshot().repairUpdated !== null);
});
