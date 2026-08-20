import { randomUUID } from 'node:crypto';
import type { OneBotMessageEvent } from '@snowluma/sdk';
import type { ConfigGroupMeta } from '../../config/schema';
import { registerConfigFields } from '../../config/schema';
import { logger } from '../../logging/logger';
import { logReject, sendLogged } from '../../logging/send-log';
import { normalizeMessage } from '../../pipeline/normalize';
import { auditShell, redactShellCommand } from '../../tools/audit';
import { evaluateShellRequest } from '../../tools/policy';
import { shellTasks, type ShellTaskFinished } from '../../tools/tasks';
import type { ShellRequest } from '../../tools/types';
import type { Plugin, SkillRegistry } from '../registry';
import type { MspRuntime } from '../../msp/protocol/types';
import { commandInput } from './shell-command-input';
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
  if (finished.error) return `执行失败：${finished.error instanceof Error ? finished.error.message : String(finished.error)}`;
  if (!finished.decision.allowed) return `执行失败：${finished.decision.reason ?? '策略拒绝'}`;
  const result = finished.result;
  if (!result) return '执行失败：执行器未返回结果';
  const output = result.displayText ?? [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n');
  const status = result.ok ? '完成' : result.error ?? `退出码 ${result.exitCode ?? '未知'}`;
  return `${status}${output ? `\n${output}` : ''}`;
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
      if (!shellConfig || triggerPrefix.length === 0 || !text.startsWith(triggerPrefix)) return;
      if (!shellConfig.enabled) return;
      const rawSenderId = typeof event.user_id === 'number' ? event.user_id : Number(event.user_id);
      const normalizedSenderId = Number.isFinite(rawSenderId) ? rawSenderId : undefined;
      const groupValue = typeof event.group_id === 'number' ? event.group_id : Number(event.group_id);
      const groupId = Number.isFinite(groupValue) ? groupValue : undefined;
      const chatId = groupId !== undefined ? `g:${groupId}` : `p:${normalizedSenderId ?? ''}`;
      const body = text.slice(triggerPrefix.length).trim();
      const context = {
        chatId,
        groupId,
        senderId: normalizedSenderId,
        senderName: event.sender?.nickname,
        source: 'chat' as const,
      };
      const sessionRunner = registry.getSessionCommandRunner();
      if (sessionRunner) {
        if (normalizedSenderId === undefined || !shellConfig.adminIds.includes(normalizedSenderId)) {
          logReject({ module: 'src/skills/builtin/shell.ts', command: body, chatId, groupId, senderId: normalizedSenderId, reason: 'Shell 管理员列表拒绝' });
          return { handled: true };
        }
        const result = await sessionRunner.run(body, context);
        if (result.stdout || result.stderr) {
          const output = result.stderr ? `${result.stdout}${result.stdout ? '\n' : ''}stderr:\n${result.stderr}` : result.stdout;
          await sendLogged((out) => ctx.reply(out as never), { module: 'src/skills/builtin/shell.ts', command: body, chatId, groupId, senderId: normalizedSenderId, messageType: 'text' }, output);
        }
        return { handled: true };
      }
      log.warn('shell 执行器未配置，拒绝执行', { module: 'src/skills/builtin/shell.ts', command: body, chatId, groupId, senderId: normalizedSenderId, reason: 'SessionCommandRunner 未配置' });
      const message = '工具执行失败：SessionCommandRunner 未配置，已停止后续处理';
      await sendLogged((out) => ctx.reply(out as never), { module: 'src/skills/builtin/shell.ts', command: body, chatId, groupId, senderId: normalizedSenderId, messageType: 'text' }, message);
      return { handled: true };
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
        const runner = registry.getSessionCommandRunner();
        if (!runner) return '工具执行失败：SessionCommandRunner 未配置';
        const result = await runner.run(command, { chatId: context.chatId, senderId: context.senderId, senderName: context.senderName, source: 'agent' });
        audit({ event: result.exitCode === 0 ? 'completed' : 'failed', ...base, durationMs: result.internal.durationMs, exitCode: result.exitCode ?? undefined, ok: result.exitCode === 0, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), reason: result.exitCode === 0 ? undefined : result.stderr });
        return [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n') || `退出码 ${result.exitCode ?? '未知'}`;
        } catch (error) {
          audit({ event: 'failed', ...base, reason: error instanceof Error ? error.message : String(error) });
          return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  },
};
