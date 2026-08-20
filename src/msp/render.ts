import { truncateUtf8 } from '../tools/output';
import type { MspInternalResult, MspToolResult } from './protocol/types';

const DEFAULT_MAX_OUTPUT_TOKENS = 10000;

export function outputTokenBudget(maxOutputTokens: number | undefined): number {
  const value = maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.max(0, Math.min(Math.floor(value), 1_000_000));
}

export function renderRawResult(result: MspInternalResult, maxOutputTokens?: number): string {
  const budgetBytes = outputTokenBudget(maxOutputTokens) * 4;
  const output = result.combinedOutput || [result.stdout, result.stderr].filter(Boolean).join('');
  const truncated = budgetBytes > 0 ? truncateUtf8(output, budgetBytes) : { text: '', truncated: output.length > 0, bytes: Buffer.byteLength(output) };
  const lines = [truncated.text];
  if (result.error && !result.running) lines.push(`Error: ${result.error.message}`);
  return lines.filter(Boolean).join('\n');
}

/** MSP 模型可见结果：纯 terminal text，不返回内部 JSON envelope。 */
export function renderMspResult(result: MspInternalResult, maxOutputTokens?: number, formatOutput = true): string {
  if (!formatOutput) return renderRawResult(result, maxOutputTokens);
  const budgetBytes = outputTokenBudget(maxOutputTokens) * 4;
  const output = result.combinedOutput || [result.stdout, result.stderr].filter(Boolean).join('');
  const truncated = budgetBytes > 0 ? truncateUtf8(output, budgetBytes) : { text: '', truncated: output.length > 0, bytes: Buffer.byteLength(output) };
  const lines = [`Wall time: ${(result.durationMs / 1000).toFixed(4)}`];
  if (result.running && result.sessionId !== undefined) {
    lines.push(`Process running with session ID ${result.sessionId}`);
  } else if (result.error?.code === 'msp-agent.v1.runtime.process_interrupted') {
    lines.push('Process interrupted');
  } else if (result.error?.code === 'msp-agent.v1.runtime.process_terminated') {
    lines.push('Process terminated');
  } else if (result.exitCode !== null) {
    lines.push(`Process exited with code ${result.exitCode}`);
  }
  lines.push('Output:');
  if (truncated.text) lines.push(truncated.text);
  if (truncated.truncated && !truncated.text.includes('[输出已截断]')) lines.push('[输出已截断]');
  if (result.error && !result.running) lines.push(`Error: ${result.error.message}`);
  return lines.join('\n');
}

export function asMspToolResult(result: MspInternalResult, maxOutputTokens?: number, formatOutput = true): MspToolResult {
  return { text: renderMspResult(result, maxOutputTokens, formatOutput), internal: result };
}
