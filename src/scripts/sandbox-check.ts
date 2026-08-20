import { loadConfig } from '../config';
import { SessionSandboxManager } from '../msp/session-sandbox-manager';
import { SessionCommandRunner } from '../msp/session-command-runner';
import { PluginCliRegistry } from '../msp/plugin-cli-registry';

const productionConfig = loadConfig({
  MSP_RUNTIME_MODE: 'podman',
  MSP_ALLOW_LOCAL_BASH_FALLBACK: 'false',
  MSP_WORKSPACE_ROOT: './data/sandbox-check-production',
});
const productionManager = new SessionSandboxManager(productionConfig.msp);
const productionStatus = await productionManager.inspect();
if (!productionStatus.available && productionStatus.isolated) {
  throw new Error('sandbox-check：后端不可用时不允许报告 isolated=true');
}
await productionManager.dispose();

// 即使 runtime CLI/rootless 可用，缺失的配置镜像也不得进入 Agent/命令执行路径。
const missingImageConfig = loadConfig({
  MSP_RUNTIME_MODE: 'podman',
  MSP_ALLOW_LOCAL_BASH_FALLBACK: 'false',
  MSP_CONTAINER_IMAGE: `al1s-sandbox:missing-${Date.now()}`,
  MSP_WORKSPACE_ROOT: './data/sandbox-check-missing-image',
});
const missingImageManager = new SessionSandboxManager(missingImageConfig.msp);
const missingImageStatus = await missingImageManager.inspect();
if (productionStatus.available && missingImageStatus.available) {
  throw new Error(`sandbox-check：runtime available but image missing 仍报告可用：${JSON.stringify(missingImageStatus)}`);
}
if (productionStatus.available) {
  const missingRunner = new SessionCommandRunner(missingImageManager, new PluginCliRegistry());
  const rejected = await missingRunner.run('printf 用户输入不应执行', { chatId: 'g:sandbox-check', groupId: 1, senderId: 2, senderName: 'check', source: 'chat' });
  if (rejected.exitCode === 0 || rejected.internal.state !== 'not_started') {
    throw new Error('sandbox-check：镜像缺失时 SessionCommandRunner 仍执行命令');
  }
}
await missingImageManager.dispose();

// 离线语义检查显式使用 local-bash；成功不代表已经隔离。
const config = loadConfig({
  MSP_RUNTIME_MODE: 'local-bash',
  MSP_ALLOW_LOCAL_BASH_FALLBACK: 'true',
  MSP_WORKSPACE_ROOT: './data/sandbox-check',
});
const manager = new SessionSandboxManager(config.msp);
const status = await manager.inspect();
if (!status.available || status.isolated) throw new Error(`sandbox-check：local fallback 状态错误：${JSON.stringify(status)}`);
const sandbox = await manager.get('check-session');
const result = await sandbox.runtime.execCommand({ cmd: "printf 'a\\nb\\n' | grep b > result.txt && cat result.txt && python - <<'PY'\nprint('python-ok')\nPY", workdir: '/' });
if (result.internal.exitCode !== 0 || !result.internal.stdout.includes('python-ok') || !result.internal.stdout.includes('b')) throw new Error(`sandbox-check：shell 组合语义失败：${result.text}`);
const second = await manager.get('check-session');
if (second.workspace.hostRoot !== sandbox.workspace.hostRoot) throw new Error('sandbox-check：会话工作区不持久');
console.log(`sandbox-check ok backend=${sandbox.backend} isolated=${sandbox.isolated} productionAvailable=${productionStatus.available}`);
await manager.dispose();
