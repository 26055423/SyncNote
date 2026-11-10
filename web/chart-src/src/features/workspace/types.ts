import type { NoteSection } from '../../ReviewNotebook';

export interface Review {
  status: string;
  charts: Record<string, number[][]>;
  errors: Record<string, string>;
  trade: any;
  opened: number | null;
  source?: string;
  market_source?: string | null;
  error?: string;
}

export interface Entry {
  mode: 'owner' | 'viewer' | 'shared';
  owner: { id: string; name: string; avatar: string };
  read_only: boolean;
  share: { id: number; message: string; created: number; seen: boolean; anchor_ms?: number | null; timeframe?: string | null; layout?: string | null } | null;
  review: Review;
  note: { body: string; tags: string[]; sections?: NoteSection[]; updated: number } | null;
  chart: { document: unknown; updated: number; source?: string } | null;
  /** 券商服务器墙钟 − UTC 的秒数；标注对齐用。 */
  bar_offset?: number;
}

export interface Member {
  id: string;
  name: string;
  username: string;
  avatar: string;
  can_view: boolean;
  /** 对方是否开放复盘（交易数据开放不等于复盘开放）。 */
  can_review?: boolean;
  /** 这位成员真正复盘过的成交，和看板里的 reviewed 不同。 */
  reviewed?: string[];
}

export interface Board {
  market_source?: string | null;
  user: { id: string; nickname: string; username: string; avatar: string; onboarding_step: number; auto_history_sync?: boolean };
  members: Member[];
  snapshots: Record<string, { data: any; updated: number }>;
  events: Array<{ id: number; person: string; kind: string; text: string; created: number }>;
  messages: Array<{ id: number; person: string; name?: string; text: string; created: number }>;
  now: number;
  /** 真正复盘过的成交（写过笔记或在图上画过），否则算未复盘。 */
  reviewed?: string[];
}

export interface ShareRow {
  id: number;
  ticket: string;
  owner: { id: string; name: string; avatar: string };
  message: string;
  created: number;
  seen: boolean;
  /** 分享人点击分享那一刻：激活格子的可见窗口中点（毫秒）与周期。 */
  anchor_ms?: number | null;
  timeframe?: string | null;
  layout?: string | null;
  trade: any;
}

export type Tab = 'trade' | 'friends' | 'review' | 'inbox';
