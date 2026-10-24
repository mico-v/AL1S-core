import { useState, type ReactNode } from 'react';
import { Overview } from './views/Overview';
import { Messages } from './views/Messages';
import { Settings } from './views/Settings';

type Tab = 'overview' | 'messages' | 'settings';

const NAV: Array<{ id: Tab; label: string; hint: string; icon: ReactNode }> = [
  {
    id: 'overview',
    label: '概览',
    hint: '用量与健康',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.7">
        <path d="M4 19V9m5 10V5m5 14v-7m5 7V8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'messages',
    label: '消息',
    hint: '群聊记录',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.7">
        <path d="M8 10h8M8 14h5M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: '设置',
    hint: '运行配置',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.33-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.08A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.08a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

const RANGES = [
  { days: 1, label: '24h' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(7);
  const active = NAV.find((n) => n.id === tab);

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-6 border-b border-white/[0.06] bg-[#0b1120]/70 px-4 py-5 backdrop-blur lg:h-screen lg:w-60 lg:border-b-0 lg:border-r lg:px-4 lg:py-6">
        <div className="flex items-center gap-3 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-400 text-sm font-bold text-white shadow-lg shadow-indigo-500/25">
            K
          </div>
          <div>
            <p className="text-sm font-semibold tracking-wide text-slate-100">Kei</p>
            <p className="text-[11px] text-slate-500">控制台</p>
          </div>
        </div>

        <nav className="flex gap-1 lg:flex-col">
          {NAV.map((item) => {
            const on = item.id === tab;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`group flex flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition lg:flex-none ${
                  on ? 'bg-white/[0.07] text-slate-100 shadow-inner' : 'text-slate-400 hover:bg-white/[0.03] hover:text-slate-200'
                }`}
              >
                <span className={on ? 'text-indigo-300' : 'text-slate-500 group-hover:text-slate-300'}>{item.icon}</span>
                <span className="min-w-0">
                  <span className="block text-sm">{item.label}</span>
                  <span className="hidden text-[11px] text-slate-600 lg:block">{item.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto hidden rounded-xl border border-white/[0.06] bg-black/20 p-3 lg:block">
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            服务在线
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">只读视图，不会修改机器人状态</p>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:h-screen lg:overflow-y-auto lg:px-8 lg:py-7">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">{active?.label}</h1>
            <p className="mt-1 text-xs text-slate-500">{active?.hint}</p>
          </div>
          {tab === 'overview' ? (
            <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  onClick={() => setDays(r.days)}
                  className={`rounded-lg px-3 py-1.5 text-xs transition ${
                    days === r.days ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        {tab === 'overview' ? <Overview days={days} /> : null}
        {tab === 'messages' ? <Messages /> : null}
        {tab === 'settings' ? <Settings /> : null}
      </main>
    </div>
  );
}
