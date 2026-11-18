import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(path, hooks) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { exports, require: name => name === 'react' && hooks ? hooks : name === './risk' ? risk : name === './chartOrders' ? chartOrders : require(name), crypto: { randomUUID: () => 'test-only' } });
  return exports;
}
const risk = load('../src/trade/risk.ts');
const chartOrders = load('../src/trade/chartOrders.ts');
const spec = { tick_size: .01, tick_value_loss: 1, tick_value_profit: 1, volume_min: .01, volume_max: 100, volume_step: .01, digits: 2 };
const account = { currency: 'USD', balance: 1000 };
const ref = { bid: 2999.8, ask: 3000 };
const buy = { action: 'market', side: 'buy', price: 0, sl: 2999 };
const size = (order = buy, budget = 10, contract = spec, prices = ref, acc = account) => risk.sizeByRisk(order, prices, acc, contract, budget, true);

test('closer SL allows more lots; rounding never exceeds the risk budget', () => {
  assert.equal(size().volume, .1);
  assert.equal(size({ ...buy, sl: 2998 }).volume, .05);
  assert.equal(size({ ...buy, sl: 2997 }).volume, .03);
  assert.equal(size({ ...buy, sl: 2997 }).loss, 9);
  for (let i = 1; i < 100; i++) {
    const result = size({ ...buy, sl: 3000 - i / 7 }, 10);
    if (!result.problem) {
      assert.ok(result.loss <= 10);
      assert.ok(Math.abs(result.volume / spec.volume_step - Math.round(result.volume / spec.volume_step)) < 1e-6);
    }
  }
});
test('sell uses bid; pending orders use their entry rather than current quote', () => {
  assert.equal(size({ ...buy, side: 'sell', sl: 3000.8 }).volume, .1);
  assert.equal(size({ ...buy, action: 'limit', price: 2900, sl: 2898 }).volume, .05);
  assert.equal(size({ ...buy, action: 'stop', price: 3100, sl: 3098 }).volume, .05);
});
test('no SL, invalid inputs and missing specifications cannot size a trade', () => {
  for (const order of [{ ...buy, sl: 0 }, { ...buy, sl: 3000 }, { ...buy, sl: 3001 }, { ...buy, sl: NaN }]) assert.ok(size(order).problem);
  for (const budget of [0, -1, NaN, Infinity]) assert.ok(size(buy, budget).problem);
  assert.ok(size(buy, 10, null).problem);
  assert.ok(size(buy, 10, { ...spec, tick_value_loss: 0 }).problem);
  assert.ok(size(buy, 10, spec, ref, {}).problem);
});
test('minimum lot is never rounded up; max lot and custom steps are respected', () => {
  assert.equal(size({ ...buy, sl: 2800 }).volume, 0);
  assert.equal(size(buy, 10, { ...spec, volume_max: .05 }).volume, .05);
  assert.equal(size(buy, 10, { ...spec, volume_max: .05 }).capped, true);
  assert.equal(size(buy, 10, { ...spec, volume_min: .001, volume_step: .001 }).volume, .1);
  assert.equal(size(buy, 10, { ...spec, volume_step: .03 }).volume, .09);
  assert.equal(risk.fmtVolume(.001), '0.001');
});
test('broker tick loss and profit values preserve account currency and non-gold contracts', () => {
  const contract = { ...spec, tick_size: .25, tick_value_loss: 2, tick_value_profit: 3 };
  const order = { ...buy, volume: 1, symbol: 'USTEC', sl: 2999, tp: 3002 };
  const result = risk.previewRisk(order, ref, { ...account, currency: 'EUR' }, true, contract);
  assert.equal(result.riskUsd, 8);
  assert.equal(result.rewardUsd, 24);
  assert.equal(size(buy, 10, contract, ref, { currency: 'EUR' }).volume, 1.25);
});

