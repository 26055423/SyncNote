import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, money, stamp } from './api';
import { ChartWorkspace, TIMEFRAME_OPTIONS, type ChartHandle, type SyncKind } from './vela/ChartWorkspace';
import { BarReplayControls } from './BarReplayControls';
import { FullscreenButton } from './ChartToolsMenu';
import { LayoutMenu } from './vela/LayoutMenu';
import { TfMenu } from './vela/TfMenu';
import { LiveProvider, TIMEFRAMES, type BaseTimeframe, type ReviewCharts } from './vela/provider';
import { BASE_SECONDS as TF_SECONDS, mergeLiveHistory, prependLiveHistory } from './liveHistory';
import { readTrackPage, readTrackHead, selectTrackSource, trackProviderName, type TrackCatalog, type TrackPage } from './trackHistory';
import { readReviewPage, mergeReviewBars, type ReviewDirection } from './reviewHistory';
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
  const [tab, setTab] = useState<Tab>(() => (params.get('panel') === 'sync' ? 'trade' : params.get('ticket') || params.get('share') ? 'review' : 'trade'));
  const [error, setError] = useState('');
  const [railOpen, setRailOpen] = useState(() => params.get('panel') === 'sync' || window.innerWidth > 900);
  const [feedFilter, setFeedFilter] = useState<'all' | 'share' | 'chat' | 'unread'>('all');
  const [feedLimit, setFeedLimit] = useState(80);
  const [chatReadAt, setChatReadAt] = useState<number>(() => {
    try { return Number(localStorage.getItem('sn-chat-read') || 0) || 0; } catch { return 0; }
  });

  const [note, setNote] = useState({ body: '', tags: [] as string[] });
  const [categories, setCategories] = useState<string[]>([]);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [nativeToolbarHost, setNativeToolbarHost] = useState<HTMLDivElement | null>(null);
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
  const [layout, setLayout] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 900px)').matches ? '1' : '4'));
  /** 窄屏（手机）：一格图表、右栏抽屉、底部抽屉默认收起。 */
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 900px)').matches ? true : false));
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
  const [liveBars, setLiveBars] = useState<ReviewCharts | null>(null);
  /** 图上画的是哪套数据：server = bars 表（券商墙钟），utc = 交易快照（journal.review 已转 UTC）。 */

  /** 没有本机推送时的兜底：用自己那条券商轨的最新历史 K 线，别让「行情」页空着。 */
  const [marketSeries, setMarketSeries] = useState<ReviewCharts | null>(null);
  const [marketInfo, setMarketInfo] = useState<{ source: string; server: string; last: number | null; tfs?: TrackCatalog['sources'][number]['tfs'] } | null>(null);
  const trackSourceRef = useRef<string | null>(null);
  const storedTipsRef = useRef<Partial<Record<BaseTimeframe, number>>>({});
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
  const [replayActive, setReplayActive] = useState(false);
  /** 回放「选起点」状态 + 鼠标横坐标：用来把选择线右侧的 K 线压成半透明。 */
  const [replayArmed, setReplayArmed] = useState(false);
  const [ghostX, setGhostX] = useState<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  /** 拖动补段的滑动窗口：每个基础周期当前已加载的 K 线（秒）与范围（毫秒）。 */
  const seriesRef = useRef<Record<string, number[][]>>({});
  const windowRef = useRef<Record<string, { from: number; to: number }>>({});
  const fetchingRef = useRef<Set<string>>(new Set());
  const reviewEpochRef = useRef(0);
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
    setMarketSeries(null);
    trackSourceRef.current = null;
    storedTipsRef.current = {};
    setMarketInfo(null);
  }, [liveSymbol, board?.user.id]);

  useEffect(() => {
    if (!localConnected || !marketInfo?.server || marketInfo.server !== local.server) return;
    // 新 K 线不该把画面推走：先记下每格可见范围，合并后再恢复（自动滚动关闭时）。
    const keepRanges = chartRef.current?.captureRanges();
    const beforeLast: Record<string, number> = {};
    for (const [key, rows] of Object.entries(liveRef.current)) {
      const last = rows?.[rows.length - 1];
      if (last) beforeLast[key] = last[0];
    }
    // tick 变化也进这里:把最新报价插值进当前蜡烛,蜡烛在两次 EA bar 推送之间随 tick 伸缩。
    // EA 只更新每周期最新一根；历史深度由服务器数据轨道决定。
    const recent = toChartBars(local.bars);
    for (const base of Object.keys(recent) as BaseTimeframe[]) recent[base] = recent[base]?.slice(-1);
    const incoming = applyTickToBars(recent, local.tick);
    mergeLiveHistory(liveRef.current, incoming);
    if (trackSourceRef.current && Object.keys(incoming).length) {
      setLiveBars(liveRef.current);
    }
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
      const tfSec = TF_SECONDS[range.base];
      if (!newest) continue;
      if (range.to < (newest - 8 * tfSec) * 1000) frozen[id] = { from: range.from, to: range.to };
    }
    if (Object.keys(frozen).length) requestAnimationFrame(() => chartRef.current?.restoreRanges(frozen));
  }, [localConnected, local.server, marketInfo?.server, local.tick, local.bars, local.history_ready]);

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

  // 连上 EA 后只在后台补近7天缺口，不锁轨道图，也不恢复旧的多年回溯。
  // error 态不在此自动重试(否则 error→initializing→error 无退避空转);重连会话变化会被
  // backfillBars 内部 stop 回 idle,那时再由本 effect 重启。
  useEffect(() => {
    if (!board?.user.id || !localConnected || !local.history_ready || !local.features.includes('history')) return;
    if (backfill.phase !== 'idle') return;
    void backfillBars.start();
  }, [board?.user.id, localConnected, local.history_ready, local.features, backfill.phase]);

  // 个人中心勾了「自动续传」后：近期首轮结束或用户暂停补齐后才启动，
  // 避免与回填争用本机历史读通道(localTerminal 串行互斥)。已在同步中则不重复开。
  useEffect(() => {
    if (!board?.user.auto_history_sync || !localConnected || !local.history_ready) return;
    if (!local.features.includes('history')) return;
    if (backfill.phase !== 'ready' && backfill.phase !== 'partial_ready' && backfill.phase !== 'paused' && backfill.phase !== 'error') return;
    if (localHistorySync.getSnapshot().enabled) return;
    void localHistorySync.start().catch(() => undefined);
  }, [board?.user.auto_history_sync, localConnected, local.history_ready, local.features, backfill.phase]);

  useEffect(() => {
    const pause = () => { localHistorySync.stop('网页已关闭，笔记同步已暂停。'); backfillBars.stop('网页已关闭，行情回填已暂停。'); };
    window.addEventListener('pagehide', pause);
    return () => { window.removeEventListener('pagehide', pause); pause(); };
  }, []);

  // 旧 /api/live 内存缓存没有原生 source/symbol 身份，不能拿来给轨道补历史。
  // 未连接本机时直接读取已入库轨道，避免换绑账户或品种后混入旧缓存。

  useEffect(() => {
    // 历史首屏始终读当前数据轨道，不受 EA 是否在线或首批缓存深度限制。
    if (mode !== 'live' || !board?.user.id) return;
    let alive = true;
    void (async () => {
      try {
        const catalog = await api<TrackCatalog>('/api/data/sources');
        if (!alive) return;
        const source = selectTrackSource(catalog, liveSymbol, localConnected ? local.server : undefined);
        if (!source) {
          for (const key of Object.keys(liveRef.current)) delete liveRef.current[key as BaseTimeframe];
          trackSourceRef.current = null; setLiveBars(null); setMarketSeries(null); setMarketInfo(null);
          setError('当前券商的数据轨道尚未入库这个品种的行情。');
          return;
        }
        if (trackSourceRef.current && trackSourceRef.current !== source) {
          for (const key of Object.keys(liveRef.current)) delete liveRef.current[key as BaseTimeframe];
          setLiveBars(null);
          setMarketSeries(null);
          setMarketInfo(null);
          storedTipsRef.current = {};
        }
        trackSourceRef.current = source;
        const pages = await Promise.all(REVIEW_BASE_TFS.map((base) => readTrackPage((path) => api<TrackPage>(path), {
          source, symbol: liveSymbol, base, limit: MARKET_LIMIT[base],
        })));
        if (!alive || trackSourceRef.current !== source) return;
        const out: ReviewCharts = {};
        for (const page of pages) if (page.bars.length) {
          const base = page.tf as BaseTimeframe;
          out[base] = page.bars;
          storedTipsRef.current[base] = page.bars.at(-1)![0];
        }
        mergeLiveHistory(liveRef.current, out);
        setMarketSeries(Object.keys(out).length ? out : null);
        setMarketInfo({ source, server: pages[0]?.feed?.server ?? '', last: Math.max(0, ...pages.map((page) => page.last_bar ?? 0)) || null,
          tfs: catalog.sources.find((track) => track.id === source && track.symbol === liveSymbol)?.tfs });
        if (Object.keys(liveRef.current).length) { setLiveBars(liveRef.current); }
        await Promise.all(REVIEW_BASE_TFS.map((base) => out[base]?.length ? chartRef.current?.applySeries(base, liveRef.current[base]!) : undefined));
      } catch (error) {
        if (alive) setError(`轨道历史读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode, localConnected, local.server, local.epoch, liveSymbol, board?.user.id]);

  // 补采入库后刷新轨道尾部。通常每周期只取两根，发现落后一段才拉近期窗口补齐。
  const refreshTrackRef = useRef<((forceRecent?: boolean) => void) | null>(null);
  useEffect(() => {
    const source = marketInfo?.source;
    if (mode !== 'live' || !source) return;
    let alive = true;
    let refreshing = false, pendingRecent = false;
    let catalogAt = 0;
    const refresh = async (forceRecent = false) => {
      if (refreshing) { pendingRecent ||= forceRecent; return; }
      refreshing = true;
      try {
        const pages = await Promise.all(REVIEW_BASE_TFS.map((base) => readTrackHead((path) => api<TrackPage>(path), {
          source, symbol: liveSymbol, base, period: TF_SECONDS[base], storedTip: storedTipsRef.current[base],
          forceRecent,
        })));
        if (!alive || trackSourceRef.current !== source) return;
        const changed: BaseTimeframe[] = [];
        for (const page of pages) {
          if (!page.bars.length) continue;
          const base = page.tf as BaseTimeframe;
          const before = liveRef.current[base]?.length ?? 0;
          mergeLiveHistory(liveRef.current, { [base]: page.bars });
          storedTipsRef.current[base] = page.bars.at(-1)![0];
          if (forceRecent || (liveRef.current[base]?.length ?? 0) > before) changed.push(base);
        }
        await Promise.all(changed.map((base) => chartRef.current?.applySeries(base, liveRef.current[base]!, undefined, true)));
        if (!alive || trackSourceRef.current !== source) return;
        setMarketInfo((info) => info?.source === source ? { ...info,
          last: Math.max(info.last ?? 0, ...pages.map((page) => page.last_bar ?? 0)) || null } : info);
        for (const listener of liveListeners.current) listener();
        if (forceRecent || Date.now() - catalogAt > 60000) {
          const catalog = await api<TrackCatalog>('/api/data/sources');
          if (!alive || trackSourceRef.current !== source) return;
          catalogAt = Date.now();
          const entry = catalog.sources.find((track) => track.id === source && track.symbol === liveSymbol);
          if (entry) setMarketInfo((info) => info?.source === source ? { ...info, tfs: entry.tfs } : info);
        }
      } catch (error) { console.warn('[track-head] 轨道近期数据刷新失败，稍后重试', error); }
      finally {
        refreshing = false;
        if (pendingRecent && alive) { pendingRecent = false; void refresh(true); }
      }
    };
    refreshTrackRef.current = (forceRecent) => { void refresh(forceRecent); };
    const initial = window.setTimeout(() => void refresh(), 700);
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { alive = false; refreshTrackRef.current = null; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [mode, marketInfo?.source, liveSymbol]);
  const previousBackfillPhase = useRef(backfill.phase);
  const previousRepairUpdated = useRef(backfill.repairUpdated);
  const forceTrackRefreshRef = useRef(false);
  useEffect(() => {
    const completed = previousBackfillPhase.current === 'initializing' && (backfill.phase === 'ready' || backfill.phase === 'partial_ready');
    const repaired = backfill.repairUpdated !== null && backfill.repairUpdated !== previousRepairUpdated.current;
    previousBackfillPhase.current = backfill.phase;
    previousRepairUpdated.current = backfill.repairUpdated;
    forceTrackRefreshRef.current ||= completed || repaired;
    const timer = window.setTimeout(() => {
      const forceRecent = forceTrackRefreshRef.current;
      forceTrackRefreshRef.current = false;
      refreshTrackRef.current?.(forceRecent);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [backfill.phase, backfill.lastUpdated, backfill.repairUpdated]);

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
    if (chartRef.current?.replayStatus().active) { setError('请先退出K线回放，再分享复盘切片。'); return; }
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
  const reviewingOther = mode === 'review' && Boolean(target?.person && target.person !== me?.id);
  const liveAnchor = (() => {
    const rows = liveBars?.M1 ?? [];
    const last = rows[rows.length - 1];
    return last ? last[0] * 1000 : Date.now();
  })();
  /** 历史来自当前数据轨道；本机/云端推送只合并实时增量。 */
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
  const [series, setSeries] = useState<ReviewCharts | null>(null);
  const availableTfs = useMemo(() => {
    if (mode === 'live') return TIMEFRAME_OPTIONS;
    const charts = series ?? entry?.review.charts ?? {};
    return TIMEFRAME_OPTIONS.filter((option) => {
      const base = charts[TIMEFRAMES[option.id].base];
      if (!base || base.length < 2) return false;
      if (option.id === '30' || option.id === '240') return base.length >= 4;
      if (option.id === '1D') return base.length >= 24;
      return true;
    });
  }, [entry, mode, series]);

  const ready = Boolean(
    entry && entry.review.status === 'ready' && Object.values(entry.review.charts || {}).some((bars) => (bars?.length ?? 0) > 1),
  );

  // 复盘图的数据源：先拿交易快照，再按锚点往两边抓该券商 source 的 bars（没覆盖的地方留白）。
  const anchorSeconds = entry?.share?.anchor_ms
    ? Math.round(entry.share.anchor_ms / 1000)
    : (entry?.review.opened ?? (entry?.review.trade?.closed as number | undefined) ?? null);
  useEffect(() => {
    const epoch = ++reviewEpochRef.current;
    setSeries(null);
    seriesRef.current = {};
    windowRef.current = {};
    fetchingRef.current.clear();
    edgeBlockRef.current = {};
    if (mode !== 'review' || !entry || entry.review.status !== 'ready' || !ready) return;
    const payload = entry.review.charts || {};
    const anchor = anchorSeconds ?? Math.round(Date.now() / 1000);
    let alive = true;
    void (async () => {
      // 服务端已经把库里的券商墙钟换成 UTC（bars.to_utc），所以两套数据现在可以直接按
      // 时间戳合并：同一周期有 bars 就用 bars（更全），没有就留交易快照那一段。
      const merged: ReviewCharts = { ...payload };
      try {
        await Promise.allSettled(REVIEW_BASE_TFS.map(async (tf) => {
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
      if (alive && epoch === reviewEpochRef.current) setSeries(merged);
    })();
    return () => {
      alive = false;
      reviewEpochRef.current += 1;
    };
  }, [entry?.review, mode, ready, shareId, target?.person, target?.ticket, anchorSeconds]);

  /* ------------------------------------------------- 复盘历史双向分页 */

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

  const loadWindow = useCallback(async (base: BaseTimeframe, direction: ReviewDirection) => {
    const replay = chartRef.current?.replayStatus(); if (replay?.active || replay?.armed || replay?.busy) return null;
    const epoch = reviewEpochRef.current;
    const key = `${epoch}:${base}`;
    if (fetchingRef.current.has(key)) return null;
    fetchingRef.current.add(key);
    try {
      const data = await readReviewPage(api, ctxRef.current, base, direction, seriesRef.current[base] ?? []);
      if (epoch !== reviewEpochRef.current) return null;
      if (!data.bars?.length) {
        edgeBlockRef.current[base + ':' + direction] = Date.now() + 60_000;
        return null;
      }
      const merged = mergeReviewBars(seriesRef.current[base] ?? [], data.bars);
      seriesRef.current[base] = merged;
      windowRef.current[base] = { from: merged[0][0] * 1000, to: merged[merged.length - 1][0] * 1000 };
      if (data.has_more === false && direction !== 'latest') edgeBlockRef.current[base + ':' + direction] = Date.now() + 60_000;
      await chartRef.current?.applySeries(base, merged);
      if (epoch !== reviewEpochRef.current) return null;
      return data.bars[data.bars.length - 1][0];
    } catch (error) {
      if (epoch === reviewEpochRef.current) {
        edgeBlockRef.current[base + ':' + direction] = Date.now() + 15_000;
      }
      return null;
    } finally {
      fetchingRef.current.delete(key);
    }
  }, []);


  /** 实时图分页：同周期只允许一个在途请求；暂时无数据时短暂退避，不认定历史到底。 */
  const livePagingRef = useRef<Set<string>>(new Set());
  const liveFloorRef = useRef<Record<string, number>>({});
  const liveScopeRef = useRef('');
  liveScopeRef.current = `${mode}:${marketInfo?.source ?? ''}:${liveSymbol}`;
  const liveOlder = useCallback(async (base: BaseTimeframe, manual = false) => {
    const replay = chartRef.current?.replayStatus(); if (replay?.active || replay?.armed || replay?.busy) return;
    const source = trackSourceRef.current;
    if (mode !== 'live' || !source || livePagingRef.current.has(base)) return;
    const rows = liveRef.current[base];
    if (!rows?.length) return;
    if (!manual && (liveFloorRef.current[base] ?? 0) > Date.now()) return;
    const scope = liveScopeRef.current;
    const valid = () => liveScopeRef.current === scope && trackSourceRef.current === source;
    const merge = async (older: number[][]) => {
      if (!valid()) return false;
      let painted: Promise<void> | undefined;
      if (!prependLiveHistory(liveRef.current, base, older, (tf, data) => {
        painted = chartRef.current?.applySeries(tf, data);
      })) return false;
      try { await painted; }
      catch (error) {
        setError(`历史图表更新失败：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      if (!valid()) return false;
      // 注意：必须传同一个引用。传 {...} 会让 charts prop 变换新对象，
      // ChartWorkspace 的初始化 effect 依赖 [charts] → 整个工作台重建 → 视图跳回最新。
      setLiveBars(liveRef.current);
      for (const listener of liveListeners.current) listener();
      return true;
    };
    livePagingRef.current.add(base);
    try {
      // 按行数向前翻轨道，不按日历时间窗口切，也不请求 EA。
      const page = await readTrackPage((path) => api<TrackPage>(path), {
        source, symbol: liveSymbol, base, before: rows[0][0], limit: MARKET_LIMIT[base],
      });
      if (!valid()) return;
      await merge(page.bars);
      if (!page.has_more && valid()) liveFloorRef.current[base] = Date.now() + 60_000;
    } catch (error) {
      if (valid()) {
        liveFloorRef.current[base] = Date.now() + 15_000;
        setError(`轨道历史读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      livePagingRef.current.delete(base);
    }
  }, [mode, liveSymbol]);

  /** 轨道首屏就绪后，每个周期预取一页；离线也能继续向左翻。 */
  const prefetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'live' || !marketInfo?.source || !liveBars || prefetchedRef.current === marketInfo.source) return;
    prefetchedRef.current = marketInfo.source;
    const bases: BaseTimeframe[] = ['M1', 'M5', 'M15', 'H1'];
    void (async () => {
      for (const base of bases) {
        if (!liveRef.current[base]?.length) continue;
        await liveOlder(base).catch(() => undefined);
      }
    })();
  }, [mode, marketInfo?.source, liveBars, liveOlder]);
  useEffect(() => {
    // 切换轨道后重新允许预取
    liveFloorRef.current = {};
  }, [marketInfo?.source]);

  // 历史通道可能正在回填。可见左边缘仍缺数据时自动重试，不要求用户再拖一下。
  useEffect(() => {
    if (mode !== 'live' || !marketInfo?.source) return;
    const timer = window.setInterval(() => {
      for (const range of Object.values(chartRef.current?.captureRanges() ?? {})) {
        const first = liveRef.current[range.base]?.[0]?.[0];
        if (first === undefined) continue;
        const span = Math.max(60_000, range.to - range.from);
        if (range.from - first * 1000 < span * 1.5) void liveOlder(range.base);
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [mode, marketInfo?.source, liveOlder]);

  /** 窄屏没有横向空间放 2×2：首次进入手机宽度时切成单格，回到宽屏不强行改回。 */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 900px)');
    setNarrow(mq.matches);
    if (mq.matches) {
      chartRef.current?.setLayout('1');
      setLayout('1');
    }
    const onChange = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
      if (event.matches) {
        chartRef.current?.setLayout('1');
        setLayout('1');
      }
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const handleViewport = useCallback((info: { cellId: string; timeframe: string; from: number; to: number }) => {
    const replay = chartRef.current?.replayStatus(); if (replay?.active || replay?.armed || replay?.busy) return;
    const recipe = TIMEFRAMES[info.timeframe];
    if (!recipe) return;
    const base = recipe.base;
    const spanMs = Math.max(60_000, info.to - info.from);
    // 实时模式：翻到最左边就把更早的一段补进来（每次 ~1990 根）。
    if (mode === 'live') {
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
    // 按实际根数向两侧翻页，周末/缺口不会让固定日历窗口卡在旧快照。
    const nearEdge = span * (base === 'H1' ? 1.5 : 0.75);
    const blocked = (side: string) => (edgeBlockRef.current[base + ':' + side] ?? 0) > Date.now();
    const needLeft = info.from - loaded.from < nearEdge && !blocked('left');
    const needRight = loaded.to - info.to < nearEdge && !blocked('right');
    if (needLeft || needRight) {
      const direction = needLeft && (!needRight || info.from - loaded.from < loaded.to - info.to) ? 'left' : 'right';
      void loadWindow(base, direction);
    }

  }, [loadWindow, mode, liveOlder]);

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
      <header className="topbar unified-topbar">
        <a className="brand" href="/">
          <span className="mark">▥</span> 同频 <small>交易台</small>
        </a>
        <div className="status-row" title={reviewingOther ? '正在复盘的是别人的交易；账户数字已隐藏，避免和对方混淆' : '我的账户'}>
          <span className="stat"><b className="stat-v">{mode === 'live' ? liveSymbol : trade.symbol || 'XAUUSD'}</b></span>
          {/* 没有任何账户数据源时不显示净值/余额，避免把云端旧快照当成本机状态。 */}
          {reviewingOther || !(localConnected || mt5Online) ? null : (
            <>
              <span className="sep account-stat" aria-hidden="true" />
              <span className="stat account-stat"><span className="stat-k">净值</span><b className="stat-v">{money(displayedAccount?.equity)}</b></span>
              <span className="stat account-stat"><span className="stat-k">余额</span><b className="stat-v">{money(displayedAccount?.balance)}</b></span>
              <span className="stat account-stat"><span className="stat-k">浮盈</span><b className={floating >= 0 ? 'stat-v up' : 'stat-v down'}>{money(floating)}</b></span>
            </>
          )}
        </div>
        <div className="chart-toolbar unified-chart-tools">
          {/* 指标按钮由我们放在「品种」和「周期」之间；真正的 Vela 指标面板按钮被隐藏，
              点这里代它触发（DOM 仍在，picker 逻辑不用重写）。 */}
          <button
            type="button"
            className="tool-btn indicator-trigger"
            title="指标"
            aria-label="指标"
            onClick={() => {
              const nativeButton = document.querySelector<HTMLButtonElement>('.vela-widget-indicators');
              nativeButton?.click();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 17l5-6 4 4 6-8" />
              <path d="M3 21h18" />
            </svg>
            指标
          </button>
          <TfMenu disabled={replayActive} current={tf} options={availableTfs} scopeAll={Boolean(syncs.timeframe)} onPick={(id) => { chartRef.current?.setTimeframe(id); setTf(id); }} />
          <div className="native-chart-tools" ref={setNativeToolbarHost} />
          <DrawingFavs
            favorites={favs}
            active={activeTool}
            onUse={(key) => {
              chartRef.current?.useTool(key);
              setActiveTool((prev) => (prev === key ? null : key));
            }}
          />
          <span className="mode-switch" role="group" aria-label="图表视图">
            <button type="button" className={`tool-btn ${mode === 'live' && !replayActive ? 'is-active' : ''}`.trim()} aria-pressed={mode === 'live' && !replayActive} disabled={replayActive} onClick={() => switchMode('live')}>行情</button>
            <button
              type="button"
              className={`tool-btn ${replayActive ? 'is-active' : ''}`.trim()}
              aria-pressed={replayActive}
              title={replayActive ? '重新选择回放起点' : '在历史 K 线上逐根回放'}
              onClick={() => chartRef.current?.replaySelect()}
            >
              回放
            </button>
          </span>
          <BarReplayControls
            chart={chartRef}
            onActiveChange={setReplayActive}
            onArmedChange={setReplayArmed}
            onRandom={async () => {
              // 随机起点：在「所有数据轨道的覆盖并集」里随机，再用 /api/market/bars 回查一次，
              // 确认真有 K 线才跳；查空就换一个时点重试（用户无感）。
              const base = TIMEFRAMES[tf]?.base;
              const tfName: Record<string, '1m' | '5m' | '15m' | '1h'> = { M1: '1m', M5: '5m', M15: '15m', H1: '1h' };
              const name = base ? tfName[base] : undefined;
              if (!name) throw new Error('当前周期不支持随机回放');
              const seconds = TF_SECONDS[base!];
              const catalog = await api<{ sources: Array<{ tfs?: Record<string, { from: number; to: number; bars: number }> }> }>('/api/data/sources');
              const windows = (catalog.sources ?? [])
                .map((row) => row.tfs?.[base!])
                .filter((info): info is { from: number; to: number; bars: number } => Boolean(info && info.bars > 0 && info.to > info.from))
                .map((info) => ({ from: info.from, to: info.to, weight: Math.max(1, info.bars) }));
              if (!windows.length) {
                // 目录还没建（新库/刚接入）：退回到当前已加载的序列里随机，别让用户卡在弹错上。
                const rows = (mode === 'live' ? liveRef.current[base!] : seriesRef.current[base!]) ?? [];
                if (rows.length < 10) throw new Error('还没有可回放的 K 线');
                const pick = rows[Math.floor(Math.random() * rows.length)][0];
                chartRef.current?.focus(pick * 1000);
                await new Promise((resolve) => window.setTimeout(resolve, 400));
                await chartRef.current?.replayStartFromView();
                return;
              }
              const total = windows.reduce((sum, w) => sum + w.weight, 0);
              for (let attempt = 0; attempt < 8; attempt += 1) {
                let roll = Math.random() * total;
                const win = windows.find((w) => (roll -= w.weight) <= 0) ?? windows[windows.length - 1];
                const spot = win.from + Math.floor(Math.random() * Math.max(1, win.to - win.from));
                const look = await api<{ bars: number[][] }>(
                  `/api/market/bars?symbol=${encodeURIComponent(liveSymbol)}&tf=${name}&from=${spot}&to=${spot + seconds * 60}`,
                ).catch(() => null);
                const first = look?.bars?.[0]?.[0];
                if (first) {
                  chartRef.current?.focus(first * 1000);
                  await new Promise((resolve) => window.setTimeout(resolve, 400));
                  await chartRef.current?.replayStartFromView();
                  return;
                }
              }
              throw new Error('随机到的区间暂时没有 K 线，请再试一次');
            }}
            onEarliest={async () => {
              // 「最早可用日期」：先把视口挪到当前数据最早一根，再从视图开始。
              const base = TIMEFRAMES[tf]?.base;
              const rows = (mode === 'live' ? liveRef.current[base] : seriesRef.current[base]) ?? [];
              const first = rows[0]?.[0];
              if (!first) throw new Error('当前周期还没有可回放的历史');
              chartRef.current?.focus(first * 1000);
              await new Promise((resolve) => window.setTimeout(resolve, 400));
              await chartRef.current?.replayStartFromView();
            }}
          />
          <span className="spacer" />
          <span className="save-hint" role="status" aria-live="polite">
            {saveState === 'saving' ? '保存画线…' : saveState === 'saved' ? '画线已保存' : saveState === 'error' ? '画线保存失败' : ''}
          </span>
        </div>

        <nav className="top-actions">
          <button type="button" className="tool-btn" onClick={() => { setTab('trade'); setRailOpen(true); }}>本机 MT5</button>
          <a href="/history" target="_blank" rel="noopener noreferrer" title="新标签页打开，保留本机 EA 连接">交易日历 ↗</a>
          <LayoutMenu disabled={replayActive} compact current={layout} onPick={(id) => { chartRef.current?.setLayout(id); setLayout(id); }} syncs={syncs} onToggleSync={toggleSync} />
          <FullscreenButton />
          <SettingsMenu name={me?.nickname || '账户'} />
        </nav>
      </header>

      {/* ---------------------------------------------------------- 主体 */}
      <div className={`main ${railOpen ? '' : 'rail-closed'}`}>
        <section className="chart-pane">
          {mode === 'review' && entry?.read_only ? (
            <div className="context-banner" role="status">
              <b>只读回放</b>
              <span>{entry.owner.name} 的复盘 · 画线与笔记不可修改</span>
              {myHistory.length ? <button type="button" className="link" onClick={() => openTicket(me!.id, String(myHistory[0].ticket))}>回到我的最近一笔</button> : null}
            </div>
          ) : backfill.phase === 'initializing' ? (
            <div className="context-banner sync-status" role="status" aria-live="polite">
              <b>后台补齐近期行情</b>
              <span>只检查近7天缺口，可继续看图；交易指令优先。已写入 {backfill.segments} 段。</span>
              <button type="button" className="link" onClick={() => backfillBars.pause()}>暂停补齐</button>
            </div>
          ) : backfill.phase === 'paused' ? (
            <div className="context-banner sync-status" role="status">
              <b>近期补齐已暂停</b><span>轨道中已有的历史仍可查看。</span>
              <button type="button" className="link" onClick={() => void backfillBars.resume()}>继续补齐</button>
            </div>
          ) : backfill.phase === 'error' || backfill.phase === 'partial_ready' ? (
            <div className="context-banner sync-status" role="status">
              <b>近期补齐待重试</b><span>{backfill.message}</span>
              <button type="button" className="link" onClick={() => void backfillBars.start()}>重试近期补齐</button>
            </div>
          ) : null}

          <div
            className="chart-body"
            onPointerMove={(event) => {
              if (!replayArmed) return;
              const rect = event.currentTarget.getBoundingClientRect();
              setGhostX(Math.max(0, Math.min(rect.width, event.clientX - rect.left)));
            }}
            onPointerLeave={() => setGhostX(null)}
          >
            {replayArmed && ghostX != null ? (
              <div className="replay-ghost" style={{ left: ghostX }} aria-hidden="true" />
            ) : null}
            {mode === 'live' && liveSeries ? (
              <ChartWorkspace
                key={`live:${marketInfo?.source ?? 'loading'}:${liveSymbol}`}
                ref={chartRef}
                toolbarHost={nativeToolbarHost}
                forceLayout={narrow ? '1' : undefined}
                charts={liveSeries}
                provider={liveBars ? liveProvider : undefined}
                providerName={marketInfo?.source ? trackProviderName(marketInfo.source) : 'trackpending'}
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
                toolbarHost={nativeToolbarHost}
                forceLayout={narrow ? '1' : undefined}
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
                      ? (ready ? '正在读取服务器复盘历史…' : entry?.review.status === 'pending' ? '等待 MT5 上传这笔交易的 K 线…' : entry?.review.error || '参考行情准备中…')
                      : '还没有可复盘的交易'}
                </p>
                <p className="dim">
                  {mode === 'live'
                    ? '连接本机 EA 看实时行情，或打开一笔历史复盘。'
                    : target
                      ? (ready ? '无需连接 EA，读取完成后图表会自动出现。' : '同步完成后图表会自动出现。')
                      : '在 MT5 同步一笔成交，或从底部「历史」打开已有交易。'}
                </p>
                <div className="empty-actions">
                  {mode === 'review' && !target && myHistory[0] ? (
                    <button type="button" className="primary" onClick={() => openTicket(me!.id, String(myHistory[0].ticket))}>
                      打开最近一笔 #{String(myHistory[0].ticket)}
                    </button>
                  ) : null}
                  {!localConnected && !(mode === 'review' && ready) ? (
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

            {/* 窄屏抽屉没有图标条可点，给一个显式关闭按钮。 */}
        <button type="button" className="rail-close" aria-label="收起面板" title="收起面板" onClick={() => setRailOpen(false)}>×</button>
        <div className="rail-body">
              {tab === 'trade' ? (
                <div className="pane">
                  <LocalTradePanel state={local} />
                  {/* 本机连接时 LocalTradePanel 已经显示实时账户/持仓；这里只补云端快照，避免同屏两份。 */}

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

