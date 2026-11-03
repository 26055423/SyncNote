import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, money, quotePrice, stamp } from './api';
import { ChartWorkspace, TIMEFRAME_OPTIONS, type ChartHandle, type SyncKind } from './vela/ChartWorkspace';
import { LayoutMenu } from './vela/LayoutMenu';
import { TfMenu } from './vela/TfMenu';
import { LiveProvider, TIMEFRAMES, type BaseTimeframe, type ReviewCharts } from './vela/provider';
import { LocalTradePanel } from './LocalTradePanel';
import { BottomDock } from './BottomDock';
import { DrawingFavs } from './DrawingFavs';
import { SettingsMenu } from './SettingsMenu';
import { TrackStrip } from './TrackStrip';
import { FriendsIcon, MailIcon, ReviewIcon, TradeIcon } from './ui/icons';
import { DEFAULT_FAVORITES } from './vela/drawingTools';
import { localTerminal, useLocalTerminal } from './localTerminal';
import { localHistorySync } from './localHistorySync';

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
  share: { id: number; message: string; created: number; seen: boolean; anchor_ms?: number | null; timeframe?: string | null; layout?: string | null } | null;
  review: Review;
  note: { body: string; tags: string[]; updated: number } | null;
  chart: { document: unknown; updated: number; source?: string } | null;
  /** 券商服务器墙钟 − UTC 的秒数；标注对齐用。 */
  bar_offset?: number;
}

interface Member {
  id: string;
  name: string;
  username: string;
  avatar: string;
  can_view: boolean;
  /** 对方是否开放复盘（交易数据开放不等于复盘开放）。 */
  can_review?: boolean;
  /** 这位成员真正复盘过的成交，和看板里的 reviewed 不同。 */
  reviewed?: string[];
}

interface Board {
  user: { id: string; nickname: string; username: string; avatar: string; onboarding_step: number };
  members: Member[];
  snapshots: Record<string, { data: any; updated: number }>;
  events: Array<{ id: number; person: string; kind: string; text: string; created: number }>;
  messages: Array<{ id: number; person: string; name?: string; text: string; created: number }>;
  now: number;
  /** 真正复盘过的成交（写过笔记或在图上画过），否则算未复盘。 */
  reviewed?: string[];
}

interface ShareRow {
  id: number;
  ticket: string;
  owner: { id: string; name: string; avatar: string };
  message: string;
  created: number;
  seen: boolean;
  /** 分享人点击分享那一刻：激活格子的可见窗口中点（毫秒）与周期。 */
  anchor_ms?: number | null;
  timeframe?: string | null;
  layout?: string | null;
  trade: any;
}

type Tab = 'trade' | 'friends' | 'review' | 'inbox';

/* 复盘图一次抓多宽的行情：按锚点往前/往后取多少天（每个基础周期各自独立）。 */
const REVIEW_BASE_TFS = ['M1', 'M5', 'M15', 'H1'] as const;
/* 行情页一次取多少根（最新 N 根）：这条轨有多少就给多少，按根数而不是按天数。 */
const MARKET_LIMIT: Record<(typeof REVIEW_BASE_TFS)[number], number> = {
  M1: 6000,
  M5: 6000,
  M15: 6000,
  H1: 6000,
};

