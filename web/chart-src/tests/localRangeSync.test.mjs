import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {}, require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/localRangeSync.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports, require: (name) => name === './localTerminal' ? { localTerminal: { subscribe() { return () => {}; } } } : name === './localHistorySync' ? { historyAccountKey: async () => 'key-1' } : require(name), AbortController, console,
});
const { LocalRangeSync } = exports;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const native = (value) => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  let terminalState = { phase: 'connected', instance_id: 'local-instance', account_id: '1001', server: 'Broker', epoch: 'epoch', symbol: 'XAUUSD', features: ['history'], history_ready: true, server_offset_sec: 10800, commands: [] };
  const listeners = new Set(), scheduled = new Map(), requests = [], reads = [];
  let sequence = 0;
  const segment = { job_id: 'job-1', segment_id: 'segment-1', account_key: 'key-1', account: '1001', server: 'Broker', symbol: 'NAS100.cash', tf: 'M1', from_server: 1800000000, to_server: 1800000120 };
  const jobs = [segment];
  const sync = new LocalRangeSync({
    terminal: { subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }, getSnapshot: () => terminalState,
      async requestReviewBars(symbol, tf, range, signal) {
        reads.push({ symbol, tf, range: native(range), signal });
        const page = { symbol, tf, range, time_basis: 'broker_server', bars: [0, 60, 120].map((delta) => [range.from_server + delta, 10, 12, 9, 11, 4]) };
        return options.read ? options.read(page, reads.length, signal) : page;
      },
    },
    accountKey: async () => options.accountKey ? options.accountKey(terminalState) : 'key-1', now: () => (1800003600 - terminalState.server_offset_sec) * 1000,
    async post(path, body, signal) {
      requests.push({ path, body: native(body), signal });
      if (options.post) return options.post(path, body, requests.filter((row) => row.path === path).length, signal, segment);
      if (path.endsWith('local-poll')) return { ok: true, job: jobs.shift() ?? null };
      return ack(body);
    },
    schedule(callback, delay) { const id = ++sequence; scheduled.set(id, { callback, delay }); return id; },
    cancelSchedule(id) { scheduled.delete(id); },
  });
  sync.bindUser('user-1');
  return { sync, requests, reads, scheduled, segment, jobs,
    update(patch) { terminalState = { ...terminalState, ...patch }; for (const callback of listeners) callback(); },
    async wake() { const [id, timer] = [...scheduled][0] ?? []; assert.ok(timer, 'expected a scheduled range step'); scheduled.delete(id); timer.callback(); await flush(); },
  };
}
function ack(body, extra = {}) {
  return { ok: true, job_id: body.job_id, segment_id: body.segment_id, account_key: body.account_key, symbol: body.symbol, tf: body.tf, from_server: body.from_server, to_server: body.to_server, accepted: body.bars.length, status: 'completed', ...extra };
}

test('explicit start relays exact broker-wall range without sending trades or converting timestamps', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0, 'binding does not silently start sync');
  await f.sync.start(); await f.wake(); await f.wake();
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].symbol, 'NAS100.cash'); assert.equal(f.reads[0].tf, '1m');
  const result = f.requests.find((row) => row.path.endsWith('local-result')).body;
  assert.equal(result.website_user_id, 'user-1'); assert.equal(result.account, '1001'); assert.equal(result.account_key, 'key-1');
  assert.equal(result.bars[0][0], 1800000000); assert.equal(result.error, '');
  assert.equal(f.sync.getSnapshot().segments, 1);
  assert.equal(f.sync.getSnapshot().phase, 'idle'); assert.equal(f.scheduled.size, 0);
});

test('a completed explicit task does not silently consume a later task', async () => {
  const f = fixture(); f.jobs.push({ ...f.segment, job_id: 'job-2', segment_id: 'segment-2' });
  await f.sync.start(); await f.wake(); await f.wake();
  assert.equal(f.sync.getSnapshot().phase, 'idle'); assert.equal(f.jobs.length, 1); assert.equal(f.scheduled.size, 0);
  await f.sync.start(); assert.equal(f.sync.getSnapshot().jobId, 'job-2');
});

test('unknown trades and busy history reads yield without advancing or consuming retry budget', async () => {
  const f = fixture({ read(page, call) { if (call < 3) throw Object.assign(new Error('busy'), { code: call === 1 ? 'BARS_BUSY' : 'history_read_busy' }); return page; } });
  f.update({ commands: [{ account_id: '1001', server: 'Broker', state: 'uncertain' }] });
  await f.sync.start(); assert.equal(f.requests.length, 0);
  f.update({ commands: [] }); await f.wake();
  await f.wake(); await f.wake(); await f.wake(); await f.wake();
  assert.equal(f.reads.length, 3); assert.deepEqual(f.reads.map((row) => row.range), [f.reads[0].range, f.reads[0].range, f.reads[0].range]);
  assert.equal(f.requests.filter((row) => row.path.endsWith('local-result')).length, 1);
});

