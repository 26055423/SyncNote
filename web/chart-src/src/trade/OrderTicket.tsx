import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CONTRACT_SIZE,
  fmtMoney,
  fmtPrice,
  fmtVolume,
  previewRisk,
  resolveEntry,
  type Account,
  type OrderAction,
  type OrderAttempt,
  type OrderRequest,
  type OrderSide,
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
  account: Account | null;
  symbol: string;
  bid: number;
  ask: number;
  connected: boolean;
  /** EA 是否声明支持挂单（limit/stop）。首版协议没有，默认关闭。 */
  allowPending?: boolean;
  submitting?: boolean;
  onSubmit?: (request: OrderRequest, key: string) => Promise<OrderAttempt>;
  onConnect?: () => void;
}

export function OrderTicket({ account, symbol, bid, ask, connected, allowPending = false, submitting = false, onSubmit, onConnect }: OrderTicketProps) {
  const [action, setAction] = useState<OrderAction>('market');
  const [side, setSide] = useState<OrderSide>('buy');
  const [volume, setVolume] = useState('0.01');
  const [price, setPrice] = useState('');
  const [slOn, setSlOn] = useState(false);
  const [tpOn, setTpOn] = useState(false);
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [armed, setArmed] = useState(false);
  const [oneClick, setOneClick] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState<OrderAttempt | null>(null);
  const [busy, setBusy] = useState(false);

  const keyRef = useRef<string | null>(null);
  const fingerprintRef = useRef('');

  const hasQuote = bid > 0 && ask > 0;

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
      volume: num(volume),
      price: action === 'market' ? 0 : num(price),
      sl: slOn ? num(sl) : 0,
      tp: tpOn ? num(tp) : 0,
      deviation: 20,
      magic: 0,
      comment: 'tongpin-web',
    }),
    [action, side, symbol, volume, price, slOn, sl, tpOn, tp],
  );

  const ref = useMemo(() => ({ bid, ask }), [bid, ask]);
  const preview = useMemo(() => previewRisk(request, ref, account), [request, ref, account]);
  const entry = resolveEntry(request, ref);

  const blocked = action !== 'market' && !allowPending
    ? '本机 EA 首版不支持挂单（限价/止损），请用市价'
    : !connected
      ? '本机 EA 未连接 —— 下单已禁用'
    : !hasQuote
      ? '等待行情报价…'
      : !armed
        ? '请先勾选「解锁下单」'
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
    if (!onSubmit) return;
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
    if (forAction === 'limit') return fmtPrice(forSide === 'buy' ? bid : ask);
    return fmtPrice(forSide === 'buy' ? ask + spread : bid - spread);
  }

  function pickAction(next: OrderAction): void {
    setAction(next);
    if (next !== 'market' && !price) setPrice(defaultPrice(side, next));
  }

  function pickSide(next: OrderSide): void {
    setSide(next);
    if (action !== 'market' && price) setPrice(defaultPrice(next, action));
  }

  return (
    <section className={cls('ticket', !connected && 'is-locked')}>
      <header className="ticket-head">
        <h3>下单</h3>
        <span className="dim">手动 · 非自动</span>
      </header>

      {!connected ? (
        <div className="lock-banner">
          本机 EA 未连接
          {onConnect ? <button type="button" className="link" onClick={onConnect}>如何连接</button> : null}
        </div>
      ) : null}

      <div className="seg">
        {(['market', 'limit', 'stop'] as OrderAction[]).map((a) => (
          <button key={a} type="button" className={cls('seg-btn', action === a && 'is-active')} disabled={a !== 'market' && !allowPending} title={a !== 'market' && !allowPending ? 'EA 首版未开放挂单' : undefined} onClick={() => pickAction(a)}>
            {a === 'market' ? '市价' : a === 'limit' ? '限价' : '止损'}
          </button>
        ))}
      </div>

      <div className="sides">
        <button type="button" className={cls('side-btn', 'buy', side === 'buy' && 'is-active')} onClick={() => pickSide('buy')}>
          BUY <em>{hasQuote ? fmtPrice(ask) : '—'}</em>
        </button>
        <button type="button" className={cls('side-btn', 'sell', side === 'sell' && 'is-active')} onClick={() => pickSide('sell')}>
          SELL <em>{hasQuote ? fmtPrice(bid) : '—'}</em>
        </button>
      </div>

      <label className="field">
        <span>手数</span>
        <div className="field-row">
          <input type="number" min="0.01" step="0.01" value={volume} onChange={(e) => setVolume(e.target.value)} disabled={!connected} inputMode="decimal" />
          <div className="quick">
            {VOLUME_STEPS.map((v) => (
              <button key={v} type="button" className="chip" onClick={() => setVolume(v)}>{v}</button>
            ))}
          </div>
        </div>
      </label>

      <label className={cls('field', action === 'market' && 'is-disabled')}>
        <span>{action === 'market' ? '市价（按当前买卖价成交）' : '委托价'}</span>
        <input
          type="number"
          step="0.01"
          value={action === 'market' ? '' : price}
          placeholder={hasQuote ? fmtPrice(side === 'buy' ? ask : bid) : '—'}
          onChange={(e) => setPrice(e.target.value)}
          disabled={action === 'market' || !connected}
          inputMode="decimal"
        />
      </label>

      <div className="stops">
        <label className={cls('field', 'field-inline')}>
          <span>
            <input type="checkbox" checked={slOn} onChange={(e) => setSlOn(e.target.checked)} disabled={!connected} /> 止损 SL
          </span>
          <input type="number" step="0.01" value={sl} onChange={(e) => setSl(e.target.value)} disabled={!slOn || !connected} placeholder="价格" inputMode="decimal" />
        </label>
        <label className={cls('field', 'field-inline')}>
          <span>
            <input type="checkbox" checked={tpOn} onChange={(e) => setTpOn(e.target.checked)} disabled={!connected} /> 止盈 TP
          </span>
          <input type="number" step="0.01" value={tp} onChange={(e) => setTp(e.target.value)} disabled={!tpOn || !connected} placeholder="价格" inputMode="decimal" />
        </label>
      </div>

      <div className="risk">
        <div className="risk-head">
          <span>风险预览</span>
          <span className="dim" title={`${CONTRACT_SIZE} oz per lot（估算）`}>估算</span>
        </div>
        <div className="risk-grid">
          <div><em>参考入场</em><b>{entry > 0 ? fmtPrice(entry) : '—'}</b></div>
          <div><em>名义价值</em><b>{preview.notional > 0 ? fmtMoney(preview.notional) : '—'}</b></div>
          <div><em>预估保证金</em><b>{preview.marginUsd != null ? fmtMoney(preview.marginUsd) : '—'}</b></div>
          <div><em>最大亏损</em><b className={preview.riskUsd != null ? 'down' : ''}>{preview.riskUsd != null ? fmtMoney(preview.riskUsd) : '—'}</b></div>
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
      </div>

      <label className="arm">
        <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} disabled={!connected} />
        <span>解锁下单 <em className="dim">（仅手动，确认后才会发送）</em></span>
      </label>

      <label className={cls('arm', 'oneclick', oneClick && 'is-on')}>
        <input type="checkbox" checked={oneClick} onChange={(e) => setOneClick(e.target.checked)} disabled={!connected || !armed} />
        <span>一键下单 <em>（勾选后跳过确认，点按钮即刻成交）</em></span>
      </label>

      <button
        type="button"
        className={cls('submit', side, oneClick && 'is-oneclick')}
        disabled={!canSubmit}
        onClick={() => (oneClick ? void submit() : setConfirming(true))}
      >
        {submitting || busy ? '提交中…' : `${side === 'buy' ? '买入' : '卖出'} ${fmtVolume(request.volume)} ${symbol}${oneClick ? ' · 一键' : ''}`}
      </button>

      {oneClick && canSubmit ? <p className="oneclick-warn">一键下单已开启：点击即提交，不再弹出确认</p> : null}
      {blocked ? <p className="hint">{blocked}</p> : null}

      {attempt ? <ResultCard attempt={attempt} onDismiss={() => setAttempt(null)} /> : null}

      {confirming ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setConfirming(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="确认下单" onClick={(e) => e.stopPropagation()}>
            <h3>确认下单（真实账户）</h3>
            <dl className="confirm-grid">
              <dt>账户</dt><dd>#{account?.login ?? '—'} · {account?.currency ?? 'USD'}</dd>
              <dt>品种</dt><dd>{symbol}</dd>
              <dt>方向</dt>
              <dd className={side === 'buy' ? 'up' : 'down'}>
                {side === 'buy' ? '买入 BUY' : '卖出 SELL'} · {action === 'market' ? '市价' : action === 'limit' ? '限价' : '止损'}
              </dd>
              <dt>手数</dt><dd>{fmtVolume(request.volume)}</dd>
              {action !== 'market' ? (<><dt>委托价</dt><dd>{fmtPrice(request.price)}</dd></>) : (<><dt>参考价</dt><dd>{fmtPrice(entry)}</dd></>)}
              {slOn ? (<><dt>止损</dt><dd>{fmtPrice(request.sl)}</dd></>) : null}
              {tpOn ? (<><dt>止盈</dt><dd>{fmtPrice(request.tp)}</dd></>) : null}
            </dl>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirming(false)}>取消</button>
              <button type="button" className={cls('btn', 'primary', side)} onClick={() => void submit()}>确认提交</button>
            </div>
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
          <br />请先核对「持仓 / 挂单」，再决定是否用同一幂等键重试。
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
