/**
 * 注册 / 对账指令面板（官方 `/v2/panels`）。
 *
 *   pnpm qq:panel                 # 单聊按主人、群聊按 AGENT_GROUPS，各自对账一次
 *   pnpm qq:panel --scope c2c     # 只弄单聊
 *   pnpm qq:panel --scope group   # 只弄群聊
 *   pnpm qq:panel --all           # 改成对该场景所有人可见（target_type=all）
 *   pnpm qq:panel --list          # 只看线上现有面板，不动
 *   pnpm qq:panel --dry-run       # 只校验内容，不碰接口
 *
 * 幂等：内容没变就什么都不做；内容变了就地更新；作用范围变了删掉重建
 * （更新接口不改范围）。面板内容与约束都声明在 src/agent/panels.ts，
 * 这个脚本只负责取 token 与打日志。
 *
 * 点击面板里的指令会把文字填进输入框，用户发送后由 ChatAgent 的指令分支
 * 直接应答，不经过模型。
 */

import { PANEL_REMARK, buildPanel, ensurePanel, validatePanel, type PanelApi, type PanelScope } from '../agent/panels.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return value;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function getToken(appId: string, secret: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  const data = (await res.json()) as { access_token?: string; message?: string; code?: number };
  if (!res.ok || !data.access_token) {
    throw new Error(`取 token 失败：${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.access_token;
}

function makeApi(token: string): PanelApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  };
  return {
    get: <T>(path: string, query?: Record<string, string | number | boolean>) => {
      const qs = query
        ? `?${Object.entries(query)
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
            .join('&')}`
        : '';
      return call<T>('GET', `${path}${qs}`);
    },
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
    delete: <T>(path: string) => call<T>('DELETE', path),
  };
}

interface PanelRecord {
  panel_id: string;
  scope: string;
  target_type: string;
  panel: { items?: { type?: string; name?: string; desc?: string; link?: string }[]; remark?: string; version?: number };
}

async function listPanels(api: PanelApi, scope: PanelScope): Promise<void> {
  const list = await api.get<{ records?: PanelRecord[] }>('/v2/panels', { scope, limit: 50 });
  const records = list.records ?? [];
  console.log(`${scope} 场景现有面板 ${records.length} 个：`);
  for (const record of records) {
    const mine = record.panel?.remark === PANEL_REMARK ? ' ← 我的' : '';
    console.log(`  ${record.panel_id} · ${record.target_type} · remark=${record.panel?.remark ?? '-'}${mine}`);
    for (const item of record.panel?.items ?? []) {
      console.log(`    - [${item.type}] ${item.name}${item.desc ? ` · ${item.desc}` : ''}${item.link ? ` → ${item.link}` : ''}`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const dryRun = argv.includes('--dry-run');
  const allScopes = argv.includes('--all');
  const scopeArg = argv[argv.indexOf('--scope') + 1];
  const scopes: PanelScope[] =
    argv.includes('--scope') && (scopeArg === 'c2c' || scopeArg === 'group')
      ? [scopeArg]
      : ['c2c', 'group'];

  const targets: Record<PanelScope, string[]> = {
    c2c: splitList(process.env.AGENT_OWNER_OPENIDS),
    group: splitList(process.env.AGENT_GROUPS),
  };

  if (!dryRun) {
    // 先把内容校验跑一遍，不合规就别浪费一次接口调用
    for (const scope of scopes) {
      const problems = validatePanel(buildPanel(scope));
      if (problems.length > 0) {
        console.error(`${scope} 面板不合规：${problems.join('；')}`);
        process.exit(1);
      }
    }
  }

  if (dryRun) {
    for (const scope of scopes) {
      const spec = buildPanel(scope);
      console.log(`${scope} 面板（${spec.items.length} 个元素，remark=${spec.remark}）：`);
      for (const item of spec.items) {
        console.log(`  - [${item.type}] ${item.name}${item.desc ? ` · ${item.desc}` : ''}${item.link ? ` → ${item.link}` : ''}`);
      }
    }
    console.log('（dry-run：没动接口）');
    return;
  }

  const api = makeApi(await getToken(env('QQBOT_APP_ID'), env('QQBOT_APP_SECRET')));

  for (const scope of scopes) {
    if (listOnly) {
      await listPanels(api, scope);
      continue;
    }
    const openids = targets[scope];
    if (!allScopes && openids.length === 0) {
      console.log(
        `${scope}：没有生效对象（${scope === 'c2c' ? 'AGENT_OWNER_OPENIDS' : 'AGENT_GROUPS'} 为空），跳过；要全局生效加 --all`,
      );
      continue;
    }
    const result = await ensurePanel(api, buildPanel(scope), {
      targetType: allScopes ? 'all' : 'specific',
      openids,
    });
    const actionText: Record<typeof result.action, string> = {
      created: '已创建',
      updated: '已更新',
      recreated: '范围变了，已重建',
      unchanged: '内容没变，跳过',
    };
    console.log(
      `${scope}：${actionText[result.action]} ${result.panelId ?? ''}${
        result.replaced ? `（原 ${result.replaced}）` : ''
      }${!allScopes && openids.length > 0 ? ` · 生效对象 ${openids.length} 个` : ' · 全局'}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
