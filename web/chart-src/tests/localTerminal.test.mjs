import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Exercise the actual browser client with a fake wire, without MT5 or broker calls.
const source = readFileSync(new URL('../src/localTerminal.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const require = createRequire(import.meta.url);
const componentCache = new Map();
function loadComponent(path) {
  if (componentCache.has(path)) return componentCache.get(path);
  const exports = {};
  componentCache.set(path, exports);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => name.startsWith('.') ? loadComponent(resolve(dirname(path), `${name}.ts`)) : require(name) });
  return exports;
}
test('Nasdaq risk preview never inherits the gold contract multiplier', () => {
  const { previewRisk } = loadComponent(resolve(dirname(fileURLToPath(import.meta.url)), '../src/trade/risk.ts'));
  const result = previewRisk({ action: 'market', side: 'buy', symbol: 'USTEC', volume: 1, price: 0, sl: 19900, tp: 20200 }, { bid: 19999, ask: 20000 }, { currency: 'USD', balance: 10000, leverage: 100 }, true);
  assert.equal(result.notional, 0);
  assert.equal(result.marginUsd, null);
  assert.equal(result.riskUsd, null);
  assert.equal(result.rewardUsd, null);
  assert.equal(result.riskPctBalance, null);
  assert.equal(result.rr, 2);
});
function fixture(secure = true) {
  const timers = new Map();
  let timerId = 0;
  class Socket {
    static OPEN = 1;
    static sockets = [];
    readyState = 1;
    sent = [];
    constructor(url, protocol) { this.url = url; this.protocol = protocol; Socket.sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const window = {
    isSecureContext: secure,
    setInterval(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url), window, WebSocket: Socket, performance, crypto: webcrypto, AbortController, setTimeout, clearTimeout });
  const client = new exports.LocalTerminal();
  function connect(account = '1001', extra = {}) {
    client.connect();
    const socket = Socket.sockets.at(-1);
    socket.emit({ type: 'hello', protocol: 'tongpin-local', version: 1, instance_id: 'instance', epoch: 'epoch1' });
    client.pair('12345678');
    socket.emit({ type: 'pair_pending' });
    socket.emit({ type: 'paired', token: 'test-session-only', instance_id: 'instance', account_id: account, server: 'Demo-Server', epoch: 'epoch1', symbol: 'XAUUSD', read_only: false, demo: true, hedging: true, capabilities: ['market', 'close', 'cancel', 'modify'], ...extra });
    return socket;
  }
  return { client, connect, Socket, timers, access: exports.localTradeAccess };
}

test('EA clock samples retain raw UTC milliseconds and offset and clear on disconnect', () => {
  const { client, connect } = fixture();
  const socket = connect();
  socket.emit({ type: 'snapshot', server_time_ms: 1800000000000, server_offset_sec: 7200 });
  assert.equal(client.getSnapshot().clock_sample.server_time_ms, 1800000000000);
  assert.equal(client.getSnapshot().clock_sample.server_offset_sec, 7200);
  client.disconnect();
  assert.equal(client.getSnapshot().clock_sample, undefined);
});

test('quote sessions follow the exact connected broker symbol, including overnight sessions', async () => {
  const { client, connect } = fixture();
  const socket = connect('1001', { features: ['select_symbol'] });
  assert.equal(client.getSnapshot().quote_sessions, null);
  socket.emit({ type: 'snapshot', symbol: 'XAUUSD', quote_sessions: [[5, 82800, 90000]] });
  const gold = client.getSnapshot().quote_sessions;
  assert.deepEqual(Array.from(gold[0]), [5, 82800, 90000]);
  socket.emit({ type: 'snapshot', symbol: 'XAUUSD', quote_sessions: [[5, 82800, 90000]] });
  assert.equal(client.getSnapshot().quote_sessions, gold);
  const switching = client.selectSymbol('USTEC.m');
  const request = socket.sent.at(-1);
  socket.emit({ type: 'symbol_selected', request_id: request.request_id, symbol: 'USTEC.m', quote_sessions: [[1, 0, 86400]] });
  await switching;
  const nasdaq = client.getSnapshot().quote_sessions;
  assert.deepEqual(Array.from(nasdaq[0]), [1, 0, 86400]);
  socket.emit({ type: 'snapshot', symbol: 'XAUUSD', quote_sessions: [[5, 82800, 90000]] });
  assert.equal(client.getSnapshot().quote_sessions, nasdaq);
  socket.emit({ type: 'snapshot', symbol: 'USTEC.m', quote_sessions: [[7, 0, 86400]] });
  assert.equal(client.getSnapshot().quote_sessions, null);
  client.disconnect();
  assert.equal(client.getSnapshot().quote_sessions, null);
});

test('broker catalog pages preserve exact codes and authenticated request scope', async () => {
  const { client, connect } = fixture();
  const socket = connect('1001', { features: ['symbols', 'select_symbol'] });
  const result = client.requestSymbols();
  const first = socket.sent.at(-1);
  assert.equal(first.type, 'symbols');
  assert.equal(first.token, 'test-session-only');
  assert.equal(first.offset, 0);
  socket.emit({ type: 'symbols', request_id: first.request_id, symbols: [{ symbol: 'USTEC.m', description: 'US Tech 100' }], has_more: true, next_offset: 200 });
  await Promise.resolve();
  const second = socket.sent.at(-1);
  assert.equal(second.offset, 200);
  socket.emit({ type: 'symbols', request_id: second.request_id, symbols: [{ symbol: 'NAS100', description: 'Nasdaq 100 CFD' }], has_more: false });
  assert.deepEqual(Array.from(await result, (row) => row.symbol), ['USTEC.m', 'NAS100']);
});

test('symbol switch blocks orders then clears old series and rejects delayed old quotes', async () => {
  const { client, connect, access } = fixture();
  const socket = connect('1001', { features: ['symbols', 'select_symbol'] });
  const oldHistory = socket.sent.at(-1);
  socket.emit({ type: 'bar', symbol: 'XAUUSD', tf: '1m', bar: [100, 1, 2, 1, 2] });
  const selected = client.selectSymbol('USTEC.m');
  const request = socket.sent.at(-1);
  assert.equal(request.type, 'select_symbol');
  assert.equal(client.getSnapshot().symbol, 'XAUUSD');
  assert.equal(access(client.getSnapshot()).enabled, false);
  assert.throws(() => client.command('market', { symbol: 'XAUUSD' }), /正在切换/);
  socket.emit({ type: 'symbol_selected', request_id: request.request_id, symbol: 'USTEC.m' });
  await selected;
  assert.equal(client.getSnapshot().symbol, 'USTEC.m');
  assert.equal(Object.keys(client.getSnapshot().bars).length, 0);
  assert.equal(client.getSnapshot().tick, null);
  assert.equal(socket.sent.at(-1).symbol, 'USTEC.m');
  socket.emit({ type: 'bars', request_id: oldHistory.request_id, symbol: 'XAUUSD', tf: '1m', bars: [[100, 1, 2, 1, 2]] });
  socket.emit({ type: 'bar', symbol: 'XAUUSD', tf: '1m', bar: [200, 1, 2, 1, 2] });
  socket.emit({ type: 'tick', tick: { symbol: 'XAUUSD', bid: 1, ask: 2 } });
  socket.emit({ type: 'snapshot', symbol: 'XAUUSD', tick: { symbol: 'XAUUSD', bid: 1, ask: 2 }, account: { marker: 'stale' } });
  assert.equal(Object.keys(client.getSnapshot().bars).length, 0);
  assert.equal(client.getSnapshot().tick, null);
  assert.equal(client.getSnapshot().account.marker, undefined);
  socket.emit({ type: 'bar', symbol: 'USTEC.m', tf: '1m', bar: [200, 100, 102, 99, 101] });
  assert.equal(client.getSnapshot().bars['1m'][0][1], 100);
});

test('unknown order results prevent symbol switching and old EA never receives unsupported frames', async () => {
  const old = fixture();
  const oldSocket = old.connect();
  const sent = oldSocket.sent.length;
  await assert.rejects(old.client.requestSymbols(), /1\.108/);
  await assert.rejects(old.client.selectSymbol('USTEC'), /1\.108/);
  assert.equal(oldSocket.sent.length, sent);
  const { client, connect } = fixture();
  const socket = connect('1001', { features: ['symbols', 'select_symbol'] });
  client.command('market', { symbol: 'XAUUSD', side: 'buy', volume: 0.01 });
  await assert.rejects(client.selectSymbol('USTEC'), /结果尚未确认/);
  assert.equal(socket.sent.at(-1).type, 'command');
});

test('catalog disconnect rejects pending reads and switch timeout fails closed', async () => {
  const { client, connect, timers } = fixture();
  connect('1001', { features: ['symbols', 'select_symbol'] });
  const catalog = client.requestSymbols();
  client.disconnect();
  await assert.rejects(catalog, /连接已结束/);
  connect('1001', { features: ['symbols', 'select_symbol'] });
  const selected = client.selectSymbol('USTEC');
  const timer = [...timers.values()].find((row) => row.ms === 15000);
  timer.callback();
  await assert.rejects(selected, /超时/);
  assert.equal(client.getSnapshot().phase, 'error');
  assert.match(client.getSnapshot().error, /切换未获确认/);
});

test('EA rejected switch preserves current symbol and connection', async () => {
  const { client, connect } = fixture();
  const socket = connect('1001', { features: ['symbols', 'select_symbol'] });
  const selected = client.selectSymbol('FAKE');
  socket.emit({ type: 'error', request_id: socket.sent.at(-1).request_id, code: 'SYMBOL', error: 'Unavailable broker symbol' });
  await assert.rejects(selected, /Unavailable/);
  assert.equal(client.getSnapshot().phase, 'connected');
  assert.equal(client.getSnapshot().symbol, 'XAUUSD');
  assert.equal(client.getSnapshot().symbol_switching, false);
});

test('HTTP production is blocked before a local connection is opened', () => {
  const { client, Socket } = fixture(false);
  client.connect();
  assert.equal(Socket.sockets.length, 0);
  assert.equal(client.getSnapshot().phase, 'error');
  assert.match(client.getSnapshot().error, /HTTPS/);
});

test('pairing waits for local approval and sends history serially with scoped credentials', () => {
  const { client, Socket } = fixture();
  client.connect();
  const socket = Socket.sockets.at(-1);
  assert.equal(socket.url, 'ws://127.0.0.1:18765/ws');
  assert.equal(socket.protocol, 'tongpin-local.v1');
  socket.emit({ type: 'hello', protocol: 'tongpin-local', version: 1 });
  assert.throws(() => client.command('market', {}), /未授权/);
  client.pair('12345678');
  assert.deepEqual(socket.sent[0], { type: 'pair', code: '12345678' });
  socket.emit({ type: 'pair_pending' });
  assert.equal(client.getSnapshot().phase, 'confirming');
  socket.emit({ type: 'paired', token: 'ram-only', account_id: '1001', server: 'Demo', epoch: 'e1', symbol: 'XAUUSD', read_only: true, demo: true });
  assert.equal(client.getSnapshot().phase, 'connected');
  assert.equal(socket.sent.filter((message) => message.type === 'bars').length, 1);
  assert.equal(socket.sent.at(-1).tf, '1m');
  assert.equal(socket.sent.at(-1).limit, 500);
  assert.equal(socket.sent.at(-1).from_server, undefined);
  assert.equal(socket.sent.at(-1).account_id, '1001');
  assert.equal(socket.sent.at(-1).token, 'ram-only');
  socket.emit({ type: 'bars', request_id: socket.sent.at(-1).request_id, tf: '1m', bars: [[100, 1, 2, 1, 2]] });
  assert.equal(socket.sent.at(-1).tf, '5m');
  assert.equal(client.getSnapshot().bars['1m'][0][0], 100);
  assert.equal(client.getSnapshot().history_ready, false);
});

test('empty bootstrap history preserves candles already pushed by the terminal', () => {
  const { client, connect } = fixture();
  const socket = connect();
  const request = socket.sent.at(-1);
  socket.emit({ type: 'bar', tf: '1m', symbol: 'XAUUSD', bar: [180, 1, 3, 1, 3, 10] });
  socket.emit({ type: 'bars', request_id: request.request_id, tf: '1m', symbol: 'XAUUSD', bars: [] });
  assert.deepEqual(Array.from(client.getSnapshot().bars['1m'], row => Array.from(row)), [[180, 1, 3, 1, 3, 10]]);
  assert.equal(socket.sent.at(-1).tf, '5m');
});

test('history errors and read timeouts advance bootstrap without replaying a trade', () => {
  const { client, connect, timers } = fixture();
  const socket = connect();
  socket.emit({ type: 'error', code: 'HISTORY_UNAVAILABLE', error: 'load history in MT5', request_id: socket.sent.at(-1).request_id });
  assert.equal(client.getSnapshot().phase, 'connected');
  assert.equal(client.getSnapshot().error, '');
  assert.match(client.getSnapshot().historyWarnings['1m'], /历史行情/);
  assert.equal(socket.sent.at(-1).tf, '5m');
  const timer = [...timers.values()].find((row) => row.ms === 10000);
  timer.callback();
  assert.equal(client.getSnapshot().error, '');
  assert.match(client.getSnapshot().historyWarnings['5m'], /加载超时/);
  assert.equal(socket.sent.at(-1).tf, '15m');
  socket.emit({ type: 'bars', tf: '15m', request_id: socket.sent.at(-1).request_id, bars: [[100, 1, 2, 1, 2]] });
  assert.equal(socket.sent.at(-1).tf, '1h');
  socket.emit({ type: 'bars', tf: '1h', request_id: socket.sent.at(-1).request_id, bars: [[100, 1, 2, 1, 2]] });
  assert.equal(client.getSnapshot().history_ready, true);
  assert.equal(socket.sent.filter((row) => row.type === 'command').length, 0);
});

test('real, unknown-type, read-only or missing-capability accounts cannot trade', () => {
  for (const extra of [{ demo: false }, { demo: undefined }, { read_only: true }, { capabilities: [] }]) {
    const { client, connect } = fixture();
    const socket = connect('1001', extra);
    assert.throws(() => client.command('market', { side: 'buy', volume: 0.01 }), /未授权/);
    assert.equal(socket.sent.filter((message) => message.type === 'command').length, 0);
  }
});

test('actual EA action declarations authorize limit and stop frames with their requested prices', () => {
  const eaSource = readFileSync(new URL('../../../bridge/SyncTrade.mq5', import.meta.url), 'utf8');
  const declaration = eaSource.match(/string CapabilitiesJson\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(declaration, 'the EA capability declaration must remain inspectable');
  // All local opt-ins enabled: use the concrete actions declared by the real EA,
  // rather than inventing a market-only fake handshake as older tests did.
  const capabilities = [...new Set([...declaration.matchAll(/\\"(market|limit|stop|close|cancel|modify|pending)\\"/g)].map((match) => match[1]))];
  assert.ok(capabilities.includes('limit'), 'EA must declare the concrete limit action');
  assert.ok(capabilities.includes('stop'), 'EA must declare the concrete stop action');
  const { client, connect } = fixture();
  const socket = connect('1001', { capabilities });
  for (const [action, price] of [['limit', 2400.5], ['stop', 2420.5]]) {
    const id = client.command(action, { symbol: 'XAUUSD', side: 'buy', volume: 0.01, price });
    const request = socket.sent.at(-1);
    assert.equal(request.type, 'command');
    assert.equal(request.action, action);
    assert.equal(request.price, price);
    assert.equal(request.account_id, '1001');
    socket.emit({ type: 'command_result', command_id: id, state: 'completed', order: '77', retcode: 10008 });
  }
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 2);
});

test('pending compatibility labels never grant undeclared limit or stop actions', () => {
  for (const capabilities of [['market', 'pending'], ['limit'], ['stop']]) {
    for (const action of ['limit', 'stop']) {
      const { client, connect } = fixture();
      const socket = connect('1001', { capabilities });
      if (capabilities.includes(action)) client.command(action, { symbol: 'XAUUSD', side: 'buy', volume: 0.01, price: 2400 });
      else assert.throws(() => client.command(action, { price: 2400 }), /未授权/);
      assert.equal(socket.sent.filter((message) => message.type === 'command').length, capabilities.includes(action) ? 1 : 0);
    }
  }
});

test('accepted pending-order placement completes its command and permits an explicit cancel', () => {
  const { client, connect, timers } = fixture();
  const socket = connect('1001', { capabilities: ['limit', 'cancel'] });
  const id = client.command('limit', { symbol: 'XAUUSD', side: 'buy', volume: 0.01, price: 2400 });
  socket.emit({ type: 'command_result', command_id: id, state: 'completed', retcode: 10008, order: '77' });
  assert.equal(client.getSnapshot().commands[0].state, 'completed');
  assert.equal([...timers.values()].filter((timer) => timer.ms === 15000).length, 0);
  client.command('cancel', { order_ticket: '77' });
  const requests = socket.sent.filter((message) => message.type === 'command');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].action, 'cancel');
  assert.equal(requests[1].order_ticket, '77');
});

