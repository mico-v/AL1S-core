/**
 * 内置插件：/reset 清空当前群/会话上下文。
 */
import type { Plugin, SkillRegistry } from '../registry';

export const resetPlugin: Plugin = {
  name: 'reset',
  displayName: '重置上下文',
  description: '重置上下文（已由宿主管理命令处理）',
  register(_registry: SkillRegistry): void {
    // 兼容保留模块；正式注册由 builtinPlugin 元数据完成。
  },
};
