/**
 * 管理后台 API 路由：统一 `/api/*` 处理器 + 日志 SSE。
 * 响应包裹统一为 `{ ok, data?, error? }`；未授权返回 401。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigStore } from '../config/store';
import { CONFIG_FIELD_MAP, CONFIG_GROUPS } from '../config/schema';
import type { SkillRegistry } from '../skills/registry';
import type { PluginControl } from '../plugins/control';
import type { SessionManager } from '../session/manager';
import type { SessionPersistence } from '../session/persistence';
import { logBuffer, type LogRecord } from '../logging/buffer';
import { metricsSnapshot } from '../metrics';
import { adminToken, isAuthorized } from './auth';
import type { MspRuntime } from '../msp/protocol/types';

/** 管理服务能接触到的 bot 运行态 */
export interface AdminContext {
  configStore: ConfigStore;
  registry: SkillRegistry;
  pluginControl: PluginControl;
  sessions: SessionManager;
  persistence?: SessionPersistence;
  isConnected(): boolean;
  getLogin(): Promise<{ user_id: number; nickname: string } | undefined>;
  getBotNickname(): string;
  startedAt: number;
  version: string;
  /** 优雅关闭（落盘会话 + 关连接 + 退出）；缺省时直接 process.exit */
  shutdown?: () => void;
  getMspRuntime?: () => MspRuntime;
}

/** 仅 SSE 允许用 ?token= 鉴权（EventSource 无法自定义请求头）；其余接口只认 Bearer 头 */
function queryTokenMatches(url: URL): boolean {
  const token = adminToken();
  return token !== undefined && url.searchParams.get('token') === token;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function ok(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { ok: true, data });
}

function fail(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { ok: false, error });
}

function redactConfigValues(values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values };
  for (const key of Object.keys(out)) {
    if (/key|token|secret|password/i.test(key)) {
      out[key] = out[key] ? '••••••••' : '';
    }
  }
  return out;
}
const MAX_JSON_BODY_BYTES = 1_000_000;

/** 读取并解析 JSON body */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const failOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (c) => {
      if (settled) return;
      const chunk = c as Buffer;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        failOnce(new Error('JSON body 过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`JSON 解析失败：${e instanceof Error ? e.message : e}`));
      }
    });
    req.on('error', (error) => failOnce(error instanceof Error ? error : new Error(String(error))));
  });
}

