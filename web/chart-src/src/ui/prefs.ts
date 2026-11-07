import { useSyncExternalStore } from 'react';
import { DEFAULT_ZONE, resolveZone, setDisplayZone } from '../lib/time';

/**
 * 本机偏好：主题 / 显示时区 / 图表语言。
 *
 * 存在浏览器 `localStorage.sn-ui.v1`（跟画图收藏一样，不跨设备、不上云）。
 * `apply()` 之后 `:root[data-theme]` 由 CSS 令牌接管配色，Vela 那边由调用方用
 * `ws.setTheme()/setTimezone()/setLocale()` 跟着改。
 *
 * 首屏防闪在 `index.html` 的内联脚本里，键名和形状必须与这里保持一致。
 */

export type Theme = 'dark' | 'light';
export type ChartLocale = 'zh-Hans' | 'en';

export interface Prefs {
  theme: Theme;
  /** IANA 时区名，或 `'auto'`（跟随系统）。 */
  timezone: string;
  /** Vela 图表内部文案的语言（只影响图表，不翻译本站界面）。 */
  chartLocale: ChartLocale;
  /** 主图与副图的背景网格线，默认隐藏。 */
  gridVisible: boolean;
}

const STORAGE_KEY = 'sn-ui.v1';

const DEFAULTS: Prefs = { theme: 'dark', timezone: DEFAULT_ZONE, chartLocale: 'zh-Hans', gridVisible: false };

function load(): Prefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return {
        theme: parsed.theme === 'light' ? 'light' : 'dark',
        timezone: typeof parsed.timezone === 'string' && parsed.timezone ? parsed.timezone : DEFAULT_ZONE,
        chartLocale: parsed.chartLocale === 'en' ? 'en' : 'zh-Hans',
        gridVisible: parsed.gridVisible === true,
      };
    }
  } catch {
    /* 隐私模式 / 存档损坏：用默认值，不阻塞打开图表 */
  }
  return { ...DEFAULTS };
}

class PrefsStore {
  private state: Prefs = load();
  private listeners = new Set<() => void>();

  constructor() {
    this.apply();
  }

  getState = (): Prefs => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<Prefs>): void {
    this.state = { ...this.state, ...patch };
    this.apply();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* 存不了就算了，本次会话仍然生效 */
    }
    for (const listener of this.listeners) listener();
  }

  setTheme = (next: Theme): void => this.set({ theme: next });
  setTimezone = (next: string): void => this.set({ timezone: next || DEFAULT_ZONE });
  setChartLocale = (next: ChartLocale): void => this.set({ chartLocale: next });
  setGridVisible = (next: boolean): void => this.set({ gridVisible: next });
  toggleTheme = (): void => this.set({ theme: this.state.theme === 'dark' ? 'light' : 'dark' });

  private apply(): void {
    const root = document.documentElement;
    root.dataset.theme = this.state.theme;
    setDisplayZone(resolveZone(this.state.timezone));
  }
}

export const prefs = new PrefsStore();

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefs.subscribe, prefs.getState, prefs.getState);
}
