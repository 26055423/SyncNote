/** 画图工具目录：key 与 Vela 的 DrawingTypeKey 对应，label/icon 用于顶部收藏栏。 */

export interface DrawingTool {
  key: string;
  label: string;
  icon: string;
  group: string;
}

export const DRAWING_TOOLS: DrawingTool[] = [
  { key: 'trendline', label: '趋势线', icon: '╱', group: '线条' },
  { key: 'hline', label: '水平线', icon: '─', group: '线条' },
  { key: 'vline', label: '垂直线', icon: '│', group: '线条' },
  { key: 'ray', label: '射线', icon: '→', group: '线条' },
  { key: 'extendedline', label: '延长线', icon: '⇢', group: '线条' },
  { key: 'crossline', label: '十字线', icon: '✛', group: '线条' },
  { key: 'trendangle', label: '角度线', icon: '∠', group: '线条' },
  { key: 'infoline', label: '信息线', icon: 'ⓘ', group: '线条' },

  { key: 'box', label: '矩形', icon: '▭', group: '形状' },
  { key: 'ellipse', label: '椭圆', icon: '◯', group: '形状' },
  { key: 'triangle', label: '三角形', icon: '△', group: '形状' },
  { key: 'polyline', label: '折线', icon: '⌁', group: '形状' },
  { key: 'freehand', label: '自由画笔', icon: '✎', group: '形状' },
  { key: 'highlighter', label: '荧光笔', icon: '▤', group: '形状' },
  { key: 'arrow', label: '箭头', icon: '➤', group: '形状' },
  { key: 'arrowmarkup', label: '上升箭头', icon: '↑', group: '形状' },
  { key: 'arrowmarkdown', label: '下降箭头', icon: '↓', group: '形状' },

  { key: 'text', label: '文字', icon: 'T', group: '标注' },
  { key: 'note', label: '便签', icon: '🗒', group: '标注' },
  { key: 'pricenote', label: '价格标注', icon: '¤', group: '标注' },
  { key: 'comment', label: '评论', icon: '💬', group: '标注' },
  { key: 'pricelabel', label: '价格标签', icon: '🏷', group: '标注' },
  { key: 'flagmark', label: '旗帜', icon: '⚑', group: '标注' },

  { key: 'fibretracement', label: '斐波那契回撤', icon: '𝔉', group: '斐波那契' },
  { key: 'fibextension', label: '斐波那契扩展', icon: '⨏', group: '斐波那契' },
  { key: 'fibfan', label: '斐波那契扇形', icon: '◺', group: '斐波那契' },
  { key: 'fibtimezones', label: '时间周期', icon: '⏱', group: '斐波那契' },
  { key: 'fibchannel', label: '斐波那契通道', icon: '≋', group: '斐波那契' },

  { key: 'parallelchannel', label: '平行通道', icon: '∥', group: '通道' },
  { key: 'regressionchannel', label: '回归通道', icon: '📈', group: '通道' },
  { key: 'pitchfork', label: '分叉线', icon: '⋔', group: '通道' },

  { key: 'position', label: '头寸测算', icon: '⚖', group: '交易' },
  { key: 'datepricerange', label: '日期价格区间', icon: '⧉', group: '交易' },
  { key: 'magnifier', label: '放大镜', icon: '🔍', group: '交易' },

  { key: 'xabcd', label: 'XABCD 形态', icon: 'X', group: '形态' },
  { key: 'headshoulders', label: '头肩形态', icon: 'M', group: '形态' },
  { key: 'elliottimpulse', label: '艾略特推动浪', icon: '5', group: '形态' },

  { key: 'fairvaluegap', label: '公允价值缺口', icon: '▥', group: '智能' },
  { key: 'orderblock', label: '订单块', icon: '▦', group: '智能' },
  { key: 'liquidity', label: '流动性', icon: '≋', group: '智能' },
];

export const DEFAULT_FAVORITES = ['trendline', 'hline', 'box', 'text'];

const byKey = new Map(DRAWING_TOOLS.map((tool) => [tool.key, tool]));

export function toolLabel(key: string): string {
  return byKey.get(key)?.label ?? key;
}

export function toolIcon(key: string): string {
  return byKey.get(key)?.icon ?? '?';
}
