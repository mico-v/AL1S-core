import type { CliPluginManifest } from '../msp/plugin-cli-types';

export const cliPluginManifests: CliPluginManifest[] = [
  {
    name: 'dice',
    version: '0.2.0',
    displayName: '骰子',
    description: '掷骰子命令',
    entrypoint: 'internal:plugin-command',
    enabled: true,
    execution: 'runtime',
    commands: [{ name: 'roll_dice', summary: '掷骰子，可指定面数与次数，返回点数列表', aliases: ['dice'], risk: 'low', permission: 'public', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: { sides: { type: 'integer', default: 6, minimum: 2 }, times: { type: 'integer', default: 1, minimum: 1, maximum: 10 } } } }],
  },
  {
    name: 'xxt',
    version: '0.2.0',
    displayName: 'XXT 课堂提醒',
    description: '选人、防撤回和课堂提醒 CLI 命令',
    entrypoint: 'internal:plugin-command',
    enabled: true,
    execution: 'runtime',
    commands: [
      { name: '选人', summary: '随机选择群成员；CLI 输出选中的 QQ 号', risk: 'medium', permission: 'admin', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, default: 1 }, members: { type: 'string' } } } },
      { name: '查撤回', summary: '查询当前运行实例记录的撤回消息', risk: 'medium', permission: 'admin', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, default: 5 } } } },
      { name: '重放', summary: '重放当前运行实例记录的撤回消息', risk: 'high', permission: 'admin', supportsChat: true, supportsAgent: false, inputSchema: { type: 'object', properties: { index: { type: 'integer', minimum: 1 } }, required: ['index'] } },
      { name: '清空撤回', summary: '清空当前群撤回记录', risk: 'high', permission: 'admin', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: {} } },
      { name: '课堂提醒', summary: '切换或查看课堂提醒状态', risk: 'medium', permission: 'admin', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['on', 'off', 'status'], default: 'status' } } } },
    ],
  },
  {
    name: 'course-schedule',
    version: '0.2.0',
    displayName: '课程表',
    description: '课程查询、修改和同步 CLI 命令',
    entrypoint: 'internal:plugin-command',
    enabled: true,
    execution: 'runtime',
    commands: [
      { name: '今日课表', summary: '输出当前会话今日课程表文本摘要', risk: 'low', permission: 'public', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: {} } },
      { name: '同步课表', summary: '同步当前群课程表文件；需要宿主 OneBot capability', risk: 'medium', permission: 'admin', supportsChat: true, supportsAgent: false, inputSchema: { type: 'object', properties: {} } },
      { name: 'query_course_schedule_sql', summary: '只读查询课程表 SQL', risk: 'low', permission: 'public', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: { sql: { type: 'string' }, time_range: { type: 'string', default: 'today' } }, required: ['sql'] } },
      { name: 'edit_local_course_schedule_sql', summary: '修改本地课程表 SQL', risk: 'medium', permission: 'owner', supportsChat: true, supportsAgent: true, inputSchema: { type: 'object', properties: { sql: { type: 'string' }, query: { type: 'string', default: '' } }, required: ['sql'] } },
    ],
  },
];

export function getCliManifest(plugin: string): CliPluginManifest | undefined {
  return cliPluginManifests.find((manifest) => manifest.name === plugin);
}

export function registerBuiltinCliPlugins(registry: { register(manifest: CliPluginManifest, command: string, handler: never, aliases?: string[]): void }): void {
  // CLI manifest 由宿主统一注册；具体 command handler 在 src/cli/entry.ts 中按 manifest 执行。
  for (const manifest of cliPluginManifests) {
    for (const command of manifest.commands) {
      registry.register(manifest, command.name, (() => ({ ok: false, stdout: '', stderr: 'CLI entry 由统一 bootstrap 执行', actions: [] })) as never, command.aliases ?? []);
    }
  }
}
