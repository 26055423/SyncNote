import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../src/notebookModel.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { appendTemplate, templateStructure, moveSection, appendPhrase, frequentFirst, checklistProgress, appendChecklist, DEFAULT_CHECKLIST, summarizeNote, isChecklist, insertAt } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
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

test('legacy checkmarks stay checks and not-applicable items do not count', () => {
  const rows = [
    { id: '1', title: '方向', checked: true, body: '', group: '方向' },
    { id: '2', title: '位置', checked: false, body: '', group: '位置' },
    { id: '3', title: '形状', checked: false, body: '', group: '形态', verdict: 'na' },
    { id: '4', title: '自由', checked: true, body: '' },
  ];
  assert.deepEqual(checklistProgress(rows), { done: 2, total: 3 });
  assert.deepEqual(checklistProgress([]), { done: 0, total: 0 });
});

test('the starter checklist is optional, capped by room and keeps its groups', () => {
  const added = appendChecklist([]);
  assert.equal(added.length, DEFAULT_CHECKLIST.reduce((sum, group) => sum + group.items.length, 0));
  assert.ok(added.every(row => row.group && !row.checked && !row.body && !row.verdict));
  const nearlyFull = Array.from({ length: 28 }, (_, index) => ({ id: `s${index}`, title: `t${index}`, checked: false, body: '' }));
  assert.equal(appendChecklist(nearlyFull).length, 30);
});

test('templates keep the group but never the verdict or the trade text', () => {
  const rows = [{ id: 'a', title: '方向', checked: true, body: '文字', group: '方向判断', verdict: 'yes' }];
  const structure = templateStructure(rows);
  assert.equal(structure[0].group, '方向判断');
  assert.equal(structure[0].verdict, null);
  assert.equal(structure[0].checked, false);
  assert.equal(structure[0].body, '');
  const applied = appendTemplate([], { sections: rows });
  assert.equal(applied[0].group, '方向判断');
  assert.equal(applied[0].verdict, null);
  assert.equal(applied[0].body, '');
});

test('summary lists verdicts, groups, evidence and the free note', () => {
  const note = {
    body: '下次提前减仓',
    tags: [],
    sections: [
      { id: '1', title: '方向', checked: true, body: '日线看多', group: '方向判断', verdict: 'yes', evidence: [{ id: 'e1', caption: '15m 需求区', drawing_id: 'd1', timeframe: '15', anchor_ms: 1 }] },
      { id: '2', title: '位置', checked: true, body: '', group: '位置', verdict: 'no' },
      { id: '3', title: '自由章', checked: false, body: '随手记' },
    ],
  };
  const text = summarizeNote(note);
  assert.match(text, /已检查 2\/2/);
  assert.match(text, /符合 1 · 不符合 1/);
  assert.match(text, /【方向判断】/);
  assert.match(text, /\[符合\] 方向/);
  assert.match(text, /证据：15m 需求区/);
  assert.match(text, /自由笔记：/);
});

test('ordinary grouped chapters are not checklist items and templates preserve their type', () => {
  const chapter = { ...a, group: '结构', checklist: false, checked: false };
  assert.equal(isChecklist(chapter), false);
  assert.deepEqual(checklistProgress([chapter]), { done: 0, total: 0 });
  assert.equal(appendTemplate([], { sections: [chapter] })[0].checklist, false);
  assert.ok(!summarizeNote({ body: '', tags: [], sections: [chapter] }).includes('未检查'));
});
test('pinned phrases stay ahead of frequently used phrases', () => {
  const pinned = { uses: 1, last_used: 0, pinned: true };
  const frequent = { uses: 100, last_used: 100 };
  assert.deepEqual(frequentFirst([frequent, pinned]), [pinned, frequent]);
});
test('insertion replaces the selected text and subsequent clicks continue at the caret', () => {
  const first = insertAt('方向：空头。', '多头', { start: 3, end: 5 });
  assert.equal(first.body, '方向：多头。');
  const second = insertAt(first.body, '确认', { start: first.position, end: first.position });
  assert.equal(second.body, '方向：多头确认。');
});
