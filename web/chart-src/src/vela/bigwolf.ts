/**
 * bigwolf：Vegas 通道 + 交易时段箱体 + 时段高低点 + FVG + 内包 K 线 + MACD 穿零轴标记。
 *
 * 参考 Pine v6 版 `bigwolf`。这里用 Vela 的绘图 API 实现（折线 / 方框 / 标签），
 * 不做 MACD 副图窗格——Vela 的自定义指标需要走它自己的脚本引擎，我们暂时用
 * 「主图叠加 + 标签」的方式把能画的都画出来。
 *
 * 所有坐标都是 `{time: 毫秒, price}`；数据来自调用方传进来的该格 K 线（秒）。
 */

export interface BigwolfBars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
}

export interface BigwolfConfig {
  vegas: boolean;
  sessions: boolean;
  levels: boolean;
  fvg: boolean;
  inside: boolean;
  marks: boolean;
}

export const BIGWOLF_DEFAULTS: BigwolfConfig = {
  vegas: true,
  sessions: true,
  levels: true,
  fvg: true,
  inside: true,
  marks: true,
};

const VEGAS_LENGTHS: Array<[string, number, string, number]> = [
  ['ema12', 12, '#ff9800', 1],
  ['ema144', 144, '#f23645', 1],
  ['ema169', 169, '#f23645', 2],
  ['ema576', 576, '#2962ff', 1],
  ['ema676', 676, '#2962ff', 2],
];

/** 把 [[t,o,h,l,c]] 拆成列，便于逐根计算。 */
export function splitBars(rows: number[][]): BigwolfBars {
  const bars: BigwolfBars = { t: [], o: [], h: [], l: [], c: [] };
  for (const row of rows) {
    if (!row || row.length < 5) continue;
    bars.t.push(Number(row[0]) * 1000);
    bars.o.push(Number(row[1]));
    bars.h.push(Number(row[2]));
    bars.l.push(Number(row[3]));
    bars.c.push(Number(row[4]));
  }
  return bars;
}

