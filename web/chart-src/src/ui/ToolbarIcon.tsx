/** Geometry follows Vela's 16px, 1.2px rounded outline toolbar icons. */
export function ToolbarIcon({ name }: { name: 'calendar' | 'terminal' | 'layout' | 'fullscreen' | 'gear' | 'replay' | 'live' | 'chevron' }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'calendar' && <><rect x="2" y="3.5" width="12" height="10.5" rx="1.5"/><path d="M5 2v3M11 2v3M2 7h12M5 10h2M9 10h2"/></>}
    {name === 'terminal' && <><rect x="1.5" y="2" width="13" height="9" rx="1.3"/><path d="M5 14h6M8 11v3M4 8l2-3 2 3 3-4"/></>}
    {name === 'layout' && <><rect x="2" y="2" width="12" height="12" rx="1"/><path d="M8 2v12M2 8h12"/></>}
    {name === 'fullscreen' && <path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"/>}
    {name === 'gear' && <><path d="m6.5 1.5-.4 1.7-1.3.8-1.7-.5-1.5 2.6 1.3 1.2v1.4l-1.3 1.2 1.5 2.6 1.7-.5 1.3.8.4 1.7h3l.4-1.7 1.3-.8 1.7.5 1.5-2.6-1.3-1.2V7.3l1.3-1.2-1.5-2.6-1.7.5-1.3-.8-.4-1.7z"/><circle cx="8" cy="8" r="2.3"/></>}
    {name === 'replay' && <><path d="M3 3v10M12.5 3.5 6 8l6.5 4.5z"/></>}
    {name === 'live' && <><path d="M1.5 9h3l2-5 3 8 2-5h3"/></>}
    {name === 'chevron' && <path d="m5 6.5 3 3 3-3"/>}
  </svg>;
}
