/**
 * 对话摘要与话题索引。
 *
 * 群聊累积到一定条数后，把这一段的对话交给模型压缩成：
 *   1. 一段摘要（聊了什么、气氛如何、谁的状态有变化）
 *   2. 若干话题条目（标题 + 关键词 + 一句话）
 *   3. 可选的群体记忆点（值得长期记住的事）
 *
 * 摘要和话题落进 data/memory/<群>/digest/，供检索工具和人查看；
 * 水位线独立于成员档案归纳（后者用 memory/state.json），互不覆盖。
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogger } from '../logger.js';
import { chatComplete, type ChatMessage, type LlmOptions } from './llm.js';
import { readNewRecords, type RawRecord } from './memory.js';

export interface DigestTopic {
  title: string;
  keywords: string[];
  summary?: string;
}

export interface DigestRecord {
  id: string;
  day: string;
  from: string;
  to: string;
  count: number;
  participants: string[];
  summary: string;
  topics: DigestTopic[];
  note?: string;
}

export interface DigestOptions {
  dataRoot: string;
  llm: LlmOptions;
  log: AppLogger;
  /** 累积多少条触发一次摘要 */
  threshold: number;
  /** 单次最多喂多少条给模型 */
  maxBatch: number;
  /** 摘要里出现值得长期记住的事时回调（用来触发档案更新） */
  onMemoryWorthy?: (chatId: string, note: string) => void;
  /** 测试注入用；默认走真实模型 */
  complete?: (messages: ChatMessage[], opts: LlmOptions) => Promise<string>;
}

interface DigestState {
  lastMessageId?: string;
  lastMessageAt?: string;
}

const PROMPT = `你在给一个 QQ 群做"这一轮聊了什么"的归档。

给你一段连续群聊，请产出三样东西：

1. **summary**：3–5 句，说清这轮在聊什么、气氛如何、谁的状态或立场有变化。
   写事实，不写"大家进行了愉快的交流"这种空话。
2. **topics**：这一轮的话题条目，1–5 条。每条给：
   - title：不超过 12 字的话题名
   - keywords：2–6 个检索关键词（人名、作品名、具体事件）
   - summary：一句话说清这个话题聊到哪了
3. **note**：只有出现"值得长期记住的群体事件"时才写（约定、矛盾、谁退群了、
   某个梗的起源），否则留空字符串。

不要编造消息里没有的信息。拿不准就不写。

只输出 JSON：
{"summary":"...","topics":[{"title":"...","keywords":["..."],"summary":"..."}],"note":""}`;

function digestDir(dataRoot: string, chatId: string): string {
  return path.join(dataRoot, 'memory', chatId, 'digest');
}

async function readState(file: string): Promise<DigestState> {
  if (!existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DigestState;
  } catch {
    return {};
  }
}

