import { useEffect, useState } from 'react';
import { api, fmt, type SummaryResponse } from '../api';
import { Badge, Bars, Card, CardHead, Empty, Skeleton, Stat } from '../components/ui';

export function Overview({ days }: { days: number }) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .summary(days)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [days]);

  if (error) {
    return <Card><Empty>加载失败：{error}</Empty></Card>;
  }
  if (!data) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Card key={i}><Skeleton rows={2} /></Card>)}
      </div>
    );
  }

  const s = data.summary;
  const daily = data.daily.length
    ? data.daily
    : [{ day: '-', calls: 0, totalTokens: 0, avgMs: 0, cacheRate: 0 } as unknown as SummaryResponse['daily'][number]];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat label="模型调用" value={fmt.num(s.calls)} sub={`成功 ${s.okCalls} · 失败 ${s.failedCalls}`} />
        <Stat label="缓存命中" value={fmt.pct(s.cacheRate)} sub={`${fmt.compact(s.cachedTokens)} / ${fmt.compact(s.promptTokens)} prompt`} accent="sky" />
        <Stat label="平均延迟" value={fmt.ms(s.avgMs)} sub={`p50 ${fmt.ms(s.p50Ms)} · p95 ${fmt.ms(s.p95Ms)}`} accent="emerald" />
        <Stat label="输出速度" value={`${s.avgTokensPerSecond} tok/s`} sub={`共 ${fmt.num(s.totalTokens)} token`} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHead title="每日调用量" hint={`最近 ${data.days} 天`} right={<Badge tone="indigo">{data.days}d</Badge>} />
          <Bars data={daily.map((d) => ({ label: d.day.slice(5), value: d.calls, hint: fmt.ms(d.avgMs) }))} />
        </Card>

        <Card>
          <CardHead title="群聊概况" hint="来自聊天记录" />
          <div className="space-y-3 p-5 text-sm">
            {[
              ['消息总数', fmt.num(data.messages.total)],
              ['本区间新增', fmt.num(data.messages.inRange)],
              ['说话人数', fmt.num(data.messages.members)],
              ['会话数', fmt.num(data.messages.groups)],
              ['上下文占用峰值', fmt.pct(s.maxContextRate)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between">
                <span className="text-slate-500">{k}</span>
                <span className="tabular-nums text-slate-200">{v}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHead title="按用途" hint="chat / caption / learn" />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2 font-medium">用途</th>
                  <th className="px-3 py-2 text-right font-medium">次数</th>
                  <th className="px-3 py-2 text-right font-medium">prompt</th>
                  <th className="px-3 py-2 text-right font-medium">缓存</th>
                  <th className="px-3 py-2 text-right font-medium">平均</th>
                  <th className="px-5 py-2 text-right font-medium">tok/s</th>
                </tr>
              </thead>
              <tbody>
                {data.purposes.map((p) => (
                  <tr key={p.purpose} className="border-t border-white/[0.04]">
                    <td className="px-5 py-2.5"><Badge tone={p.purpose === 'chat' ? 'indigo' : p.purpose === 'caption' ? 'amber' : 'slate'}>{p.purpose}</Badge></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmt.num(p.calls)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{fmt.compact(p.promptTokens)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{fmt.pct(p.cacheRate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{fmt.ms(p.avgMs)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-400">{p.avgTokensPerSecond}</td>
                  </tr>
                ))}
                {data.purposes.length === 0 ? (
                  <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-500">区间内没有调用</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHead title="最慢的调用" hint="排查卡顿用" />
          <div className="divide-y divide-white/[0.04]">
            {data.slowest.slice(0, 6).map((c, i) => (
              <div key={`${c.at}-${i}`} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone="slate">{c.purpose}</Badge>
                    <span className="truncate text-xs text-slate-500">{c.stack[1] ?? c.stack[0] ?? '—'}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-600">
                    {fmt.time(c.at)} · {fmt.num(c.promptTokens)}→{fmt.num(c.completionTokens)} tok
                    {c.images > 0 ? ` · ${c.images} 图` : ''}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums text-sm text-amber-300">{fmt.ms(c.ms)}</span>
              </div>
            ))}
            {data.slowest.length === 0 ? <Empty>暂无调用</Empty> : null}
          </div>
        </Card>
      </div>

      {data.failures.length > 0 ? (
        <Card>
          <CardHead title="失败记录" hint="最近 8 条" right={<Badge tone="rose">{data.failures.length}</Badge>} />
          <div className="divide-y divide-white/[0.04]">
            {data.failures.map((f, i) => (
              <div key={`${f.at}-${i}`} className="px-5 py-3">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Badge tone="rose">{f.status ?? 'ERR'}</Badge>
                  <span>{fmt.time(f.at)}</span>
                  <span className="text-slate-600">{f.purpose}</span>
                </div>
                <p className="mt-1 break-all text-[11px] text-slate-500">{f.error ?? '未知错误'}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