test('real accounts need an explicit boolean real_trading opt-in even when capabilities allow the action', () => {
  for (const real_trading of [undefined, false, 'true', 1]) {
    const { client, connect } = fixture();
    const socket = connect('2002', { demo: false, real_trading, capabilities: ['market', 'limit', 'stop'] });
    assert.throws(() => client.command('market', { volume: 0.01 }), /未授权/);
    assert.equal(socket.sent.filter((message) => message.type === 'command').length, 0);
  }
  const { client, connect } = fixture();
  const socket = connect('2002', { demo: false, real_trading: true, capabilities: ['limit'] });
  assert.throws(() => client.command('market', { volume: 0.01 }), /未授权/);
  client.command('limit', { symbol: 'XAUUSD', side: 'buy', volume: 0.01, price: 2400 });
  assert.equal(socket.sent.at(-1).account_id, '2002');
  assert.equal(socket.sent.at(-1).action, 'limit');
});

test('netting or unknown account modes cannot close or modify without explicit local management permission', () => {
  for (const hedging of [false, undefined]) {
    for (const action of ['close', 'modify']) {
      const { client, connect } = fixture();
      const socket = connect('1001', { hedging, netting_manage: false, capabilities: ['close', 'modify'] });
      assert.throws(() => client.command(action, { position_ticket: '7', ticket: '7' }), /持仓管理/);
      assert.equal(socket.sent.filter((message) => message.type === 'command').length, 0);
    }
  }
  const { client, connect } = fixture();
  const socket = connect('1001', { hedging: false, netting_manage: true, capabilities: ['close'] });
  client.command('close', { position_ticket: '7', volume: 0 });
  assert.equal(socket.sent.at(-1).action, 'close');
});