function extractJson(raw: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = fenced?.[1] ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function renderRecords(records: RawRecord[]): string {
  return records
    .map((r) => {
      const at = String(r.timestamp ?? '').slice(11, 16);
      const who = r.senderName ?? r.senderId.slice(0, 8);
      const text = (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return `${at} ${who}: ${text}`;
    })
    .join('\n');
}

export class DigestEngine {
  private readonly opts: DigestOptions;
  /** 自上次摘要以来观察到的新消息数 */
  private readonly pending = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(opts: DigestOptions) {
    this.opts = opts;
  }

  /** 每收到一条消息调用一次；到阈值就后台摘要，不阻塞回复。 */
  observe(chatId: string): void {
    const next = (this.pending.get(chatId) ?? 0) + 1;
    this.pending.set(chatId, next);
    if (next >= this.opts.threshold) {
      void this.digest(chatId).catch((error: unknown) => {
        this.opts.log.warn('对话摘要失败', { chatId, error });
      });
    }
  }

  /** 手动/定时触发：按 chat-log 水位线看看够不够。 */
  async dueCount(chatId: string): Promise<number> {
    const state = await readState(path.join(digestDir(this.opts.dataRoot, chatId), 'state.json'));
    const records = await readNewRecords(this.opts.dataRoot, chatId, state.lastMessageId);
    return records.length;
  }

  async digest(chatId: string): Promise<DigestRecord | undefined> {
    if (this.running.has(chatId)) {
      return undefined;
    }
    this.running.add(chatId);
    try {
      const dir = digestDir(this.opts.dataRoot, chatId);
      await mkdir(dir, { recursive: true });
      const stateFile = path.join(dir, 'state.json');
      const state = await readState(stateFile);

      const fresh = await readNewRecords(this.opts.dataRoot, chatId, state.lastMessageId);
      if (fresh.length < Math.min(8, this.opts.threshold)) {
        this.pending.set(chatId, fresh.length);
        return undefined;
      }
      const batch = fresh.slice(-this.opts.maxBatch);
      const first = batch[0];
      const last = batch[batch.length - 1];
      if (!first || !last) {
        return undefined;
      }

      const complete = this.opts.complete ?? chatComplete;
      const raw = await complete(
        [
          { role: 'system', content: PROMPT },
          {
            role: 'user',
            content: `## 群聊片段（${batch.length} 条）\n\n${renderRecords(batch)}`,
          },
        ],
        {
          ...this.opts.llm,
          maxTokens: 1200,
          temperature: 0.3,
          disableThinking: true,
          purpose: 'digest',
          conversationId: chatId,
        },
      );

      const parsed = extractJson(raw);
      const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
      if (!summary) {
        this.opts.log.warn('摘要为空，跳过', { chatId, bytes: raw.length });
        return undefined;
      }

      const topics: DigestTopic[] = [];
      if (Array.isArray(parsed?.topics)) {
        for (const item of parsed.topics as unknown[]) {
          if (topics.length >= 5) {
            break;
          }
          if (!item || typeof item !== 'object') {
            continue;
          }
          const rec = item as Record<string, unknown>;
          const title = typeof rec.title === 'string' ? rec.title.trim() : '';
          if (!title) {
            continue;
          }
          const topic: DigestTopic = { title: title.slice(0, 20), keywords: [] };
          if (Array.isArray(rec.keywords)) {
            topic.keywords = (rec.keywords as unknown[])
              .filter((k): k is string => typeof k === 'string')
              .slice(0, 6);
          }
          if (typeof rec.summary === 'string' && rec.summary.trim()) {
            topic.summary = rec.summary.trim();
          }
          topics.push(topic);
        }
      }

      const note = typeof parsed?.note === 'string' ? parsed.note.trim() : '';
      const participants = [...new Set(batch.map((r) => r.senderName ?? r.senderId.slice(0, 8)))];

      const record: DigestRecord = {
        id: new Date().toISOString(),
        day: String(last.timestamp ?? '').slice(0, 10),
        from: String(first.timestamp ?? ''),
        to: String(last.timestamp ?? ''),
        count: batch.length,
        participants,
        summary,
        topics,
        ...(note ? { note } : {}),
      };

      await appendFile(path.join(dir, 'records.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
      await this.mergeTopics(dir, record);
      if (note) {
        await appendFile(
          path.join(dir, 'notes.md'),
          `- ${record.day} ${note}\n`,
          'utf8',
        );
        this.opts.onMemoryWorthy?.(chatId, note);
      }

      await writeFile(
        stateFile,
        JSON.stringify({ lastMessageId: last.messageId, lastMessageAt: record.to }, null, 2),
        'utf8',
      );
      this.pending.set(chatId, 0);
      this.opts.log.info('对话已归档', {
        chatId,
        count: record.count,
        topics: topics.length,
        note: note ? 'yes' : 'no',
      });
      return record;
    } finally {
      this.running.delete(chatId);
    }
  }

  /** 话题按标题合并计数，避免同一件事每次都新增一条。 */
  private async mergeTopics(dir: string, record: DigestRecord): Promise<void> {
    const file = path.join(dir, 'topics.json');
    let topics: Array<DigestTopic & { count: number; firstAt: string; lastAt: string }> = [];
    if (existsSync(file)) {
      try {
        topics = JSON.parse(await readFile(file, 'utf8')) as typeof topics;
      } catch {
        topics = [];
      }
    }
    for (const topic of record.topics) {
      const existing = topics.find((t) => t.title === topic.title);
      if (existing) {
        existing.count += 1;
        existing.lastAt = record.to;
        existing.summary = topic.summary ?? existing.summary;
        existing.keywords = [...new Set([...existing.keywords, ...topic.keywords])].slice(0, 8);
      } else {
        topics.push({ ...topic, count: 1, firstAt: record.from, lastAt: record.to });
      }
    }
    topics.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    await writeFile(file, JSON.stringify(topics.slice(0, 400), null, 2), 'utf8');
  }

  async readDigests(chatId: string, limit = 5): Promise<DigestRecord[]> {
    const file = path.join(digestDir(this.opts.dataRoot, chatId), 'records.jsonl');
    if (!existsSync(file)) {
      return [];
    }
    const rows = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as DigestRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is DigestRecord => r !== undefined);
    return rows.slice(-limit).reverse();
  }

  async readTopics(chatId: string): Promise<Array<DigestTopic & { count: number; firstAt: string; lastAt: string }>> {
    const file = path.join(digestDir(this.opts.dataRoot, chatId), 'topics.json');
    if (!existsSync(file)) {
      return [];
    }
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return [];
    }
  }
}
