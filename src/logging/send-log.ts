import { logger } from './logger';

const log = logger.child('send');

export interface SendLogContext {
  module: string;
  sourceModule?: string;
  command?: string;
  chatId?: string;
  groupId?: number;
  senderId?: number;
  messageType?: string;
}

/** 统一记录宿主发出的消息；不记录 token 或完整敏感 payload。 */
export function logSend(context: SendLogContext, message?: unknown): void {
  log.info('发送消息', {
    ...context,
    messageType: context.messageType ?? inferMessageType(message),
    payload: summarizeMessage(message),
  });
}

export async function sendLogged<T>(send: (message: unknown) => Promise<T>, context: SendLogContext, message: unknown): Promise<T> {
  logSend(context, message);
  return send(message);
}

export function logReject(context: SendLogContext & { reason: string }): void {
  log.warn('命令拒绝', { ...context });
}

function inferMessageType(message: unknown): string {
  if (Array.isArray(message)) return 'segments';
  if (typeof message === 'string') return 'text';
  return message === undefined ? 'unknown' : 'message';
}

function summarizeMessage(message: unknown): string | undefined {
  if (typeof message === 'string') return message.slice(0, 200);
  if (Array.isArray(message)) return `segments:${message.length}`;
  return message === undefined ? undefined : '[structured-message]';
}
