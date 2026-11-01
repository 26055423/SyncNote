/**
 * 设置 → 时区 里列出的时区。
 *
 * `'auto'` 跟随浏览器；其余是 IANA 时区名。想知道某个时区**此刻**是 UTC+几，
 * 用 `lib/time.ts` 的 `zoneOffsetLabel()`，不要在这里写死偏移。
 */
export interface ZoneOption {
  id: string;
  /** 顶栏/表格里用的短名。 */
  short: string;
  /** 设置列表里的全名。 */
  label: string;
}

export const ZONES: ZoneOption[] = [
  { id: 'auto', short: '自动', label: '自动（跟随系统）' },
  { id: 'Asia/Shanghai', short: '北京', label: '北京 UTC+8' },
  { id: 'Etc/UTC', short: 'UTC', label: 'UTC' },
  { id: 'America/New_York', short: '纽约', label: '纽约（美东）' },
  { id: 'Europe/London', short: '伦敦', label: '伦敦' },
  { id: 'Europe/Berlin', short: '法兰克福', label: '法兰克福' },
  { id: 'Asia/Tokyo', short: '东京', label: '东京' },
  { id: 'Asia/Dubai', short: '迪拜', label: '迪拜' },
  { id: 'Asia/Singapore', short: '新加坡', label: '新加坡' },
  { id: 'Australia/Sydney', short: '悉尼', label: '悉尼' },
];

export function zoneShort(id: string): string {
  return ZONES.find((entry) => entry.id === id)?.short ?? id;
}
