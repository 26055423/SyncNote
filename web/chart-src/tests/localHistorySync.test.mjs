import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/localHistorySync.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const inertTerminal = { subscribe() { return () => {}; } };
const exports = {};
const require = createRequire(import.meta.url);
vm.runInNewContext(compiled, { exports, require: (name) => name === './localTerminal' ? { localTerminal: inertTerminal } : require(name),
  crypto: webcrypto, TextEncoder, AbortController, console });
const { LocalHistorySync, historyAccountKey } = exports;
const NOW = 1800000000000;
const ACCOUNT_KEY = await historyAccountKey('Demo-Server', '1001');

function fixture(options = {}) {
  let terminalState = { phase: 'connected', instance_id: 'instance', account_id: '1001', server: 'Demo-Server', epoch: 'e1',
    features: ['history'], product: 'SyncTrade', history_ready: true, server_offset_sec: 10800,
    account: { currency: 'USD', balance: 12345, equity: 12346 }, commands: [] };
  const terminalListeners = new Set(), stored = options.stored || new Map(), scheduled = new Map();
  const reads = [], uploads = [], reviewReads = [], reviewUploads = [];
  let sequence = 0;
  let now = options.now ?? NOW;
  const terminal = {
    getSnapshot: () => terminalState,
    subscribe(listener) { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
    async requestHistoryPage(range, cursor, signal) {
      reads.push({ range: { ...range }, cursor, signal });
      const page = { type: 'history', request_id: 'read', account_id: terminalState.account_id, server: terminalState.server, epoch: terminalState.epoch,
        account_key: ACCOUNT_KEY, range: { ...range }, deals: [{ deal_ticket: '9007199254740993', symbol: 'EURUSD', commission: -1.2, comment: 'not-persisted' }],
        next_cursor: 'cursor-final', has_more: false, through_server: range.to_server, time_basis: 'broker_server', server_offset_sec: 10800 };
      return options.read ? await options.read(page, reads.length) : page;
    },
    async requestReviewBars(symbol, tf, range, signal) {
      reviewReads.push({ symbol, tf, range, signal });
      const page = { type: 'bars', request_id: 'bars', symbol, tf, range, time_basis: 'broker_server',
        bars: [[range.from_server, 1, 2, 1, 2], [range.to_server, 2, 3, 2, 3]] };
      return options.reviewRead ? options.reviewRead(page, reviewReads.length) : page;
    },
  };
  const sync = new LocalHistorySync({ terminal,
    storage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => { if (options.storageFailure) throw new Error('quota'); stored.set(key, value); } },
    upload: async (body, signal) => { uploads.push({ body, signal }); return options.upload ? await options.upload(body, uploads.length) : { ok: true, batch_id: body.batch_id, account_key: body.account_key }; },
    accountKey: historyAccountKey, uuid: () => `batch-${++sequence}`, now: () => now,
    schedule(callback, ms) { const id = ++sequence; scheduled.set(id, { callback, ms }); return id; }, cancelSchedule(id) { scheduled.delete(id); },
    ...(options.job ? {
      reviewJob: async () => ({ ok: true, website_user_id: 'site-user', review_job: options.job }),
      uploadReview: async (body) => { reviewUploads.push(body); return { ok: true }; },
    } : {}),
  });
  sync.bindUser('site-user');
  return { sync, reads, uploads, stored, scheduled, reviewReads, reviewUploads,
    advance(ms) { now += ms; },
    async wake() {
      const [id, timer] = [...scheduled.entries()][0];
      scheduled.delete(id);
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    changeTerminal(patch) { terminalState = { ...terminalState, ...patch }; for (const listener of terminalListeners) listener(); } };
}

function unconfirmedPlan(stored) {
  assert.equal(stored.size, 1);
  const plan = JSON.parse([...stored.values()][0]);
  assert.equal(plan.cursor, '');
  assert.equal(plan.window_complete, false);
  assert.equal(plan.through_server, plan.range.from_server - 1);
  assert.equal(plan.saved_at, 0);
  assert.equal(plan.last_full, 0);
  return plan;
}

test('history consent starts off, and import contains raw history without account finances or EA credentials', async () => {
  const { sync, reads, uploads, stored } = fixture();
  assert.equal(sync.getSnapshot().enabled, false);
  assert.equal(reads.length, 0);
  assert.equal(uploads.length, 0);
  await sync.start();
  assert.equal(uploads.length, 1);
  const body = uploads[0].body;
  assert.equal(body.website_user_id, 'site-user');
  assert.equal(body.account, '1001');
  assert.equal(body.schema, 'syncnote-history.v1');
  assert.equal(body.deals[0].symbol, 'EURUSD'); // Never filters to the chart's symbol.
  assert.equal(body.checkpoint.last_deal_ticket, '9007199254740993');
  for (const key of ['balance', 'equity', 'positions', 'token', 'password']) assert.equal(key in body, false);
  assert.equal(stored.size, 1);
  const checkpoint = JSON.parse([...stored.values()][0]);
  assert.equal(checkpoint.window_complete, true);
  assert.equal('deals' in checkpoint, false);
  assert.equal(JSON.stringify(checkpoint).includes('not-persisted'), false);
});

test('a failed HTTP upload preserves the exact batch for explicit safe retry and never advances the cursor', async () => {
  const { sync, uploads, reads, stored } = fixture({ upload: (body, count) => {
    if (count === 1) throw new Error('network');
    return { ok: true, batch_id: body.batch_id, account_key: body.account_key };
  } });
  await sync.start();
  assert.equal(sync.getSnapshot().status, 'error');
  unconfirmedPlan(stored);
  sync.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(uploads.length, 2);
  assert.strictEqual(uploads[0].body, uploads[1].body);
  assert.equal(reads.length, 1);
  assert.equal(stored.size, 1);
});

test('wrong ACK identity or batch does not persist any progress', async () => {
  for (const patch of [{ batch_id: 'other' }, { account_key: 'other' }, { ok: false }]) {
    const { sync, stored } = fixture({ upload: (body) => ({ ok: true, batch_id: body.batch_id, account_key: body.account_key, ...patch }) });
    await sync.start();
    unconfirmedPlan(stored);
    assert.equal(sync.getSnapshot().status, 'error');
  }
});

test('an empty history window uses the explicit zero-ticket checkpoint accepted by the importer', async () => {
  const { sync, uploads } = fixture({ read: (page) => ({ ...page, deals: [] }) });
  await sync.start();
  assert.equal(uploads[0].body.checkpoint.last_deal_ticket, '0');
  assert.equal(sync.getSnapshot().status, 'idle');
});

test('website-user switch aborts an in-flight import and ignores even a late matching ACK', async () => {
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const begun = new Promise((resolve) => { entered = resolve; });
  const { sync, uploads, stored } = fixture({ upload: async (body) => { entered(); await waiting; return { ok: true, batch_id: body.batch_id, account_key: body.account_key }; } });
  const start = sync.start();
  await begun;
  assert.equal(uploads.length, 1);
  sync.bindUser('different-site-user');
  assert.equal(uploads[0].signal.aborted, true);
  release();
  await start;
  unconfirmedPlan(stored);
  assert.equal(sync.getSnapshot().enabled, false);
});

test('EA disconnect or epoch switch revokes sync consent without uploading to the new account', async () => {
  const { sync, uploads, changeTerminal, scheduled } = fixture();
  await sync.start();
  changeTerminal({ epoch: 'e2', account_id: '2002' });
  assert.equal(sync.getSnapshot().enabled, false);
  assert.equal(scheduled.size, 0);
  assert.equal(uploads.length, 1);
});

test('an unfinished window resumes its acknowledged cursor after reload; consent still starts off', async () => {
  const stored = new Map();
  const range = { from_server: 1700000000, to_server: 1700100000 };
  stored.set(`syncnote-history-v1:site-user:${ACCOUNT_KEY}`, JSON.stringify({ version: 1, account_key: ACCOUNT_KEY, account: '1001', server: 'Demo-Server', range,
    cursor: 'ack-cursor', through_server: range.from_server + 100, last_deal_ticket: '123', window_complete: false, saved_at: NOW - 1000 }));
  const { sync, reads } = fixture({ stored });
  assert.equal(sync.getSnapshot().enabled, false);
  await sync.start();
  assert.equal(reads[0].cursor, 'ack-cursor');
  assert.deepEqual(reads[0].range, range);
});

test('same-second partial pagination may report from-1 and all pages keep the fixed window', async () => {
  const { sync, reads, uploads } = fixture({ read: (page, count) => count === 1 ? { ...page, has_more: true, next_cursor: 'first', through_server: page.range.from_server - 1 } : page });
  await sync.start();
  assert.equal(uploads.length, 2);
  assert.equal(reads[1].cursor, 'first');
  assert.deepEqual(reads[0].range, reads[1].range);
});

test('completed windows overlap a day on the next scan to pick up late deals and fee edits', async () => {
  const { sync, reads, scheduled } = fixture();
  await sync.start();
  const previousTo = reads[0].range.to_server;
  [...scheduled.values()][0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads[1].range.from_server, previousTo - 86400);
  assert.equal(reads[1].cursor, '');
});

test('history data from a different account or range is never uploaded', async () => {
  for (const patch of [{ account_id: '2002' }, { account_key: 'wrong' }, { epoch: 'different' }, { time_basis: 'utc' }]) {
    const { sync, uploads } = fixture({ read: (page) => ({ ...page, ...patch }) });
    await sync.start();
    assert.equal(uploads.length, 0);
    assert.equal(sync.getSnapshot().status, 'error');
  }
});

test('each website user gets a separate local cursor even for the same MT5 account', async () => {
  const { sync, reads, stored } = fixture();
  await sync.start();
  sync.bindUser('another-site-user');
  await sync.start();
  assert.equal(reads[1].cursor, '');
  assert.equal(stored.size, 2);
});

test('a matching review uses historical symbol/range, preserves broker timestamps and uploads four periods', async () => {
  const job = { ticket: 'trade-1', symbol: 'EURUSD', opened_server: 1700000000, closed_server: 1700000300,
    account: '1001', server: 'Demo-Server', source_account_key: ACCOUNT_KEY };
  const { sync, reviewReads, reviewUploads } = fixture({ job });
  await sync.start();
  assert.equal(reviewReads.length, 4);
  assert.equal(reviewReads[0].symbol, 'EURUSD');
  assert.equal(reviewUploads.length, 1);
  assert.equal(reviewUploads[0].charts.M1[0][0], reviewReads[0].range.from_server);
  assert.equal(reviewUploads[0].website_user_id, 'site-user');
  assert.equal(sync.getSnapshot().reviews, 1);
});

test('another account review is skipped, and incomplete bars are explicitly marked instead of replaced with latest bars', async () => {
  const wrong = fixture({ job: { ticket: 'other', symbol: 'EURUSD', opened_server: 1700000000, closed_server: 1700000300,
    account: '2002', server: 'Demo-Server', source_account_key: 'other' } });
  await wrong.sync.start();
  assert.equal(wrong.reviewReads.length, 0);
  assert.equal(wrong.reviewUploads.length, 0);
  const missing = fixture({ job: { ticket: 'trade-1', symbol: 'EURUSD', opened_server: 1700000000, closed_server: 1700000300,
    account: '1001', server: 'Demo-Server', source_account_key: ACCOUNT_KEY }, reviewRead: (page) => ({ ...page, bars: [] }) });
  await missing.sync.start();
  assert.equal(missing.reviewUploads[0].charts.M1.length, 0);
  assert.equal(missing.reviewUploads[0].errors.M1, 'history_unavailable');
});
