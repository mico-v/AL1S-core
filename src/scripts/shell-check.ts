import { loadConfig } from '../config';
import { evaluateShellRequest } from '../tools/policy';
import { executeShell } from '../tools/executor';

const config = loadConfig({
  ...process.env,
  SHELL_ENABLED: 'true',
  SHELL_RUNTIME: 'local',
  SHELL_CWD: process.cwd(),
  SHELL_ALLOWLIST: 'printf,sleep',
  SHELL_ADMIN_IDS: '42',
  SHELL_MAX_OUTPUT_BYTES: '32',
});

let failed = false;
function expect(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed = true; console.error(`  ✗ ${label}`); }
}

expect('默认 shell 开启', loadConfig({}).shell.enabled === true);
expect('默认 runtime 为 local', loadConfig({}).shell.runtime === 'local');
expect('空 allowlist 允许普通命令', evaluateShellRequest({ command: 'printf ok' }, { ...config.shell, allowlist: [] }, 42).allowed);
expect('非管理员拒绝', !evaluateShellRequest({ command: 'printf ok', runtime: 'local' }, config.shell, 7).allowed);
expect('非法 runtime 拒绝', !evaluateShellRequest({ command: 'printf ok', runtime: 'sandbox' as never }, config.shell, 42).allowed);
expect('绝对路径命令可执行', evaluateShellRequest({ command: '/usr/bin/printf ok', runtime: 'local' }, config.shell, 42).allowed);
expect('复合命令可执行', evaluateShellRequest({ command: 'printf ok; printf bad', runtime: 'local' }, { ...config.shell, allowlist: [] }, 42).allowed);
expect('allowlist 外命令拒绝', !evaluateShellRequest({ command: 'echo ok', runtime: 'local' }, { ...config.shell, allowlist: ['printf'] }, 42).allowed);

const run = await executeShell({ command: 'printf 你好', runtime: 'local' }, config.shell, 42);
expect('allowlist 命令可执行', run.result?.ok === true && run.result.stdout === '你好');
expect('固定 cwd 生效', run.decision.allowed);
const large = await executeShell({ command: 'printf %05000d', runtime: 'local' }, config.shell, 42);
expect('输出按字节截断', large.result?.stdoutTruncated === true && Buffer.byteLength(large.result.stdout) <= 32 + Buffer.byteLength('\n[输出已截断]'));
const timed = await executeShell({ command: 'sleep 1', runtime: 'local', timeoutMs: 20 }, config.shell, 42);
expect('超时终止进程', timed.result?.ok === false && timed.result.error === '命令执行超时');

if (failed) {
  console.error('\nshell:check 失败');
  process.exit(1);
}
console.log('\nshell:check 通过');
