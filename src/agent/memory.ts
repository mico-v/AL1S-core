/**
 * 群记忆：成员档案 + 群日记。
 *
 * 数据来源是 chat-log 已经落盘的 JSONL（data/chats/group/<openid>/messages.jsonl），
 * 所以这里不重复采集，只负责：
 *   1. 读取某个群的原始消息（增量）；
 *   2. 让模型把这批消息归纳进成员档案；
 *   3. 给对话时提供「我记得的事」文本块。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RawRecord {
  messageId: string;
  timestamp: string;
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  groupOpenid?: string;
}

export interface MemberEntry {
  openid: string;
  name: string;
  profilePath: string;
  profile: string;
}

const MAX_CONTEXT_PROFILE_CHARS = 700;

/** 一个群的记忆目录。 */
export class GroupMemory {
  readonly dir: string;
  private readonly membersDir: string;
  private readonly diaryDir: string;
  private readonly stateFile: string;

  constructor(root: string, groupOpenid: string) {
    const safe = groupOpenid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
    this.dir = path.join(root, 'memory', safe);
    this.membersDir = path.join(this.dir, 'members');
    this.diaryDir = path.join(this.dir, 'diary');
    this.stateFile = path.join(this.dir, 'state.json');
  }

  async ensure(): Promise<void> {
    await mkdir(this.membersDir, { recursive: true });
    await mkdir(this.diaryDir, { recursive: true });
  }

  /** 全部成员档案（含正文）。 */
  async listMembers(): Promise<MemberEntry[]> {
    if (!existsSync(this.membersDir)) {
      return [];
    }
    const files = (await readdir(this.membersDir)).filter((f) => f.endsWith('.md'));
    const out: MemberEntry[] = [];
    for (const file of files) {
      const profilePath = path.join(this.membersDir, file);
      const profile = await readFile(profilePath, 'utf8');
      const openid = file.replace(/\.md$/, '');
      const name = /^#\s*(.+)$/m.exec(profile)?.[1]?.trim() ?? openid.slice(0, 8);
      out.push({ openid, name, profilePath, profile });
    }
    return out;
  }

  async getMember(openid: string): Promise<MemberEntry | undefined> {
    const profilePath = path.join(this.membersDir, `${openid}.md`);
    if (!existsSync(profilePath)) {
      return undefined;
    }
    const profile = await readFile(profilePath, 'utf8');
    const name = /^#\s*(.+)$/m.exec(profile)?.[1]?.trim() ?? openid.slice(0, 8);
    return { openid, name, profilePath, profile };
  }

  async saveMember(openid: string, name: string, body: string): Promise<void> {
    await this.ensure();
    const text = body.trimStart().startsWith('#') ? body : `# ${name}\n\n${body}`;
    await writeFile(path.join(this.membersDir, `${openid}.md`), text.trimEnd() + '\n', 'utf8');
  }

  /** 渲染成给模型看的「我记得的事」。只挑相关的人，避免撑爆上下文。 */
  async renderContext(openids: string[], maxPeople = 3): Promise<string> {
    const blocks: string[] = [];
    for (const openid of openids.slice(0, maxPeople)) {
      const member = await this.getMember(openid);
      if (!member) {
        continue;
      }
      const body = member.profile.trim();
      blocks.push(body.length > MAX_CONTEXT_PROFILE_CHARS
        ? `${body.slice(0, MAX_CONTEXT_PROFILE_CHARS)}…`
        : body);
    }
    return blocks.join('\n\n');
  }

  async readState(): Promise<{ lastMessageId?: string; lastMessageAt?: string }> {
    if (!existsSync(this.stateFile)) {
      return {};
    }
    try {
      return JSON.parse(await readFile(this.stateFile, 'utf8')) as {
        lastMessageId?: string;
        lastMessageAt?: string;
      };
    } catch {
      return {};
    }
  }

  async writeState(state: { lastMessageId?: string; lastMessageAt?: string }): Promise<void> {
    await this.ensure();
    await writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  async appendDiary(date: string, text: string): Promise<void> {
    await this.ensure();
    const file = path.join(this.diaryDir, `${date}.md`);
    const prev = existsSync(file) ? await readFile(file, 'utf8') : `# ${date} 群日记\n`;
    await writeFile(file, `${prev.trimEnd()}\n\n${text.trim()}\n`, 'utf8');
  }
}

/** 从 chat-log 的 JSONL 里读增量记录（按 messageId 去重，取 watermark 之后的部分）。 */
export async function readNewRecords(
  chatRoot: string,
  groupOpenid: string,
  afterMessageId?: string,
): Promise<RawRecord[]> {
  const file = path.join(chatRoot, 'chats', 'group', groupOpenid, 'messages.jsonl');
  if (!existsSync(file)) {
    return [];
  }
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const records: RawRecord[] = [];
  let seenWatermark = !afterMessageId;
  for (const line of lines) {
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      continue;
    }
    if (!seenWatermark) {
      if (rec.messageId === afterMessageId) {
        seenWatermark = true;
      }
      continue;
    }
    if (rec.senderIsBot) {
      continue;
    }
    if (!rec.content?.trim()) {
      continue;
    }
    records.push(rec);
  }
  return records;
}