function ticketFixture() {
  const slots = []; let cursor = 0; let dirty = false; let effects = [];
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) dirty = true; slots[i] = next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn) { return fn(); },
    useEffect(fn, deps) {
      const i = cursor++; const old = slots[i];
      if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps[at]))) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const { OrderTicket } = load('../src/trade/OrderTicket.tsx', hooks);
  const sent = [];
  const props = { account, symbolSpec: spec, symbol: 'XAUUSD', ...ref, connected: true, quotaUnrestricted: true,
    onSubmit: async request => { sent.push(request); return { status: 200, result: { ok: true }, transportError: null }; } };
  let tree;
  const render = () => { let passes = 0; do { dirty = false; effects = []; cursor = 0; tree = OrderTicket(props); for (const effect of effects) effect(); assert.ok(++passes < 20, 'effects settle'); } while (dirty); };
  function nodes(node) { if (arguments.length === 0) node = tree; return !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(n => nodes(n)) : [node, ...nodes(node.props?.children)]; }
  function text(node) { return typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : ''; }
  const button = value => nodes().find(n => n.type === 'button' && text(n) === value);
  const field = label => nodes(nodes().find(n => n.type === 'label' && text(n).includes(label))).find(n => n.type === 'input');
  const volume = () => nodes().find(n => n.props?.['aria-label'] === '下单手数');
  const submit = () => nodes().find(n => n.type === 'button' && n.props.className?.split(' ').includes('submit'));
  render();
  return { props, sent, render, nodes, button, field, volume, submit };
}
test('actual ticket fills and submits calculated lots with attached SL; manual mode remains editable', async () => {
  const f = ticketFixture();
  f.button('以损定仓').props.onClick(); f.render();
  assert.equal(f.volume().props.value, '');
  const stopInput = f.nodes().filter(n => n.type === 'input' && n.props.placeholder === '价格')[0];
  stopInput.props.onChange({ target: { value: '2999' } }); f.render();
  assert.equal(f.volume().props.value, '0.1');
  assert.equal(f.volume().props.disabled, true);
  f.field('解锁下单').props.onChange({ target: { checked: true } }); f.render();
  assert.equal(f.submit().props.disabled, false);
  f.submit().props.onClick(); f.render();
  f.button('确认提交').props.onClick(); await Promise.resolve(); f.render();
  assert.equal(f.sent[0].volume, .1);
  assert.equal(f.sent[0].sl, 2999);
  f.button('手动手数').props.onClick(); f.render();
  assert.equal(f.volume().props.disabled, false);
  assert.equal(f.volume().props.value, '0.1');
});
test('changing quote recalculates lots and invalidates an already opened confirmation', () => {
  const f = ticketFixture();
  f.button('以损定仓').props.onClick(); f.render();
  f.nodes().filter(n => n.type === 'input' && n.props.placeholder === '价格')[0].props.onChange({ target: { value: '2999' } }); f.render();
  f.field('解锁下单').props.onChange({ target: { checked: true } }); f.render();
  f.submit().props.onClick(); f.render();
  f.props.ask = 3001; f.render();
  assert.equal(f.volume().props.value, '0.05');
  assert.equal(f.button('确认提交').props.disabled, true);
  f.button('确认提交').props.onClick();
  assert.equal(f.sent.length, 0);
});

test('chart edits update the actual ticket, recalculate risk lots and cancel confirmation without submitting', () => {
  const f = ticketFixture(); let draft;
  f.props.draftScope = 'one-account'; f.props.onDraftChange = value => { draft = value; };
  f.props.allowedActions = ['market', 'limit', 'stop']; f.render();
  f.button('以损定仓').props.onClick(); f.render();
  f.props.chartEdit = { id: 1, scope: 'one-account', field: 'sl', price: 2998 }; f.render();
  assert.equal(draft.sl, 2998); assert.equal(draft.volume, .05);
  f.field('解锁下单').props.onChange({ target: { checked: true } }); f.render();
  f.submit().props.onClick(); f.render(); assert.ok(f.button('确认提交'));
  f.props.chartEdit = { id: 2, scope: 'one-account', field: 'sl', price: 2999 }; f.render();
  assert.equal(draft.volume, .1); assert.equal(f.button('确认提交'), undefined);
  f.props.chartEdit = { id: 3, scope: 'one-account', field: 'entry', price: 3001 }; f.render();
  assert.equal(draft.action, 'stop'); assert.equal(draft.entry, 3001); assert.equal(draft.volume, .05);
  f.props.chartEdit = { id: 4, scope: 'one-account', field: 'tp', price: 3005 }; f.render(); assert.equal(draft.tp, 3005);
  f.props.chartEdit = { id: 5, scope: 'another-account', field: 'sl', price: 2990 }; f.render(); assert.equal(draft.sl, 2999);
  assert.equal(f.sent.length, 0);
});
