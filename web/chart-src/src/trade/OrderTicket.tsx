import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { editDraftPrice, type ChartOrderDraft, type ChartOrderEdit } from './chartOrders';
import {
  CONTRACT_SIZE,
  fmtMoney,
  fmtPrice,
  fmtVolume,
  previewRisk,
  sizeByRisk,
  resolveEntry,
  type Account,
  type OrderAction,
  type OrderAttempt,
  type OrderRequest,
  type OrderSide,
  type SymbolSpec,
} from './risk';

/**
 * 下单面板，从 trade_dashboard 的 OrderTicket 搬来：
 * 市价/限价/止损、BUY/SELL、手数、SL/TP、风险预览、解锁下单、一键下单、确认弹窗、结果卡。
 *
 * 与云端无关：只有连上本机 EA 后才允许提交，最终校验在 EA 里。
 */

const VOLUME_STEPS = ['0.01', '0.05', '0.1', '0.5'];

function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const cls = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export interface OrderTicketProps {
  context?: ReactNode;
  account: Account | null;
  symbolSpec?: SymbolSpec | null;
  draftScope?: string;
  chartEdit?: ChartOrderEdit | null;
  onDraftChange?: (draft: ChartOrderDraft | null) => void;
  symbol: string;
  bid: number;
  ask: number;
  connected: boolean;
  /** 连上了但不能下单时，把原因写在这里（比笼统的"未连接"准确）。 */
  lockedReason?: string;
  /** 实盘账户：额外显示醒目标签并多一道确认。 */
  real?: boolean;
  /** EA 授权不限额模式时，手数上限交由券商检查。 */
  quotaUnrestricted?: boolean;
  /** EA 逐项声明的开仓动作；pending 兼容标签不授予 limit/stop 权限。 */
  allowedActions?: readonly OrderAction[];
  submitting?: boolean;
  onSubmit?: (request: OrderRequest, key: string) => Promise<OrderAttempt>;
  onConnect?: () => void;
}

