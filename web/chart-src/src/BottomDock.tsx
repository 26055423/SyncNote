import { useState } from 'react';
import { money, quotePrice, stamp } from './api';

/**
 * 底部交易区：持仓 / 挂单 / 历史，对应 MT5 终端下方那一排。
 * 连上本机 EA 时持仓和挂单来自 EA；历史成交来自云端（可点「复盘」）。
 */

type Tab = 'positions' | 'orders' | 'history';

export interface BottomDockProps {
  connected: boolean;
  localPositions: any[];
  localOrders: any[];
  cloudPositions: any[];
  history: any[];
  reviewed?: string[];
  onReview: (ticket: string) => void;
}

const sideText = (side: string) => (side === 'sell' ? '卖出' : '买入');

export function BottomDock({ connected, localPositions, localOrders, cloudPositions, history, reviewed, onReview }: BottomDockProps) {
  const [tab, setTab] = useState<Tab>('positions');
  const [open, setOpen] = useState(true);
  const [sortDesc, setSortDesc] = useState(true);

  const positions = connected ? localPositions : cloudPositions;
  const orders = localOrders;
  const rows = sortDesc ? history : [...history].reverse();
  const count = (id: Tab) => (id === 'positions' ? positions.length : id === 'orders' ? orders.length : history.length);

  return (
    <section className={`dock ${open ? 'is-open' : ''}`}>
      <header className="dock-head">
        <nav className="dock-tabs">
          {([
            ['positions', '持仓'],
            ['orders', '挂单'],
            ['history', '历史'],
          ] as Array<[Tab, string]>).map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? 'is-active' : ''} onClick={() => { setTab(id); setOpen(true); }}>
              {label} <small>{count(id)}</small>
            </button>
          ))}
        </nav>
        <span className="dim">
          {connected ? '本机 EA · 实时' : '云端 · 5 秒刷新'}
          {tab === 'positions' && !connected ? '（本机 EA 未连接，持仓来自云端快照）' : ''}
        </span>
        <button type="button" className="icon" onClick={() => setOpen((v) => !v)} title={open ? '收起' : '展开'}>
          {open ? '▾' : '▴'}
        </button>
      </header>

      {open ? (
        <div className="dock-body">
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
            rows.length ? (
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>平仓时间</th><th>品种</th><th>方向</th><th>手数</th><th>开仓价</th><th>平仓价</th><th>净盈亏</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((t: any) => (
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
            ) : <p className="dim dock-empty">还没有已同步的成交</p>
          ) : null}
        </div>
      ) : null}

      {open && tab === 'history' && history.length ? (
        <button type="button" className="dock-sort" onClick={() => setSortDesc((v) => !v)}>
          {sortDesc ? '最新的在上面' : '最早的在上面的'}
        </button>
      ) : null}
    </section>
  );
}
