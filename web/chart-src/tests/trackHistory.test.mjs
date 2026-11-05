import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { MultiProviderFeed, BarStore } from '@luxalgo/vela';

const source = readFileSync(new URL('../src/trackHistory.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readTrackPage, readTrackHead, selectTrackSource, trackProviderName } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
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

test('a stale stored tip refreshes the missing recent candles instead of retaining only the live bar', async () => {
  const limits = [];
  const result = await readTrackHead(async (url) => {
    const limit = Number(new URL('https://test.local'+url).searchParams.get('limit')); limits.push(limit);
    return limit === 2 ? page([1060, 1120]) : page([180, 240, 300, 1060, 1120]);
  }, { source: 'srv:A', symbol: 'XAUUSD', base: 'M1', period: 60, storedTip: 120 });
  assert.deepEqual(limits, [2, 10082]);
  assert.deepEqual(result.bars.map((bar) => bar[0]), [180, 240, 300, 1060, 1120]);
});

test('normal stored increments keep the head request small and stay on the same track', async () => {
  const requests = [];
  const result = await readTrackHead(async (url) => { requests.push(url); return page([120, 180]); },
    { source: 'srv:A', symbol: 'XAUUSD', base: 'M1', period: 60, storedTip: 120 });
  assert.equal(requests.length, 1);
  assert.equal(new URL('https://test.local'+requests[0]).searchParams.get('limit'), '2');
  assert.equal(result.bars.at(-1)[0], 180);
});

test('wrong source, repeated cursor rows and unsorted history are rejected', async () => {
  const request = { source: 'srv:A', symbol: 'XAUUSD', base: 'M1', limit: 6000, before: 1000 };
  await assert.rejects(readTrackPage(async () => ({ ...page([60]), source: 'srv:B' }), request), /轨道/);
  await assert.rejects(readTrackPage(async () => page([1000]), request), /范围/);
  await assert.rejects(readTrackPage(async () => page([120, 60]), request), /范围/);
  await assert.rejects(readTrackPage(async () => page([60, 60]), request), /范围/);
});

test('track provider identifiers preserve exact source identity without forbidden separators', () => {
  const sources = ['', 'srv:A', 'srv:a', 'srv:A-B', 'srv:A_B', 'srv:券商:東京', 'srv:💱', 'srv:\ud83d', 'srv:A\0B'];
  const names = sources.map(trackProviderName);
  assert.equal(new Set(names).size, sources.length);
  for (let index = 0; index < sources.length; index += 1) {
    assert.match(names[index], /^sntrack[a-z0-9]+$/);
    assert.ok(names[index].length < 20, 'provider identifiers appear in the chart legend');
    assert.equal(trackProviderName(sources[index]), names[index], 'remounting the same source must keep its cache key');
  }
});

test('real Vela shared cache does not borrow bars when switching broker tracks', async () => {
  const store = new BarStore();
  const times = Array.from({ length: 600 }, (_, index) => 1700000000000 + index * 60000);
  const provider = (price) => ({
    info: () => ({ name: 'fixture', supportedTimeframes: ['1'], capabilities: { enumerate: true, stream: true } }),
    async listSymbols() { return [{ ticker: 'XAUUSD' }]; },
    async getBars(_symbol, _tf, range = {}) {
      let bars = times.map((time) => ({ time, open: price, high: price + 1, low: price - 1, close: price, volume: 1 }));
      if (range.from !== undefined) bars = bars.filter((bar) => bar.time >= range.from);
      if (range.to !== undefined) bars = bars.filter((bar) => bar.time <= range.to);
      return range.limit ? bars.slice(-range.limit) : bars;
    },
    subscribe: () => () => {},
  });
  // Remount separate feed instances against the same real store, as workspaces do.
  // Identical provider keys would retain 498 old-price rows plus only two new rows.
  for (const [sourceId, price] of [['srv:Broker-A', 100], ['srv:Broker-B', 200], ['srv:broker-b', 300]]) {
    const name = trackProviderName(sourceId);
    const feed = new MultiProviderFeed(store);
    feed.registerProvider(name, provider(price));
    const bars = await feed.load({ symbol: `${name}:XAUUSD`, timeframe: '1', bars: 500 });
    assert.equal(bars.length, 500);
    assert.ok(bars.every((bar) => bar.close === price && bar.open === price), `${sourceId} must not contain another broker's cached prices`);
  }
});
