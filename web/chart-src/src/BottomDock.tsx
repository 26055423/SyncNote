import { useRef, useState } from 'react';
import { money, quotePrice, stamp } from './api';
import type { HistorySyncState } from './localHistorySync';

/**
 * 底部交易区：持仓 / 挂单 / 历史，对应 MT5 终端下方那一排。
 * 连上本机 EA 时持仓和挂单来自 EA；历史成交来自云端（可点「复盘」）。
 */

type Tab = 'positions' | 'orders' | 'history' | 'tracks';

export interface BottomDockProps {
  connected: boolean;
  localPositions: any[];
  localOrders: any[];
  cloudPositions: any[];
  history: any[];
  historySync?: HistorySyncState;
  onRetryHistorySync?: () => void;
  reviewed?: string[];
  onReview: (ticket: string) => void;
  /** 「轨道」页签的内容：复盘时是数据轨道条，没开复盘时给一句提示。 */
  tracksSlot?: React.ReactNode;
}

const sideText = (side: string) => (side === 'sell' ? '卖出' : '买入');

/** dock-body 高度范围：太矮看不到行，太高压掉图表。 */
const DOCK_MIN = 120;
const DOCK_MAX = 600;
const clampHeight = (h: number) => Math.max(DOCK_MIN, Math.min(DOCK_MAX, h));

