/**
 * 插件注册冒烟脚本：新建 SkillRegistry，注册全部插件，
 * 断言命令与 skill 数量/名称，验证各插件可导入、可注册、无副作用。
 *
 * 用法：npm run plugins:check
 */
import { SkillRegistry } from '../skills/registry';
import { registerPlugins } from '../skills/plugins';

const registry = new SkillRegistry();
registerPlugins(registry);

const commands = registry.getAllPluginCommands();
const commandNames = commands.map((c) => c.name);

console.log('已注册命令：', commandNames.join('、'));

let failed = false;
const expect = (label: string, cond: boolean): void => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.error(`  ✗ ${label}`);
  }
};

expect('内置管理命令不进入普通命令表', !['help', 'reset', 'persona'].some((n) => commandNames.includes(n)));
expect('示例命令 roll_dice', commandNames.filter((name) => name === 'roll_dice').length === 1);
expect('XXT: 选人', commandNames.includes('选人'));
expect('XXT: 查撤回', commandNames.includes('查撤回'));
expect('XXT: 重放', commandNames.includes('重放'));
expect('XXT: 清空撤回', commandNames.includes('清空撤回'));
expect('XXT: 课堂提醒', commandNames.includes('课堂提醒'));
expect('CourseSchedule: 今日课表', commandNames.includes('今日课表'));
expect('CourseSchedule: 同步课表', commandNames.includes('同步课表'));
expect('CourseSchedule: query_course_schedule_sql', commandNames.includes('query_course_schedule_sql'));
expect('CourseSchedule: edit_local_course_schedule_sql', commandNames.includes('edit_local_course_schedule_sql'));

if (failed) {
  console.error('\nplugins:check 失败');
  process.exit(1);
}
console.log('\nplugins:check 通过');
process.exit(0);
