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
 * SMC structures as a native indicator (all detection runs in the browser).
 *
 * Three families, all anchored to bar indices so they stay correct while panning:
 *   - order blocks : a displacement candle (body > `obMult` × ATR14) plus the last
 *                    opposite-colour candle that set it up
 *   - fair value gap: three-bar imbalance (`low[i+1] > high[i-1]` and the mirror)
 *   - liquidity     : two adjacent swing highs/lows within `liqTol` percent
 *
 * Zones are drawn as boxes from their origin bar to the latest bar, so they refresh on
 * every `onBars()` — no external service, no manual redraw.
 */

interface Zone {
  kind: 'ob' | 'fvg' | 'liq';
  side: 'bull' | 'bear';
  from: number;
  top: number;
  bottom: number;
}

function atr(bars: readonly OHLCV[], period = 14): number[] {
  const out: number[] = [];
  let prevClose: number | null = null;
  const window: number[] = [];
  for (const bar of bars) {
    const tr =
      prevClose == null
        ? bar.high - bar.low
        : Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    window.push(tr);
    if (window.length > period) window.shift();
    out.push(window.reduce((sum, v) => sum + v, 0) / window.length);
    prevClose = bar.close;
  }
  return out;
}

function findOrderBlocks(bars: readonly OHLCV[], multiplier: number): Zone[] {
  const ranges = atr(bars);
  const zones: Zone[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const body = bar.close - bar.open;
    if (Math.abs(body) < Math.max(1e-9, (ranges[i] ?? 0) * multiplier)) continue;
    const bull = body > 0;
    for (let j = i - 1; j >= Math.max(0, i - 20); j -= 1) {
      const prev = bars[j];
      if (!prev) continue;
      const opposite = bull ? prev.close < prev.open : prev.close > prev.open;
      if (!opposite) continue;
      zones.push({ kind: 'ob', side: bull ? 'bull' : 'bear', from: j, top: prev.high, bottom: prev.low });
      break;
    }
  }
  return zones;
}

function findFairValueGaps(bars: readonly OHLCV[]): Zone[] {
  const zones: Zone[] = [];
  for (let i = 1; i < bars.length - 1; i += 1) {
    const prev = bars[i - 1];
    const next = bars[i + 1];
    if (!prev || !next) continue;
    if (next.low > prev.high) zones.push({ kind: 'fvg', side: 'bull', from: i, top: next.low, bottom: prev.high });
    else if (next.high < prev.low) zones.push({ kind: 'fvg', side: 'bear', from: i, top: prev.low, bottom: next.high });
  }
  return zones;
}

function swingPoints(bars: readonly OHLCV[], left = 2, right = 2): { highs: number[]; lows: number[]; highIdx: number[]; lowIdx: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  const highIdx: number[] = [];
  const lowIdx: number[] = [];
  for (let i = left; i < bars.length - right; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    let isHigh = true;
    let isLow = true;
    for (let k = i - left; k <= i + right; k += 1) {
      const other = bars[k];
      if (!other) continue;
      if (other !== bar) {
        if (other.high > bar.high) isHigh = false;
        if (other.low < bar.low) isLow = false;
      }
    }
    if (isHigh) {
      highs.push(bar.high);
      highIdx.push(i);
    }
    if (isLow) {
      lows.push(bar.low);
      lowIdx.push(i);
    }
  }
  return { highs, lows, highIdx, lowIdx };
}

function findLiquidity(bars: readonly OHLCV[], tolerancePct: number): Zone[] {
  const { highs, lows, highIdx, lowIdx } = swingPoints(bars);
  const zones: Zone[] = [];

  for (let k = 1; k < highs.length; k += 1) {
    const a = highs[k - 1] ?? 0;
    const b = highs[k] ?? 0;
    const base = Math.max(a, b);
    if (base <= 0 || a === b) continue;
    if ((Math.abs(a - b) / base) * 100 > tolerancePct) continue;
    zones.push({ kind: 'liq', side: 'bear', from: highIdx[k - 1] ?? 0, top: base, bottom: Math.min(a, b) });
  }
  for (let k = 1; k < lows.length; k += 1) {
    const a = lows[k - 1] ?? 0;
    const b = lows[k] ?? 0;
    const base = Math.min(a, b);
    if (base <= 0 || a === b) continue;
    if ((Math.abs(a - b) / base) * 100 > tolerancePct) continue;
    zones.push({ kind: 'liq', side: 'bull', from: lowIdx[k - 1] ?? 0, top: Math.max(a, b), bottom: base });
  }
  return zones;
}

