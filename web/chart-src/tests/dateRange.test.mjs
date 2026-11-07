import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
const source = readFileSync(new URL('../src/lib/dateRange.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, Intl, Date, Error });
const { calendarSyncRange, dateInZone, dateStartUTC, shiftDate } = exports;

test('calendar inputs use the chosen display zone, including fractional offsets', () => {
  assert.equal(dateStartUTC('2026-11-08', 'Asia/Kathmandu'), Date.parse('2026-11-07T18:15:00Z') / 1000);
  assert.equal(dateInZone(Date.parse('2026-11-07T19:00:00Z'), 'Asia/Kathmandu'), '2026-11-08');
  const range = calendarSyncRange('2026-11-01', '2026-11-01', 'Asia/Shanghai', Date.parse('2026-11-08T12:00:00Z'));
  assert.equal(range.from, Date.parse('2026-10-31T16:00:00Z') / 1000);
  assert.equal(range.to, Date.parse('2026-11-01T16:00:00Z') / 1000);
});
test('spring and autumn DST dates preserve the real 23-hour and 25-hour days', () => {
  const spring = calendarSyncRange('2026-03-08', '2026-03-08', 'America/New_York', Date.parse('2026-12-01T00:00:00Z'));
  const autumn = calendarSyncRange('2026-11-01', '2026-11-01', 'America/New_York', Date.parse('2026-12-01T00:00:00Z'));
  assert.equal(spring.to - spring.from, 23 * 3600);
  assert.equal(autumn.to - autumn.from, 25 * 3600);
});
test('today ends at now, future or invalid dates and oversized ranges are rejected', () => {
  const now = Date.parse('2026-11-08T12:30:00Z');
  assert.equal(calendarSyncRange('2026-11-08', '2026-11-08', 'UTC', now).to, now / 1000);
  assert.throws(() => calendarSyncRange('2026-02-30', '2026-03-01', 'UTC', now), /有效日期/);
  assert.throws(() => calendarSyncRange('2026-11-09', '2026-11-09', 'UTC', now), /当前时间/);
  assert.throws(() => calendarSyncRange('2026-11-08', '2026-11-07', 'UTC', now), /结束日期/);
  assert.throws(() => calendarSyncRange('2024-01-01', '2026-11-07', 'UTC', now), /365/);
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
});
