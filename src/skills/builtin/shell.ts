import { randomUUID } from 'node:crypto';
import type { OneBotMessageEvent } from '@snowluma/sdk';
import type { ConfigGroupMeta } from '../../config/schema';
import { registerConfigFields } from '../../config/schema';
import { logger } from '../../logging/logger';
import { normalizeMessage } from '../../pipeline/normalize';
import { auditShell, redactShellCommand } from '../../tools/audit';
import { evaluateShellRequest } from '../../tools/policy';
import { shellTasks, type ShellTaskFinished } from '../../tools/tasks';
import type { ShellRequest } from '../../tools/types';
import type { Plugin, SkillRegistry } from '../registry';

const log = logger.child('shell');

const shellSettings: ConfigGroupMeta = {
  key: 'shell',
  label: 'Shell 工具',
  description: '开发阶段本地命令执行与聊天命令配置；留空 allowlist 表示不限制',
  fields: [
    { key: 'shell.enabled', label: '启用 Shell', type: 'boolean', group: 'shell' },
    { key: 'shell.runtime', label: '运行时', type: 'string', group: 'shell', hint: '固定为 local' },
    { key: 'shell.cwd', label: '工作目录', type: 'string', group: 'shell' },
    { key: 'shell.triggerPrefix', label: '聊天触发词', type: 'string', group: 'shell', hint: '管理员消息以此开头执行命令，默认 $' },
    { key: 'shell.allowlist', label: '命令 allowlist', type: 'string-list', group: 'shell', hint: '留空表示不限制' },
    { key: 'shell.denylist', label: '命令 denylist', type: 'string-list', group: 'shell' },
    { key: 'shell.timeoutMs', label: '超时(毫秒)', type: 'number', group: 'shell', min: 1 },
    { key: 'shell.maxOutputBytes', label: '输出上限(字节)', type: 'number', group: 'shell', min: 1 },
    { key: 'shell.adminIds', label: 'Shell 管理员 QQ', type: 'number-list', group: 'shell' },
    { key: 'shell.scrubEnv', label: '清理敏感环境变量', type: 'boolean', group: 'shell' },
  ],
};
registerConfigFields(shellSettings);

function audit(record: Parameters<typeof auditShell>[0]): void {
  auditShell(record);
  log.info('shell 任务事件', { ...record, command: redactShellCommand(record.command) });
}

function messageText(event: OneBotMessageEvent): string {
  return normalizeMessage(event).text.trim();
}

function formatResult(finished: ShellTaskFinished): string {
  const taskId = finished.task.taskId;
  if (finished.error) return `[shell ${taskId}] 执行失败：${finished.error instanceof Error ? finished.error.message : String(finished.error)}`;
  if (!finished.decision.allowed) return `[shell ${taskId}] 执行失败：${finished.decision.reason ?? '策略拒绝'}`;
  const result = finished.result;
  if (!result) return `[shell ${taskId}] 执行失败：执行器未返回结果`;
  const output = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n');
  const status = result.ok ? '完成' : result.error ?? `退出码 ${result.exitCode ?? '未知'}`;
  return `[shell ${taskId}] ${status}${output ? `\n${output}` : ''}`;
}

