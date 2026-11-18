import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const ordersURL = url(compile('../src/trade/chartOrders.ts'));
const { snapTradePrice, editDraftPrice, modifyPositionLevel } = await import(ordersURL);
const { OrderLevels, transientOrderLine } = await import(url(compile('../src/vela/orderLevels.ts').replace("'../trade/chartOrders'", JSON.stringify(ordersURL))));
test('broker price grid and market-to-pending direction obey the quote and capabilities', () => {
  assert.equal(snapTradePrice(123.38, .25, 2), 123.5);
  assert.equal(snapTradePrice(1.123456, .00001, 5), 1.12346);
  for (const invalid of [NaN, Infinity, 0, -1]) assert.throws(() => snapTradePrice(invalid, .01, 2));
  const draft = { editable: true, action: 'market', side: 'buy', step: .01, digits: 2 };
  const quote = { bid: 100, ask: 101 };
  for (const [side, price, action] of [['buy',99,'limit'], ['buy',102,'stop'], ['sell',102,'limit'], ['sell',99,'stop']])
    assert.deepEqual(editDraftPrice({ ...draft, side }, 'entry', price, quote, ['limit','stop']), { price, action });
  assert.throws(() => editDraftPrice(draft, 'entry', 99, quote, ['market']));
  assert.throws(() => editDraftPrice({ ...draft, editable: false }, 'sl', 99, quote, ['market']));
});
function terminalFixture() {
  const scope = { account_id:'a', server:'broker', epoch:'epoch', instance_id:'instance', symbol:'XAUUSD' };
  const current = { ...scope, phase:'connected', positions:[{ ticket:'12345678901234567', symbol:'XAUUSD', sl:99, tp:110 }], commands:[], symbol_spec:{ tick_size:.25, digits:2 } };
  const writes=[], tasks=[], errors=[]; let reverts=0, time=100;
  const terminal={ getSnapshot:()=>current, command(action,payload) { writes.push({action,payload}); current.commands=[{command_id:'one',state:'sending'}]; return 'one'; } };
  const drag=(field='sl',price=98.38)=>modifyPositionLevel(terminal,scope,'12345678901234567',field,price,message=>errors.push(message),()=>reverts++,fn=>tasks.push(fn),()=>time);
  return {current,terminal,writes,tasks,errors,drag,reverts:()=>reverts,time:value=>time=value};
}
test('one modify preserves the other stop and full ticket; successful completion never retries',()=>{
  const f=terminalFixture(); f.drag();
  assert.deepEqual(f.writes,[{action:'modify',payload:{ticket:'12345678901234567',sl:98.5,tp:110}}]);
  f.tasks.shift()(); assert.equal(f.writes.length,1);
  f.current.commands[0].state='completed'; f.tasks.shift()(); assert.equal(f.tasks.length,0); assert.equal(f.reverts(),0);
  const tp=terminalFixture(); tp.drag('tp',111.12); assert.deepEqual(tp.writes[0].payload,{ticket:'12345678901234567',sl:99,tp:111});
});
test('entry, stale account/symbol, missing position/spec and denied permission cannot submit',()=>{
  for(const change of [f=>f.current.account_id='other',f=>f.current.symbol='EURUSD',f=>f.current.positions=[],f=>f.current.symbol_spec=null,f=>f.current.symbol_switching=true]) {
    const f=terminalFixture(); change(f); f.drag(); assert.equal(f.writes.length,0); assert.equal(f.reverts(),1);
  }
  const entry=terminalFixture(); entry.drag('entry'); assert.equal(entry.writes.length,0);
  const denied=terminalFixture(); denied.terminal.command=()=>{throw Error('EA permission denied');}; denied.drag(); assert.equal(denied.reverts(),1); assert.match(denied.errors[0],/permission denied/);
  const same=terminalFixture(); same.drag('sl',99); assert.equal(same.writes.length,0);
});
test('rejected, uncertain, missing results and timeout revert without retries; switched sessions stop stale polling',()=>{
  for(const state of ['rejected','uncertain','not_found','missing','timeout']) {
    const f=terminalFixture(); f.drag();
    if(state==='missing') f.current.commands=[]; else if(state==='timeout') f.time(16000); else f.current.commands[0].state=state;
    f.tasks.shift()(); assert.equal(f.reverts(),1); assert.equal(f.errors.length,1); assert.equal(f.tasks.length,0); assert.equal(f.writes.length,1);
  }
  const f=terminalFixture(); f.drag(); f.current.epoch='new'; f.tasks.shift()(); assert.equal(f.tasks.length,0); assert.equal(f.reverts(),0);
});
function drawingFixture() {
  let levels=[{ticket:'42',side:'buy',entry:100,sl:99,tp:110,editable:true,digits:2,step:.25}],blocked=false;
  const writes=[]; const control=new OrderLevels(()=>levels,(...args)=>writes.push(args),()=>blocked,()=>100); let count=0;
  const cell=id=>{
    const rows=[]; let c; const edited=id=>control.edit(c,id);
    const api={all:()=>rows,add(type,init){const row={...init,type,id:id+'-'+(++count)};rows.push(row);edited(row.id);return row;},
      update(id,patch){Object.assign(rows.find(r=>r.id===id),patch);edited(id);},
      lock(id,locked){rows.find(r=>r.id===id).locked=locked;edited(id);},show(id,visible){rows.find(r=>r.id===id).visible=visible;edited(id);},
      remove(id){rows.splice(rows.findIndex(r=>r.id===id),1);}};
    c={id,chart:{drawings:api}};return c;
  };
  return {control,writes,cell,levels:value=>levels=value,block:value=>blocked=value};
}
const colors={entry:'accent',sl:'bad',tp:'good'};
test('native programmatic edits, lock/show events and broker refreshes never trade; closed positions remove lines',()=>{
  const f=drawingFixture(),c=f.cell('c1');f.control.sync(c,colors);f.control.sync(c,colors);
  const rows=c.chart.drawings.all();assert.equal(rows.length,3);assert.equal(f.writes.length,0);assert.equal(rows[0].locked,true);assert.equal(rows[1].locked,false);
  f.levels([{ticket:'42',side:'buy',entry:100,sl:98,tp:111,editable:false}]);f.control.sync(c,colors,false);
  assert.equal(f.writes.length,0);assert.ok(rows.every(r=>r.locked&&!r.visible));
  f.levels([]);f.control.sync(c,colors);assert.equal(rows.length,0);
});
test('one user drag across mirrored cells submits once; clones deduplicate and transient lines are excluded',()=>{
  const f=drawingFixture(),c1=f.cell('c1'),c2=f.cell('c2');f.control.sync(c1,colors);f.control.sync(c2,colors);
  const sl=c1.chart.drawings.all().find(r=>r.text.value.includes('止损'));
  c1.chart.drawings.update(sl.id,{anchors:[{price:98.38}]});assert.deepEqual(f.writes,[['42','sl',98.5]]);
  const mirror=c2.chart.drawings.all().find(r=>r.text.value.includes('止损'));
  c2.chart.drawings.update(mirror.id,{anchors:[{price:98.38}]});assert.equal(f.writes.length,1);
  c2.chart.drawings.add('hline',mirror);f.control.sync(c2,colors);assert.equal(c2.chart.drawings.all().length,3);
  const doc=[...c1.chart.drawings.all(),{id:'user',text:{value:'my analysis'}}];assert.deepEqual(doc.filter(r=>!transientOrderLine(r)).map(r=>r.id),['user']);
  f.block(true);c1.chart.drawings.update(sl.id,{anchors:[{price:97}]});assert.equal(f.writes.length,1);
});
test('draft entry can be dragged while executed entry remains locked',()=>{
  const f=drawingFixture(),c=f.cell('c1');f.levels([{ticket:'draft:scope',draft:true,side:'buy',entry:100,sl:99,tp:110,editable:true}]);f.control.sync(c,colors);
  const entry=c.chart.drawings.all()[0];assert.equal(entry.locked,false);
  c.chart.drawings.update(entry.id,{anchors:[{price:101}]});assert.deepEqual(f.writes,[['draft:scope','entry',101]]);
});
