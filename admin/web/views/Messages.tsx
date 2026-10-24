import { useEffect, useMemo, useState } from 'react';
import { api, fmt, type MessageItem, type MessagesResponse } from '../api';
import { Badge, Card, CardHead, Empty, Skeleton } from '../components/ui';

const PAGE = 60;

const AVATAR_TONES = [
  'from-indigo-500/70 to-sky-500/60',
  'from-emerald-500/70 to-teal-500/60',
  'from-amber-500/70 to-orange-500/60',
  'from-rose-500/70 to-pink-500/60',
  'from-violet-500/70 to-purple-500/60',
];

function toneOf(id: string): string {
  let hash = 0;
  for (const ch of id) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length] as string;
}

export function Messages() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [data, setData] = useState<MessagesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .messages({ limit: PAGE, offset: 0, q: debounced })
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [debounced]);

  const loadMore = async () => {
    if (!data) return;
    setLoading(true);
    try {
      const next = await api.messages({ limit: PAGE, offset: data.items.length, q: debounced });
      setData({ ...next, items: [...data.items, ...next.items] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const groups = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, number>();
    for (const item of data.items) {
      map.set(item.scope, (map.get(item.scope) ?? 0) + 1);
    }
    return [...map.entries()];
  }, [data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHead
          title="消息记录"
          hint={data ? `共 ${fmt.num(data.total)} 条` : '按时间倒序'}
          right={
            <div className="flex items-center gap-2">
              {groups.map(([scope, count]) => (
                <Badge key={scope} tone="slate">{scope.split('/').pop()?.slice(0, 8)} · {count}</Badge>
              ))}
            </div>
          }
        />
        <div className="border-b border-white/[0.06] px-5 py-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索内容或昵称…"
            className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>

        {error ? <Empty>加载失败：{error}</Empty> : null}
        {!error && !data ? <Skeleton rows={6} /> : null}
        {!error && data && data.items.length === 0 ? <Empty>没有匹配的消息</Empty> : null}

        <div className="divide-y divide-white/[0.04]">
          {data?.items.map((m, i) => <Row key={`${m.timestamp}-${i}`} item={m} />)}
        </div>

        {data && data.items.length < data.total ? (
          <div className="border-t border-white/[0.06] p-4 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={loading}
              className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-xs text-slate-300 transition hover:bg-white/[0.07] disabled:opacity-40"
            >
              {loading ? '加载中…' : `加载更多（还剩 ${fmt.num(data.total - data.items.length)}）`}
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function Row({ item }: { item: MessageItem }) {
  const name = item.senderName ?? item.senderId.slice(0, 8);
  const hasMedia = item.attachments.length > 0;
  return (
    <div className="flex gap-3 px-5 py-3.5 transition hover:bg-white/[0.02]">
      <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${toneOf(item.senderId)} text-xs font-semibold text-white/90`}>
        {name.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-slate-200">{name}</span>
          <span className="text-[11px] text-slate-600">{fmt.time(item.timestamp)}</span>
          {item.msgType === 103 ? <Badge tone="indigo">富文本</Badge> : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-400">
          {item.content || '（无文字）'}
        </p>
        {hasMedia ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.attachments.map((a, i) => (
              <Badge key={i} tone="amber">{a.replace('image/', '').replace('application/', '')}</Badge>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
