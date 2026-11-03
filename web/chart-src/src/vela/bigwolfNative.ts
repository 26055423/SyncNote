/**
 * bigwolf —— Vela 原生指标（不经过 Pine 引擎：不需要 unsafe-eval，也不依赖 AGPL 包）。
 *
 * 两个类型：
 *   bigwolf       主图：Vegas 通道 / 时段箱体 + KZ / 时段高低点 / FVG / 内包 K / 穿零轴标记 / OB
 *   bigwolf-macd  副图：MACD 线、信号线、能量柱、零轴
 *
 * 输入项刻意对齐原 Pine 脚本：Vela 的 InputSchema 支持 int/float/bool/string(下拉)/
 * color/session，也支持 group（分组）和 inline（同一行），和 TradingView 的输入面板一致。
 */

type RegisterFn = (descriptor: any) => void;
let registerNativeIndicator: RegisterFn | null = null;

type Bars = readonly { time: number; open: number; high: number; low: number; close: number }[];

interface Cfg {
  // ① MACD
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  showHist: boolean;
  colMACD: string;
  colSignal: string;
  colHistUp: string;
  colHistDn: string;
  // ② Vegas
  showVegas: boolean;
  showV12: boolean;
  showTubeA: boolean;
  showTubeB: boolean;
  // ③ 时段
  showSessions: boolean;
  showKz: boolean;
  asiaSess: string;
  colAsia: string;
  londonSess: string;
  colLondon: string;
  londonKzOn: boolean;
  londonKzSess: string;
  colLondonKz: string;
  nySess: string;
  colNy: string;
  nyAmKzOn: boolean;
  nyAmKzSess: string;
  colNyAmKz: string;
  nyPmKzOn: boolean;
  nyPmKzSess: string;
  colNyPmKz: string;
  // ④ 高低点
  publishLevels: boolean;
  touchCounts: boolean;
  extendLevels: boolean;
  levelWidth: number;
  // ⑤ 穿零轴标记
  markOn: boolean;
  markUp: boolean;
  markDn: boolean;
  markLbMax: number;
  markLbMin: number;
  mkEmojiLow: string;
  mkEmojiHi: string;
  mkGapAtr: number;
  mkShowPrc: boolean;
  mkBgTrans: number;
  mkColLow: string;
  mkColHigh: string;
  mkKeep: number;
  // ⑥ FVG
  fvgOn: boolean;
  fvgShowBull: boolean;
  fvgShowBear: boolean;
  fvgNeedBody: boolean;
  fvgShrink: boolean;
  fvgExtend: boolean;
  fvgAfter: string;
  fvgKeep: number;
  colFvgBull: string;
  colFvgBear: string;
  fvgTrans: number;
  // ⑦ 内包 K
  ibOn: boolean;
  ibStrict: boolean;
  ibColor: string;
  ibTrans: number;
  // ⑧ OB
  obOn: boolean;
  obShowBull: boolean;
  obShowBear: boolean;
  obPivot: number;
  obKeep: number;
  obExtend: boolean;
  obMitig: string;
  colObBull: string;
  colObBear: string;
  obTrans: number;
}

const DEFAULTS: Cfg = {
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  showHist: true,
  colMACD: '#2962ff',
  colSignal: '#ff6d00',
  colHistUp: '#26a69a',
  colHistDn: '#ef5350',
  showVegas: true,
  showV12: true,
  showTubeA: true,
  showTubeB: true,
  showSessions: true,
  showKz: true,
  asiaSess: '0700-1530',
  colAsia: '#42a5f5',
  londonSess: '1530-2330',
  colLondon: '#ab47bc',
  londonKzOn: true,
  londonKzSess: '1530-1700',
  colLondonKz: '#7e57c2',
  nySess: '2030-0500',
  colNy: '#26a69a',
  nyAmKzOn: true,
  nyAmKzSess: '2030-2330',
  colNyAmKz: '#26a69a',
  nyPmKzOn: true,
  nyPmKzSess: '0200-0400',
  colNyPmKz: '#ffa726',
  publishLevels: true,
  touchCounts: false,
  extendLevels: false,
  levelWidth: 1,
  markOn: true,
  markUp: true,
  markDn: true,
  markLbMax: 20,
  markLbMin: 0,
  mkEmojiLow: '⚔️',
  mkEmojiHi: '⚔️',
  mkGapAtr: 0.15,
  mkShowPrc: false,
  mkBgTrans: 85,
  mkColLow: '#26a69a',
  mkColHigh: '#ef5350',
  mkKeep: 30,
  fvgOn: true,
  fvgShowBull: true,
  fvgShowBear: true,
  fvgNeedBody: false,
  fvgShrink: true,
  fvgExtend: false,
  fvgAfter: '删除',
  fvgKeep: 20,
  colFvgBull: '#26a69a',
  colFvgBear: '#ef5350',
  fvgTrans: 82,
  ibOn: true,
  ibStrict: false,
  ibColor: '#ff9800',
  ibTrans: 30,
  obOn: true,
  obShowBull: true,
  obShowBear: true,
  obPivot: 5,
  obKeep: 5,
  obExtend: true,
  obMitig: '影线触及',
  colObBull: '#089981',
  colObBear: '#b22833',
  obTrans: 80,
};

