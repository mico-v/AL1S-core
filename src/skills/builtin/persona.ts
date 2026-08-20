/**
 * 内置插件：/persona 查看或修改当前会话人设。
 * 用法：/persona            查看当前人设
 *      /persona 新的人设内容 覆盖本会话人设
 */
import type { Plugin, SkillRegistry } from '../registry';

export const personaPlugin: Plugin = {
  name: 'persona',
  displayName: '人设',
  description: '人设（已由宿主管理命令处理）',
  register(_registry: SkillRegistry): void {
    // 兼容保留模块；正式注册由 builtinPlugin 元数据完成。
  },
};
