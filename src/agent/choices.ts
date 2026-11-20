/**
 * 选项卡片：把「要主人拍板的方案抉择」变成一排按钮。
 *
 * 依据（2026-11-21 核对官方文档，见 docs/qq-api/）：
 *   - 消息按钮在单聊 / 群聊场景已对全部机器人开放（FAQ：无需申请模版）；
 *     频道场景仍需内邀。
 *   - 按钮挂在 `keyboard` 字段上，`action.type=1` 是回调按钮，点击推
 *     `INTERACTION_CREATE`（intents 1<<26），机器人要 `PUT /interactions/{id}` 回应，
 *     否则客户端一直转圈。
 *   - `group_id` 同一分组内点一个，其它按钮自动变灰（仅 type=1 有效）——
 *     正好用来表达「选完了，别的作废」，不用改消息。
 *   - 按钮文字最多 10 字，一行最多 5 个，最多 5 行。
 *
 * 这里只做三件事：造键盘、渲染 markdown 正文、把待选项落盘。
 * 点按钮之后怎么继续，交给 index.ts 把它当成一条用户消息喂回去。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';

/** 一行最多 5 个、最多 5 行；抉择场景给 2~5 个就够，多了按钮上写不下。 */
export const MAX_CHOICE_OPTIONS = 5;
/** 按钮文字上限（平台限制）。 */
export const MAX_LABEL_CHARS = 10;
/** 一个选项卡片等主人多久；过期就当没发过。 */
export const CHOICE_TTL_MS = 24 * 60 * 60 * 1000;
/** 每个会话最多留几张待选卡片。 */
export const MAX_PENDING_PER_CHAT = 20;
/** 按钮 data 前缀，用来和别处的互动事件区分。 */
export const CHOICE_DATA_PREFIX = 'choice';

export interface ChoiceOption {
  /** 按钮上的字（≤10 字），也是回喂给模型的选择文本。 */
  label: string;
  /** 展开说明，只写进正文，不进按钮。 */
  detail?: string;
}

export interface PendingChoice {
  token: string;
  /** 会话 id：群 openid，或 `dm:<openid>`。 */
  chatId: string;
  question: string;
  options: ChoiceOption[];
  createdAt: number;
  /** 谁发的卡片（主人昵称），回喂时标出处。 */
  by: string;
}

/** 按钮 data：`choice:<token>:<index>`。 */
export function encodeChoiceData(token: string, index: number): string {
  return `${CHOICE_DATA_PREFIX}:${token}:${index}`;
}

export function parseChoiceData(data: string | undefined): { token: string; index: number } | undefined {
  if (!data) {
    return undefined;
  }
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CHOICE_DATA_PREFIX) {
    return undefined;
  }
  const index = Number.parseInt(parts[2] as string, 10);
  if (!Number.isInteger(index) || index < 0) {
    return undefined;
  }
  return { token: parts[1] as string, index };
}

/** 截到平台允许的字数，不切坏表情（按码点切）。 */
export function clipLabel(label: string, max = MAX_LABEL_CHARS): string {
  const chars = [...label.trim()];
  if (chars.length <= max) {
    return chars.join('');
  }
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * 造键盘：每个选项一行，权限只给主人。
 *
 * `permission.type=0` + `specify_user_ids`：群里其他人点了只会弹「没有权限」，
 * 不会把别人的选择当成主人的决定。
 */
export function buildChoiceKeyboard(
  choice: PendingChoice,
  opts: { ownerOpenids: string[] },
): InlineKeyboard {
  const buttons = choice.options.slice(0, MAX_CHOICE_OPTIONS).map((option, index) => {
    const label = clipLabel(option.label);
    const button: Record<string, unknown> = {
      id: `c${index}`,
      render_data: {
        label,
        visited_label: clipLabel(`✓ ${label}`),
        // 第一个选项描蓝边，其余灰框：不给建议时也别把眼睛全吸走
        style: index === 0 ? 1 : 0,
      },
      action: {
        type: 1,
        permission: {
          type: 0,
          specify_user_ids: opts.ownerOpenids,
        },
        data: encodeChoiceData(choice.token, index),
        unsupport_tips: '当前版本不支持按钮，直接回我一句选哪个',
      },
      // 点一个，同组其它按钮自动变灰
      group_id: `choice-${choice.token}`,
    };
    return button;
  });
  return {
    content: { rows: buttons.map((button) => ({ buttons: [button] })) },
  } as unknown as InlineKeyboard;
}

/** 卡片正文：问题 + 编号选项（群聊 markdown 支持加粗与列表，不写表格）。 */
export function renderChoiceMarkdown(choice: PendingChoice): string {
  const lines = [`**${choice.question.trim()}**`, ''];
  choice.options.slice(0, MAX_CHOICE_OPTIONS).forEach((option, index) => {
    const detail = option.detail?.trim();
    lines.push(`${index + 1}. ${option.label}${detail ? `：${detail}` : ''}`);
  });
  lines.push('', '点下面按钮就行，或者直接回我一句。');
  return lines.join('\n');
}

function safeFileName(chatId: string): string {
  return chatId.replace(/[^0-9A-Za-z_-]/g, '_');
}

/**
 * 待选卡片落盘：一个会话一个文件。
 *
 * 存盘不是为了优雅，是为了「重启后按钮还能点」—— 一张卡片可能挂一整天，
 * 中间我重启一次就把 token 弄丢，主人点了只会得到一句「过期了」。
 */
export class ChoiceStore {
  private readonly file: string;

  constructor(dataRoot: string, chatId: string) {
    this.file = path.join(dataRoot, 'choices', `${safeFileName(chatId)}.json`);
  }

  async read(now = Date.now()): Promise<PendingChoice[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const alive = parsed.filter((item): item is PendingChoice => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const choice = item as PendingChoice;
      return (
        typeof choice.token === 'string' &&
        Array.isArray(choice.options) &&
        typeof choice.createdAt === 'number' &&
        now - choice.createdAt < CHOICE_TTL_MS
      );
    });
    return alive;
  }

  async add(choice: PendingChoice): Promise<void> {
    const kept = (await this.read()).filter((item) => item.token !== choice.token);
    const next = [...kept, choice].slice(-MAX_PENDING_PER_CHAT);
    await this.write(next);
  }

  /** 取走一个 token（一次性）：拿不到就是过期 / 已点过 / 重启前的老卡片。 */
  async take(token: string, now = Date.now()): Promise<PendingChoice | undefined> {
    const alive = await this.read(now);
    const hit = alive.find((item) => item.token === token);
    if (!hit) {
      return undefined;
    }
    await this.write(alive.filter((item) => item.token !== token));
    return hit;
  }

  private async write(items: PendingChoice[]): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }
}
