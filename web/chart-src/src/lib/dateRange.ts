/** Calendar dates use the chart display zone, independent of the browser's zone. */
function parsedDate(value: string): { year: number; month: number; day: number; utc: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('请选择有效日期。');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  if (year < 1970 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('请选择有效日期。');
  return { year, month, day, utc };
}

export function dateInZone(ms: number, zone: string): string {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDate(value: string, days: number): string {
  return new Date(parsedDate(value).utc + days * 86400000).toISOString().slice(0, 10);
}

/** First real second on a local calendar date, including zones whose DST shifts at midnight. */
export function dateStartUTC(value: string, zone: string): number {
  const target = parsedDate(value);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = (seconds: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(seconds * 1000)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  let left = target.utc / 1000 - 172800, right = target.utc / 1000 + 172800;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (localDate(mid) < value) left = mid + 1;
    else right = mid;
  }
  if (localDate(left) !== value) throw new Error('显示时区中不存在这个日期，请选择其他日期。');
  return left;
}

/** UTC half-open bounds [from, to); the EA only uploads candles closed before to. */
export function calendarSyncRange(start: string, end: string, zone: string, nowMs = Date.now()): { from: number; to: number } {
  parsedDate(start); parsedDate(end);
  if (end < start) throw new Error('结束日期不能早于开始日期。');
  const from = dateStartUTC(start, zone);
  const to = Math.min(dateStartUTC(shiftDate(end, 1), zone), Math.floor(nowMs / 1000));
  if (from >= to) throw new Error('请选择当前时间之前的同步区间。');
  if (to - from > 365 * 86400) throw new Error('一次最多同步 365 天，请缩小区间。');
  return { from, to };
}
