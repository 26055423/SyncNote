import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(file, dependencies) {
  let cursor = 0;
  const state = [], effects = [], cleanups = [];
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
      return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value; }];
    },
    useEffect(fn) { effects.push(fn); },
  };
  const source = readFileSync(new URL('../src/features/' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => name === 'react' ? react : dependencies[name] ?? {}, exports);
  const cleanup = () => { for (const stop of cleanups.splice(0)) stop?.(); };
  return {
    state, cleanup,
    render(name, ...args) {
      cleanup(); cursor = 0;
      const result = exports[name](...args);
      for (const start of effects.splice(0)) cleanups.push(start());
      return result;
    },
  };
}

test('symbol catalog ignores an old account response even when the transport ignores cancellation', async () => {
  const requests = [];
  const localTerminal = { requestSymbols(signal) { const pending = deferred(); requests.push({ ...pending, signal }); return pending.promise; } };
  const hook = harness('market/useSymbolCatalog.ts', { '../../localTerminal': { localTerminal } });
  const board = { user: { id: 'user' } };
  const local = { phase: 'connected', symbol: 'A', features: ['symbols'], instance_id: 'one', epoch: 1 };
  hook.render('useSymbolCatalog', board, local);
  hook.render('useSymbolCatalog', board, { ...local, instance_id: 'two', epoch: 2, symbol: 'B' });
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve([{ symbol: 'B' }]); await flush();
  requests[0].resolve([{ symbol: 'A' }]); await flush();
  assert.equal(hook.state[0], 'B');
  assert.deepEqual(hook.state[1], [{ symbol: 'B' }]);
  hook.cleanup();
  assert.equal(requests[1].signal.aborted, true);
});

test('board polling does not overlap and unmount aborts the request without changing state', async () => {
  const original = globalThis.window;
  const timers = new Set();
  globalThis.window = { setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); } };
  try {
    const requests = [], errors = [];
    const hook = harness('board/useBoard.ts', { '../../api': { api(path, _, options) { const pending = deferred(); requests.push({ ...pending, signal: options.signal }); return pending.promise; } } });
    hook.render('useBoard', message => errors.push(message));
    for (const poll of timers) { poll(); poll(); }
    assert.equal(requests.length, 1);
    hook.cleanup();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ user: { id: 'old', onboarding_step: 4 } }); await flush();
    assert.equal(hook.state[0], null);
    assert.deepEqual(errors, []);
    assert.equal(timers.size, 0);
  } finally { globalThis.window = original; }
});
