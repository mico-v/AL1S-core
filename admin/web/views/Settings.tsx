import { useEffect, useState } from 'react';
import { api, fmt, type SettingsResponse } from '../api';
import { Badge, Card, CardHead, Empty, Skeleton } from '../components/ui';

export function Settings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <Card><Empty>加载失败：{error}</Empty></Card>;
  if (!data) return <Card><Skeleton rows={8} /></Card>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHead
          title="运行环境"
          hint="只读视图，改配置请编辑 .env 后重启服务"
          right={<Badge tone="emerald">运行中</Badge>}
        />
        <div className="grid gap-x-8 gap-y-3 p-5 text-sm sm:grid-cols-2">
          {[
            ['数据目录', data.runtime.dataDir],
            ['今日调用', fmt.num(data.runtime.callsToday)],
            ['Node', data.runtime.node],
            ['平台', data.runtime.platform],
            ['进程号', String(data.runtime.pid)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <span className="text-slate-500">{k}</span>
              <span className="truncate font-mono text-xs text-slate-300">{v}</span>
            </div>
          ))}
        </div>
      </Card>

      {data.groups.map((group) => (
        <Card key={group.group}>
          <CardHead title={group.group} hint={`${group.items.length} 项`} />
          <div className="divide-y divide-white/[0.04]">
            {group.items.map((item) => (
              <div key={item.key} className="flex flex-col gap-1 px-5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <span className="font-mono text-xs text-slate-400">{item.key}</span>
                <span className={`break-all text-right text-xs ${item.secret ? 'text-slate-500' : 'text-slate-200'}`}>
                  {item.value}
                  {item.secret ? <span className="ml-2 align-middle"><Badge tone="amber">已脱敏</Badge></span> : null}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {data.groups.length === 0 ? <Card><Empty>没有找到 .env</Empty></Card> : null}
    </div>
  );
}