test('snapshot permission updates revoke real trading and concrete action capabilities immediately', () => {
  const { client, connect } = fixture();
  const socket = connect('2002', { demo: false, real_trading: true, capabilities: ['market', 'limit', 'stop'] });
  socket.emit({ type: 'snapshot', read_only: false, demo: false, real_trading: false, capabilities: ['market', 'limit', 'stop'] });
  assert.throws(() => client.command('limit', { price: 2400 }), /未授权/);
  socket.emit({ type: 'snapshot', read_only: false, demo: false, real_trading: true, capabilities: ['limit'], hedging: false, netting_manage: false });
  assert.throws(() => client.command('stop', { price: 2420 }), /未授权/);
  assert.equal(client.getSnapshot().hedging, false);
  assert.equal(client.getSnapshot().netting_manage, false);
  client.command('limit', { symbol: 'XAUUSD', side: 'buy', volume: 0.01, price: 2400 });
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 1);
});

test('unrestricted authorization permits real-account opening and netting management without legacy flags', () => {
  const { client, connect, access } = fixture();
  const socket = connect('2002', { demo: false, real_trading: false, unrestricted: true, hedging: false, netting_manage: false,
    capabilities: ['market', 'close', 'modify'] });
  const permission = access(client.getSnapshot());
  assert.equal(permission.enabled, true);
  assert.equal(permission.canManage, true);
  assert.equal(permission.realTrading, true);
  assert.equal(permission.lockedReason, '');
  for (const action of ['market', 'close', 'modify']) {
    const id = client.command(action, { symbol: 'XAUUSD', side: 'buy', volume: 2, position_ticket: '7', ticket: '7' });
    assert.equal(socket.sent.at(-1).action, action);
    assert.equal(socket.sent.at(-1).token, 'test-session-only');
    socket.emit({ type: 'command_result', command_id: id, state: 'completed' });
  }
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 3);
});

