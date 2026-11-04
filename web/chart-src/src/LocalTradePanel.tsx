import { useState } from 'react';
import { money, quotePrice } from './api';
import { localTerminal, localTradeAccess, type LocalTerminalState } from './localTerminal';
import { OrderTicket } from './trade/OrderTicket';
import { submitMarketOrder } from './trade/localSubmit';
import { HistorySyncPanel } from './HistorySyncPanel';

const phaseText = { disconnected: '尚未连接', connecting: '连接中…', pairing: '等待配对码', confirming: '请在 MT5 图表允许本次连接', connected: '本机已连接', error: '连接不可用' };
const commandText: Record<string, string> = { sending: '正在发送', received: 'EA 已接收', submitted: '已提交，等待回报', completed: '执行完成', rejected: '已拒绝', uncertain: '结果待核实', not_found: 'EA 未找到记录，仍需核查' };
const actionText: Record<string, string> = { market: '市价下单', limit: '限价挂单', stop: '止损挂单', close: '平仓', cancel: '撤单', modify: '修改止损止盈' };

export function LocalTradePanel({ state }: { state: LocalTerminalState }) {
  const [code, setCode] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<{ action: string; payload: Record<string, unknown>; description: string; epoch: string } | null>(null);
  const [modifyTicket, setModifyTicket] = useState('');
  const connected = state.phase === 'connected';
  const { realTrading, enabled, canManage, lockedReason } = localTradeAccess(state);

  const perform = (callback: () => unknown) => {
    try { setError(''); callback(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const prepare = (action: string, payload: Record<string, unknown>, description: string) => {
    setError('');
    if (!enabled || !state.capabilities.includes(action) || ((action === 'close' || action === 'modify') && !canManage)) { setError('请在 EA 中授权此账户操作，并处理完待核实指令。'); return; }
    setPrepared({ action, payload, description, epoch: state.epoch });
  };
  const modify = () => {
    const stop = Number(sl || 0), target = Number(tp || 0);
    if (!modifyTicket || !Number.isFinite(stop) || stop < 0 || !Number.isFinite(target) || target < 0) { setError('请选择订单或持仓，填写有效止损止盈价格。'); return; }
    prepare('modify', { ticket: modifyTicket, sl: stop, tp: target }, `修改 #${modifyTicket} · 止损 ${stop || '清除'} · 止盈 ${target || '清除'}`);
  };

  return <>
    {/* ── 数据连接：成交记录 / K 线 / 复盘数据同步 ───────────────── */}
    <section className="link-block" data-kind="data">
      <header className="link-head">
        <h3>数据连接</h3>
        <span className={`link-state ${connected ? 'on' : 'off'}`}>{connected ? '本机在线' : '未连接'}</span>
      </header>
      <p className="dim">成交记录、K 线与复盘数据同步。它不负责下单，删掉也不影响交易连接。</p>
      <HistorySyncPanel terminal={state} />
      <div className="local-buttons">
        {state.phase === 'disconnected' || state.phase === 'error' ? <button className="primary" type="button" onClick={() => perform(() => localTerminal.connect())}>连接本机 MT5</button> : <button className="tool-btn" type="button" onClick={() => { localTerminal.disconnect(); setPrepared(null); setCode(''); }}>断开本机</button>}
        <a href="/local-ea" target="_blank" rel="noopener noreferrer">源码与安装说明 ↗</a>
      </div>
      {state.phase === 'pairing' ? <form className="local-pair" onSubmit={(event) => { event.preventDefault(); perform(() => { localTerminal.pair(code); setCode(''); }); }}>
        <label htmlFor="local-pair-code">EA 图表上的 8 位交易码</label>
        <div className="local-buttons"><input id="local-pair-code" autoComplete="off" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="00000000" /><button className="primary" type="submit" disabled={!/^\d{8}$/.test(code)}>配对</button></div>
      </form> : null}
      {state.phase === 'confirming' ? <p className="local-notice">请切换到 MT5，在 EA 图表上点击「允许本次连接」。</p> : null}
      {state.error || error ? <p className="local-error" role="alert">{error || state.error}</p> : null}
    </section>

    {/* ── 交易连接：本机行情 + 下单 ─────────────────────────────── */}
    <section className="link-block" data-kind="trade">
      <header className="link-head">
        <h3>交易连接</h3>
        <span className={`link-state ${connected ? 'on' : 'off'}`}>{phaseText[state.phase]}</span>
      </header>
      <p className="dim">MT5 密码留在终端。行情和交易指令直接连接本机 EA。</p>
    <OrderTicket
        key={`${state.instance_id}:${state.epoch}:${state.account_id}:${state.server}:${realTrading}`}
        account={{ login: state.account_id, balance: state.account?.balance, equity: state.account?.equity, currency: state.account?.currency, leverage: state.account?.leverage }}
        symbol={state.symbol}
        bid={state.tick?.bid ?? 0}
        ask={state.tick?.ask ?? 0}
        connected={enabled}
        lockedReason={lockedReason}
        real={realTrading}
        quotaUnrestricted={state.unrestricted === true || state.quota_unrestricted === true}
        allowedActions={(['market', 'limit', 'stop'] as const).filter((action) => state.capabilities.includes(action))}
        onSubmit={submitMarketOrder}
      />
    {state.account_id ? <div className="kv"><span>账户</span><b>{state.account_id} · {state.demo ? '模拟账户' : '实盘或类型未确认'}</b><span>服务器</span><b>{state.server}</b><span>权限</span><b>{state.read_only || (!state.demo && !realTrading) ? '只读' : state.unrestricted || state.quota_unrestricted ? '已获本机授权（不限额）' : realTrading ? '已获本机实盘交易授权' : '已获本机模拟交易授权'}</b><span>本机往返</span><b>{state.latency === null ? '待测量' : `${state.latency} ms`}</b></div> : null}
    {connected ? <>
      
      <h3>本机持仓 <small>{state.positions.length}</small></h3>
      {state.positions.map((position) => <div className="local-position" key={String(position.ticket)}>
        <div><b>{position.symbol} · {position.side === 'sell' ? '卖出' : '买入'} {position.volume}</b><span className={(position.profit || 0) >= 0 ? 'up' : 'down'}>{money(position.profit)}</span></div>
        <p className="dim">#{String(position.ticket)} · 开仓 {quotePrice(position.price_open ?? position.open)} · SL {quotePrice(position.sl)} / TP {quotePrice(position.tp)}</p>
        <div className="local-buttons"><button type="button" className="tool-btn" disabled={!enabled || !canManage || !state.capabilities.includes('close')} onClick={() => prepare('close', { position_ticket: String(position.ticket), volume: 0 }, `全部平仓 #${position.ticket} · ${position.symbol} · ${position.volume} 手`)}>平仓</button><button type="button" className="link" disabled={!enabled || !canManage || !state.capabilities.includes('modify')} onClick={() => { setModifyTicket(String(position.ticket)); setSl(String(position.sl || '')); setTp(String(position.tp || '')); }}>修改止损止盈</button></div>
      </div>)}
      {!canManage ? <p className="dim">净额账户：持仓是合并的，平仓/改单已禁用（EA 参数 InpAllowNettingManage=true 可打开）。</p> : null}
      {!state.positions.length ? <p className="dim">本机账户没有持仓</p> : null}
      <h3>本机挂单 <small>{state.orders.length}</small></h3>
      {state.orders.map((order) => <div className="local-position" key={String(order.ticket)}><div><b>{order.symbol} · {order.type} · {order.volume} 手</b><button type="button" className="link" disabled={!enabled || !state.capabilities.includes('cancel')} onClick={() => prepare('cancel', { order_ticket: String(order.ticket) }, `撤销挂单 #${order.ticket} · ${order.symbol}`)}>撤单</button></div><p className="dim">#{String(order.ticket)} · {quotePrice(order.price)}</p></div>)}
      {modifyTicket ? <div className="local-notice local-modify"><p>正在编辑 #{modifyTicket}；留空表示清除该价格。</p><div className="local-price-inputs"><label>止损<input type="number" step="0.01" inputMode="decimal" value={sl} onChange={(event) => setSl(event.target.value)} placeholder="价格" /></label><label>止盈<input type="number" step="0.01" inputMode="decimal" value={tp} onChange={(event) => setTp(event.target.value)} placeholder="价格" /></label></div><div className="local-buttons"><button className="primary" type="button" disabled={!enabled || !canManage || !state.capabilities.includes('modify')} onClick={modify}>预览修改</button><button className="link" type="button" onClick={() => setModifyTicket('')}>取消编辑</button></div></div> : null}
    </> : null}
    {prepared && connected && prepared.epoch === state.epoch ? <div className="local-confirm" role="alert"><b>确认{actionText[prepared.action]}</b><p>账户 {state.account_id} · {state.server}</p><p>{prepared.description}</p><div className="local-buttons"><button className="primary" type="button" disabled={!enabled || !state.capabilities.includes(prepared.action) || (['close', 'modify'].includes(prepared.action) && !canManage)} onClick={() => perform(() => { localTerminal.command(prepared.action, prepared.payload); setPrepared(null); setModifyTicket(''); })}>确认发送一次</button><button className="tool-btn" type="button" onClick={() => setPrepared(null)}>取消</button></div></div> : null}
    {state.commands.length ? <div className="local-command-log"><h3>本页交易回报</h3>{state.commands.slice(0, 8).map((command) => <div className="local-command" key={command.command_id}><b>{actionText[command.action]} · {commandText[command.state] || command.state}{command.partial ? ' · 部分成交' : ''}</b><p className="dim">{command.account_id} · {command.command_id.slice(0, 8)}{command.order ? ` · 订单 ${command.order}` : ''}{command.deal ? ` · 成交 ${command.deal}` : ''}</p>{command.error ? <p className="local-error">{command.error}</p> : null}{!['completed', 'rejected'].includes(command.state) ? <button type="button" className="link" disabled={!connected || command.account_id !== state.account_id || command.server !== state.server} onClick={() => perform(() => localTerminal.queryCommand(command.command_id))}>只查询执行结果</button> : null}</div>)}<p className="dim">结果待核实时不会自动重发。刷新网页会清除此处记录，请同时在 MT5 核查。</p></div> : null}
    </section>
  </>;
}
