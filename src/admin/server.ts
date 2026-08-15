/**
 * 管理后台 HTTP 服务：Node 内置 http，零依赖。
 * 同一端口提供：前端静态资源（frontend/dist）+ /api REST + /api/logs/stream SSE。
 * 默认只监听 127.0.0.1；未配置 ADMIN_TOKEN 则不启动。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { logger } from '../logging/logger';
import { adminToken } from './auth';
import { handleApiRequest, type AdminContext } from './router';

const log = logger.child('admin');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export class AdminServer {
  private readonly context: AdminContext;
  private readonly port: number;
  private readonly host: string;
  private readonly staticDir: string;
  private httpServer?: Server;

  constructor(context: AdminContext, port: number, host = '127.0.0.1', staticDir = './frontend/dist') {
    this.context = context;
    this.port = port;
    this.host = host;
    this.staticDir = staticDir;
  }

  /** 实际绑定的端口（port=0 随机分配时用） */
  get boundPort(): number {
    const addr = this.httpServer?.address();
    return addr !== null && typeof addr === 'object' ? addr.port : this.port;
  }

  /** 启动监听；未配置 ADMIN_TOKEN 则不启动。返回 Promise 便于测试等待就绪。 */
  start(): Promise<void> {
    if (!adminToken()) {
      log.warn('未配置 ADMIN_TOKEN，管理后台不启动');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const server = createServer((req, res) => void this.handle(req, res));
      this.httpServer = server;
      server.once('error', (err) => {
        log.error('管理服务启动失败', { err: err.message });
        resolve();
      });
      server.listen(this.port, this.host, () => {
        log.info('管理后台已启动', { url: `http://${this.host}:${this.boundPort}` });
        resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 畸形 Host/URL 不能导致进程崩溃（unhandled rejection → Node 崩进程）
    let url: URL;
    try {
      const host = req.headers['host'] ?? 'localhost';
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      url = new URL('/', 'http://localhost');
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(this.context, req, res, url);
        return;
      }
      this.serveStatic(url.pathname, res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** hash 路由：非 /api 全部走静态；找不到回退 index.html */
  private serveStatic(pathname: string, res: ServerResponse): void {
    const root = normalize(this.staticDir);
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(root, rel));
    // 路径边界检查：拒绝同前缀兄弟目录（如 dist-evil），也拒绝 .. 逃逸
    const inRoot = file === root || file.startsWith(root + sep);
    if (!inRoot || !existsSync(file) || !statSync(file).isFile()) {
      this.fallbackIndex(res);
      return;
    }
    const ext = extname(file).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(readFileSync(file));
  }

  private fallbackIndex(res: ServerResponse): void {
    const index = join(this.staticDir, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(readFileSync(index));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('管理前端未构建（frontend/dist 缺失）。请先在 frontend/ 目录运行 npm run build。');
  }
}
