import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/marketSyncGate.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { syncChartReady } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('first uploaded bars cannot open charts while any sync task is active', () => {
  for (const status of ['waiting', 'running']) {
    assert.equal(syncChartReady(true, { job_id: 'sync-1', status }, null), false);
    assert.equal(syncChartReady(true, { job_id: 'sync-1', status }, 'sync-1'), false);
  }
});
test('a partial result needs explicit viewing consent for that exact job', () => {
  const job = { job_id: 'sync-2', status: 'partial' };
  assert.equal(syncChartReady(true, job, null), false);
  assert.equal(syncChartReady(true, job, 'sync-1'), false);
  assert.equal(syncChartReady(true, job, 'sync-2'), true);
});
test('reload checks task status before showing stored partial pages', () => {
  assert.equal(syncChartReady(false, null, null), false);
  assert.equal(syncChartReady(true, null, null), true);
  assert.equal(syncChartReady(true, { job_id: 'sync-1', status: 'completed' }, null), true);
  assert.equal(syncChartReady(true, { job_id: 'sync-1', status: 'error' }, null), false);
});
