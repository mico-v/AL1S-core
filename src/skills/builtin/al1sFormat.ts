import type { Plugin, SkillRegistry } from '../registry';
import type { ConfigGroupMeta } from '../../config/schema';
import { registerConfigFields } from '../../config/schema';

const settings: ConfigGroupMeta = {
  key: 'al1sFormat',
  label: 'AL1S 格式化',
  description: 'LLM 回复清理、结构分段与发送节奏',
  fields: [
    { key: 'al1sFormat.enabled', label: '启用格式化', type: 'boolean', group: 'al1sFormat' },
    { key: 'al1sFormat.globalMarkdownKiller', label: '全局 Markdown 清理', type: 'boolean', group: 'al1sFormat' },
    { key: 'al1sFormat.lineSplit', label: '按结构分段发送', type: 'boolean', group: 'al1sFormat' },
    { key: 'al1sFormat.charsPerSecond', label: '分段字数/秒', type: 'number', group: 'al1sFormat', min: 1 },
    { key: 'al1sFormat.minDelay', label: '单段最小延时(秒)', type: 'number', group: 'al1sFormat', min: 0 },
    { key: 'al1sFormat.maxDelay', label: '单段最大延时(秒)', type: 'number', group: 'al1sFormat', min: 0 },
  ],
};

registerConfigFields(settings);

export const al1sFormatPlugin: Plugin = {
  name: 'al1s-format',
  displayName: 'AL1S 格式化',
  description: 'LLM 输出 Markdown 清理、结构分段与发送节奏控制',
  settings,
  register(_registry: SkillRegistry): void {
    // 功能由 Pipeline + Al1sFormatter 提供，插件目录负责统一管理配置。
  },
};
