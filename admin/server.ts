/**
 * Kei 的只读管理台。
 *
 * 三块数据：调用账本（data/calls）、聊天记录（data/chats）、运行配置（.env）。
 * 全程只读 —— 这个服务不碰机器人状态，也不写任何文件。
 */

import express from 'express';
import compression from 'compression';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords, summarize, type CallRecord } from '../src/agent/telemetry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DATA = process.env.ADMIN_DATA_DIR ?? path.join(REPO, 'data');
const DIST = path.join(HERE, 'dist');
const PORT = Number(process.env.ADMIN_PORT ?? 18082);
const HOST = process.env.ADMIN_HOST ?? '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(compression());

interface ChatRecord {
  timestamp?: string;
  recordedAt?: string;
  rawEventType?: string;
  kind?: string;
  senderId?: string;
  senderName?: string;
  senderIsBot?: boolean;
  content?: string;
  msgType?: number;
  groupOpenid?: string;
  attachments?: Array<{ contentType?: string; url?: string }>;
  messageId?: string;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await readFile(file, 'utf8');
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 半行/坏行，跳过
    }
  }
  return out;
}

/** 把 data/chats/<kind>/<id>/messages.jsonl 全读出来，按时间倒序。 */
async function loadMessages(): Promise<Array<ChatRecord & { scope: string }>> {
  const chatsRoot = path.join(DATA, 'chats');
  if (!existsSync(chatsRoot)) {
    return [];
  }
  const all: Array<ChatRecord & { scope: string }> = [];
  for (const kind of await readdir(chatsRoot)) {
    const kindDir = path.join(chatsRoot, kind);
    if (!(await stat(kindDir)).isDirectory()) {
      continue;
    }
    for (const target of await readdir(kindDir)) {
      const file = path.join(kindDir, target, 'messages.jsonl');
      if (!existsSync(file)) {
        continue;
      }
      for (const record of await readJsonl<ChatRecord>(file)) {
        all.push({ ...record, scope: `${kind}/${target}` });
      }
    }
  }
  all.sort((a, b) => String(b.timestamp ?? b.recordedAt).localeCompare(String(a.timestamp ?? a.recordedAt)));
  return all;
}

/** 读 .env，密钥类只留长度，别把值送到浏览器。 */
async function loadSettings(): Promise<Array<{ group: string; items: Array<{ key: string; value: string; secret: boolean }> }>> {
  const envFile = path.join(REPO, '.env');
  if (!existsSync(envFile)) {
    return [];
  }
  const raw = await readFile(envFile, 'utf8');
  const groups = new Map<string, Array<{ key: string; value: string; secret: boolean }>>();
  let current = '其他';
  const secretPattern = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL)/i;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('#')) {
      const title = trimmed.replace(/^#+\s*/, '').replace(/^-\s*/, '').trim();
      if (title && !/^[-=]+$/.test(title)) {
        current = title.replace(/[（(].*?[)）]/g, '').trim() || '其他';
      }
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    const secret = secretPattern.test(key);
    const shown = secret ? (value ? `已设置 · ${value.length} 字符` : '未设置') : value || '(空)';
    const list = groups.get(current) ?? [];
    list.push({ key, value: shown, secret });
    groups.set(current, list);
  }

  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

function pickDays(raw: unknown): number {
  const n = Number(raw ?? 7);
  return Number.isFinite(n) && n > 0 && n <= 90 ? n : 7;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, data: DATA, uptime: process.uptime() });
});

app.get('/api/summary', async (req, res, next) => {
  try {
    const days = pickDays(req.query.days);
    const records = await readRecords(path.join(DATA, 'calls'), days);

    const byPurpose = new Map<string, CallRecord[]>();
    const byDay = new Map<string, CallRecord[]>();
    for (const record of records) {
      const p = byPurpose.get(record.purpose) ?? [];
      p.push(record);
      byPurpose.set(record.purpose, p);
      const d = byDay.get(record.at.slice(0, 10)) ?? [];
      d.push(record);
      byDay.set(record.at.slice(0, 10), d);
    }

    const messages = await loadMessages();
    const since = Date.now() - days * 86_400_000;
    const recentMessages = messages.filter((m) => Date.parse(m.timestamp ?? m.recordedAt ?? '') >= since);

    res.json({
      days,
      summary: summarize(records),
      purposes: [...byPurpose.entries()].map(([purpose, list]) => ({ purpose, ...summarize(list) })),
      daily: [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, list]) => ({ day, ...summarize(list) })),
      messages: {
        total: messages.length,
        inRange: recentMessages.length,
        members: new Set(messages.map((m) => m.senderId)).size,
        groups: new Set(messages.map((m) => m.groupOpenid ?? m.scope)).size,
      },
      slowest: [...records].sort((a, b) => b.ms - a.ms).slice(0, 8),
      failures: records.filter((r) => !r.ok).slice(-8).reverse(),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/calls', async (req, res, next) => {
  try {
    const days = pickDays(req.query.days);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    const records = await readRecords(path.join(DATA, 'calls'), days);
    res.json({ total: records.length, items: records.slice(-limit).reverse() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/messages', async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 60)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const sender = String(req.query.sender ?? '').trim();

    let messages = await loadMessages();
    if (q) {
      messages = messages.filter(
        (m) => (m.content ?? '').toLowerCase().includes(q) || (m.senderName ?? '').toLowerCase().includes(q),
      );
    }
    if (sender) {
      messages = messages.filter((m) => m.senderId === sender);
    }

    res.json({
      total: messages.length,
      offset,
      items: messages.slice(offset, offset + limit).map((m) => ({
        timestamp: m.timestamp ?? m.recordedAt,
        senderId: m.senderId,
        senderName: m.senderName,
        content: m.content,
        msgType: m.msgType,
        attachments: (m.attachments ?? []).map((a) => a.contentType ?? 'file'),
        scope: m.scope,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    const groups = await loadSettings();
    const calls = await readRecords(path.join(DATA, 'calls'), 1);
    res.json({
      groups,
      runtime: {
        dataDir: DATA,
        callsToday: calls.length,
        node: process.version,
        platform: process.platform,
        pid: process.pid,
      },
    });
  } catch (error) {
    next(error);
  }
});

// 前端静态资源
if (existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(503).type('text/plain').send('前端还没构建：cd admin && npm run build');
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[admin]', error);
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

app.listen(PORT, HOST, () => {
  console.log(`[admin] http://${HOST}:${PORT}  data=${DATA}  dist=${existsSync(DIST) ? 'ok' : '缺失'}`);
});
