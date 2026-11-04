/**
 * 右侧工具栏图标：统一成一种线框风格（1.6px 描边、`currentColor`），
 * 这样深色/浅色主题都能直接用颜色令牌，也不会像 emoji 那样各平台长得不一样。
 */
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  width: 19,
  height: 19,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

/** 交易：带上下影线的 K 线。 */
export function TradeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M7 4v3.2M7 16.8V20M17 3v4.2M17 15.8V21" />
      <rect x="4.6" y="7.2" width="4.8" height="9.6" rx="1.1" />
      <rect x="14.6" y="7.2" width="4.8" height="8.6" rx="1.1" />
    </svg>
  );
}

/** 账户与设置：齿轮。 */
export function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.4 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4 15a1.7 1.7 0 0 0-1.56-1.03H2.4a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.05 8.4a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1.03-1.56V2.4a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 14.46 4c.66.14 1.35-.05 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8.4c.14.66.61 1.21 1.16 1.56" />
    </svg>
  );
}
/** 消息：信封。复盘分享就是一条带切片的消息。 */
export function MailIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="5.4" width="18" height="13.2" rx="2" />
      <path d="M3.7 7 12 12.8 20.3 7" />
    </svg>
  );
}

/** 好友：两个人。 */
export function FriendsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="9.2" cy="9" r="3.1" />
      <path d="M3.6 19.4c0-2.8 2.5-4.8 5.6-4.8s5.6 2 5.6 4.8" />
      <path d="M15.6 6.4a2.9 2.9 0 0 1 0 5.4M17 14.9c2 .5 3.4 2.1 3.4 4.3" />
    </svg>
  );
}

/** 复盘：带折线的图板。 */
export function ReviewIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2" />
      <path d="M6.6 14.6l2.8-3.4 2.6 2.2 3-4.2 2.4 2.1" />
      <path d="M6.6 17.2h10.8" opacity=".5" />
    </svg>
  );
}
