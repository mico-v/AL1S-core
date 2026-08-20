import type { Skill } from '../skills/registry';
import type { MspPluginCliExecutor } from './plugin-cli-executor';
import type { CliPluginManifest } from './plugin-cli-types';

export interface MspCliSkillSpec {
  manifest: CliPluginManifest;
  command: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 将一个插件 CLI 暴露成模型工具；执行始终经过 MSP runtime。 */
export function createMspCliSkill(spec: MspCliSkillSpec, executor: MspPluginCliExecutor, workspace = '/'): Skill {
  return {
    name: spec.command,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async run(args, context): Promise<string> {
      const cliArgs: string[] = [];
      for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null || value === false) continue;
        if (value === true) cliArgs.push(`--${key}`);
        else cliArgs.push(`--${key}`, String(value));
      }
      const result = await executor.run(spec.manifest, spec.command, cliArgs, {
        chatId: context.chatId,
        groupId: context.groupId,
        senderId: context.senderId,
        senderName: context.senderName,
        workspace,
      });
      return [result.stdout, result.stderr].filter(Boolean).join('\n') || `命令退出码：${result.exitCode}`;
    },
  };
}
