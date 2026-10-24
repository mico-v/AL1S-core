export interface Summary {
  calls: number;
  okCalls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  avgTokensPerSecond: number;
  maxContextRate: number;
}

export interface CallRecord {
  at: string;
  purpose: string;
  model: string;
  attempt: number;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cacheRate: number;
  tokensPerSecond: number;
  contextRate: number;
  contextWindow: number;
  messages: number;
  promptChars: number;
  images: number;
  maxTokens: number;
  temperature: number;
  conversationId?: string;
  speaker?: string;
  stack: string[];
}

export interface SummaryResponse {
  days: number;
  summary: Summary;
  purposes: Array<Summary & { purpose: string }>;
  daily: Array<Summary & { day: string }>;
  messages: { total: number; inRange: number; members: number; groups: number };
  slowest: CallRecord[];
  failures: CallRecord[];
}

export interface MessageItem {
  timestamp: string;
  senderId: string;
  senderName?: string;
  content: string;
  msgType: number;
  attachments: string[];
  scope: string;
}

export interface MessagesResponse {
  total: number;
  offset: number;
  items: MessageItem[];
}

export interface SettingsResponse {
  groups: Array<{ group: string; items: Array<{ key: string; value: string; secret: boolean }> }>;
  runtime: { dataDir: string; callsToday: number; node: string; platform: string; pid: number };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  summary: (days: number) => getJson<SummaryResponse>(`/api/summary?days=${days}`),
  messages: (params: { limit?: number; offset?: number; q?: string }) => {
    const search = new URLSearchParams();
    search.set('limit', String(params.limit ?? 60));
    search.set('offset', String(params.offset ?? 0));
    if (params.q) {
      search.set('q', params.q);
    }
    return getJson<MessagesResponse>(`/api/messages?${search.toString()}`);
  },
  settings: () => getJson<SettingsResponse>('/api/settings'),
};

export const fmt = {
  num: (value: number): string => (value ?? 0).toLocaleString('en-US'),
  compact: (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(value ?? 0);
  },
  pct: (value: number, digits = 1): string => `${((value ?? 0) * 100).toFixed(digits)}%`,
  ms: (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`),
  time: (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso ?? '-';
    return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },
  clock: (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString('zh-CN', { hour12: false });
  },
};