test('unrestricted requires a boolean grant and still respects read-only and concrete capabilities', () => {
  for (const extra of [{ unrestricted: 'true' }, { unrestricted: 1 }, { unrestricted: false },
    { unrestricted: true, read_only: true }, { unrestricted: true, capabilities: [] }]) {
    const { client, connect } = fixture();
    const socket = connect('2002', { demo: false, real_trading: false, ...extra });
    assert.throws(() => client.command('market', { volume: 2 }), /未授权/);
    assert.equal(socket.sent.filter((message) => message.type === 'command').length, 0);
  }
});

test('quota-unrestricted trading removes account and lot gates without granting netting management', () => {
  const { client, connect, access } = fixture();
  const socket = connect('2002', { demo: false, real_trading: false, unrestricted: false, quota_unrestricted: true,
    hedging: false, netting_manage: false, capabilities: ['market', 'close', 'modify'] });
  assert.equal(access(client.getSnapshot()).enabled, true);
  assert.equal(access(client.getSnapshot()).lockedReason, '');
  assert.equal(access(client.getSnapshot()).canManage, false);
  const id = client.command('market', { symbol: 'XAUUSD', side: 'buy', volume: 2 });
  assert.equal(socket.sent.at(-1).volume, 2);
  socket.emit({ type: 'command_result', command_id: id, state: 'completed' });
  assert.throws(() => client.command('close', { position_ticket: '7', volume: 0 }), /持仓管理/);
  assert.throws(() => client.command('modify', { ticket: '7', sl: 2300 }), /持仓管理/);
  socket.emit({ type: 'snapshot', netting_manage: true });
  client.command('close', { position_ticket: '7', volume: 0 });
  assert.equal(socket.sent.at(-1).action, 'close');
});

