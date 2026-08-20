import { SkillRegistry } from '../skills/registry';
import { registerPlugins } from '../skills/plugins';
import { PluginCliRegistry } from '../msp/plugin-cli-registry';
import { registerBuiltinCliPlugins } from '../cli/plugins';
import { MspWorkspace } from '../msp/workspace';
import { LocalBashMspRuntime } from '../msp/local-bash-runtime';
import { CommandBroker } from '../msp/command-broker';
import { SessionCommandRunner } from '../msp/session-command-runner';
import { loadConfig } from '../config';
import { SessionManager } from '../session/manager';

const config = loadConfig({ BOT_ADMINS: '123', MSP_ENABLED: 'true', COURSE_DATA_FILE: './data/session-cli-check-course.json' });
const sessions = new SessionManager({ tokenBudget: 1000, maxSessions: 10 });
const sent: Array<{ groupId: number; message: unknown }> = [];
const api = {
  getGroupMemberList: async () => [{ user_id: 456 }, { user_id: 789 }],
  getLoginInfo: async () => ({ user_id: 999, nickname: 'bot' }),
  sendGroupMessage: async (groupId: number, message: unknown) => { sent.push({ groupId, message }); return {}; },
  sendPrivateMessage: async () => ({}),
  call: async () => ({}),
} as never;
const registry = new SkillRegistry();
registry.setConfig(config);
registry.setSessionManager(sessions);
registry.setApi(api);
const cli = new PluginCliRegistry();
cli.setConfig(config);
registry.setCliRegistry(cli);
registerPlugins(registry);
registerBuiltinCliPlugins(cli);
const workspace = new MspWorkspace('./data/session-cli-check-workspace');
const runtime = new LocalBashMspRuntime({ workspace, defaultYieldTimeMs: 250, timeoutMs: 10000 });
const broker = new CommandBroker(registry, sessions, api, config, './data/session-cli-check.sock');
const runner = new SessionCommandRunner(runtime, workspace, cli, broker);
try {
  await broker.start();
  const result = await runner.run('选人 1 | cat', { chatId: 'g:818919231', groupId: 818919231, senderId: 123, senderName: 'admin', source: 'chat' });
  if (result.exitCode !== 0 || !result.stdout || sent.length !== 1 || sent[0]!.groupId !== 818919231) {
    throw new Error(`session-cli-check：命令失败 exit=${result.exitCode} stdout=${result.stdout} stderr=${result.stderr}`);
  }
  const redirected = await runner.run('选人 1 > selected.txt', { chatId: 'g:818919231', groupId: 818919231, senderId: 123, senderName: 'admin', source: 'chat' });
  if (redirected.exitCode !== 0 || redirected.stdout !== '') throw new Error('session-cli-check：重定向未由 bash 处理');
  console.log('session-cli-check ok');
} finally {
  await broker.stop();
  await runtime.dispose();
}
