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
import { ChatDock } from './ChatDock';
import { ReviewShareDialog } from './ReviewShareDialog';
import { FriendsIcon, ReviewIcon, TradeIcon } from './ui/icons';
import { DEFAULT_FAVORITES } from './vela/drawingTools';
import { localTerminal, useLocalTerminal } from './localTerminal';
import { localHistorySync } from './localHistorySync';
import { backfillBars, useBackfillBars } from './backfillBars';

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
  user: { id: string; nickname: string; username: string; avatar: string; onboarding_step: number; auto_history_sync?: boolean };
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

/** 周期秒数：用于判断 tick 是否落在当前（最新）那根 K 线窗口内。 */
const TF_SECONDS: Record<'M1' | 'M5' | 'M15' | 'H1', number> = { M1: 60, M5: 300, M15: 900, H1: 3600 };

/**
 * 用一笔 tick 的中间价,把每个周期最新那根蜡烛的 close/high/low 更新到当前价,
 * 让蜡烛在两次 EA `bar` 推送之间也随 tick 实时伸缩(视觉插值,非无损存档)。
 * 只改落在该 bar 周期窗口内的最新一根;改的是浅拷贝,不污染 local.bars 的原数组。
 */
function applyTickToBars(charts: ReviewCharts, tick: { bid: number; ask: number; time: number } | null): ReviewCharts {
  if (!tick || !Number.isFinite(tick.bid) || !Number.isFinite(tick.ask)) return charts;
  const mid = (tick.bid + tick.ask) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return charts;
  const out: ReviewCharts = { ...charts };
  for (const key of Object.keys(TF_SECONDS) as Array<keyof typeof TF_SECONDS>) {
    const rows = charts[key];
    if (!rows || !rows.length) continue;
    const last = rows[rows.length - 1];
    if (!Array.isArray(last) || last.length < 5) continue;
    const seconds = TF_SECONDS[key];
    // tick 必须落在最新这根的周期窗口内,否则是下一根开始,交给 EA 的 bar 推送开新蜡烛。
    if (tick.time < last[0] || tick.time >= last[0] + seconds) continue;
    const patched = [...last];
    patched[4] = mid;                       // close = 当前中间价
    patched[2] = Math.max(patched[2], mid); // high
    patched[3] = Math.min(patched[3], mid); // low
    out[key] = [...rows.slice(0, -1), patched];
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
  const backfill = useBackfillBars();
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
  // 好友申请：别人申请我的（可通过对）/ 我申请的（可取消）。
  const [friendManager, setFriendManager] = useState(false);
  const [dmUnread, setDmUnread] = useState<Record<string, number>>({});
  const [groupUnread, setGroupUnread] = useState(0);
  const [chatGroup, setChatGroup] = useState<{ id: string; name: string; avatar?: string } | null>(null);
  const [friendReq, setFriendReq] = useState<{ incoming: Array<{ id: string; nickname: string; username: string }>; outgoing: Array<{ id: string; nickname: string; username: string }> }>({ incoming: [], outgoing: [] });
  const [shareRequest, setShareRequest] = useState<{ ticket: string; snapshot: unknown; initialRecipient?: { kind: 'dm' | 'group'; id: string } } | null>(null);
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
  /** 有新 K 线时是否自动滚动到最新：默认关，让蜡烛在画面里自然生长。 */
  const [autoScroll, setAutoScroll] = useState(() => {
    try { return localStorage.getItem('sn-autoscroll') === '1'; } catch { return false; }
  });
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  /** 图上画的是哪套数据：server = bars 表（券商墙钟），utc = 交易快照（journal.review 已转 UTC）。 */

  /** 没有本机推送时的兜底：用自己那条券商轨的最新历史 K 线，别让「行情」页空着。 */
  const [marketSeries, setMarketSeries] = useState<ReviewCharts | null>(null);
  const [marketInfo, setMarketInfo] = useState<{ server: string; last: number | null } | null>(null);
  const liveRef = useRef<ReviewCharts>({});
  const liveListeners = useRef(new Set<() => void>());
  const liveSymbol = localConnected ? local.symbol : 'XAUUSD';
  // 实时数据新鲜度：各周期最后一根的时间。某个周期明显落后（>3 根）时在标签上提示，
  // 否则用户会以为"十字线没同步"，其实是那一格的数据停在了更早的位置。
  const liveLag = useMemo(() => {
    if (!liveBars) return { stale: [] as string[], latest: null as number | null };
    const entries = Object.entries(liveBars) as Array<[string, number[][]]>;
    const last: Array<{ tf: string; time: number; sec: number }> = [];
    for (const [tf, rows] of entries) {
      const row = rows?.[rows.length - 1];
      const sec = TIMEFRAMES[tf as BaseTimeframe]?.seconds ?? 0;
      if (Array.isArray(row) && Number.isFinite(row[0]) && sec) last.push({ tf, time: row[0], sec });
    }
    if (!last.length) return { stale: [] as string[], latest: null as number | null };
    const latest = Math.max(...last.map((row) => row.time));
    const stale = last.filter((row) => latest - row.time > row.sec * 3).map((row) => row.tf);
    return { stale, latest };
  }, [liveBars]);
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
    // 新 K 线不该把画面推走：先记下每格可见范围，合并后再恢复（自动滚动关闭时）。
    const keepRanges = autoScrollRef.current ? null : chartRef.current?.captureRanges();
    const beforeLast: Record<string, number> = {};
    for (const [key, rows] of Object.entries(liveRef.current)) {
      const last = rows?.[rows.length - 1];
      if (last) beforeLast[key] = last[0];
    }
    // tick 变化也进这里:把最新报价插值进当前蜡烛,蜡烛在两次 EA bar 推送之间随 tick 伸缩。
    const incoming = applyTickToBars(toChartBars(local.bars), local.tick);
    Object.assign(liveRef.current, incoming);
    if (local.history_ready && Object.keys(incoming).length) setLiveBars(liveRef.current);
    for (const listener of liveListeners.current) listener();
    if (!keepRanges) return;
    const grew = Object.entries(liveRef.current).some(([key, rows]) => {
      const last = rows?.[rows.length - 1];
      const prev = beforeLast[key];
      return Boolean(last && prev !== undefined && last[0] > prev);
    });
    if (!grew) return;
    // 只冻结"已经往回翻"的格子：可见右端比最新一根落后超过 8 根，才把范围拉回去；
    // 停在最新时保持自然生长，新蜡烛照常出现在右侧。
    const frozen: Record<string, { from: number; to: number }> = {};
    for (const [id, range] of Object.entries(keepRanges)) {
      const rows = liveRef.current[range.base];
      const newest = rows?.[rows.length - 1]?.[0];
      const tfSec = TIMEFRAMES[range.base]?.seconds ?? 60;
      if (!newest) continue;
      if (range.to < (newest - 8 * tfSec) * 1000) frozen[id] = { from: range.from, to: range.to };
    }
    if (Object.keys(frozen).length) requestAnimationFrame(() => chartRef.current?.restoreRanges(frozen));
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
    backfillBars.bindUser(board?.user.id || '');
  }, [board?.user.id]);

  // 连上 EA + 图表就绪 → 自动进入行情回填首填(阻塞式初始化,只锁读轨道功能)。
  // coverage 已满会很快到 ready;同券商复用别人填过的数据,新用户几秒解锁。
  // error 态不在此自动重试(否则 error→initializing→error 无退避空转);重连会话变化会被
  // backfillBars 内部 stop 回 idle,那时再由本 effect 重启。
  useEffect(() => {
    if (!board?.user.id || !localConnected || !local.history_ready || !local.features.includes('history')) return;
    if (backfill.phase !== 'idle') return;
    void backfillBars.start();
  }, [board?.user.id, localConnected, local.history_ready, local.features, backfill.phase]);

  // 个人中心勾了「自动续传」后:连上 EA、图表就绪、且行情首填已完成(ready/partial_ready)才启动,
  // 避免与回填争用本机历史读通道(localTerminal 串行互斥)。已在同步中则不重复开。
  useEffect(() => {
    if (!board?.user.auto_history_sync || !localConnected || !local.history_ready) return;
    if (!local.features.includes('history')) return;
    if (backfill.phase !== 'ready' && backfill.phase !== 'partial_ready') return;
    if (localHistorySync.getSnapshot().enabled) return;
    void localHistorySync.start().catch(() => undefined);
  }, [board?.user.auto_history_sync, localConnected, local.history_ready, local.features, backfill.phase]);

  useEffect(() => {
    const pause = () => { localHistorySync.stop('网页已关闭，笔记同步已暂停。'); backfillBars.stop('网页已关闭，行情回填已暂停。'); };
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

  // 邀请链接沿用旧地址，入群后直接进入聊天中的对应群会话。
  useEffect(() => {
    const code = params.get('group');
    if (!code || !board?.user.id) return;
    void api<{ id: string; name: string; avatar?: string }>('/api/groups/join', { code })
      .then((group) => {
        setChatGroup(group);
        setTab('friends');
        setFriendManager(false);
        setRailOpen(true);
        const next = new URLSearchParams(location.search);
        next.delete('group');
        history.replaceState(null, '', location.pathname + (next.toString() ? '?' + next.toString() : ''));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [board?.user.id]);

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
      void api<{ incoming?: any[]; outgoing?: any[] }>('/api/profile')
        .then((r) => {
          if (!alive) return;
          setFriendReq({ incoming: r.incoming ?? [], outgoing: r.outgoing ?? [] });
          void api<{ unread: Record<string, number> | number; threads: Array<{ peer: { id: string }; unread: number }> }>('/api/dm/threads')
            .then((dm) => {
              const map: Record<string, number> = {};
              for (const row of dm.threads ?? []) if (row.unread) map[row.peer.id] = row.unread;
              if (!alive) return;
              setDmUnread(map);
              void api<{ groups: Array<{ unread: number; mentions: number }> }>('/api/groups')
                .then((gs) => { if (alive) setGroupUnread((gs.groups ?? []).reduce((n, g) => n + (g.unread || 0), 0)); })
                .catch(() => undefined);
            })
            .catch(() => undefined);
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
    setShareRequest(null);
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
    setShareRequest(null);
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

  const openReviewShare = (initialRecipient?: { kind: 'dm' | 'group'; id: string }) => {
    if (!entry || entry.read_only || !target) return;
    setShareRequest({ ticket: target.ticket, snapshot: chartRef.current?.view?.() ?? null, initialRecipient });
  };

  /** 通过 / 拒绝好友申请：处理完把面板和看板一起刷新。 */
  const answerRequest = async (id: string, action: 'accept' | 'reject') => {
    try {
      await api('/api/friends/' + action, { target: id });
      const r = await api<{ incoming?: any[]; outgoing?: any[] }>('/api/profile');
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

  /** 实时图分页：一个格子一个周期只允许一个在途请求；取到空/失败后冷却 5 分钟。 */
  const livePagingRef = useRef<Set<string>>(new Set());
  const liveFloorRef = useRef<Record<string, number>>({});
  const liveOlder = useCallback(async (base: BaseTimeframe) => {
    if (!localConnected || livePagingRef.current.has(base)) return;
    const rows = liveRef.current[base];
    if (!rows || rows.length < 10) return;
    if ((liveFloorRef.current[base] ?? 0) > Date.now()) return;
    const eaTf: Record<BaseTimeframe, string> = { M1: '1m', M5: '5m', M15: '15m', H1: '1h' };
    livePagingRef.current.add(base);
    try {
      const older = await localTerminal.loadOlderBars(eaTf[base], rows[0][0]);
      const seen = new Set(rows.map((row) => row[0]));
      const fresh = older.filter((row) => !seen.has(row[0]));
      if (!fresh.length) {
        liveFloorRef.current[base] = Date.now() + 5 * 60_000;
        return;
      }
      const merged = [...fresh, ...rows].sort((a, b) => a[0] - b[0]);
      liveRef.current[base] = merged.slice(-40000);
      if (local.history_ready) setLiveBars({ ...liveRef.current });
      for (const listener of liveListeners.current) listener();
    } catch {
      // 忙/超时只短暂退避；真空结果已在上面按 5 分钟冷却。
      liveFloorRef.current[base] = Date.now() + 60_000;
    } finally {
      livePagingRef.current.delete(base);
    }
  }, [localConnected, local.history_ready]);

  const handleViewport = useCallback((info: { cellId: string; timeframe: string; from: number; to: number }) => {
    const recipe = TIMEFRAMES[info.timeframe];
    if (!recipe) return;
    const base = recipe.base;
    const spanMs = Math.max(60_000, info.to - info.from);
    // 实时模式：翻到最左边就把更早的一段补进来（每次 ~1990 根）。
    if (mode === 'live' && localConnected) {
      const liveRows = liveRef.current[base];
      if (liveRows?.length) {
        const firstMs = liveRows[0][0] * 1000;
        if (info.from - firstMs < spanMs * 1.5) void liveOlder(base as BaseTimeframe);
      }
      return;
    }
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
  }, [loadWindow, mode, localConnected, liveOlder]);

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
        <div className="status-row" title={reviewingOther ? '正在复盘的是别人的交易；账户数字已隐藏，避免和对方混淆' : '我的账户'}>
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
          {reviewingOther ? null : (
            <>
              <span className="sep account-stat" aria-hidden="true" />
              <span className="stat account-stat"><span className="stat-k">净值</span><b className="stat-v">{money(displayedAccount?.equity)}</b></span>
              <span className="stat account-stat"><span className="stat-k">余额</span><b className="stat-v">{money(displayedAccount?.balance)}</b></span>
              <span className="stat account-stat"><span className="stat-k">浮盈</span><b className={floating >= 0 ? 'stat-v up' : 'stat-v down'}>{money(floating)}</b></span>
            </>
          )}
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
            <button
              type="button"
              className={`tool-btn autoscroll-toggle ${autoScroll ? 'is-active' : ''}`.trim()}
              title={autoScroll ? '新 K 线出现时自动滚动到最新（点击关闭）' : '新 K 线出现时保持当前画面，不自动滚动（点击开启自动滚动）'}
              aria-pressed={autoScroll}
              onClick={() => {
                const next = !autoScroll;
                setAutoScroll(next);
                try { localStorage.setItem('sn-autoscroll', next ? '1' : '0'); } catch { /* ignore */ }
              }}
            >
              自动滚动
            </button>
            {/* 数据源标签：避免把"复盘回放"当成实时行情。 */}
            <span
              className={`data-chip ${mode === 'live' ? (liveBars ? (liveLag.stale.length ? 'is-wait' : 'is-live') : 'is-wait') : 'is-review'}`}
              title={
                mode === 'live'
                  ? liveBars
                    ? `实时行情：来自本机 EA 推送，随 tick 更新${liveLag.latest ? `；最新一根 ${new Date(liveLag.latest * 1000).toLocaleString()}` : ''}`
                    : '实时行情未就绪：本机 EA 还没推送 K 线，当前显示的是服务器历史行情'
                  : '复盘回放：这是那笔交易发生时的历史切片，不是实时行情'
              }
            >
              {mode === 'live'
                ? liveBars
                  ? liveLag.stale.length
                    ? `实时 K 线（${liveLag.stale.join(' / ')} 落后）`
                    : '实时 K 线'
                  : '历史行情（实时未就绪）'
                : '复盘回放 · 非实时'}
            </span>
            <span className="save-hint" role="status" aria-live="polite">
              {saveState === 'saving' ? '保存画线…' : saveState === 'saved' ? '画线已保存' : saveState === 'error' ? '画线保存失败' : ''}
            </span>
          </div>

          {backfill.locked ? (
            <div className="context-banner" role="status" aria-live="polite">
              <b>正在准备行情数据</b>
              <span>
                {backfill.message || '正在确保行情数据完整,复盘功能稍后可用…'}
                {backfill.segments ? ` · 已处理 ${backfill.segments} 段` : ''}
                {backfill.reachedServer ? ` · 已回溯到 ${new Date(backfill.reachedServer * 1000).toISOString().slice(0, 10)}` : ''}
              </span>
            </div>
          ) : entry?.read_only ? (
            <div className="context-banner" role="status">
              <b>只读回放</b>
              <span>{entry.owner.name} 的复盘 · 画线与笔记不可修改</span>
              {myHistory.length ? <button type="button" className="link" onClick={() => openTicket(me!.id, String(myHistory[0].ticket))}>回到我的最近一笔</button> : null}
            </div>
          ) : backfill.phase === 'partial_ready' ? (
            <div className="context-banner" role="status">
              <b>行情数据已就绪</b>
              <span>更早的历史需要在 MT5 加载后重新回填{backfill.flooredTfs.length ? `（周期 ${backfill.flooredTfs.join(' / ')} 已到可得边界）` : ''}。</span>
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
        <aside className={railOpen ? (tab === 'friends' ? "rail is-wide" : "rail") : "rail is-collapsed"}>
            <div className="rail-icons">
              {([
                { key: 'trade', label: '交易', Icon: TradeIcon },
                { key: 'review', label: '复盘', Icon: ReviewIcon },
                { key: 'friends', label: '聊天', Icon: FriendsIcon },
              ] as Array<{ key: Tab; label: string; Icon: typeof TradeIcon }>).map(({ key, label, Icon }) => {
                const badge = key === 'friends' ? Object.values(dmUnread).reduce((n, v) => n + v, 0) + groupUnread : 0;
                const fresh = badge > 0;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`${tab === key ? 'is-active' : ''} ${fresh ? 'has-new' : ''}`.trim()}
                    title={fresh ? `${label}（${badge} 条未读）` : label}
                    aria-label={fresh ? `${label}，${badge} 条未读` : label}
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
                    {fresh ? <i className="dot">{badge}</i> : null}
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

              {tab === 'friends' && friendManager ? (
                <div className="pane pane-wide">
                    <div className="friend-manager">
                      <button type="button" className="link" onClick={() => setFriendManager(false)}>
                        ← 返回聊天
                      </button>
                      <div className="friend-manager-head">
                        <h3>好友管理 <small>{Math.max(0, board.members.length - 1)}</small></h3>
                        <a className="tool-btn" href="/profile" target="_blank" rel="noopener noreferrer">搜索并添加好友 ↗</a>
                      </div>
                      {friendReq.incoming.length ? (
                        <div className="friend-requests">
                          <p className="dim">好友申请 · {friendReq.incoming.length}</p>
                          {friendReq.incoming.map((row) => (
                            <div className="friend-request" key={row.id}>
                              <b>{row.nickname}</b>
                              <small className="dim">@{row.username}</small>
                              <button type="button" className="primary" onClick={() => void answerRequest(row.id, 'accept')}>
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
                        <p className="dim">已申请：{friendReq.outgoing.map((row) => row.nickname).join('、')}（等待对方通过）</p>
                      ) : null}
                      <div className="friend-list">
                        {board.members.filter((m) => m.id !== me?.id).map((member) => {
                          const snap = board.snapshots[member.id];
                          const online = Boolean(snap && board.now - (snap.updated || 0) <= 45 && snap.data.online !== false);
                          return (
                            <div className="friend" key={member.id}>
                              <div className="friend-head">
                                <b>{member.name}</b>
                                <span className={online ? 'link-dot on' : 'link-dot off'}>{online ? '在线' : '离线'}</span>
                                {dmUnread[member.id] ? <span className="friend-badge">{dmUnread[member.id]}</span> : null}
                              </div>
                              <p className="dim">{member.can_view ? '交易数据已开放' : '对方未开放交易数据'}</p>
                            </div>
                          );
                        })}
                        {board.members.length <= 1 ? <p className="dim">还没有好友。去个人中心搜索交易伙伴，发送好友申请。</p> : null}
                      </div>
                    </div>
                </div>
              ) : null}

              <div className="pane pane-wide chat-host" hidden={tab !== 'friends' || friendManager}>
                <ChatDock
                  visible={railOpen && tab === 'friends' && !friendManager}
                  current={target?.ticket && target.person === me?.id && entry && !entry.read_only ? { ticket: target.ticket } : null}
                  onShareCurrent={openReviewShare}
                  onError={setError}
                  onOpenFriendManager={() => setFriendManager(true)}
                  openGroup={chatGroup}
                  onGroupOpened={() => setChatGroup(null)}
                />
              </div>

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

                      {!entry.read_only ? <button type="button" className="tool-btn review-share-trigger" onClick={() => openReviewShare()}>分享复盘给好友或群聊</button> : null}
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

      {shareRequest && <ReviewShareDialog {...shareRequest} onClose={() => setShareRequest(null)} />}
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

