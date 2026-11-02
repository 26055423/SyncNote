/**
 * bigwolf —— Vela 原生指标（不经过 Pine 引擎，因此不需要 unsafe-eval、也不依赖 AGPL 包）。
 *
 * 两个类型：
 *   bigwolf       主图叠加：Vegas 通道 / 时段箱体+KZ / 时段高低点 / FVG / 内包 K / 穿零轴标记 / OB
 *   bigwolf-macd  副图：MACD 线、信号线、能量柱、零轴、金叉死叉
 *
 * 计算全部在这里完成，画图交给 ctx.emit()。
 */
// 动态导入：核心包本来就在图表初始化时懒加载，这里复用它，别把 1.2MB 核心拖进首屏。
type RegisterFn = (descriptor: any) => void;
let registerNativeIndicator: RegisterFn | null = null;

type Bars = readonly { time: number; open: number; high: number; low: number; close: number }[];

interface Inputs {
  /** Vegas */
  showVegas: boolean;
  showTubeA: boolean;
  showTubeB: boolean;
  /** 时段 */
  showSessions: boolean;
  showKz: boolean;
  showLevels: boolean;
  /** 其它 */
  showFvg: boolean;
  showInside: boolean;
  showMarks: boolean;
  showOb: boolean;
  /** MACD 参数（副图） */
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
}

const BEIJING_OFFSET = 8 * 3600_000;

