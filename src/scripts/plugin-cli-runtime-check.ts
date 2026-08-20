import { MspWorkspace } from '../msp/workspace';
import { LocalBashMspRuntime } from '../msp/local-bash-runtime';
import { MspPluginCliExecutor } from '../msp/plugin-cli-executor';
import { cliPluginManifests } from '../cli/plugins';

const runtime = new LocalBashMspRuntime({ workspace: new MspWorkspace('./data/plugin-cli-runtime-check'), defaultYieldTimeMs: 250, timeoutMs: 10000 });
const executor = new MspPluginCliExecutor(runtime);
const diceCliManifest = cliPluginManifests.find((manifest) => manifest.name === 'dice')!;
try {
  const result = await executor.run(diceCliManifest, 'dice', ['--sides', '6', '--times', '2'], { workspace: '/', chatId: 'check' });
  if (result.exitCode !== 0 || !result.stdout.includes('掷骰结果')) throw new Error('plugin-cli-runtime-check：CLI 未通过 MSP 执行');
  console.log('plugin-cli-runtime-check ok');
} finally {
  await runtime.dispose();
}
