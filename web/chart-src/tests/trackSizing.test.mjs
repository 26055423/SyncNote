import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/vela/trackSizing.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { fitTrackWeights, fitSavedWorkspaceTracks } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test('a saved narrow third column gains room without changing the wider columns ratio', () => {
  const fitted = fitTrackWeights([2, 2, 1], 840);
  near(fitted.reduce((sum, weight) => sum + weight, 0), 5);
  near(fitted[0] / fitted[1], 1);
  near(fitted[2] / 5 * 840, 240);
  near(fitted[0] / 5 * 840, 300);
});

test('water filling handles several narrow tracks and preserves unconstrained ratios', () => {
  const fitted = fitTrackWeights([8, 4, 1, 1], 1400);
  near(fitted[2] / 14 * 1400, 240);
  near(fitted[3] / 14 * 1400, 240);
  near(fitted[0] / fitted[1], 2);
});

test('a grid narrower than the total minimum uses equal columns rather than overflowing', () => {
  const fitted = fitTrackWeights([2, 2, 1], 600);
  fitted.forEach(weight => near(weight, 5 / 3));
});

test('roomy proportions, malformed weights and unknown container widths are left alone', () => {
  for (const width of [0, -1, NaN, Infinity]) assert.deepEqual(fitTrackWeights([2, 2, 1], width), [2, 2, 1]);
  assert.deepEqual(fitTrackWeights([2, 2, 1], 1600), [2, 2, 1]);
  assert.deepEqual(fitTrackWeights([0, 1], 800), [0, 1]);
  assert.deepEqual(fitTrackWeights([NaN, 1], 800), [NaN, 1]);
});

test('normalizing a document changes only active-layout column sizes and never mutates input', () => {
  const state = { layout: 'g1x3', trackSizes: { g1x3: { cols: [2, 2, 1], rows: [1] }, other: { cols: [9, 1] } },
    charts: [{ id: 'c1', drawings: { important: true }, nativeIndicators: ['bigwolf'] }], activeCellId: 'c1' };
  const result = fitSavedWorkspaceTracks(state, 842);
  assert.notEqual(result, state);
  assert.equal(result.charts, state.charts);
  assert.equal(result.trackSizes.other, state.trackSizes.other);
  assert.equal(result.trackSizes.g1x3.rows, state.trackSizes.g1x3.rows);
  assert.deepEqual(state.trackSizes.g1x3.cols, [2, 2, 1]);
  near(result.trackSizes.g1x3.cols[2] / 5 * 840, 240);
  assert.equal(fitSavedWorkspaceTracks(result, 842), result, 'normalization is idempotent');
});

test('documents without saved splitters or with malformed active tracks preserve identity', () => {
  for (const state of [null, {}, { layout: '4' }, { layout: '4', trackSizes: { '4': { cols: 'bad' } } },
    { layout: '4', trackSizes: { '4': { cols: [1, 'bad'] } } }]) {
    assert.equal(fitSavedWorkspaceTracks(state, 842), state);
  }
});
