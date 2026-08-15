/**
 * 内置插件：/reset 清空当前群/会话上下文。
 */
import type { Plugin, SkillRegistry } from '../registry';

export const resetPlugin: Plugin = {
  name: 'reset',
  description: '清空上下文',
  register(registry: SkillRegistry): void {
    registry.registerCommand({
      name: 'reset',
      description: '清空本群上下文',
      async handler(ctx) {
        ctx.sessions.clear(ctx.chatId);
        await ctx.reply('已清空本群/本会话上下文。');
      },
    });
  },
};
