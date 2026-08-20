import { PluginCliRegistry } from '../msp/plugin-cli-registry';
import { registerBuiltinCliPlugins } from '../cli/plugins';
import { PluginCommandRunner } from '../msp/plugin-command-runner';
import { MspWorkspace } from '../msp/workspace';
import { LocalBashMspRuntime } from '../msp/local-bash-runtime';
import { MspPluginCliExecutor } from '../msp/plugin-cli-executor';
import { SessionCommandRunner } from '../msp/session-command-runner';

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(`plugin-cli-check 失败：${message}`);
}

const registry = new PluginCliRegistry();
const runtime = new LocalBashMspRuntime({ workspace: new MspWorkspace('./data/plugin-cli-check'), defaultYieldTimeMs: 250, timeoutMs: 10000 });
registry.setExecutor(new MspPluginCliExecutor(runtime));
const workspace = new MspWorkspace('./data/plugin-cli-check');
registry.setSessionRunner(new SessionCommandRunner(runtime, workspace, registry));
registerBuiltinCliPlugins(registry);
const listed = registry.list();
expect(listed.some((command) => command.name === 'roll_dice'), 'roll_dice 已注册');
expect(listed.some((command) => command.aliases.includes('dice')), 'dice alias 已注册');
const runner = new PluginCommandRunner(registry);
const result = await runner.run('dice', ['--sides', '6', '--times', '2'], { workspace: '/', chatId: 'check' });
expect(result.exitCode === 0, 'CLI alias 执行成功');
expect(result.stdout.includes('掷骰结果'), 'CLI 返回业务文本');
registry.setEnabled('roll_dice', false);
const disabled = await runner.run('roll_dice', [], { workspace: '/', chatId: 'check' });
expect(disabled.exitCode !== 0, '禁用命令拒绝执行');
await runtime.dispose();
console.log('plugin-cli-check ok');