function minutesInBeijing(ms: number): number {
  const d = new Date(ms + BEIJING_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
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

/** 时段定义：北京时间。kz = Kill Zone 子窗口。 */
const SESSIONS: Array<{ name: string; start: number; end: number; color: string; kz: Array<[number, number, string]> }> = [
  { name: '亚盘', start: 7 * 60, end: 15 * 60 + 30, color: '#42a5f5', kz: [] },
  { name: '欧盘', start: 15 * 60 + 30, end: 23 * 60 + 30, color: '#ab47bc', kz: [[15 * 60 + 30, 17 * 60, '伦敦 KZ']] },
  {
    name: '美盘',
    start: 20 * 60 + 30,
    end: 5 * 60,
    color: '#26a69a',
    kz: [
      [20 * 60 + 30, 23 * 60 + 30, '美盘 AM KZ'],
      [2 * 60, 4 * 60, '美盘 PM KZ'],
    ],
  },
];

interface BoxOut {
  left: number;
  right: number;
  top: number;
  bottom: number;
  color: string;
  border?: string;
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
}

interface Computed {
  vegas: Array<{ points: Array<{ time: number; price: number }>; color: string; width: number }>;
  boxes: BoxOut[];
  lines: LineOut[];
  labels: LabelOut[];
}

/** 主图叠加层的全部计算。 */
function computeOverlay(bars: Bars, inputs: Inputs): Computed {
  const n = bars.length;
  const out: Computed = { vegas: [], boxes: [], lines: [], labels: [] };
  if (n < 3) return out;

  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time);

  if (inputs.showVegas) {
    const set: Array<[number, string, number, boolean]> = [
      [12, '#ff9800', 1, true],
      [144, '#f23645', 1, inputs.showTubeA],
      [169, '#f23645', 2, inputs.showTubeA],
      [576, '#2962ff', 1, inputs.showTubeB],
      [676, '#2962ff', 2, inputs.showTubeB],
    ];
    for (const [length, color, width, on] of set) {
      if (!on || n < 2) continue;
      const values = ema(closes, length);
      const points = values.map((value, i) => ({ time: times[i], price: value }));
      out.vegas.push({ points, color, width });
    }
  }

  // ── 时段箱体 / KZ / 时段高低点 ───────────────────────────────────────────
  for (const session of SESSIONS) {
    let openIndex = -1;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    const flush = (endIndex: number) => {
      if (openIndex < 0) return;
      const from = times[openIndex];
      const to = times[endIndex] ?? times[openIndex];
      if (inputs.showSessions) {
        out.boxes.push({
          left: from,
          right: to,
          top: high,
          bottom: low,
          color: `${session.color}1f`,
          border: `${session.color}55`,
          text: session.name,
          textColor: session.color,
        });
      }
      if (inputs.showLevels) {
        out.lines.push({ x1: from, y1: high, x2: to, y2: high, color: session.color, width: 1, style: 'dashed' });
        out.lines.push({ x1: from, y1: low, x2: to, y2: low, color: session.color, width: 1, style: 'dashed' });
      }
      openIndex = -1;
      high = Number.NEGATIVE_INFINITY;
      low = Number.POSITIVE_INFINITY;
    };
    for (let i = 0; i < n; i += 1) {
      const active = inWindow(minutesInBeijing(times[i]), session.start, session.end);
      if (active && openIndex < 0) {
        openIndex = i;
        high = bars[i].high;
        low = bars[i].low;
      } else if (active) {
        high = Math.max(high, bars[i].high);
        low = Math.min(low, bars[i].low);
      } else if (openIndex >= 0) {
        flush(i - 1);
      }
    }
    if (openIndex >= 0) flush(n - 1);
  }

  // Kill Zone 单独一层
  if (inputs.showKz) {
    for (const session of SESSIONS) {
      for (const [start, end, name] of session.kz) {
        let from = -1;
        let hi = Number.NEGATIVE_INFINITY;
        let lo = Number.POSITIVE_INFINITY;
        let last = -1;
        for (let i = 0; i < n; i += 1) {
          const active = inWindow(minutesInBeijing(times[i]), start, end);
          if (active) {
            if (from < 0) from = i;
            hi = Math.max(hi, bars[i].high);
            lo = Math.min(lo, bars[i].low);
            last = i;
          } else if (from >= 0) {
            out.boxes.push({ left: times[from], right: times[last], top: hi, bottom: lo, color: `${session.color}26`, border: `${session.color}66`, text: name, textColor: session.color });
            from = -1;
          }
        }
        if (from >= 0) out.boxes.push({ left: times[from], right: times[last], top: hi, bottom: lo, color: `${session.color}26`, border: `${session.color}66`, text: name, textColor: session.color });
      }
    }
  }

  // ── FVG ────────────────────────────────────────────────────────────────
  if (inputs.showFvg) {
    let bull = 0;
    let bear = 0;
    for (let i = n - 1; i >= 2 && (bull < 20 || bear < 20); i -= 1) {
      const a = bars[i - 2];
      const c = bars[i];
      if (bull < 20 && c.low > a.high) {
        out.boxes.push({ left: times[i - 1], right: times[i], top: c.low, bottom: a.high, color: '#26a69a22', border: '#26a69a66' });
        bull += 1;
      }
      if (bear < 20 && c.high < a.low) {
        out.boxes.push({ left: times[i - 1], right: times[i], top: a.low, bottom: c.high, color: '#ef535022', border: '#ef535066' });
        bear += 1;
      }
    }
  }

  // ── 内包 K 线 ───────────────────────────────────────────────────────────
  if (inputs.showInside) {
    for (let i = Math.max(1, n - 300); i < n; i += 1) {
      const prev = bars[i - 1];
      const cur = bars[i];
      if (!(cur.high <= prev.high && cur.low >= prev.low)) continue;
      const top = Math.max(cur.open, cur.close);
      const bottom = Math.min(cur.open, cur.close);
      out.boxes.push({ left: times[i], right: times[i], top, bottom, color: '#ff980099', border: '#ff9800' });
    }
  }

  // ── MACD 穿零轴标记 ─────────────────────────────────────────────────────
  if (inputs.showMarks) {
    const values = macdSeries(closes, inputs.macdFast, inputs.macdSlow, inputs.macdSignal);
    const atr = atrSeries(bars, 14);
    for (let i = 2; i < n; i += 1) {
      const prev = values.line[i - 1];
      const now = values.line[i];
      if (!Number.isFinite(prev) || !Number.isFinite(now)) continue;
      if (prev <= 0 && now > 0) {
        let low = Number.POSITIVE_INFINITY;
        let lowAt = i;
        for (let j = Math.max(0, i - 20); j <= i; j += 1) {
          if (bars[j].low < low) {
            low = bars[j].low;
            lowAt = j;
          }
        }
        out.labels.push({ x: times[lowAt], y: low - atr[lowAt] * 0.15, text: '⚔️', color: '#26a69a', style: 'label_up' });
      } else if (prev >= 0 && now < 0) {
        let high = Number.NEGATIVE_INFINITY;
        let highAt = i;
        for (let j = Math.max(0, i - 20); j <= i; j += 1) {
          if (bars[j].high > high) {
            high = bars[j].high;
            highAt = j;
          }
        }
        out.labels.push({ x: times[highAt], y: high + atr[highAt] * 0.15, text: '⚔️', color: '#ef5350', style: 'label_down' });
      }
    }
    if (out.labels.length > 30) out.labels = out.labels.slice(-30);
  }

  // ── OB 订单块（结构突破取腿部极值） ────────────────────────────────────
  if (inputs.showOb) {
    const pivot = 5;
    let swingHi = Number.NaN;
    let swingLo = Number.NaN;
    let hiBar = -1;
    let loBar = -1;
    let bullCount = 0;
    let bearCount = 0;
    for (let i = pivot; i < n - pivot; i += 1) {
      let isHi = true;
      let isLo = true;
      for (let k = 1; k <= pivot; k += 1) {
        if (bars[i].high <= bars[i - k].high || bars[i].high <= bars[i + k].high) isHi = false;
        if (bars[i].low >= bars[i - k].low || bars[i].low >= bars[i + k].low) isLo = false;
      }
      if (isHi) {
        swingHi = bars[i].high;
        hiBar = i;
      }
      if (isLo) {
        swingLo = bars[i].low;
        loBar = i;
      }
      if (bullCount < 5 && Number.isFinite(swingHi) && hiBar >= 0 && bars[i].close > swingHi) {
        let low = Number.POSITIVE_INFINITY;
        let lowAt = hiBar;
        for (let j = hiBar; j <= i; j += 1) {
          if (bars[j].low < low) {
            low = bars[j].low;
            lowAt = j;
          }
        }
        out.boxes.push({ left: times[lowAt], right: times[i], top: bars[lowAt].high, bottom: low, color: '#08998126', border: '#08998166' });
        bullCount += 1;
        swingHi = Number.NaN;
      }
      if (bearCount < 5 && Number.isFinite(swingLo) && loBar >= 0 && bars[i].close < swingLo) {
        let high = Number.NEGATIVE_INFINITY;
        let highAt = loBar;
        for (let j = loBar; j <= i; j += 1) {
          if (bars[j].high > high) {
            high = bars[j].high;
            highAt = j;
          }
        }
        out.boxes.push({ left: times[highAt], right: times[i], top: high, bottom: bars[highAt].low, color: '#b2283326', border: '#b2283366' });
        bearCount += 1;
        swingLo = Number.NaN;
      }
    }
  }

  return out;
}

function atrSeries(bars: Bars, length: number): number[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)));
  }
  return ema(trs, length);
}

