import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { NativeRenderer, RendererControl } from '@luxalgo/vela';

const compiled = ts.transpileModule(readFileSync(new URL('../src/vela/viewportPan.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { panChartByTime, centerChartOnTime, restoreChartLeft } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const start = 1793000000000, period = 300000;
const row = (index) => ({ time: start + index * period, open: 100, high: 102, low: 99, close: 101, volume: 10 });
function fixture(gap = true) {
  const renderer = new NativeRenderer();
  // Test-only headless mount: retain the actual native coordinate/viewport implementation.
  renderer.scheduler = { invalidate() {} };
  renderer.animator = { start() {}, stop() {} };
  renderer.introPlayed = true;
  renderer.coords.setSize(800, 400, 1);
  const rows = Array.from({ length: 600 }, (_, i) => row(i));
  if (gap) rows.push(row(600 + 72 * 12));
  renderer.setBars(rows);
  renderer.setVisibleRange({ from: row(500).time, to: row(599).time });
  const chart = { getVisibleRange: () => renderer.getVisibleRange(), panBy: (fraction) => renderer.panBy(fraction), renderer: new RendererControl(renderer) };
  const spacing = () => renderer.coords.getViewport().barSpacing;
  return { renderer, chart, rows, spacing };
}

test('real native calendar-range translation reproduces the two huge candles across a gap', () => {
  const f = fixture(), range = f.chart.getVisibleRange();
  f.renderer.setVisibleRange({ from: range.from + 24 * 3600000, to: range.to + 24 * 3600000 });
  assert.equal(f.spacing(), 400, 'the original time-range pan fits only two logical bars');
});

test('constant-zoom pans survive a long gap, repeated drags and both data boundaries', () => {
  const f = fixture(), spacing = f.spacing();
  for (const delta of [24 * 3600000, -24 * 3600000, ...Array(50).fill(60000), -1e12, 1e12]) {
    panChartByTime(f.chart, delta);
    assert.equal(f.spacing(), spacing);
  }
  centerChartOnTime(f.chart, row(350).time);
  assert.equal(f.spacing(), spacing);
});

test('reloading series restores its left anchor without refitting clipped time ranges', () => {
  const f = fixture(false), left = f.chart.getVisibleRange().from, spacing = f.spacing();
  f.renderer.setBars([]);
  f.renderer.setBars(f.rows);
  restoreChartLeft(f.chart, left);
  assert.equal(f.spacing(), spacing);
  assert.ok(Math.abs(f.chart.getVisibleRange().from - left) <= period);
});

test('pans suppress animations only for the operation and restore them even on failure', () => {
 for (const original of [true, 140]) {
  let animation = original, observed;
  const chart = { getVisibleRange: () => ({ from: 0, to: 100 }),
    renderer: { get: () => animation, set: (_key, value) => { animation = value; } },
    panBy: (fraction) => { observed = [animation, fraction]; throw new Error('test failure'); } };
  assert.throws(() => panChartByTime(chart, 50), /test failure/);
  assert.deepEqual(observed, [false, 0.5]);
  assert.equal(animation, original);
 }
});

test('restoring a reload across a weekend searches screen distance without oscillating at the boundaries', () => {
  const f = fixture(false), left = f.chart.getVisibleRange().from, spacing = f.spacing();
  const monday = Array.from({ length: 600 }, (_, i) => row(i + 600 + 72 * 12));
  f.renderer.setBars([]);
  f.renderer.setBars([...f.rows, ...monday]);
  restoreChartLeft(f.chart, left);
  assert.equal(f.spacing(), spacing);
  assert.ok(Math.abs(f.chart.getVisibleRange().from - left) <= period);
});

test('unavailable, zero-width and invalid ranges never issue a pan', () => {
  for (const range of [null, { from: 1, to: 1 }, { from: 1, to: NaN }]) {
    const chart = { getVisibleRange: () => range, panBy: () => assert.fail('invalid pan') };
    assert.equal(panChartByTime(chart, 1), false);
  }
  assert.equal(panChartByTime({ getVisibleRange: () => ({ from: 0, to: 10 }), panBy() { assert.fail(); } }, Infinity), false);
});