export function BottomDock({ connected, localPositions, localOrders, cloudPositions, history, historySync, onRetryHistorySync, reviewed, onReview, tracksSlot }: BottomDockProps) {
  const [tab, setTab] = useState<Tab>('positions');
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('sn-dock-open');
      if (saved === '0') return false;
      if (saved === '1') return true;
    } catch { /* 忽略 */ }
    // 手机上默认收起：把高度还给图表（用户手动展开过就记住）。
    return window.innerWidth > 900 && window.innerHeight >= 760;
  });
  const [sortDesc, setSortDesc] = useState(true);
  const [limit, setLimit] = useState(200);
  const [height, setHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('sn-dock-height'));
      if (Number.isFinite(saved) && saved > 0) return clampHeight(saved);
    } catch { /* 忽略 */ }
    return 190;
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const positions = connected ? localPositions : cloudPositions;
  const orders = localOrders;
  const rows = sortDesc ? history : [...history].reverse();
  const count = (id: Tab) => (id === 'positions' ? positions.length : id === 'orders' ? orders.length : id === 'history' ? history.length : null);
  const setOpenPersist = (next: boolean) => {
    setOpen(next);
    try { localStorage.setItem('sn-dock-open', next ? '1' : '0'); } catch { /* 忽略 */ }
  };

  // 从顶部手柄拖动改高度：向上拖变高、向下拖变矮。指针事件兼顾鼠标和触摸。
  const onHandleDown = (event: React.PointerEvent) => {
    if (!open) return;
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startH: height };
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      setHeight(clampHeight(dragRef.current.startH + (dragRef.current.startY - e.clientY)));
    };
    const onUp = () => {
      dragRef.current = null;
      // 用函数式 setter 读最新高度再存：onUp 闭包捕获的 height 是按下那刻的旧值，
      // 直接存会把拖拽结果丢掉（刷新后回到拖动前）。
      setHeight((h) => { try { localStorage.setItem('sn-dock-height', String(h)); } catch { /* 忽略 */ } return h; });
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  // 键盘可达：聚焦手柄后用上下箭头以 24px 步进调整，PageUp/PageDown 以 96px 调整。
  const onHandleKey = (event: React.KeyboardEvent) => {
    const step = event.key === 'PageUp' || event.key === 'PageDown' ? 96 : 24;
    let next = height;
    if (event.key === 'ArrowUp' || event.key === 'PageUp') next = clampHeight(height + step);
    else if (event.key === 'ArrowDown' || event.key === 'PageDown') next = clampHeight(height - step);
    else return;
    event.preventDefault();
    setHeight(next);
    try { localStorage.setItem('sn-dock-height', String(next)); } catch { /* 忽略 */ }
  };

  return (
    <section className={`dock ${open ? 'is-open' : ''}`}>
      {open ? (
        <div
          className="dock-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整底部面板高度"
          tabIndex={0}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          onDoubleClick={() => { setHeight(190); try { localStorage.setItem('sn-dock-height', '190'); } catch { /* 忽略 */ } }}
          title="拖动调整高度，双击复位"
        />
      ) : null}
      <header className="dock-head">
        <nav className="dock-tabs">
          {([
            ['positions', '持仓'],
            ['orders', '挂单'],
            ['history', '历史'],
            ['tracks', '数据轨道'],
          ] as Array<[Tab, string]>).map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? 'is-active' : ''} onClick={() => { setTab(id); setOpen(true); }}>
              {label}
              {count(id) !== null ? <small>{count(id)}</small> : null}
            </button>
          ))}
        </nav>
        <span className="dim">
          {tab === 'history' ? '云端成交 · 5 秒刷新' : connected ? '本机 EA · 实时' : '云端 · 5 秒刷新'}
          {tab === 'positions' && !connected ? '（本机 EA 未连接，持仓来自云端快照）' : ''}
        </span>
        <button type="button" className="icon" onClick={() => setOpenPersist(!open)} title={open ? '收起' : '展开'} aria-label={open ? '收起底部面板' : '展开底部面板'} aria-expanded={open}>
          {open ? '▾' : '▴'}
        </button>
      </header>

      {open ? (
        <div className="dock-body" style={{ maxHeight: height, height }}>
          {tab === 'positions' ? (
            positions.length ? (
              <table className="grid-table">
                <thead>
                  <tr><th>品种</th><th>方向</th><th>手数</th><th>开仓价</th><th>现价</th><th>止损</th><th>止盈</th><th>浮动盈亏</th></tr>
                </thead>
                <tbody>
                  {positions.map((p: any) => (
                    <tr key={String(p.ticket)}>
                      <td>{p.symbol}<span className="dim"> #{String(p.ticket)}</span></td>
                      <td className={p.side === 'sell' ? 'down' : 'up'}>{sideText(p.side)}</td>
                      <td>{p.volume}</td>
                      <td>{quotePrice(p.price_open ?? p.open)}</td>
                      <td>{quotePrice(p.current)}</td>
                      <td>{quotePrice(p.sl)}</td>
                      <td>{quotePrice(p.tp)}</td>
                      <td className={(p.profit || 0) >= 0 ? 'up' : 'down'}>{money(p.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="dim dock-empty">没有持仓</p>
          ) : null}

          {tab === 'orders' ? (
            orders.length ? (
              <table className="grid-table">
                <thead>
                  <tr><th>品种</th><th>类型</th><th>手数</th><th>委托价</th><th>止损</th><th>止盈</th><th>状态</th></tr>
                </thead>
                <tbody>
                  {orders.map((o: any) => (
                    <tr key={String(o.ticket)}>
                      <td>{o.symbol}<span className="dim"> #{String(o.ticket)}</span></td>
                      <td>{o.type}</td>
                      <td>{o.volume}</td>
                      <td>{quotePrice(o.price)}</td>
                      <td>{quotePrice(o.sl)}</td>
                      <td>{quotePrice(o.tp)}</td>
                      <td className="dim">{o.state || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="dim dock-empty">{connected ? '没有挂单' : '挂单需要连接本机 EA'}</p>
          ) : null}

          {tab === 'history' ? (
            <>
            {historySync?.status === 'error' ? (
              <p className="dim dock-empty" role="status">{historySync.message} <button type="button" className="link" onClick={onRetryHistorySync}>重试成交同步</button></p>
            ) : null}
            {historySync?.enabled && !historySync.recent_ready && historySync.status !== 'error' ? (
              <p className="dim dock-empty" role="status">{historySync.message}</p>
            ) : null}
            {rows.length ? (
              <>
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>平仓时间</th><th>品种</th><th>方向</th><th>手数</th><th>开仓价</th><th>平仓价</th><th>净盈亏</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, limit).map((t: any) => (
                      <tr key={String(t.ticket)}>
                        <td className="dim">{stamp(t.closed)}</td>
                        <td>{t.symbol}</td>
                        <td className={t.side === 'sell' ? 'down' : 'up'}>{sideText(t.side)}</td>
                        <td>{t.volume}</td>
                        <td>{money(t.open)}</td>
                        <td>{money(t.close)}</td>
                        <td className={(t.profit || 0) >= 0 ? 'up' : 'down'}>{money(t.profit)}</td>
                        <td>
                          {reviewed?.includes(String(t.ticket))
                            ? <button type="button" className="link done" onClick={() => onReview(String(t.ticket))}>已复盘</button>
                            : <button type="button" className="link todo" onClick={() => onReview(String(t.ticket))}>未复盘</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="dock-more">
                  <span className="dim">显示 {Math.min(limit, rows.length)} / {rows.length} 笔</span>
                  {limit < rows.length ? <button type="button" className="tool-btn" onClick={() => setLimit((n) => n + 200)}>加载更多</button> : null}
                </div>
              </>
            ) : <p className="dim dock-empty">还没有已同步的成交</p>}
            </>
          ) : null}

          {tab === 'tracks' ? (
            <div className="dock-tracks">
              {tracksSlot ?? <p className="dim dock-empty">打开一笔复盘后，这里显示它的券商数据轨道</p>}
            </div>
          ) : null}
        </div>
      ) : null}

      {open && tab === 'history' && history.length ? (
        <button type="button" className="dock-sort" aria-pressed={sortDesc} onClick={() => setSortDesc((v) => !v)}>
          {sortDesc ? '最新在前 ↓' : '最早在前 ↑'}
        </button>
      ) : null}
    </section>
  );
}
