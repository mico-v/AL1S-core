/**
 * 群聊历史检索。
 *
 * 全量消息在 data/chats/<kind>/<target>/messages.jsonl 里，量级到十万条也放得下内存。
 * 用「文件 mtime + size」当缓存键，写入新消息后自动重建，不额外维护索引文件。
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface StoredMessage {
  timestamp?: string;
  recordedAt?: string;
  senderId?: string;
  senderName?: string;
  content?: string;
  groupOpenid?: string;
  msgType?: number;
  attachments?: Array<{ contentType?: string }>;
}

export interface SearchHit {
  at: string;
  sender: string;
  senderId: string;
  content: string;
  chat: string;
  hasImage: boolean;
}

export interface SearchOptions {
  query: string;
  /** 按昵称模糊匹配或按 openid 精确匹配 */
  sender?: string;
  /** 只搜最近 N 天 */
  days?: number;
  limit?: number;
  /** 只搜某个会话 */
  chatId?: string;
}

interface IndexEntry extends StoredMessage {
  chat: string;
  at: string;
  epoch: number;
}

const MAX_CONTENT = 200;

export class MessageIndex {
  private readonly root: string;
  private cache: { key: string; rows: IndexEntry[] } | undefined;

  constructor(dataRoot: string) {
    this.root = path.join(dataRoot, 'chats');
  }

  private async files(): Promise<string[]> {
    if (!existsSync(this.root)) {
      return [];
    }
    const out: string[] = [];
    for (const kind of await readdir(this.root)) {
      const kindDir = path.join(this.root, kind);
      const info = await stat(kindDir).catch(() => undefined);
      if (!info?.isDirectory()) {
        continue;
      }
      for (const target of await readdir(kindDir)) {
        const file = path.join(kindDir, target, 'messages.jsonl');
        if (existsSync(file)) {
          out.push(file);
        }
      }
    }
    return out;
  }

  private async load(): Promise<IndexEntry[]> {
    const files = await this.files();
    const stamps: string[] = [];
    for (const file of files) {
      const info = await stat(file).catch(() => undefined);
      stamps.push(`${file}:${info?.mtimeMs ?? 0}:${info?.size ?? 0}`);
    }
    const key = stamps.join('|');
    if (this.cache?.key === key) {
      return this.cache.rows;
    }

    const rows: IndexEntry[] = [];
    for (const file of files) {
      const chat = path.basename(path.dirname(file));
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        let record: StoredMessage;
        try {
          record = JSON.parse(line) as StoredMessage;
        } catch {
          continue;
        }
        const at = record.timestamp ?? record.recordedAt ?? '';
        const epoch = Date.parse(at);
        if (!record.content || Number.isNaN(epoch)) {
          continue;
        }
        rows.push({ ...record, chat, at, epoch });
      }
    }
    rows.sort((a, b) => a.epoch - b.epoch);
    this.cache = { key, rows };
    return rows;
  }

  async size(): Promise<number> {
    return (await this.load()).length;
  }

  async search(options: SearchOptions): Promise<SearchHit[]> {
    const rows = await this.load();
    const query = options.query.trim();
    const terms = query.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    const limit = Math.min(20, Math.max(1, options.limit ?? 8));
    const since = options.days && options.days > 0 ? Date.now() - options.days * 86_400_000 : 0;
    const all = query.toLowerCase();

    const scored: Array<{ row: IndexEntry; score: number }> = [];
    for (const row of rows) {
      if (since && row.epoch < since) {
        continue;
      }
      if (options.chatId && row.groupOpenid !== options.chatId && row.chat !== options.chatId) {
        continue;
      }
      if (options.sender) {
        const wanted = options.sender.toLowerCase();
        const name = (row.senderName ?? '').toLowerCase();
        if (!(row.senderId === options.sender || name.includes(wanted))) {
          continue;
        }
      }
      const text = row.content?.toLowerCase() ?? '';
      let score = 0;
      if (all && text.includes(all)) {
        score += 6;
      }
      let matched = 0;
      for (const term of terms) {
        if (text.includes(term)) {
          matched += 1;
          score += 2;
        }
      }
      if (terms.length > 1) {
        // 多个词必须都命中，避免噪音
        if (matched < terms.length) {
          continue;
        }
      }
      // 没有关键词时（纯按人/时间筛）给基础分；有关键词就必须命中，不能靠兜底混进来
      if (terms.length === 0) {
        score = 1;
      }
      if (score === 0) {
        continue;
      }
      // 越新的小幅加权
      const ageDays = (Date.now() - row.epoch) / 86_400_000;
      scored.push({ row, score: score + Math.max(0, 3 - ageDays / 7) });
    }

    scored.sort((a, b) => b.score - a.score || b.row.epoch - a.row.epoch);
    return scored.slice(0, limit).map(({ row }) => ({
      at: row.at,
      sender: row.senderName ?? row.senderId?.slice(0, 8) ?? '未知',
      senderId: row.senderId ?? '',
      content: (row.content ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT),
      chat: row.groupOpenid ?? row.chat,
      hasImage: (row.attachments ?? []).some((a) => (a.contentType ?? '').startsWith('image/')),
    }));
  }
}

/** 把检索结果渲染成给模型看的紧凑文本。 */
export function renderHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return '（没有找到相关消息）';
  }
  return hits
    .map((hit) => {
      const when = hit.at.replace('T', ' ').slice(0, 16);
      const media = hit.hasImage ? ' [图片]' : '';
      return `[${when}] ${hit.sender}${media}: ${hit.content}`;
    })
    .join('\n');
}
