/**
 * 指令面板（`/v2/panels`）：群聊 / 单聊里常驻的一排入口。
 *
 * 和消息按钮分工不同：
 *   - 消息按钮（choices.ts）是一次性的，问题解决就作废；
 *   - 指令面板是长期挂着的，点一下把文字填进输入框（`type=command`），
 *     或直接开浏览器（`type=link`）。用户还得自己按发送，所以适合放
 *     「随时会用一下」的指令，不适合放「需要立刻拍板」的选择。
 *
 * 依据（2026-11-21 核对官方文档，见 docs/qq-api/autogen/api/v2_panels.*.md）：
 *   - scope 四选一 c2c/group/channel/dm；只有 c2c 与 group 支持
 *     `target_type=specific`（按用户 / 按群生效），channel/dm 只能 all。
 *   - 一个机器人最多 20 个面板，一个面板最多 20 个元素；
 *     `name` ≤14 字符（约 7 个汉字）、`desc` ≤30 字符（约 15 个汉字）。
 *   - 更新接口只改内容不改作用范围 —— 想改范围必须删掉重建。
 *
 * 这里只做三件事：声明要放什么、校验它符合平台约束、按现状对账（新建/更新/重建）。
 */

import { matchCommand, matchGoalCommand } from './commands.js';

export type PanelScope = 'c2c' | 'group';

export interface PanelItem {
  type: 'command' | 'link';
  /** 面板上显示的名字，≤14 字符。 */
  name: string;
  /** 一行说明，≤30 字符。 */
  desc?: string;
  /** 仅管理员可点（群 / 频道场景有意义）。 */
  only_admin?: boolean;
  /** `type=link` 时的跳转地址，必须 https。 */
  link?: string;
}

export interface PanelSpec {
  scope: PanelScope;
  items: PanelItem[];
  /** 开发者备注，不展示给用户；对账时靠它认领「哪个面板是我的」。 */
  remark: string;
}

export interface PanelRecord {
  panel_id: string;
  scope: string;
  target_type: string;
  panel: { items?: PanelItem[]; remark?: string; version?: number };
}

