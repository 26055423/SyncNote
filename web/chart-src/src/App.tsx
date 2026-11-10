import { useMarketHistory } from './features/market/useMarketHistory';
import { REVIEW_BASE_TFS, MARKET_LIMIT, MARKET_HEAD_POLL_MS, toChartBars } from './features/market/model';
import { useSocialNotifications } from './features/social/useSocialNotifications';
import { useSymbolCatalog } from './features/market/useSymbolCatalog';
import { useTerminalSync } from './features/local/useTerminalSync';
import { useBoard } from './features/board/useBoard';
import type { Board, Entry, ShareRow, Tab } from './features/workspace/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, money, stamp } from './api';
import { ChartWorkspace, TIMEFRAME_OPTIONS, type ChartHandle, type SyncKind } from './vela/ChartWorkspace';
import { BarReplayControls } from './BarReplayControls';
import { FullscreenButton } from './ChartToolsMenu';
import { StyleMenu, type PriceStyle } from './StyleMenu';
import { LayoutMenu } from './vela/LayoutMenu';
import { TfMenu } from './vela/TfMenu';
import { LiveProvider, TIMEFRAMES, type BaseTimeframe, type ReviewCharts } from './vela/provider';
import { BASE_SECONDS as TF_SECONDS, mergeLiveHistory, prependLiveHistory } from './liveHistory';
import { readTrackPage, trackProviderName, type TrackPage } from './trackHistory';
import { readReviewPage, readReviewRange, mergeReviewBars, visibleReviewGap, type ReviewDirection, type ReviewScope } from './reviewHistory';
import { readIndicatorMinutes } from './indicatorHistory';
import { LocalTradePanel } from './LocalTradePanel';
import { MT5Connection } from './MT5Connection';
import { BottomDock } from './BottomDock';
import { DrawingFavs } from './DrawingFavs';
import { SettingsMenu } from './SettingsMenu';
import { TrackStrip } from './TrackStrip';
import { ChatDock } from './ChatDock';
import { ReviewShareDialog } from './ReviewShareDialog';
import { ReviewNotesList } from './ReviewNotesList';
import { ReviewNotebook, type NoteSection } from './ReviewNotebook';
import { FriendsIcon, ReviewIcon, TradeIcon } from './ui/icons';
import { ToolbarIcon } from './ui/ToolbarIcon';
import { DEFAULT_FAVORITES } from './vela/drawingTools';
import { localTerminal, useLocalTerminal } from './localTerminal';
import { localHistorySync, historyAccountKey, useLocalHistorySync } from './localHistorySync';
import { localRangeSync, useLocalRangeSync } from './localRangeSync';
import { backfillBars, useBackfillBars } from './backfillBars';
import { SymbolPicker } from './SymbolPicker';
import { MarketRangeSync } from './MarketRangeSync';
import type { MarketSyncGateJob } from './marketSyncGate';

/* ------------------------------------------------------------------ 类型 */

/* 复盘图一次抓多宽的行情：按锚点往前/往后取多少天（每个基础周期各自独立）。 */
const REVIEW_WINDOW: Record<(typeof REVIEW_BASE_TFS)[number], [number, number]> = {
  M1: [2, 0.5],
  M5: [10, 2],
  M15: [30, 7],
  H1: [120, 30],
};

/* ------------------------------------------------------------------ 工具 */

const sideText = (side: string) => (side === 'sell' ? '做空' : '做多');

/* ------------------------------------------------------------------ 页面 */

