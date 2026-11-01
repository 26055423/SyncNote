/**
 * 时间格式化。
 *
 * 同频把一切时间戳都当 **UTC 秒**（或毫秒）存：复盘的开平仓、成交表、`/api/live` 的 K 线。
 * 显示是另一条轴：先按 UTC 解释，再按用户选定的 **显示时区**（设置 → 时区；默认
 * Asia/Shanghai，也可以「跟随系统」）格式化。图表里的时间轴交给 Vela 的
 * `setTimezone`，同一个偏好喂给它，所以表格和图表永远对得上。
 *
 * 不要再在别处写死 `+8` 或 `Asia/Shanghai`。
 */

/** 设置里「自动」对应 `'auto'`；其余是 IANA 时区名。 */
export const DEFAULT_ZONE = 'Asia/Shanghai';

/** 浏览器自己所在时区，例如 `Asia/Shanghai`。 */
export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_ZONE;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** `'auto'` 跟随系统；其他值原样当 IANA 时区。 */
export function resolveZone(pref: string): string {
  return pref === 'auto' ? systemZone() : pref || DEFAULT_ZONE;
}

let displayZone = DEFAULT_ZONE;
const cache = new Map<string, Intl.DateTimeFormat>();

export function setDisplayZone(zone: string): void {
  const next = resolveZone(zone);
  if (next === displayZone) return;
  displayZone = next;
  cache.clear();
}

export function getDisplayZone(): string {
  return displayZone;
}

function parts(ms: number): Record<string, string> {
  if (!Number.isFinite(ms)) return {};
  let formatter = cache.get(displayZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: displayZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    cache.set(displayZone, formatter);
  }
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/** `2026-11-01 20:38:12`（显示时区）。 */
export function fmtLocal(ms: number): string {
  const p = parts(ms);
  if (!p.year) return '时间待校准';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** `20:38:12`（显示时区）。 */
export function fmtClock(ms: number): string {
  const p = parts(ms);
  if (!p.hour) return '—';
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** `2026-11-01`（显示时区）。 */
export function fmtDate(ms: number): string {
  const p = parts(ms);
  if (!p.year) return '—';
  return `${p.year}-${p.month}-${p.day}`;
}

/** `UTC+08:00`：从平台读这个时区**当前**的偏移，用于设置面板和顶栏提示。 */
export function zoneOffsetLabel(zone: string): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: resolveZone(zone), timeZoneName: 'shortOffset' });
    const found = dtf.formatToParts(new Date()).find((part) => part.type === 'timeZoneName');
    return found?.value ?? zone;
  } catch {
    return zone;
  }
}
