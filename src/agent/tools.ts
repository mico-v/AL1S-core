/**
 * 给模型用的工具。
 *
 * 设计原则：只读、快、返回紧凑文本。模型看不到文件系统，这里就是它的眼睛。
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogger } from '../logger.js';
import { MessageIndex, renderHits } from './search.js';

export interface ToolContext {
  dataRoot: string;
  /** 当前会话（群 openid）；搜历史时默认只看这个群 */
  groupId?: string;
  log: AppLogger;
}

export const TOOL_DEFINITIONS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description:
        '在群聊历史记录里检索消息。当群友提到过去发生的事、某句话、某个梗，或者你记不清时，用它查证，不要凭印象猜。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，多个词用空格分隔（需同时出现）' },
          sender: { type: 'string', description: '只看某个人说的，填昵称' },
          days: { type: 'number', description: '只搜最近多少天，不填表示全部历史' },
          limit: { type: 'number', description: '返回条数，默认 8，最大 20' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'member_profile',
      description: '查某个群友的长期档案：性格、口癖、常聊话题。当你需要确认「他是谁」「之前记过什么」时用它。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '群友昵称，可以是部分匹配' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_topics',
      description:
        '在「话题索引」里检索：每轮群聊归档时生成的话题条目（标题+关键词+一句话）。问「之前聊过什么」「有没有聊过 X」时先查这里，比逐条翻消息快。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '话题关键词，留空则返回最近所有话题' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_digests',
      description: '读最近的对话摘要：每一段群聊聊了什么、气氛如何。适合回答「昨天群里聊了啥」。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '最近几天，默认 7' },
          limit: { type: 'number', description: '最多几条，默认 5' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'chat_stats',
      description: '群聊整体统计：消息总数、时间跨度、谁说话最多。适合回答「群里最近活跃吗」这类问题。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** 索引按 dataRoot 复用，避免每次检索都重新解析 JSONL。 */
const indexes = new Map<string, MessageIndex>();

function indexFor(dataRoot: string): MessageIndex {
  let index = indexes.get(dataRoot);
  if (!index) {
    index = new MessageIndex(dataRoot);
    indexes.set(dataRoot, index);
  }
  return index;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function memberProfile(ctx: ToolContext, name: string): Promise<string> {
  const groups = existsSync(path.join(ctx.dataRoot, 'memory'))
    ? await readdir(path.join(ctx.dataRoot, 'memory'))
    : [];
  const wanted = name.trim().toLowerCase();
  if (!wanted) {
    return '需要提供昵称。';
  }

  const matches: Array<{ name: string; body: string }> = [];
  for (const group of groups) {
    const dir = path.join(ctx.dataRoot, 'memory', group, 'members');
    if (!existsSync(dir)) {
      continue;
    }
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.md')) {
        continue;
      }
      const body = await readFile(path.join(dir, file), 'utf8');
      const title = body.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? '';
      if (title.toLowerCase().includes(wanted) || wanted.includes(title.toLowerCase())) {
        matches.push({ name: title, body });
      }
    }
  }

  if (matches.length === 0) {
    return `没有找到「${name}」的档案 —— 你可能还没记住这个人，直接说不熟就行，别编。`;
  }
  return matches
    .slice(0, 2)
    .map((m) => m.body.trim().slice(0, 900))
    .join('\n\n---\n\n');
}

async function chatStats(ctx: ToolContext): Promise<string> {
  const index = indexFor(ctx.dataRoot);
  const total = await index.size();
  if (total === 0) {
    return '还没有聊天记录。';
  }
  // 借 search 的空关键词走一遍全量太贵，这里只给规模和最近活跃度
  const recent = await index.search({ query: '', days: 7, limit: 20 });
  return [
    `消息总数：${total} 条`,
    `最近 7 天抽样：${recent.length > 0 ? '有活动' : '很安静'}`,
    recent.length > 0 ? `最近的活跃发言者：${[...new Set(recent.map((r) => r.sender))].slice(0, 5).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}


interface TopicEntry {
  title: string;
  keywords: string[];
  summary?: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

interface DigestEntry {
  day: string;
  from: string;
  to: string;
  count: number;
  participants: string[];
  summary: string;
  topics?: Array<{ title: string }>;
}

/** 列出可用的摘要目录（指定群，或全部群）。 */
async function digestDirs(ctx: ToolContext): Promise<string[]> {
  const memory = path.join(ctx.dataRoot, 'memory');
  if (!existsSync(memory)) {
    return [];
  }
  const groups = ctx.groupId ? [ctx.groupId] : await readdir(memory);
  const dirs: string[] = [];
  for (const group of groups) {
    const dir = path.join(memory, group, 'digest');
    if (existsSync(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

async function searchTopics(ctx: ToolContext, query: string): Promise<string> {
  const dirs = await digestDirs(ctx);
  const wanted = query.trim().toLowerCase();
  const hits: TopicEntry[] = [];

  for (const dir of dirs) {
    const file = path.join(dir, 'topics.json');
    if (!existsSync(file)) {
      continue;
    }
    let list: TopicEntry[] = [];
    try {
      list = JSON.parse(await readFile(file, 'utf8')) as TopicEntry[];
    } catch {
      continue;
    }
    for (const topic of list) {
      if (!wanted) {
        hits.push(topic);
        continue;
      }
      const haystack = `${topic.title} ${topic.keywords.join(' ')} ${topic.summary ?? ''}`.toLowerCase();
      if (haystack.includes(wanted)) {
        hits.push(topic);
      }
    }
  }

  if (hits.length === 0) {
    return wanted ? '话题索引里没有匹配的条目。' : '还没有任何话题归档。';
  }
  hits.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return hits
    .slice(0, 10)
    .map((t) => {
      const span = `${t.firstAt.slice(5, 10)}~${t.lastAt.slice(5, 10)}`;
      const kw = t.keywords.length > 0 ? ` · 关键词 ${t.keywords.join('、')}` : '';
      return `「${t.title}」${t.count} 次 · ${span}${kw}${t.summary ? ` · ${t.summary}` : ''}`;
    })
    .join('\n');
}

async function recentDigests(ctx: ToolContext, days: number, limit: number): Promise<string> {
  const dirs = await digestDirs(ctx);
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  const rows: DigestEntry[] = [];

  for (const dir of dirs) {
    const file = path.join(dir, 'records.jsonl');
    if (!existsSync(file)) {
      continue;
    }
    const raw = await readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as DigestEntry;
        if (Date.parse(record.to) >= since) {
          rows.push(record);
        }
      } catch {
        // 坏行跳过
      }
    }
  }

  if (rows.length === 0) {
    return `最近 ${days} 天没有对话归档。`;
  }
  rows.sort((a, b) => b.to.localeCompare(a.to));
  return rows
    .slice(0, Math.max(1, limit))
    .map((r) => {
      const span = `${r.from.slice(5, 16).replace('T', ' ')} → ${r.to.slice(11, 16)}`;
      const who = r.participants.slice(0, 4).join('、');
      const topics = (r.topics ?? []).map((t) => t.title).join(' / ');
      return `[${span}] ${r.summary}${topics ? `\n  话题：${topics}` : ''}${who ? `\n  在场：${who}` : ''}`;
    })
    .join('\n\n');
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const args = safeParse(rawArgs);
  try {
    if (name === 'search_messages') {
      const query = asString(args.query).trim();
      if (!query) {
        return '需要提供关键词 query。';
      }
      const hits = await indexFor(ctx.dataRoot).search({
        query,
        sender: asString(args.sender) || undefined,
        days: asNumber(args.days),
        limit: asNumber(args.limit),
        chatId: ctx.groupId,
      });
      ctx.log.info('检索历史', { query, hits: hits.length });
      return renderHits(hits);
    }
    if (name === 'member_profile') {
      return await memberProfile(ctx, asString(args.name));
    }
    if (name === 'search_topics') {
      return await searchTopics(ctx, asString(args.query));
    }
    if (name === 'recent_digests') {
      return await recentDigests(ctx, asNumber(args.days) ?? 7, asNumber(args.limit) ?? 5);
    }
    if (name === 'chat_stats') {
      return await chatStats(ctx);
    }
    return `未知工具：${name}`;
  } catch (error) {
    ctx.log.warn('工具执行失败', { name, error });
    return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
