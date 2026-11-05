import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Run the actual backfill state machine, including coverage and checkpoint moves.
const compiled = ts.transpileModule(readFileSync(new URL('../src/backfillBars.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const require = createRequire(import.meta.url);
const exports = {};
vm.runInNewContext(compiled, { exports, require: (name) => name === './localTerminal'
  ? { localTerminal: { subscribe() { return () => {}; } } }
  : name === './localHistorySync' ? { historyAccountKey: async () => 'fixture-account-key' } : require(name),
  AbortController, setTimeout, console, window: { localStorage: {} } });
const { BackfillBars } = exports;
const PERIOD = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
const TF_PERIOD = { M1: 60, M5: 300, M15: 900, H1: 3600 };
const NOW_SERVER = 1800000037; // Deliberately inside a minute/hour.
const FLOOR = NOW_SERVER - 2500 * 3600;

function fixture(options = {}) {
  const queries = [], reads = [], uploads = [], stored = new Map();
  const terminal = {
    subscribe() { return () => {}; },
    getSnapshot: () => ({ phase: 'connected', instance_id: 'fixture', epoch: 'epoch', account_id: '1001', server: 'Fixture-Broker',
      symbol: 'XAUUSD', features: ['history'], history_ready: true, server_offset_sec: 10800, commands: [] }),
    async requestReviewBars(symbol, tf, range) {
      const period = PERIOD[tf];
      const alignedFrom = Math.floor(range.from_server / period) * period;
      assert.ok(range.from_server <= range.to_server, 'request must not be reversed');
      assert.ok((range.to_server - range.from_server) / period + 1 <= 2000, 'EA validates inclusive range slots before CopyRates');
      assert.ok((Math.floor(range.to_server / period) * period - alignedFrom) / period + 1 <= 2000, 'CopyRates must not expand past 2000 aligned bars');
      reads.push({ symbol, tf, range: { ...range } });
      return { symbol, tf, range, time_basis: 'broker_server', bars: [[alignedFrom, 1, 2, 1, 2, 1]] };
    },
  };
  const sync = new BackfillBars({ terminal,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    accountKey: async () => 'fixture-account-key',
    now: () => (NOW_SERVER - 10800) * 1000,
    earliest: async () => ({ earliest_server: FLOOR + 100 * 60 }),
    coverage: async (query) => {
      queries.push({ ...query });
      return options.coverage ? options.coverage(query, queries.length) : { missing: [{ from: query.from, to: query.to }] };
    },
    upload: async (body) => { uploads.push(body); return { ok: true }; },
  });
  sync.bindUser('fixture-user');
  return { sync, queries, reads, uploads, stored };
}

test('backfill inclusive windows fit the actual EA limit for every timeframe at a nonaligned clock', async () => {
  const { sync, reads, queries, uploads, stored } = fixture();
  await sync.start();
  assert.equal(sync.getSnapshot().phase, 'ready');
  for (const [tf, period] of Object.entries(PERIOD)) {
    const first = reads.find((read) => read.tf === tf);
    assert.ok(first, `${tf} must be read`);
    assert.equal(first.range.to_server % period, 0);
    assert.equal((first.range.to_server - first.range.from_server) / period + 1, 2000);
    const pages = reads.filter((read) => read.tf === tf);
    for (let index = 1; index < pages.length; index += 1) {
      assert.ok(pages[index].range.to_server <= pages[index - 1].range.from_server, 'backward pages must not skip a time interval');
    }
  }
  assert.equal(uploads.length, reads.length);
  assert.ok(queries.every((query) => query.to % TF_PERIOD[query.tf] === 0));
  const checkpoint = JSON.parse([...stored.values()][0]);
  assert.equal(checkpoint.done, true);
  assert.ok(Object.values(checkpoint.cursors).every((cursor) => cursor === FLOOR));
});

test('coverage failure uses the same bounded inclusive request window', async () => {
  const { sync, reads } = fixture({ coverage() { throw new Error('synthetic coverage unavailable'); } });
  await sync.start();
  assert.equal(sync.getSnapshot().phase, 'ready');
  assert.ok(reads.length > 4);
});

test('coverage holes are clipped and aligned before every EA read', async () => {
  const { sync, reads, queries } = fixture({ coverage(query) {
    const period = TF_PERIOD[query.tf];
    return { missing: [{ from: query.from - 17 * period - 1, to: query.to + 17 * period + 1 }] };
  } });
  await sync.start();
  assert.equal(sync.getSnapshot().phase, 'ready');
  assert.equal(reads.length, queries.length);
  for (let index = 0; index < reads.length; index += 1) {
    assert.ok(reads[index].range.from_server >= queries[index].from);
    assert.ok(reads[index].range.to_server <= queries[index].to);
  }
});

test('the rightmost nonaligned hole advances only to its own left edge', async () => {
  let leftHole, firstQuery;
  const { sync, reads, queries } = fixture({ coverage(query, call) {
    if (call !== 1) return { missing: [] };
    firstQuery = { ...query };
    leftHole = { from: query.from + 13, to: query.from + 3 * 60 + 17 };
    return { missing: [leftHole, { from: query.to - 4 * 60 + 17, to: query.to - 2 * 60 + 23 }] };
  } });
  await sync.start();
  assert.equal(sync.getSnapshot().phase, 'ready');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].range.from_server, firstQuery.to - 4 * 60);
  assert.equal(reads[0].range.to_server, firstQuery.to - 2 * 60);
  assert.equal(queries[1].to, reads[0].range.from_server);
  assert.ok(queries[1].from <= leftHole.from && queries[1].to >= leftHole.to, 'left hole must remain inside the next coverage query');
});

test('a single-bar coverage hole remains a valid one-slot EA request', async () => {
  let leftHole;
  const { sync, reads, queries } = fixture({ coverage(query, call) {
    leftHole ??= { from: query.from + 60, to: query.from + 120 };
    return { missing: call === 1 ? [leftHole, { from: query.to, to: query.to }] : [] };
  } });
  await sync.start();
  assert.equal(sync.getSnapshot().phase, 'ready');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].range.from_server, reads[0].range.to_server);
  assert.equal(queries[1].to, queries[0].to - 60);
  assert.ok(queries[1].from <= leftHole.from && queries[1].to >= leftHole.to, 'one-bar hole must not skip another missing interval');
});