const BEIJING_OFFSET = 8 * 3600_000;

function minutesInBeijing(ms: number): number {
  const d = new Date(ms + BEIJING_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "HHMM-HHMM" → [startMinutes, endMinutes]；解析失败返回 null。 */
function parseWindow(text: string): [number, number] | null {
  const match = /^\s*(\d{2})(\d{2})-(\d{2})(\d{2})\s*$/.exec(String(text ?? ''));
  if (!match) return null;
  return [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])];
}

function inWindow(minutes: number, start: number, end: number): boolean {
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function ema(values: number[], length: number): number[] {
  const out: number[] = [];
  const alpha = 2 / (length + 1);
  let prev = Number.NaN;
  for (const value of values) {
    prev = Number.isFinite(prev) ? prev + alpha * (value - prev) : value;
    out.push(prev);
  }
  return out;
}

function macdSeries(closes: number[], fast: number, slow: number, signal: number) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const signalLine = ema(line, signal);
  const hist = line.map((v, i) => v - signalLine[i]);
  return { line, signal: signalLine, hist };
}

function atrSeries(bars: Bars, length: number): number[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)));
  }
  return ema(trs, length);
}

/** `#rrggbb` + 透明度(0-100，100 = 全透明) → 8 位 hex。 */
function withAlpha(color: string, transparency: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color ?? '').trim());
  const base = hex ? hex[1] : '888888';
  const alpha = Math.round((100 - Math.max(0, Math.min(100, transparency))) * 2.55);
  return `#${base}${alpha.toString(16).padStart(2, '0')}`;
}

interface BoxOut {
  left: number;
  right: number;
  top: number;
  bottom: number;
  bg: string;
  border: string;
  text?: string;
  textColor?: string;
}
interface LineOut {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  style?: 'solid' | 'dashed' | 'dotted';
}
interface LabelOut {
  x: number;
  y: number;
  text: string;
  color: string;
  style: 'label_up' | 'label_down';
  bg: string;
}

interface Computed {
  vegas: Array<{ points: Array<{ time: number; price: number }>; color: string; width: number }>;
  boxes: BoxOut[];
  lines: LineOut[];
  labels: LabelOut[];
}

/** 一个时间窗口的箱体（可选）与高低点线。 */
function sessionPass(
  bars: Bars,
  times: number[],
  window: [number, number],
  color: string,
  cfg: Cfg,
  out: Computed,
  options: { box: boolean; levels: boolean; label?: string; border?: boolean; transparency: number },
) {
  let open = -1;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  const flush = (end: number) => {
    if (open < 0) return;
    const from = times[open];
    const to = times[end] ?? times[open];
    if (options.box) {
      out.boxes.push({
        left: from,
        right: to,
        top: high,
        bottom: low,
        bg: withAlpha(color, options.transparency),
        border: options.border ? withAlpha(color, 60) : 'transparent',
        text: options.label,
        textColor: color,
      });
    }
    if (options.levels && cfg.publishLevels) {
      out.lines.push({ x1: from, y1: high, x2: to, y2: high, color: withAlpha(color, 45), width: cfg.levelWidth, style: 'dashed' });
      out.lines.push({ x1: from, y1: low, x2: to, y2: low, color: withAlpha(color, 45), width: cfg.levelWidth, style: 'dashed' });
    }
    open = -1;
    high = Number.NEGATIVE_INFINITY;
    low = Number.POSITIVE_INFINITY;
  };
  for (let i = 0; i < times.length; i += 1) {
    const active = inWindow(minutesInBeijing(times[i]), window[0], window[1]);
    if (active && open < 0) {
      open = i;
      high = bars[i].high;
      low = bars[i].low;
    } else if (active) {
      high = Math.max(high, bars[i].high);
      low = Math.min(low, bars[i].low);
    } else if (open >= 0) {
      flush(i - 1);
    }
  }
  if (open >= 0) flush(times.length - 1);
}

