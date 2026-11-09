import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/reviewHistory.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readReviewPage, readReviewRange, mergeReviewBars, visibleReviewGap } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const row = (time, close = 2) => [time, 1, 3, 0.5, close, 10];

test('review pages cross calendar gaps without EA, on the authorized trade endpoint', async () => {
  const urls = [];
  const read = async (url) => { urls.push(url); return { bars: [row(1793869500)], has_more: false }; };
  await readReviewPage(read, { shareId: null, person: 'owner', ticket: 'old-trade' }, 'M1', 'right', [row(1793063640)]);
  const url = new URL(urls[0], 'https://test.local');
  assert.equal(url.pathname, '/api/chart/bars');
  assert.equal(url.searchParams.get('after'), '1793063640');
  assert.equal(url.searchParams.get('limit'), '2000');
  assert.equal(url.searchParams.get('ticket'), 'old-trade');
  assert.equal(url.searchParams.has('to'), false, 'no calendar end can hide the next available bar');
});

test('latest keeps share access scope and clears pagination cursors', async () => {
  let result;
  await readReviewPage(async (url) => { result = new URL(url, 'https://test.local'); return { bars: [] }; },
    { shareId: 42, person: 'ignored', ticket: 'ignored' }, 'M5', 'latest', [row(1793063640)]);
  assert.equal(result.searchParams.get('share'), '42');
  for (const field of ['person', 'ticket', 'before', 'after', 'from', 'to', 'source']) assert.equal(result.searchParams.has(field), false);
});

test('left pagination excludes its first UTC bar and cannot silently use another feed', async () => {
  let url;
  await readReviewPage(async (value) => { url = new URL(value, 'https://test.local'); return { bars: [] }; },
    { shareId: null, person: 'owner', ticket: 'trade' }, 'M15', 'left', [row(1793063640)]);
  assert.equal(url.searchParams.get('before'), '1793063640');
  await assert.rejects(readReviewPage(async () => { throw new Error('must not fetch'); }, { shareId: null }, 'M1', 'latest', []), /选择一笔交易/);
});

test('merging preserves the snapshot, orders gap-separated bars, and replaces corrected candles', () => {
  const initial = [row(100), row(160)];
  const merged = mergeReviewBars(initial, [row(160, 2.5), row(500000)]);
  assert.deepEqual(merged.map((bar) => bar[0]), [100, 160, 500000]);
  assert.equal(merged[1][4], 2.5);
  assert.equal(initial[1][4], 2);
});

test('range and latest polling reject same-symbol data from a different broker', async () => {
  const scope = { shareId: 42, source: 'srv:Broker A', symbol: 'XAUUSD' };
  const read = async () => ({ bars: [row(160)], source: 'srv:Broker B', symbol: 'XAUUSD', tf: 'M1' });
  await assert.rejects(readReviewPage(read, scope, 'M1', 'latest', [], 2), /轨道已变化/);
  await assert.rejects(readReviewRange(read, scope, 'M1', 100, 200), /轨道已变化/);
});

test('polling identical candles keeps series identity, but a correction in a loaded gap is applied', () => {
  const initial = [row(100), row(220)];
  assert.equal(mergeReviewBars(initial, [row(220)]), initial);
  const merged = mergeReviewBars(initial, [row(160), row(220, 2.75)]);
  assert.deepEqual(merged.map(bar => [bar[0], bar[4]]), [[100, 2], [160, 2], [220, 2.75]]);
});

test('joining a snapshot to a recent page exposes the unloaded interior for paging', () => {
  const rows = [row(100), row(160), row(500000), row(500060)];
  assert.deepEqual(visibleReviewGap(rows, 100, 500060, 60), { from: 160, to: 500000 });
  assert.equal(visibleReviewGap(rows, 500000, 500060, 60), undefined);
});
