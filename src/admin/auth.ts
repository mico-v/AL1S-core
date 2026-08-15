/**
 * 管理后台鉴权：`ADMIN_TOKEN` 环境变量。未配置则不开管理服务。
 * 所有 /api/* 请求需 `Authorization: Bearer <ADMIN_TOKEN>`。
 */
import type { IncomingMessage } from 'node:http';

/** 管理 token（未配置返回 undefined → 管理服务不启动） */
export function adminToken(): string | undefined {
  const raw = process.env.ADMIN_TOKEN;
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
}

/** 校验请求是否携带合法 Bearer token */
export function isAuthorized(req: IncomingMessage): boolean {
  const token = adminToken();
  if (!token) return false;
  const header = req.headers['authorization'];
  return typeof header === 'string' && header === `Bearer ${token}`;
}
