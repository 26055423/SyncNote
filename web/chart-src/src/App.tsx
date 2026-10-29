import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, money, stamp } from './api';
import { ChartWorkspace, TIMEFRAME_OPTIONS, type ChartHandle, type SyncKind } from './vela/ChartWorkspace';
import { LayoutMenu } from './vela/LayoutMenu';
import { TfMenu } from './vela/TfMenu';
import { LiveProvider, TIMEFRAMES, type ReviewCharts } from './vela/provider';

/* ------------------------------------------------------------------ 类型 */

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

interface Member {
  id: string;
  name: string;
  username: string;
  avatar: string;
  can_view: boolean;
}

interface Board {
  user: { id: string; nickname: string; username: string; avatar: string; onboarding_step: number };
  members: Member[];
  snapshots: Record<string, { data: any; updated: number }>;
  events: Array<{ id: number; person: string; kind: string; text: string; created: number }>;
  messages: Array<{ id: number; person: string; name?: string; text: string; created: number }>;
  now: number;
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

type Tab = 'trade' | 'social' | 'friends' | 'review' | 'inbox';

/* ------------------------------------------------------------------ 工具 */

const sideText = (side: string) => (side === 'sell' ? '做空' : '做多');
const sideClass = (side: string) => (side === 'sell' ? 'sell' : 'buy');

const LIVE_KEYS: Record<string, 'M1' | 'M5' | 'M15' | 'H1'> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '1h': 'H1' };

/** 服务端按 1m/5m/15m/1h 返回，图表用 M1/M5/M15/H1。 */
function toChartBars(bars: Record<string, number[][]> | undefined): ReviewCharts {
  const out: ReviewCharts = {};
  for (const [key, rows] of Object.entries(bars || {})) {
    const mapped = LIVE_KEYS[key];
    if (mapped && Array.isArray(rows)) out[mapped] = rows;
  }
  return out;
}

function latestTradeOf(snapshot: { data: any } | undefined) {
  const rows = snapshot?.data?.history ?? [];
  return rows.length ? rows[0] : null;
}

function barsClose(entry: Entry | null): number | null {
  const bars = entry?.review?.charts?.M1;
  if (!bars || !bars.length) return null;
  return bars[bars.length - 1][4];
}

