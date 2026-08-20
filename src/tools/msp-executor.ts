import type { MspRuntime } from '../msp/protocol/types';
import type { ShellRequest, ShellResult } from './types';
import type { ShellTaskOwner } from './tasks';

export async function executeMsp(runtime: MspRuntime, request: ShellRequest, owner: ShellTaskOwner, signal?: AbortSignal, onSession?: (sessionId: number) => void): Promise<{ requestId: string; decision: { allowed: boolean; reason?: string }; result?: ShellResult }> {
  let toolResult = await runtime.execCommand({ cmd: request.command, workdir: '/' }, { chatId: owner.chatId, actorId: owner.senderId, signal });
    if (toolResult.internal.sessionId !== undefined) onSession?.(toolResult.internal.sessionId);
  let polls = 0;
  while (toolResult.internal.running && toolResult.internal.sessionId !== undefined && polls < 100) {
    if (signal?.aborted) break;
    toolResult = await runtime.writeStdin({ session_id: toolResult.internal.sessionId, chars: '', yield_time_ms: 5000 }, { chatId: owner.chatId, actorId: owner.senderId, signal });
    polls++;
  }
  if (toolResult.internal.running && toolResult.internal.sessionId !== undefined) {
    toolResult = await runtime.terminateSession(toolResult.internal.sessionId, { chatId: owner.chatId, actorId: owner.senderId });
  }
  return {
    requestId: toolResult.internal.sessionId?.toString() ?? crypto.randomUUID(),
    decision: toolResult.internal.error?.code === 'msp-agent.v1.runtime.policy_denied' ? { allowed: false, reason: toolResult.internal.error.message } : { allowed: true },
    result: {
      ok: toolResult.internal.exitCode === 0,
      exitCode: toolResult.internal.exitCode,
      signal: toolResult.internal.signal as NodeJS.Signals | null,
      stdout: toolResult.internal.stdout,
      stderr: toolResult.internal.stderr,
      stdoutTruncated: toolResult.internal.outputTruncated,
      stderrTruncated: toolResult.internal.outputTruncated,
      durationMs: toolResult.internal.durationMs,
      displayText: toolResult.text,
      error: toolResult.internal.error?.message,
    },
  };
}
