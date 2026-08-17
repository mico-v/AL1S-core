import type { Plugin, SkillRegistry } from '../registry';
import type { ConfigGroupMeta } from '../../config/schema';
import { registerConfigFields } from '../../config/schema';

const builtinSettings: ConfigGroupMeta = {
  key: 'builtin',
  label: '内置功能',
  description: 'AL1S 格式化、帮助、上下文与人设命令',
  fields: [
    { key: 'al1sFormat.enabled', label: '启用 AL1S 格式化', type: 'boolean', group: 'builtin' },
    { key: 'al1sFormat.globalMarkdownKiller', label: '全局 Markdown 清理', type: 'boolean', group: 'builtin' },
    { key: 'al1sFormat.lineSplit', label: '按结构分段发送', type: 'boolean', group: 'builtin' },
    { key: 'al1sFormat.charsPerSecond', label: '分段字数/秒', type: 'number', group: 'builtin', min: 1 },
    { key: 'al1sFormat.minDelay', label: '单段最小延时(秒)', type: 'number', group: 'builtin', min: 0 },
    { key: 'al1sFormat.maxDelay', label: '单段最大延时(秒)', type: 'number', group: 'builtin', min: 0 },
  ],
};

registerConfigFields(builtinSettings);

export const builtinPlugin: Plugin = {
  name: 'builtin',
  displayName: '内置功能',
  description: 'AL1S 格式化、帮助、重置上下文和人设管理',
  settings: builtinSettings,
  register(registry: SkillRegistry): void {
    registry.registerCommand({ name: 'help', description: '显示帮助', async handler(ctx) {
      const lines = ['—— 可用命令 ——'];
      for (const c of registry.getEnabledCommands()) lines.push(`/${c.name}：${c.description}`);
      lines.push('', '—— 可用工具 ——');
      for (const s of registry.getEnabledSkills()) lines.push(`${s.name}：${s.description}`);
      await ctx.reply(lines.join('\n'));
    }});
    registry.registerCommand({ name: 'reset', description: '清空本群上下文', async handler(ctx) {
      ctx.sessions.clear(ctx.chatId);
      await ctx.reply('已清空本群/本会话上下文。');
    }});
    registry.registerCommand({ name: 'persona', description: '查看或修改人设，/persona 新的人设内容', async handler(ctx) {
      const session = ctx.sessions.get(ctx.chatId);
      const rest = ctx.rest.trim();
      if (!rest) await ctx.reply(`当前人设：${session.personaOverride ?? ctx.config.persona}`);
      else { session.setPersonaOverride(rest); await ctx.reply('已更新本会话人设。'); }
    }});
  },
};
