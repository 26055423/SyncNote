import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../src/indicatorHistory.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readIndicatorMinutes } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const row = time => [time, 10, 12, 9, 11];
test('review indicator history is scoped to the trade/share and paginates by real rows', async () => {
  const calls = [];
  const result = await readIndicatorMinutes(async url => {
    const q = new URL('https://test' + url); calls.push(q);
    return calls.length === 1 ? { bars: [row(120), row(180)], has_more: true } : { bars: [row(60)], has_more: false };
  }, { review: { shareId: 8 } }, 240000, 30000);
  assert.deepEqual(result.map(r => r[0]), [60,120,180]);
  assert.equal(calls[0].pathname, '/api/chart/bars');
  assert.equal(calls[0].searchParams.get('share'), '8');
  assert.equal(calls[0].searchParams.get('limit'), '20000');
  assert.equal(calls[1].searchParams.get('before'), '120');
});
test('live requests keep exact broker/symbol identity and reject future or repeated rows', async () => {
  await readIndicatorMinutes(async url => {
    const q = new URL('https://test' + url);
    assert.equal(q.pathname, '/api/market/bars');
    assert.equal(q.searchParams.get('source'), 'Exact:BROKER');
    assert.equal(q.searchParams.get('symbol'), 'NAS100.cash');
    return { bars: [row(60)], has_more: false };
  }, { source: 'Exact:BROKER', symbol: 'NAS100.cash' }, 120000, 20);
  await assert.rejects(readIndicatorMinutes(async () => ({ bars: [row(120)] }),
    { review: { shareId: 8 } }, 120000, 20), /范围错误/);
});
