import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/mt5Pairing.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, setTimeout, clearTimeout, Error });
const { pairLocalMT5 } = exports;
function fake(phase='disconnected') {
  let state={phase,error:''}; const listeners=new Set();
  return { codes:[], connects:0, disconnects:0, getSnapshot:()=>state,
    subscribe(fn){ listeners.add(fn); return ()=>listeners.delete(fn); },
    emit(phase,error=''){state={phase,error};for(const fn of [...listeners])fn();},
    connect(){this.connects++;this.emit('connecting');}, disconnect(){this.disconnects++;this.emit('disconnected');},
    pair(code){this.codes.push(code);}, listeners };
}
test('waits for hello, sends once, and waits for EA local confirmation',async()=>{
 const t=fake(), p=pairLocalMT5(t,'12345678',new AbortController().signal);
 assert.deepEqual(t.codes,[]);t.emit('pairing');t.emit('pairing');
 assert.deepEqual(t.codes,['12345678']);t.emit('confirming');await p;
 assert.equal(t.listeners.size,0);assert.equal(t.disconnects,0);
});
test('rejects without retrying an incorrect code',async()=>{
 const t=fake(),p=pairLocalMT5(t,'12345678',new AbortController().signal);t.emit('pairing');t.emit('pairing','incorrect code');
 await assert.rejects(p,/incorrect code/);assert.equal(t.codes.length,1);assert.equal(t.disconnects,1);
});
test('cancelled discovery cleans up and cannot send code after late hello',async()=>{
 const t=fake(),a=new AbortController(),p=pairLocalMT5(t,'12345678',a.signal);a.abort();await assert.rejects(p,/取消/);t.emit('pairing');assert.deepEqual(t.codes,[]);
});
test('timeout closes only the attempted connection',async()=>{
 const t=fake();await assert.rejects(pairLocalMT5(t,'12345678',new AbortController().signal,1),/未找到/);assert.equal(t.disconnects,1);assert.equal(t.listeners.size,0);
});
test('existing approved connection is not silently replaced',async()=>{
 const t=fake('connected');await assert.rejects(pairLocalMT5(t,'12345678',new AbortController().signal),/已有/);assert.equal(t.connects,0);assert.equal(t.disconnects,0);
});