/** 处理 /api/* 请求；返回是否已处理（false → 交静态托管） */
export async function handleApiRequest(ctx: AdminContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false;
  const isSse = url.pathname === '/api/logs/stream';
  const authorized = isAuthorized(req) || (isSse && queryTokenMatches(url));
  if (!authorized) {
    fail(res, 401, '未授权：需要 Bearer ADMIN_TOKEN');
    return true;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  try {
    // --- 状态 ---
    if (method === 'GET' && path === '/api/status') {
      let login: { user_id: number; nickname: string } | undefined;
      try {
        login = await ctx.getLogin();
      } catch {
        login = undefined;
      }
      ok(res, {
        connected: ctx.isConnected(),
        login,
        botNickname: ctx.getBotNickname(),
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)),
        sessionCount: ctx.sessions.size,
        metrics: metricsSnapshot(),
        version: ctx.version,
        restartRequired: ctx.configStore.restartRequired,
      });
      return true;
    }

    // --- 配置 ---
    if (path === '/api/config') {
      if (method === 'GET') {
        ok(res, { values: redactConfigValues(ctx.configStore.getValues()) });
        return true;
      }
      if (method === 'PUT') {
        const body = (await readJsonBody(req)) as { values?: Record<string, unknown> };
        const values = body?.values ?? {};
        for (const [key, value] of Object.entries(values)) {
          if (/key|token|secret|password/i.test(key) && value === '••••••••') delete values[key];
        }
        const { applied, pendingRestart } = ctx.configStore.updateValues(values);
        ok(res, { applied, pendingRestart });
        return true;
      }
    }
    if (method === 'GET' && path === '/api/config/secret') {
      const key = url.searchParams.get('key') ?? '';
      const meta = CONFIG_FIELD_MAP[key];
      if (!meta || meta.type !== 'password') {
        fail(res, 404, '密钥字段不存在');
        return true;
      }
      const value = ctx.configStore.getField(key);
      ok(res, { key, value: typeof value === 'string' ? value : '' });
      return true;
    }
    if (method === 'GET' && path === '/api/config/schema') {
      ok(res, { groups: CONFIG_GROUPS });
      return true;
    }

    // --- 插件/命令/工具 ---
    if (method === 'GET' && path === '/api/plugins') {
      ok(res, ctx.pluginControl.list());
      return true;
    }
    if (method === 'PUT' && path === '/api/plugins/enabled') {
      const body = (await readJsonBody(req)) as { kind?: 'command' | 'skill' | 'plugin'; id?: string; name?: string; enabled?: unknown };
      const kind = body?.kind;
      const name = body?.name;
      const enabled = body?.enabled;
      if (kind === 'command' && typeof body?.id === 'string') {
        const changedById = ctx.registry.setCommandEnabledById(body.id, enabled as boolean);
        if (!changedById) { fail(res, 404, `未找到 command ${body.id}`); return true; }
        ok(res, { enabled });
        return true;
      }
      if (typeof enabled !== 'boolean') {
        fail(res, 400, '参数错误：enabled 必须是 boolean');
        return true;
      }
      if ((kind !== 'command' && kind !== 'skill' && kind !== 'plugin') || typeof name !== 'string') {
        fail(res, 400, '参数错误：需要 kind(command|plugin) 与 name，以及 boolean enabled');
        return true;
      }
      const changed = kind === 'plugin'
        ? ctx.pluginControl.setPluginEnabled(name, enabled)
        : ctx.pluginControl.setEnabled(kind, name, enabled);
      if (!changed) {
        fail(res, 404, `未找到 ${kind} ${name}`);
        return true;
      }
      ok(res, { enabled });
      return true;
    }

    // --- 插件设置（每插件一组）--- 固定在 /api/plugins 与 /api/plugins/enabled 之后匹配
    const pluginConfigMatch = path.match(/^\/api\/plugins\/([^/]+)\/config$/);
    if (pluginConfigMatch) {
      const pluginName = decodeURIComponent(pluginConfigMatch[1]!);
      const meta = ctx.registry.getPluginMeta(pluginName);
      if (!meta) {
        fail(res, 404, `插件不存在：${pluginName}`);
        return true;
      }
      if (method === 'GET') {
        const group = meta.settings ?? null;
        const values: Record<string, unknown> = {};
        if (group) for (const f of group.fields) {
          const value = ctx.configStore.getField(f.key);
          values[f.key] = f.type === 'password' ? (value ? '••••••••' : '') : value;
        }
        ok(res, { group, values });
        return true;
      }
      if (method === 'PUT') {
        if (!meta.settings) {
          fail(res, 400, `插件 ${pluginName} 无设置项`);
          return true;
        }
        const body = (await readJsonBody(req)) as { values?: Record<string, unknown> };
        const allowed = new Set(meta.settings.fields.map((f) => f.key));
        const patch = Object.fromEntries(Object.entries(body?.values ?? {}).filter(([key]) => allowed.has(key)));
        const { applied, pendingRestart } = ctx.configStore.updateValues(patch);
        ok(res, { applied, pendingRestart });
        return true;
      }
    }

    // --- 会话 ---
    if (path === '/api/sessions') {
      if (method === 'GET') {
        const disk = ctx.persistence?.listDiskSummaries() ?? [];
        const byId = new Map(disk.map((s) => [s.chatId, s]));
        for (const s of ctx.sessions.list()) byId.set(s.chatId, {
          chatId: s.chatId, messageCount: s.size, lastActivity: s.lastActivity, isGenerating: s.isGenerating, personaOverride: s.personaOverride,
        });
        const sessions = [...byId.values()].map((s) => ({
          chatId: s.chatId,
          messageCount: s.messageCount,
          lastActivity: Math.floor(s.lastActivity / 1000),
          isGenerating: 'isGenerating' in s ? Boolean(s.isGenerating) : false,
          personaOverride: s.personaOverride,
        })).sort((a, b) => b.lastActivity - a.lastActivity);
        ok(res, { sessions });
        return true;
      }
    }
    const sessionMatch = path.match(/^\/api\/sessions\/(.+)$/);
    if (sessionMatch) {
      const chatId = decodeURIComponent(sessionMatch[1]!);
      if (method === 'GET') {
        const session = ctx.sessions.getOrLoad(chatId);
        const messages = session.getSnapshot().map((m) => ({ ...m, time: Math.floor(m.time / 1000) })); // 统一 epoch 秒
        ok(res, { chatId, messages });
        return true;
      }
      if (method === 'DELETE') {
        ctx.sessions.clear(chatId);
        ctx.persistence?.remove(chatId);
        ok(res, null);
        return true;
      }
    }

    // --- MSP AgentBridge runtime ---
    if (method === 'GET' && path === '/api/msp/runtime') {
      const runtime = ctx.getMspRuntime?.();
      if (!runtime) { fail(res, 503, 'MSP runtime 不可用'); return true; }
      ok(res, { capabilities: runtime.getCapabilities(), commands: runtime.listCommands(), formatOutput: ctx.configStore.config.msp.formatOutput, workspace: '/' });
      return true;
    }
    if (method === 'GET' && path === '/api/msp/sessions') {
      const runtime = ctx.getMspRuntime?.();
      if (!runtime) { fail(res, 503, 'MSP runtime 不可用'); return true; }
      ok(res, { sessions: runtime.listSessions(), capabilities: runtime.getCapabilities() });
      return true;
    }


    if (method === 'GET' && path === '/api/logs') {
      const level = url.searchParams.get('level');
      const tag = url.searchParams.get('tag');
      const limitRaw = Number(url.searchParams.get('limit') ?? 200);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 1000) : 200;
      let logs = logBuffer.recent(limit);
      if (level) logs = logs.filter((l) => l.level === level);
      if (tag) logs = logs.filter((l) => l.tag === tag);
      ok(res, { logs });
      return true;
    }
    if (method === 'GET' && path === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');

      // 每条 log 事件带 id（基于记录时间的兼容格式）
      const sendLog = (record: LogRecord): void => {
        res.write(`id: ${record.time}\n`);
        res.write(`event: log\ndata: ${JSON.stringify(record)}\n\n`);
      };

      const lastId = req.headers['last-event-id'];
      if (typeof lastId === 'string' && lastId) {
        // 断线续传：只补发断点之后的历史，不重推 snapshot
        const after = logBuffer.recent().filter((r) => r.time > lastId);
        for (const record of after) sendLog(record);
      } else {
        // 首次连接：推历史快照
        const snapshot = logBuffer.recent(200);
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      }

      const unsubscribe = logBuffer.subscribe((record) => sendLog(record));
      req.on('close', () => {
        unsubscribe();
        res.end();
      });
      return true;
    }

    // --- 系统 ---
    if (method === 'POST' && path === '/api/system/restart') {
      ok(res, { message: '正在重启（由外部 supervisor 拉起）……' });
      // 先等响应 flush，再走优雅关闭（落盘会话后退出）
      setTimeout(() => {
        if (ctx.shutdown) ctx.shutdown();
        else process.exit(0);
      }, 200);
      return true;
    }

    fail(res, 404, `接口不存在：${method} ${path}`);
    return true;
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : String(e));
    return true;
  }
}