test('failed upload and mismatched ACK retry the identical preserved body without rereading EA', async () => {
  const f = fixture({ post(path, body, call, _signal, segment) {
    if (path.endsWith('local-poll')) return { ok: true, job: segment };
    if (call === 1) throw new Error('network unavailable');
    if (call === 2) return ack(body, { symbol: 'XAUUSD' });
    return ack(body);
  } });
  await f.sync.start(); await f.wake(); await f.wake();
  assert.equal(f.sync.getSnapshot().segments, 0);
  await f.wake(); assert.equal(f.sync.getSnapshot().segments, 0);
  await f.wake(); assert.equal(f.sync.getSnapshot().segments, 1);
  const uploads = f.requests.filter((row) => row.path.endsWith('local-result'));
  assert.equal(f.reads.length, 1); assert.equal(uploads.length, 3);
  assert.deepEqual(uploads[0].body, uploads[1].body); assert.deepEqual(uploads[1].body, uploads[2].body);
});

test('partial and empty ranges remain explicit partial evidence after bounded reads', async () => {
  for (const bars of [[], [[1800000000, 10, 12, 9, 11, 4]]]) {
    const f = fixture({ read(page) { return { ...page, bars }; } });
    await f.sync.start(); await f.wake(); await f.wake(); await f.wake(); await f.wake();
    assert.equal(f.reads.length, 3);
    const body = f.requests.find((row) => row.path.endsWith('local-result')).body;
    assert.equal(body.error, bars.length ? 'partial_window' : 'empty_window'); assert.deepEqual(body.bars, bars);
  }
});

test('unavailable broker history waits twelve attempts before reporting an unconfirmed gap', async () => {
  const f = fixture({ read() { throw Object.assign(new Error('history not ready'), { code: 'HISTORY_UNAVAILABLE' }); } });
  await f.sync.start();
  for (let count = 0; count < 11; count++) { await f.wake(); assert.equal(f.requests.filter((row) => row.path.endsWith('local-result')).length, 0); }
  await f.wake(); await f.wake();
  assert.equal(f.reads.length, 12); const body = f.requests.find((row) => row.path.endsWith('local-result')).body;
  assert.equal(body.error, 'history_unavailable'); assert.deepEqual(body.bars, []);
});

test('disconnect and user/account/symbol changes abort late reads and never upload to the new identity', async () => {
  for (const change of ['disconnect', 'user', 'account', 'symbol']) {
    let release;
    const f = fixture({ read: () => new Promise((resolve) => { release = resolve; }) });
    await f.sync.start(); const [id, timer] = [...f.scheduled][0]; f.scheduled.delete(id); timer.callback(); await flush();
    assert.equal(f.reads.length, 1);
    if (change === 'user') f.sync.bindUser('user-2');
    else f.update(change === 'disconnect' ? { phase: 'disconnected' } : change === 'account' ? { account_id: '1002', epoch: 'new' } : { symbol: 'USTEC' });
    assert.equal(f.reads[0].signal.aborted, true);
    release({ symbol: 'NAS100.cash', tf: '1m', range: f.reads[0].range, time_basis: 'broker_server', bars: [] }); await flush();
    assert.equal(f.requests.filter((row) => row.path.endsWith('local-result')).length, 0); assert.equal(f.scheduled.size, 0);
  }
});

test('invalid EA responses fail closed and server cancellation drops the pending batch', async () => {
  const wrong = fixture({ read(page) { return { ...page, symbol: 'XAUUSD' }; } });
  await wrong.sync.start(); await wrong.wake(); assert.equal(wrong.sync.getSnapshot().phase, 'error'); assert.equal(wrong.scheduled.size, 0);
  const cancelled = fixture({ post(path, body, _call, _signal, segment) {
    if (path.endsWith('local-poll')) return { ok: true, job: segment };
    throw Object.assign(new Error('任务已取消'), { status: 409 });
  } });
  await cancelled.sync.start(); await cancelled.wake(); await cancelled.wake();
  assert.equal(cancelled.sync.getSnapshot().phase, 'error'); assert.equal(cancelled.scheduled.size, 0); assert.equal(cancelled.sync.getSnapshot().segments, 0);
});
