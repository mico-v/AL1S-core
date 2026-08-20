/**
 * 内置插件：/help 显示可用命令与工具帮助。
 */
import type { Plugin, SkillRegistry } from '../registry';

export const helpPlugin: Plugin = {
  name: 'help',
  displayName: '帮助',
  description: '帮助（已由宿主管理命令处理）',
  register(_registry: SkillRegistry): void {
    // 兼容保留模块；正式注册由 builtinPlugin 元数据完成。
  },
};
