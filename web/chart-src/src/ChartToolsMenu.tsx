import { useEffect, useRef, useState, type ReactNode } from 'react';

/** History navigation stays on the existing data paths; this only groups its controls. */
export function ChartHistoryMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="chart-history-menu" ref={root}>
    <button ref={trigger} type="button" className={`tool-btn ${open ? 'is-active' : ''}`} aria-haspopup="dialog"
      aria-expanded={open} onClick={() => setOpen(!open)}>历史数据 <span aria-hidden="true">⌄</span></button>
    {open && <div className="chart-history-popover" role="dialog" aria-label="历史数据">
      <strong>历史数据</strong><p>读取当前轨道，保留画线和复盘定位。</p>{children}
    </div>}
  </div>;
}

export function FullscreenButton() {
  const [active, setActive] = useState(Boolean(document.fullscreenElement));
  const [error, setError] = useState('');
  useEffect(() => {
    const changed = () => { setActive(Boolean(document.fullscreenElement)); setError(''); };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  return <span className="chart-fullscreen">
    <button type="button" className="tool-btn" aria-label={active ? '退出全屏' : '全屏'} title={active ? '退出全屏' : '全屏'}
      disabled={!document.fullscreenEnabled} aria-pressed={active} onClick={() => {
        const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
        void action.catch(() => setError('浏览器暂不支持全屏，请使用窗口最大化。'));
      }}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg></button>
    {error && <span role="status">{error}</span>}
  </span>;
}
