import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-white/[0.06] bg-[#0e1526]/80 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_20px_40px_-24px_rgba(0,0,0,0.9)] backdrop-blur ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHead({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
      <div>
        <h2 className="text-sm font-medium tracking-wide text-slate-200">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent = 'indigo',
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'indigo' | 'sky' | 'emerald' | 'amber';
}) {
  const ring = {
    indigo: 'from-indigo-500/25 text-indigo-300',
    sky: 'from-sky-500/25 text-sky-300',
    emerald: 'from-emerald-500/25 text-emerald-300',
    amber: 'from-amber-500/25 text-amber-300',
  }[accent];

  return (
    <Card className="relative overflow-hidden p-5">
      <div className={`pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-gradient-to-br ${ring} to-transparent blur-2xl`} />
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-50">{value}</p>
      {sub ? <p className="mt-1 text-xs text-slate-500">{sub}</p> : null}
    </Card>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'indigo' | 'emerald' | 'rose' | 'amber' }) {
  const cls = {
    slate: 'bg-slate-500/10 text-slate-300 ring-slate-400/20',
    indigo: 'bg-indigo-500/10 text-indigo-300 ring-indigo-400/25',
    emerald: 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/25',
    rose: 'bg-rose-500/10 text-rose-300 ring-rose-400/25',
    amber: 'bg-amber-500/10 text-amber-300 ring-amber-400/25',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-14 text-center text-sm text-slate-500">{children}</div>;
}

export function Bars({ data }: { data: Array<{ label: string; value: number; hint?: string }> }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex h-40 items-end gap-2 px-5 pb-4 pt-6">
      {data.map((d) => (
        <div key={d.label} className="group relative flex flex-1 flex-col items-center justify-end gap-2">
          <div
            className="w-full rounded-t-md bg-gradient-to-t from-indigo-500/30 to-indigo-400/80 transition-all duration-300 group-hover:from-indigo-400/50 group-hover:to-sky-300"
            style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }}
          />
          <span className="text-[10px] text-slate-500">{d.label}</span>
          <div className="pointer-events-none absolute -top-8 hidden whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] text-slate-200 ring-1 ring-white/10 group-hover:block">
            {d.value}
            {d.hint ? ` · ${d.hint}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 w-full animate-pulse rounded bg-white/5" />
      ))}
    </div>
  );
}