function computeOverlay(bars: Bars, cfg: Cfg): Computed {
  const n = bars.length;
  const out: Computed = { vegas: [], boxes: [], lines: [], labels: [] };
  if (n < 3) return out;
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time);
  const atr = atrSeries(bars, 14);

  if (cfg.showVegas) {
    const list: Array<[number, string, number, boolean]> = [
      [12, '#ff9800', 1, cfg.showV12],
      [144, '#f23645', 1, cfg.showTubeA],
      [169, '#f23645', 2, cfg.showTubeA],
      [576, '#2962ff', 1, cfg.showTubeB],
      [676, '#2962ff', 2, cfg.showTubeB],
    ];
    for (const [length, color, width, on] of list) {
      if (!on) continue;
      const values = ema(closes, length);
      out.vegas.push({ points: values.map((value, i) => ({ time: times[i], price: value })), color, width });
    }
  }

  const asia = parseWindow(cfg.asiaSess);
  const london = parseWindow(cfg.londonSess);
  const ny = parseWindow(cfg.nySess);
  const londonKz = parseWindow(cfg.londonKzSess);
  const nyAmKz = parseWindow(cfg.nyAmKzSess);
  const nyPmKz = parseWindow(cfg.nyPmKzSess);

  if (asia) sessionPass(bars, times, asia, cfg.colAsia, cfg, out, { box: cfg.showSessions, levels: true, label: '亚盘', transparency: 88 });
  if (london) sessionPass(bars, times, london, cfg.colLondon, cfg, out, { box: cfg.showSessions, levels: true, label: '欧盘', transparency: 88 });
  if (ny) sessionPass(bars, times, ny, cfg.colNy, cfg, out, { box: cfg.showSessions, levels: true, label: '美盘', transparency: 88 });
  if (cfg.showKz && londonKz && cfg.londonKzOn) sessionPass(bars, times, londonKz, cfg.colLondonKz, cfg, out, { box: true, levels: false, label: '伦敦 KZ', border: true, transparency: 86 });
  if (cfg.showKz && nyAmKz && cfg.nyAmKzOn) sessionPass(bars, times, nyAmKz, cfg.colNyAmKz, cfg, out, { box: true, levels: false, label: '美盘 AM KZ', border: true, transparency: 86 });
  if (cfg.showKz && nyPmKz && cfg.nyPmKzOn) sessionPass(bars, times, nyPmKz, cfg.colNyPmKz, cfg, out, { box: true, levels: false, label: '美盘 PM KZ', border: true, transparency: 86 });

  // ── FVG ────────────────────────────────────────────────────────────────
  if (cfg.fvgOn && (cfg.fvgShowBull || cfg.fvgShowBear)) {
    let bull = 0;
    let bear = 0;
    for (let i = n - 3; i >= 2; i -= 1) {
      if (bull >= cfg.fvgKeep && bear >= cfg.fvgKeep) break;
      const a = bars[i - 2];
      const b = bars[i - 1];
      const c = bars[i];
      if (cfg.fvgShowBull && bull < cfg.fvgKeep && c.low > a.high && (!cfg.fvgNeedBody || b.close > b.open)) {
        let top = c.low;
        const bottom = a.high;
        let dead = false;
        for (let j = i + 1; j < n; j += 1) {
          if (bars[j].low <= bottom) {
            dead = true;
            break;
          }
          if (cfg.fvgShrink && bars[j].low < top) top = bars[j].low;
        }
        if (!dead || cfg.fvgAfter !== '删除') {
          out.boxes.push({
            left: times[i - 1],
            right: cfg.fvgExtend ? times[n - 1] : times[i],
            top,
            bottom,
            bg: withAlpha(cfg.colFvgBull, dead ? 92 : cfg.fvgTrans),
            border: withAlpha(cfg.colFvgBull, dead ? 70 : 60),
          });
          bull += 1;
        }
      }
      if (cfg.fvgShowBear && bear < cfg.fvgKeep && c.high < a.low && (!cfg.fvgNeedBody || b.close < b.open)) {
        const top = a.low;
        let bottom = c.high;
        let dead = false;
        for (let j = i + 1; j < n; j += 1) {
          if (bars[j].high >= top) {
            dead = true;
            break;
          }
          if (cfg.fvgShrink && bars[j].high > bottom) bottom = bars[j].high;
        }
        if (!dead || cfg.fvgAfter !== '删除') {
          out.boxes.push({
            left: times[i - 1],
            right: cfg.fvgExtend ? times[n - 1] : times[i],
            top,
            bottom,
            bg: withAlpha(cfg.colFvgBear, dead ? 92 : cfg.fvgTrans),
            border: withAlpha(cfg.colFvgBear, dead ? 70 : 60),
          });
          bear += 1;
        }
      }
    }
  }

  // ── 内包 K 线 ───────────────────────────────────────────────────────────
  if (cfg.ibOn) {
    for (let i = Math.max(1, n - 400); i < n; i += 1) {
      const prev = bars[i - 1];
      const cur = bars[i];
      const inside = cfg.ibStrict ? cur.high < prev.high && cur.low > prev.low : cur.high <= prev.high && cur.low >= prev.low;
      if (!inside) continue;
      out.boxes.push({
        left: times[i],
        right: times[i],
        top: Math.max(cur.open, cur.close),
        bottom: Math.min(cur.open, cur.close),
        bg: withAlpha(cfg.ibColor, cfg.ibTrans),
        border: withAlpha(cfg.ibColor, 0),
      });
    }
  }

  // ── 穿零轴标记 ──────────────────────────────────────────────────────────
  if (cfg.markOn && (cfg.markUp || cfg.markDn)) {
    const values = macdSeries(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
    const fromBack = Math.max(0, Math.min(cfg.markLbMin, cfg.markLbMax - 1));
    const toBack = Math.max(fromBack + 1, cfg.markLbMax);
    const marks: LabelOut[] = [];
    for (let i = 2; i < n; i += 1) {
      const prev = values.line[i - 1];
      const now = values.line[i];
      if (!Number.isFinite(prev) || !Number.isFinite(now)) continue;
      if (cfg.markUp && prev <= 0 && now > 0) {
        let low = Number.POSITIVE_INFINITY;
        let at = i;
        for (let j = Math.max(0, i - toBack); j <= Math.max(0, i - fromBack); j += 1) {
          if (bars[j].low < low) {
            low = bars[j].low;
            at = j;
          }
        }
        marks.push({
          x: times[at],
          y: low - cfg.mkGapAtr * (atr[at] || 0),
          text: cfg.mkShowPrc ? `${cfg.mkEmojiLow} ${low.toFixed(2)}` : cfg.mkEmojiLow,
          color: cfg.mkColLow,
          style: 'label_up',
          bg: withAlpha(cfg.mkColLow, cfg.mkBgTrans),
        });
      } else if (cfg.markDn && prev >= 0 && now < 0) {
        let high = Number.NEGATIVE_INFINITY;
        let at = i;
        for (let j = Math.max(0, i - toBack); j <= Math.max(0, i - fromBack); j += 1) {
          if (bars[j].high > high) {
            high = bars[j].high;
            at = j;
          }
        }
        marks.push({
          x: times[at],
          y: high + cfg.mkGapAtr * (atr[at] || 0),
          text: cfg.mkShowPrc ? `${cfg.mkEmojiHi} ${high.toFixed(2)}` : cfg.mkEmojiHi,
          color: cfg.mkColHigh,
          style: 'label_down',
          bg: withAlpha(cfg.mkColHigh, cfg.mkBgTrans),
        });
      }
    }
    out.labels.push(...marks.slice(-cfg.mkKeep));
  }

  // ── OB 订单块 ───────────────────────────────────────────────────────────
  if (cfg.obOn && (cfg.obShowBull || cfg.obShowBear)) {
    const pivot = Math.max(2, Math.round(cfg.obPivot));
    const boxes: BoxOut[] = [];
    let swingHigh = Number.NaN;
    let swingLow = Number.NaN;
    let highBar = -1;
    let lowBar = -1;
    for (let i = pivot; i < n - pivot; i += 1) {
      let isHigh = true;
      let isLow = true;
      for (let k = 1; k <= pivot; k += 1) {
        if (bars[i].high <= bars[i - k].high || bars[i].high <= bars[i + k].high) isHigh = false;
        if (bars[i].low >= bars[i - k].low || bars[i].low >= bars[i + k].low) isLow = false;
      }
      if (isHigh) {
        swingHigh = bars[i].high;
        highBar = i;
      }
      if (isLow) {
        swingLow = bars[i].low;
        lowBar = i;
      }
      if (cfg.obShowBull && Number.isFinite(swingHigh) && highBar >= 0 && bars[i].close > swingHigh) {
        let low = Number.POSITIVE_INFINITY;
        let at = highBar;
        for (let j = highBar; j <= i; j += 1) {
          if (bars[j].low < low) {
            low = bars[j].low;
            at = j;
          }
        }
        let dead = false;
        for (let j = i + 1; j < n; j += 1) {
          if (cfg.obMitig === '收盘突破' ? bars[j].close < low : bars[j].low < low) {
            dead = true;
            break;
          }
        }
        if (!dead) {
          boxes.push({
            left: times[at],
            right: cfg.obExtend ? times[n - 1] : times[i],
            top: bars[at].high,
            bottom: low,
            bg: withAlpha(cfg.colObBull, cfg.obTrans),
            border: withAlpha(cfg.colObBull, 60),
          });
          if (boxes.length > cfg.obKeep * 2) boxes.shift();
        }
        swingHigh = Number.NaN;
      }
      if (cfg.obShowBear && Number.isFinite(swingLow) && lowBar >= 0 && bars[i].close < swingLow) {
        let high = Number.NEGATIVE_INFINITY;
        let at = lowBar;
        for (let j = lowBar; j <= i; j += 1) {
          if (bars[j].high > high) {
            high = bars[j].high;
            at = j;
          }
        }
        let dead = false;
        for (let j = i + 1; j < n; j += 1) {
          if (cfg.obMitig === '收盘突破' ? bars[j].close > high : bars[j].high > high) {
            dead = true;
            break;
          }
        }
        if (!dead) {
          boxes.push({
            left: times[at],
            right: cfg.obExtend ? times[n - 1] : times[i],
            top: high,
            bottom: bars[at].low,
            bg: withAlpha(cfg.colObBear, cfg.obTrans),
            border: withAlpha(cfg.colObBear, 60),
          });
          if (boxes.length > cfg.obKeep * 2) boxes.shift();
        }
        swingLow = Number.NaN;
      }
    }
    out.boxes.push(...boxes);
  }

  return out;
}