/** 主图叠加指标。 */
class BigwolfPrice {
  private ctx: any;
  private inputs!: Inputs;

  start(ctx: any, inputs: Record<string, unknown>) {
    this.ctx = ctx;
    this.inputs = inputs as unknown as Inputs;
    this.paint();
  }

  onBars() {
    this.paint();
  }

  setInputs(inputs: Record<string, unknown>) {
    this.inputs = inputs as unknown as Inputs;
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
    const bars = ctx.bars() as Bars;
    const data = computeOverlay(bars, this.inputs);
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
      bgColor: box.color,
      borderColor: box.border,
      borderWidth: 1,
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
      extend: 'none' as const,
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
      color: label.color,
      textColor: '#ffffff',
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

/** 副图 MACD。 */
class BigwolfMacd {
  private ctx: any;
  private inputs!: Inputs;

  start(ctx: any, inputs: Record<string, unknown>) {
    this.ctx = ctx;
    this.inputs = inputs as unknown as Inputs;
    this.paint();
  }

  onBars() {
    this.paint();
  }

  setInputs(inputs: Record<string, unknown>) {
    this.inputs = inputs as unknown as Inputs;
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
    const bars = ctx.bars() as Bars;
    const closes = bars.map((bar) => bar.close);
    const values = macdSeries(closes, this.inputs.macdFast, this.inputs.macdSlow, this.inputs.macdSignal);
    const paneId = '';
    const points = (series: number[]) => series.map((value, index) => ({ time: bars[index].time, value: Number.isFinite(value) ? value : null }));
    const series = [
      { id: 'bw-macd', title: 'MACD', paneId, kind: 'line' as const, points: points(values.line), style: { color: '#2962ff', width: 1, lineStyle: 'solid' as const } },
      { id: 'bw-signal', title: '信号线', paneId, kind: 'line' as const, points: points(values.signal), style: { color: '#ff6d00', width: 1, lineStyle: 'solid' as const } },
      { id: 'bw-hist', title: '能量柱', paneId, kind: 'columns' as const, points: points(values.hist), style: { color: '#26a69a', width: 1, lineStyle: 'solid' as const, base: 0 } },
    ];
    const priceLines = [{ id: 'bw-zero', paneId, price: 0, color: '#888888', lineStyle: 'dotted' as const, width: 1 }];
    try {
      ctx.emit({ series, priceLines });
    } catch (error) {
      console.warn('bigwolf-macd emit failed', error);
    }
  }
}

const sharedInputs = () => [
  { key: 'showVegas', title: 'Vegas 通道', type: 'bool' as const, defval: true, group: '② Vegas' },
  { key: 'showTubeA', title: '主通道 144/169', type: 'bool' as const, defval: true, group: '② Vegas' },
  { key: 'showTubeB', title: '次通道 576/676', type: 'bool' as const, defval: true, group: '② Vegas' },
  { key: 'showSessions', title: '时段箱体', type: 'bool' as const, defval: true, group: '③ 时段' },
  { key: 'showKz', title: 'Kill Zone 箱体', type: 'bool' as const, defval: true, group: '③ 时段' },
  { key: 'showLevels', title: '时段高低点', type: 'bool' as const, defval: true, group: '④ 高低点' },
  { key: 'showFvg', title: 'FVG 缺口', type: 'bool' as const, defval: true, group: '⑥ FVG' },
  { key: 'showInside', title: '内包 K 线', type: 'bool' as const, defval: true, group: '⑦ 内包 K' },
  { key: 'showMarks', title: '穿零轴标记', type: 'bool' as const, defval: true, group: '⑤ 标记' },
  { key: 'showOb', title: 'OB 订单块', type: 'bool' as const, defval: true, group: '⑧ OB' },
  { key: 'macdFast', title: 'MACD 快线', type: 'int' as const, defval: 12, min: 1, max: 200, group: '① MACD' },
  { key: 'macdSlow', title: 'MACD 慢线', type: 'int' as const, defval: 26, min: 1, max: 400, group: '① MACD' },
  { key: 'macdSignal', title: 'MACD 信号线', type: 'int' as const, defval: 9, min: 1, max: 200, group: '① MACD' },
];

const defaultInputs = () => ({
  showVegas: true,
  showTubeA: true,
  showTubeB: true,
  showSessions: true,
  showKz: true,
  showLevels: true,
  showFvg: true,
  showInside: true,
  showMarks: true,
  showOb: true,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
});

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
    title: '★ bigwolf（主图）',
    shortTitle: 'bigwolf',
    paneHint: 'price',
    overlay: true,
    inputsSchema: sharedInputs,
    defaultInputs,
    create: () => new BigwolfPrice() as any,
  });
  register({
    type: 'bigwolf-macd',
    title: '★ bigwolf · MACD（副图）',
    shortTitle: 'bw MACD',
    paneHint: 'new',
    overlay: false,
    inputsSchema: sharedInputs,
    defaultInputs,
    create: () => new BigwolfMacd() as any,
  });
}
