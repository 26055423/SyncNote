import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReviewIcon, TradeIcon } from './ui/icons';
import type { MarketSymbol } from './localTerminal';
export type { MarketSymbol } from './localTerminal';

/** Display aliases never replace broker codes in requests or persisted series. */
export function marketSymbolLabel(row: MarketSymbol): string {
  if (/(?:NAS(?:DAQ)?[\s_-]*100|US[\s_-]*100|USTEC|USTECH|US[\s_-]*TECH[\s_-]*100|NDX)/i.test(`${row.symbol} ${row.description ?? ''}`)) return '纳斯达克100';
  if (/^XAUUSD(?:[._-].*|m|c)?$/i.test(row.symbol)) return '黄金 / 美元';
  return row.description || row.symbol;
}
const categories = ['全部', '外汇', '指数', '贵金属', '能源', '其他'] as const;
type Category = typeof categories[number];
/** Categories are display filters only; original broker codes remain intact. */
export function marketSymbolCategory(row: MarketSymbol): Category {
  const text = `${row.symbol} ${row.description ?? ''} ${row.path ?? ''}`;
  if (/XAU|XAG|XPT|XPD|gold|silver|platinum|palladium|metal|黄金|白银|贵金属/i.test(text)) return '贵金属';
  if (/NAS|USTEC|US100|US30|US500|SPX|SP500|DJ30|GER40|DE40|UK100|JP225|HK50|index|indices|nasdaq|dow jones|指数|纳指/i.test(text)) return '指数';
  if (/WTI|BRENT|USOIL|UKOIL|XTI|XBR|NATGAS|crude|energy|能源|原油|天然气/i.test(text)) return '能源';
  if (/forex|外汇/i.test(text) || /^(?:EUR|USD|GBP|JPY|AUD|NZD|CAD|CHF|CNH|CNY|HKD|SGD|NOK|SEK|ZAR|MXN|TRY){2}(?:[._-].*|m|c)?$/i.test(row.symbol)) return '外汇';
  return '其他';
}
function SearchIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;
}
export interface SymbolPickerProps {
  symbol: string;
  symbols: MarketSymbol[];
  loading?: boolean;
  disabled?: boolean;
  error?: string;
  contextNote?: string;
  onSelect: (symbol: string) => Promise<void> | void;
  onOpen?: () => void;
}
export function SymbolPicker({ symbol, symbols, loading, disabled, error, contextNote, onSelect, onOpen }: SymbolPickerProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('全部');
  const [selecting, setSelecting] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (open) { if (!dialog.current?.open) dialog.current?.showModal(); search.current?.focus(); }
    else dialog.current?.close();
  }, [open]);
  const q = query.trim().toLocaleLowerCase().replace(/纳指/g, '纳斯达克100')
    .replace(/^(?:nas100|us100|ustec|ustech|ndx)$/, '纳斯达克100').replace(/^gold$/, '黄金');
  const matching = symbols.filter((row) => (category === '全部' || marketSymbolCategory(row) === category)
    && `${row.symbol} ${row.description ?? ''} ${marketSymbolLabel(row)}`.toLocaleLowerCase().includes(q));
  const rows = matching.slice(0, 100);
  const select = async (code: string) => {
    if (selecting || disabled) return;
    setSelecting(true); setFailure('');
    try { await onSelect(code); setOpen(false); }
    catch (err) { setFailure(err instanceof Error ? err.message : '切换失败，请重试。'); }
    finally { setSelecting(false); }
  };
  return <div className="symbol-picker">
    <button type="button" className="tool-btn symbol-trigger" aria-label={`选择品种：${symbol}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled || selecting}
      onClick={() => { setQuery(''); setCategory('全部'); setFailure(''); onOpen?.(); setOpen(true); }}>
      <SearchIcon /><span>{symbol}</span>
    </button>
    {createPortal(<dialog ref={dialog} className="symbol-search-dialog" aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClose={() => setOpen(false)}>
      <div className="symbol-search-head"><h2 id={`${id}-title`}>商品代码 / 名称搜索</h2><button type="button" className="tool-btn" aria-label="关闭品种选择" onClick={() => setOpen(false)}>×</button></div>
      <div className="symbol-search-input"><SearchIcon /><input ref={search} aria-label="搜索品种" placeholder="搜索代码或名称，如 NAS100、纳指" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && rows[0] && !loading) { event.preventDefault(); void select(rows[0].symbol); } }} />{query ? <button type="button" className="tool-btn" aria-label="清空搜索" onClick={() => { setQuery(''); search.current?.focus(); }}>×</button> : <kbd>Enter</kbd>}</div>
      <div className="symbol-search-filters" role="group" aria-label="品种分类">{categories.map((name) => <button type="button" key={name} aria-pressed={category === name} className={category === name ? 'is-active' : ''} onClick={() => setCategory(name)}>{name}</button>)}</div>
      <div className="symbol-search-caption"><span>{query ? '搜索结果' : '可用品种'}</span><span>{loading ? '正在更新…' : `${matching.length} 个品种`}</span></div>
      {error || failure ? <p role="alert" className="local-error">{failure || error}</p> : null}
      <div className="symbol-search-list" aria-busy={loading || selecting}>
        {rows.map((row) => {
          const group = marketSymbolCategory(row);
          return <button type="button" key={row.symbol} className={`symbol-search-row${row.symbol === symbol ? ' is-active' : ''}`} aria-pressed={row.symbol === symbol} disabled={selecting || disabled} onClick={() => void select(row.symbol)}>
            <span className="symbol-search-icon" aria-hidden="true">{group === '指数' ? <TradeIcon /> : <ReviewIcon />}</span><strong>{row.symbol}</strong><span className="symbol-search-description">{marketSymbolLabel(row)}</span><small>{group}</small><span className="symbol-search-selected" aria-hidden="true">{row.symbol === symbol ? '✓' : ''}</span>
          </button>;
        })}
        {!matching.length ? <div className="symbol-search-empty"><SearchIcon /><strong>{loading ? '正在读取品种…' : '没有匹配的品种'}</strong><p>{loading ? '请稍候' : symbols.length ? '试试其他代码、名称，或切换分类。' : '连接 MT5 后读取券商品种，离线时仅显示已保存的行情。'}</p></div> : null}
        {matching.length > rows.length ? <p className="symbol-search-note">已显示前 {rows.length} 项，请输入更多文字缩小范围。</p> : null}
      </div>
      <div className="symbol-search-footer">{contextNote || '品种来自当前数据源，使用券商原始代码。'}<span>Esc 关闭</span></div>
    </dialog>, document.body)}
  </div>;
}
