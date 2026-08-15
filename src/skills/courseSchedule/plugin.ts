/**
 * 课程表插件：注册 /今日课表、/同步课表 命令 + 两个 SQL 工具。
 */
import type { Plugin, SkillRegistry } from '../registry';
import { CourseSchedulePlugin } from './main';
import { ScheduleStore } from './store';

export const courseSchedulePlugin: Plugin = {
  name: 'course-schedule',
  description: '课程表插件（今日课表/同步课表 + SQL 查询与修改）',
  register(registry: SkillRegistry): void {
    const plugin = new CourseSchedulePlugin(new ScheduleStore(process.env.COURSE_DATA_FILE || './data/course-schedule.json'));
    plugin.setApi(registry.getApi());

    registry.registerCommand({
      name: '今日课表',
      description: '生成当前会话今日课程表图片',
      handler: (ctx) => plugin.cmdToday(ctx),
    });
    registry.registerCommand({
      name: '同步课表',
      description: '按时间戳双向同步当前群 .ics 课程表文件',
      handler: (ctx) => plugin.cmdSync(ctx),
    });

    registry.registerSkill({
      name: 'query_course_schedule_sql',
      description:
        '用类似 SQL 的只读查询检索当前会话课程表（members/courses 表），适合复杂查询、多人查询和统计。时间字段为 Asia/Shanghai 本地时间文本。',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: '只读 SELECT 语句，不要包含分号；可按 user_id、name、date、weekday、course、location、status 等过滤/聚合/排序' },
          time_range: { type: 'string', default: 'today', description: '展开事件的时间范围：today、tomorrow、昨天、本周、下周、本月、YYYY-MM-DD 或区间' },
        },
        required: ['sql'],
      },
      run: async (args, ctx) =>
        plugin.skillQuerySql(ctx.chatId, String(args['sql'] ?? ''), String(args['time_range'] ?? 'today')),
    });

    registry.registerSkill({
      name: 'edit_local_course_schedule_sql',
      description:
        '用 SQL 修改本地保存的结构化课程表（local_courses 表），自动重建本地 .ics 与时间戳；不会同步或上传群文件。仅支持一条 UPDATE/INSERT/DELETE。',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: '修改 local_courses 的 SQL：UPDATE/INSERT/DELETE 一条，不要包含分号；改/删已有课程须用 WHERE id=...' },
          query: { type: 'string', default: '', description: '成员 QQ 号或昵称关键字，留空表示发起人自己的课程表' },
        },
        required: ['sql'],
      },
      run: async (args, ctx) =>
        plugin.skillEditSql(ctx.chatId, ctx.senderId, String(args['sql'] ?? ''), String(args['query'] ?? '')),
    });
  },
};