/* ------------------------------------------------------------------ 页面 */

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [board, setBoard] = useState<Board | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [target, setTarget] = useState<{ person: string; ticket: string; t?: number } | null>(null);
  const [tab, setTab] = useState<Tab>('trade');
  const [error, setError] = useState('');
  const [railOpen, setRailOpen] = useState(true);

  const [note, setNote] = useState({ body: '', tags: [] as string[] });
  const [categories, setCategories] = useState<string[]>([]);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [inbox, setInbox] = useState<ShareRow[]>([]);
  const [following, setFollowing] = useState<Array<{ id: string; name: string }>>([]);
  const [recipients, setRecipients] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [shareState, setShareState] = useState('');
  const [chat, setChat] = useState('');
  const [tf, setTf] = useState('15');
  const [layout, setLayout] = useState('4');
  const [syncs, setSyncs] = useState<Partial<Record<SyncKind, boolean>>>({});
  const [mode, setMode] = useState<'review' | 'live'>(() => (params.get('ticket') ? 'review' : 'live'));
  const [liveTick, setLiveTick] = useState<{ bid: number; ask: number; time: number } | null>(null);
  const [liveBars, setLiveBars] = useState<ReviewCharts | null>(null);
  const liveRef = useRef<ReviewCharts>({});
  const liveProvider = useMemo(
    () => new LiveProvider(liveRef.current, 'XAUUSD', async () => toChartBars((await api<{ bars: Record<string, number[][]> }>('/api/live?limit=3')).bars)),
    [],
  );

  const chartRef = useRef<ChartHandle>(null);
  const saveTimer = useRef<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------- 看板轮询 */

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await api<Board>('/api/state?view=board');
        if (!alive) return;
        if (data.user.onboarding_step < 4) {
          location.replace('/welcome');
          return;
        }
        setBoard(data);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  /* ------------------------------------------------- 默认目标：最近一笔交易 */

  useEffect(() => {
    if (!board || target) return;
    const ticketParam = params.get('ticket');
    const personParam = params.get('person') || board.user.id;
    const tParam = Number(params.get('t') || 0) || undefined;
    if (ticketParam) {
      setTarget({ person: personParam, ticket: ticketParam, t: tParam });
      return;
    }
    const mine = latestTradeOf(board.snapshots[board.user.id]);
    if (mine) setTarget({ person: board.user.id, ticket: String(mine.ticket), t: undefined });
  }, [board, target, params]);

  /* --------------------------------------------------------- 复盘数据加载 */

  useEffect(() => {
    if (!target) return;
    let alive = true;
    let timer: number | null = null;
    const run = async () => {
      try {
        const data = await api<Entry>(`/api/chart/entry?person=${encodeURIComponent(target.person)}&ticket=${encodeURIComponent(target.ticket)}`);
        if (!alive) return;
        setEntry(data);
        setNote(data.note ? { body: data.note.body, tags: [...data.note.tags] } : { body: '', tags: [] });
        setError('');
        if (data.review.status !== 'ready') timer = window.setTimeout(run, 5000);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [target]);

  /* ------------------------------------------------------------ 实时行情 */

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const data = await api<{ tick: any; bars: Record<string, number[][]> }>('/api/live?limit=2');
        if (!alive) return;
        if (data.tick) setLiveTick(data.tick);
        const incoming = toChartBars(data.bars);
        if (Object.keys(incoming).length) {
          // 原地合并：LiveProvider 持有的是同一个对象引用，整体替换会让它看不到更新。
          const merged = liveRef.current;
          for (const [key, rows] of Object.entries(incoming)) {
            const base = merged[key as keyof ReviewCharts] ?? [];
            const last = (rows as number[][])[(rows as number[][]).length - 1];
            const next = [...base];
            if (last) {
              if (next.length && next[next.length - 1][0] === last[0]) next[next.length - 1] = last;
              else next.push(last);
            }
            merged[key as keyof ReviewCharts] = next.slice(-3000);
          }
        }
      } catch {
        /* 下一轮再试 */
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'live' || liveBars) return;
    let alive = true;
    void api<{ bars: Record<string, number[][]> }>('/api/live?limit=400')
      .then((data) => {
        if (!alive) return;
        const incoming = toChartBars(data.bars);
        if (!Object.keys(incoming).length) return;
        Object.assign(liveRef.current, incoming);
        setLiveBars(liveRef.current);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [mode, liveBars]);

  /* ------------------------------------------------- 会话：作业 / 关注 */

  useEffect(() => {
    if (!board) return;
    void api<{ items: ShareRow[] }>('/api/reviews/inbox').then((r) => setInbox(r.items)).catch(() => undefined);
    void api<{ following: Array<{ id: string; name: string }> }>('/api/profile').then((r) => setFollowing(r.following)).catch(() => undefined);
  }, [board?.user.id]);

  useEffect(() => {
    const person = target?.person;
    if (!person) return;
    void api<{ categories: string[] }>('/api/journal?person=' + encodeURIComponent(person))
      .then((r) => setCategories(r.categories))
      .catch(() => undefined);
  }, [target?.person]);

  /* ------------------------------------------------------------- 画线保存 */

  const onStateChange = useCallback(
    (document: unknown) => {
      if (!entry || entry.read_only || !target) return;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        setSaveState('saving');
        try {
          await api('/api/chart/state', { ticket: target.ticket, state: document });
          setSaveState('saved');
          window.setTimeout(() => setSaveState('idle'), 1600);
        } catch {
          setSaveState('error');
        }
      }, 900);
    },
    [entry, target],
  );

  /* --------------------------------------------------------------- 动作 */

  const openTicket = (person: string, ticket: string, t?: number) => {
    setTarget({ person, ticket, t });
    setMode('review');
    const qs = new URLSearchParams({ person, ticket });
    if (t) qs.set('t', String(t));
    history.replaceState(null, '', '/chart?' + qs.toString());
  };

  const saveNote = async () => {
    if (!entry || entry.read_only || !target) return;
    setNoteState('saving');
    try {
      await api('/api/journal', { ticket: target.ticket, body: note.body, tags: note.tags });
      setNoteState('saved');
      window.setTimeout(() => setNoteState('idle'), 1600);
    } catch (err) {
      setNoteState('error');
      setShareState(err instanceof Error ? err.message : '');
    }
  };

  const sendShare = async () => {
    if (!entry || entry.read_only || !target) return;
    if (!recipients.size) {
      setShareState('请选择至少一位收件人');
      return;
    }
    setShareState('正在发送…');
    try {
      await api('/api/reviews/share', { ticket: target.ticket, recipients: [...recipients], message });
      setShareState('已发给 ' + recipients.size + ' 位好友');
      setRecipients(new Set());
      setMessage('');
    } catch (err) {
      setShareState(err instanceof Error ? err.message : '发送失败');
    }
  };

  const sendChat = async () => {
    const text = chat.trim();
    if (!text || !board) return;
    setChat('');
    try {
      await api('/api/messages', { text });
      const data = await api<Board>('/api/state?view=board');
      setBoard(data);
      window.setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    }
  };

  const toggleSync = (kind: SyncKind) => {
    chartRef.current?.toggleSync(kind);
    setSyncs(chartRef.current?.getSyncs() ?? {});
  };

  /* --------------------------------------------------------------- 派生 */

  const me = board?.user;
  const mySnap = me ? board?.snapshots[me.id] : undefined;
  const myHistory: any[] = mySnap?.data?.history ?? [];
  const myPositions: any[] = mySnap?.data?.positions ?? [];
  const floating = myPositions.reduce((n: number, p: any) => n + (p.profit || 0), 0);
  const mt5Online = Boolean(mySnap && board && board.now - (mySnap.updated || 0) <= 45 && mySnap.data.online !== false);
  const price = (liveTick && liveTick.bid ? (liveTick.bid + liveTick.ask) / 2 : null) ?? barsClose(entry) ?? null;
  const liveAnchor = (() => {
    const rows = liveBars?.M1 ?? [];
    const last = rows[rows.length - 1];
    return last ? last[0] * 1000 : Date.now();
  })();
  const availableTfs = useMemo(() => {
    const charts = entry?.review.charts ?? {};
    return TIMEFRAME_OPTIONS.filter((option) => {
      const base = charts[TIMEFRAMES[option.id].base];
      if (!base || base.length < 2) return false;
      if (option.id === '30' || option.id === '240') return base.length >= 4;
      if (option.id === '1D') return base.length >= 24;
      return true;
    });
  }, [entry]);

  const ready = Boolean(
    entry && entry.review.status === 'ready' && Object.values(entry.review.charts || {}).some((bars) => (bars?.length ?? 0) > 1),
  );
  const unseen = inbox.filter((row) => !row.seen).length;
  const trade = entry?.review.trade ?? {};
  const anchorMs = useMemo(() => {
    const opened = entry?.review?.opened ?? null;
    const closed = trade?.closed ?? null;
    const seconds = target?.t ?? opened ?? closed ?? 0;
    return seconds > 0 ? seconds * 1000 : 0;
  }, [entry, trade?.closed, target?.t]);

  if (!board) {
    return (
      <div className="boot">
        <p>{error || '正在连接同频…'}</p>
        {error ? <a href="/login">重新登录</a> : null}
      </div>
    );
  }

  return (
    <div className="app">
      {/* ---------------------------------------------------------- 顶栏 */}
      <header className="topbar">
        <a className="brand" href="/">
          <span className="mark">▥</span> 同频 <small>交易台</small>
        </a>
        <div className="symbol">
          <b>{trade.symbol || 'XAUUSD'}</b>
          <span className={price != null ? 'price' : 'price dim'}>{price != null ? money(price) : '—'}</span>
          <span className={mt5Online ? 'link-dot on' : 'link-dot off'}>{mt5Online ? 'MT5 在线' : 'MT5 离线'}</span>
        </div>
        <div className="metrics">
          <span>净值 <b>{money(mySnap?.data?.equity)}</b></span>
          <span>余额 <b>{money(mySnap?.data?.balance)}</b></span>
          <span>浮盈 <b className={floating >= 0 ? 'up' : 'down'}>{money(floating)}</b></span>
        </div>
        <nav className="top-actions">
          <a href="/history">交易记录</a>
          <a href="/profile">{me?.nickname || '个人中心'}</a>
          <button type="button" className="icon" title="显示/隐藏右侧栏" onClick={() => setRailOpen((v) => !v)}>▤</button>
        </nav>
      </header>

      {/* ---------------------------------------------------------- 主体 */}
      <div className={`main ${railOpen ? '' : 'rail-closed'}`}>
        <section className="chart-pane">
          <div className="chart-toolbar">
            <LayoutMenu current={layout} onPick={(id) => { chartRef.current?.setLayout(id); setLayout(id); }} syncs={syncs} onToggleSync={toggleSync} />
            <TfMenu current={tf} options={availableTfs} onPick={(id) => { chartRef.current?.setTimeframe(id); setTf(id); }} />
            <button type="button" className={`tool-btn ${syncs.crosshair ? 'is-active' : ''}`} onClick={() => toggleSync('crosshair')}>十字线联动</button>
            <button type="button" className={`tool-btn ${mode === 'live' ? 'is-active' : ''}`} onClick={() => setMode('live')}>行情</button>
            <button type="button" className={`tool-btn ${mode === 'review' ? 'is-active' : ''}`} disabled={!target} onClick={() => setMode('review')}>复盘</button>
            <button type="button" className="tool-btn" onClick={() => chartRef.current?.focus()}>回到开仓</button>
            <span className="spacer" />
            {entry?.read_only ? <span className="badge">只读 · {entry.owner.name} 的复盘</span> : null}
            <span className="save-hint">
              {saveState === 'saving' ? '保存画线…' : saveState === 'saved' ? '画线已保存' : saveState === 'error' ? '画线保存失败' : ''}
            </span>
          </div>

          <div className="chart-body">
            {mode === 'live' && liveBars ? (
              <ChartWorkspace
                key="live"
                ref={chartRef}
                charts={liveBars}
                provider={liveProvider}
                providerName="live"
                symbol="XAUUSD"
                anchorMs={liveAnchor}
                savedState={null}
                readOnly={false}
                timeframes={TIMEFRAME_OPTIONS.map((o) => o.id)}
                onTimeframe={setTf}
                onLayout={setLayout}
                onSyncs={setSyncs}
                onError={setError}
              />
            ) : ready ? (
              <ChartWorkspace
                key={`${target?.person}:${target?.ticket}`}
                ref={chartRef}
                charts={entry!.review.charts}
                symbol={trade.symbol || 'XAUUSD'}
                anchorMs={anchorMs}
                savedState={entry!.chart?.document ?? null}
                readOnly={entry!.read_only}
                timeframes={availableTfs.map((o) => o.id)}
                onStateChange={onStateChange}
                onTimeframe={setTf}
                onLayout={setLayout}
                onSyncs={setSyncs}
                onError={setError}
              />
            ) : (
              <div className="chart-empty">
                <p>{target ? (entry?.review.status === 'pending' ? '等待 MT5 上传这笔交易的 K 线…' : entry?.review.error || '参考行情准备中…') : '还没有可复盘的交易'}</p>
                <p className="dim">{target ? '同步完成后图表会自动出现' : '先在 MT5 上同步一笔成交'}</p>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------ 右栏 */}
        {railOpen ? (
          <aside className="rail">
            <div className="rail-icons">
              {([
                ['trade', '▣', '交易'],
                ['social', '💬', '交流'],
                ['friends', '👥', '好友'],
                ['review', '📝', '复盘'],
                ['inbox', '📬', '作业'],
              ] as Array<[Tab, string, string]>).map(([key, icon, label]) => (
                <button
                  key={key}
                  type="button"
                  className={tab === key ? 'is-active' : ''}
                  title={label}
                  aria-label={label}
                  onClick={() => setTab(key)}
                >
                  {icon}
                  {key === 'inbox' && unseen ? <i className="dot">{unseen}</i> : null}
                </button>
              ))}
            </div>

            <div className="rail-body">
              {tab === 'trade' ? (
                <div className="pane">
                  <h3>账户</h3>
                  <div className="kv">
                    <span>净值</span><b>{money(mySnap?.data?.equity)}</b>
                    <span>余额</span><b>{money(mySnap?.data?.balance)}</b>
                    <span>浮盈</span><b className={floating >= 0 ? 'up' : 'down'}>{money(floating)}</b>
                  </div>

                  <h3>持仓 <small>{myPositions.length}</small></h3>
                  {myPositions.length ? (
                    <table className="mini">
                      <thead><tr><th>品种</th><th>方向</th><th>手数</th><th>开仓</th><th>浮盈</th></tr></thead>
                      <tbody>
                        {myPositions.map((p) => (
                          <tr key={p.ticket}>
                            <td>{p.symbol}</td>
                            <td className={sideClass(p.side)}>{sideText(p.side)}</td>
                            <td>{p.volume}</td>
                            <td>{money(p.open)}</td>
                            <td className={(p.profit || 0) >= 0 ? 'up' : 'down'}>{money(p.profit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="dim">没有持仓</p>}

                  <h3>最近成交 <small>{myHistory.length}</small></h3>
                  <TradeList rows={myHistory.slice(0, 12)} onPick={(row) => openTicket(me!.id, String(row.ticket))} />
                </div>
              ) : null}

              {tab === 'social' ? (
                <div className="pane chat-pane">
                  <h3>交流板</h3>
                  <div className="chat-log">
                    {(board.messages || []).map((m) => (
                      <div key={m.id} className={`msg ${m.person === me?.id ? 'mine' : ''}`}>
                        <div className="meta">{m.name || m.person} · {stamp(m.created)}</div>
                        <p>{m.text}</p>
                      </div>
                    ))}
                    <div ref={chatEnd} />
                  </div>
                  <div className="chat-form">
                    <textarea value={chat} maxLength={1000} rows={2} placeholder="聊聊这笔交易…" onChange={(e) => setChat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat(); } }} />
                    <button type="button" className="primary" onClick={() => void sendChat()} disabled={!chat.trim()}>发送</button>
                  </div>
                </div>
              ) : null}

              {tab === 'friends' ? (
                <div className="pane">
                  <h3>好友 <small>{Math.max(0, board.members.length - 1)}</small></h3>
                  {board.members.filter((m) => m.id !== me?.id).map((member) => {
                    const snap = board.snapshots[member.id];
                    const rows: any[] = snap?.data?.history ?? [];
                    const online = Boolean(snap && board.now - (snap.updated || 0) <= 45 && snap.data.online !== false);
                    const profit = (snap?.data?.positions ?? []).reduce((n: number, p: any) => n + (p.profit || 0), 0);
                    return (
                      <div className="friend" key={member.id}>
                        <div className="friend-head">
                          <b>{member.name}</b>
                          <span className={online ? 'link-dot on' : 'link-dot off'}>{online ? '在线' : '离线'}</span>
                          {snap ? <span className="dim">浮盈 {money(profit)}</span> : null}
                        </div>
                        {member.can_view ? (
                          rows.length ? <TradeList rows={rows.slice(0, 5)} onPick={(row) => openTicket(member.id, String(row.ticket))} /> : <p className="dim">暂无可查看的成交</p>
                        ) : <p className="dim">对方未开放交易数据</p>}
                      </div>
                    );
                  })}
                  {board.members.length <= 1 ? <p className="dim">还没有好友，去个人中心关注交易伙伴。</p> : null}
                </div>
              ) : null}

              {tab === 'review' ? (
                <div className="pane">
                  <h3>
                    复盘
                    {trade.ticket ? <small> #{trade.ticket} · {sideText(trade.side)}</small> : null}
                  </h3>
                  {entry ? (
                    <>
                      <p className="dim">
                        {money(trade.volume)} 手 · {money(trade.open)} → {money(trade.close)} · 盈亏 <b className={(trade.profit || 0) >= 0 ? 'up' : 'down'}>{money(trade.profit)}</b><br />
                        开仓 {stamp(entry.review.opened)} · 平仓 {stamp(trade.closed)}
                      </p>
                      <label htmlFor="note-body">入场理由、管理问题与下次改进</label>
                      <textarea id="note-body" value={note.body} readOnly={entry.read_only} maxLength={10000} onChange={(e) => setNote((prev) => ({ ...prev, body: e.target.value }))} />
                      <div className="tags">
                        {categories.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className={note.tags.includes(tag) ? 'tag is-on' : 'tag'}
                            disabled={entry.read_only}
                            onClick={() => setNote((prev) => ({
                              ...prev,
                              tags: prev.tags.includes(tag)
                                ? prev.tags.filter((v) => v !== tag)
                                : prev.tags.length < 12 ? [...prev.tags, tag] : prev.tags,
                            }))}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                      {!entry.read_only ? (
                        <button type="button" className="primary" onClick={() => void saveNote()} disabled={noteState === 'saving'}>
                          {noteState === 'saving' ? '保存中…' : noteState === 'saved' ? '已保存' : '保存笔记'}
                        </button>
                      ) : <p className="dim">这是好友的复盘，笔记与画线只读。</p>}

                      {!entry.read_only ? (
                        <details className="share-box">
                          <summary>把这笔复盘发给好友</summary>
                          {following.length ? (
                            <div className="people">
                              {following.map((row) => (
                                <label key={row.id} className="person">
                                  <input
                                    type="checkbox"
                                    checked={recipients.has(row.id)}
                                    onChange={() => setRecipients((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(row.id)) next.delete(row.id);
                                      else next.add(row.id);
                                      return next;
                                    })}
                                  />
                                  <span>{row.name}</span>
                                </label>
                              ))}
                            </div>
                          ) : <p className="dim">还没有关注的人。</p>}
                          <textarea value={message} maxLength={500} rows={2} placeholder="留言，例如：看 15 分钟这段结构" onChange={(e) => setMessage(e.target.value)} />
                          <button type="button" className="primary" onClick={() => void sendShare()} disabled={!following.length}>发送</button>
                          {shareState ? <p className="dim">{shareState}</p> : null}
                        </details>
                      ) : null}
                    </>
                  ) : <p className="dim">先在左侧选一笔交易。</p>}
                </div>
              ) : null}

              {tab === 'inbox' ? (
                <div className="pane">
                  <h3>作业 <small>{inbox.length}</small></h3>
                  {inbox.length ? inbox.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className={`inbox-item ${row.seen ? '' : 'is-new'}`}
                      onClick={() => openTicket(row.owner.id, row.ticket)}
                    >
                      <b>{row.owner.name}</b> · {row.trade?.symbol || 'XAUUSD'} {sideText(row.trade?.side || 'buy')}
                      <span className="dim">{row.trade ? `净盈亏 ${money(row.trade.profit)}` : '交易记录未同步'} · {stamp(row.created)}</span>
                      {row.message ? <em>{row.message}</em> : null}
                    </button>
                  )) : <p className="dim">还没有收到作业。好友在复盘里点「发给好友」后会出现在这里。</p>}
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- 底栏 */}
      <footer className="ticker">
        <span className="label">动态</span>
        <div className="track">
          {(board.events || []).filter((e) => e.kind === 'open' || e.kind === 'close').slice(0, 12).map((e) => (
            <span key={e.id} className="tick">
              <b>{nameOf(board, e.person)}</b> {e.text} <time>{stamp(e.created)}</time>
            </span>
          ))}
          {!board.events.length ? <span className="tick dim">暂无交易动态</span> : null}
        </div>
      </footer>

      {error ? <div className="toast">{error}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 子组件 */

function nameOf(board: Board, person: string): string {
  return board.members.find((m) => m.id === person)?.name || person;
}

function TradeList({ rows, onPick }: { rows: any[]; onPick: (row: any) => void }) {
  if (!rows.length) return <p className="dim">暂无成交</p>;
  return (
    <table className="mini">
      <thead><tr><th>时间</th><th>方向</th><th>开/平</th><th>盈亏</th><th /></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.ticket}>
            <td className="dim">{stamp(row.closed)}</td>
            <td className={sideClass(row.side)}>{sideText(row.side)}</td>
            <td>{money(row.open)} / {money(row.close)}</td>
            <td className={(row.profit || 0) >= 0 ? 'up' : 'down'}>{money(row.profit)}</td>
            <td><button type="button" className="link" onClick={() => onPick(row)}>复盘</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