const COLORS: Record<string, { bg: string; border: string }> = {
  'ob-bull': { bg: 'rgba(38, 166, 154, 0.10)', border: 'rgba(38, 166, 154, 0.55)' },
  'ob-bear': { bg: 'rgba(239, 83, 80, 0.10)', border: 'rgba(239, 83, 80, 0.55)' },
  'fvg-bull': { bg: 'rgba(79, 140, 255, 0.08)', border: 'rgba(79, 140, 255, 0.40)' },
  'fvg-bear': { bg: 'rgba(190, 130, 255, 0.08)', border: 'rgba(190, 130, 255, 0.40)' },
  'liq-bull': { bg: 'rgba(240, 161, 58, 0.07)', border: 'rgba(240, 161, 58, 0.40)' },
  'liq-bear': { bg: 'rgba(240, 161, 58, 0.07)', border: 'rgba(240, 161, 58, 0.40)' },
};

function build(bars: readonly OHLCV[], inputs: Record<string, InputValue>): NativeIndicatorOutput {
  const maxEach = typeof inputs.maxEach === 'number' ? inputs.maxEach : 12;
  const mult = typeof inputs.obMult === 'number' ? inputs.obMult : 1.5;
  const tol = typeof inputs.liqTol === 'number' ? inputs.liqTol : 0.06;

  const zones: Zone[] = [];
  if (inputs.showOB !== false) zones.push(...findOrderBlocks(bars, mult).slice(-maxEach));
  if (inputs.showFVG !== false) zones.push(...findFairValueGaps(bars).slice(-maxEach));
  if (inputs.showLiq !== false) zones.push(...findLiquidity(bars, tol).slice(-Math.round(maxEach / 2)));

  const last = Math.max(0, bars.length - 1);
  const boxes = zones.map((zone, index) => {
    const palette = COLORS[`${zone.kind}-${zone.side}`] ?? COLORS['ob-bull']!;
    return {
      id: `smc-${zone.kind}-${index}`,
      paneId: '',
      xloc: 'bar_index' as const,
      left: zone.from,
      right: last,
      top: Math.max(zone.top, zone.bottom),
      bottom: Math.min(zone.top, zone.bottom),
      extend: 'none' as const,
      bgColor: palette.bg,
      borderColor: palette.border,
      borderWidth: 1,
      borderStyle: 'solid' as const,
      textSize: 'tiny' as const,
      hAlign: 'center' as const,
      vAlign: 'center' as const,
      wrap: false,
      fontFamily: 'default' as const,
      bold: false,
      italic: false,
      overlay: true,
    };
  });

  return { boxes };
}

const descriptor: NativeIndicatorDescriptor = {
  type: 'smc-structures',
  title: 'SMC 结构（订单块 / 失衡 / 流动性）',
  shortTitle: 'SMC',
  paneHint: 'price',
  overlay: true,
  multiInstance: false,
  inputsSchema: () => [
    { key: 'showOB', title: '订单块', type: 'bool', defval: true },
    { key: 'showFVG', title: '失衡缺口', type: 'bool', defval: true },
    { key: 'showLiq', title: '流动性', type: 'bool', defval: true },
    {
      key: 'obMult',
      title: '订单块 ATR 倍数',
      type: 'float',
      defval: 1.5,
      min: 0.5,
      max: 5,
      step: 0.1,
    },
    {
      key: 'maxEach',
      title: '每类最多显示',
      type: 'int',
      defval: 12,
      min: 3,
      max: 60,
    },
    {
      key: 'liqTol',
      title: '流动性容差（%）',
      type: 'float',
      defval: 0.06,
      min: 0.01,
      max: 1,
      step: 0.01,
    },
  ],
  defaultInputs: () => ({ showOB: true, showFVG: true, showLiq: true, obMult: 1.5, maxEach: 12, liqTol: 0.06 }),
  create: (): NativeIndicator => {
    let ctx: NativeIndicatorContext | null = null;
    let inputs: Record<string, InputValue> = {};

    const emit = (): void => {
      if (!ctx) return;
      ctx.emit(build(ctx.bars(), inputs));
    };

    return {
      start(context, initialInputs) {
        ctx = context;
        inputs = initialInputs;
        emit();
      },
      onBars() {
        emit();
      },
      onViewport() {
        /* index-anchored, no viewport dependency */
      },
      setInputs(next) {
        inputs = next;
        emit();
      },
      suspend() {
        /* nothing to release */
      },
      resume() {
        emit();
      },
      stop() {
        ctx = null;
      },
    };
  },
};

registerNativeIndicator(descriptor);

export const SMC_TYPE = descriptor.type;
