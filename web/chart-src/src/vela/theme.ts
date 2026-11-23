import type { VelaTheme } from '@luxalgo/vela';

/**
 * 交易台配色（对齐 OpenMarket 的深色主题）：
 *
 * - 近黑中性灰打底（#0f0f0f），层级只靠 1px 描边拉开，不再带蓝调
 * - 强调色是他们家的青绿 #2999af，而不是默认的 TradingView 蓝
 * - 涨/买用同一支青绿，跌/卖用砖红 #c04341
 *
 * Vela 的 canvas 只认 VelaTheme 对象（不是 CSS 变量），所以这里给它一份同样的主题，
 * 让图表底色、网格、涨跌 K 线与页面 chrome 用同一套颜色。
 */
export const openMarketDark: VelaTheme = {
  background: '#121214',
  textColor: '#dbdbdb',
  gridColor: '#232326',
  borderColor: '#2a2a2a',
  upColor: '#2999af',
  downColor: '#c04341',
  fontFamily: 'sans-serif',
};

/** 深色给自定义主题；浅色继续用 Vela 自带的那套（字体和对比度已经调好）。 */
export function velaTheme(mode: 'dark' | 'light'): 'light' | VelaTheme {
  return mode === 'dark' ? openMarketDark : 'light';
}

/**
 * K 线实体的涨跌色。Vela 的 canvas 不读 VelaTheme.upColor/downColor（那是 chrome 变量），
 * 原生渲染器只认构造时传的 `upColor`/`downColor`，所以这里单独给一份。
 */
export const CANDLE_UP = { dark: '#2999af', light: '#2999af' } as const;
export const CANDLE_DOWN = { dark: '#c04341', light: '#c04341' } as const;
