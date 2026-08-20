export interface MspCapabilityRequest {
  type: 'invoke_command';
  command: string;
  arguments: string[];
}

export interface MspCapabilityResponse {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  effects?: unknown[];
}

export interface MspCommandInvocationContext {
  chatId?: string;
  groupId?: number;
  senderId?: number;
  senderName?: string;
}

export type MspCapabilityBroker = (request: MspCapabilityRequest, context: MspCommandInvocationContext) => Promise<MspCapabilityResponse>;

/** 子进程侧 capability 客户端：使用 MSP runtime 注入的 fd3 NDJSON 通道。 */
export class MspCapabilityClient {
  private readonly input?: NodeJS.ReadableStream;
  private readonly output?: NodeJS.WritableStream;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, (response: MspCapabilityResponse) => void>();

  constructor() {
    if (process.env.AL1S_CAPABILITY_FD !== '3') return;
    try {
      const fs = requireFs();
      this.output = fs.createWriteStream('', { fd: 3, autoClose: false });
      this.input = fs.createReadStream('', { fd: 3, autoClose: false });
      this.input.on('data', (chunk: Buffer | string) => this.onData(String(chunk)));
    } catch {
      this.input = undefined;
      this.output = undefined;
    }
  }

  available(): boolean { return this.input !== undefined && this.output !== undefined; }

  request(request: MspCapabilityRequest): Promise<MspCapabilityResponse> {
    if (!this.output) return Promise.resolve({ ok: false, stderr: 'MSP capability 通道不可用', exitCode: 125 });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.output!.write(`${JSON.stringify({ id, request })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number; response?: MspCapabilityResponse };
        if (typeof message.id === 'number' && message.response) this.pending.get(message.id)?.(message.response);
        if (typeof message.id === 'number') this.pending.delete(message.id);
      } catch {
        // 非法 capability 数据不应污染命令 stdout。
      }
    }
  }
}

function requireFs(): typeof import('node:fs') {
  // 该文件也会在 CLI 子进程中运行；Node >= 22 下通过 global require 兼容 tsx ESM/CJS 入口。
  return (globalThis as { require?: (name: string) => typeof import('node:fs') }).require?.('node:fs')
    ?? (() => { throw new Error('fs loader unavailable'); })();
}
