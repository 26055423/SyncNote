import { useEffect, useId, useRef, useState } from 'react';
import type { MarketSymbol } from './localTerminal';
export type { MarketSymbol } from './localTerminal';

/** Display aliases never replace broker codes in requests or persisted series. */
export function marketSymbolLabel(row: MarketSymbol): string {
  if (/(?:NAS(?:DAQ)?[\s_-]*100|US[\s_-]*100|USTEC|USTECH|US[\s_-]*TECH[\s_-]*100|NDX)/i.test(`${row.symbol} ${row.description}`)) return '纳斯达克100';
  if (/^XAUUSD(?:[._-].*|m|c)?$/i.test(row.symbol)) return '黄金 / 美元';
  return row.description || row.symbol;
}

export interface SymbolPickerProps {
  symbol: string;
  symbols: MarketSymbol[];
  loading?: boolean;
  disabled?: boolean;
  error?: string;
  onSelect: (symbol: string) => Promise<void> | void;
  onOpen?: () => void;
}

export function SymbolPicker({ symbol, symbols, loading, disabled, error, onSelect, onOpen }: SymbolPickerProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const q = query.trim().toLocaleLowerCase().replace(/纳指/g, '纳斯达克100');
  const matching = symbols.filter((row) => `${row.symbol} ${row.description} ${marketSymbolLabel(row)}`.toLocaleLowerCase().includes(q));
  const rows = matching.slice(0, 100);
  return <div className="symbol-picker" ref={root}>
    <button type="button" className="tool-btn symbol-trigger" aria-label={`选择品种：${symbol}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled || selecting}
      onClick={() => { if (!open) { setQuery(''); setFailure(''); onOpen?.(); } setOpen((value) => !value); }}>
      <strong>{symbol}</strong><span aria-hidden="true">⌄</span>
    </button>
    {open ? <div className="symbol-picker-panel" role="dialog" aria-label="选择行情品种" aria-labelledby={`${id}-title`}>
      <div className="symbol-picker-head"><strong id={`${id}-title`}>选择品种</strong><button type="button" className="tool-btn" aria-label="关闭品种选择" onClick={() => setOpen(false)}>×</button></div>
      <input ref={search} aria-label="搜索品种" placeholder="搜索代码或名称，如 NAS100、纳指" value={query} onChange={(event) => setQuery(event.target.value)} />
      <p className="symbol-picker-note">使用当前券商的原始代码，行情按数据源独立保存。</p>
      {loading ? <p role="status" className="dim">正在读取品种…</p> : null}
      {error || failure ? <p role="alert" className="local-error">{failure || error}</p> : null}
      <div className="symbol-picker-list" aria-busy={loading || selecting}>
        {rows.map((row) => <button type="button" key={row.symbol} className={`symbol-picker-row${row.symbol === symbol ? ' is-active' : ''}`} aria-pressed={row.symbol === symbol} disabled={selecting || disabled}
          onClick={async () => {
            setSelecting(true); setFailure('');
            try { await onSelect(row.symbol); setOpen(false); }
            catch (err) { setFailure(err instanceof Error ? err.message : '切换失败，请重试。'); }
            finally { setSelecting(false); }
          }}>
          <span><strong>{row.symbol}</strong><small>{marketSymbolLabel(row)}</small></span><span aria-hidden="true">{row.symbol === symbol ? '✓' : '→'}</span>
        </button>)}
      </div>
      {!loading && !matching.length ? <p className="dim">{symbols.length ? '没有匹配的品种。' : '当前数据源暂无品种，请连接 MT5 或选择其他数据轨道。'}</p> : null}
      {matching.length > rows.length ? <p className="dim">匹配 {matching.length} 个品种，请输入更多文字缩小范围。</p> : null}
    </div> : null}
  </div>;
}
