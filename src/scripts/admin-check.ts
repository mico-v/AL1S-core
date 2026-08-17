/**
 * 管理后台离线自检：不连 SnowLuma，起 AdminServer（随机端口），
 * 验证：鉴权、status/config/schema/plugins 接口、config 热更新、插件启停。
 * 用到的持久化文件均为 data/.admin-check-*（临时，不污染真实配置）。
 *
 * 用法：npm run admin:check
 */
import { ConfigStore } from '../config/store';
import { SkillRegistry } from '../skills/registry';
import { registerPlugins } from '../skills/plugins';
import { PluginControl } from '../plugins/control';
import { SessionManager } from '../session/manager';
import { SessionPersistence } from '../session/persistence';
import { AdminServer } from '../admin/server';
import type { AdminContext } from '../admin/router';

process.env.ADMIN_TOKEN = 'admin-check-token';
process.env.ADMIN_SETTINGS_FILE = './data/.admin-check-settings.json';
const TOGGLE_FILE = './data/.admin-check-toggles.json';
const SESSION_DIR = './data/.admin-check-sessions';

let failed = false;
const assert = (label: string, cond: boolean): void => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.error(`  ✗ ${label}`);
  }
};

const configStore = new ConfigStore();
const registry = new SkillRegistry();
registerPlugins(registry);
const pluginControl = new PluginControl(registry, TOGGLE_FILE);
pluginControl.attach();
const sessions = new SessionManager({ tokenBudget: 3000, maxSessions: 50 });
const persistence = new SessionPersistence(sessions, SESSION_DIR);
persistence.attach();

const adminCtx: AdminContext = {
  configStore,
  registry,
  pluginControl,
  sessions,
  persistence,
  isConnected: () => false,
  getLogin: async () => undefined,
  getBotNickname: () => 'check-bot',
  startedAt: Date.now(),
  version: '0.0.0',
};

const server = new AdminServer(adminCtx, 0, '127.0.0.1');
await server.start();
const base = `http://127.0.0.1:${server.boundPort}`;
const auth = { Authorization: 'Bearer admin-check-token' };
const jsonHeaders = { ...auth, 'Content-Type': 'application/json' };

console.log('== 鉴权 ==');
const noAuth = await fetch(`${base}/api/status`);
assert('无 token → 401', noAuth.status === 401);

console.log('== status ==');
const status = (await (await fetch(`${base}/api/status`, { headers: auth })).json()) as any;
assert('status ok', status.ok === true);
assert('uptimeSeconds 为数字', typeof status.data.uptimeSeconds === 'number');
assert('metrics 含计数', typeof status.data.metrics?.messagesReceived === 'number');

console.log('== config ==');
const schema = (await (await fetch(`${base}/api/config/schema`, { headers: auth })).json()) as any;
assert('schema 分组 >= 3', schema.ok && Array.isArray(schema.data.groups) && schema.data.groups.length >= 3);
assert('全局 schema 不含插件分组(course)', !schema.data.groups.some((g: any) => g.key === 'course'));
assert('全局 schema 不含插件分组(xxt)', !schema.data.groups.some((g: any) => g.key === 'xxt'));

const cfg0 = (await (await fetch(`${base}/api/config`, { headers: auth })).json()) as any;
assert('persona 可读取', typeof cfg0.data.values['persona'] === 'string');

const put = (await (
  await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ values: { persona: '测试人设-已热更新', replyCooldownSeconds: 7 } }),
  })
).json()) as any;
assert('config PUT ok', put.ok === true);
assert('persona 标记 applied', put.data.applied.includes('persona'));
assert('cooldown 标记 applied', put.data.applied.includes('replyCooldownSeconds'));

const cfg1 = (await (await fetch(`${base}/api/config`, { headers: auth })).json()) as any;
assert('persona 热生效', cfg1.data.values['persona'] === '测试人设-已热更新');
assert('cooldown 热生效', cfg1.data.values['replyCooldownSeconds'] === 7);

const putRestart = (await (
  await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ values: { 'llm.apiKey': 'sk-test' } }),
  })
).json()) as any;
assert('llm.apiKey 标记 pendingRestart', putRestart.ok && putRestart.data.pendingRestart.includes('llm.apiKey'));
assert('restartRequired 标志置位', configStore.restartRequired === true);

console.log('== plugins ==');
const plugins = (await (await fetch(`${base}/api/plugins`, { headers: auth })).json()) as any;
assert('插件列表含「xxt」', plugins.ok && plugins.data.plugins.some((p: any) => p.name === 'xxt'));
assert('xxt 声明了设置(hasSettings)', plugins.data.plugins.find((p: any) => p.name === 'xxt').hasSettings === true);
assert('xxt 含命令「选人」', plugins.data.plugins.find((p: any) => p.name === 'xxt').commands.some((c: any) => c.name === '选人'));
const toggle = (await (
  await fetch(`${base}/api/plugins/enabled`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ kind: 'command', name: '选人', enabled: false }),
  })
).json()) as any;
assert('命令启停 ok', toggle.ok === true);
assert('registry 中「选人」已禁用', registry.isCommandEnabled('选人') === false);
const plugins2 = (await (await fetch(`${base}/api/plugins`, { headers: auth })).json()) as any;
assert('列表反映禁用', plugins2.data.plugins.find((p: any) => p.name === 'xxt').commands.find((c: any) => c.name === '选人').enabled === false);
// 恢复
await fetch(`${base}/api/plugins/enabled`, {
  method: 'PUT',
  headers: jsonHeaders,
  body: JSON.stringify({ kind: 'command', name: '选人', enabled: true }),
});

console.log('== 插件设置 ==');
const pc = (await (await fetch(`${base}/api/plugins/xxt/config`, { headers: auth })).json()) as any;
assert('插件配置 GET 带 group', pc.ok && pc.data.group?.key === 'xxt');
assert('插件配置 GET 带值', pc.ok && 'env.XXT_CLASS_WARNING_COOLDOWN_SECONDS' in (pc.data.values ?? {}));
const pcPut = (await (
  await fetch(`${base}/api/plugins/xxt/config`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ values: { 'env.XXT_CLASS_WARNING_COOLDOWN_SECONDS': 90 } }),
  })
).json()) as any;
assert('插件配置 PUT applied', pcPut.ok && pcPut.data.applied.includes('env.XXT_CLASS_WARNING_COOLDOWN_SECONDS'));
assert('插件配置写回 process.env', process.env['XXT_CLASS_WARNING_COOLDOWN_SECONDS'] === '90');
const pcGet2 = (await (await fetch(`${base}/api/plugins/xxt/config`, { headers: auth })).json()) as any;
assert('插件配置 GET 反映热更新', pcGet2.data.values['env.XXT_CLASS_WARNING_COOLDOWN_SECONDS'] === '90');
const pcMissing = (await (await fetch(`${base}/api/plugins/not-exist/config`, { headers: auth })).json()) as any;
assert('未知插件配置 404', pcMissing.ok === false);

console.log('== sessions ==');
const sessionsResp = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as any;
assert('会话列表接口 ok', sessionsResp.ok && Array.isArray(sessionsResp.data.sessions));

console.log('== 日志 ==');
const logs = (await (await fetch(`${base}/api/logs?limit=10`, { headers: auth })).json()) as any;
assert('日志接口 ok', logs.ok && Array.isArray(logs.data.logs));

if (failed) {
  console.error('\nadmin:check 失败');
  process.exit(1);
}
console.log('\nadmin:check 通过');
process.exit(0);
