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
    const ticketParam = params.get('ticket');
    const personParam = params.get('person') || board.user.id;
    const tParam = Number(params.get('t') || 0) || undefined;
    if (ticketParam) {
      setTarget({ person: personParam, ticket: ticketParam, t: tParam });
      return;
    }
    const mine = latestTradeOf(board.snapshots[board.user.id]);
    if (mine) setTarget({ person: board.user.id, ticket: String(mine.ticket), t: undefined });
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
    if (!board) return;
    void api<{ items: ShareRow[] }>('/api/reviews/inbox').then((r) => setInbox(r.items)).catch(() => undefined);
    void api<{ following: Array<{ id: string; name: string }> }>('/api/profile').then((r) => setFollowing(r.following)).catch(() => undefined);
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
    setShareId(null);
    setTarget({ person, ticket, t });
    setMode('review');
    // 打开复盘时右栏直接切到「复盘」，不要停在「下单」。
    setTab('review');
    setRailOpen(true);
    const qs = new URLSearchParams({ person, ticket });
    if (t) qs.set('t', String(t));
    history.replaceState(null, '', '/chart?' + qs.toString());
  };

  /** 打开一条消息里的复盘切片：还原分享人当时那个窗口（服务端按 share 存档回放）。 */
  const openShare = (row: ShareRow) => {
    setShareId(row.id);
    setTarget({ person: row.owner.id, ticket: row.ticket });
    setMode('review');
    setTab('review');
    setRailOpen(true);
    history.replaceState(null, '', '/chart?share=' + row.id);
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
  const price = localConnected
    ? (local.tick?.bid ? (local.tick.bid + local.tick.ask) / 2 : null)
    : (liveTick && liveTick.bid ? (liveTick.bid + liveTick.ask) / 2 : null) ?? barsClose(entry) ?? null;
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

  const loadWindow = useCallback(async (base: string, from: number, to: number, span: number) => {
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
      chartRef.current?.applySeries(base as BaseTimeframe, merged);
    } catch {
      /* 补不到就留白，不拿别的来源顶 */
    } finally {
      fetchingRef.current.delete(base);
    }
  }, []);

  const handleViewport = useCallback((info: { timeframe: string; from: number; to: number }) => {
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
      void loadWindow(base, info.from, info.to, span);
    }
    const bars = seriesRef.current[base] ?? [];
    if (bars.length > 12_000) {
      const trimmed = bars.filter((bar) => bar[0] * 1000 >= info.from - keep && bar[0] * 1000 <= info.to + keep);
      if (trimmed.length > 200 && trimmed.length < bars.length) {
        seriesRef.current[base] = trimmed;
        windowRef.current[base] = { from: trimmed[0][0] * 1000, to: trimmed[trimmed.length - 1][0] * 1000 };
        chartRef.current?.applySeries(base as BaseTimeframe, trimmed);
      }
    }
  }, [loadWindow]);

  const unseen = inbox.filter((row) => !row.seen).length;
  /** 消息页把「留言」和「复盘分享」合成一条时间线：分享就是一条带切片的消息。 */
  const feed = useMemo<Array<{ kind: 'share'; row: ShareRow } | { kind: 'chat'; row: Board['messages'][number] }>>(() => {
    const shares = inbox.map((row) => ({ kind: 'share' as const, row }));
    const chats = (board?.messages ?? []).map((row) => ({ kind: 'chat' as const, row }));
    return [...shares, ...chats].sort((a, b) => b.row.created - a.row.created).slice(0, 80);
  }, [inbox, board?.messages]);
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
        <div className="symbol">
          <b>{mode === 'live' ? liveSymbol : trade.symbol || 'XAUUSD'}</b>
          <span className={price != null ? 'price' : 'price dim'}>{price != null ? quotePrice(price) : '—'}</span>
          <span className={mt5Online ? 'link-dot on' : 'link-dot off'}>{localConnected ? '本机直连' : mt5Online ? '云端同步 · 只读' : 'MT5 未连接'}</span>
        </div>
        <div className="metrics">
          <span>净值 <b>{money(displayedAccount?.equity)}</b></span>
          <span>余额 <b>{money(displayedAccount?.balance)}</b></span>
          <span>浮盈 <b className={floating >= 0 ? 'up' : 'down'}>{money(floating)}</b></span>
        </div>
        <nav className="top-actions">
          <button type="button" className="tool-btn" onClick={() => { setTab('trade'); setRailOpen(true); }}>本机 MT5</button>
          <a href="/history">交易记录</a>
          <a href="/profile">{me?.nickname || '个人中心'}</a>
          <SettingsMenu />
          <button type="button" className="icon" title="显示/隐藏右侧栏" onClick={() => setRailOpen((v) => !v)}>▤</button>
        </nav>
      </header>

      {/* ---------------------------------------------------------- 主体 */}
      <div className={`main ${railOpen ? '' : 'rail-closed'}`}>
        <section className="chart-pane">
          <div className="chart-toolbar">
            <LayoutMenu current={layout} onPick={(id) => { chartRef.current?.setLayout(id); setLayout(id); }} syncs={syncs} onToggleSync={toggleSync} />
            <TfMenu current={tf} options={availableTfs} onPick={(id) => { chartRef.current?.setTimeframe(id); setTf(id); }} />
            <DrawingFavs
              favorites={favs}
              active={activeTool}
              onUse={(key) => {
                chartRef.current?.useTool(key);
                setActiveTool((prev) => (prev === key ? null : key));
              }}
            />
            <button type="button" className={`tool-btn ${mode === 'live' ? 'is-active' : ''}`} onClick={() => setMode('live')}>行情</button>
            <button type="button" className={`tool-btn ${mode === 'review' ? 'is-active' : ''}`} disabled={!target} onClick={() => setMode('review')}>复盘</button>
            <button type="button" className="tool-btn" onClick={() => chartRef.current?.focus()}>回到开仓</button>
            {mode === 'live' && !liveBars && marketSeries ? (
              <span className="badge">历史行情{marketInfo?.last ? ' · 最新 ' + stamp(marketInfo.last) : ''}</span>
            ) : null}
            <span className="spacer" />
            {entry?.read_only ? <span className="badge">只读 · {entry.owner.name} 的复盘</span> : null}
            <span className="save-hint">
              {saveState === 'saving' ? '保存画线…' : saveState === 'saved' ? '画线已保存' : saveState === 'error' ? '画线保存失败' : ''}
            </span>
          </div>

          {mode === 'review' && (target || shareId != null) ? (
            <TrackStrip
              person={target?.person}
              ticket={target?.ticket}
              shareId={shareId}
              from={anchorMs - 3 * 86400000}
              to={anchorMs + 86400000}
              refreshKey={entry?.chart?.updated ?? 0}
            />
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
                <p>{mode === 'live' ? (localConnected ? local.history_ready ? '本机历史暂不可用，请在 MT5 加载历史后重新连接' : '正在加载本机四周期 K 线…' : '等待行情数据…') : target ? (entry?.review.status === 'pending' ? '等待 MT5 上传这笔交易的 K 线…' : entry?.review.error || '参考行情准备中…') : '还没有可复盘的交易'}</p>
                <p className="dim">{mode === 'live' ? '在右侧连接本机 EA，或使用已有云端同步行情' : target ? '同步完成后图表会自动出现' : '先在 MT5 上同步一笔成交'}</p>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------ 右栏 */}
        {railOpen ? (
          <aside className="rail">
            <div className="rail-icons">
              {([
                { key: 'trade', label: '交易', Icon: TradeIcon },
                { key: 'inbox', label: '消息', Icon: MailIcon },
                { key: 'friends', label: '好友', Icon: FriendsIcon },
                { key: 'review', label: '复盘', Icon: ReviewIcon },
              ] as Array<{ key: Tab; label: string; Icon: typeof TradeIcon }>).map(({ key, label, Icon }) => {
                const fresh = key === 'inbox' && unseen > 0;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`${tab === key ? 'is-active' : ''} ${fresh ? 'has-new' : ''}`.trim()}
                    title={fresh ? `${label}（${unseen} 条未读）` : label}
                    aria-label={fresh ? `${label}，${unseen} 条未读` : label}
                    onClick={() => setTab(key)}
                  >
                    <Icon />
                    {fresh ? <i className="dot">{unseen}</i> : null}
                  </button>
                );
              })}
            </div>

            <div className="rail-body">
              {tab === 'trade' ? (
                <div className="pane">
                  <LocalTradePanel state={local} />
                  <h3>账户</h3>
                  <div className="kv">
                    <span>净值</span><b>{money(displayedAccount?.equity)}</b>
                    <span>余额</span><b>{money(displayedAccount?.balance)}</b>
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
                            <td>{money(p.price_open ?? p.open)}</td>
                            <td className={(p.profit || 0) >= 0 ? 'up' : 'down'}>{money(p.profit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="dim">没有持仓</p>}

                  {/* 成交历史统一放在底部「历史」页签里，右栏不再重复列一遍。 */}
                  <p className="dim">成交历史在底部「历史」页签，点「复盘 / 未复盘」直接打开对应 K 线。</p>
                </div>
              ) : null}

              {tab === 'inbox' ? (
                <div className="pane chat-pane">
                  <h3>
                    消息
                    <small>{inbox.length ? `${inbox.length} 条复盘分享${unseen ? ` · ${unseen} 未读` : ''}` : '留言与复盘分享'}</small>
                  </h3>
                  <div className="chat-log">
                    {feed.length ? feed.map((item) => (item.kind === 'share' ? (
                      <button
                        key={'s' + item.row.id}
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
                      <div key={'c' + item.row.id} className={`msg ${item.row.person === me?.id ? 'mine' : ''}`}>
                        <div className="meta">{item.row.name || item.row.person} · {stamp(item.row.created)}</div>
                        <p>{item.row.text}</p>
                      </div>
                    ))) : (
                      <p className="dim">还没有消息。在复盘里点「发给好友」，好友会在这里收到一条带复盘切片的消息。</p>
                    )}
                    <div ref={chatEnd} />
                  </div>
                  <div className="chat-form">
                    <textarea value={chat} maxLength={1000} rows={2} placeholder="说点什么…" onChange={(e) => setChat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat(); } }} />
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
                          rows.length ? <TradeList rows={rows.slice(0, 5)} reviewed={board?.reviewed} onPick={(row) => openTicket(member.id, String(row.ticket))} /> : <p className="dim">暂无可查看的成交</p>
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

            </div>
          </aside>
        ) : null}
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

      {error ? <div className="toast">{error}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 子组件 */

function nameOf(board: Board, person: string): string {
  return board.members.find((m) => m.id === person)?.name || person;
}

function TradeList({ rows, reviewed, onPick }: { rows: any[]; reviewed?: string[]; onPick: (row: any) => void }) {
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
              {reviewed?.includes(String(row.ticket)) ? (
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
