import { loadConfig } from '../config';
import { SessionManager } from '../session/manager';
import { SkillRegistry } from '../skills/registry';
import { registerPlugins } from '../skills/plugins';
import { PluginCliRegistry } from '../msp/plugin-cli-registry';
import { registerBuiltinCliPlugins, cliPluginManifests } from '../cli/plugins';
import { MspWorkspace } from '../msp/workspace';
import { LocalBashMspRuntime } from '../msp/local-bash-runtime';
import { MspPluginCliExecutor } from '../msp/plugin-cli-executor';
import { CommandBroker } from '../msp/command-broker';

const config = loadConfig({ BOT_ADMINS: '123', MSP_ENABLED: 'true', COURSE_DATA_FILE: './data/command-broker-check-course.json' });
const sessions = new SessionManager({ tokenBudget: 1000, maxSessions: 10 });
const sent: unknown[] = [];
const fakeApi = {
  getGroupMemberList: async () => [{ user_id: 123 }, { user_id: 456 }, { user_id: 789 }],
  getLoginInfo: async () => ({ user_id: 999, nickname: 'bot' }),
  sendGroupMessage: async (_groupId: number, message: unknown) => { sent.push(message); return {}; },
  sendPrivateMessage: async () => ({}),
  call: async () => ({}),
} as never;
const registry = new SkillRegistry();
registry.setConfig(config);
registry.setSessionManager(sessions);
registry.setApi(fakeApi);
const cli = new PluginCliRegistry();
cli.setConfig(config);
registry.setCliRegistry(cli);
registerPlugins(registry);
registerBuiltinCliPlugins(cli);
const runtime = new LocalBashMspRuntime({ workspace: new MspWorkspace('./data/command-broker-check-workspace'), defaultYieldTimeMs: 250, timeoutMs: 10000 });
const broker = new CommandBroker(registry, sessions, fakeApi, config, './data/command-broker-check.sock');
cli.setExecutor(new MspPluginCliExecutor(runtime, undefined, broker));
try {
  await broker.start();
  const executor = new MspPluginCliExecutor(runtime, undefined, broker);
  const xxt = cliPluginManifests.find((manifest) => manifest.name === 'xxt')!;
  const pick = await executor.run(xxt, '选人', ['1'], { workspace: '/', chatId: 'g:1', groupId: 1, senderId: 123, senderName: 'admin', source: 'chat', input: { count: 1 } });
  if (pick.exitCode !== 0 || sent.length !== 1) throw new Error(`command-broker-check：选人失败 stdout=${pick.stdout} stderr=${pick.stderr}`);

  const course = cliPluginManifests.find((manifest) => manifest.name === 'course-schedule')!;
  const today = await executor.run(course, '今日课表', [], { workspace: '/', chatId: 'g:1', groupId: 1, senderId: 123, senderName: 'admin', source: 'chat' });
  if (today.exitCode !== 0 || !today.stdout.includes('没有可展示')) throw new Error(`command-broker-check：今日课表失败 stdout=${today.stdout} stderr=${today.stderr}`);
  console.log('command-broker-check ok');
} finally {
  await broker.stop();
  await runtime.dispose();
}