const REVIEW_WINDOW: Record<(typeof REVIEW_BASE_TFS)[number], [number, number]> = {
  M1: [2, 0.5],
  M5: [10, 2],
  M15: [30, 7],
  H1: [120, 30],
};

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
  const local = useLocalTerminal();
  const localConnected = local.phase === 'connected';
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [board, setBoard] = useState<Board | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [target, setTarget] = useState<{ person: string; ticket: string; t?: number } | null>(null);
  /** 正在看某条消息里的复盘切片时，入口按 share id 取（拿分享人当时的窗口）。 */
  const [shareId, setShareId] = useState<number | null>(() => {
    const raw = params.get('share');
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  });
  const [tab, setTab] = useState<Tab>(() => (params.get('ticket') || params.get('share') ? 'review' : 'trade'));
  const [error, setError] = useState('');
  const [railOpen, setRailOpen] = useState(() => window.innerWidth > 900);
  const [feedFilter, setFeedFilter] = useState<'all' | 'share' | 'chat' | 'unread'>('all');
  const [feedLimit, setFeedLimit] = useState(80);
  const [chatReadAt, setChatReadAt] = useState<number>(() => {
    try { return Number(localStorage.getItem('sn-chat-read') || 0) || 0; } catch { return 0; }
  });

  const [note, setNote] = useState({ body: '', tags: [] as string[] });
  const [categories, setCategories] = useState<string[]>([]);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [inbox, setInbox] = useState<ShareRow[]>([]);
  const [following, setFollowing] = useState<Array<{ id: string; name: string }>>([]);
  // 好友申请：别人申请我的（可通过对）/ 我申请的（可取消）。
  const [friendReq, setFriendReq] = useState<{ incoming: Array<{ id: string; nickname: string; username: string }>; outgoing: Array<{ id: string; nickname: string; username: string }> }>({ incoming: [], outgoing: [] });
  const [recipients, setRecipients] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [shareState, setShareState] = useState('');
  const [chat, setChat] = useState('');
  const [tf, setTf] = useState('15');
  const [layout, setLayout] = useState('4');
  const [syncs, setSyncs] = useState<Partial<Record<SyncKind, boolean>>>({});
  const [favs, setFavs] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('sn-chart-favs');
      const list = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(list) && list.length ? (list as string[]) : DEFAULT_FAVORITES;
    } catch {
      return DEFAULT_FAVORITES;
    }
  });
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const saveFavorites = (list: string[]) => {
    setFavs(list);
    try {
      localStorage.setItem('sn-chart-favs', JSON.stringify(list));
    } catch {
      /* 存不了就算了 */
    }
  };
  const [mode, setMode] = useState<'review' | 'live'>(() => (params.get('ticket') || params.get('share') ? 'review' : 'live'));
  const [liveTick, setLiveTick] = useState<{ bid: number; ask: number; time: number } | null>(null);
  const [liveBars, setLiveBars] = useState<ReviewCharts | null>(null);
  /** 图上画的是哪套数据：server = bars 表（券商墙钟），utc = 交易快照（journal.review 已转 UTC）。 */

  /** 没有本机推送时的兜底：用自己那条券商轨的最新历史 K 线，别让「行情」页空着。 */
  const [marketSeries, setMarketSeries] = useState<ReviewCharts | null>(null);
  const [marketInfo, setMarketInfo] = useState<{ server: string; last: number | null } | null>(null);
  const liveRef = useRef<ReviewCharts>({});
  const liveListeners = useRef(new Set<() => void>());
  const liveSymbol = localConnected ? local.symbol : 'XAUUSD';
  const liveProvider = useMemo(
    () => new LiveProvider(liveRef.current, liveSymbol, (listener) => {
      liveListeners.current.add(listener);
      return () => liveListeners.current.delete(listener);
    }),
    [liveSymbol],
  );

  const chartRef = useRef<ChartHandle>(null);
  const saveTimer = useRef<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  /** 拖动补段的滑动窗口：每个基础周期当前已加载的 K 线（秒）与范围（毫秒）。 */
  const seriesRef = useRef<Record<string, number[][]>>({});
  const windowRef = useRef<Record<string, { from: number; to: number }>>({});
  const fetchingRef = useRef<Set<string>>(new Set());
  /** 某一边已经没有更早/更新的数据时，60 秒内不再追问（避免拖到尽头后每次事件都发请求）。 */
  const edgeBlockRef = useRef<Record<string, number>>({});
  /** 补段要知道“现在看的是哪笔/哪个品种”，放 ref 避免回调拿到旧值。 */
  const ctxRef = useRef<{ shareId: number | null; person?: string; ticket?: string; symbol: string }>({ shareId: null, symbol: 'XAUUSD' });

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
        setError('');
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
    if (!board || target || shareId) return;
    // 用户明确选了「行情」时不要把他拽回复盘。
    if (params.get('view') === 'live') return;
    const ticketParam = params.get('ticket');
    const personParam = params.get('person') || board.user.id;
    const tParam = Number(params.get('t') || 0) || undefined;
    const open = (person: string, ticket: string, t?: number) => {
      setTarget({ person, ticket, t });
      setMode('review');
      setTab('review');
    };
    if (ticketParam) {
      open(personParam, ticketParam, tParam);
      return;
    }
    // 默认落到最近一笔复盘：交易台的第一屏应该是内容，而不是空行情。
    const mine = latestTradeOf(board.snapshots[board.user.id]);
    if (mine) {
      open(board.user.id, String(mine.ticket), undefined);
      history.replaceState(null, '', `/chart?view=review&person=${encodeURIComponent(board.user.id)}&ticket=${encodeURIComponent(String(mine.ticket))}`);
    }
  }, [board, target, params, shareId]);

  /* --------------------------------------------------------- 复盘数据加载 */

  useEffect(() => {
    if (!target && shareId == null) return;
    let alive = true;
    let timer: number | null = null;
    const url = shareId != null
      ? `/api/chart/entry?share=${shareId}`
      : `/api/chart/entry?person=${encodeURIComponent(target!.person)}&ticket=${encodeURIComponent(target!.ticket)}`;
    const run = async () => {
      try {
        const data = await api<Entry>(url);
        if (!alive) return;
        setEntry(data);
        setNote(data.note ? { body: data.note.body, tags: [...data.note.tags] } : { body: '', tags: [] });
        setError('');
        // 按消息打开时，target 由服务端返回的归属交易补上（用于标题、分享卡片和重挂载 key）。
        const ticket = String(data.review?.trade?.ticket ?? '');
        if (shareId != null && !target && ticket) setTarget({ person: data.owner.id, ticket });
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
  }, [target, shareId]);

  /* ------------------------------------------------------------ 实时行情 */

  useEffect(() => {
    for (const key of Object.keys(liveRef.current)) delete liveRef.current[key as keyof ReviewCharts];
    setLiveBars(null);
    setLiveTick(null);
  }, [localConnected, local.epoch]);

  useEffect(() => {
    if (!localConnected) return;
    setLiveTick(local.tick);
    const incoming = toChartBars(local.bars);
    Object.assign(liveRef.current, incoming);
    if (local.history_ready && Object.keys(incoming).length) setLiveBars(liveRef.current);
    for (const listener of liveListeners.current) listener();
  }, [localConnected, local.tick, local.bars, local.history_ready]);

  useEffect(() => () => localTerminal.disconnect(), []);

  /* 本机已连接时离开页面会丢配对令牌：先给一次浏览器级确认。 */
  useEffect(() => {
    if (!localConnected) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [localConnected]);

  /* 刷新/后退/forward 时从 URL 还原视图，而不是只认第一次的 location.search。 */
  useEffect(() => {
    const onPop = () => {
      const next = new URLSearchParams(location.search);
      const share = next.get('share');
      if (share && /^\d+$/.test(share)) {
        setShareId(Number(share));
        setTarget(null);
        setMode('review');
        setTab('review');
        return;
      }
      setShareId(null);
      const ticket = next.get('ticket');
      if (ticket) {
        setTarget({ person: next.get('person') || board?.user.id || '', ticket, t: Number(next.get('t') || 0) || undefined });
        setMode('review');
        setTab('review');
        return;
      }
      setTarget(null);
      setMode(next.get('view') === 'live' ? 'live' : 'review');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [board?.user.id]);

  useEffect(() => {
    localHistorySync.bindUser(board?.user.id || '');
  }, [board?.user.id]);

  useEffect(() => {
    const pause = () => localHistorySync.stop('网页已关闭，笔记同步已暂停。');
    window.addEventListener('pagehide', pause);
    return () => { window.removeEventListener('pagehide', pause); pause(); };
  }, []);

  useEffect(() => {
    if (localConnected) return;
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
          for (const listener of liveListeners.current) listener();
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
  }, [mode, localConnected]);

  useEffect(() => {
    // 既没有本机 EA、也没有 /api/live 缓存时，退回自己券商轨的历史 K 线。
    // 按“最新 N 根”取：这条轨里有 7 年数据，就有多少显示多少，不按天数切。
    if (mode !== 'live' || liveBars || localConnected) return;
    let alive = true;
    void (async () => {
      const out: ReviewCharts = {};
      let info: { server: string; last: number | null } | null = null;
      await Promise.all(REVIEW_BASE_TFS.map(async (tf) => {
        try {
          const data = await api<{ bars: number[][]; feed?: { server?: string }; last_bar?: number | null }>(
            `/api/market/bars?symbol=${encodeURIComponent(liveSymbol)}&tf=${tf}&limit=${MARKET_LIMIT[tf]}`,
          );
          if (data?.bars?.length) out[tf] = data.bars;
          if (data?.feed?.server) info = { server: data.feed.server, last: data.last_bar ?? null };
        } catch {
          /* 还没绑定账户或没有这段数据：保持原来的空态提示 */
        }
      }));
      if (!alive) return;
      setMarketSeries(Object.keys(out).length ? out : null);
      setMarketInfo(info);
    })();
    return () => {
      alive = false;
    };
  }, [mode, liveBars, localConnected, liveSymbol]);

  useEffect(() => {
    if (localConnected || mode !== 'live' || liveBars) return;
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
  }, [mode, liveBars, localConnected]);

  /* ------------------------------------------------- 会话：消息 / 关注 */

  useEffect(() => {
    if (!board?.user.id) return;
    let alive = true;
    const loadInbox = async () => {
      try {
        const r = await api<{ items: ShareRow[] }>('/api/reviews/inbox');
        if (alive) setInbox(r.items);
      } catch {
        /* 下一轮再试 */
      }
    };
    void loadInbox();
    const loadProfile = () => {
      void api<{ following: Array<{ id: string; name: string }>; incoming?: any[]; outgoing?: any[] }>('/api/profile')
        .then((r) => {
          if (!alive) return;
          setFollowing(r.following);
          setFriendReq({ incoming: r.incoming ?? [], outgoing: r.outgoing ?? [] });
        })
        .catch(() => undefined);
    };
    loadProfile();
    const profileTimer = window.setInterval(loadProfile, 15000);
    // 分享是社交入口：交易台开着时也要能看到新消息，不能只在刷新页面时更新。
    const timer = window.setInterval(loadInbox, 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') void loadInbox(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.clearInterval(profileTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [board?.user.id]);

  /** 打开「消息」就把未读标成已读：角标和小铃不再闪，下次刷新也不会再算未读。 */
  useEffect(() => {
    if (tab !== 'inbox') return;
    const unread = inbox.filter((row) => !row.seen).map((row) => row.id);
    if (!unread.length) return;
    let alive = true;
    void Promise.all(unread.map((id) => api('/api/reviews/share/seen', { id }).catch(() => undefined))).then(() => {
      if (alive) setInbox((rows) => rows.map((row) => (unread.includes(row.id) ? { ...row, seen: true } : row)));
    });
    return () => {
      alive = false;
    };
  }, [tab, inbox]);

  /* 聊天没有服务端 seen：用本机「最后阅读时间」算未读，至少别让信封只统计分享。 */
  useEffect(() => {
    if (!board) return;
    const latest = (board.messages || []).reduce((n, row) => Math.max(n, row.created || 0), 0);
    if (!latest) return;
    if (!chatReadAt) {
      setChatReadAt(latest);
      try { localStorage.setItem('sn-chat-read', String(latest)); } catch { /* 忽略 */ }
      return;
    }
    if (tab === 'inbox' && latest > chatReadAt) {
      setChatReadAt(latest);
      try { localStorage.setItem('sn-chat-read', String(latest)); } catch { /* 忽略 */ }
    }
  }, [board, tab, chatReadAt]);

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

  /** 笔记是否改过还没保存：切换交易/离开前用它拦一下。 */
  const noteDirty = () => Boolean(
    entry
    && !entry.read_only
    && (note.body !== (entry.note?.body || '')
      || JSON.stringify(note.tags) !== JSON.stringify(entry.note?.tags || [])),
  );

  const confirmLeaveNote = () => !noteDirty() || window.confirm('这笔交易的笔记还没保存，确定要离开吗？');

  const writeUrl = (nextMode: 'review' | 'live', nextTarget = target, nextShare = shareId) => {
    const qs = new URLSearchParams(location.search);
    qs.set('view', nextMode);
    if (nextMode === 'live') {
      qs.delete('share');
      qs.delete('person');
      qs.delete('ticket');
      qs.delete('t');
    } else if (nextShare != null) {
      qs.delete('person');
      qs.delete('ticket');
      qs.delete('t');
      qs.set('share', String(nextShare));
    } else if (nextTarget) {
      qs.delete('share');
      qs.set('person', nextTarget.person);
      qs.set('ticket', nextTarget.ticket);
      if (nextTarget.t) qs.set('t', String(nextTarget.t));
      else qs.delete('t');
    } else {
      qs.delete('share');
      qs.delete('person');
      qs.delete('ticket');
      qs.delete('t');
    }
    history.replaceState(null, '', '/chart?' + qs.toString());
  };

  const switchMode = (next: 'review' | 'live') => {
    if (next === 'review' && !target && shareId == null) {
      const mine = board ? latestTradeOf(board.snapshots[board.user.id]) : null;
      if (board && mine) {
        openTicket(board.user.id, String(mine.ticket));
        return;
      }
      setTab('review');
      setRailOpen(true);
      return;
    }
    if (next === 'review' && !confirmLeaveNote()) return;
    setMode(next);
    if (next === 'review') setTab('review');
    writeUrl(next);
  };

  const openTicket = (person: string, ticket: string, t?: number) => {
    if (!confirmLeaveNote()) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    chartRef.current?.flush();
    setEntry(null);
    setShareId(null);
    setTarget({ person, ticket, t });
    setMode('review');
    // 打开复盘时右栏直接切到「复盘」，不要停在「下单」。
    setTab('review');
    setRailOpen(true);
    setNote({ body: '', tags: [] });
    setNoteState('idle');
    setSaveState('idle');
    setShareState('');
    setMessage('');
    setRecipients(new Set());
    setFeedFilter('all');
    const qs = new URLSearchParams({ view: 'review', person, ticket });
    if (t) qs.set('t', String(t));
    history.replaceState(null, '', '/chart?' + qs.toString());
  };

  /** 打开一条消息里的复盘切片：还原分享人当时那个窗口（服务端按 share 存档回放）。 */
  const openShare = (row: ShareRow) => {
    if (!confirmLeaveNote()) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    chartRef.current?.flush();
    setEntry(null);
    setShareId(row.id);
    setTarget({ person: row.owner.id, ticket: row.ticket });
    setMode('review');
    setTab('review');
    setRailOpen(true);
    setNote({ body: '', tags: [] });
    setNoteState('idle');
    setSaveState('idle');
    setShareState('');
    setMessage('');
    setRecipients(new Set());
    history.replaceState(null, '', '/chart?view=review&share=' + row.id);
  };

  const saveNote = async () => {
    if (!entry || entry.read_only || !target) return;
    setNoteState('saving');
    try {
      await api('/api/journal', { ticket: target.ticket, body: note.body, tags: note.tags });
      setEntry((prev) => prev ? { ...prev, note: { body: note.body, tags: [...note.tags], updated: Date.now() / 1000 } } : prev);
      setNoteState('saved');
      window.setTimeout(() => setNoteState('idle'), 1600);
    } catch (err) {
      setNoteState('error');
      setError(err instanceof Error ? err.message : '笔记保存失败');
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
      // 分享 = 一条带切片的富文本消息：此刻激活格子的周期、可见窗口中点、画线坐标。
      const snapshot = chartRef.current?.view?.() ?? null;
      await api('/api/reviews/share', { ticket: target.ticket, recipients: [...recipients], message, snapshot });
      setShareState('已发给 ' + recipients.size + ' 位好友' + (snapshot ? '（含当前复盘切片）' : ''));
      setRecipients(new Set());
      setMessage('');
    } catch (err) {
      setShareState(err instanceof Error ? err.message : '发送失败');
    }
  };

  /** 通过 / 拒绝好友申请：处理完把面板和看板一起刷新。 */
  const answerRequest = async (id: string, action: 'accept' | 'reject') => {
    try {
      await api('/api/friends/' + action, { target: id });
      const r = await api<{ following?: Array<{ id: string; name: string }>; incoming?: any[]; outgoing?: any[] }>('/api/profile');
      setFollowing(r.following ?? []);
      setFriendReq({ incoming: r.incoming ?? [], outgoing: r.outgoing ?? [] });
      setBoard(await api<Board>('/api/state?view=board'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
  const displayedAccount = localConnected ? local.account : mySnap?.data;
  const myHistory: any[] = mySnap?.data?.history ?? [];
  const myPositions: any[] = localConnected ? local.positions : mySnap?.data?.positions ?? [];
  const floating = myPositions.reduce((n: number, p: any) => n + (p.profit || 0), 0);
  const mt5Online = localConnected || Boolean(mySnap && board && board.now - (mySnap.updated || 0) <= 45 && mySnap.data.online !== false);
  const livePrice = localConnected
    ? (local.tick?.bid ? (local.tick.bid + local.tick.ask) / 2 : null)
    : (liveTick && liveTick.bid ? (liveTick.bid + liveTick.ask) / 2 : null);
  const reviewTrade = entry?.review.trade ?? {};
  const reviewPrice = Number(reviewTrade.close) || Number(reviewTrade.open) || barsClose(entry);
  // 复盘看的是这笔交易的平仓价；行情才看现价。两者不能混在一个裸数字里。
  const price = mode === 'review' ? reviewPrice : (livePrice ?? barsClose(entry));
  const priceLabel = mode === 'review' ? '平仓价' : '现价';
  const reviewingOther = mode === 'review' && Boolean(target?.person && target.person !== me?.id);
  const liveAnchor = (() => {
    const rows = liveBars?.M1 ?? [];
    const last = rows[rows.length - 1];
    return last ? last[0] * 1000 : Date.now();
  })();
  /** 行情页的数据源：优先本机/云端的实时推送，没有就用自己券商轨的历史 K 线。 */
  // 服务端 K 线是券商墙钟、交易/复盘时间戳是 UTC：标注按这个差对齐，否则开平仓点会偏。
  const serverOffsetSec = typeof entry?.bar_offset === 'number'
    ? entry.bar_offset
    : (Math.round(Number(entry?.review?.trade?.closed_server ?? NaN) - Number(entry?.review?.trade?.closed ?? NaN)) || 0);
  // 服务端出库时已把 bars 的券商墙钟换成 UTC，前端不再需要偏移。
  // 快照通道的旧交易没有 `review.opened`，只有 `opened_server`：用墙钟减去偏移折算成 UTC，
  // 否则整笔复盘会定位到平仓时间上去（实测 #43442851 就是这样）。
  const openedSeconds = entry?.review?.opened
    ?? (typeof entry?.review?.trade?.opened_server === 'number' ? entry.review.trade.opened_server - serverOffsetSec : null);
  const liveSeries = liveBars ?? marketSeries;
  const marketAnchorMs = (() => {
    const rows = marketSeries?.M1 ?? [];
    const last = rows[rows.length - 1];
    return last ? last[0] * 1000 : Date.now();
  })();
  const availableTfs = useMemo(() => {
    if (mode === 'live') return TIMEFRAME_OPTIONS;
    const charts = entry?.review.charts ?? {};
    return TIMEFRAME_OPTIONS.filter((option) => {
      const base = charts[TIMEFRAMES[option.id].base];
      if (!base || base.length < 2) return false;
      if (option.id === '30' || option.id === '240') return base.length >= 4;
      if (option.id === '1D') return base.length >= 24;
      return true;
    });
  }, [entry, mode]);

  const ready = Boolean(
    entry && entry.review.status === 'ready' && Object.values(entry.review.charts || {}).some((bars) => (bars?.length ?? 0) > 1),
  );

  // 复盘图的数据源：先拿交易快照，再按锚点往两边抓该券商 source 的 bars（没覆盖的地方留白）。
  const [series, setSeries] = useState<ReviewCharts | null>(null);
  const anchorSeconds = entry?.share?.anchor_ms
    ? Math.round(entry.share.anchor_ms / 1000)
    : (entry?.review.opened ?? (entry?.review.trade?.closed as number | undefined) ?? null);
  useEffect(() => {
    setSeries(null);
    if (!entry || entry.review.status !== 'ready' || !ready) return;
    const payload = entry.review.charts || {};
    const anchor = anchorSeconds ?? Math.round(Date.now() / 1000);
    let alive = true;
    void (async () => {
      // 服务端已经把库里的券商墙钟换成 UTC（bars.to_utc），所以两套数据现在可以直接按
      // 时间戳合并：同一周期有 bars 就用 bars（更全），没有就留交易快照那一段。
      const merged: ReviewCharts = { ...payload };
      try {
        await Promise.all(REVIEW_BASE_TFS.map(async (tf) => {
          const [before, after] = REVIEW_WINDOW[tf];
          const params = new URLSearchParams({
            tf,
            from: String(Math.round(anchor - before * 86400)),
            to: String(Math.round(anchor + after * 86400)),
          });
          if (shareId != null) params.set('share', String(shareId));
          else if (target?.person && target?.ticket) {
            params.set('person', target.person);
            params.set('ticket', target.ticket);
          } else return;
          const data = await api<{ bars: number[][] }>('/api/chart/bars?' + params.toString());
          if (!data?.bars?.length) return;
          if (!payload[tf]?.length) {
            merged[tf] = data.bars;
            return;
          }
          const byTime = new Map<number, number[]>();
          for (const bar of payload[tf]) byTime.set(bar[0], bar);
          for (const bar of data.bars) byTime.set(bar[0], bar);
          merged[tf] = [...byTime.values()].sort((a, b) => a[0] - b[0]);
        }));
      } catch {
        /* 拿不到就退回交易快照，不阻塞看图 */
      }
      if (alive) setSeries(merged);
    })();
    return () => {
      alive = false;
    };
  }, [entry, ready, shareId, target?.person, target?.ticket, anchorSeconds]);

  /* ------------------------------------------------- 拖动补段 / 远处删段 */

  ctxRef.current = {
    shareId,
    person: target?.person,
    ticket: target?.ticket,
    symbol: mode === 'live' ? liveSymbol : (entry?.review?.trade?.symbol || 'XAUUSD'),
  };

  const hydrateWindow = (tf: string, bars: number[][]) => {
    if (!bars.length) return;
    seriesRef.current[tf] = bars;
    windowRef.current[tf] = { from: bars[0][0] * 1000, to: bars[bars.length - 1][0] * 1000 };
  };

  useEffect(() => {
    if (!series) return;
    for (const tf of REVIEW_BASE_TFS) hydrateWindow(tf, series[tf] ?? []);
  }, [series]);

  useEffect(() => {
    if (!marketSeries) return;
    for (const tf of REVIEW_BASE_TFS) hydrateWindow(tf, marketSeries[tf] ?? []);
  }, [marketSeries]);

  const loadWindow = useCallback(async (base: string, from: number, to: number, span: number, cellId?: string) => {
    // 只有整屏都在用 bars 表（券商墙钟）时才允许按需补段：
    // 交易快照那一屏是固定窗口，补进来的 bars 是另一种时间基，混进去会错位。
    if (fetchingRef.current.has(base)) return;
    fetchingRef.current.add(base);
    try {
      const ctx = ctxRef.current;
      const params = new URLSearchParams({
        tf: base,
        from: String(Math.floor((from - span) / 1000)),
        to: String(Math.floor((to + span) / 1000)),
      });
      let path: string;
      if (ctx.shareId != null) {
        params.set('share', String(ctx.shareId));
        path = '/api/chart/bars?';
      } else if (ctx.person && ctx.ticket) {
        params.set('person', ctx.person);
        params.set('ticket', ctx.ticket);
        path = '/api/chart/bars?';
      } else {
        params.set('symbol', ctx.symbol);
        path = '/api/market/bars?';
      }
      const data = await api<{ bars: number[][] }>(path + params.toString());
      if (!data?.bars?.length) return;
      // 合并同周期已加载的 K 线，再把整段推回图表（保持视窗）。
      const byTime = new Map<number, number[]>();
      for (const bar of seriesRef.current[base] ?? []) byTime.set(bar[0], bar);
      for (const bar of data.bars) byTime.set(bar[0], bar);
      const merged = [...byTime.values()].sort((a, b) => a[0] - b[0]);
      if (merged.length === (seriesRef.current[base]?.length ?? 0)) {
        // 这一段服务端也没有更多数据：两边都先别再问，等有新增（或 60 秒后）再说。
        const until = Date.now() + 60_000;
        edgeBlockRef.current[base + ':left'] = until;
        edgeBlockRef.current[base + ':right'] = until;
        return;
      }
      seriesRef.current[base] = merged;
      windowRef.current[base] = { from: merged[0][0] * 1000, to: merged[merged.length - 1][0] * 1000 };
      chartRef.current?.applySeries(base as BaseTimeframe, merged, cellId);
    } catch {
      /* 补不到就留白，不拿别的来源顶 */
    } finally {
      fetchingRef.current.delete(base);
    }
  }, []);

  const handleViewport = useCallback((info: { cellId: string; timeframe: string; from: number; to: number }) => {
    const recipe = TIMEFRAMES[info.timeframe];
    if (!recipe) return;
    const base = recipe.base;
    const loaded = windowRef.current[base];
    if (!loaded) return;
    const span = Math.max(60_000, info.to - info.from);
    // 离边缘不到一格屏就去补；离得超过 5 屏才删（避免来回抖动时反复增删）。
    const nearEdge = span * (base === 'H1' ? 1.5 : 0.75);
    const keep = span * 5;
    const blocked = (side: string) => (edgeBlockRef.current[base + ':' + side] ?? 0) > Date.now();
    const needLeft = info.from - loaded.from < nearEdge && !blocked('left');
    const needRight = loaded.to - info.to < nearEdge && !blocked('right');
    if (needLeft || needRight) {
      void loadWindow(base, info.from, info.to, span, info.cellId);
    }
    const bars = seriesRef.current[base] ?? [];
    if (bars.length > 12_000) {
      const trimmed = bars.filter((bar) => bar[0] * 1000 >= info.from - keep && bar[0] * 1000 <= info.to + keep);
      if (trimmed.length > 200 && trimmed.length < bars.length) {
        seriesRef.current[base] = trimmed;
        windowRef.current[base] = { from: trimmed[0][0] * 1000, to: trimmed[trimmed.length - 1][0] * 1000 };
        chartRef.current?.applySeries(base as BaseTimeframe, trimmed, info.cellId);
      }
    }
  }, [loadWindow]);

  const myChats = useMemo(
    () => (board?.messages ?? []).filter((row) => row.person !== me?.id),
    [board?.messages, me?.id],
  );
  const unseenShares = inbox.filter((row) => !row.seen).length;
  const unseenChat = myChats.filter((row) => (row.created || 0) > chatReadAt).length;
  const unseen = unseenShares + unseenChat;
  /** 消息页把「留言」和「复盘分享」合成一条时间线：分享就是一条带切片的消息。 */
  const feed = useMemo<Array<{ kind: 'share'; row: ShareRow } | { kind: 'chat'; row: Board['messages'][number] }>>(() => {
    const shares = inbox.map((row) => ({ kind: 'share' as const, row }));
    const chats = (board?.messages ?? []).map((row) => ({ kind: 'chat' as const, row }));
    let all: Array<{ kind: 'share'; row: ShareRow } | { kind: 'chat'; row: Board['messages'][number] }> =
      [...shares, ...chats].sort((a, b) => b.row.created - a.row.created);
    if (feedFilter === 'share') all = all.filter((item) => item.kind === 'share');
    if (feedFilter === 'chat') all = all.filter((item) => item.kind === 'chat');
    if (feedFilter === 'unread') {
      all = all.filter((item) => item.kind === 'share' ? !item.row.seen : (item.row.created || 0) > chatReadAt);
    }
    return all.slice(0, feedLimit);
  }, [inbox, board?.messages, feedFilter, feedLimit, chatReadAt]);
  const feedHasMore = useMemo(() => {
    if (feedFilter === 'share') return inbox.length > feedLimit;
    if (feedFilter === 'chat') return (board?.messages?.length ?? 0) > feedLimit;
    if (feedFilter === 'unread') {
      const total = unseenShares + unseenChat;
      return total > feedLimit;
    }
    return (inbox.length + (board?.messages?.length ?? 0)) > feedLimit;
  }, [inbox.length, board?.messages?.length, feedFilter, feedLimit, unseenShares, unseenChat]);
  const trade = entry?.review.trade ?? {};
  const anchorMs = useMemo(() => {
    // 消息里的切片：分享人当时可见窗口中点，优先于开仓时间。
    const shared = entry?.share?.anchor_ms ?? null;
    if (shared && shared > 0) return shared;
    const opened = openedSeconds;
    const closed = trade?.closed ?? null;
    const seconds = target?.t ?? opened ?? closed ?? 0;
    // 图上是券商墙钟的 K 线，定位点也要跟着偏移，否则"居中"会偏到另一根上去。
    return seconds > 0 ? seconds * 1000 : 0;
  }, [entry, trade?.closed, target?.t, openedSeconds]);

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
        <div className="status-row" title={reviewingOther ? '我的账户；正在复盘的是别人的交易' : '我的账户'}>
          <span className="stat"><b className="stat-v">{mode === 'live' ? liveSymbol : trade.symbol || 'XAUUSD'}</b></span>
          <span className="sep" aria-hidden="true" />
          <span className="stat">
            <span className="stat-k">{priceLabel}</span>
            <b className={price != null ? 'stat-v' : 'stat-v dim'}>{price != null ? quotePrice(price) : '—'}</b>
          </span>
          <span className={`status-chip ${localConnected ? 'on' : mt5Online ? 'sync' : 'off'}`}>
            <i aria-hidden="true" />
            {localConnected ? '本机直连' : mt5Online ? '云端同步 · 只读' : 'MT5 未连接'}
          </span>
          <span className="sep" aria-hidden="true" />
          <span className="stat"><span className="stat-k">{reviewingOther ? '我的净值' : '净值'}</span><b className="stat-v">{money(displayedAccount?.equity)}</b></span>
          <span className="stat"><span className="stat-k">{reviewingOther ? '我的余额' : '余额'}</span><b className="stat-v">{money(displayedAccount?.balance)}</b></span>
          <span className="stat"><span className="stat-k">{reviewingOther ? '我的浮盈' : '浮盈'}</span><b className={floating >= 0 ? 'stat-v up' : 'stat-v down'}>{money(floating)}</b></span>
        </div>
        <nav className="top-actions">
          <button type="button" className="tool-btn" onClick={() => { setTab('trade'); setRailOpen(true); }}>本机 MT5</button>
          <a href="/history" target="_blank" rel="noopener noreferrer" title="新标签页打开，保留本机 EA 连接">交易日历 ↗</a>
          <SettingsMenu name={me?.nickname || '账户'} />
        </nav>
      </header>

      {/* ---------------------------------------------------------- 主体 */}
      <div className={`main ${railOpen ? '' : 'rail-closed'}`}>
        <section className="chart-pane">
          <div className="chart-toolbar">
            <LayoutMenu current={layout} onPick={(id) => { chartRef.current?.setLayout(id); setLayout(id); }} syncs={syncs} onToggleSync={toggleSync} />
            <TfMenu current={tf} options={availableTfs} scopeAll={Boolean(syncs.timeframe)} onPick={(id) => { chartRef.current?.setTimeframe(id); setTf(id); }} />
            <DrawingFavs
                favorites={favs}
              active={activeTool}
              onUse={(key) => {
                chartRef.current?.useTool(key);
                setActiveTool((prev) => (prev === key ? null : key));
              }}
            />
            <span className="mode-switch" role="group" aria-label="图表视图">
              <button type="button" className={`tool-btn ${mode === 'live' ? 'is-active' : ''}`} aria-pressed={mode === 'live'} onClick={() => switchMode('live')}>行情</button>
              <button type="button" className={`tool-btn ${mode === 'review' ? 'is-active' : ''}`} aria-pressed={mode === 'review'} disabled={!target && shareId == null && !myHistory.length} onClick={() => switchMode('review')}>复盘</button>
            </span>
            {mode === 'review' && (target || shareId != null) ? (
              <button type="button" className="tool-btn" onClick={() => chartRef.current?.focus()}>定位开仓</button>
            ) : null}
            {mode === 'live' && !liveBars && marketSeries ? (
              <span className="badge">历史行情{marketInfo?.last ? ' · 最新 ' + stamp(marketInfo.last) : ''}</span>
            ) : null}
            <span className="spacer" />
            <span className="save-hint" role="status" aria-live="polite">
              {saveState === 'saving' ? '保存画线…' : saveState === 'saved' ? '画线已保存' : saveState === 'error' ? '画线保存失败' : ''}
            </span>
          </div>

          {entry?.read_only ? (
            <div className="context-banner" role="status">
              <b>只读回放</b>
              <span>{entry.owner.name} 的复盘 · 画线与笔记不可修改</span>
              {myHistory.length ? <button type="button" className="link" onClick={() => openTicket(me!.id, String(myHistory[0].ticket))}>回到我的最近一笔</button> : null}
            </div>
          ) : null}

          <div className="chart-body">
            {mode === 'live' && liveSeries ? (
              <ChartWorkspace
                key={`live:${liveBars ? 'push' : 'store'}:${localConnected ? local.instance_id + ':' + local.epoch : 'cloud'}:${liveSymbol}`}
                ref={chartRef}
                charts={liveSeries}
                provider={liveBars ? liveProvider : undefined}
                providerName={liveBars ? 'live' : 'market'}
                symbol={liveSymbol}
                anchorMs={liveBars ? liveAnchor : marketAnchorMs}
                savedState={null}
                readOnly={false}
                timeframes={TIMEFRAME_OPTIONS.map((o) => o.id)}
              favorites={favs}
                onFavorites={saveFavorites}
                onTool={setActiveTool}
                onTimeframe={setTf}
                onLayout={setLayout}
                onSyncs={setSyncs}
                onError={setError}
                onViewport={handleViewport}
              />
            ) : mode === 'review' && ready && series ? (
              <ChartWorkspace
                key={shareId != null ? `share:${shareId}` : `${target?.person}:${target?.ticket}`}
                ref={chartRef}
                charts={series ?? entry!.review.charts}
                symbol={trade.symbol || 'XAUUSD'}
                anchorMs={anchorMs}
                savedState={entry!.chart?.document ?? null}
                tradeMarks={
                  entry!.review.opened != null && trade?.closed != null
                    ? {
                        openedAt: Number(openedSeconds ?? 0),
                        closedAt: Number(trade.closed),
                        open: Number(trade.open) || 0,
                        close: Number(trade.close) || 0,
                        side: trade.side === 'sell' ? 'sell' : 'buy',
                      }
                    : null
                }
                readOnly={entry!.read_only}
                timeframes={availableTfs.map((o) => o.id)}
                favorites={favs}
                onFavorites={saveFavorites}
                onTool={setActiveTool}
                onStateChange={onStateChange}
                onTimeframe={setTf}
                onLayout={setLayout}
                onSyncs={setSyncs}
                onError={setError}
                onViewport={handleViewport}
              />
            ) : (
              <div className="chart-empty">
                <p>
                  {mode === 'live'
                    ? (localConnected
                      ? (local.history_ready ? '本机历史暂不可用，请在 MT5 加载历史后重新连接' : '正在加载本机四周期 K 线…')
                      : '等待行情数据…')
                    : target
                      ? (entry?.review.status === 'pending' ? '等待 MT5 上传这笔交易的 K 线…' : entry?.review.error || '参考行情准备中…')
                      : '还没有可复盘的交易'}
                </p>
                <p className="dim">
                  {mode === 'live'
                    ? '连接本机 EA 看实时行情，或打开一笔历史复盘。'
                    : target
                      ? '同步完成后图表会自动出现。'
                      : '在 MT5 同步一笔成交，或从底部「历史」打开已有交易。'}
                </p>
                <div className="empty-actions">
                  {mode === 'review' && !target && myHistory[0] ? (
                    <button type="button" className="primary" onClick={() => openTicket(me!.id, String(myHistory[0].ticket))}>
                      打开最近一笔 #{String(myHistory[0].ticket)}
                    </button>
                  ) : null}
                  {!localConnected ? (
                    <button type="button" className="tool-btn" onClick={() => { setTab('trade'); setRailOpen(true); }}>连接本机 MT5</button>
                  ) : null}
                  <a className="tool-btn" href="/local-ea" target="_blank" rel="noopener noreferrer">安装与同步说明 ↗</a>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------ 右栏 */}
        <aside className={railOpen ? "rail" : "rail is-collapsed"}>
            <div className="rail-icons">
              {([
                { key: 'review', label: '复盘', Icon: ReviewIcon },
                { key: 'trade', label: '交易', Icon: TradeIcon },
                { key: 'inbox', label: '消息', Icon: MailIcon },
                { key: 'friends', label: '好友', Icon: FriendsIcon },
              ] as Array<{ key: Tab; label: string; Icon: typeof TradeIcon }>).map(({ key, label, Icon }) => {
                const fresh = key === 'inbox' && unseen > 0;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`${tab === key ? 'is-active' : ''} ${fresh ? 'has-new' : ''}`.trim()}
                    title={fresh ? `${label}（${unseen} 条未读）` : label}
                    aria-label={fresh ? `${label}，${unseen} 条未读` : label}
                    aria-current={tab === key ? 'page' : undefined}
                    onClick={() => {
                      const same = tab === key && railOpen;
                      if (same) { setRailOpen(false); return; }
                      if (key === 'review') { switchMode('review'); setRailOpen(true); return; }
                      setTab(key);
                      setRailOpen(true);
                    }}
                  >
                    <Icon />
                    <span className="rail-label">{label}</span>
                    {fresh ? <i className="dot">{unseen}</i> : null}
                  </button>
                );
              })}
            </div>

            <div className="rail-body">
              {tab === 'trade' ? (
                <div className="pane">
                  <LocalTradePanel state={local} />
                  {/* 本机连接时 LocalTradePanel 已经显示实时账户/持仓；这里只补云端快照，避免同屏两份。 */}
                  {!localConnected ? (
                    <>
                      <h3>云端账户 <small>快照</small></h3>
                      <div className="kv">
                        <span>净值</span><b>{money(displayedAccount?.equity)}</b>
                        <span>余额</span><b>{money(displayedAccount?.balance)}</b>
                        <span>浮盈</span><b className={floating >= 0 ? 'up' : 'down'}>{money(floating)}</b>
                      </div>
                      <h3>云端持仓 <small>{myPositions.length}</small></h3>
                      {myPositions.length ? (
                        <table className="mini">
                          <thead><tr><th>品种</th><th>方向</th><th>手数</th><th>开仓</th><th>浮盈</th></tr></thead>
                          <tbody>
                            {myPositions.map((p) => (
                              <tr key={p.ticket}>
                                <td>{p.symbol}</td>
                                <td className={sideClass(p.side)}>{sideText(p.side)}</td>
                                <td>{p.volume}</td>
                                <td>{money(p.price_open ?? p.open)}</td>
                                <td className={(p.profit || 0) >= 0 ? 'up' : 'down'}>{money(p.profit)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : <p className="dim">没有持仓</p>}
                      <p className="dim">连接本机 EA 后，这里换成实时账户、持仓和下单。</p>
                    </>
                  ) : null}

                  {/* 成交历史统一放在底部「历史」页签里，右栏不再重复列一遍。 */}
                  <p className="dim">成交历史在底部「历史」页签，点「复盘 / 未复盘」直接打开对应 K 线。</p>
                </div>
              ) : null}

              {tab === 'inbox' ? (
                <div className="pane chat-pane">
                  <h3>
                    消息
                    <small>{inbox.length} 条分享 · {myChats.length} 条留言{unseen ? ` · ${unseen} 未读` : ''}</small>
                  </h3>
                  <div className="chat-filters" role="group" aria-label="消息筛选">
                    {([
                      ['all', '全部'],
                      ['share', '复盘'],
                      ['chat', '留言'],
                      ['unread', '未读'],
                    ] as Array<['all' | 'share' | 'chat' | 'unread', string]>).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={`chip ${feedFilter === id ? 'is-on' : ''}`}
                        aria-pressed={feedFilter === id}
                        onClick={() => setFeedFilter(id)}
                      >
                        {label}{id === 'unread' && unseen ? ` ${unseen}` : ''}
                      </button>
                    ))}
                  </div>
                  <div className="chat-log">
                    {feed.length ? feed.map((item, index) => {
                      const day = stamp(item.row.created).slice(0, 10);
                      const prevDay = index > 0 ? stamp(feed[index - 1]!.row.created).slice(0, 10) : '';
                      return (
                        <div className="feed-group" key={(item.kind === 'share' ? 's' : 'c') + item.row.id}>
                          {day !== prevDay ? <div className="feed-day">{day}</div> : null}
                          {item.kind === 'share' ? (
                            <button
                              type="button"
                              className={`msg share-msg ${item.row.seen ? '' : 'is-new'}`}
                              onClick={() => openShare(item.row)}
                            >
                              <div className="meta">
                                {item.row.owner.name} · {stamp(item.row.created)}
                                {item.row.seen ? null : <b className="share-unread">未读</b>}
                              </div>
                              <p className="share-title">
                                {item.row.trade?.symbol || 'XAUUSD'} {sideText(item.row.trade?.side || 'buy')}
                                {item.row.trade ? <span className={(item.row.trade.profit || 0) >= 0 ? 'up' : 'down'}> · 净盈亏 {money(item.row.trade.profit)}</span> : null}
                              </p>
                              {item.row.message ? <p>{item.row.message}</p> : null}
                              <span className="share-slice">
                                打开复盘切片
                                {item.row.timeframe ? ` · ${item.row.timeframe} 分钟图` : ''}
                                {item.row.anchor_ms ? ` · ${stamp(item.row.anchor_ms / 1000)}` : ''}
                              </span>
                            </button>
                          ) : (
                            <div className={`msg ${item.row.person === me?.id ? 'mine' : ''}`}>
                              <div className="meta">{item.row.name || item.row.person} · {stamp(item.row.created)}</div>
                              <p>{item.row.text}</p>
                            </div>
                          )}
                        </div>
                      );
                    }) : (
                      <p className="dim">
                        {feedFilter === 'unread'
                          ? '没有未读消息。'
                          : feedFilter === 'share'
                            ? '还没有复盘分享。在复盘里点「发给好友」，这里会出现带切片的卡片。'
                            : feedFilter === 'chat'
                              ? '还没有留言。'
                              : '还没有消息。'}
                      </p>
                    )}
                    {feedHasMore ? (
                      <button type="button" className="tool-btn feed-more" onClick={() => setFeedLimit((n) => n + 80)}>加载更早的消息</button>
                    ) : null}
                    <div ref={chatEnd} />
                  </div>
                  <p className="chat-hint">留言只在你和好友之间可见；复盘分享也只会发给好友。</p>
                  <div className="chat-form">
                    <textarea value={chat} maxLength={1000} rows={2} placeholder="说点什么…（Enter 发送，Shift+Enter 换行）" onChange={(e) => setChat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat(); } }} />
                    <button type="button" className="primary" onClick={() => void sendChat()} disabled={!chat.trim()}>发送</button>
                  </div>
                </div>
              ) : null}

              {tab === 'friends' ? (
                <div className="pane">
                  <h3>好友 <small>{Math.max(0, board.members.length - 1)}</small></h3>
                  {friendReq.incoming.length ? (
                    <div className="friend-requests">
                      <p className="dim">好友申请 · {friendReq.incoming.length}</p>
                      {friendReq.incoming.map((row) => (
                        <div className="friend-request" key={row.id}>
                          <b>{row.nickname}</b>
                          <small className="dim">@{row.username}</small>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void answerRequest(row.id, 'accept')}
                          >
                            通过
                          </button>
                          <button type="button" onClick={() => void answerRequest(row.id, 'reject')}>
                            拒绝
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {friendReq.outgoing.length ? (
                    <p className="dim">
                      已申请：{friendReq.outgoing.map((row) => row.nickname).join('、')}（等待对方通过）
                    </p>
                  ) : null}
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
                          rows.length ? (
                            <>
                              <TradeList
                                rows={rows.slice(0, 5)}
                                reviewed={member.reviewed}
                                canReview={member.can_review !== false}
                                onPick={(row) => openTicket(member.id, String(row.ticket))}
                              />
                              <a className="link friend-all" href={`/history?person=${encodeURIComponent(member.id)}`} target="_blank" rel="noopener noreferrer">
                                查看全部 {rows.length} 笔交易 ↗
                              </a>
                            </>
                          ) : <p className="dim">暂无可查看的成交</p>
                        ) : <p className="dim">对方未开放交易数据</p>}
                        {member.can_view && member.can_review === false ? <p className="dim">对方只开放成交，没有开放复盘。</p> : null}
                      </div>
                    );
                  })}
                  {board.members.length <= 1 ? <p className="dim">还没有好友。去个人中心搜索交易伙伴，发送好友申请；对方通过后就能互相看到复盘。</p> : null}
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
                        <>
                          {noteDirty() ? <p className="note-dirty" role="status">笔记有未保存的修改</p> : null}
                          <button type="button" className="primary" onClick={() => void saveNote()} disabled={noteState === 'saving'}>
                            {noteState === 'saving' ? '保存中…' : noteState === 'saved' ? '已保存' : '保存笔记'}
                          </button>
                        </>
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
                  ) : target ? <p className="dim">正在加载这笔复盘…</p> : (
                    <div className="rail-empty">
                      <p className="dim">还没有打开复盘。可以从底部「历史」选一笔成交，或直接打开最近一笔。</p>
                      {myHistory[0] ? (
                        <button type="button" className="primary" onClick={() => openTicket(me!.id, String(myHistory[0].ticket))}>
                          打开最近一笔 #{String(myHistory[0].ticket)}
                        </button>
                      ) : null}
                      <a className="link" href="/local-ea" target="_blank" rel="noopener noreferrer">如何把 MT5 成交同步进来 ↗</a>
                    </div>
                  )}
                </div>
              ) : null}

            </div>
        </aside>
      </div>

      {/* ---------------------------------------------------------- 底栏 */}
      <BottomDock
        connected={localConnected}
        localPositions={local.positions}
        localOrders={local.orders}
        cloudPositions={myPositions}
        history={myHistory}
        reviewed={board?.reviewed}
        onReview={(ticket) => openTicket(me!.id, ticket)}
        tracksSlot={mode === 'review' && (target || shareId != null) ? (
          <TrackStrip
            person={target?.person}
            ticket={target?.ticket}
            shareId={shareId}
            from={anchorMs - 3 * 86400000}
            to={anchorMs + 86400000}
            refreshKey={entry?.chart?.updated ?? 0}
            headless
          />
        ) : null}
      />

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

      {error ? (
        <div className="toast" role="alert" aria-live="assertive">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="关闭错误提示">×</button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 子组件 */

function nameOf(board: Board, person: string): string {
  return board.members.find((m) => m.id === person)?.name || person;
}

function TradeList({ rows, reviewed, canReview = true, onPick }: { rows: any[]; reviewed?: string[]; canReview?: boolean; onPick: (row: any) => void }) {
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
            <td>
              {!canReview ? (
                <span className="dim">未分享复盘</span>
              ) : reviewed?.includes(String(row.ticket)) ? (
                <button type="button" className="link done" onClick={() => onPick(row)}>已复盘</button>
              ) : (
                <button type="button" className="link todo" onClick={() => onPick(row)}>未复盘</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
