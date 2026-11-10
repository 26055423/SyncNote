import { useEffect, useState } from 'react';
import { api, stamp } from './api';

export function ReviewNotesList({ revision, current = null, open }: { revision: number; current?: string | null; open(id: string): void }) {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ items: Array<{ id: string; ticket: string | null; title: string; updated: number; scene: { symbol: string; anchor_ms: number } }>; has_more: boolean }>({ items: [], has_more: false });
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<typeof data>('/api/notes?' + new URLSearchParams({ q: query, offset: String(offset) }), undefined, { signal: controller.signal })
        .then(result => { setData(result); setError(''); }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, offset, revision]);
  const historyHref = '/history' + (current ? `?note=${encodeURIComponent(current)}` : '');
  return <details className="review-notes-list">
    <summary><span>我的复盘</span><a className="review-notes-history" href={historyHref} title="在交易日历里定位这条复盘" onClick={event => event.stopPropagation()}>交易日历 ↗</a></summary>
    <input aria-label="搜索我的复盘" type="search" value={query} placeholder="搜索内容或品种" onChange={event => { setQuery(event.target.value); setOffset(0); }} />
    {error && <p role="alert">{error}</p>}
    {data.items.map(item => <button type="button" key={item.id} onClick={() => open(item.id)}><b>{item.title || '图表笔记'}</b><small>{item.scene.symbol} · {stamp(item.scene.anchor_ms / 1000)}{item.ticket ? ` · #${item.ticket}` : ''}</small></button>)}
    {!data.items.length && !error && <p className="dim">还没有匹配的笔记</p>}
    {(offset > 0 || data.has_more) && <div><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button type="button" disabled={!data.has_more} onClick={() => setOffset(offset + 50)}>下一页</button></div>}
  </details>;
}
