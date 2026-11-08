import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../src/notebookModel.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { appendTemplate, templateStructure, moveSection, appendPhrase, frequentFirst } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const a = { id: 'a', title: '先看这里', checked: true, body: '这一笔的判断' };
const b = { id: 'b', title: '持仓时', checked: false, body: '保留原文' };
test('applying a template appends independent empty chapters and preserves the original note', () => {
  const input = [a], template = { sections: [a, b] };
  const result = appendTemplate(input, template);
  assert.equal(result[0], a);
  assert.equal(input.length, 1);
  assert.equal(result.length, 3);
  assert.notEqual(result[1].id, a.id);
  assert.notEqual(result[1].id, result[2].id);
  assert.deepEqual(result.slice(1).map(({ title, checked, body }) => ({ title, checked, body })), [
    { title: a.title, checked: false, body: '' }, { title: b.title, checked: false, body: '' },
  ]);
});
test('template storage strips trade text and checked state but retains the chosen order', () => {
  const result = templateStructure([b, a, { ...a, id: 'empty', title: ' ' }]);
  assert.deepEqual(result.map(row => row.title), [b.title, a.title]);
  assert.ok(result.every(row => !row.checked && !row.body));
  assert.equal(a.body, '这一笔的判断');
});
test('reordering retains chapter identity and content, and does not move at boundaries', () => {
  const input = [a, b];
  assert.deepEqual(moveSection(input, 'b', -1), [b, a]);
  assert.equal(moveSection(input, 'a', -1), input);
  assert.equal(moveSection(input, 'b', 1), input);
  assert.deepEqual(input, [a, b]);
});
test('recommendations order candidates by frequency then recency without mutating the source', () => {
  const input = [{ uses: 1, last_used: 20 }, { uses: 2, last_used: 10 }, { uses: 2, last_used: 30 }];
  assert.deepEqual(frequentFirst(input), [input[2], input[1], input[0]]);
  assert.equal(input[0].uses, 1);
});
test('phrases preserve existing prose and add a separator only when necessary', () => {
  assert.equal(appendPhrase('', '扫了低点'), '扫了低点');
  assert.equal(appendPhrase('回到计划位置', '扫了低点'), '回到计划位置，扫了低点');
  assert.equal(appendPhrase('回到计划位置。', '扫了低点'), '回到计划位置。扫了低点');
});