class BigwolfPrice {
  private ctx: any;
  private cfg: Cfg = { ...DEFAULTS };

  start(ctx: any, inputs: Record<string, unknown>) {
    this.ctx = ctx;
    this.cfg = { ...DEFAULTS, ...(inputs as unknown as Partial<Cfg>) };
    this.paint();
  }

  onBars() {
    this.paint();
  }

  setInputs(inputs: Record<string, unknown>) {
    this.cfg = { ...DEFAULTS, ...(inputs as unknown as Partial<Cfg>) };
    this.paint();
  }

  suspend() {}

  resume() {
    this.paint();
  }

  stop() {}

  private paint() {
    const ctx = this.ctx;
    if (!ctx) return;
    const cfg = this.cfg;
    const bars = ctx.bars() as Bars;
    const data = computeOverlay(bars, cfg);
    const paneId = 'price';
    const polylines = data.vegas
      .filter((line) => line.points.length > 1)
      .map((line, index) => ({
        id: `bw-vegas-${index}`,
        paneId,
        points: line.points.map((point) => ({ xloc: 'bar_time', x: point.time, price: point.price })),
        curved: false,
        closed: false,
        lineColor: line.color,
        lineWidth: line.width,
        lineStyle: 'solid' as const,
        arrowLeft: false,
        arrowRight: false,
        overlay: true,
      }));
    const boxes = data.boxes.map((box, index) => ({
      id: `bw-box-${index}`,
      paneId,
      xloc: 'bar_time' as const,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      extend: 'none' as const,
      bgColor: box.bg,
      borderColor: box.border === 'transparent' ? undefined : box.border,
      borderWidth: box.border === 'transparent' ? 0 : 1,
      borderStyle: 'solid' as const,
      text: box.text,
      textColor: box.textColor,
      textSize: 'small' as const,
      hAlign: 'left' as const,
      vAlign: 'top' as const,
    }));
    const lines = data.lines.map((line, index) => ({
      id: `bw-line-${index}`,
      paneId,
      xloc: 'bar_time' as const,
      x1: line.x1,
      y1: line.y1,
      x2: line.x2,
      y2: line.y2,
      extend: cfg.extendLevels ? ('right' as const) : ('none' as const),
      color: line.color,
      invisible: false,
      width: line.width,
      style: line.style ?? 'solid',
    }));
    const labels = data.labels.map((label, index) => ({
      id: `bw-label-${index}`,
      paneId,
      xloc: 'bar_time' as const,
      x: label.x,
      y: label.y,
      yloc: 'price' as const,
      text: label.text,
      style: label.style,
      color: label.bg,
      textColor: label.color,
      size: 'small' as const,
      textAlign: 'center' as const,
    }));
    try {
      ctx.emit({ polylines, boxes, lines, labels });
    } catch (error) {
      console.warn('bigwolf emit failed', error);
    }
  }
}

