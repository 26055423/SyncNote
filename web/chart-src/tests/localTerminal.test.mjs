import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual browser client with a fake wire, without MT5 or broker calls.
const source = readFileSync(new URL('../src/localTerminal.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
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
    socket.emit({ type: 'paired', token: 'test-session-only', instance_id: 'instance', account_id: account, server: 'Demo-Server', epoch: 'epoch1', symbol: 'XAUUSD', read_only: false, demo: true, capabilities: ['market', 'close', 'cancel', 'modify'], ...extra });
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