/** Pine 的 ta.ema：alpha = 2/(len+1)，首值用第一个收盘价播种。 */
export function ema(values: number[], length: number): number[] {
  const out: number[] = [];
  const alpha = 2 / (length + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    prev = Number.isFinite(prev) ? prev + alpha * (v - prev) : v;
    out.push(prev);
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const fastLine = ema(closes, fast);
  const slowLine = ema(closes, slow);
  const line = closes.map((_, i) => fastLine[i] - slowLine[i]);
  const signalLine = ema(line, signal);
  const hist = line.map((v, i) => v - signalLine[i]);
  return { line, signal: signalLine, hist };
}

/** 交易时段定义：按北京时间填（与 Pine 版一致），跨日的用 start > end 表示。 */
const SESSIONS: Array<{ name: string; start: number; end: number; color: string; kz?: Array<[number, number]> }> = [
  { name: '亚盘', start: 7 * 60, end: 15 * 60 + 30, color: '#42a5f5' },
  {
    name: '欧盘',
    start: 15 * 60 + 30,
    end: 23 * 60 + 30,
    color: '#ab47bc',
    kz: [[15 * 60 + 30, 17 * 60]],
  },
  {
    name: '美盘',
    start: 20 * 60 + 30,
    end: 5 * 60,
    color: '#26a69a',
    kz: [
      [20 * 60 + 30, 23 * 60 + 30],
      [2 * 60, 4 * 60],
    ],
  },
];

/** 北京时间（UTC+8）= 本地分钟数。图表时间戳是 UTC 毫秒。 */
function beijingMinutes(ms: number): number {
  const d = new Date(ms + 8 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function inWindow(minutes: number, start: number, end: number): boolean {
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface BigwolfBox {
  from: number;
  to: number;
  top: number;
  bottom: number;
  color: string;
  label?: string;
}

export interface BigwolfLevel {
  from: number;
  to: number;
  price: number;
  color: string;
  swept: boolean;
}

export interface BigwolfResult {
  polylines: Array<{ points: Array<{ time: number; price: number }>; color: string; width: number }>;
  boxes: BigwolfBox[];
  levels: BigwolfLevel[];
  labels: Array<{ time: number; price: number; text: string; color: string; above: boolean }>;
}

const MAX_POINTS = 1200;

/** 计算整份 bigwolf 叠加层。只保留最近的一部分，避免绘图对象无限增长。 */
export function computeBigwolf(rows: number[][], config: BigwolfConfig): BigwolfResult {
  const bars = splitBars(rows);
  const n = bars.t.length;
  const result: BigwolfResult = { polylines: [], boxes: [], levels: [], labels: [] };
  if (n < 3) return result;

  if (config.vegas) {
    for (const [, length, color, width] of VEGAS_LENGTHS) {
      if (n < length) continue;
      const values = ema(bars.c, length);
      const start = Math.max(0, n - MAX_POINTS);
      const points: Array<{ time: number; price: number }> = [];
      for (let i = start; i < n; i += 1) points.push({ time: bars.t[i], price: values[i] });
      result.polylines.push({ points, color, width });
    }
  }

  if (config.sessions) {
    for (const session of SESSIONS) {
      let open = -1;
      let high = -Infinity;
      let low = Infinity;
      let startTime = 0;
      let endTime = 0;
      const flush = (closeIndex: number) => {
        if (open < 0) return;
        result.boxes.push({
          from: startTime,
          to: endTime,
          top: high,
          bottom: low,
          color: `${session.color}1f`,
          label: session.name,
        });
        if (config.levels) {
          result.levels.push({ from: startTime, to: bars.t[closeIndex], price: high, color: session.color, swept: false });
          result.levels.push({ from: startTime, to: bars.t[closeIndex], price: low, color: session.color, swept: false });
        }
        open = -1;
        high = -Infinity;
        low = Infinity;
      };
      for (let i = 0; i < n; i += 1) {
        const minutes = beijingMinutes(bars.t[i]);
        const active = inWindow(minutes, session.start, session.end);
        if (active && open < 0) {
          open = i;
          startTime = bars.t[i];
          endTime = bars.t[i];
          high = bars.h[i];
          low = bars.l[i];
        } else if (active) {
          high = Math.max(high, bars.h[i]);
          low = Math.min(low, bars.l[i]);
          endTime = bars.t[i];
        } else if (!active && open >= 0) {
          endTime = bars.t[i - 1] ?? bars.t[i];
          flush(i);
        }
      }
      if (open >= 0) flush(n - 1);
      // 只保留最近若干段
      const keep = 6;
      const own = result.boxes.filter((b) => b.color === `${session.color}1f`);
      if (own.length > keep) {
        const drop = new Set(own.slice(0, own.length - keep));
        result.boxes = result.boxes.filter((b) => !drop.has(b));
      }
    }
  }

  if (config.fvg) {
    const minGap = 0;
    const bull: BigwolfBox[] = [];
    const bear: BigwolfBox[] = [];
    for (let i = 2; i < n; i += 1) {
      if (bars.l[i] > bars.h[i - 2] && bars.l[i] - bars.h[i - 2] > minGap) {
        bull.push({ from: bars.t[i - 1], to: bars.t[i], top: bars.l[i], bottom: bars.h[i - 2], color: '#26a69a26' });
      }
      if (bars.h[i] < bars.l[i - 2] && bars.l[i - 2] - bars.h[i] > minGap) {
        bear.push({ from: bars.t[i - 1], to: bars.t[i], top: bars.l[i - 2], bottom: bars.h[i], color: '#ef535026' });
      }
    }
    result.boxes.push(...bull.slice(-20), ...bear.slice(-20));
  }

  if (config.inside) {
    for (let i = Math.max(1, n - 400); i < n; i += 1) {
      const inside = bars.h[i] <= bars.h[i - 1] && bars.l[i] >= bars.l[i - 1];
      if (!inside) continue;
      const top = Math.max(bars.o[i], bars.c[i]);
      const bottom = Math.min(bars.o[i], bars.c[i]);
      result.boxes.push({ from: bars.t[i], to: bars.t[i], top, bottom, color: '#ff980055' });
    }
  }

  if (config.marks) {
    const values = macd(bars.c);
    for (let i = 2; i < n; i += 1) {
      const prev = values.line[i - 1];
      const now = values.line[i];
      if (!Number.isFinite(prev) || !Number.isFinite(now)) continue;
      if (prev <= 0 && now > 0) {
        let low = Infinity;
        let lowAt = i;
        for (let j = Math.max(0, i - 20); j <= i; j += 1) {
          if (bars.l[j] < low) {
            low = bars.l[j];
            lowAt = j;
          }
        }
        result.labels.push({ time: bars.t[lowAt], price: low, text: '⚔️', color: '#26a69a', above: false });
      } else if (prev >= 0 && now < 0) {
        let high = -Infinity;
        let highAt = i;
        for (let j = Math.max(0, i - 20); j <= i; j += 1) {
          if (bars.h[j] > high) {
            high = bars.h[j];
            highAt = j;
          }
        }
        result.labels.push({ time: bars.t[highAt], price: high, text: '⚔️', color: '#ef5350', above: true });
      }
    }
    result.labels = result.labels.slice(-30);
  }

  return result;
}
