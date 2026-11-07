import {
  registerNativeIndicator,
  type InputValue,
  type NativeIndicator,
  type NativeIndicatorContext,
  type NativeIndicatorDescriptor,
  type NativeIndicatorOutput,
  type OHLCV,
} from '@luxalgo/vela';

/**
 * hidden OB —— 由 `indicators/tradingview/hidden_ob.pine` 移植的原生指标
 * （不经过 Pine 引擎：不需要 unsafe-eval，也不依赖 AGPL 包）。
 *
 * 判定全部在 **1 分钟** K 线上跑，主图只画「离现价最近的 N 个未缓解区」：
 *   1. 摆动点：枢轴左右各 3 根确认（`ta.pivothigh/low(3, 3)`），确认后才算数；
 *   2. 突破：收盘越过该摆动点，且「被突破方向的反向 K 线」是 100 根分钟内的来源，
 *      同一根来源只认一次 → 这条来源 K 线就是隐藏 OB；
 *   3. 高质量（可选）：来源阴 K → 紧接阳 K → 第三根最低价严格高于来源最高价（空头镜像）；
 *   4. 缓解：按设置用影线首次触及 / 触及 50% / 完全穿过来移除，未缓解前一直有效（不是超时）；
 *   5. 选中：按中轴分上下两侧，取离现价最近的几个，同距取更新的来源。
 *
 * 与 Pine 版的差别只在「怎么取 1 分钟数据」：Pine 用 `request.security_lower_tf`
 * 拉数据，这里直接问当前图表的行情源（provider 的 `1` 分钟序列），拿不到才退回
 * 图表自身周期的 K 线（此时文案前缀会写当前周期，不再是 1m）。
 */

const SWING = 3;
const ORIGIN_LOOKBACK = 100;
/** 未缓解区最多留多少条：极端单边行情里防止无限增长拖慢每一根分钟的重算。 */
const MAX_BLOCKS = 4000;
/** 超过这个数量的分钟线，重置扫描时只取最后一段。 */
const MAX_SCAN_MINUTES = 100000;

type Mitigation = '首次触及' | '触及50%' | '完全穿越';

