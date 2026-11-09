import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { NativeRenderer, RendererControl } from '@luxalgo/vela';

const compiled = ts.transpileModule(readFileSync(new URL('../src/vela/chartInteractions.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace("'@luxalgo/vela'", JSON.stringify(import.meta.resolve('@luxalgo/vela')));
const { configurePriceScale, configureViewReset, prepareWorkspaceState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('a saved review resolves every cell against the currently registered provider', () => {
  const drawings = { drawings: [{ id: 'saved-line' }] };
  const saved = { layout: '3', charts: [
    { id: 'c1', provider: 'review', symbol: 'XAUUSD', timeframe: '1', drawings },
    { id: 'c2', provider: 'retired', symbol: 'retired:XAUUSD', timeframe: '5' },
  ] };
  const restored = prepareWorkspaceState(saved, 'sntrack7', 'XAUUSD');
  assert.deepEqual(restored.charts.map(cell => [cell.provider, cell.symbol, cell.timeframe]),
    [['sntrack7', 'XAUUSD', '1'], ['sntrack7', 'XAUUSD', '5']]);
  assert.deepEqual(restored.charts[0].drawings, drawings);
  assert.equal(saved.charts[0].provider, 'review');
});
function fixture() {
  const native = new NativeRenderer();
  native.scheduler = { invalidate() {}, destroy() {} };
  native.animator = { start() {}, stop() {} };
  native.showCountdown = false;
  // Config commits subscribe the unmounted renderer to Vela's shared second clock.
  return { renderer: new RendererControl(native), cleanup: () => native.countdownUnsub?.() };
}

test('native price fitting defaults to candles and remembers the axis-menu preference', () => {
  const stored = new Map();
  globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const first = fixture();
  const dispose = configurePriceScale(first);
  assert.equal(first.renderer.get('scalePriceOnly'), true);
  first.renderer.applyConfig({ priceScale: { priceOnly: false } });
  assert.equal(stored.get('sn-price-only-scale'), '0');
  const second = fixture();
  const disposeSecond = configurePriceScale(second);
  assert.equal(second.renderer.get('scalePriceOnly'), false);
  dispose(); disposeSecond(); first.cleanup(); second.cleanup(); delete globalThis.localStorage;
});

test('blocked browser storage still gives a readable candle price scale', () => {
  globalThis.localStorage = { getItem() { throw Error('blocked'); } };
  const chart = fixture();
  const dispose = configurePriceScale(chart);
  assert.equal(chart.renderer.get('scalePriceOnly'), true);
  dispose(); chart.cleanup(); delete globalThis.localStorage;
});

test('view reset counts real candles across a gap and keeps the historical right edge', async () => {
  const bars = Array.from({ length: 400 }, (_, i) => ({ time: i * 60_000 + (i >= 160 ? 172_800_000 : 0) }));
  const updates = [];
  const range = { from: bars[177].time, to: bars[180].time };
  const original = () => assert.fail('native reset jumps to the tail');
  const cell = { resetView: original, chart: {
    market: { symbol: 'XAUUSD', timeframe: '1' },
    renderer: { set: (key, value) => updates.push([key, value]) },
    getVisibleRange: () => range,
    setVisibleRange: next => updates.push(next),
  } };
  const dispose = configureViewReset(cell, async () => bars);
  cell.resetView();
  await Promise.resolve();
  assert.deepEqual(updates, [['autoScale', true], { from: bars[61].time, to: bars[180].time }]);
  dispose();
  assert.equal(cell.resetView, original);
});

test('a pending reset does not override a pan made while candle data is read', async () => {
  let range = { from: 60_000, to: 120_000 };
  let finish;
  const updates = [];
  const cell = { resetView() {}, chart: {
    market: { symbol: 'XAUUSD', timeframe: '1' },
    renderer: { set() {} },
    getVisibleRange: () => range,
    setVisibleRange: next => updates.push(next),
  } };
  configureViewReset(cell, () => new Promise(resolve => { finish = resolve; }));
  cell.resetView();
  range = { from: 0, to: 60_000 };
  finish([{ time: 0 }, { time: 60_000 }, { time: 120_000 }]);
  await Promise.resolve();
  assert.deepEqual(updates, []);
});
