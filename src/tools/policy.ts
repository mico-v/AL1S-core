import { isAbsolute, resolve } from 'node:path';
import type { BotConfig } from '../config';
import type { ShellDecision, ShellPolicy, ShellRequest } from './types';

/** 解析命令用于 allowlist/denylist；不按提示词猜测或拦截命令内容。 */
export function tokenizeCommand(command: string): string[] | undefined {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { out.push(current); current = ''; } continue; }
    current += char;
  }
  if (escaped || quote !== undefined) return undefined;
  if (current) out.push(current);
  return out.length > 0 ? out : undefined;
}

function basename(command: string): string {
  const normalized = command.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function containsDeniedToken(argv: string[], policy: ShellPolicy): string | undefined {
  for (const arg of argv) {
    const name = basename(arg);
    if (policy.denylist.some((entry) => entry.toLowerCase() === name || entry === arg)) return name;
  }
  return undefined;
}

export function evaluateShellRequest(request: ShellRequest, policy: ShellPolicy, actorId?: number): ShellDecision {
  if (!policy.enabled) return { allowed: false, reason: 'shell 工具未启用' };
  if (policy.runtime !== 'local') return { allowed: false, reason: '当前仅支持 local runtime' };
  if (request.runtime !== undefined && request.runtime !== 'local') return { allowed: false, reason: '当前仅支持 local runtime' };
  if (actorId === undefined || policy.adminIds.length === 0 || !policy.adminIds.includes(actorId)) {
    return { allowed: false, reason: '仅管理员可使用 shell 工具' };
  }
  if (typeof request.command !== 'string' || request.command.trim().length === 0 || request.command.length > 2000) {
    return { allowed: false, reason: '命令为空或过长' };
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    return { allowed: false, reason: 'timeout 必须是正数' };
  }
  const argv = tokenizeCommand(request.command);
  if (!argv) return { allowed: false, reason: '命令解析失败' };
  const executable = basename(argv[0] ?? '');
  const denied = containsDeniedToken(argv, policy);
  if (denied) return { allowed: false, reason: `命令命中 denylist：${denied}` };
  if (policy.allowlist.length > 0 && !policy.allowlist.some((entry) => entry.toLowerCase() === executable)) {
    return { allowed: false, reason: `命令不在 allowlist：${executable}` };
  }
  if (!isAbsolute(policy.cwd)) return { allowed: false, reason: 'cwd 必须是绝对路径' };
  return { allowed: true, executable: request.command.trim(), args: [] };
}

export function shellPolicyFromConfig(config: BotConfig): ShellPolicy { return config.shell; }
export function resolveFixedCwd(policy: ShellPolicy): string { return resolve(policy.cwd); }
