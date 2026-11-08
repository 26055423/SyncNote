import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { NativeRenderer, RendererControl } from '@luxalgo/vela';

const compiled = ts.transpileModule(readFileSync(new URL('../src/vela/chartInteractions.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace("'@luxalgo/vela'", JSON.stringify(import.meta.resolve('@luxalgo/vela')));
const { configurePriceScale } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
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
