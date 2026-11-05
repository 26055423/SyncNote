import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/trackHistory.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readTrackPage, selectTrackSource } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const row = (time) => [time, 1, 3, 0.5, 2, 10];
const page = (times) => ({ source: 'srv:A', tf: 'M1', bars: times.map(row), has_more: false, earliest: times[0], next_before: null });

test('a stored track can be selected and paged with no EA connection', async () => {
  const catalog = { personal: null, sources: [{ id: 'srv:A', server: 'A', symbol: 'XAUUSD' }] };
  const selected = selectTrackSource(catalog, 'XAUUSD');
  assert.equal(selected, 'srv:A');
  const urls = [];
  const read = async (url) => {
    urls.push(url);
    const params = new URL('https://test.local'+url).searchParams;
    return params.has('before') ? page([600000000]) : { ...page([1700000000, 1700000060]), has_more: true, next_before: 1700000000 };
  };
  const head = await readTrackPage(read, { source: selected, symbol: 'XAUUSD', base: 'M1', limit: 6000 });
  const older = await readTrackPage(read, { source: selected, symbol: 'XAUUSD', base: 'M1', limit: 6000, before: head.next_before });
  assert.equal(older.bars[0][0], 600000000, 'a decades-long gap must not hide the older row');
  assert.equal(urls.length, 2);
  for (const url of urls) {
    const params = new URL('https://test.local'+url).searchParams;
    assert.equal(params.get('source'), selected);
    assert.equal(params.get('limit'), '6000');
    assert.equal(params.has('from'), false);
    assert.equal(params.has('to'), false);
  }
});

test('personal and connected-broker tracks never silently fall back to another broker', () => {
  const catalog = { personal: 'srv:personal-empty', sources: [{ id: 'srv:A', server: 'A', symbol: 'XAUUSD' }] };
  assert.equal(selectTrackSource(catalog, 'XAUUSD'), 'srv:personal-empty');
  assert.equal(selectTrackSource(catalog, 'XAUUSD', 'A'), 'srv:A');
  assert.equal(selectTrackSource(catalog, 'XAUUSD', 'B'), null);
});

test('wrong source, repeated cursor rows and unsorted history are rejected', async () => {
  const request = { source: 'srv:A', symbol: 'XAUUSD', base: 'M1', limit: 6000, before: 1000 };
  await assert.rejects(readTrackPage(async () => ({ ...page([60]), source: 'srv:B' }), request), /轨道/);
  await assert.rejects(readTrackPage(async () => page([1000]), request), /范围/);
  await assert.rejects(readTrackPage(async () => page([120, 60]), request), /范围/);
  await assert.rejects(readTrackPage(async () => page([60, 60]), request), /范围/);
});
