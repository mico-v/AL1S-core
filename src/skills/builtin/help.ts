/**
 * 内置插件：/help 显示可用命令与工具帮助。
 */
import type { Plugin, SkillRegistry } from '../registry';

export const helpPlugin: Plugin = {
  name: 'help',
  description: '帮助',
  register(registry: SkillRegistry): void {
    registry.registerCommand({
      name: 'help',
      description: '显示帮助',
      async handler(ctx) {
        const lines: string[] = [];
        lines.push('—— 可用命令 ——');
        for (const c of registry.getCommands()) {
          lines.push(`/${c.name}：${c.description}`);
        }
        lines.push('');
        lines.push('—— 可用工具 ——');
        for (const s of registry.getSkills()) {
          lines.push(`${s.name}：${s.description}`);
        }
        await ctx.reply(lines.join('\n'));
      },
    });
  },
};
