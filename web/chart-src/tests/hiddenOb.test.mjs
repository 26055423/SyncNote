import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * hidden OB（indicators/tradingview/hidden_ob.pine 的原生移植）回归测试。
 *
 * 指标模块自己 import 了 `@luxalgo/vela`，所以先把 TS 转成 JS，再把裸模块名换成
 * 解析后的绝对 URL（data: URL 里不能解析裸模块名），这样注册表仍与测试共享同一实例。
 */
const entry = import.meta.resolve('@luxalgo/vela');
const source = readFileSync(new URL('../src/vela/indicators/hiddenOb.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/from\s+['"]@luxalgo\/vela['"]/g, `from '${entry}'`);
await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const { getNativeIndicator } = await import('@luxalgo/vela');

const BASE = Date.UTC(2026, 0, 5, 8, 0, 0);
const at = (index) => BASE + index * 60_000;
const def = getNativeIndicator('hidden-ob');
assert.ok(def, 'hidden-ob 已在注册表里');

/** 一根分钟线：[开, 高, 低, 收]。 */
function minutesOf(rows) {
  return rows.map(([open, high, low, close], index) => ({ time: at(index), open, high, low, close }));
}

/** 跑一次指标，返回它 emit 出来的 box。 */
async function run(rows, inputs = {}) {
  const minutes = minutesOf(rows);
  let output = null;
  const ctx = {
    id: 'test',
    symbol: 'review:TEST',
    timeframe: '1',
    live: false,
    bars: () => minutes,
    data: {
      resolve: () => ({ provider: 'review', ticker: 'TEST' }),
      providerInstance: () => ({ getBars: async () => minutes }),
    },
    emit: (out) => { output = out; },
    pushData: () => {},
    setStatus: () => {},
  };
  const instance = def.create();
  instance.start(ctx, { ...def.defaultInputs(), ...inputs });
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.stop();
  return output?.boxes ?? [];
}

/** 枢轴低(3) → 摆动高(3) → 阴 K 来源 → 收盘突破。 */
const BULL = [
  [100.0, 100.5, 99.5, 100.0],
  [100.0, 100.4, 99.4, 99.9],
  [99.9, 100.2, 99.2, 99.6],
  [99.6, 99.8, 99.0, 99.4], // 枢轴低
  [99.4, 100.0, 99.5, 99.9],
  [99.9, 100.6, 99.8, 100.5],
  [100.5, 101.0, 100.4, 100.9],
  [100.9, 101.2, 100.8, 101.1],
  [101.1, 101.5, 101.0, 101.2], // 枢轴高 101.5
  [101.2, 101.4, 100.9, 101.0],
  [101.0, 101.3, 100.8, 100.9],
  [100.9, 101.2, 100.7, 100.8],
  [100.8, 100.9, 100.2, 100.3], // 来源（阴 K）
  [100.3, 101.9, 100.25, 101.8], // 突破
  [101.8, 102.0, 101.7, 101.9],
];

/** 镜像：枢轴高(3) → 摆动低(3) → 阳 K 来源 → 收盘跌破。 */
const BEAR = [
  [100.0, 100.5, 99.5, 100.0],
  [100.0, 100.6, 99.6, 100.1],
  [100.1, 100.8, 99.8, 100.4],
  [100.4, 101.0, 100.2, 100.6], // 枢轴高 101.0
  [100.6, 100.5, 100.0, 100.2],
  [100.2, 100.4, 99.4, 99.6],
  [99.6, 99.8, 99.0, 99.2],
  [99.2, 99.4, 98.8, 99.0],
  [99.0, 99.2, 98.6, 98.9], // 枢轴低 98.6
  [98.9, 99.1, 98.7, 99.0],
  [99.0, 99.2, 98.8, 99.1],
  [99.1, 99.3, 98.9, 99.0],
  [99.0, 99.8, 98.95, 99.7], // 来源（阳 K）
  [99.7, 99.75, 98.4, 98.5], // 跌破
  [98.5, 98.6, 98.2, 98.4],
];

test('多头：结构突破把来源阴 K 变成隐藏 OB，并延伸到最后一根分钟收盘', async () => {
  const boxes = await run(BULL);
  assert.equal(boxes.length, 1);
  const [box] = boxes;
  assert.equal(box.id, `hidden-ob-${at(12)}-b`);
  assert.equal(box.left, at(12));
  assert.equal(box.right, at(14) + 60_000);
  assert.equal(box.top, 100.9, '整根 K 线的上沿 = 来源最高');
  assert.equal(box.bottom, 100.2, '整根 K 线的下沿 = 来源最低');
  assert.equal(box.extend, 'right', '与 Pine 一样向右延伸未缓解区域');
  assert.equal(box.text, '1m 多头OB 1');
  assert.equal(box.borderColor, '#00897b');
});

test('空头：镜像判定', async () => {
  const boxes = await run(BEAR);
  assert.equal(boxes.length, 1);
  const [box] = boxes;
  assert.equal(box.id, `hidden-ob-${at(12)}-s`);
  assert.equal(box.top, 99.8);
  assert.equal(box.bottom, 98.95);
  assert.equal(box.text, '1m 空头OB 1');
  assert.equal(box.borderColor, '#f44336');
});

