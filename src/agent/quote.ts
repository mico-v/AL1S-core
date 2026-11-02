/**
 * 引用解析。
 *
 * QQ 的引用只给一个 refMsgIdx，要自己拿它去对 msgIdx。
 * 之前在内存里存最近 600 条，重启就全丢 —— 群里 2273 条引用消息，
 * 能对上的只有一半，而且重启后是零。
 *
 * 这里改成从 chat-log 增量读：文件的 mtime/size 变了就只读新增的字节，
 * 14k 条消息也只解析一次，之后每条只读几十字节。
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface QuoteRef {
  sender: string;
  text: string;
  at: string;
}

interface LogLine {
  msgIdx?: string;
  senderName?: string;
  senderId?: string;
  content?: string;
  timestamp?: string;
}

const MAX_ENTRIES = 40_000;
const MAX_TEXT = 300;

class GroupQuoteIndex {
  private offset = 0;
  private readonly map = new Map<string, QuoteRef>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async touch(): Promise<void> {
    if (!existsSync(this.file)) {
      return;
    }
    let size = 0;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return;
    }
    // 文件被截断/轮转：整份重建
    if (size < this.offset) {
      this.offset = 0;
      this.map.clear();
    }
    if (size === this.offset) {
      return;
    }

    const buffer = Buffer.alloc(size - this.offset);
    const handle = await (await import('node:fs/promises')).open(this.file, 'r');
    try {
      await handle.read(buffer, 0, buffer.length, this.offset);
    } finally {
      await handle.close();
    }

    const text = buffer.toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak === -1) {
      // 只有半行，等下次再读
      return;
    }
    const complete = text.slice(0, lastBreak);
    this.offset += Buffer.byteLength(complete, 'utf8') + 1;

    for (const line of complete.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as LogLine;
        if (!record.msgIdx) {
          continue;
        }
        this.map.set(record.msgIdx, {
          sender: record.senderName ?? record.senderId?.slice(0, 8) ?? '某人',
          text: (record.content ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
          at: record.timestamp ?? '',
        });
      } catch {
        // 坏行跳过
      }
    }

    if (this.map.size > MAX_ENTRIES) {
      const drop = this.map.size - MAX_ENTRIES;
      let i = 0;
      for (const key of this.map.keys()) {
        if (i >= drop) {
          break;
        }
        this.map.delete(key);
        i += 1;
      }
    }
  }

  get(idx: string): QuoteRef | undefined {
    return this.map.get(idx);
  }

  get size(): number {
    return this.map.size;
  }
}

export class QuoteResolver {
  private readonly byGroup = new Map<string, GroupQuoteIndex>();
  private readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
  }

  private indexFor(groupOpenid: string): GroupQuoteIndex {
    const safe = groupOpenid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
    let index = this.byGroup.get(safe);
    if (!index) {
      index = new GroupQuoteIndex(
        path.join(this.dataRoot, 'chats', 'group', safe, 'messages.jsonl'),
      );
      this.byGroup.set(safe, index);
    }
    return index;
  }

  /** 解析一条引用。解析不到就返回 undefined —— 调用方要明说「看不到」，不许猜。 */
  async resolve(groupOpenid: string, refMsgIdx: string | undefined): Promise<QuoteRef | undefined> {
    if (!refMsgIdx) {
      return undefined;
    }
    const index = this.indexFor(groupOpenid);
    await index.touch();
    return index.get(refMsgIdx);
  }

  /** 测试/运维用。 */
  stats(groupOpenid: string): number {
    return this.indexFor(groupOpenid).size;
  }
}