class BigwolfMacd {
  private ctx: any;
  private cfg: Cfg = { ...DEFAULTS };

  start(ctx: any, inputs: Record<string, unknown>) {
    this.ctx = ctx;
    this.cfg = { ...DEFAULTS, ...(inputs as unknown as Partial<Cfg>) };
    this.paint();
  }

  onBars() {
    this.paint();
  }

  setInputs(inputs: Record<string, unknown>) {
    this.cfg = { ...DEFAULTS, ...(inputs as unknown as Partial<Cfg>) };
    this.paint();
  }

  suspend() {}

  resume() {
    this.paint();
  }

  stop() {}

  private paint() {
    const ctx = this.ctx;
    if (!ctx) return;
    const cfg = this.cfg;
    const bars = ctx.bars() as Bars;
    const closes = bars.map((bar) => bar.close);
    const values = macdSeries(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
    const paneId = '';
    const points = (series: number[]) => series.map((value, index) => ({ time: bars[index].time, value: Number.isFinite(value) ? value : null }));
    const series: any[] = [
      { id: 'bw-macd', title: 'MACD', paneId, kind: 'line' as const, points: points(values.line), style: { color: cfg.colMACD, width: 1, lineStyle: 'solid' as const } },
      { id: 'bw-signal', title: '信号线', paneId, kind: 'line' as const, points: points(values.signal), style: { color: cfg.colSignal, width: 1, lineStyle: 'solid' as const } },
    ];
    if (cfg.showHist) {
      series.push({
        id: 'bw-hist',
        title: '能量柱',
        paneId,
        kind: 'columns' as const,
        points: points(values.hist),
        style: { color: cfg.colHistUp, width: 1, lineStyle: 'solid' as const, base: 0 },
      });
    }
    const priceLines = [{ id: 'bw-zero', paneId, price: 0, color: '#888888', lineStyle: 'dotted' as const, width: 1 }];
    try {
      ctx.emit({ series, priceLines });
    } catch (error) {
      console.warn('bigwolf-macd emit failed', error);
    }
  }
}

const schema = () => [
  // ① MACD
  { key: 'macdFast', title: '快线', type: 'int' as const, defval: 12, min: 1, max: 500, group: '① MACD', inline: 'macd' },
  { key: 'macdSlow', title: '慢线', type: 'int' as const, defval: 26, min: 1, max: 500, group: '① MACD', inline: 'macd' },
  { key: 'macdSignal', title: '信号线', type: 'int' as const, defval: 9, min: 1, max: 500, group: '① MACD', inline: 'macd' },
  { key: 'showHist', title: '显示能量柱', type: 'bool' as const, defval: true, group: '① MACD', inline: 'macd' },
  { key: 'colMACD', title: 'MACD 线', type: 'color' as const, defval: '#2962ff', group: '① MACD', inline: 'mcol' },
  { key: 'colSignal', title: '信号线', type: 'color' as const, defval: '#ff6d00', group: '① MACD', inline: 'mcol' },
  { key: 'colHistUp', title: '柱·增强↑', type: 'color' as const, defval: '#26a69a', group: '① MACD', inline: 'mcol2' },
  { key: 'colHistDn', title: '柱·增强↓', type: 'color' as const, defval: '#ef5350', group: '① MACD', inline: 'mcol2' },
  // ② Vegas
  { key: 'showVegas', title: '显示 Vegas 通道', type: 'bool' as const, defval: true, group: '② Vegas 通道' },
  { key: 'showV12', title: '短线 EMA12', type: 'bool' as const, defval: true, group: '② Vegas 通道', inline: 'vtube' },
  { key: 'showTubeA', title: '主通道 144/169', type: 'bool' as const, defval: true, group: '② Vegas 通道', inline: 'vtube' },
  { key: 'showTubeB', title: '次通道 576/676', type: 'bool' as const, defval: true, group: '② Vegas 通道', inline: 'vtube' },
  // ③ 时段
  { key: 'showSessions', title: '显示时段箱体', type: 'bool' as const, defval: true, group: '③ 时段 · 全局' },
  { key: 'showKz', title: '显示 Kill Zone 箱体', type: 'bool' as const, defval: true, group: '③ 时段 · 全局' },
  { key: 'asiaSess', title: '亚盘时段', type: 'session' as const, defval: '0700-1530', group: '③-1 亚盘 Asia', inline: 'asia' },
  { key: 'colAsia', title: '颜色', type: 'color' as const, defval: '#42a5f5', group: '③-1 亚盘 Asia', inline: 'asia' },
  { key: 'londonSess', title: '欧盘时段', type: 'session' as const, defval: '1530-2330', group: '③-2 欧盘 London', inline: 'lon' },
  { key: 'colLondon', title: '颜色', type: 'color' as const, defval: '#ab47bc', group: '③-2 欧盘 London', inline: 'lon' },
  { key: 'londonKzOn', title: '启用 Kill Zone', type: 'bool' as const, defval: true, group: '③-2 欧盘 London', inline: 'lonkz' },
  { key: 'londonKzSess', title: '时间', type: 'session' as const, defval: '1530-1700', group: '③-2 欧盘 London', inline: 'lonkz' },
  { key: 'colLondonKz', title: 'KZ 颜色', type: 'color' as const, defval: '#7e57c2', group: '③-2 欧盘 London', inline: 'lonkzc' },
  { key: 'nySess', title: '美盘时段', type: 'session' as const, defval: '2030-0500', group: '③-3 美盘 New York', inline: 'ny' },
  { key: 'colNy', title: '颜色', type: 'color' as const, defval: '#26a69a', group: '③-3 美盘 New York', inline: 'ny' },
  { key: 'nyAmKzOn', title: '启用上午 KZ', type: 'bool' as const, defval: true, group: '③-3 美盘 New York', inline: 'nyam' },
  { key: 'nyAmKzSess', title: '时间', type: 'session' as const, defval: '2030-2330', group: '③-3 美盘 New York', inline: 'nyam' },
  { key: 'colNyAmKz', title: '颜色', type: 'color' as const, defval: '#26a69a', group: '③-3 美盘 New York', inline: 'nyamc' },
  { key: 'nyPmKzOn', title: '启用下午 KZ', type: 'bool' as const, defval: true, group: '③-3 美盘 New York', inline: 'nypm' },
  { key: 'nyPmKzSess', title: '时间', type: 'session' as const, defval: '0200-0400', group: '③-3 美盘 New York', inline: 'nypm' },
  { key: 'colNyPmKz', title: '颜色', type: 'color' as const, defval: '#ffa726', group: '③-3 美盘 New York', inline: 'nypmc' },
  // ④ 高低点
  { key: 'publishLevels', title: '时段收线后延伸高低点', type: 'bool' as const, defval: true, group: '④ 时段高低点 (DOL)' },
  { key: 'touchCounts', title: '影线触及即算突破', type: 'bool' as const, defval: false, group: '④ 时段高低点 (DOL)' },
  { key: 'extendLevels', title: '高低点线延伸到右侧', type: 'bool' as const, defval: false, group: '④ 时段高低点 (DOL)' },
  { key: 'levelWidth', title: '线宽', type: 'int' as const, defval: 1, min: 1, max: 4, group: '④ 时段高低点 (DOL)' },
  // ⑤ 穿零轴标记
  { key: 'markOn', title: '启用标记', type: 'bool' as const, defval: true, group: '⑤ MACD 穿 0 轴 · 高低点标记' },
  { key: 'markUp', title: '上穿 0 轴 → 标记最低点', type: 'bool' as const, defval: true, group: '⑤ MACD 穿 0 轴 · 高低点标记', inline: 'mkdir' },
  { key: 'markDn', title: '下穿 0 轴 → 标记最高点', type: 'bool' as const, defval: true, group: '⑤ MACD 穿 0 轴 · 高低点标记', inline: 'mkdir' },
  { key: 'markLbMax', title: '回看上限', type: 'int' as const, defval: 20, min: 2, max: 200, group: '⑤ MACD 穿 0 轴 · 高低点标记', inline: 'mklb' },
  { key: 'markLbMin', title: '回看下限', type: 'int' as const, defval: 0, min: 0, max: 199, group: '⑤ MACD 穿 0 轴 · 高低点标记', inline: 'mklb' },
  { key: 'mkEmojiLow', title: '上穿时（低点）图标', type: 'string' as const, defval: '⚔️', group: '⑤ MACD 穿 0 轴 · 高低点标记' },
  { key: 'mkEmojiHi', title: '下穿时（高点）图标', type: 'string' as const, defval: '⚔️', group: '⑤ MACD 穿 0 轴 · 高低点标记' },
  { key: 'mkGapAtr', title: '图标离 K 线（ATR 比例）', type: 'float' as const, defval: 0.15, min: 0, max: 5, step: 0.05, group: '⑤ MACD 穿 0 轴 · 高低点标记' },
  { key: 'mkShowPrc', title: '同时显示价格', type: 'bool' as const, defval: false, group: '⑤ MACD 穿 0 轴 · 高低点标记' },
  { key: 'mkBgTrans', title: '背景透明度', type: 'int' as const, defval: 85, min: 0, max: 100, group: '⑤ MACD 穿 0 轴 · 高低点标记' },
  { key: 'mkColLow', title: '低点颜色', type: 'color' as const, defval: '#26a69a', group: '⑤ MACD 穿 0 轴 · 高低点标记', inline: 'mkcol' },
  { key: 'mkColHigh', title: '高点颜色', type: 'color' as const, defval: '#ef5350', group: '⑤ MACD 穿 0 轴 · 高低点标记', inline: 'mkcol' },
  { key: 'mkKeep', title: '只保留最近标记数', type: 'int' as const, defval: 30, min: 5, max: 500, group: '⑤ MACD 穿 0 轴 · 高低点标记' },
  // ⑥ FVG
  { key: 'fvgOn', title: '显示 FVG 缺口', type: 'bool' as const, defval: true, group: '⑥ FVG 缺口' },
  { key: 'fvgShowBull', title: '看涨缺口', type: 'bool' as const, defval: true, group: '⑥ FVG 缺口', inline: 'fvgdir' },
  { key: 'fvgShowBear', title: '看跌缺口', type: 'bool' as const, defval: true, group: '⑥ FVG 缺口', inline: 'fvgdir' },
  { key: 'fvgNeedBody', title: '只保留中轴 K 线同向的缺口', type: 'bool' as const, defval: false, group: '⑥ FVG 缺口' },
  { key: 'fvgShrink', title: '部分回补时收缩', type: 'bool' as const, defval: true, group: '⑥ FVG 缺口' },
  { key: 'fvgExtend', title: 'FVG 向右延伸', type: 'bool' as const, defval: false, group: '⑥ FVG 缺口' },
  { key: 'fvgAfter', title: '完全填补后', type: 'string' as const, defval: '删除', options: ['删除', '变灰停止'], group: '⑥ FVG 缺口' },
  { key: 'fvgKeep', title: '每个方向保留数量', type: 'int' as const, defval: 20, min: 2, max: 200, group: '⑥ FVG 缺口' },
  { key: 'colFvgBull', title: '看涨颜色', type: 'color' as const, defval: '#26a69a', group: '⑥ FVG 缺口', inline: 'fvgcol' },
  { key: 'colFvgBear', title: '看跌颜色', type: 'color' as const, defval: '#ef5350', group: '⑥ FVG 缺口', inline: 'fvgcol' },
  { key: 'fvgTrans', title: '填充透明度', type: 'int' as const, defval: 82, min: 0, max: 100, group: '⑥ FVG 缺口' },
  // ⑦ 内包 K
  { key: 'ibOn', title: '标记内包 K 线', type: 'bool' as const, defval: true, group: '⑦ 内包 K 线' },
  { key: 'ibStrict', title: '严格内包', type: 'bool' as const, defval: false, group: '⑦ 内包 K 线' },
  { key: 'ibColor', title: '实体颜色', type: 'color' as const, defval: '#ff9800', group: '⑦ 内包 K 线', inline: 'ibcol' },
  { key: 'ibTrans', title: '透明度', type: 'int' as const, defval: 30, min: 0, max: 100, group: '⑦ 内包 K 线', inline: 'ibcol' },
  // ⑧ OB
  { key: 'obOn', title: '显示 OB 订单块', type: 'bool' as const, defval: true, group: '⑧ OB 订单块' },
  { key: 'obShowBull', title: '看涨 OB（需求）', type: 'bool' as const, defval: true, group: '⑧ OB 订单块', inline: 'obdir' },
  { key: 'obShowBear', title: '看跌 OB（供给）', type: 'bool' as const, defval: true, group: '⑧ OB 订单块', inline: 'obdir' },
  { key: 'obPivot', title: '结构确认根数', type: 'int' as const, defval: 5, min: 2, max: 50, group: '⑧ OB 订单块' },
  { key: 'obKeep', title: '每个方向保留数量', type: 'int' as const, defval: 5, min: 1, max: 20, group: '⑧ OB 订单块' },
  { key: 'obExtend', title: 'OB 向右延伸', type: 'bool' as const, defval: true, group: '⑧ OB 订单块' },
  { key: 'obMitig', title: '失效判定', type: 'string' as const, defval: '影线触及', options: ['影线触及', '收盘突破'], group: '⑧ OB 订单块' },
  { key: 'colObBull', title: '看涨 OB 颜色', type: 'color' as const, defval: '#089981', group: '⑧ OB 订单块', inline: 'obcol' },
  { key: 'colObBear', title: '看跌 OB 颜色', type: 'color' as const, defval: '#b22833', group: '⑧ OB 订单块', inline: 'obcol' },
  { key: 'obTrans', title: '填充透明度', type: 'int' as const, defval: 80, min: 0, max: 100, group: '⑧ OB 订单块' },
];

let registered = false;

/** 注册两个原生指标（幂等）。首次调用时懒加载核心包。 */
export async function registerBigwolf() {
  if (registered) return;
  registered = true;
  if (!registerNativeIndicator) {
    const core = (await import('@luxalgo/vela')) as unknown as { registerNativeIndicator: RegisterFn };
    registerNativeIndicator = core.registerNativeIndicator;
  }
  const register = registerNativeIndicator!;
  register({
    type: 'bigwolf',
    title: '★ bigwolf',
    shortTitle: 'bigwolf',
    paneHint: 'price',
    overlay: true,
    inputsSchema: schema,
    defaultInputs: () => ({ ...DEFAULTS }),
    create: () => new BigwolfPrice() as any,
  });
  register({
    type: 'bigwolf-macd',
    title: '★ bigwolf · MACD（副图）',
    shortTitle: 'bw MACD',
    paneHint: 'new',
    overlay: false,
    inputsSchema: schema,
    defaultInputs: () => ({ ...DEFAULTS }),
    create: () => new BigwolfMacd() as any,
  });
}