test('quota permission is explicit, updates with snapshots and never overrides read-only or unresolved commands', () => {
  for (const quota_unrestricted of [undefined, false, 'true', 1]) {
    const { client, connect } = fixture();
    connect('2002', { demo: false, real_trading: false, quota_unrestricted });
    assert.throws(() => client.command('market', { volume: 2 }), /未授权/);
  }
  const { client, connect, access } = fixture();
  const socket = connect('2002', { demo: false, real_trading: false });
  socket.emit({ type: 'snapshot', quota_unrestricted: true });
  assert.equal(client.getSnapshot().quota_unrestricted, true);
  socket.emit({ type: 'snapshot', positions: [] });
  assert.equal(client.getSnapshot().quota_unrestricted, true);
  const id = client.command('market', { volume: 2 });
  assert.throws(() => client.command('market', { volume: 2 }), /尚未确认/);
  socket.emit({ type: 'command_result', command_id: id, state: 'completed' });
  socket.emit({ type: 'snapshot', read_only: true, block_reason: 'risk' });
  assert.equal(access(client.getSnapshot()).enabled, false);
  assert.match(access(client.getSnapshot()).lockedReason, /保留下单日志/);
  assert.throws(() => client.command('market', { volume: 2 }), /未授权/);
  socket.emit({ type: 'snapshot', read_only: false, quota_unrestricted: false, block_reason: '' });
  assert.equal(client.getSnapshot().quota_unrestricted, false);
  assert.throws(() => client.command('market', { volume: 2 }), /未授权/);
});

