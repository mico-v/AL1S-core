/**
 * 注册群聊指令面板。
 *
 *   pnpm qq:panel            # 注册/更新，作用于 AGENT_GROUPS 里的群
 *   pnpm qq:panel --all      # 作用于所有群
 *   pnpm qq:panel --list     # 只看现有面板
 *
 * 走官方 /v2/panels（scope=group）。点击面板里的「/status」会把该文本
 * 填进输入框，用户发送后由 ChatAgent 的指令分支直接应答，不经过模型。
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const REMARK = 'kei-commands';

interface PanelItem {
  type: 'command' | 'link';
  name: string;
  desc?: string;
  only_admin?: boolean;
  link?: string;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return value;
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

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `QQBot ${token}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface PanelRecord {
  panel_id: string;
  scope: string;
  target_type: string;
  panel: { items?: PanelItem[]; remark?: string; version?: number };
}

async function main(): Promise<void> {
  const appId = env('QQBOT_APP_ID');
  const secret = env('QQBOT_APP_SECRET');
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const allGroups = argv.includes('--all');

  const token = await getToken(appId, secret);

  const existing = await api<{ records?: PanelRecord[] }>(token, 'GET', '/v2/panels?scope=group&limit=50');
  const ours = (existing.records ?? []).find((record) => record.panel?.remark === REMARK);

  if (listOnly) {
    console.log(`现有群聊面板 ${existing.records?.length ?? 0} 个：`);
    for (const record of existing.records ?? []) {
      console.log(`  ${record.panel_id} · ${record.target_type} · remark=${record.panel?.remark ?? '-'}`);
      for (const item of record.panel?.items ?? []) {
        console.log(`    - [${item.type}] ${item.name}${item.desc ? ` · ${item.desc}` : ''}`);
      }
    }
    return;
  }

  const items: PanelItem[] = [
    { type: 'command', name: '/status', desc: '看 Kei 当前的对话状态' },
    { type: 'link', name: '控制台', desc: '消息与用量（仅主人）', link: 'https://kei.st.mioc.cc', only_admin: true },
  ];
  const panel = { items, remark: REMARK };

  if (ours) {
    const result = await api<{ version?: number }>(token, 'PUT', `/v2/panels/${ours.panel_id}`, { panel });
    console.log(`已更新面板 ${ours.panel_id} → version ${result.version ?? '?'}`);
    return;
  }

  const groups = allGroups
    ? []
    : (process.env.AGENT_GROUPS ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);

  if (!allGroups && groups.length === 0) {
    console.error('没有指定群：设置 AGENT_GROUPS，或加 --all');
    process.exit(1);
  }

  const created = await api<{ panel_id?: string; version?: number }>(token, 'POST', '/v2/panels', {
    scope: 'group',
    ...(allGroups ? { target_type: 'all' } : { target_type: 'specific', group_openids: groups }),
    panel,
  });
  console.log(`已创建面板 ${created.panel_id ?? '?'} → version ${created.version ?? '?'}`);
  if (!allGroups) {
    console.log(`作用群：${groups.join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
