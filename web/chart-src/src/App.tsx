import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, money, stamp } from './api';
import { ChartWorkspace, TIMEFRAME_OPTIONS, type ChartHandle, type SyncKind } from './vela/ChartWorkspace';
import { LayoutMenu } from './vela/LayoutMenu';
import { TfMenu } from './vela/TfMenu';
import { TIMEFRAMES } from './vela/provider';

interface Review {
  status: string;
  charts: Record<string, number[][]>;
  errors: Record<string, string>;
  trade: any;
  opened: number | null;
  source?: string;
  error?: string;
}

interface Entry {
  mode: 'owner' | 'viewer' | 'shared';
  owner: { id: string; name: string; avatar: string };
  read_only: boolean;
  share: { id: number; message: string; created: number; seen: boolean } | null;
  review: Review;
  note: { body: string; tags: string[]; updated: number } | null;
  chart: { document: unknown; updated: number } | null;
}

interface ShareRow {
  id: number;
  ticket: string;
  owner: { id: string; name: string; avatar: string };
  message: string;
  created: number;
  seen: boolean;
  trade: any;
}

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const shareId = params.get('share') || '';
  const person = params.get('person') || '';
  const ticket = params.get('ticket') || '';
  const anchorInput = Number(params.get('t') || 0);

  const [entry, setEntry] = useState<Entry | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState({ body: '', tags: [] as string[] });
  const [categories, setCategories] = useState<string[]>([]);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [inbox, setInbox] = useState<ShareRow[]>([]);
  const [following, setFollowing] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [shareState, setShareState] = useState('');
  const [panel, setPanel] = useState<'note' | 'share' | 'inbox'>('note');
  const [tf, setTf] = useState('15');
  const [layout, setLayout] = useState('4');
  const [syncs, setSyncs] = useState<Partial<Record<SyncKind, boolean>>>({});

  const chartRef = useRef<ChartHandle>(null);
  const saveTimer = useRef<number | null>(null);
  const requested = useRef(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (shareId) qs.set('share', shareId);
    else {
      if (person) qs.set('person', person);
      qs.set('ticket', ticket);
    }
    const data = await api<Entry>('/api/chart/entry?' + qs.toString());
    setEntry(data);
    setError('');
    return data;
  }, [shareId, person, ticket]);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const run = async () => {
      try {
        let data = await load();
        if (!alive) return;
        if (data.review.status === 'not_requested' && !requested.current) {
          requested.current = true;
          try {
            await api('/api/trade-review/request', { ticket: data.review.trade.ticket, person: data.owner.id });
          } catch {
            /* 已有请求在排队时忽略 */
          }
          data = await load();
          if (!alive) return;
        }
        setNote(data.note ? { body: data.note.body, tags: [...data.note.tags] } : { body: '', tags: [] });
        if (data.review.status !== 'ready') timer = window.setTimeout(run, 5000);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!entry) return;
    void api<{ items: ShareRow[] }>('/api/reviews/inbox').then((r) => setInbox(r.items)).catch(() => undefined);
    void api<{ following: Array<{ id: string; name: string }> }>('/api/profile').then((r) => setFollowing(r.following)).catch(() => undefined);
    void api<{ categories: string[] }>('/api/journal?person=' + encodeURIComponent(entry.owner.id)).then((r) => setCategories(r.categories)).catch(() => undefined);
  }, [entry?.owner.id]);

  const anchorMs = useMemo(() => {
    const opened = entry?.review?.opened ?? null;
    const closed = entry?.review?.trade?.closed ?? null;
    const seconds = anchorInput || opened || closed || 0;
    return seconds > 0 ? seconds * 1000 : 0;
  }, [entry, anchorInput]);

  const availableTfs = useMemo(() => {
    const charts = entry?.review.charts ?? {};
    return TIMEFRAME_OPTIONS.filter((option) => {
      const recipe = TIMEFRAMES[option.id];
      const base = charts[recipe.base];
      if (!base || base.length < 2) return false;
      if (option.id === '30' || option.id === '240') return base.length >= 4;
      if (option.id === '1D') return base.length >= 24;
      return true;
    });
  }, [entry]);

  const onStateChange = useCallback(
    (document: unknown) => {
      if (!entry || entry.read_only) return;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        setSaveState('saving');
        try {
          await api('/api/chart/state', { ticket: entry.review.trade.ticket, state: document });
          setSaveState('saved');
          window.setTimeout(() => setSaveState('idle'), 1600);
        } catch {
          setSaveState('error');
        }
      }, 900);
    },
    [entry],
  );

  const saveNote = async () => {
    if (!entry || entry.read_only) return;
    setNoteState('saving');
    try {
      await api('/api/journal', { ticket: entry.review.trade.ticket, body: note.body, tags: note.tags });
      setNoteState('saved');
      window.setTimeout(() => setNoteState('idle'), 1600);
    } catch (err) {
      setNoteState('error');
      setShareState(err instanceof Error ? err.message : '');
    }
  };

  const sendShare = async () => {
    if (!entry || entry.read_only) return;
    if (!selected.size) {
      setShareState('请选择至少一位收件人');
      return;
    }
    setShareState('正在发送…');
    try {
      await api('/api/reviews/share', { ticket: entry.review.trade.ticket, recipients: [...selected], message });
      setShareState('已发送，对方可以在「作业」里看到这张图和画线');
      setSelected(new Set());
      setMessage('');
    } catch (err) {
      setShareState(err instanceof Error ? err.message : '发送失败');
    }
  };

  const toggleSync = (kind: SyncKind) => {
    chartRef.current?.toggleSync(kind);
    setSyncs(chartRef.current?.getSyncs() ?? {});
  };

  if (error) {
    return (
      <div className="page state-page">
        <p className="state-title">图表打不开</p>
        <p className="state-text">{error}</p>
        <a className="link" href="/history">返回交易记录</a>
      </div>
    );
  }

  if (!entry) {
    return <div className="page state-page"><p className="state-title">正在读取这笔复盘…</p></div>;
  }

  const review = entry.review;
  const trade = review.trade ?? {};
  const side = trade.side === 'sell' ? '做空' : '做多';
  const ready = review.status === 'ready' && Object.values(review.charts || {}).some((bars) => (bars?.length ?? 0) > 1);
  const unseen = inbox.filter((row) => !row.seen).length;

  return (
    <div className="page">
      <header className="head">
        <a className="back" href="/history">← 交易记录</a>
        <div className="title">
          <h1>
            {trade.symbol || 'XAUUSD'} · {side}
            {entry.read_only ? <span className="badge">只读 · 来自 {entry.owner.name} 的复盘作业</span> : null}
          </h1>
          <p className="meta">
            {money(trade.volume)} 手 · 开仓 {money(trade.open)} → 平仓 {money(trade.close)} · 净盈亏 {money(trade.profit)} ·
            开仓 {stamp(review.opened)} · 平仓 {stamp(trade.closed)}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="ghost" onClick={() => chartRef.current?.focus()}>回到交易时间</button>
          <button type="button" className="ghost" onClick={() => setPanel('inbox')}>作业{inbox.length ? ` · ${inbox.length}` : ''}{unseen ? <span className="dot">{unseen}</span> : null}</button>
          {!entry.read_only ? <button type="button" className="ghost" onClick={() => setPanel('share')}>分享作业</button> : null}
        </div>
      </header>

      <div className="tools">
        <LayoutMenu current={layout} onPick={(id) => { chartRef.current?.setLayout(id); setLayout(id); }} syncs={syncs} onToggleSync={toggleSync} />
        <TfMenu current={tf} options={availableTfs} onPick={(id) => { chartRef.current?.setTimeframe(id); setTf(id); }} />
        <button type="button" className={`tool-btn ${syncs.crosshair ? 'is-active' : ''}`} onClick={() => toggleSync('crosshair')}>十字线联动</button>
        <span className="spacer" />
        <span className="save-hint">{saveState === 'saving' ? '正在保存画线…' : saveState === 'saved' ? '画线已保存' : saveState === 'error' ? '画线保存失败' : ready ? '画线自动保存' : ''}</span>
      </div>

      <main className="body">
        <section className="chart-area">
          {ready ? (
            <ChartWorkspace
              key={entry.owner.id + ':' + trade.ticket + ':' + anchorMs}
              ref={chartRef}
              charts={review.charts}
              symbol={trade.symbol || 'XAUUSD'}
              anchorMs={anchorMs}
              savedState={entry.chart?.document ?? null}
              readOnly={entry.read_only}
              timeframes={availableTfs.map((option) => option.id)}
              onStateChange={onStateChange}
              onTimeframe={setTf}
              onLayout={setLayout}
              onSyncs={setSyncs}
              onError={setError}
            />
          ) : (
            <div className="chart-wait">
              <p>{review.status === 'pending' ? '等待 MT5 上传这笔交易的 K 线…' : review.error || '参考行情还在准备中。'}</p>
              <p className="dim">同步完成前可以先写笔记；行情到了图表会自动出现。</p>
            </div>
          )}
        </section>

        <aside className="side">
          <nav className="tabs">
            <button type="button" className={panel === 'note' ? 'is-active' : ''} onClick={() => setPanel('note')}>笔记</button>
            <button type="button" className={panel === 'share' ? 'is-active' : ''} onClick={() => setPanel('share')}>分享</button>
            <button type="button" className={panel === 'inbox' ? 'is-active' : ''} onClick={() => setPanel('inbox')}>作业</button>
          </nav>

          {panel === 'note' ? (
            <div className="pane">
              <label htmlFor="note-body">入场理由、管理问题与下次改进</label>
              <textarea id="note-body" value={note.body} readOnly={entry.read_only} maxLength={10000} onChange={(event) => setNote((prev) => ({ ...prev, body: event.target.value }))} />
              <div className="tags">
                {categories.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={note.tags.includes(tag) ? 'tag is-on' : 'tag'}
                    disabled={entry.read_only}
                    onClick={() =>
                      setNote((prev) => ({
                        ...prev,
                        tags: prev.tags.includes(tag) ? prev.tags.filter((value) => value !== tag) : prev.tags.length < 12 ? [...prev.tags, tag] : prev.tags,
                      }))
                    }
                  >
                    {tag}
                  </button>
                ))}
              </div>
              {!entry.read_only ? (
                <button type="button" className="primary" onClick={saveNote} disabled={noteState === 'saving'}>
                  {noteState === 'saving' ? '保存中…' : noteState === 'saved' ? '已保存' : '保存笔记'}
                </button>
              ) : (
                <p className="dim">这是对方发来的作业，笔记与画线仅可查看。</p>
              )}
              {entry.chart?.updated ? <p className="dim">画线最后保存 {stamp(entry.chart.updated)}</p> : null}
            </div>
          ) : null}

          {panel === 'share' ? (
            <div className="pane">
              {entry.read_only ? (
                <p className="dim">只读作业不能再转发。</p>
              ) : (
                <>
                  <label>发给谁（只列已关注的交易伙伴）</label>
                  {following.length ? (
                    <div className="people">
                      {following.map((row) => (
                        <label key={row.id} className="person">
                          <input
                            type="checkbox"
                            checked={selected.has(row.id)}
                            onChange={() =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })
                            }
                          />
                          <span>{row.name}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="dim">还没有关注的交易伙伴。先去个人中心关注对方，再回来发作业。</p>
                  )}
                  <label htmlFor="share-message">留言</label>
                  <textarea id="share-message" value={message} maxLength={500} placeholder="例如：看 15 分钟这段结构的处理，标了三处问题。" onChange={(event) => setMessage(event.target.value)} />
                  <button type="button" className="primary" onClick={sendShare} disabled={!following.length}>发送作业</button>
                  {shareState ? <p className="dim">{shareState}</p> : null}
                </>
              )}
            </div>
          ) : null}

          {panel === 'inbox' ? (
            <div className="pane">
              {inbox.length ? (
                inbox.map((row) => (
                  <a key={row.id} className={`inbox-item ${row.seen ? '' : 'is-new'}`} href={'/chart?share=' + row.id}>
                    <b>{row.owner.name}</b> · {row.trade?.symbol || 'XAUUSD'} {row.trade?.side === 'sell' ? '做空' : '做多'}
                    <span className="dim">{row.trade ? `净盈亏 ${money(row.trade.profit)}` : '交易记录未同步'} · {stamp(row.created)}</span>
                    {row.message ? <em>{row.message}</em> : null}
                  </a>
                ))
              ) : (
                <p className="dim">还没有收到作业。对方在复盘图里点「分享作业」后会出现在这里。</p>
              )}
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
