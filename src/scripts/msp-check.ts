import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { MspWorkspace } from '../msp/workspace';
import { LocalBashMspRuntime } from '../msp/local-bash-runtime';
import { parseExecCommandInput, parseWriteStdinInput } from '../msp/protocol/validate';

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(`msp-check 失败：${message}`);
}

const root = `./data/msp-check-${randomUUID().slice(0, 8)}`;
const workspace = new MspWorkspace(root, 'check');
const runtime = new LocalBashMspRuntime({ workspace, defaultYieldTimeMs: 250, maxYieldTimeMs: 1000, emptyPollMs: 5000, timeoutMs: 3000 });

try {
  const exec = parseExecCommandInput({ cmd: 'printf ok' });
  expect(exec.cmd === 'printf ok', 'exec schema');
  let rejected = false;
  try { parseExecCommandInput({ cmd: 'printf ok', unknown: true }); } catch { rejected = true; }
  expect(rejected, 'unknown field rejected');
  rejected = false;
  try { parseWriteStdinInput({ session_id: 1.5 }); } catch { rejected = true; }
  expect(rejected, 'fraction session id rejected');

  const workspacePath = await workspace.resolveVirtualPath('/nested/../');
  expect(workspacePath.virtualPath === '/', 'virtual path normalization');
  const outside = await workspace.resolveVirtualPath('/../outside');
  expect(outside.virtualPath === '/outside', 'parent traversal clamped');

  const pwd = await runtime.execCommand({ cmd: 'pwd', yield_time_ms: 250 });
  expect(pwd.internal.stdout.trim() === '/', 'pwd 使用虚拟工作目录');
  expect(!pwd.text.includes(root), '模型输出不泄露物理工作区');

  const quick = await runtime.execCommand({ cmd: 'printf hello', yield_time_ms: 250 });
  expect(quick.text.includes('Process exited with code 0'), 'quick command terminal result');
  expect(quick.text.includes('hello'), 'quick command output');
  expect(!quick.text.startsWith('{'), 'model result is plain text');

  const live = await runtime.execCommand({ cmd: 'sleep 1; printf done', yield_time_ms: 250 });
  expect(live.internal.running || live.text.includes('Process exited'), 'live or completed session result');
  if (live.internal.running && live.internal.sessionId !== undefined) {
    const polled = await runtime.writeStdin({ session_id: live.internal.sessionId, chars: '', yield_time_ms: 5000 });
    expect(polled.text.includes('done') || polled.text.includes('Process exited'), 'session poll');
  }

  const pty = await runtime.execCommand({ cmd: 'printf no', tty: true });
  expect(pty.internal.error?.code === 'msp-agent.v1.runtime.pty_unavailable', 'pty unavailable code');
  const sessions = runtime.listSessions();
  expect(Array.isArray(sessions), 'runtime session list');
  console.log('msp-check ok');
} finally {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
}
