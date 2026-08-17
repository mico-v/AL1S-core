/**
 * XXT 学习通模仿娱乐插件：选人 / 防撤回 / 课堂提醒。
 * 注册 5 个斜杠命令 + 1 个消息钩子（缓存 + 课堂提醒）+ 1 个撤回通知钩子。
 */
import type { Plugin, SkillRegistry } from '../registry';
import type { ConfigGroupMeta } from '../../config/schema';
import { registerConfigFields } from '../../config/schema';
import { XxtPlugin } from './main';

/** 插件声明设置：XXT_* 环境变量配置项。模块顶层注册进字段索引（见 registerConfigFields 注释的时序不变量）。 */
const xxtSettings: ConfigGroupMeta = {
  key: 'xxt',
  label: 'XXT 课堂提醒',
  description: '上课时段与提醒参数',
  fields: [
    { key: 'env.XXT_CLASS_PERIODS', label: '上课时段', type: 'string', group: 'xxt', hint: '逗号分隔："08:30-10:00:课程名"', requiresRestart: true },
    { key: 'env.XXT_CLASS_WARNING_COOLDOWN_SECONDS', label: '发言提醒冷却(秒)', type: 'number', group: 'xxt', min: 0 },
    { key: 'env.XXT_CLASS_REPLY_TIMEOUT_SECONDS', label: '@ 未回复超时(秒)', type: 'number', group: 'xxt', min: 0 },
  ],
};
// 必须在 ConfigStore 构造前调用（bot.ts 静态 import 链保证）；幂等
registerConfigFields(xxtSettings);

export const xxtPlugin: Plugin = {
  name: 'xxt',
  displayName: 'XXT 课堂提醒',
  description: '学习通模仿娱乐插件（选人/防撤回/课堂提醒）',
  settings: xxtSettings,
  register(registry: SkillRegistry): void {
    const plugin = new XxtPlugin();
    plugin.setApi(registry.getApi());
    registry.registerPluginInstance('xxt', { dispose: () => plugin.dispose(), reloadFromConfig: () => plugin.reloadFromConfig() });

    // 后台：每条消息缓存 + 课堂提醒判定
    registry.addMessageHook((event) => plugin.messageHook(event));
    // 后台：撤回通知监听
    registry.addNoticeHook((event) => plugin.noticeHook(event));

    registry.registerCommand({
      name: '选人',
      description: '随机 @ 群成员，用法：/选人 人数',
      handler: (ctx) => plugin.cmdPick(ctx),
    });
    registry.registerCommand({
      name: '查撤回',
      description: '查询已记录的撤回消息（管理员），用法：/查撤回 [数量]',
      handler: (ctx) => plugin.cmdQueryRecall(ctx),
    });
    registry.registerCommand({
      name: '重放',
      description: '按编号重放撤回消息（管理员），用法：/重放 序号',
      handler: (ctx) => plugin.cmdReplay(ctx),
    });
    registry.registerCommand({
      name: '清空撤回',
      description: '清空当前群撤回记录（管理员）',
      handler: (ctx) => plugin.cmdClearRecall(ctx),
    });
    registry.registerCommand({
      name: '课堂提醒',
      description: '课堂提醒开关（管理员），用法：/课堂提醒 开|关|状态',
      handler: (ctx) => plugin.cmdClassReminder(ctx),
    });
  },
};