/** 官方 `/v2/panels` 的最小接口面（`bot.api` 与脚本里的 fetch 适配器都满足）。 */
export interface PanelApi {
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

/** 认领标记：改这个等于换一个面板，老面板会被当成别人的留在那儿。 */
export const PANEL_REMARK = 'kei-commands';
export const MAX_PANEL_ITEMS = 20;
export const MAX_ITEM_NAME_CHARS = 14;
export const MAX_ITEM_DESC_CHARS = 30;
export const MAX_REMARK_CHARS = 255;

/** 面板里的链接。只有确实该给所有人点的才放，别把内部地址摊开。 */
const LINKS = {
  console: {
    type: 'link',
    name: '控制台',
    // 不靠 only_admin 拦：群里点得到不代表进得去，basic auth 才是真边界
    desc: '消息与用量（需登录）',
    link: 'https://kei.st.mioc.cc',
  },
  project: {
    type: 'link',
    name: '项目主页',
    desc: 'campus-nav-3d 线上版',
    link: 'https://map.mioc.cc',
  },
} satisfies Record<string, PanelItem>;

/**
 * 面板内容。
 *
 * 只放「不走模型、立刻回」的指令 —— 点一下就要有结果，否则面板比手打还慢。
 * `/goal` 系列只在群聊有（目标的自动续跑本来也只跑工程群），单聊面板就不放。
 *
 * 指令名不带斜杠：平台存面板时会把开头的 `/` 规范掉（实测 name 写 `/status`
 * 存回来是 `status`），写不带斜杠才能跟线上对得上，对账不会每次都想更新。
 * 点击填进输入框的是 `status`，指令解析器两种写法都认。
 */
export function buildPanel(scope: PanelScope): PanelSpec {
  const statusItem: PanelItem = { type: 'command', name: 'status', desc: '看对话状态与用量' };
  const items: PanelItem[] =
    scope === 'group'
      ? [
          statusItem,
          { type: 'command', name: 'goal', desc: '看目标与切片进度' },
          { type: 'command', name: 'goal resume', desc: '续跑暂停的目标' },
          LINKS.console,
          LINKS.project,
        ]
      : [statusItem, LINKS.console, LINKS.project];
  return { scope, items, remark: PANEL_REMARK };
}

function charCount(text: string): number {
  return [...text].length;
}

/**
 * 校验面板：返回问题清单，空数组代表可以提交。
 *
 * 除了字数，还守着一条更实在的约束：`type=command` 的名字必须真的被指令解析器认。
 * 面板里点一下发出去、结果被当成「别人的命令」静默丢掉，比没有这个入口更糟。
 */
export function validatePanel(spec: PanelSpec): string[] {
  const problems: string[] = [];
  if (spec.items.length > MAX_PANEL_ITEMS) {
    problems.push(`元素 ${spec.items.length} 个，超过 ${MAX_PANEL_ITEMS} 个上限`);
  }
  if (charCount(spec.remark) > MAX_REMARK_CHARS) {
    problems.push(`备注超过 ${MAX_REMARK_CHARS} 字符`);
  }
  if (spec.items.length === 0) {
    problems.push('面板是空的');
  }
  for (const [index, item] of spec.items.entries()) {
    const at = `第 ${index + 1} 个元素「${item.name}」`;
    if (!item.name?.trim()) {
      problems.push(`${at} 缺名字`);
      continue;
    }
    if (charCount(item.name) > MAX_ITEM_NAME_CHARS) {
      problems.push(`${at} 名字超过 ${MAX_ITEM_NAME_CHARS} 字符`);
    }
    if (item.desc !== undefined && charCount(item.desc) > MAX_ITEM_DESC_CHARS) {
      problems.push(`${at} 说明超过 ${MAX_ITEM_DESC_CHARS} 字符`);
    }
    if (item.type === 'link') {
      if (!item.link?.startsWith('https://')) {
        problems.push(`${at} 是链接元素，link 必须以 https:// 开头`);
      }
      continue;
    }
    if (item.type !== 'command') {
      problems.push(`${at} 类型只能是 command / link`);
      continue;
    }
    // 单聊里没有目标指令（自动续跑只跑工程群），群聊里两者都认。
    const recognized =
      matchCommand(item.name) !== undefined ||
      (spec.scope === 'group' && matchGoalCommand(item.name) !== undefined);
    if (!recognized) {
      problems.push(`${at} 不是已实现的指令（点了会被当别人的命令丢掉）`);
    }
  }
  return problems;
}

function sameItems(a: PanelItem[] | undefined, b: PanelItem[]): boolean {
  // 平台会把指令名的前导 `/` 规范掉，比较前先抹平，否则每次对账都误判成「变了」
  const normalizeName = (item: PanelItem): string =>
    item.type === 'command' ? item.name.replace(/^\/+/, '') : item.name;
  const normalize = (items: PanelItem[]): string =>
    JSON.stringify(
      items.map((item) => ({
        type: item.type,
        name: normalizeName(item),
        desc: item.desc ?? '',
        only_admin: item.only_admin ?? false,
        link: item.link ?? '',
      })),
    );
  return normalize(a ?? []) === normalize(b);
}

export interface EnsurePanelOptions {
  /** all = 该场景下所有人可见；specific = 只对 openids 里那些用户/群可见。 */
  targetType: 'all' | 'specific';
  /** `targetType=specific` 时的用户 openid（c2c）或群 openid（group）列表。 */
  openids?: string[];
}

export interface EnsurePanelResult {
  action: 'created' | 'updated' | 'recreated' | 'unchanged';
  panelId?: string;
  /** 老面板被删掉重建时，这里带原 panel_id，方便对账。 */
  replaced?: string;
}

/**
 * 对账：让线上面板与本文件声明的一致。
 *
 * 幂等，重复跑只有第一次会动接口。范围变了（比如新加了群）只能删掉重建 ——
 * 更新接口不改作用范围，否则面板永远绑在最初那几个群上，新群看不到。
 */
export async function ensurePanel(
  api: PanelApi,
  spec: PanelSpec,
  options: EnsurePanelOptions,
): Promise<EnsurePanelResult> {
  const problems = validatePanel(spec);
  if (problems.length > 0) {
    throw new Error(`面板不合规：${problems.join('；')}`);
  }
  const openids = (options.openids ?? []).map((id) => id.trim()).filter(Boolean);
  if (options.targetType === 'specific' && openids.length === 0) {
    throw new Error('target_type=specific 却没给生效对象');
  }

  const list = await api.get<{ records?: PanelRecord[] }>('/v2/panels', {
    scope: spec.scope,
    limit: 50,
  });
  const ours = (list.records ?? []).find((record) => record.panel?.remark === spec.remark);
  const panel = { items: spec.items, remark: spec.remark };

  if (ours && ours.target_type === options.targetType) {
    if (sameItems(ours.panel?.items, spec.items)) {
      return { action: 'unchanged', panelId: ours.panel_id };
    }
    await api.put(`/v2/panels/${ours.panel_id}`, { panel });
    return { action: 'updated', panelId: ours.panel_id };
  }

  if (ours) {
    await api.delete(`/v2/panels/${ours.panel_id}`);
  }
  const created = await api.post<{ panel_id?: string }>('/v2/panels', {
    scope: spec.scope,
    target_type: options.targetType,
    ...(options.targetType === 'specific'
      ? spec.scope === 'c2c'
        ? { user_openids: openids }
        : { group_openids: openids }
      : {}),
    panel,
  });
  return ours
    ? { action: 'recreated', panelId: created.panel_id, replaced: ours.panel_id }
    : { action: 'created', panelId: created.panel_id };
}