test('snapshots can grant and revoke unrestricted permission and preserve exact read-only diagnostics', () => {
  const { client, connect, access } = fixture();
  const socket = connect('2002', { demo: false, real_trading: false, hedging: false, netting_manage: false, unrestricted: true });
  socket.emit({ type: 'snapshot', positions: [] });
  assert.equal(client.getSnapshot().unrestricted, true);
  socket.emit({ type: 'snapshot', unrestricted: false, real_no_caps: false, block_reason: 'real_not_allowed' });
  assert.equal(client.getSnapshot().unrestricted, false);
  assert.throws(() => client.command('market', { volume: 2 }), /未授权/);
  socket.emit({ type: 'snapshot', unrestricted: true, real_no_caps: true, block_reason: '', read_only: false });
  assert.equal(access(client.getSnapshot()).lockedReason, '');
  const id = client.command('close', { position_ticket: '7', volume: 0 });
  assert.equal(socket.sent.at(-1).action, 'close');
  assert.throws(() => client.command('market', { volume: 2 }), /尚未确认/);
  socket.emit({ type: 'command_result', command_id: id, state: 'completed' });
  socket.emit({ type: 'snapshot', read_only: true, block_reason: 'journal' });
  assert.equal(client.getSnapshot().block_reason, 'journal');
  assert.equal(client.getSnapshot().real_no_caps, true);
  assert.equal(access(client.getSnapshot()).enabled, false);
  assert.match(access(client.getSnapshot()).lockedReason, /下单日志/);
  assert.throws(() => client.command('market', { volume: 2 }), /未授权/);
});

test('quota-unrestricted risk preview removes the local lot cap while retaining numeric and price validation', () => {
  const { previewRisk } = loadComponent(fileURLToPath(new URL('../src/trade/risk.ts', import.meta.url)));
  const request = { action: 'market', side: 'buy', symbol: 'XAUUSD', volume: 2, price: 0, sl: 0, tp: 0, deviation: 20, magic: 0, comment: '' };
  const ref = { bid: 2400, ask: 2401 };
  assert.ok(previewRisk(request, ref, null).problems.some((message) => message.includes('手数不得超过')));
  assert.equal(previewRisk(request, ref, null, true).problems.length, 0);
  for (const volume of [0, -1, NaN, Infinity]) {
    assert.ok(previewRisk({ ...request, volume }, ref, null, true).problems.includes('手数必须大于 0'));
  }
  const limit = { ...request, action: 'limit', price: 1200 };
  assert.ok(previewRisk(limit, ref, null).problems.some((message) => message.includes('价格偏离')));
  assert.ok(previewRisk(limit, ref, null, true).problems.some((message) => message.includes('价格偏离')));
  assert.ok(previewRisk({ ...limit, price: 2500 }, ref, null, true).problems.includes('买入限价需低于当前卖价'));
  assert.ok(previewRisk({ ...request, sl: 2500 }, ref, null, true).problems.includes('买单止损需低于入场价'));
});

test('the order ticket enables only individually declared market/limit/stop controls', () => {
  const { OrderTicket } = loadComponent(fileURLToPath(new URL('../src/trade/OrderTicket.tsx', import.meta.url)));
  for (const allowedActions of [['market'], ['limit'], ['stop'], ['limit', 'stop'], ['pending']]) {
    const html = renderToStaticMarkup(createElement(OrderTicket, { account: { login: '1001', currency: 'USD' },
      symbol: 'XAUUSD', bid: 2400, ask: 2401, connected: true, allowedActions }));
    const buttons = [...html.matchAll(/<button([^>]*)>(市价|限价|止损)<\/button>/g)];
    assert.equal(buttons.length, 3);
    for (const [index, action] of ['market', 'limit', 'stop'].entries()) {
      assert.equal(buttons[index][1].includes('disabled'), !allowedActions.includes(action));
    }
  }
});

test('a real-account ticket still presents both explicit trading unlocks', () => {
  const { OrderTicket } = loadComponent(fileURLToPath(new URL('../src/trade/OrderTicket.tsx', import.meta.url)));
  const html = renderToStaticMarkup(createElement(OrderTicket, { account: { login: '2002', currency: 'USD' },
    symbol: 'XAUUSD', bid: 2400, ask: 2401, connected: true, real: true, allowedActions: ['market', 'limit', 'stop'] }));
  assert.match(html, /解锁下单/);
  assert.match(html, /确认按实盘下单/);
  assert.match(html, /<button[^>]*class="submit[^>]*disabled/);
});

test('a trade is sent exactly once by the UI; timeout queries do not resend', () => {
  const { client, connect, timers } = fixture();
  const socket = connect();
  const id = client.command('market', { side: 'buy', symbol: 'XAUUSD', volume: 0.01 });
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 1);
  assert.throws(() => client.command('market', { side: 'buy' }), /尚未确认/);
  for (const timer of [...timers.values()]) if (timer.ms === 15000) timer.callback();
  assert.equal(client.getSnapshot().commands[0].state, 'uncertain');
  client.queryCommand(id);
  assert.equal(socket.sent.at(-1).type, 'command_status');
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 1);
  socket.emit({ type: 'command_result', command_id: id, state: 'not_found' });
  assert.throws(() => client.command('market', {}), /尚未确认/);
  socket.emit({ type: 'command_result', command_id: id, state: 'completed', order: '77', deal: '88' });
  assert.equal(client.getSnapshot().commands[0].deal, '88');
  client.command('cancel', { order_ticket: '99' });
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 2);
});