export default function App() {
  const local = useLocalTerminal();
  const localConnected = local.phase === 'connected';
  const backfill = useBackfillBars();
  const historySync = useLocalHistorySync();
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [mt5ConnectionOpen, setMT5ConnectionOpen] = useState(params.get('connect') === '1');

  const [entry, setEntry] = useState<Entry | null>(null);
  const [target, setTarget] = useState<{ person: string; ticket: string; note?: string; t?: number } | null>(null);
  /** 正在看某条消息里的复盘切片时，入口按 share id 取（拿分享人当时的窗口）。 */
  const [shareId, setShareId] = useState<number | null>(() => {
    const raw = params.get('share');
    return params.get('view') !== 'live' && raw && /^\d+$/.test(raw) ? Number(raw) : null;
  });
  const initialReview = params.get('view') !== 'live' && Boolean(params.get('note') || params.get('ticket') || shareId || params.get('view') === 'review');
  const [tab, setTab] = useState<Tab>(() => (params.get('panel') !== 'sync' && initialReview ? 'review' : 'trade'));
  const [error, setError] = useState('');
  const { board, setBoard } = useBoard(setError);
  useTerminalSync(board, local, backfill, historySync);
  const { inbox, dmUnread, groupUnread, friendReq, setFriendReq } = useSocialNotifications(board, tab);
  const [railOpen, setRailOpen] = useState(() => params.get('panel') === 'sync' || window.innerWidth > 900);
  const [feedFilter, setFeedFilter] = useState<'all' | 'share' | 'chat' | 'unread'>('all');
  const [feedLimit, setFeedLimit] = useState(80);
  const [chatReadAt, setChatReadAt] = useState<number>(() => {
    try { return Number(localStorage.getItem('sn-chat-read') || 0) || 0; } catch { return 0; }
  });

  const [note, setNote] = useState({ body: '', tags: [] as string[], sections: [] as NoteSection[] });
  const noteRef = useRef(note);
  noteRef.current = note;
  const [categories, setCategories] = useState<string[]>([]);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [nativeToolbarHost, setNativeToolbarHost] = useState<HTMLDivElement | null>(null);
  // 好友申请：别人申请我的（可通过对）/ 我申请的（可取消）。
  const [friendManager, setFriendManager] = useState(false);
  const [chatGroup, setChatGroup] = useState<{ id: string; name: string; avatar?: string } | null>(null);
  const [shareRequest, setShareRequest] = useState<{ ticket: string; note_id?: string; note?: unknown; snapshot: unknown; initialRecipient?: { kind: 'dm' | 'group'; id: string } } | null>(null);
  const [notesRevision, setNotesRevision] = useState(0);
  const [creatingNote, setCreatingNote] = useState(false);
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
  const [mode, setMode] = useState<'review' | 'live'>(() => initialReview ? 'review' : 'live');
  const tradeReview = mode === 'review' && (target !== null || shareId !== null);
  const marketView = !tradeReview;
  const [forming, setForming] = useState<{ source: string; symbol: string; bars: ReviewCharts } | null>(null);
  /** 图上画的是哪套数据：server = bars 表（券商墙钟），utc = 交易快照（journal.review 已转 UTC）。 */

  /** 没有本机推送时的兜底：用自己那条券商轨的最新历史 K 线，别让「行情」页空着。 */
  const { storedSymbol, setStoredSymbol, symbolOptions, symbolsLoading, symbolsError, catalogSource, catalogAvailable, setCatalogRevision } = useSymbolCatalog(board, local);
  const liveSymbol = localConnected ? local.symbol : storedSymbol;
  const connectedTrack = localConnected ? (local.server.trim() ? 'srv:' + local.server.trim() : null) : board?.market_source;
  const chartRef = useRef<ChartHandle>(null);
  const { liveBars, setLiveBars, marketSeries, marketInfo, marketLoadError, trackSourceRef, storedTipsRef, liveRef, liveListeners, setMarketRetry, cacheScope, loadedCacheScope, refreshTrackRef } = useMarketHistory({ board, local, backfill, marketView, liveSymbol, connectedTrack, catalogSource, chartRef, forming });
  const [syncProgress, setSyncProgress] = useState<{ scope: string; job: MarketSyncGateJob | null }>({ scope: '', job: null });
  const rangeSync = useLocalRangeSync();
  const syncScope = `${cacheScope}:${localConnected ? 'synctrade' : 'syncnote'}`;
  const receiveSyncJob = (job: MarketSyncGateJob | null) => setSyncProgress({ scope: syncScope, job });
  const getLocalSyncContext = async () => {
    const terminal = localTerminal.getSnapshot();
    const user = board?.user.id;
    if (!user || terminal.phase !== 'connected') throw new Error('请先连接本机 SyncTrade。');
    const account_key = await historyAccountKey(terminal.server, terminal.account_id);
    const current = localTerminal.getSnapshot();
    if (current.phase !== 'connected' || current.epoch !== terminal.epoch || current.account_id !== terminal.account_id || current.server !== terminal.server || current.symbol !== terminal.symbol) throw new Error('本机账户或品种已改变，请重新选择同步。');
    return { website_user_id: user, account: terminal.account_id, server: terminal.server, account_key, clock_sample: current.clock_sample,
      quote_symbol: current.symbol, quote_sessions: current.quote_sessions };
  };
  const chooseSymbol = async (symbol: string) => {
    // 「商品代码」不同步时，品种只换当前激活的那一格：一格黄金、一格纳指这种对照。
    if (syncs.symbol === false) {
      const cellId = chartRef.current?.activeCellId?.() ?? null;
      if (cellId) {
        await chartRef.current?.setCellSymbol?.(cellId, symbol);
        setError('');
        return;
      }
    }
    if (localConnected) await localTerminal.selectSymbol(symbol);
    else setStoredSymbol(symbol);
    showLatestChart();
    setError('');
  };
  const liveProvider = useMemo(
    () => new LiveProvider(liveRef.current, liveSymbol, (listener) => {
      liveListeners.current.add(listener);
      return () => liveListeners.current.delete(listener);
    }),
    [liveSymbol],
  );

  const [replayActive, setReplayActive] = useState(false);
  /** 右栏停靠时给工具条算出的宽度：让它的右边界和图表右边界严格对齐。 */
  const [toolbarWidth, setToolbarWidth] = useState<number | null>(null);
  /** 图表样式（Vela 的样式按钮被我们换成自己的下拉，避免悬停就收）。 */
  const [priceStyle, setPriceStyle] = useState<PriceStyle>('candles');
  useEffect(() => {
    const read = () => {
      const next = chartRef.current?.getPriceStyle?.();
      if (next) setPriceStyle(next as PriceStyle);
    };
    read();
    const timer = window.setInterval(read, 1500);
    return () => window.clearInterval(timer);
  }, []);
  const [toolbarActionInset, setToolbarActionInset] = useState(8);
  /** 回放「选起点」状态 + 鼠标横坐标：用来把选择线右侧的 K 线压成半透明。 */
  const [replayArmed, setReplayArmed] = useState(false);
  const [ghostX, setGhostX] = useState<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  /** 拖动补段的滑动窗口：每个基础周期当前已加载的 K 线（秒）与范围（毫秒）。 */
  const seriesRef = useRef<ReviewCharts>({});
  const reviewListeners = useRef(new Set<() => void>());
  const reviewTips = useRef<Partial<Record<BaseTimeframe, number>>>({});
  const reviewCacheKey = useRef('');
  const activeReviewKey = useRef('');
  const windowRef = useRef<Record<string, { from: number; to: number }>>({});
  const fetchingRef = useRef<Set<string>>(new Set());
  const reviewEpochRef = useRef(0);
  /** 某一边已经没有更早/更新的数据时，60 秒内不再追问（避免拖到尽头后每次事件都发请求）。 */
  const edgeBlockRef = useRef<Record<string, number>>({});
  /** 补段要知道“现在看的是哪笔/哪个品种”，放 ref 避免回调拿到旧值。 */
  const ctxRef = useRef<ReviewScope & { symbol: string; cutoff?: number | null }>({ shareId: null, symbol: 'XAUUSD' });

  /* ------------------------------------------------- 仅在显式打开复盘时定位交易 */

  useEffect(() => {
    if (!board || target || shareId) return;
    const route = new URLSearchParams(location.search);
    if (route.get('view') === 'live') return;
    const ticketParam = route.get('ticket');
    const personParam = route.get('person') || board.user.id;
    const tParam = Number(route.get('t') || 0) || undefined;
    const open = (person: string, ticket: string, t?: number) => {
      setTarget({ person, ticket, t });
      setMode('review');
      setTab('review');
    };
    if (route.get('note')) { setTarget({ person: personParam, ticket: '', note: route.get('note')! }); setMode('review'); setTab('review'); }
    else if (ticketParam) open(personParam, ticketParam, tParam);
  }, [board, target, shareId]);

  /* --------------------------------------------------------- 复盘数据加载 */

  useEffect(() => {
    if (!target && shareId == null) return;
    let alive = true;
    let timer: number | null = null;
    let hydrated = false;
    const url = shareId != null
      ? `/api/chart/entry?share=${shareId}`
      : target?.note ? '/api/chart/entry?note=' + encodeURIComponent(target.note)
      : `/api/chart/entry?person=${encodeURIComponent(target!.person)}&ticket=${encodeURIComponent(target!.ticket)}`;
    const run = async () => {
      try {
        const data = await api<Entry>(url);
        if (!alive) return;
        setEntry(data);
        if (!hydrated) setNote(data.note ? { body: data.note.body, tags: [...data.note.tags], sections: data.note.sections ?? [] } : { body: '', tags: [], sections: [] });
        hydrated = true;
        setError('');
        // 按消息打开时，target 由服务端返回的归属交易补上（用于标题、分享卡片和重挂载 key）。
        const ticket = String(data.review?.trade?.ticket ?? '');
        if (shareId != null && !target && ticket) setTarget({ person: data.owner.id, ticket });
        if (shareId == null && target?.ticket && data.note_id && !ticket) {
          setTarget({ person: data.owner.id, ticket: '', note: data.note_id });
          history.replaceState(null, '', '/chart?view=review&note=' + data.note_id);
        }
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

  /* 刷新/后退/forward 时从 URL 还原视图，而不是只认第一次的 location.search。 */
  useEffect(() => {
    const onPop = () => {
      const next = new URLSearchParams(location.search);
      if (next.get('view') === 'live') {
        setShareId(null);
        setTarget(null);
        setMode('live');
        return;
      }
      const share = next.get('share');
      if (share && /^\d+$/.test(share)) {
        setShareId(Number(share));
        setTarget(null);
        setMode('review');
        setTab('review');
        return;
      }
      setShareId(null);
      if (next.get('note')) { setTarget({ person: board?.user.id || '', ticket: '', note: next.get('note')! }); setMode('review'); setTab('review'); return; }
      const ticket = next.get('ticket');
      if (ticket) {
        setTarget({ person: next.get('person') || board?.user.id || '', ticket, t: Number(next.get('t') || 0) || undefined });
        setMode('review');
        setTab('review');
        return;
      }
      setTarget(null);
      setEntry(null);
      const review = next.get('view') === 'review';
      setMode(review ? 'review' : 'live');
      if (review) setTab('review');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [board?.user.id]);

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
      const view = chartRef.current?.view();
      saveTimer.current = window.setTimeout(async () => {
        setSaveState('saving');
        try {
          if (entry.note_id) {
            await api('/api/notes', { id: entry.note_id, document, ...(view && entry.scene ? { scene: { ...entry.scene, ...view } } : {}) });
          }
          else await api('/api/chart/state', { ticket: target.ticket, state: document });
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
      || JSON.stringify(note.tags) !== JSON.stringify(entry.note?.tags || [])
      || JSON.stringify(note.sections) !== JSON.stringify(entry.note?.sections || [])),
  );

  const hasUnsavedNote = noteDirty();
  useEffect(() => {
    if (!hasUnsavedNote || localConnected) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedNote, localConnected]);

  const confirmLeaveNote = () => !noteDirty() || window.confirm('笔记还没保存，确定要离开吗？');

  const showLatestChart = () => {
    if (!confirmLeaveNote()) return;
    chartRef.current?.flush();
    setEntry(null); setTarget(null); setShareId(null);
    setMode('live');
    const qs = new URLSearchParams(location.search);
    for (const key of ['share', 'person', 'ticket', 'note', 't']) qs.delete(key);
    qs.set('view', 'live');
    history.replaceState(null, '', '/chart?' + qs.toString());
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
    setNote({ body: '', tags: [], sections: [] });
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
    setNote({ body: '', tags: [], sections: [] });
    setNoteState('idle');
    setSaveState('idle');
    setShareRequest(null);
    history.replaceState(null, '', '/chart?view=review&share=' + row.id);
  };

  const openNote = (id: string) => {
    if (!confirmLeaveNote()) return;
    chartRef.current?.flush();
    setEntry(null); setShareId(null); setTarget({ person: board!.user.id, ticket: '', note: id });
    setMode('review'); setTab('review'); setRailOpen(true); setNoteState('idle'); setSaveState('idle'); setShareRequest(null);
    history.replaceState(null, '', '/chart?view=review&note=' + encodeURIComponent(id));
  };
  const captureScene = () => {
    const view = chartRef.current?.view();
    if (!view) return null;
    return { ...view, source: tradeReview ? entry?.review.market_source : liveTrack, symbol: tradeReview ? entry?.review.trade.symbol : liveSymbol };
  };
  const createNote = async () => {
    if (creatingNote || !confirmLeaveNote()) return;
    const scene = captureScene();
    if (!scene?.source || !scene.symbol) { setError('图表准备好后，即可开始复盘。'); return; }
    chartRef.current?.replayPause();
    setCreatingNote(true);
    try {
      const result = await api<{ note: { id: string } }>('/api/notes', { scene, document: scene.document, body: '', tags: [], sections: [] });
      setNote({ body: '', tags: [], sections: [] });
      setEntry(null); setShareId(null); setTarget({ person: board!.user.id, ticket: '', note: result.note.id });
      setMode('review'); setTab('review'); setRailOpen(true); setNotesRevision(n => n + 1);
      history.replaceState(null, '', '/chart?view=review&note=' + result.note.id);
    } catch (error) { setError(String(error)); }
    finally { setCreatingNote(false); }
  };
  const saveNote = async () => {
    if (!entry || entry.read_only || !entry.note_id) return;
    const id = entry.note_id;
    const snapshot = structuredClone(noteRef.current);
    const scene = captureScene();
    setNoteState('saving');
    try {
      const result = await api<{ note: NonNullable<Entry['note']> }>('/api/notes', { id, ...snapshot, ...(scene ? { scene, document: scene.document } : {}) });
      setEntry(prev => prev?.note_id === id ? { ...prev, note: result.note } : prev);
      if (ctxRef.current.noteId !== id) return;
      const unchanged = JSON.stringify(noteRef.current) === JSON.stringify(snapshot);
      if (unchanged) setNote({ body: result.note.body, tags: result.note.tags, sections: result.note.sections ?? [] });
      setNoteState(unchanged ? 'saved' : 'idle');
      setNotesRevision(n => n + 1);
    } catch (error) { setNoteState('error'); setError(String(error)); }
  };
  useEffect(() => {
    if (!hasUnsavedNote || noteState === 'saving' || noteState === 'error' || !entry?.note_id || entry.read_only) return;
    const timer = window.setTimeout(() => void saveNote(), 1200);
    return () => window.clearTimeout(timer);
  }, [note, entry?.note_id, hasUnsavedNote, noteState]);
  const openReviewShare = (initialRecipient?: { kind: 'dm' | 'group'; id: string }) => {
    if (!entry || entry.read_only || !entry.note_id) return;
    const snapshot = captureScene();
    if (!snapshot) { setError('图表还在加载，请稍后分享'); return; }
    chartRef.current?.replayPause();
    setShareRequest({ ticket: String(entry.review.trade.ticket || ''), note_id: entry.note_id, note: structuredClone(noteRef.current), snapshot, initialRecipient });
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
  const reviewingOther = tradeReview && Boolean(target?.person && target.person !== me?.id);
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
  const liveSeries = loadedCacheScope === cacheScope ? liveBars ?? marketSeries : null;
  const liveTrack = connectedTrack || marketInfo?.source || '';
  const latestChartBar = liveSeries?.[TIMEFRAMES[tf]?.base ?? 'M15']?.at(-1)?.[0];
  const staleMarket = marketView && !localConnected && latestChartBar != null &&
    Date.now() - latestChartBar * 1000 > 72 * 3600_000;
  const [series, setSeries] = useState<ReviewCharts | null>(null);
  const [reviewAvailability, setReviewAvailability] = useState(0);
  const [reviewLoadedKey, setReviewLoadedKey] = useState('');
  const reviewSymbol = entry?.review.trade?.symbol as string | undefined;
  const reviewSource = entry?.review.market_source;
  const formingSource = tradeReview ? reviewSource : connectedTrack;
  const formingSymbol = tradeReview ? reviewSymbol : liveSymbol;
  useEffect(() => {
    setForming(null);
    if (localConnected || !formingSource || !formingSymbol || board?.market_source !== formingSource) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ source: formingSource, symbol: formingSymbol });
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await api<NonNullable<typeof forming>>('/api/market/forming-bars?' + query, undefined, { signal: controller.signal });
        if (controller.signal.aborted || next.source !== formingSource || next.symbol !== formingSymbol) return;
        setForming(previous => previous?.source === next.source && previous.symbol === next.symbol &&
          JSON.stringify(previous.bars) === JSON.stringify(next.bars) ? previous : next);
      } catch {
        // Stored candles remain available during transient quote errors.
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [localConnected, formingSource, formingSymbol, board?.user.id, board?.market_source]);

  const entryMatchesTarget = entry && (shareId != null
    ? entry.share?.id === shareId
    : entry.owner.id === target?.person && (target.note ? entry.note_id === target.note : String(entry.review.trade.ticket) === target.ticket));
  const reviewKey = entryMatchesTarget && entry && reviewSymbol
    ? JSON.stringify([board?.user.id, entry.owner.id, entry.note_id || entry.review.trade.ticket, shareId, reviewSource, reviewSymbol])
    : '';
  activeReviewKey.current = tradeReview ? reviewKey : '';
  const reviewProvider = useMemo(() => series && reviewSymbol ? new LiveProvider(series, reviewSymbol, listener => {
    reviewListeners.current.add(listener);
    return () => { reviewListeners.current.delete(listener); };
  }) : undefined, [series, reviewSymbol]);
  const availableTfs = useMemo(() => {
    if (marketView) return TIMEFRAME_OPTIONS;
    const charts = series ?? entry?.review.charts ?? {};
    return TIMEFRAME_OPTIONS.filter(option => {
      const rows = charts[TIMEFRAMES[option.id].base];
      if (!rows || rows.length < 2) return false;
      if (option.id === '30' || option.id === '240') return rows.length >= 4;
      if (option.id === '1D') return rows.length >= 24;
      return true;
    });
  }, [entry, marketView, series, reviewAvailability]);
  const ready = Boolean(reviewKey && (!entry?.scene?.replay_ms || reviewLoadedKey === reviewKey) && reviewCacheKey.current === reviewKey && series && Object.values(series).some(rows => rows?.length));
  const anchorSeconds = entry?.share?.anchor_ms
    ? Math.round(entry.share.anchor_ms / 1000)
    : (entry?.scene?.anchor_ms ? entry.scene.anchor_ms / 1000 : entry?.review.opened ?? (entry?.review.trade?.closed as number | undefined) ?? null);

  ctxRef.current = {
    shareId,
    noteId: entry?.note_id,
    cutoff: entry?.read_only ? entry.scene?.replay_ms : null,
    person: target?.person,
    ticket: target?.ticket,
    source: tradeReview ? reviewSource : undefined,
    symbol: tradeReview ? (reviewSymbol || 'XAUUSD') : liveSymbol,
  };

  const updateReviewSeries = useCallback(async (base: BaseTimeframe, rows: number[][], streaming = false, followTail = false) => {
    const cutoff = ctxRef.current.cutoff;
    if (cutoff) rows = rows.filter(row => (row[0] + TF_SECONDS[base]) * 1000 <= cutoff);
    if (!rows.length) return;
    const cache = seriesRef.current;
    const previous = cache[base] ?? [];
    const previousLength = previous.length;
    let merged: number[][];
    if (streaming) {
      mergeLiveHistory(cache, { [base]: rows });
      merged = cache[base]!;
    } else {
      merged = mergeReviewBars(previous, rows);
      if (merged === previous) return;
    }
    cache[base] = merged;
    windowRef.current[base] = { from: merged[0][0] * 1000, to: merged[merged.length - 1][0] * 1000 };
    setSeries(cache);
    if ([2, 4, 24].some(count => previousLength < count && merged.length >= count)) {
      setReviewAvailability(version => version + 1);
    }
    const replay = chartRef.current?.replayStatus();
    if (streaming && !(replay?.active || replay?.armed || replay?.busy)) return;
    await chartRef.current?.applySeries(base, merged, undefined, true, followTail);
  }, []);

  const loadWindow = useCallback(async (
    base: BaseTimeframe, direction: ReviewDirection | 'head' | 'range' | 'gap', range?: { from: number; to: number },
  ) => {
    const epoch = reviewEpochRef.current;
    const cacheKey = reviewCacheKey.current;
    const valid = () => epoch === reviewEpochRef.current && cacheKey === activeReviewKey.current;
    const key = `${epoch}:${base}`;
    const gapKey = direction === 'gap' && range ? `gap:${base}:${range.from}:${range.to}` : '';
    if (gapKey && (edgeBlockRef.current[gapKey] ?? 0) > Date.now()) return null;
    if (fetchingRef.current.has(key)) return null;
    const scope = { ...ctxRef.current };
    const replay = chartRef.current?.replayStatus();
    if (!scope.source || !cacheKey || !valid() || replay?.active || replay?.armed || replay?.busy) return null;
    fetchingRef.current.add(key);
    try {
      let data;
      if (direction === 'range' && range) {
        data = await readReviewRange(api, scope, base, range.from, range.to);
      } else if (direction === 'gap' && range) {
        const page = await readReviewPage(api, scope, base, 'right', [[range.from]]);
        data = { ...page, bars: page.bars.filter(row => row[0] < range.to) };
        if (valid() && !data.bars.length) edgeBlockRef.current[gapKey] = Date.now() + 60000;
      } else if (direction === 'head') {
        const tip = reviewTips.current[base];
        data = await readReviewPage(api, scope, base, 'latest', [], tip === undefined ? MARKET_LIMIT[base] : 2);
        if (!valid()) return null;
        // Catch up by actual bars when multiple candles landed between polls.
        if (tip !== undefined && (data.bars[0]?.[0] ?? tip) > tip + TF_SECONDS[base]) {
          data = await readReviewPage(api, scope, base, 'right', [[tip]]);
        }
      } else if (direction !== 'range' && direction !== 'gap') {
        data = await readReviewPage(api, scope, base, direction, seriesRef.current[base] ?? []);
      }
      if (!valid() || !data) return null;
      const newest = data.bars.at(-1)?.[0];
      if (direction === 'head' || direction === 'latest') {
        if (newest !== undefined) reviewTips.current[base] = Math.max(reviewTips.current[base] ?? 0, newest);
      }
      if (direction === 'left' || direction === 'right') {
        if (!data.bars.length || data.has_more === false) edgeBlockRef.current[base + ':' + direction] = Date.now() + 60000;
      }
      await updateReviewSeries(base, data.bars, false, direction === 'head' || direction === 'latest');
      return valid() ? newest ?? null : null;
    } catch {
      if (valid()) edgeBlockRef.current[gapKey || base + ':' + direction] = Date.now() + 15000;
      return null;
    } finally {
      fetchingRef.current.delete(key);
    }
  }, [updateReviewSeries]);

  // A review is a view of the trade's broker track, with the original snapshot as a seed.
  useEffect(() => {
    const epoch = ++reviewEpochRef.current;
    reviewCacheKey.current = reviewKey;
    setSeries(null);
    seriesRef.current = {};
    windowRef.current = {};
    reviewTips.current = {};
    fetchingRef.current.clear();
    edgeBlockRef.current = {};
    if (!tradeReview || !reviewKey) return;
    if (reviewSource && trackSourceRef.current === reviewSource && liveSymbol === reviewSymbol && loadedCacheScope === cacheScope) {
      for (const base of REVIEW_BASE_TFS) {
        const tip = storedTipsRef.current[base];
        if (tip !== undefined) void updateReviewSeries(base, (liveRef.current[base] ?? []).filter(row => row[0] <= tip), true);
      }
    }
    if (!reviewSource) return;
    let alive = true;
    const anchor = anchorSeconds ?? Math.floor(Date.now() / 1000);
    const refresh = () => {
      if (alive) void Promise.all(REVIEW_BASE_TFS.map(base => loadWindow(base, 'head')));
    };
    const initial = REVIEW_BASE_TFS.map(async base => {
      const [before, after] = REVIEW_WINDOW[base];
      await loadWindow(base, 'range', { from: anchor - before * 86400, to: anchor + after * 86400 });
      if (alive && epoch === reviewEpochRef.current) await loadWindow(base, 'head');
    });
    let timer: number | undefined;
    void Promise.allSettled(initial).then(() => {
      if (alive) { setReviewLoadedKey(reviewKey); timer = window.setInterval(refresh, MARKET_HEAD_POLL_MS); }
    });
    // Keep a visible historical window current when the server fills an older gap.
    const historyTimer = window.setInterval(() => {
      const ranges = Object.values(chartRef.current?.captureRanges() ?? {});
      for (const range of ranges) {
        const period = TF_SECONDS[range.base];
        const from = Math.floor(range.from / 1000);
        const to = Math.ceil(range.to / 1000);
        if (to > from && to - from <= 4000 * period) void loadWindow(range.base, 'range', { from, to });
        else {
          const gap = visibleReviewGap(seriesRef.current[range.base] ?? [], from, to, period);
          if (gap) void loadWindow(range.base, 'gap', gap);
        }
      }
    }, 31000);
    return () => {
      alive = false;
      reviewEpochRef.current += 1;
      window.clearInterval(timer);
      window.clearInterval(historyTimer);
    };
  }, [tradeReview, reviewKey, loadWindow, updateReviewSeries]);

  const reviewSnapshot = entry?.review.status === 'ready' ? entry.review.charts : undefined;
  useEffect(() => {
    if (!tradeReview || !reviewKey || !reviewSnapshot) return;
    for (const base of REVIEW_BASE_TFS) {
      const seed = reviewSnapshot[base];
      if (!seed?.length) continue;
      const current = seriesRef.current[base] ?? [];
      const merged = mergeReviewBars(seed, current);
      void updateReviewSeries(base, merged).catch(error => console.warn('[review] 快照合并失败', error));
    }
  }, [tradeReview, reviewKey, reviewSnapshot, updateReviewSeries]);

  useEffect(() => {
    if (!tradeReview || !reviewKey || !reviewSource || !reviewSymbol) return;
    const cloud = forming?.source === reviewSource && forming.symbol === reviewSymbol ? forming.bars : null;
    if (localConnected ? reviewSource !== connectedTrack || reviewSymbol !== local.symbol : !cloud) return;
    const incoming = localConnected ? toChartBars(local.bars) : { ...cloud };
    const chart = chartRef.current;
    let ranges: ReturnType<ChartHandle['captureRanges']> | undefined;
    const frozen: Record<string, { from: number; to: number }> = {};
    let changed = false;
    for (const base of REVIEW_BASE_TFS) {
      const next = incoming[base]?.at(-1);
      if (!next || next[0] <= (reviewTips.current[base] ?? 0)) continue;
      const old = seriesRef.current[base]?.at(-1);
      if (old && (old[0] > next[0] || (old.length === next.length && old.every((v, i) => v === next[i])))) continue;
      if (old && next[0] > old[0]) {
        ranges ??= chart?.captureRanges() ?? {};
        for (const [id, range] of Object.entries(ranges)) {
          if (range.base === base && range.to < (old[0] - 8 * TF_SECONDS[base]) * 1000) frozen[id] = range;
        }
      }
      changed = true;
      void updateReviewSeries(base, [next], true);
    }
    if (changed) reviewListeners.current.forEach(listener => listener());
    if (Object.keys(frozen).length) requestAnimationFrame(() => {
      if (chartRef.current === chart) chart?.restoreRanges(frozen);
    });
  }, [tradeReview, reviewKey, reviewSource, reviewSymbol, localConnected, connectedTrack, local.symbol, local.bars, forming, updateReviewSeries]);

  const loadIndicatorMinutes = async (endMs: number, count: number): Promise<number[][]> => {
    if (tradeReview) return readIndicatorMinutes(api, { review: { ...ctxRef.current } }, endMs, count);
    if (!marketInfo?.source) return [];
    return readIndicatorMinutes(api, { source: marketInfo.source, symbol: liveSymbol }, endMs, count);
  };

  /** 实时图分页：同周期只允许一个在途请求；暂时无数据时短暂退避，不认定历史到底。 */
  const livePagingRef = useRef<Set<string>>(new Set());
  const liveFloorRef = useRef<Record<string, number>>({});
  const liveScopeRef = useRef('');
  liveScopeRef.current = `${marketView}:${marketInfo?.source ?? ''}:${liveSymbol}`;
  const liveOlder = useCallback(async (base: BaseTimeframe, manual = false) => {
    const replay = chartRef.current?.replayStatus(); if (replay?.active || replay?.armed || replay?.busy) return;
    const source = trackSourceRef.current;
    if (!marketView || !source || livePagingRef.current.has(base)) return;
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
  }, [marketView, liveSymbol]);

  /** 轨道首屏就绪后，每个周期预取一页；离线也能继续向左翻。 */
  const prefetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!marketView || !marketInfo?.source || !liveBars || prefetchedRef.current === marketInfo.source) return;
    prefetchedRef.current = marketInfo.source;
    const bases: BaseTimeframe[] = ['M1', 'M5', 'M15', 'H1'];
    void (async () => {
      for (const base of bases) {
        if (!liveRef.current[base]?.length) continue;
        await liveOlder(base).catch(() => undefined);
      }
    })();
  }, [marketView, marketInfo?.source, liveBars, liveOlder]);
  useEffect(() => {
    // 切换轨道后重新允许预取
    liveFloorRef.current = {};
  }, [marketInfo?.source]);

  // 历史通道可能正在回填。可见左边缘仍缺数据时自动重试，不要求用户再拖一下。
  useEffect(() => {
    if (!marketView || !marketInfo?.source) return;
    const timer = window.setInterval(() => {
      for (const range of Object.values(chartRef.current?.captureRanges() ?? {})) {
        const first = liveRef.current[range.base]?.[0]?.[0];
        if (first === undefined) continue;
        const span = Math.max(60_000, range.to - range.from);
        if (range.from - first * 1000 < span * 1.5) void liveOlder(range.base);
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [marketView, marketInfo?.source, liveOlder]);

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

  useEffect(() => {
    const rail = document.querySelector('.rail') as HTMLElement | null;
    const chart = document.querySelector('.chart-pane') as HTMLElement | null;
    if (!rail || !chart) return;
    const toolbar = document.querySelector('.chart-toolbar') as HTMLElement | null;
    const measure = () => {
      const position = getComputedStyle(rail).position;
      const docked = position !== 'absolute' && position !== 'fixed';
      if (!docked || !toolbar) { setToolbarWidth(null); return; }
      const chartRight = chart.getBoundingClientRect().right;
      const left = toolbar.getBoundingClientRect().left;
      // The toolbar's right border is inside its box; the rail's left border
      // starts at chartRight. Align the painted lines, not their outer edges.
      const width = chartRight - left + parseFloat(getComputedStyle(toolbar).borderRightWidth);
      const actions = document.querySelector('.top-actions') as HTMLElement | null;
      const header = toolbar.parentElement!;
      header.style.setProperty('--toolbar-hairline', `${1 / (window.devicePixelRatio || 1)}px`);
      const actionsLeft = header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight) - (actions?.getBoundingClientRect().width ?? 0);
      setToolbarActionInset(Math.max(8, Math.ceil(chartRight - actionsLeft + 10)));
      setToolbarWidth(width > 120 ? width : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    observer.observe(chart);
    for (const element of document.querySelectorAll('.unified-topbar .status-row, .unified-topbar .top-actions')) observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [!!board, railOpen, tab, narrow, layout]);

  const handleViewport = useCallback((info: { cellId: string; timeframe: string; from: number; to: number }) => {
    const replay = chartRef.current?.replayStatus(); if (replay?.active || replay?.armed || replay?.busy) return;
    const recipe = TIMEFRAMES[info.timeframe];
    if (!recipe) return;
    const base = recipe.base;
    const spanMs = Math.max(60_000, info.to - info.from);
    // 实时模式：翻到最左边就把更早的一段补进来（每次 ~1990 根）。
    if (marketView) {
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
    } else {
      const gap = visibleReviewGap(seriesRef.current[base] ?? [], info.from / 1000, info.to / 1000, TF_SECONDS[base]);
      if (gap) void loadWindow(base, 'gap', gap);
    }

  }, [loadWindow, marketView, liveOlder]);

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
    const shared = entry?.share?.anchor_ms ?? entry?.scene?.anchor_ms ?? null;
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
      <header className={`topbar unified-topbar${toolbarWidth ? ' toolbar-aligned' : ''}`}>
        <a className="brand" href="/">
          <span className="mark">▥</span> 同频 <small>交易台</small>
        </a>
        <div className="status-row" title={reviewingOther ? '正在复盘的是别人的交易；账户数字已隐藏，避免和对方混淆' : '我的账户'}>
          {syncs.symbol === false ? <span className="symbol-scope-hint" title="商品代码不同步：选中的品种只作用于当前激活的那一格">仅当前格</span> : null}
          <SymbolPicker symbol={tradeReview ? trade.symbol || 'XAUUSD' : liveSymbol} symbols={symbolOptions} loading={symbolsLoading} disabled={local.symbol_switching} error={symbolsError} contextNote={tradeReview ? '选择品种后打开行情，当前复盘记录保留。' : !localConnected && !catalogAvailable ? '当前仅列出已有行情；更新并运行 SyncNote 1.015 后可同步券商品种目录。' : undefined} onSelect={chooseSymbol} onOpen={() => setCatalogRevision((revision) => revision + 1)} />
        </div>
        <div
          className="chart-toolbar unified-chart-tools"
          style={toolbarWidth ? { flex: '0 0 auto', width: `${toolbarWidth}px`, paddingRight: toolbarActionInset } : undefined}
        >
          <span className="toolbar-separator" aria-hidden="true" />
          <TfMenu disabled={replayActive} current={tf} options={availableTfs} scopeAll={Boolean(syncs.timeframe)} onPick={(id) => { chartRef.current?.setTimeframe(id); setTf(id); }} />
          <LayoutMenu disabled={replayActive} compact current={layout} onPick={(id) => { chartRef.current?.setLayout(id); setLayout(id); }} syncs={syncs} onToggleSync={toggleSync} />
          <StyleMenu
            current={priceStyle}
            onPick={(id) => {
              setPriceStyle(id);
              chartRef.current?.setPriceStyle(id);
            }}
          />
          <div className="native-chart-tools" ref={setNativeToolbarHost} />
          <DrawingFavs
            favorites={favs}
            active={activeTool}
            onUse={(key) => {
              chartRef.current?.useTool(key);
              setActiveTool((prev) => (prev === key ? null : key));
            }}
          />
          <span className="toolbar-separator" aria-hidden="true" />
          <span className="chart-view-actions" role="group" aria-label="图表视图">
            <button type="button" className="tool-btn" disabled={creatingNote} onClick={() => void createNote()}>开始复盘</button>
            {tradeReview && !replayActive ? (
              <button type="button" className="tool-btn" onClick={showLatestChart}><ToolbarIcon name="live" />回到最新</button>
            ) : null}
            <button
              type="button"
              className={`tool-btn ${replayActive ? 'is-active' : ''}`.trim()}
              aria-pressed={replayActive}
              title={replayActive ? '重新选择回放起点' : '在历史 K 线上逐根回放'}
              onClick={() => chartRef.current?.replaySelect()}
            >
              <ToolbarIcon name="replay" />回放
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
                const rows = (marketView ? liveRef.current[base!] : seriesRef.current[base!]) ?? [];
                if (rows.length < 10) throw new Error('还没有可回放的 K 线');
                const pick = rows[Math.floor(Math.random() * rows.length)][0];
                await chartRef.current?.replayStartAt(pick * 1000);
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
                  await chartRef.current?.replayStartAt(first * 1000);
                  return;
                }
              }
              throw new Error('随机到的区间暂时没有 K 线，请再试一次');
            }}
            onEarliest={async () => {
              // 将最早一根直接交给回放控制器，按各周期共同历史边界对齐。
              const base = TIMEFRAMES[tf]?.base;
              const rows = (marketView ? liveRef.current[base] : seriesRef.current[base]) ?? [];
              const first = rows[0]?.[0];
              if (!first) throw new Error('当前周期还没有可回放的历史');
              await chartRef.current?.replayStartAt(first * 1000);
            }}
          />
          <span className="spacer" />
          <span className="save-hint" role="status" aria-live="polite">
            {saveState === 'saving' ? '保存画线…' : saveState === 'saved' ? '画线已保存' : saveState === 'error' ? '画线保存失败' : ''}
          </span>
        </div>

        <nav className="top-actions">
          <MT5Connection state={local} open={mt5ConnectionOpen} onOpen={() => setMT5ConnectionOpen(true)} onClose={() => setMT5ConnectionOpen(false)} />
          <a href="/history" target="_blank" rel="noopener noreferrer" aria-label="交易日历（新标签页）" title="交易日历：新标签页打开，保留本机 EA 连接"><ToolbarIcon name="calendar" /><span className="action-label">交易日历</span></a>
          <span className="toolbar-separator" aria-hidden="true" />
          <FullscreenButton />
          <SettingsMenu name={me?.nickname || '账户'} />
        </nav>
      </header>

      {/* ---------------------------------------------------------- 主体 */}
      <div className={`main ${railOpen ? '' : 'rail-closed'}`}>
        <section className="chart-pane">
          {tradeReview && entry?.read_only ? (
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
              <b>{backfill.phase === 'error' ? '近期行情补齐失败' : '近期行情覆盖待确认'}</b><span>{backfill.message}</span>
              <button type="button" className="link" onClick={() => void backfillBars.start()}>重新检查</button>
            </div>
          ) : staleMarket ? (
            <div className="context-banner sync-status" role="status">
              <b>当前轨道的行情较旧</b><span>最新可用 K 线：{stamp(latestChartBar)}</span>
              <button type="button" className="link" onClick={() => setMT5ConnectionOpen(true)}>连接 MT5</button>
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
            {marketView && liveSeries ? (
              <ChartWorkspace
                key={`market:${cacheScope}:${liveTrack}`}
                ref={chartRef}
                toolbarHost={nativeToolbarHost}
                loadIndicatorMinutes={loadIndicatorMinutes}
                forceLayout={narrow ? '1' : undefined}
                charts={liveRef.current}
                provider={liveProvider}
                providerName={trackProviderName(liveTrack || cacheScope)}
                symbol={liveSymbol}
                anchorMs={0}
                savedState={null}
                readOnly={false}
                timeframes={TIMEFRAME_OPTIONS.map((o) => o.id)}
                positionLevels={(mode === 'live' ? myPositions : []).filter((position: any) => !liveSymbol || position.symbol === liveSymbol).map((position: any) => ({
                  ticket: String(position.ticket),
                  side: position.side,
                  entry: Number(position.price_open ?? position.open ?? 0),
                  sl: Number(position.sl ?? 0) || null,
                  tp: Number(position.tp ?? 0) || null,
                  volume: Number(position.volume ?? 0),
                }))}
                onLevelDrag={(ticket, field, price) => {
                  const revert = () => { try { chartRef.current?.syncPositionLevels(); } catch { /* 忽略 */ } };
                  if (!localConnected) { setError('本机 EA 未连接，无法修改止损止盈。'); revert(); return; }
                  const position = myPositions.find((row: any) => String(row.ticket) === String(ticket));
                  if (!position) { revert(); return; }
                  const current = Number(position[field] ?? 0);
                  if (Number.isFinite(current) && Math.abs(current - price) < 1e-6) return;
                  let commandId = '';
                  try {
                    commandId = localTerminal.command('modify', {
                      ticket: String(ticket),
                      sl: field === 'sl' ? price : Number(position.sl ?? 0) || 0,
                      tp: field === 'tp' ? price : Number(position.tp ?? 0) || 0,
                    });
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                    revert();
                    return;
                  }
                  // 等 EA 回报：被拒或超时就把线拉回原价，避免图上留下一个不存在的止损。
                  const started = Date.now();
                  const watch = () => {
                    const command = localTerminal.getSnapshot().commands.find((row: any) => row.command_id === commandId);
                    const state = command?.state ?? '';
                    if (state === 'completed') return;
                    if (state === 'uncertain') { setError('改单结果待核实，请到 MT5 确认后再拖一次。'); return; }
                    if (state === 'rejected' || state === 'not_found') {
                      setError(command?.error || 'EA 拒绝了这次改单，止损止盈保持原值。');
                      revert();
                      return;
                    }
                    if (Date.now() - started > 12000) {
                      setError('改单等待超时，请到 MT5 核实；图上已恢复原值。');
                      revert();
                      return;
                    }
                    window.setTimeout(watch, 300);
                  };
                  window.setTimeout(watch, 250);
                }}
              favorites={favs}
                onFavorites={saveFavorites}
                onTool={setActiveTool}
                onTimeframe={setTf}
                onLayout={setLayout}
                onSyncs={setSyncs}
                onError={setError}
                onViewport={handleViewport}
              />
            ) : tradeReview && ready && series ? (
              <ChartWorkspace
                key={reviewKey}
                ref={chartRef}
                toolbarHost={nativeToolbarHost}
                forceLayout={narrow ? '1' : undefined}
                charts={series}
                provider={reviewProvider}
                providerName={trackProviderName('review:' + reviewKey)}
                loadIndicatorMinutes={loadIndicatorMinutes}
                symbol={trade.symbol || 'XAUUSD'}
                anchorMs={anchorMs}
                savedState={entry!.chart?.document ?? null}
                initialScene={entry!.scene ?? undefined}
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
                  {marketView
                    ? (syncProgress.scope === syncScope && (syncProgress.job?.status === 'waiting' || syncProgress.job?.status === 'running') ? `${liveSymbol} 正在同步 K 线，收到首批数据后自动显示` : syncProgress.scope === syncScope && syncProgress.job?.status === 'partial' ? `${liveSymbol} 部分行情尚未获取` : symbolOptions.find((item) => item.symbol === liveSymbol)?.has_bars === false ? `${liveSymbol} 尚未同步 K 线` : '正在检查行情同步状态…')
                    : (ready ? '正在读取服务器复盘历史…' : entry?.review.status === 'pending' ? '等待 MT5 上传这笔交易的 K 线…' : entry?.review.error || '参考行情准备中…')}
                </p>
                <p className="dim">
                  {marketView
                    ? (localConnected ? '选择区间，通过本机 SyncTrade 读取并上传该品种 K 线，保持网页打开。' : '选择同步区间，由已授权的 SyncNote 获取该品种 K 线，无需更换 MT5 图表。')
                    : (ready ? '无需连接 EA，读取完成后图表会自动出现。' : '同步完成后图表会自动出现。')}
                </p>
                {marketView && marketLoadError ? <p role="status">{marketLoadError}</p> : null}
                {marketView ? <MarketRangeSync key={syncScope} symbol={liveSymbol} transport={localConnected ? 'synctrade' : 'syncnote'} getLocalContext={getLocalSyncContext} onStartLocal={() => localRangeSync.start()} onStopLocal={() => localRangeSync.stop('区间任务已取消。')} localStatus={rangeSync} onJobChange={receiveSyncJob} onUpdated={() => { if (refreshTrackRef.current) refreshTrackRef.current(true); else setMarketRetry((value) => value + 1); }} /> : null}
                <div className="empty-actions">
                  {!localConnected && !(tradeReview && ready) ? (
                    <button type="button" className="tool-btn" onClick={() => { setTab('trade'); setRailOpen(true); setMT5ConnectionOpen(true); }}>连接 MT5</button>
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
                  {!reviewingOther && (localConnected || mt5Online) ? <div className="account-summary" aria-label="账户概况">
                    <span><span className="stat-k">净值</span><b>{money(displayedAccount?.equity)}</b></span>
                    <span><span className="stat-k">余额</span><b>{money(displayedAccount?.balance)}</b></span>
                    <span><span className="stat-k">浮盈</span><b className={floating >= 0 ? 'up' : 'down'}>{money(floating)}</b></span>
                  </div> : null}
                  <LocalTradePanel key={`${local.server}:${local.account_id}:${local.symbol}`} state={local} />
                  {mode === 'live' && liveSeries ? <MarketRangeSync key={syncScope} symbol={liveSymbol} transport={localConnected ? 'synctrade' : 'syncnote'} getLocalContext={getLocalSyncContext} onStartLocal={() => localRangeSync.start()} onStopLocal={() => localRangeSync.stop('区间任务已取消。')} localStatus={rangeSync} onJobChange={receiveSyncJob} onUpdated={() => { if (refreshTrackRef.current) refreshTrackRef.current(true); else setMarketRetry((value) => value + 1); }} /> : null}
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
                  current={entry?.note_id && !entry.read_only ? { ticket: String(trade.ticket || '') } : null}
                  onShareCurrent={openReviewShare}
                  onError={setError}
                  onOpenFriendManager={() => setFriendManager(true)}
                  openGroup={chatGroup}
                  onGroupOpened={() => setChatGroup(null)}
                />
              </div>

              {tab === 'review' ? (
                <div className="pane">
                  <ReviewNotesList revision={notesRevision} open={openNote} />
                  <h3>
                    复盘
                    {trade.ticket ? <small> #{trade.ticket} · {sideText(trade.side)}</small> : null}
                  </h3>
                  {trade.legacy ? <p className="dim">旧版成交摘要，尚未经原始成交完整重建。</p> : null}
                  {entry && tradeReview ? (
                    <>
                      {trade.ticket ? <p className="dim">
                        {money(trade.volume)} 手 · {money(trade.open)} → {money(trade.close)} · 盈亏 <b className={(trade.profit || 0) >= 0 ? 'up' : 'down'}>{money(trade.profit)}</b><br />
                        开仓 {stamp(entry.review.opened)} · 平仓 {stamp(trade.closed)}
                      </p> : <p className="dim">{trade.symbol} · {stamp((entry.scene?.anchor_ms ?? 0) / 1000)} · 图表笔记</p>}
                      {!entry.read_only && entry.note_id && <label className="notebook-target">关联订单（可选）<select value={String(trade.ticket || '')} onChange={async event => {
                        try {
                          await api('/api/notes', { id: entry.note_id, ...noteRef.current, ticket: event.target.value || null });
                          setTarget({ person: entry.owner.id, ticket: '', note: entry.note_id! });
                          history.replaceState(null, '', '/chart?view=review&note=' + entry.note_id);
                          setEntry(await api<Entry>('/api/chart/entry?note=' + entry.note_id));
                        } catch (error) { setError(String(error)); }
                      }}><option value="">不关联订单</option>{myHistory.filter(item => item.symbol === trade.symbol).map(item => <option key={String(item.ticket)} value={String(item.ticket)}>#{String(item.ticket)} · {item.symbol}</option>)}</select></label>}
                      <ReviewNotebook
                        key={entry.note_id || `${entry.owner.id}:${trade.ticket}`}
                        value={note}
                        onChange={next => { setNote(next); setNoteState(state => state === 'saving' ? state : 'idle'); }}
                        readOnly={entry.read_only}
                        onError={setError}
                        evidence={{
                          list: () => chartRef.current?.drawingCandidates?.() ?? [],
                          insertText: (id, text) => chartRef.current?.insertDrawingText(id, text) ?? false,
                          select: (ids) => chartRef.current?.selectDrawings?.(ids),
                          goTo: (tf, anchorMs) => {
                            if (tf) chartRef.current?.setTimeframe(tf);
                            if (anchorMs) chartRef.current?.focus(anchorMs);
                          },
                        }}
                      />
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
                          {noteDirty() ? <p className="note-dirty" role="status">笔记已修改，稍后自动保存</p> : null}
                          <button type="button" className="primary" onClick={() => void saveNote()} disabled={noteState === 'saving'}>
                            {noteState === 'saving' ? '保存中…' : noteState === 'saved' ? '已保存' : '保存笔记'}
                          </button>
                        </>
                      ) : <p className="dim">这是好友的复盘，笔记与画线只读。</p>}

                      {!entry.read_only ? <button type="button" className="tool-btn review-share-trigger" onClick={() => openReviewShare()}>分享复盘给好友或群聊</button> : null}
                    </>
                  ) : tradeReview ? <p className="dim">正在加载这笔复盘…</p> : (
                    <div className="rail-empty">
                      <button type="button" className="primary" disabled={creatingNote} onClick={() => void createNote()}>开始复盘当前图表</button>
                      <p className="dim">在图表上浏览、选日期或随机回放后，点击「开始复盘」。也可以从历史订单进入同一个笔记编辑器。</p>
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
        historySync={localConnected ? historySync : undefined}
        onRetryHistorySync={() => localHistorySync.retry()}
        reviewed={board?.reviewed}
        onReview={(ticket) => openTicket(me!.id, ticket)}
        tracksSlot={tradeReview && target?.ticket ? (
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