test('Pine 枢轴在等高/等低平台取较新的一根，左侧相等不应丢掉突破', async () => {
  const bull = BULL.map(row => [...row]);
  bull[7][1] = bull[8][1]; // 较旧的等高不妨碍第 8 根在第 11 根确认。
  const bullBoxes = await run(bull);
  assert.equal(bullBoxes.length, 1);
  assert.equal(bullBoxes[0].id, `hidden-ob-${at(12)}-b`);

  const bear = BEAR.map(row => [...row]);
  bear[7][2] = bear[8][2];
  const bearBoxes = await run(bear);
  assert.equal(bearBoxes.length, 1);
  assert.equal(bearBoxes[0].id, `hidden-ob-${at(12)}-s`);
});

test('枢轴右侧相等时等待较新的极值确认，不能提前产生 OB', async () => {
  const bull = BULL.slice(0, 14).map(row => [...row]);
  bull[11][1] = bull[8][1]; // 第 11 根直到第 14 根才确认；第 13 根不能提前突破。
  assert.equal((await run(bull)).length, 0);

  const bear = BEAR.slice(0, 14).map(row => [...row]);
  bear[11][2] = bear[8][2];
  assert.equal((await run(bear)).length, 0);
});

test('OB 范围 = 实体时用开/收', async () => {
  const [box] = await run(BULL, { zoneRange: '实体' });
  assert.equal(box.top, 100.8, '阴 K 实体上沿 = 开盘');
  assert.equal(box.bottom, 100.3, '阴 K 实体下沿 = 收盘');
});

test('高质量：来源阴 K + 紧接阳 K + 第三根整根脱离来源区间', async () => {
  const rows = BULL.slice(0, 13);
  rows.push([100.3, 101.4, 100.3, 101.2]); // 阳 K，还没突破 101.5
  rows.push([101.2, 101.9, 101.0, 101.8]); // 第三根：最低 101.0 > 来源最高 100.9，且收盘突破
  const [box] = await run(rows);
  assert.equal(box.text, '1m 高质量多头OB 1');
  assert.equal(box.borderColor, '#ff9800');
});

test('仅显示高质量：第三根还没收盘的突破不算高质量，直接被过滤', async () => {
  const boxes = await run(BULL, { onlyHighQuality: true });
  assert.equal(boxes.length, 0);
});

test('缓解：首次触及用影线打掉区，完全穿越要穿到底沿', async () => {
  const touched = BULL.slice(0, 14).concat([[101.8, 101.9, 100.5, 101.6]]); // 最低 100.5 只碰到区里
  assert.equal((await run(touched)).length, 0, '首次触及：碰到上沿即失效');
  assert.equal((await run(touched, { mitigation: '触及50%' })).length, 0, '触及50%：中轴 100.55 之上被打掉');
  assert.equal((await run(touched, { mitigation: '完全穿越' })).length, 1, '完全穿越：还没穿到 100.2，保留');

  const through = BULL.slice(0, 14).concat([[101.8, 101.9, 100.1, 100.2]]);
  assert.equal((await run(through, { mitigation: '完全穿越' })).length, 0, '穿到底沿才失效');
});

test('只显示最近的上方/下方：数量为 0 时一侧整体隐藏', async () => {
  assert.equal((await run(BULL, { lowerCount: 0 })).length, 0, 'OB 在现价下方，下方关掉就没了');
  assert.equal((await run(BULL, { upperCount: 0 })).length, 1);
});

function mounted({ timeframe = '60', chartBars, minutes = minutesOf(BULL), extension = true }) {
  let output, requested, listener;
  const provider = {
    getBars: async () => [], // The visible chart's cached M1 snapshot is empty/stale.
    ...(extension ? { getIndicatorBars: async (...args) => { requested = args; return minutes; } } : {}),
    onIndicatorBars: callback => { listener = callback; return () => { listener = null; }; },
  };
  const ctx = { id: 'higher', symbol: 'broker-track:TEST', timeframe, live: false,
    bars: () => chartBars ?? [{ ...minutes[0], close: 102 }],
    data: { resolve: () => ({ provider: 'broker-track', ticker: 'TEST' }),
      providerInstance: name => { assert.equal(name, 'broker-track'); return provider; } },
    emit: value => { output = value; }, setStatus() {}, pushData() {} };
  const instance = def.create(); instance.start(ctx, def.defaultInputs());
  return { instance, read: () => output, requested: () => requested,
    changed: () => listener?.(), close: () => instance.stop() };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('H1 requests actual one-minute history through its own broker instead of using a stale snapshot', async () => {
  const f = mounted({}); await settle();
  assert.equal(f.read().boxes.length, 1);
  assert.deepEqual(f.requested(), ['TEST', '1', BASE + 3600000, 20000]);
  assert.match(f.read().boxes[0].text, /^1m /); f.close();
});

test('replay never consumes future minutes that would mitigate an existing OB', async () => {
  const minutes = minutesOf(BULL.concat([[101.9, 102, 99, 99.5]]));
  const f = mounted({ timeframe: '1', chartBars: minutes.slice(0, 14), minutes }); await settle();
  assert.equal(f.read().boxes.length, 1, 'future touch must remain invisible'); f.close();
});

test('missing minute history never silently calculates the detector on H1 candles', async () => {
  const f = mounted({ chartBars: minutesOf(BULL), extension: false }); await settle();
  assert.equal(f.read().boxes.length, 0); f.close();
});

test('M1 dependency updates repaint H1 and replay corrections inside already scanned history', async () => {
  const minutes = minutesOf(BULL), f = mounted({ minutes }); await settle();
  assert.equal(f.read().boxes[0].top, 100.9);
  minutes[12] = { ...minutes[12], high: 100.95 };
  f.changed(); await settle();
  assert.equal(f.read().boxes[0].top, 100.95, 'interior correction must invalidate scanner and output cache');
  f.close();
});
