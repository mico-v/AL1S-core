/**
 * 会话续航：到点不是停工，是交接后换一条新会话接着干。
 *
 * 依据 Humanize 的实测：长会话跑 3–5 小时后单次回复的 token 会缩水三成以上，
 * 靠压缩上下文硬撑只会越跑越糊。做法是把成果留在工作区与交接单里，
 * 新会话只带「目标 + 最近几句」重新起步。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RotationInput {
  /** 建链时间；缺省视为刚建。 */
  bornAt?: number;
  turns: number;
  now?: number;
  maxAgeMs: number;
  maxTurns: number;
}

export interface Rotation {
  rotate: boolean;
  reason?: string;
}

export function shouldRotateThread(input: RotationInput): Rotation {
  if (input.maxTurns > 0 && input.turns >= input.maxTurns) {
    return { rotate: true, reason: `会话已 ${input.turns} 轮` };
  }
  const now = input.now ?? Date.now();
  if (input.maxAgeMs > 0 && input.bornAt && now - input.bornAt >= input.maxAgeMs) {
    const minutes = Math.round((now - input.bornAt) / 60_000);
    return { rotate: true, reason: `会话已 ${minutes} 分钟` };
  }
  return { rotate: false };
}

/** 交接单的落盘路径（相对 dataRoot）。 */
export function handoffPath(chatId: string, at: Date): string {
  const safe = chatId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return path.join('handoffs', safe, `${stamp}.md`);
}

export interface HandoffInput {
  reason: string;
  turns: number;
  goalBrief?: string;
  /** 最近几句对话（已压成一行一句）。 */
  tail?: string;
  at?: Date;
}

export function renderHandoff(input: HandoffInput): string {
  const at = input.at ?? new Date();
  return [
    '# 会话交接',
    '',
    `- 时间：${at.toISOString()}`,
    `- 原因：${input.reason}`,
    `- 本段轮数：${input.turns}`,
    '',
    '## 当前目标',
    '',
    input.goalBrief?.trim() || '（这个会话没有进行中的目标）',
    '',
    '## 最近对话',
    '',
    input.tail?.trim() || '（无）',
    '',
  ].join('\n');
}

export async function writeHandoff(dataRoot: string, chatId: string, body: string, at = new Date()): Promise<string> {
  const rel = handoffPath(chatId, at);
  const file = path.join(dataRoot, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
  return rel;
}
