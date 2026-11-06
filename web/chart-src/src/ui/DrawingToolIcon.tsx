import type { ReactNode } from 'react';

/** Small line icons for drawing favorites, matching the Vela toolbar. */
const icons: Record<string, ReactNode> = {
  trendline: <><path d="M3 13 13 3" /><circle cx="3" cy="13" r="1" /><circle cx="13" cy="3" r="1" /></>,
  hline: <path d="M2 8h12" />,
  vline: <path d="M8 2v12" />,
  ray: <><circle cx="3" cy="12" r="1" /><path d="m4 11 10-9" /></>,
  extendedline: <><path d="m2 14 12-12" /><circle cx="5" cy="11" r="1" /><circle cx="11" cy="5" r="1" /></>,
  crossline: <path d="M2 8h12M8 2v12" />,
  trendangle: <><path d="M14 13H3L13 3" /><path d="M8 13a5 5 0 0 0-1.5-3.5" /></>,
  infoline: <><path d="m2 14 6-6" /><circle cx="10.5" cy="5.5" r="3.5" /><path d="M10.5 5.5v2M10.5 3.5h.01" /></>,
  box: <rect x="2.5" y="3.5" width="11" height="9" rx=".5" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />,
  triangle: <path d="m8 2 6 11H2Z" />,
  polyline: <path d="m2 12 4-7 4 4 4-6" />,
  freehand: <path d="M2 12c1-5 2-9 4-9s-2 10 0 10 3-7 5-7 0 5 3 4" />,
  highlighter: <><path d="m5 10 5-7 3 2-5 7ZM5 10l-.5 3 3.5-1M2 14h9" /></>,
  arrow: <path d="M2 13 13 2M7 2h6v6" />,
  arrowmarkup: <path d="M8 14V2M3 7l5-5 5 5" />,
  arrowmarkdown: <path d="M8 2v12M3 9l5 5 5-5" />,
  text: <path d="M3 4V2.5h10V4M8 2.5v11M5.5 13.5h5" />,
  note: <><path d="M10 2.5H3v11h10V5.5ZM10 2.5v3h3" /><path d="M5.5 8h5M5.5 10.5h3.5" /></>,
  pricenote: <><path d="M2 3h12v7H8l-3 3v-3H2Z" /><path d="M5 6.5h6" /></>,
  comment: <path d="M5 12H2V3h12v9H9l-4 2ZM5 6h6M5 9h4" />,
  pricelabel: <><path d="M2 3h7l5 5-6 6-6-6Z" /><circle cx="5.5" cy="6" r="1" /></>,
  flagmark: <path d="M3 14V2.5h5l1.5 2H14L12 8H3" />,
  fibretracement: <><path d="M2 3h12M2 7h12M2 10h12M2 13h12" /><path d="m3 12 10-8" strokeDasharray="1.2 2" /></>,
  fibextension: <><path d="M2 3h12M2 6h12M2 10h12M2 13h12" /><path d="m3 12 4-5 3 2 3-6" strokeDasharray="1.2 2" /></>,
  fibfan: <path d="M2 13 14 2M2 13l12-7M2 13l12-3M2 13h12" />,
  fibtimezones: <path d="M2 2v12M4 2v12M7 2v12M12 2v12M14 2v12" />,
  fibchannel: <path d="m2 7 10-5M2 10l12-6M2 13l12-6M5 14l9-4" />,
  parallelchannel: <><path d="M2 7 12 2M4 14l10-5" /><path d="m3 10.5 10-5" strokeDasharray="1.2 2" /></>,
  regressionchannel: <><path d="M2 7 12 2M4 14l10-5" /><path d="m3 11 3-4 3 1 4-3" /></>,
  pitchfork: <path d="m3 14 7-9M2 8l10-6M7 14l7-9M4 7l7 5" />,
  position: <><path d="M2 8h12M8 2v12M2 3h12v10H2Z" /><path d="M5 5.5h6M5 10.5h6" /></>,
  datepricerange: <><rect x="2.5" y="2.5" width="11" height="11" rx=".5" /><path d="M5 6V4h2M11 10v2H9M5 4l6 8" /></>,
  magnifier: <><circle cx="6.5" cy="6.5" r="4" /><path d="m9.5 9.5 4 4M4.5 6.5h4M6.5 4.5v4" /></>,
  xabcd: <path d="m2 11 3-8 3 9 3-6 3 8M2 11l9-5M5 3l9 11" />,
  headshoulders: <path d="m1.5 12 3-6 2 3L8 2.5l2 6.5 2-3 2.5 6M2 12h12" />,
  elliottimpulse: <path d="m2 14 3-6 2 3 3-9 2 5 2-5" />,
  fairvaluegap: <><path d="M3 2v5M8 5v6M13 9v5M1.5 3.5h3v2h-3ZM6.5 6.5h3v3h-3ZM11.5 10.5h3v2h-3Z" /><path d="M2 8.5h12" strokeDasharray="1.2 2" /></>,
  orderblock: <><rect x="2" y="5" width="12" height="6" rx=".5" /><path d="M4 2v3M8 11v3M12 2v3M5 8h6" /></>,
  liquidity: <><path d="M2 5h12M2 11h12M3 8l2-1 2 2 2-2 2 1 2-1" /><path d="M3 2v1M8 2v1M13 2v1" /></>,
};

export function DrawingToolIcon({ tool }: { tool: string }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {icons[tool] ?? <path d="m3 12 7-8 3 3-7 7H3ZM9 5l3 3" />}
  </svg>;
}