interface Minute {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** 1 分钟原始数据 → 归一化后的分钟线，供一次算完复用。 */
interface MinuteCache {
  sig: string;
  minutes: Minute[] | null;
}

interface Ob {
  top: number;
  bottom: number;
  /** 来源 K 线的开盘时间（ms）；也是「同距取新」的比较依据。 */
  origin: number;
  bullish: boolean;
  highQuality: boolean;
}

interface Cfg {
  /** true = 整根 K 线（高/低），false = 实体（开/收）。 */
  wholeBar: boolean;
  mitigation: Mitigation;
  onlyHighQuality: boolean;
  showText: boolean;
  upperCount: number;
  lowerCount: number;
  historyMinutes: number;
  bullColor: string;
  bearColor: string;
  highQualityBullColor: string;
  highQualityBearColor: string;
  fillTransparency: number;
}

/**
 * 增量扫描状态。Pine 用 `var` 在同一次运行里跨分钟累积，这里照搬，
 * 只在数据被前置/裁剪/改写时整个重置。
 */
interface ScanState {
  startIndex: number;
  firstTime: number;
  lastIndex: number;
  lastTime: number;
  lastCloseTime: number;
  swingHigh: number;
  swingLow: number;
  swingHighTime: number;
  swingLowTime: number;
  highArmed: boolean;
  lowArmed: boolean;
  downTop: number;
  downBottom: number;
  downTime: number;
  downIndex: number;
  upTop: number;
  upBottom: number;
  upTime: number;
  upIndex: number;
  usedDown: number;
  usedUp: number;
  blocks: Ob[];
}

function emptyState(startIndex = 0): ScanState {
  return {
    startIndex,
    firstTime: Number.NaN,
    lastIndex: startIndex - 1,
    lastTime: Number.NaN,
    lastCloseTime: Number.NaN,
    swingHigh: Number.NaN,
    swingLow: Number.NaN,
    swingHighTime: Number.NaN,
    swingLowTime: Number.NaN,
    highArmed: false,
    lowArmed: false,
    downTop: Number.NaN,
    downBottom: Number.NaN,
    downTime: Number.NaN,
    downIndex: -1,
    upTop: Number.NaN,
    upBottom: Number.NaN,
    upTime: Number.NaN,
    upIndex: -1,
    usedDown: Number.NaN,
    usedUp: Number.NaN,
    blocks: [],
  };
}

/* ------------------------------------------------------------------ 输入 */

function num(inputs: Record<string, InputValue>, key: string, fallback: number): number {
  const value = inputs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(inputs: Record<string, InputValue>, key: string, fallback: string): string {
  const value = inputs[key];
  return typeof value === 'string' && value ? value : fallback;
}

function flag(inputs: Record<string, InputValue>, key: string, fallback: boolean): boolean {
  const value = inputs[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readCfg(inputs: Record<string, InputValue>): Cfg {
  const mitigation = str(inputs, 'mitigation', '首次触及');
  return {
    wholeBar: str(inputs, 'zoneRange', '整根K线') !== '实体',
    mitigation: mitigation === '触及50%' || mitigation === '完全穿越' ? (mitigation as Mitigation) : '首次触及',
    onlyHighQuality: flag(inputs, 'onlyHighQuality', false),
    showText: flag(inputs, 'showText', true),
    upperCount: Math.max(0, Math.round(num(inputs, 'upperCount', 5))),
    lowerCount: Math.max(0, Math.round(num(inputs, 'lowerCount', 5))),
    historyMinutes: Math.max(1000, Math.round(num(inputs, 'historyMinutes', 20000))),
    bullColor: str(inputs, 'bullColor', '#00897b'),
    bearColor: str(inputs, 'bearColor', '#f44336'),
    highQualityBullColor: str(inputs, 'highQualityBullColor', '#ff9800'),
    highQualityBearColor: str(inputs, 'highQualityBearColor', '#ff9800'),
    fillTransparency: Math.max(0, Math.min(100, Math.round(num(inputs, 'fillTransparency', 87)))),
  };
}

/** `#rrggbb` + 透明度(0-100，100 = 全透明) → 8 位 hex；非 hex 颜色原样返回。 */
function withAlpha(color: string, transparency: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color ?? '').trim());
  if (!hex) return color;
  const alpha = Math.round((100 - Math.max(0, Math.min(100, transparency))) * 2.55);
  return `#${hex[1]}${alpha.toString(16).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ 取数 */

function toMinutes(bars: readonly OHLCV[]): Minute[] {
  return bars.map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
}

/**
 * 找本图的 1 分钟序列：先按当前 symbol 解析出注册名，再退回本站固定的几源。
 * 拿不到就返回 null，由调用方退回图表自身周期。
 *
 * `cache` 记住上一次的「原始数组指纹」：行情源每次 `getBars` 都会新建数组，
 * 但同一批数据不必每根 tick 重新映射一遍 6000 条。
 */
async function loadMinutes(ctx: NativeIndicatorContext, cache: MinuteCache): Promise<Minute[] | null> {
  const data = ctx.data as unknown as
    | { resolve?: (symbol: string) => { provider?: string } | null; providerInstance?: (name: string) => unknown }
    | undefined;
  if (!data?.providerInstance) return null;

  const names: string[] = [];
  try {
    const resolved = data.resolve?.(ctx.symbol);
    if (resolved?.provider) names.push(resolved.provider);
  } catch {
    /* 自定义 dataFeed 上没有 registry，走下面的固定名 */
  }
  for (const name of ['review', 'live', 'market']) {
    if (!names.includes(name)) names.push(name);
  }

  for (const name of names) {
    try {
      const provider = data.providerInstance(name) as { getBars?: (ticker: string, timeframe: string) => Promise<unknown> } | undefined;
      if (!provider || typeof provider.getBars !== 'function') continue;
      const rows = (await provider.getBars(ctx.symbol, '1')) as Array<Record<string, number>> | undefined;
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const sig = `${name}|${rows.length}|${first?.time}|${last?.time}|${last?.close}`;
      if (cache.sig === sig && cache.minutes) return cache.minutes;

      const out: Minute[] = [];
      for (const row of rows) {
        const time = Number(row?.time);
        const open = Number(row?.open);
        const high = Number(row?.high);
        const low = Number(row?.low);
        const close = Number(row?.close);
        if (![time, open, high, low, close].every(Number.isFinite)) continue;
        out.push({ time, open, high, low, close });
      }
      if (!out.length) continue;
      // provider 正常按时间升序返回；万一不是，排一次再交给扫描。
      let ordered = true;
      for (let i = 1; i < out.length; i += 1) {
        if (out[i]!.time <= out[i - 1]!.time) {
          ordered = false;
          break;
        }
      }
      if (!ordered) out.sort((a, b) => a.time - b.time);
      cache.sig = sig;
      cache.minutes = out;
      return out;
    } catch {
      /* 换下一个源 */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ 判定 */

/** `ta.pivothigh(high, 3, 3)`：p 必须是 [p-3, p+3] 里最高的那根（等高不算）。 */
function isPivotHigh(list: Minute[], p: number): boolean {
  const value = list[p]!.high;
  for (let k = p - SWING; k <= p + SWING; k += 1) {
    if (k === p) continue;
    if (list[k]!.high >= value) return false;
  }
  return true;
}

function isPivotLow(list: Minute[], p: number): boolean {
  const value = list[p]!.low;
  for (let k = p - SWING; k <= p + SWING; k += 1) {
    if (k === p) continue;
    if (list[k]!.low <= value) return false;
  }
  return true;
}

/**
 * 三条 K 线的高质量判定，与 Pine 的 `f_high_quality` 完全一致：
 * 来源反向、后一根同向、第三根整根脱离来源区间；`offset < 2` 时第三根还没收盘，不算。
 */
function highQuality(list: Minute[], offset: number, source: number, bullish: boolean): boolean {
  if (offset < 2) return false;
  const a = list[source];
  const b = list[source + 1];
  const c = list[source + 2];
  if (!a || !b || !c) return false;
  return bullish
    ? a.close < a.open && b.close > b.open && c.low > a.high
    : a.close > a.open && b.close < b.open && c.high < a.low;
}

function mitigationLevel(ob: Ob, mode: Mitigation): number {
  if (mode === '触及50%') return (ob.top + ob.bottom) / 2;
  if (mode === '完全穿越') return ob.bullish ? ob.bottom : ob.top;
  return ob.bullish ? ob.top : ob.bottom;
}

/** 未缓解区按分钟影线移除（Pine 里在「新增之前」跑，新 OB 不会被自己的确认 K 线打掉）。 */
function mitigate(blocks: Ob[], bar: Minute, mode: Mitigation): void {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const ob = blocks[i]!;
    const level = mitigationLevel(ob, mode);
    if (ob.bullish ? bar.low <= level : bar.high >= level) blocks.splice(i, 1);
  }
}

/** 处理一根已收盘分钟：记录枢轴 → 判突破 → 更新来源 → 缓解 → 新增。 */
function processMinute(list: Minute[], state: ScanState, j: number, cfg: Cfg): void {
  const bar = list[j]!;

  // ① 枢轴在 3 根之后才确认（当前根 = 枢轴 + 3）。
  const pivot = j - SWING;
  if (pivot - SWING >= state.startIndex) {
    if (isPivotHigh(list, pivot)) {
      state.swingHigh = list[pivot]!.high;
      state.swingHighTime = list[pivot]!.time;
      state.highArmed = true;
    }
    if (isPivotLow(list, pivot)) {
      state.swingLow = list[pivot]!.low;
      state.swingLowTime = list[pivot]!.time;
      state.lowArmed = true;
    }
  }

  // ② 突破：收盘越过摆动点，且来源 K 线在摆动点之后、100 根之内、没被用过。
  let bull: Ob | null = null;
  let bear: Ob | null = null;

  if (state.highArmed && bar.close > state.swingHigh) {
    state.highArmed = false;
    if (
      !Number.isNaN(state.downTime) &&
      state.downTime >= state.swingHighTime &&
      j - state.downIndex <= ORIGIN_LOOKBACK &&
      (Number.isNaN(state.usedDown) || state.downTime !== state.usedDown) &&
      bar.close > state.downTop &&
      state.downTop > state.downBottom
    ) {
      bull = {
        top: state.downTop,
        bottom: state.downBottom,
        origin: state.downTime,
        bullish: true,
        highQuality: highQuality(list, j - state.downIndex, state.downIndex, true),
      };
      state.usedDown = state.downTime;
    }
  }

  if (state.lowArmed && bar.close < state.swingLow) {
    state.lowArmed = false;
    if (
      !Number.isNaN(state.upTime) &&
      state.upTime >= state.swingLowTime &&
      j - state.upIndex <= ORIGIN_LOOKBACK &&
      (Number.isNaN(state.usedUp) || state.upTime !== state.usedUp) &&
      bar.close < state.upBottom &&
      state.upTop > state.upBottom
    ) {
      bear = {
        top: state.upTop,
        bottom: state.upBottom,
        origin: state.upTime,
        bullish: false,
        highQuality: highQuality(list, j - state.upIndex, state.upIndex, false),
      };
      state.usedUp = state.upTime;
    }
  }

  // ③ 来源 K 线在突破判定之后才更新：突破那根不能当自己的来源。
  if (bar.close < bar.open) {
    state.downTop = cfg.wholeBar ? bar.high : bar.open;
    state.downBottom = cfg.wholeBar ? bar.low : bar.close;
    state.downTime = bar.time;
    state.downIndex = j;
  } else if (bar.close > bar.open) {
    state.upTop = cfg.wholeBar ? bar.high : bar.close;
    state.upBottom = cfg.wholeBar ? bar.low : bar.open;
    state.upTime = bar.time;
    state.upIndex = j;
  }

  // ④ 先用这根分钟线结算已有区，再把新生成的放进去。
  mitigate(state.blocks, bar, cfg.mitigation);
  if (bull && (!cfg.onlyHighQuality || bull.highQuality)) state.blocks.push(bull);
  if (bear && (!cfg.onlyHighQuality || bear.highQuality)) state.blocks.push(bear);
  if (state.blocks.length > MAX_BLOCKS) state.blocks.splice(0, state.blocks.length - MAX_BLOCKS);

  state.lastIndex = j;
  state.lastTime = bar.time;
  state.lastCloseTime = bar.time + 60_000;
}

/** 增量扫描：状态还能接上就只算新分钟，接不上就整段重来。 */
function scan(list: Minute[], state: ScanState | null, cfg: Cfg): ScanState {
  const n = list.length;
  if (!n) return emptyState();
  const start = Math.max(0, n - Math.min(cfg.historyMinutes, MAX_SCAN_MINUTES));

  const resumable =
    state != null &&
    state.startIndex <= start &&
    state.startIndex < n &&
    list[state.startIndex]?.time === state.firstTime &&
    state.lastIndex >= state.startIndex - 1 &&
    state.lastIndex < n &&
    (state.lastIndex < state.startIndex || list[state.lastIndex]?.time === state.lastTime);

  let next: ScanState;
  let from: number;
  if (resumable) {
    next = state!;
    from = next.lastIndex + 1;
  } else {
    next = emptyState(start);
    next.firstTime = list[start]!.time;
    from = start;
  }

  // 只有已经收盘的分钟才参与判定（与 Pine 的 `minuteClose <= timenow` 同理）。
  const now = Date.now();
  for (let j = from; j < n; j += 1) {
    const bar = list[j]!;
    if (bar.time + 60_000 > now) break;
    processMinute(list, next, j, cfg);
  }
  return next;
}

/* ------------------------------------------------------------------ 出图 */

/** 中轴分上下两侧；边距为 0（在区内）；同距取更新的来源。 */
function nearest(blocks: Ob[], price: number, above: boolean, limit: number): Ob[] {
  const picked: Ob[] = [];
  if (!blocks.length || limit <= 0 || !Number.isFinite(price)) return picked;
  const used = new Set<number>();
  for (let rank = 0; rank < limit; rank += 1) {
    let best = -1;
    let bestDistance = Number.NaN;
    let bestOrigin = Number.NaN;
    for (let i = 0; i < blocks.length; i += 1) {
      if (used.has(i)) continue;
      const ob = blocks[i]!;
      const onSide = ((ob.top + ob.bottom) / 2 >= price) === above;
      if (!onSide) continue;
      const distance = Math.max(0, Math.max(ob.bottom - price, price - ob.top));
      if (best === -1 || distance < bestDistance || (distance === bestDistance && ob.origin > bestOrigin)) {
        best = i;
        bestDistance = distance;
        bestOrigin = ob.origin;
      }
    }
    if (best === -1) break;
    used.add(best);
    picked.push(blocks[best]!);
  }
  return picked;
}

function tintOf(ob: Ob, cfg: Cfg): string {
  if (ob.highQuality) return ob.bullish ? cfg.highQualityBullColor : cfg.highQualityBearColor;
  return ob.bullish ? cfg.bullColor : cfg.bearColor;
}

function buildOutput(
  ctx: NativeIndicatorContext,
  state: ScanState,
  cfg: Cfg,
  unit: string,
): NativeIndicatorOutput {
  const bars = ctx.bars();
  const last = bars.length ? bars[bars.length - 1]! : null;
  const price = last ? last.close : Number.NaN;
  const right = Number.isFinite(state.lastCloseTime) ? state.lastCloseTime : last ? last.time + 60_000 : 0;

  const uppers = nearest(state.blocks, price, true, cfg.upperCount);
  const lowers = nearest(state.blocks, price, false, cfg.lowerCount);

  const boxes: NonNullable<NativeIndicatorOutput['boxes']> = [];
  const push = (ob: Ob, slot: number): void => {
    const tint = tintOf(ob, cfg);
    boxes.push({
      id: `hidden-ob-${ob.origin}-${ob.bullish ? 'b' : 's'}`,
      paneId: '',
      xloc: 'bar_time',
      left: ob.origin,
      right,
      top: Math.max(ob.top, ob.bottom),
      bottom: Math.min(ob.top, ob.bottom),
      extend: 'right',
      bgColor: withAlpha(tint, cfg.fillTransparency),
      borderColor: tint,
      borderWidth: 1,
      borderStyle: 'solid',
      text: cfg.showText ? `${unit} ${ob.highQuality ? '高质量' : ''}${ob.bullish ? '多头OB' : '空头OB'} ${slot + 1}` : undefined,
      textColor: tint,
      textSize: 'tiny',
      hAlign: 'right',
      vAlign: 'center',
      wrap: false,
      fontFamily: 'default',
      bold: false,
      italic: false,
      overlay: true,
    });
  };
  uppers.forEach((ob, slot) => push(ob, slot));
  lowers.forEach((ob, slot) => push(ob, slot));

  return { boxes };
}

/* ------------------------------------------------------------------ 注册 */

const descriptor: NativeIndicatorDescriptor = {
  type: 'hidden-ob',
  // 指标库按标题 A→Z 排序（Vela 内部用 Intl.Collator），'★' 排在最前：
  // '★ bigwolf' → '★ hidden OB' → 其余。想调位次就改这里的前缀。
  title: '★ hidden OB（1m 隐藏订单块）',
  shortTitle: 'hidden OB',
  paneHint: 'price',
  overlay: true,
  multiInstance: false,
  inputsSchema: () => [
    {
      key: 'zoneRange',
      title: 'OB 范围',
      type: 'string',
      defval: '整根K线',
      options: ['整根K线', '实体'],
      group: '识别',
      tooltip: '整根K线用高/低，实体用开/收；与 FVG 的判定无关。',
    },
    {
      key: 'mitigation',
      title: '缓解条件（影线）',
      type: 'string',
      defval: '首次触及',
      options: ['首次触及', '触及50%', '完全穿越'],
      group: '识别',
    },
    {
      key: 'onlyHighQuality',
      title: '仅显示高质量OB',
      type: 'bool',
      defval: false,
      group: '识别',
      tooltip: '多头：来源为阴K，紧接一根阳K，第三根最低价严格高于来源最高价；空头镜像。在结构突破确认时判定，第三根尚未收盘则不算高质量，不事后升级。',
    },
    { key: 'showText', title: '显示文本', type: 'bool', defval: true, group: '识别' },
    {
      key: 'historyMinutes',
      title: '请求的1分钟历史根数',
      type: 'int',
      defval: 20000,
      min: 1000,
      max: 100000,
      step: 1000,
      group: '数据',
      tooltip: '实际可用范围还受图表已加载的行情限制。只在已加载数据中选择最近 OB。',
    },
    {
      key: 'upperCount',
      title: '显示当前价格上方的几个隐藏OB',
      type: 'int',
      defval: 5,
      min: 0,
      max: 50,
      group: '显示',
      tooltip: '按离当前价格的距离取最近几个；设为 0 隐藏上方 OB。',
    },
    {
      key: 'lowerCount',
      title: '显示当前价格下方的几个隐藏OB',
      type: 'int',
      defval: 5,
      min: 0,
      max: 50,
      group: '显示',
      tooltip: '按离当前价格的距离取最近几个；设为 0 隐藏下方 OB。',
    },
    { key: 'bullColor', title: '多头OB', type: 'color', defval: '#00897b', group: '显示' },
    { key: 'bearColor', title: '空头OB', type: 'color', defval: '#f44336', group: '显示' },
    { key: 'highQualityBullColor', title: '高质量多头OB', type: 'color', defval: '#ff9800', group: '显示' },
    { key: 'highQualityBearColor', title: '高质量空头OB', type: 'color', defval: '#ff9800', group: '显示' },
    { key: 'fillTransparency', title: '填充透明度', type: 'int', defval: 87, min: 0, max: 100, group: '显示' },
  ],
  defaultInputs: () => ({
    zoneRange: '整根K线',
    mitigation: '首次触及',
    onlyHighQuality: false,
    showText: true,
    historyMinutes: 20000,
    upperCount: 5,
    lowerCount: 5,
    bullColor: '#00897b',
    bearColor: '#f44336',
    highQualityBullColor: '#ff9800',
    highQualityBearColor: '#ff9800',
    fillTransparency: 87,
  }),
  create: (): NativeIndicator => {
    let ctx: NativeIndicatorContext | null = null;
    let inputs: Record<string, InputValue> = {};
    let state: ScanState | null = null;
    let seq = 0;
    const cache: MinuteCache = { sig: '', minutes: null };
    /** 上一次成功出图的数据指纹：同一批数据 + 同一套输入就不重复 emit。 */
    let lastKey = '';

    const paint = async (): Promise<void> => {
      const context = ctx;
      if (!context) return;
      const token = (seq += 1);
      const minutes = await loadMinutes(context, cache);
      if (token !== seq || ctx !== context) return;

      const cfg = readCfg(inputs);
      const list = minutes && minutes.length ? minutes : toMinutes(context.bars());
      const unit = minutes && minutes.length ? '1m' : context.timeframe === '1' ? '1m' : `${context.timeframe}m`;

      const bars = context.bars();
      const chartTail = bars.length ? `${bars.length}:${bars[bars.length - 1]!.time}:${bars[bars.length - 1]!.close}` : '0';
      const minuteTail = list.length ? `${list.length}:${list[list.length - 1]!.time}` : '0';
      const key = `${unit}|${chartTail}|${minuteTail}|${JSON.stringify(cfg)}`;
      if (key === lastKey) return;

      const next = scan(list, state, cfg);
      state = next;
      lastKey = key;
      try {
        context.emit(buildOutput(context, next, cfg, unit));
      } catch (error) {
        console.warn('hidden-ob emit failed', error);
      }
    };

    return {
      start(context, initialInputs) {
        ctx = context;
        inputs = initialInputs;
        void paint();
      },
      onBars() {
        void paint();
      },
      onViewport() {
        /* 只按价格/时间定位，不依赖视窗 */
      },
      setInputs(next) {
        inputs = next;
        // 范围/缓解/高质量都会改变扫描结果，改输入就整段重算。
        state = null;
        lastKey = '';
        void paint();
      },
      suspend() {
        /* 没有定时器要停 */
      },
      resume() {
        void paint();
      },
      stop() {
        ctx = null;
        seq += 1;
      },
    };
  },
};

registerNativeIndicator(descriptor);

export const HIDDEN_OB_TYPE = descriptor.type;
