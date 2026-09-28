/**
 * Matrix Application Service transaction 接收端。
 *
 * Tuwunel 使用 registration 中的 hs_token 对请求鉴权，并通过
 * `/_matrix/app/v1/transactions/{txnId}` 推送房间事件。服务必须等待处理完成
 * 后再返回成功，以便处理失败时由 homeserver 原地重试。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { AppLogger } from '../logger.js';
import type { JsonObject } from './client.js';
import type { BridgeMetrics } from './metrics.js';

export interface MatrixEvent {
  type: string;
  room_id: string;
  sender: string;
  event_id: string;
  origin_server_ts?: number;
  state_key?: string;
  redacts?: string;
  content: JsonObject;
}

export interface MatrixTransaction {
  events?: MatrixEvent[];
  ephemeral?: Array<{ type: string; room_id: string; content: JsonObject }>;
  to_device?: Array<{ type: string; sender: string; content: JsonObject }>;
}

export interface MatrixAppserviceServerOptions {
  host: string;
  port: number;
  hsToken: string;
  onTransaction: (transactionId: string, transaction: MatrixTransaction) => Promise<void>;
  log?: AppLogger;
  metrics?: BridgeMetrics;
  maxBodyBytes?: number;
  shutdownTimeoutMs?: number;
}

export interface ListeningAddress {
  host: string;
  port: number;
}

const TRANSACTION_PATH = /^\/_matrix\/app\/v1\/transactions\/([^/]+)$/;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

class AppserviceRequestError extends Error {
  readonly status: number;
  readonly errcode: string;

  constructor(message: string, status: number, errcode: string) {
    super(message);
    this.name = 'AppserviceRequestError';
    this.status = status;
    this.errcode = errcode;
  }
}

function sendJson(response: ServerResponse, status: number, body: JsonObject): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function tokensEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (value === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new AppserviceRequestError(
        `请求体超过上限 ${maxBytes} 字节`,
        413,
        'M_TOO_LARGE',
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseTransaction(raw: Buffer): MatrixTransaction {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppserviceRequestError('transaction 不是合法 JSON', 400, 'M_BAD_JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppserviceRequestError(
      'transaction 必须是 JSON object',
      400,
      'M_INVALID_PARAM',
    );
  }
  return value as MatrixTransaction;
}

export class MatrixAppserviceServer {
  private readonly options: MatrixAppserviceServerOptions;
  private readonly maxBodyBytes: number;
  private readonly shutdownTimeoutMs: number;
  private server?: Server;
  private inFlight = new Map<string, Promise<void>>();
  private transactionChain: Promise<void> = Promise.resolve();

  constructor(options: MatrixAppserviceServerOptions) {
    this.options = options;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  async start(): Promise<ListeningAddress> {
    if (this.server !== undefined) {
      const address = this.server.address() as AddressInfo | null;
      if (address !== null) {
        return { host: address.address, port: address.port };
      }
    }

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.options.log?.info('Matrix appservice 已监听', {
      host: address.address,
      port: address.port,
    });
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) {
      return;
    }
    let forced = false;
    let timeout: NodeJS.Timeout | undefined;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    server.closeIdleConnections();
    timeout = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
    }, this.shutdownTimeoutMs);
    try {
      await closed;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
    if (forced) {
      this.options.log?.warn('Appservice 关闭超时，已强制关闭活跃连接', {
        timeoutMs: this.shutdownTimeoutMs,
      });
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let requestRecorded = false;
    const record = (
      route: Parameters<BridgeMetrics['recordAppserviceRequest']>[0],
      result: Parameters<BridgeMetrics['recordAppserviceRequest']>[1],
    ): void => {
      if (!requestRecorded) {
        this.options.metrics?.recordAppserviceRequest(route, result);
        requestRecorded = true;
      }
    };

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        record('health', 'success');
        sendJson(response, 200, {});
        return;
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        if (this.options.metrics === undefined) {
          record('metrics', 'invalid');
          sendText(response, 404, 'metrics are not enabled\n');
          return;
        }
        record('metrics', 'success');
        sendText(response, 200, this.options.metrics.render());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/_matrix/app/v1/ping') {
        record('ping', 'success');
        sendJson(response, 200, {});
        return;
      }
      if (request.method === 'POST' && url.pathname === '/_matrix/app/v1/ping') {
        if (!this.authorized(request, url)) {
          record('ping', 'unauthorized');
          sendJson(response, 401, { errcode: 'M_FORBIDDEN', error: 'invalid hs_token' });
          return;
        }
        record('ping', 'success');
        sendJson(response, 200, {});
        return;
      }

      const match = request.method === 'PUT' ? TRANSACTION_PATH.exec(url.pathname) : null;
      if (match === null) {
        record('unknown', 'invalid');
        sendJson(response, 404, { errcode: 'M_NOT_FOUND', error: 'unknown appservice endpoint' });
        return;
      }
      if (!this.authorized(request, url)) {
        record('transactions', 'unauthorized');
        sendJson(response, 401, { errcode: 'M_FORBIDDEN', error: 'invalid hs_token' });
        return;
      }

      let transactionId: string;
      try {
        transactionId = decodeURIComponent(match[1] ?? '');
      } catch {
        throw new AppserviceRequestError(
          'transaction id 编码非法',
          400,
          'M_INVALID_PARAM',
        );
      }
      if (transactionId === '') {
        record('transactions', 'invalid');
        sendJson(response, 400, { errcode: 'M_INVALID_PARAM', error: 'missing transaction id' });
        return;
      }

      const raw = await readBody(request, this.maxBodyBytes);
      const transaction = parseTransaction(raw);
      await this.processTransaction(transactionId, transaction);
      record('transactions', 'success');
      sendJson(response, 200, {});
    } catch (error) {
      if (error instanceof AppserviceRequestError) {
        record('transactions', 'invalid');
        this.options.log?.warn('拒绝 appservice 请求', {
          status: error.status,
          error: error.message,
        });
        if (!response.headersSent && !response.destroyed) {
          sendJson(response, error.status, { errcode: error.errcode, error: error.message });
        } else if (!response.writableEnded && !response.destroyed) {
          response.end();
        }
        return;
      }
      record('transactions', 'error');
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.error('处理 appservice 请求失败', { error: message });
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, {
          errcode: 'M_UNKNOWN',
          error: 'internal appservice error',
        });
      } else if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
    }
  }

  private authorized(request: IncomingMessage, url: URL): boolean {
    const token = bearerToken(request) ?? url.searchParams.get('access_token') ?? '';
    return tokensEqual(token, this.options.hsToken);
  }

  private async processTransaction(
    transactionId: string,
    transaction: MatrixTransaction,
  ): Promise<void> {
    const running = this.inFlight.get(transactionId);
    if (running !== undefined) {
      await running;
      return;
    }
    const task = this.transactionChain.then(() =>
      this.options.onTransaction(transactionId, transaction),
    );
    this.transactionChain = task.catch(() => undefined);
    this.inFlight.set(transactionId, task);
    try {
      await task;
    } finally {
      this.inFlight.delete(transactionId);
    }
  }
}
