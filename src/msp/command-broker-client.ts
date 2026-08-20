import { createConnection, type Socket } from 'node:net';
import type { CommandBrokerRequest, CommandBrokerResponse } from './command-protocol';

export class CommandBrokerClient {
  private readonly socketPath: string;
  private readonly auth: string;

  constructor(socketPath: string, auth: string) {
    this.socketPath = socketPath;
    this.auth = auth;
  }

  async invoke(request: Omit<CommandBrokerRequest, 'protocol' | 'id' | 'auth' | 'op'>): Promise<CommandBrokerResponse> {
    const id = `${process.env.AL1S_MSP_COMMAND_REQUEST_ID ?? 'cli'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload: CommandBrokerRequest = { protocol: 'al1s.command-broker.v1', id, auth: this.auth, op: 'invoke', ...request };
    return await new Promise<CommandBrokerResponse>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = '';
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('命令代理响应超时')); }, 120_000);
      const finish = (fn: () => void): void => { clearTimeout(timeout); socket.removeAllListeners(); socket.destroy(); fn(); };
      socket.on('error', (error) => finish(() => reject(error)));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        try {
          const response = JSON.parse(line) as CommandBrokerResponse;
          if (response.id !== id) throw new Error('命令代理响应 ID 不匹配');
          finish(() => resolve(response));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    });
  }
}
