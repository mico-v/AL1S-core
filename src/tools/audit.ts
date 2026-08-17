import { logger } from '../logging/logger';
import type { ShellAuditRecord } from './types';

const log = logger.child('shell-audit');

/** 审计命令中的常见凭据参数，避免把 token/password 原文写入日志。 */
export function redactShellCommand(command: string): string {
  let safe = command.replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  // 覆盖 URL 查询参数、KEY=value（含引号）和 --key value 三种常见凭据写法。
  safe = safe.replace(/([?&](?:api[_-]?key|token|password|passwd|secret|credential)=)[^&#\s]+/gi, '$1[REDACTED]');
  safe = safe.replace(/\b(api[_-]?key|token|password|passwd|secret|credential)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1=[REDACTED]');
  safe = safe.replace(/(--?(?:api[-_]?key|token|password|passwd|secret|credential))(?:\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1 [REDACTED]');
  return safe;
}

/** 结构化审计：不记录环境变量及完整输出，命令中的常见凭据会脱敏。 */
export function auditShell(record: ShellAuditRecord): void {
  log.info('shell 执行审计', { ...record, command: redactShellCommand(record.command) });
}
