import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { WorkspaceReplay, barClose } from '@luxalgo/vela/workspace';

const source = readFileSync(new URL('../src/vela/replayController.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  .replaceAll('@luxalgo/vela/workspace', import.meta.resolve('@luxalgo/vela/workspace'));
const { replayWindow, safeReplayStart } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const M = 60000, origin = Date.UTC(2026, 10, 5, 0);

test('armed random and earliest actions pass their selected time instead of the old viewport', async () => {
  const workspaceSource = readFileSync(new URL('../src/vela/ChartWorkspace.tsx', import.meta.url), 'utf8');
  const workspaceTree = ts.createSourceFile('ChartWorkspace.tsx', workspaceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const methods = [];
  const names = ['replaySelect', 'replayStartAt', 'replayStartFromView'];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(workspaceTree))) methods.push(node.getText(workspaceTree));
    ts.forEachChild(node, visit);
  }
  visit(workspaceTree);
  assert.equal(methods.length, names.length);
  const f = fixture();
  const armed = { current: false };
  const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handle = vm.runInNewContext(compile('({' + methods.join(',') + '})'), {
    wsRef: { current: { ...f.workspace, active: { ...f.workspace.active, chart: { ...f.a, drawings: { setTool() {} }, getVisibleRange: () => ({ from: origin + 20 * M, to: origin + 24 * M }) } } } },
    replayArmedRef: armed,
    startReplay: async (from, cell) => { await safeReplayStart(f.workspace, { from, cell, masterOpenTimes: f.times }); },
  });
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const appTree = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const actions = new Map();
  function findAction(node) {
    if (ts.isJsxAttribute(node) && ['onRandom', 'onEarliest'].includes(node.name.getText(appTree)) && node.initializer?.expression) actions.set(node.name.getText(appTree), node.initializer.expression.getText(appTree));
    ts.forEachChild(node, findAction);
  }
  findAction(appTree);
  assert.equal(actions.size, 2);
  const math = Object.create(Math); math.random = () => 0.25;
  const context = { chartRef: { current: handle }, tf: '1', TIMEFRAMES: { '1': { base: 'M1' } }, TF_SECONDS: { M1: 60 }, marketView: true, liveRef: { current: { M1: f.times.map(time => [time / 1000]) } }, seriesRef: { current: {} }, api: async () => ({ sources: [] }), Math: math };
  try {
    handle.replaySelect();
    await vm.runInNewContext(compile('(' + actions.get('onRandom') + ')()'), context);
    assert.equal(f.replay.state.cursorTime, origin + 7 * M);
    handle.replaySelect();
    await vm.runInNewContext(compile('(' + actions.get('onEarliest') + ')()'), context);
    assert.equal(f.replay.state.cursorTime, origin + 4 * M, 'earliest respects the first closed coarse bar');
    await handle.replayStartFromView();
    assert.equal(f.replay.state.cursorTime, origin + 22 * M, 'view action still uses its midpoint');
  } finally { f.replay.destroy(); }
});

// Double only the individual chart ReplayControl port. The actual shipped
// WorkspaceReplay drives the clock, timers, lifecycle and multi-period syncing.
function chart(tf, offsets) {
  const tape = offsets.map(value => origin + value * M);
  const listeners = new Map();
  const emit = (kind, event) => { for (const fn of [...listeners.get(kind) ?? []]) fn(event); };
  let active = false, playing = false, count = tape.length;
  const cell = {
    market: { timeframe: String(tf) }, playCalls: 0,
    on(kind, fn) { const group = listeners.get(kind) ?? new Set(); group.add(fn); listeners.set(kind, group); return () => group.delete(fn); },
    ready: async () => undefined,
    shown: () => tape.slice(0, count),
    replay: {
      get bounds() { return { first: tape[0], last: tape.at(-1) }; },
      get state() { return { active, playing, cursorTime: active ? tape[count - 1] : null, nextTime: active ? tape[count] ?? null : null, remaining: active ? tape.length - count : 0, intervalMs: 1000 }; },
      async start({ from }) {
        let cut = tape.filter(time => time <= from).length; cut = Math.max(1, cut);
        if (cut >= tape.length) return;
        active = true; playing = false; count = cut;
        emit('replay:start', { cursorTime: tape[count - 1], remaining: tape.length - count });
      },
      step() {
        if (!active || count === tape.length) return false;
        count++; emit('replay:step', { cursorTime: tape[count - 1], remaining: tape.length - count });
        if (count === tape.length) { active = playing = false; emit('replay:end', { reason: 'finished' }); }
        return true;
      },
      stepUpdate() { return this.step(); },
      play() { cell.playCalls++; playing = true; },
      pause() { playing = false; emit('replay:pause'); },
      stop() { const had = active; active = playing = false; count = tape.length; if (had) emit('replay:end', { reason: 'stopped' }); },
    },
  };
  return cell;
}
function fixture(minuteCount = 30, coarseCount = 7) {
  const a = chart(1, Array.from({ length: minuteCount }, (_, i) => i));
  const b = chart(5, Array.from({ length: coarseCount }, (_, i) => i * 5));
  const cells = [{ id: 'c1', chart: a }, { id: 'c2', chart: b }];
  const host = { cells: () => cells, activeId: () => 'c1', onCells: () => () => undefined };
  const replay = new WorkspaceReplay(host);
  return { a, b, cells, replay, workspace: { cells: () => cells, active: cells[0], replay }, times: Array.from({ length: minuteCount }, (_, i) => origin + i * M) };
}

