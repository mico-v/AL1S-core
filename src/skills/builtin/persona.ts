/**
 * 内置插件：/persona 查看或修改当前会话人设。
 * 用法：/persona            查看当前人设
 *      /persona 新的人设内容 覆盖本会话人设
 */
import type { Plugin, SkillRegistry } from '../registry';

export const personaPlugin: Plugin = {
  name: 'persona',
  description: '人设',
  register(registry: SkillRegistry): void {
    registry.registerCommand({
      name: 'persona',
      description: '查看或修改人设，/persona 新的人设内容',
      async handler(ctx) {
        const session = ctx.sessions.get(ctx.chatId);
        const rest = ctx.rest.trim();
        if (rest === '') {
          const persona = session.personaOverride ?? ctx.config.persona;
          await ctx.reply(`当前人设：${persona}`);
        } else {
          session.setPersonaOverride(rest);
          await ctx.reply('已更新本会话人设。');
        }
      },
    });
  },
};
