import { useEffect, useRef, useState } from 'react';
import { prefs, usePrefs, type ChartLocale, type Theme } from './ui/prefs';
import { ZONES } from './lib/zones';
import { resolveZone, systemZone, zoneOffsetLabel } from './lib/time';

/**
 * 顶栏「设置」：主题 / 显示时区 / 图表语言。
 *
 * 全部存在浏览器本地（`sn-ui.v1`），即时生效：主题靠 `:root[data-theme]` 的 CSS 令牌，
 * 时区和语言由 `ChartWorkspace` 转给 Vela 的 `setTimezone` / `setLocale`。
 */
export function SettingsMenu() {
  const { theme, timezone, chartLocale } = usePrefs();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const resolved = resolveZone(timezone);

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        type="button"
        className={`tool-btn settings-trigger ${open ? 'is-active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title="设置：主题、时区、图表语言"
        aria-label="设置"
        aria-expanded={open}
      >
        ⚙ 设置
      </button>

      {open ? (
        <div className="settings-panel" role="dialog" aria-label="设置">
          <div className="settings-group">
            <span className="settings-title">主题</span>
            <div className="settings-row">
              {([
                ['dark', '☾ 深色'],
                ['light', '☀ 浅色'],
              ] as Array<[Theme, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`settings-opt ${theme === id ? 'is-active' : ''}`}
                  onClick={() => prefs.setTheme(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-group">
            <span className="settings-title">显示时区</span>
            <div className="settings-list">
              {ZONES.map((zone) => (
                <button
                  key={zone.id}
                  type="button"
                  className={`settings-opt settings-zone ${timezone === zone.id ? 'is-active' : ''}`}
                  onClick={() => prefs.setTimezone(zone.id)}
                >
                  <span className="settings-zone-label">{zone.id === 'auto' ? `自动（跟随系统） · ${systemZone()}` : zone.label}</span>
                  <em className="settings-offset">{zoneOffsetLabel(zone.id)}</em>
                </button>
              ))}
            </div>
            <span className="settings-foot">
              本机系统时区 {systemZone()} · 当前偏移 {zoneOffsetLabel(resolved)}。成交时间、复盘时间与 K 线时间轴都用这个时区。
            </span>
          </div>

          <div className="settings-group">
            <span className="settings-title">图表语言</span>
            <div className="settings-row">
              {([
                ['zh-Hans', '中文'],
                ['en', 'English'],
              ] as Array<[ChartLocale, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`settings-opt ${chartLocale === id ? 'is-active' : ''}`}
                  onClick={() => prefs.setChartLocale(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="settings-foot">只换 K 线图内部（工具栏、指标、右键菜单）的语言。</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