test('start clamps to a common CLOSED history window and leaves future candles hidden', async () => {
  const f = fixture();
  try {
    const window = replayWindow(f.cells, 'c1', f.times);
    assert.equal(window.first, origin + 4 * M, 'first 5m candle is safe only at its close');
    assert.equal(window.last, origin + 28 * M, 'a start must leave one minute bar hidden');
    const result = await safeReplayStart(f.workspace, { from: origin, masterOpenTimes: f.times });
    assert.deepEqual(result, { from: origin + 4 * M, clamped: true });
    assert.equal(f.a.shown().length, 5);
    assert.equal(f.b.shown().length, 1);
    assert.equal(f.replay.state.active, true);
  } finally { f.replay.destroy(); }
});

test('actual workspace steps on one clock and never reveals the still-forming 5m OHLC', async () => {
  const f = fixture();
  try {
    await safeReplayStart(f.workspace, { from: origin + 7 * M, masterOpenTimes: f.times });
    assert.equal(f.b.shown().length, 1);
    assert.equal(f.replay.step(), true); // close clock 09
    assert.equal(f.b.shown().length, 1);
    assert.equal(f.replay.step(), true); // close clock 10
    assert.equal(f.b.shown().length, 2);
    const clock = barClose(f.replay.state.cursorTime, '1');
    for (const cell of f.cells) for (const time of cell.chart.shown()) assert.ok(barClose(time, cell.chart.market.timeframe) <= clock);
  } finally { f.replay.destroy(); }
});

test('forward seeking beyond a shorter secondary tape restores its full safe history', async () => {
  const f = fixture(30, 3);
  try {
    await safeReplayStart(f.workspace, { from: origin + 5 * M, masterOpenTimes: f.times });
    assert.equal(f.b.shown().length, 1);
    await safeReplayStart(f.workspace, { from: origin + 18 * M, masterOpenTimes: f.times });
    assert.equal(f.b.shown().length, 3, 'native startCell skip must not retain the previous seek cursor');
    assert.equal(f.a.shown().length, 19);
  } finally { f.replay.destroy(); }
});

test('common-window alignment uses actual master timestamps across a market gap', () => {
  const f = fixture();
  try {
    f.cells[1].chart = chart(5, [10, 15, 20, 25]);
    const times = [origin, origin + M, origin + 18 * M, origin + 19 * M, origin + 29 * M];
    assert.deepEqual(replayWindow(f.cells, 'c1', times), { first: origin + 18 * M, last: origin + 19 * M });
    assert.equal(replayWindow(f.cells, 'c1', [origin]), null);
  } finally { f.replay.destroy(); }
});

test('invalid or disjoint history cannot start a leaking first coarse candle', async () => {
  const f = fixture();
  try {
    await assert.rejects(safeReplayStart(f.workspace, { from: NaN, masterOpenTimes: f.times }), /有效/);
    f.cells[1].chart = chart(60, [1000, 1060]);
    assert.equal(replayWindow(f.cells, 'c1', f.times), null);
    await assert.rejects(safeReplayStart(f.workspace, { from: origin, masterOpenTimes: f.times }), /共同历史/);
    assert.equal(f.replay.state.active, false);
  } finally { f.replay.destroy(); }
});

test('workspace playback owns a single timer and pause prevents further steps', async () => {
  const f = fixture(200, 40);
  try {
    await safeReplayStart(f.workspace, { from: origin + 10 * M, masterOpenTimes: f.times });
    const advanced = new Promise(resolve => { const off = f.replay.on('replay:step', () => { off(); f.replay.pause(); resolve(); }); });
    f.replay.play(10);
    await advanced;
    const position = f.replay.state.cursorTime;
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(f.replay.state.cursorTime, position);
    assert.equal(f.replay.state.playing, false);
    assert.equal(f.a.playCalls + f.b.playCalls, 0, 'multi-chart playback must not start independent chart timers');
    f.replay.play(25);
    assert.equal(f.replay.state.intervalMs, 25);
    f.replay.stop();
    assert.equal(f.replay.state.active, false);
    assert.equal(f.a.shown().length, 200);
    assert.equal(f.b.shown().length, 40);
  } finally { f.replay.destroy(); }
});

test('reaching a tape end ends the group together and restores all full histories', async () => {
  const f = fixture(12, 10);
  try {
    await safeReplayStart(f.workspace, { from: origin + 10 * M, masterOpenTimes: f.times });
    assert.equal(f.replay.state.active, true);
    f.replay.step();
    assert.equal(f.replay.state.active, false);
    assert.equal(f.a.shown().length, 12);
    assert.equal(f.b.shown().length, 10);
  } finally { f.replay.destroy(); }
});
