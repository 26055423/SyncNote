import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function moduleFrom(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { mergeLiveHistory, prependLiveHistory, BASE_SECONDS } = await moduleFrom('../src/liveHistory.ts');
const { LiveProvider } = await moduleFrom('../src/vela/provider.ts');
const row = (time, close = 2) => [time, 1, 3, 0.5, close, 10];

test('paged M1 history survives repeated recent-window snapshots and live candles', () => {
  const initial = Array.from({ length: 1990 }, (_, i) => row((1000 + i) * 60));
  const cache = {};
  mergeLiveHistory(cache, { M1: initial });
  const identity = cache;
  const older = Array.from({ length: 1000 }, (_, i) => row(i * 60));
  let applied;
  assert.equal(prependLiveHistory(cache, 'M1', older, (base, bars) => { applied = { base, bars }; }), true);
  assert.equal(applied.base, 'M1');
  assert.equal(applied.bars.length, 2990);
  for (let tick = 0; tick < 20; tick += 1) {
    const recent = initial.slice(1).concat([row(2990 * 60, 2.1 + tick / 100)]);
    mergeLiveHistory(cache, { M1: recent });
  }
  assert.equal(cache, identity);
  assert.equal(cache.M1.length, 2991);
  assert.equal(cache.M1[0][0], 0);
  assert.equal(cache.M1.at(-1)[0], 2990 * 60);
  assert.equal(cache.M1.at(-1)[4], 2.29);
  assert.equal(initial.length, 1990, 'wire cache must not be mutated');
});

test('one valid older candle reaches chart replacement and the live provider', async () => {
  const cache = { M1: [row(120), row(180)] };
  const provider = new LiveProvider(cache, 'XAUUSD', () => () => {});
  const applications = [];
  assert.equal(prependLiveHistory(cache, 'M1', [row(60), row(60, 2.5), row(180, 999)], (base, bars) => applications.push({ base, bars })), true);
  assert.equal(applications.length, 1);
  assert.deepEqual(applications[0].bars.map((bar) => bar[0]), [60, 120, 180]);
  assert.equal(applications[0].bars[0][4], 2.5);
  assert.equal(applications[0].bars.at(-1)[4], 2);
  const rendered = await provider.getBars('XAUUSD', '1');
  assert.deepEqual(rendered.map((bar) => bar.time), [60000, 120000, 180000]);
  assert.equal(prependLiveHistory(cache, 'M1', [row(60), row(180)], () => assert.fail('overlap is not an older page')), false);
});

test('recent out-of-order corrections retain old pages and do not duplicate timestamps', () => {
  const cache = { M1: [row(60), row(180), row(240)] };
  mergeLiveHistory(cache, { M1: [row(120), row(180, 2.8), row(300)] });
  assert.deepEqual(cache.M1.map((bar) => bar[0]), [60, 120, 180, 240, 300]);
  assert.equal(cache.M1[2][4], 2.8);
  assert.deepEqual(BASE_SECONDS, { M1: 60, M5: 300, M15: 900, H1: 3600 });
});

test('older paging is not silently discarded once the previous 60000-row cutoff is reached', () => {
  const cache = { M1: Array.from({ length: 60000 }, (_, i) => row(i + 100)) };
  assert.equal(prependLiveHistory(cache, 'M1', [row(99)], () => {}), true);
  mergeLiveHistory(cache, { M1: [row(60099, 2.9), row(60100)] });
  assert.equal(cache.M1[0][0], 99);
  assert.equal(cache.M1.length, 60002);
});
