import type { MspRuntime, MspRuntimeContext } from './protocol/types';
import type { ExecCommandInput, WriteStdinInput } from './protocol/types';

/** AgentBridge 适配层：把模型工具调用映射到可替换的 MSP runtime。 */
export class MspAgentBridge {
  private readonly runtime: MspRuntime;

  constructor(runtime: MspRuntime) {
    this.runtime = runtime;
  }

  getModelTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [
      {
        name: 'exec_command',
        description: '在当前 MSP 工作区中执行命令；结果以终端文本返回，长任务会返回 session ID。',
        inputSchema: {
          type: 'object',
          properties: {
            cmd: { type: 'string' },
            workdir: { type: 'string' },
            shell: { type: 'string' },
            tty: { type: 'boolean' },
            yield_time_ms: { type: 'number', minimum: 0, multipleOf: 1 },
            max_output_tokens: { type: 'number', minimum: 0, multipleOf: 1 },
          },
          required: ['cmd'],
          additionalProperties: false,
        },
      },
      {
        name: 'write_stdin',
        description: '向正在运行的 exec_command session 写入字符或轮询输出。空 chars 只轮询。',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'number', minimum: 0, multipleOf: 1 },
            chars: { type: 'string' },
            yield_time_ms: { type: 'number', minimum: 0, multipleOf: 1 },
            max_output_tokens: { type: 'number', minimum: 0, multipleOf: 1 },
          },
          required: ['session_id'],
          additionalProperties: false,
        },
      },
    ];
  }

  execCommand(input: ExecCommandInput, context?: MspRuntimeContext) {
    return this.runtime.execCommand(input, context);
  }

  writeStdin(input: WriteStdinInput, context?: MspRuntimeContext) {
    return this.runtime.writeStdin(input, context);
  }

  getRuntime(): MspRuntime { return this.runtime; }
}