test('disconnect revokes credentials, marks pending trades uncertain and never auto-reconnects', () => {
  const { client, connect, Socket } = fixture();
  const socket = connect();
  const id = client.command('close', { position_ticket: '7', volume: 0 });
  socket.onclose();
  assert.equal(client.getSnapshot().phase, 'error');
  assert.equal(client.getSnapshot().commands[0].command_id, id);
  assert.equal(client.getSnapshot().commands[0].state, 'uncertain');
  assert.equal(Socket.sockets.length, 1);
  assert.throws(() => client.queryCommand(id));
});

test('an unknown old-account trade blocks only its own account after reconnect', () => {
  const { client, connect } = fixture();
  connect('1001');
  const oldId = client.command('market', { side: 'buy', volume: 0.01 });
  client.disconnect();
  const socket = connect('2002');
  assert.throws(() => client.queryCommand(oldId), /对应的 MT5 账户/);
  client.command('market', { side: 'sell', volume: 0.01 });
  assert.equal(socket.sent.at(-1).account_id, '2002');
});

test('an account epoch change immediately disables the connection and clears local account data', () => {
  const { client, connect } = fixture();
  const socket = connect();
  socket.emit({ type: 'snapshot', epoch: 'epoch1', account: { login: '1001', balance: 5000 }, positions: [{ ticket: '1' }] });
  assert.equal(client.getSnapshot().positions.length, 1);
  socket.emit({ type: 'snapshot', epoch: 'different-epoch', account: { login: '2002' } });
  assert.equal(client.getSnapshot().phase, 'error');
  assert.equal(client.getSnapshot().account_id, '');
  assert.equal(client.getSnapshot().positions.length, 0);
});

test('command expiry uses the EA clock sample and the same request keeps its ID', () => {
  const { client, connect } = fixture();
  const socket = connect();
  const clock = Date.now() + 50000;
  socket.emit({ type: 'pong', server_time_ms: clock });
  const id = client.command('modify', { ticket: '7', sl: 2000, tp: 3000 });
  assert.equal(socket.sent.at(-1).command_id, id);
  assert.ok(Math.abs(socket.sent.at(-1).expires_at_ms - (clock + 10000)) < 100);
});

test('note history reads use broker ranges and cancel without issuing any trading command', async () => {
  const { client, connect } = fixture();
  const socket = connect('1001', { features: ['history'], product: 'SyncTrade', server_offset_sec: 10800 });
  for (let index = 0; index < 4; index += 1) {
    const request = socket.sent.at(-1);
    socket.emit({ type: 'bars', request_id: request.request_id, tf: request.tf, bars: [[100, 1, 2, 1, 2]] });
  }
  const controller = new AbortController();
  const read = client.requestHistoryPage({ from_server: 1700000000, to_server: 1700100000 }, 'scan-cursor', controller.signal);
  const request = socket.sent.at(-1);
  assert.equal(request.type, 'history');
  assert.equal(request.from, 1700000000);
  assert.equal(request.to, 1700100000);
  assert.equal(request.cursor, 'scan-cursor');
  assert.equal(request.limit, 100);
  assert.equal(request.token, 'test-session-only');
  controller.abort();
  await assert.rejects(read, /取消/);
  socket.emit({ type: 'history', request_id: request.request_id, deals: [{ deal_ticket: '1' }] });
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 0);
});

test('review range bars are returned to the note job without overwriting live-chart UTC cache', async () => {
  const { client, connect } = fixture();
  const socket = connect('1001', { features: ['history'], product: 'SyncTrade' });
  for (let index = 0; index < 4; index += 1) {
    const request = socket.sent.at(-1);
    socket.emit({ type: 'bars', request_id: request.request_id, tf: request.tf, bars: [[100, 1, 2, 1, 2]] });
  }
  const controller = new AbortController();
  const range = { from_server: 1700000000, to_server: 1700100000 };
  const read = client.requestReviewBars('EURUSD', '1m', range, controller.signal);
  const request = socket.sent.at(-1);
  socket.emit({ type: 'bars', request_id: request.request_id, symbol: 'EURUSD', tf: '1m', range, time_basis: 'broker_server', bars: [[1700000000, 1, 2, 1, 2]] });
  const page = await read;
  assert.equal(page.bars[0][0], 1700000000);
  assert.equal(client.getSnapshot().bars['1m'][0][0], 100);
});

function olderHistoryFixture() {
  const setup = fixture();
  const socket = setup.connect('1001', { features: ['history'], product: 'SyncTrade', server_offset_sec: 10800 });
  for (let index = 0; index < 4; index += 1) {
    const request = socket.sent.at(-1);
    socket.emit({ type: 'bars', request_id: request.request_id, tf: request.tf, bars: [[100, 1, 2, 1, 2]] });
  }
  const respond = (request, bars, extra = {}) => socket.emit({
    type: 'bars', request_id: request.request_id, symbol: request.symbol, tf: request.tf,
    range: { from_server: request.from_server, to_server: request.to_server }, time_basis: 'broker_server', bars, ...extra,
  });
  return { ...setup, socket, respond };
}

