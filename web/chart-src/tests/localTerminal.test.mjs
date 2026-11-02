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
  vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url), window, WebSocket: Socket, performance, crypto: webcrypto, setTimeout, clearTimeout });
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
  return { client, connect, Socket, timers };
}

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
  assert.equal(socket.sent.at(-1).account_id, '1001');
  assert.equal(socket.sent.at(-1).token, 'ram-only');
  socket.emit({ type: 'bars', request_id: socket.sent.at(-1).request_id, tf: '1m', bars: [[100, 1, 2, 1, 2]] });
  assert.equal(socket.sent.at(-1).tf, '5m');
  assert.equal(client.getSnapshot().bars['1m'][0][0], 100);
  assert.equal(client.getSnapshot().history_ready, false);
});

test('history errors and read timeouts advance bootstrap without replaying a trade', () => {
  const { client, connect, timers } = fixture();
  const socket = connect();
  socket.emit({ type: 'error', code: 'HISTORY_UNAVAILABLE', error: 'load history in MT5', request_id: socket.sent.at(-1).request_id });
  assert.equal(socket.sent.at(-1).tf, '5m');
  const timer = [...timers.values()].find((row) => row.ms === 10000);
  timer.callback();
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
