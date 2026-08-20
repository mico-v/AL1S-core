export const COMMAND_BROKER_EFFECT_MARKER = 'AL1S_EFFECTS:';

export interface CommandBrokerRequest {
  protocol: 'al1s.command-broker.v1';
  id: string;
  auth: string;
  op: 'invoke';
  plugin: string;
  command: string;
  args: string[];
  input: Record<string, unknown>;
  source: 'chat' | 'agent' | 'cli';
  context: { chatId: string; groupId?: number; senderId?: number; senderName?: string; source: 'chat' | 'agent' | 'cli'; workspace: string; input: Record<string, unknown> };
}

export interface CommandBrokerEffect {
  type: 'text' | 'message' | 'image' | 'file' | 'onebot';
  target?: string;
  action?: string;
  summary: string;
  payload?: unknown;
}

export interface CommandBrokerResponse {
  protocol: 'al1s.command-broker.v1';
  id: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  effects: CommandBrokerEffect[];
}