export function OrderTicket({ context, account, symbolSpec = null, draftScope = '', chartEdit, onDraftChange, symbol, bid, ask, connected, lockedReason, real = false, quotaUnrestricted = false, allowedActions = ['market'], submitting = false, onSubmit, onConnect }: OrderTicketProps) {
  const [action, setAction] = useState<OrderAction>('market');
  const [side, setSide] = useState<OrderSide>('buy');
  const [volume, setVolume] = useState('0.01');
  const [riskBased, setRiskBased] = useState(false);
  const [riskBudget, setRiskBudget] = useState('10');
  const [price, setPrice] = useState('');
  const [slOn, setSlOn] = useState(false);
  const [tpOn, setTpOn] = useState(false);
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [armed, setArmed] = useState(false);
  const [realArmed, setRealArmed] = useState(false);
  const [oneClick, setOneClick] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState<OrderAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [chartError, setChartError] = useState('');
  const appliedEdit = useRef<number | null>(null);

  const keyRef = useRef<string | null>(null);
  const fingerprintRef = useRef('');
  const confirmationRef = useRef('');

  const hasQuote = bid > 0 && ask > 0;
  const ref = useMemo(() => ({ bid, ask }), [bid, ask]);
  const sizing = useMemo(() => riskBased ? sizeByRisk({ action, side, price: num(price), sl: slOn ? num(sl) : 0 }, ref, account, symbolSpec, num(riskBudget), quotaUnrestricted) : null,
    [riskBased, action, side, price, slOn, sl, ref, account, symbolSpec, riskBudget, quotaUnrestricted]);
  const effectiveVolume = riskBased ? sizing?.volume ?? 0 : num(volume);
  const priceStep = symbolSpec?.tick_size ?? 0.01;
  const priceText = (value: number) => fmtPrice(value, symbolSpec?.digits ?? 2);

  useEffect(() => {
    if (action === 'market' || price) return;
    const value = defaultPrice(side, action);
    if (value) setPrice(value);
  }, [action, price, side, bid, ask]);

  const request: OrderRequest = useMemo(
    () => ({
      action,
      side,
      symbol,
      volume: effectiveVolume,
      price: action === 'market' ? 0 : num(price),
      sl: slOn ? num(sl) : 0,
      tp: tpOn ? num(tp) : 0,
      deviation: 20,
      magic: 0,
      comment: 'syncnote-web',
    }),
    [action, side, symbol, effectiveVolume, price, slOn, sl, tpOn, tp],
  );

  const preview = useMemo(() => previewRisk(request, ref, account, quotaUnrestricted, symbolSpec), [request, ref, account, quotaUnrestricted, symbolSpec]);
  const entry = resolveEntry(request, ref);
  useEffect(() => {
    onDraftChange?.({ scope: draftScope, symbol, action, side, entry, sl: request.sl, tp: request.tp, volume: request.volume,
      editable: connected && hasQuote && !busy && !submitting, step: priceStep, digits: symbolSpec?.digits ?? 2 });
  }, [onDraftChange, draftScope, symbol, action, side, entry, request.sl, request.tp, request.volume, connected, hasQuote, busy, submitting, priceStep, symbolSpec?.digits]);
  useEffect(() => () => onDraftChange?.(null), [onDraftChange, draftScope]);
  useEffect(() => {
    if (!chartEdit || chartEdit.scope !== draftScope || appliedEdit.current === chartEdit.id) return;
    appliedEdit.current = chartEdit.id;
    try {
      const patch = editDraftPrice({ scope: draftScope, symbol, action, side, entry, sl: request.sl, tp: request.tp, volume: request.volume,
        editable: connected && hasQuote && !busy && !submitting, step: priceStep, digits: symbolSpec?.digits ?? 2 }, chartEdit.field, chartEdit.price, ref, allowedActions);
      setChartError(''); setConfirming(false);
      if (patch.price != null) setPrice(String(patch.price));
      if (patch.action) setAction(patch.action);
      if (patch.sl != null) { setSlOn(true); setSl(String(patch.sl)); }
      if (patch.tp != null) { setTpOn(true); setTp(String(patch.tp)); }
    } catch (error) { setChartError(error instanceof Error ? error.message : String(error)); onDraftChange?.({ scope: draftScope, symbol, action, side, entry, sl: request.sl, tp: request.tp, volume: request.volume, editable: connected && hasQuote && !busy && !submitting, step: priceStep, digits: symbolSpec?.digits ?? 2 }); }
  }, [chartEdit, draftScope, connected, busy, submitting, action, side, entry, request, priceStep, symbolSpec, ref, allowedActions, onDraftChange, hasQuote, symbol]);

  const blocked = !connected
    ? (lockedReason || '本机 EA 未连接 —— 下单已禁用')
    : !allowedActions.includes(action)
    ? '本机 EA 未授权此下单类型'
    : !hasQuote
      ? '等待行情报价…'
      : !armed
        ? '请先勾选「解锁下单」'
        : real && !realArmed
          ? '实盘账户：请再勾选「确认按实盘下单」'
          : sizing?.problem
            ? sizing.problem
          : preview.problems.length > 0
            ? '请先修正校验问题'
            : null;
  const canSubmit = blocked === null && !submitting && !busy;

  function keyFor(payload: OrderRequest): string {
    const fingerprint = JSON.stringify(payload);
    if (!keyRef.current || fingerprintRef.current !== fingerprint) {
      keyRef.current = newIdempotencyKey();
      fingerprintRef.current = fingerprint;
    }
    return keyRef.current;
  }

  async function submit(): Promise<void> {
    if (!onSubmit || !canSubmit) return;
    if (confirming && confirmationRef.current !== JSON.stringify(request)) return;
    setConfirming(false);
    setBusy(true);
    const key = keyFor(request);
    try {
      const result = await onSubmit(request, key);
      setAttempt(result);
      const settled = result.transportError == null && result.status != null && !result.result?.uncertain;
      if (settled) {
        keyRef.current = null;
        fingerprintRef.current = '';
      }
    } catch (error) {
      setAttempt({ status: null, result: null, transportError: error instanceof Error ? error.message : String(error), idempotencyKey: key });
    } finally {
      setBusy(false);
    }
  }

  function defaultPrice(forSide: OrderSide, forAction: OrderAction): string {
    if (!hasQuote) return '';
    const spread = Math.max(ask - bid, 0.01);
    if (forAction === 'limit') return priceText(forSide === 'buy' ? bid : ask);
    return priceText(forSide === 'buy' ? ask + spread : bid - spread);
  }

  function pickAction(next: OrderAction): void {
    setAction(next);
    if (next !== 'market' && !price) setPrice(defaultPrice(side, next));
  }

  function pickSide(next: OrderSide): void {
    if (next !== side) {
      // 换方向时把止损止盈镜像到新方向的正确一侧，保持同样的距离（RR 才不会被绝对值掩盖）。
      const previous = resolveEntry(request, ref);
      const nextEntry = next === 'buy' ? ask : bid;
      if (previous > 0 && nextEntry > 0) {
        const stopDistance = slOn && num(sl) > 0 ? Math.abs(previous - num(sl)) : 0;
        const targetDistance = tpOn && num(tp) > 0 ? Math.abs(num(tp) - previous) : 0;
        if (stopDistance > 0) setSl(priceText(next === 'buy' ? nextEntry - stopDistance : nextEntry + stopDistance));
        if (targetDistance > 0) setTp(priceText(next === 'buy' ? nextEntry + targetDistance : nextEntry - targetDistance));
      }
    }
    setSide(next);
    if (action !== 'market' && price) setPrice(defaultPrice(next, action));
  }

  return (
    <section className={cls('ticket', !connected && 'is-locked')}>
      <header className="ticket-head">
        <h3>下单 {real ? <span className="ticket-real">实盘</span> : null}</h3>
        <span className="dim">{connected ? '手动 · 非自动' : '交易暂不可用'}</span>
      </header>
      {context}
      {onDraftChange ? <p className="hint">可拖动 K 线上的「待下单」入场、止损和止盈线；拖动市价入场线会改为挂单。价格变化后请重新确认下单。带持仓编号的止损、止盈线松手后直接提交改单。</p> : null}
      {chartError ? <p className="problems" role="alert">{chartError}</p> : null}

      {!connected ? (
        <div className="lock-banner">
          {lockedReason || '本机 EA 未连接'}
          {onConnect ? <button type="button" className="link" onClick={onConnect}>如何连接</button> : null}
        </div>
      ) : null}

      <div className="seg">
        {(['market', 'limit', 'stop'] as OrderAction[]).map((a) => (
          <button key={a} type="button" className={cls('seg-btn', action === a && 'is-active')} disabled={!allowedActions.includes(a)} title={!allowedActions.includes(a) ? (a === 'market' ? 'EA 未授权此下单类型' : '本机 EA 首版暂仅支持市价单，挂单开发中') : undefined} onClick={() => pickAction(a)}>
            {a === 'market' ? '市价' : a === 'limit' ? '限价' : '止损'}
          </button>
        ))}
      </div>

      <div className="sides">
        <button type="button" className={cls('side-btn', 'buy', side === 'buy' && 'is-active')} disabled={!connected} onClick={() => pickSide('buy')}>
          BUY <em>{hasQuote ? priceText(ask) : '—'}</em>
        </button>
        <button type="button" className={cls('side-btn', 'sell', side === 'sell' && 'is-active')} disabled={!connected} onClick={() => pickSide('sell')}>
          SELL <em>{hasQuote ? priceText(bid) : '—'}</em>
        </button>
      </div>

      <label className="field">
        <span>仓位模式</span>
        <div className="seg sizing-mode" role="group" aria-label="仓位模式">
          <button type="button" className={cls('seg-btn', !riskBased && 'is-active')} disabled={!connected} onClick={() => { if (sizing?.volume) setVolume(String(sizing.volume)); setRiskBased(false); }}>手动手数</button>
          <button type="button" className={cls('seg-btn', riskBased && 'is-active')} disabled={!connected} onClick={() => { setRiskBased(true); setSlOn(true); }}>以损定仓</button>
        </div>
      </label>
      {riskBased ? <label className="field">
        <span>每笔风险金额（{account?.currency || '账户货币'}）</span>
        <input type="number" min="0.01" step="0.01" value={riskBudget} onChange={(e) => setRiskBudget(e.target.value)} disabled={!connected} inputMode="decimal" />
      </label> : null}
      <label className="field">
        <span>手数</span>
        <div className="field-row">
          <input aria-label="下单手数" type="number" min={symbolSpec?.volume_min ?? 0.01} step={symbolSpec?.volume_step ?? 0.01} value={riskBased ? (sizing?.problem ? '' : String(effectiveVolume)) : volume} onChange={(e) => setVolume(e.target.value)} disabled={!connected || riskBased} inputMode="decimal" />
          <div className="quick">
            {VOLUME_STEPS.map((v) => (
              <button key={v} type="button" className="chip" disabled={!connected || riskBased} onClick={() => setVolume(v)}>{v}</button>
            ))}
          </div>
        </div>
      </label>
      {riskBased ? <p className="hint" role="status">{sizing?.problem || (sizing?.capped ? '手数已按券商或当前授权上限缩小。' : '按止损距离自动计算，向下取整到券商允许的手数。')} 预估亏损不含手续费、滑点及跳空。</p> : null}

      <label className={cls('field', action === 'market' && 'is-disabled')}>
        <span>{action === 'market' ? '市价（按当前买卖价成交）' : '委托价'}</span>
        <input
          type="number"
          step={priceStep}
          value={action === 'market' ? '' : price}
          placeholder={hasQuote ? priceText(side === 'buy' ? ask : bid) : '—'}
          onChange={(e) => setPrice(e.target.value)}
          disabled={action === 'market' || !connected}
          inputMode="decimal"
        />
      </label>

      <div className="stops">
        <label className={cls('field', 'field-inline')}>
          <span>
            <input type="checkbox" checked={slOn} onChange={(e) => setSlOn(e.target.checked)} disabled={!connected || riskBased} /> 止损 SL
          </span>
          <input type="number" step={priceStep} value={sl} onChange={(e) => setSl(e.target.value)} disabled={!slOn || !connected} placeholder="价格" inputMode="decimal" />
        </label>
        <label className={cls('field', 'field-inline')}>
          <span>
            <input type="checkbox" checked={tpOn} onChange={(e) => setTpOn(e.target.checked)} disabled={!connected} /> 止盈 TP
          </span>
          <input type="number" step={priceStep} value={tp} onChange={(e) => setTp(e.target.value)} disabled={!tpOn || !connected} placeholder="价格" inputMode="decimal" />
        </label>
      </div>

      <div className="risk">
        <div className="risk-head">
          <span>风险预览（{account?.currency || '账户货币'}）</span>
          <span className="dim" title={symbolSpec ? '按当前券商的跳动价值估算，金额使用账户货币' : /^XAUUSD(?:[._-].*|m|c)?$/i.test(symbol) ? `${CONTRACT_SIZE} oz per lot（估算）` : '金额需按当前券商合约规格计算'}>估算</span>
        </div>
        <div className="risk-grid">
          <div><em>参考入场</em><b>{entry > 0 ? priceText(entry) : '—'}</b></div>
          <div><em>名义价值</em><b>{preview.notional > 0 ? fmtMoney(preview.notional) : '—'}</b></div>
          <div><em>预估保证金</em><b>{preview.marginUsd != null ? fmtMoney(preview.marginUsd) : '—'}</b></div>
          <div><em>止损预估亏损</em><b className={preview.riskUsd != null ? 'down' : ''}>{preview.riskUsd != null ? fmtMoney(preview.riskUsd) : '—'}</b></div>
          <div><em>目标盈利</em><b className="up">{preview.rewardUsd != null ? fmtMoney(preview.rewardUsd) : '—'}</b></div>
          <div>
            <em>盈亏比 / 占余额</em>
            <b>
              {preview.rr != null ? `${preview.rr.toFixed(2)}R` : '—'}
              {preview.riskPctBalance != null ? <span className="dim"> · {preview.riskPctBalance.toFixed(1)}%</span> : null}
            </b>
          </div>
        </div>
        {preview.problems.length > 0 ? (
          <ul className="problems">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        ) : null}
        {!/^XAUUSD(?:[._-].*|m|c)?$/i.test(symbol) ? <p className="hint">金额预览请以 MT5 当前品种的合约规格为准。</p> : null}
      </div>

      <label className="arm">
        <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} disabled={!connected} />
        <span>解锁下单 <em className="dim">（仅手动，确认后才会发送）</em></span>
      </label>

      {real ? (
        <label className="arm arm-real">
          <input type="checkbox" checked={realArmed} onChange={(e) => setRealArmed(e.target.checked)} disabled={!connected} />
          <span>确认按实盘下单 <em>（这是真实资金，成交不可撤销）</em></span>
        </label>
      ) : null}

      <label className={cls('arm', 'oneclick', oneClick && 'is-on')}>
        <input type="checkbox" checked={oneClick} onChange={(e) => setOneClick(e.target.checked)} disabled={!connected || !armed} />
        <span>一键下单 <em>（勾选后跳过确认，点按钮立即提交委托）</em></span>
      </label>

      <button
        type="button"
        className={cls('submit', side, oneClick && 'is-oneclick')}
        disabled={!canSubmit}
        onClick={() => { if (oneClick) void submit(); else { confirmationRef.current = JSON.stringify(request); setConfirming(true); } }}
      >
        {submitting || busy ? '提交中…' : `${side === 'buy' ? '买入' : '卖出'} ${fmtVolume(request.volume)} ${symbol}${oneClick ? ' · 一键' : ''}`}
      </button>

            {blocked ? <p className="hint">{blocked}</p> : null}

      {attempt ? <ResultCard attempt={attempt} onDismiss={() => setAttempt(null)} /> : null}

      {confirming ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setConfirming(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="确认下单" onClick={(e) => e.stopPropagation()}>
            <h3>确认下单（{real ? '实盘账户' : '模拟账户'}）</h3>
            <dl className="confirm-grid">
              <dt>账户</dt><dd>#{account?.login ?? '—'} · {account?.currency ?? 'USD'}</dd>
              <dt>品种</dt><dd>{symbol}</dd>
              <dt>方向</dt>
              <dd className={side === 'buy' ? 'up' : 'down'}>
                {side === 'buy' ? '买入 BUY' : '卖出 SELL'} · {action === 'market' ? '市价' : action === 'limit' ? '限价' : '止损'}
              </dd>
              <dt>手数</dt><dd>{fmtVolume(request.volume)}</dd>
              {riskBased ? <><dt>风险金额</dt><dd>{fmtMoney(num(riskBudget))} {account?.currency}</dd><dt>止损预估亏损</dt><dd>{fmtMoney(sizing?.loss)} {account?.currency}</dd></> : null}
              {action !== 'market' ? (<><dt>委托价</dt><dd>{priceText(request.price)}</dd></>) : (<><dt>参考价</dt><dd>{priceText(entry)}</dd></>)}
              {slOn ? (<><dt>止损</dt><dd>{priceText(request.sl)}</dd></>) : null}
              {tpOn ? (<><dt>止盈</dt><dd>{priceText(request.tp)}</dd></>) : null}
            </dl>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirming(false)}>取消</button>
              <button type="button" className={cls('btn', 'primary', side)} disabled={!canSubmit || confirmationRef.current !== JSON.stringify(request)} onClick={() => void submit()}>确认提交</button>
            </div>
            {confirmationRef.current !== JSON.stringify(request) ? <p className="hint">报价或参数变化导致手数或订单更新，请取消后重新预览确认。</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ResultCard({ attempt, onDismiss }: { attempt: OrderAttempt; onDismiss: () => void }) {
  const { result, status, transportError } = attempt;
  const uncertain = Boolean(result?.uncertain) || transportError != null;
  const ok = Boolean(result?.ok) && !uncertain;
  const tone = ok ? 'ok' : uncertain ? 'warn' : 'bad';
  return (
    <div className={`result result-${tone}`}>
      <div className="result-head">
        <strong>{ok ? '订单已提交' : uncertain ? '执行结果不确定' : '订单被拒绝'}</strong>
        <button type="button" className="btn-x" onClick={onDismiss} aria-label="关闭">×</button>
      </div>
      {uncertain ? (
        <p className="result-warn">
          {transportError ? `网络/EA 错误：${transportError}` : '指令可能已经到达 EA 并成交。'}
          <br />请只查询执行结果或在 MT5 核查，不要重复提交交易指令。
        </p>
      ) : null}
      <dl className="result-grid">
        <dt>HTTP</dt><dd>{status ?? '—'}</dd>
        <dt>retcode</dt><dd className="mono">{result?.retcode ?? '—'} <span className="dim">{result?.retcode_name ?? ''}</span></dd>
        <dt>order</dt><dd className="mono">{result?.order || '—'}</dd>
        <dt>deal</dt><dd className="mono">{result?.deal || '—'}</dd>
        <dt>成交价</dt><dd className="mono">{result?.price ? fmtPrice(result.price) : '—'}</dd>
        <dt>成交量</dt><dd className="mono">{result?.volume ? fmtVolume(result.volume) : '—'}</dd>
      </dl>
      {result?.error ? <p className="result-err">{result.error}</p> : null}
    </div>
  );
}