test('a local read conflict returns an explicit busy code before sending another frame', async () => {
  for (const kind of ['history', 'bars']) {
    const { client, socket } = olderHistoryFixture();
    const controller = new AbortController();
    const range = { from_server: 1700000000, to_server: 1700100000 };
    const pending = kind === 'history' ? client.requestHistoryPage(range, '', controller.signal)
      : client.requestReviewBars('EURUSD', '1m', range, controller.signal);
    const before = socket.sent.length;
    const blocked = new AbortController();
    await assert.rejects(client.requestHistoryPage(range, '', blocked.signal), (error) => error.code === 'history_read_busy');
    await assert.rejects(client.requestReviewBars('EURUSD', '1m', range, blocked.signal), (error) => error.code === 'history_read_busy');
    assert.equal(socket.sent.length, before, 'no request or trade frame was sent for either rejected read');
    controller.abort();await assert.rejects(pending, /取消/);
  }
});

test('older live bars cross an empty closure window and retain a one-bar UTC page', async () => {
  const { client, socket, respond } = olderHistoryFixture();
  const read = client.loadOlderBars('1m', 1700000000);
  const first = socket.sent.at(-1);
  assert.equal(first.to_server, 1700000000 + 10800 - 1);
  assert.equal(first.to_server - first.from_server, 1989 * 60);
  respond(first, []);
  await Promise.resolve();
  const second = socket.sent.at(-1);
  assert.notEqual(second.request_id, first.request_id);
  assert.equal(second.to_server, first.from_server - 1);
  respond(second, [[second.from_server, 1, 2, 1, 2, 3]]);
  const rows = await read;
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], second.from_server - 10800);
  assert.equal(rows[0][5], 3);
  assert.equal(socket.sent.filter((message) => message.type === 'command').length, 0);
});

test('older live bars scan only explicitly identified unavailable windows and stay bounded', async () => {
  for (const detail of ['MT5 history is not ready for this range', 'MT5 history starts later than the requested range']) {
    const { client, socket } = olderHistoryFixture();
    const before = socket.sent.length;
    const read = client.loadOlderBars('1m', 1700000000);
    for (let probe = 0; probe < 4; probe += 1) {
      const request = socket.sent.at(-1);
      socket.emit({ type: 'error', request_id: request.request_id, code: 'HISTORY_UNAVAILABLE', error: detail });
      await Promise.resolve();
    }
    assert.equal((await read).length, 0);
    assert.equal(socket.sent.length - before, 4);
  }
});

test('older live bars do not scan past busy, timeout or unspecified unavailable failures', async () => {
  for (const [code, detail] of [['BARS_BUSY', 'Wait for current bars/history response'], ['HISTORY_UNAVAILABLE', 'Open this symbol/timeframe in MT5 to load history first']]) {
    const { client, socket } = olderHistoryFixture();
    const before = socket.sent.length;
    const read = client.loadOlderBars('1m', 1700000000);
    socket.emit({ type: 'error', request_id: socket.sent.at(-1).request_id, code, error: detail });
    await assert.rejects(read, new RegExp(code));
    assert.equal(socket.sent.length - before, 1);
  }
  const { client, socket, timers } = olderHistoryFixture();
  const before = socket.sent.length;
  const read = client.loadOlderBars('1m', 1700000000);
  [...timers.values()].find((timer) => timer.ms === 30000).callback();
  await assert.rejects(read, /HISTORY_TIMEOUT/);
  assert.equal(socket.sent.length - before, 1);
});

test('older live bars reject disconnects and epoch changes without accepting a late page', async () => {
  for (const change of ['disconnect', 'epoch']) {
    const { client, socket, respond } = olderHistoryFixture();
    const before = socket.sent.length;
    const read = client.loadOlderBars('1m', 1700000000);
    const request = socket.sent.at(-1);
    if (change === 'disconnect') client.disconnect();
    else socket.emit({ type: 'snapshot', epoch: 'epoch2' });
    respond(request, [[request.from_server, 1, 2, 1, 2]]);
    await assert.rejects(read, /会话已改变/);
    assert.equal(socket.sent.length - before, 1);
  }
});

test('older live bars recheck the session between windows and reject another symbol', async () => {
  const { client, socket, respond } = olderHistoryFixture();
  const before = socket.sent.length;
  const read = client.loadOlderBars('1m', 1700000000);
  respond(socket.sent.at(-1), []);
  client.disconnect();
  await assert.rejects(read, /会话已改变/);
  assert.equal(socket.sent.length - before, 1);

  const next = olderHistoryFixture();
  const wrong = next.client.loadOlderBars('1m', 1700000000);
  const request = next.socket.sent.at(-1);
  next.respond(request, [[request.from_server, 1, 2, 1, 2]], { symbol: 'EURUSD' });
  await assert.rejects(wrong, /HISTORY_RESPONSE_MISMATCH/);
});
