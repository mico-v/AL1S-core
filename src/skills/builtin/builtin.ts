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

/**
 * 内置插件只负责声明设置与插件元数据。
 * /help、/reset、/persona 属于宿主管理命令，由 AdminCommandDispatcher 直接处理，
 * 不进入普通插件命令注册表或 CLI 执行管道。
 */
export const builtinPlugin: Plugin = {
  name: 'builtin',
  displayName: '内置功能',
  description: 'AL1S 格式化、帮助、重置上下文和人设管理',
  settings: builtinSettings,
  register(_registry: SkillRegistry): void {
    // 管理命令由宿主 pipeline/admin dispatcher 处理。
  },
};