export const shellPlugin: Plugin = {
  name: 'shell',
  displayName: 'Shell',
  description: '管理员聊天命令 Shell 执行（固定 cwd、超时、进程组终止与输出上限）',
  settings: shellSettings,
  register(registry: SkillRegistry): void {
    registry.addMessageHook(async (event, ctx) => {
      const shellConfig = registry.getConfig()?.shell;
      if (!shellConfig) return;
      const text = messageText(event);
      const triggerPrefix = shellConfig.triggerPrefix.trim();
      if (!shellConfig.enabled || triggerPrefix.length === 0 || !text.startsWith(triggerPrefix)) return;
      const rawSenderId = typeof event.user_id === 'number' ? event.user_id : Number(event.user_id);
      const normalizedSenderId = Number.isFinite(rawSenderId) ? rawSenderId : undefined;
      const groupValue = typeof event.group_id === 'number' ? event.group_id : Number(event.group_id);
      const groupId = Number.isFinite(groupValue) ? groupValue : undefined;
      const chatId = groupId !== undefined ? `g:${groupId}` : `p:${normalizedSenderId ?? ''}`;
      const body = text.slice(triggerPrefix.length).trim();
      if (normalizedSenderId === undefined || !shellConfig.adminIds.includes(normalizedSenderId)) {
        log.warn('shell 非管理员触发已拒绝', { chatId, senderId: normalizedSenderId, command: redactShellCommand(body) });
        return;
      }
      const senderId = normalizedSenderId;
      if (body === 'stop' || body.startsWith('stop ')) {
        const target = body.slice(4).trim();
        const stopped = shellTasks.stopMatching(chatId, target === '' || target === 'all' ? undefined : target, senderId, shellConfig.adminIds);
        audit({ event: 'stopped', requestId: randomUUID(), actorId: senderId, chatId, groupId, command: body, runtime: shellConfig.runtime, cwd: shellConfig.cwd, reason: stopped.length > 0 ? `停止 ${stopped.length} 个任务` : '没有可停止任务' });
        await ctx.reply(stopped.length > 0 ? `已停止：${stopped.map((task) => task.taskId).join(', ')}` : '没有找到可停止的 shell 任务');
        return;
      }
      if (!body) { await ctx.reply(`用法：${triggerPrefix}<命令>，${triggerPrefix}stop [all|taskId]`); return; }
      const request: ShellRequest = { command: body, runtime: 'local' };
      const decision = evaluateShellRequest(request, shellConfig, senderId);
      if (!decision.allowed) {
        audit({ event: 'rejected', requestId: randomUUID(), actorId: senderId, chatId, groupId, command: body, runtime: shellConfig.runtime, cwd: shellConfig.cwd, reason: decision.reason });
        await ctx.reply(`shell 执行失败：${decision.reason ?? '策略拒绝'}`);
        return;
      }
      const task = shellTasks.start(request, { senderId, chatId, groupId }, shellConfig, async (finished) => {
        const result = finished.result;
        const eventName = result?.error === '命令执行已取消'
          ? 'stopped'
          : finished.error || !finished.decision.allowed || (result && !result.ok) ? 'failed' : 'completed';
        audit({ event: eventName, requestId: finished.requestId, taskId: task.taskId, actorId: senderId, chatId, groupId, command: body, runtime: shellConfig.runtime, cwd: shellConfig.cwd, durationMs: result?.durationMs, exitCode: result?.exitCode, signal: result?.signal, ok: result?.ok, stdoutBytes: result ? Buffer.byteLength(result.stdout) : undefined, stderrBytes: result ? Buffer.byteLength(result.stderr) : undefined, reason: result?.error ?? (finished.error instanceof Error ? finished.error.message : finished.error ? String(finished.error) : undefined) });
        await ctx.reply(formatResult(finished));
      });
      audit({ event: 'started', requestId: task.taskId, taskId: task.taskId, actorId: senderId, chatId, groupId, command: body, runtime: shellConfig.runtime, cwd: shellConfig.cwd });
      await ctx.reply(`已启动 shell 任务 ${task.taskId}`);
    });

    registry.registerSkill({
      name: 'shell_exec',
      description: '仅管理员可调用的本地 Shell 命令，执行结果返回给当前会话。',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, runtime: { type: 'string', default: 'local' }, timeoutMs: { type: 'integer' } }, required: ['command'] },
      async run(args, context): Promise<string> {
        const shellConfig = registry.getConfig()?.shell;
        if (!shellConfig) return '工具执行失败：shell 配置不可用';
        const request = args as unknown as ShellRequest;
        const command = typeof request.command === 'string' ? request.command : '';
        const requestId = randomUUID();
        const base = { requestId, actorId: context.senderId, chatId: context.chatId, command, runtime: request.runtime ?? shellConfig.runtime, cwd: shellConfig.cwd } as const;
        audit({ event: 'started', ...base });
        try {
          const execution = await import('../../tools/executor').then(({ executeShell }) => executeShell({ ...request, command }, shellConfig, context.senderId, context.signal));
          if (!execution.decision.allowed) {
            audit({ event: 'rejected', ...base, requestId: execution.requestId, reason: execution.decision.reason });
            return `工具执行失败：${execution.decision.reason ?? '策略拒绝'}`;
          }
          if (!execution.result) {
            audit({ event: 'failed', ...base, requestId: execution.requestId, reason: '执行器未返回结果' });
            return '工具执行失败：执行器未返回结果';
          }
          audit({ event: execution.result.ok ? 'completed' : execution.result.error === '命令执行已取消' ? 'stopped' : 'failed', ...base, requestId: execution.requestId, durationMs: execution.result.durationMs, exitCode: execution.result.exitCode, signal: execution.result.signal, ok: execution.result.ok, stdoutBytes: Buffer.byteLength(execution.result.stdout), stderrBytes: Buffer.byteLength(execution.result.stderr), reason: execution.result.error });
          return JSON.stringify(execution.result);
        } catch (error) {
          audit({ event: 'failed', ...base, reason: error instanceof Error ? error.message : String(error) });
          return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  },
};
