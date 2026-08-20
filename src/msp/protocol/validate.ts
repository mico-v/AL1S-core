import { MSP_ERROR_CODES } from './error-codes';
import type { ExecCommandInput, WriteStdinInput } from './types';
import type { MspErrorRecord } from './types';

export class MspProtocolInputError extends Error {
  readonly record: MspErrorRecord;

  constructor(record: MspErrorRecord) {
    super(record.message);
    this.name = 'MspProtocolInputError';
    this.record = record;
  }
}

function fail(code: MspErrorRecord['code'], message: string, details?: Record<string, string | number | boolean | null>): never {
  throw new MspProtocolInputError({ code, message, retryable: false, details });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(MSP_ERROR_CODES.inputInvalidType, '工具参数必须是 JSON object');
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedSet.has(key)).sort();
  if (unknown.length > 0) {
    fail(MSP_ERROR_CODES.inputUnknownField, `工具参数包含不支持的字段：${unknown.join(', ')}`, { fields: unknown.join(',') });
  }
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(MSP_ERROR_CODES.inputInvalidType, `${key} 必须是字符串`, { field: key });
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(MSP_ERROR_CODES.inputInvalidType, `${key} 必须是布尔值`, { field: key });
  return value;
}

function optionalNonNegativeInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    fail(MSP_ERROR_CODES.inputInvalidValue, `${key} 必须是非负整数`, { field: key });
  }
  return value;
}

export function parseExecCommandInput(value: unknown): ExecCommandInput {
  const input = objectValue(value);
  rejectUnknown(input, ['cmd', 'workdir', 'shell', 'tty', 'yield_time_ms', 'max_output_tokens']);
  if (!Object.hasOwn(input, 'cmd')) fail(MSP_ERROR_CODES.inputMissingRequired, 'exec_command 缺少 cmd', { field: 'cmd' });
  const cmd = input.cmd;
  if (typeof cmd !== 'string') fail(MSP_ERROR_CODES.inputInvalidType, 'cmd 必须是字符串', { field: 'cmd' });
  if (cmd.trim().length === 0) fail(MSP_ERROR_CODES.inputEmptyCommand, '命令不能为空');
  return {
    cmd,
    workdir: optionalString(input, 'workdir'),
    shell: optionalString(input, 'shell'),
    tty: optionalBoolean(input, 'tty'),
    yield_time_ms: optionalNonNegativeInteger(input, 'yield_time_ms'),
    max_output_tokens: optionalNonNegativeInteger(input, 'max_output_tokens'),
  };
}

export function parseWriteStdinInput(value: unknown): WriteStdinInput {
  const input = objectValue(value);
  rejectUnknown(input, ['session_id', 'chars', 'yield_time_ms', 'max_output_tokens']);
  if (!Object.hasOwn(input, 'session_id')) fail(MSP_ERROR_CODES.inputMissingRequired, 'write_stdin 缺少 session_id', { field: 'session_id' });
  const parsed = optionalNonNegativeInteger(input, 'session_id');
  if (parsed === undefined) fail(MSP_ERROR_CODES.inputMissingRequired, 'write_stdin 缺少 session_id', { field: 'session_id' });
  const sessionId = parsed;
  const chars = optionalString(input, 'chars');
  return {
    session_id: sessionId,
    chars,
    yield_time_ms: optionalNonNegativeInteger(input, 'yield_time_ms'),
    max_output_tokens: optionalNonNegativeInteger(input, 'max_output_tokens'),
  };
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(MSP_ERROR_CODES.inputInvalidJson, `工具参数不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return objectValue(value);
}

export function parseExecToolArguments(raw: string): ExecCommandInput {
  return parseExecCommandInput(parseToolArguments(raw));
}

export function parseWriteStdinToolArguments(raw: string): WriteStdinInput {
  return parseWriteStdinInput(parseToolArguments(raw));
}
