/**
 * 最小 Matrix Client-Server API 客户端。
 *
 * 只实现 bridge 所需能力，不替代 Matrix SDK：appservice 身份请求、
 * 房间创建/加入/查询、事件发送以及媒体上传下载。
 */

import type { AppLogger } from '../logger.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface MatrixCreateRoomOptions {
  name?: string;
  topic?: string;
  roomAliasName?: string;
  preset?: 'private_chat' | 'public_chat' | 'trusted_private_chat';
  visibility?: 'private' | 'public';
  invite?: string[];
  isDirect?: boolean;
}

export interface MatrixCreateRoomResponse {
  room_id: string;
  room_alias?: string;
}

export interface MatrixSendEventResponse {
  event_id: string;
}

export interface MatrixUploadResponse {
  content_uri: string;
}

export interface MatrixRoomMember {
  membership?: string;
  displayname?: string;
}

export interface MatrixPowerLevels {
  users_default?: number;
  users?: Record<string, number>;
}

export interface DownloadedMedia {
  data: Buffer;
  contentType: string;
}

export interface MatrixClientOptions {
  homeserverUrl: string;
  accessToken: string;
  log?: AppLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface MatrixRequestOptions {
  query?: Record<string, string | undefined>;
  json?: JsonObject;
  body?: Uint8Array;
  contentType?: string;
}

interface MatrixErrorBody {
  errcode?: string;
  error?: string;
}

export class MatrixApiError extends Error {
  readonly status: number;
  readonly errcode?: string;
  readonly body?: string;

  constructor(message: string, status: number, errcode?: string, body?: string) {
    super(message);
    this.name = 'MatrixApiError';
    this.status = status;
    this.errcode = errcode;
    this.body = body;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

export class MatrixClient {
  readonly userId: string;
  private readonly baseUrl: URL;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log?: AppLogger;

  constructor(options: MatrixClientOptions, userId: string) {
    this.userId = userId;
    this.baseUrl = new URL(options.homeserverUrl.endsWith('/') ? options.homeserverUrl : `${options.homeserverUrl}/`);
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.log = options.log;
  }

  async createRoom(options: MatrixCreateRoomOptions, asUser?: string): Promise<MatrixCreateRoomResponse> {
    const body: JsonObject = {};
    if (options.name !== undefined) body.name = options.name;
    if (options.topic !== undefined) body.topic = options.topic;
    if (options.roomAliasName !== undefined) body.room_alias_name = options.roomAliasName;
    if (options.preset !== undefined) body.preset = options.preset;
    if (options.visibility !== undefined) body.visibility = options.visibility;
    if (options.invite !== undefined) body.invite = options.invite;
    if (options.isDirect !== undefined) body.is_direct = options.isDirect;
    return this.request<MatrixCreateRoomResponse>('POST', '/_matrix/client/v3/createRoom', {
      json: body,
      query: { user_id: asUser },
    });
  }

  joinRoom(roomIdOrAlias: string, asUser?: string): Promise<{ room_id: string }> {
    return this.request<{ room_id: string }>(
      'POST',
      `/_matrix/client/v3/join/${encodePath(roomIdOrAlias)}`,
      { json: {}, query: { user_id: asUser } },
    );
  }

  inviteUser(
    roomId: string,
    userId: string,
    asUser?: string,
    reason?: string,
  ): Promise<void> {
    const body: JsonObject = { user_id: userId };
    if (reason !== undefined) {
      body.reason = reason;
    }
    return this.request<void>(
      'POST',
      `/_matrix/client/v3/rooms/${encodePath(roomId)}/invite`,
      { json: body, query: { user_id: asUser } },
    );
  }

  kickUser(
    roomId: string,
    userId: string,
    asUser?: string,
    reason?: string,
  ): Promise<void> {
    const body: JsonObject = { user_id: userId };
    if (reason !== undefined) {
      body.reason = reason;
    }
    return this.request<void>(
      'POST',
      `/_matrix/client/v3/rooms/${encodePath(roomId)}/kick`,
      { json: body, query: { user_id: asUser } },
    );
  }

  setDisplayName(userId: string, displayName: string, asUser?: string): Promise<void> {
    return this.request<void>(
      'PUT',
      `/_matrix/client/v3/profile/${encodePath(userId)}/displayname`,
      { json: { displayname: displayName }, query: { user_id: asUser } },
    );
  }

  resolveAlias(alias: string): Promise<{ room_id: string }> {
    return this.request<{ room_id: string }>(
      'GET',
      `/_matrix/client/v3/directory/room/${encodePath(alias)}`,
    );
  }

  async getRoomMember(roomId: string, userId: string): Promise<MatrixRoomMember | undefined> {
    try {
      return await this.request<MatrixRoomMember>(
        'GET',
        `/_matrix/client/v3/rooms/${encodePath(roomId)}/state/m.room.member/${encodePath(userId)}`,
      );
    } catch (error) {
      if (error instanceof MatrixApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async getRoomPowerLevels(roomId: string): Promise<MatrixPowerLevels | undefined> {
    try {
      return await this.request<MatrixPowerLevels>(
        'GET',
        `/_matrix/client/v3/rooms/${encodePath(roomId)}/state/m.room.power_levels`,
      );
    } catch (error) {
      if (error instanceof MatrixApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  sendEvent(
    roomId: string,
    eventType: string,
    content: JsonObject,
    transactionId: string,
    asUser?: string,
  ): Promise<MatrixSendEventResponse> {
    return this.request<MatrixSendEventResponse>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodePath(roomId)}/send/${encodePath(eventType)}/${encodePath(transactionId)}`,
      { json: content, query: { user_id: asUser } },
    );
  }

  redactEvent(
    roomId: string,
    eventId: string,
    transactionId: string,
    asUser?: string,
  ): Promise<MatrixSendEventResponse> {
    return this.request<MatrixSendEventResponse>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodePath(roomId)}/redact/${encodePath(eventId)}/${encodePath(transactionId)}`,
      { json: {}, query: { user_id: asUser } },
    );
  }

  sendStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: JsonObject,
    asUser?: string,
  ): Promise<MatrixSendEventResponse> {
    return this.request<MatrixSendEventResponse>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodePath(roomId)}/state/${encodePath(eventType)}/${encodePath(stateKey)}`,
      { json: content, query: { user_id: asUser } },
    );
  }

  async uploadMedia(
    data: Uint8Array,
    contentType: string,
    filename: string,
    asUser?: string,
  ): Promise<string> {
    const response = await this.request<MatrixUploadResponse>('POST', '/_matrix/media/v3/upload', {
      body: data,
      contentType,
      query: { filename, user_id: asUser },
    });
    return response.content_uri;
  }

  async downloadMedia(uri: string, maxBytes: number): Promise<DownloadedMedia> {
    if (!uri.startsWith('mxc://')) {
      throw new MatrixApiError(`不是合法的 mxc URI：${uri}`, 400);
    }
    const [serverName, mediaId] = uri.slice('mxc://'.length).split('/', 2);
    if (serverName === undefined || mediaId === undefined) {
      throw new MatrixApiError(`mxc URI 缺少 server 或 media ID：${uri}`, 400);
    }

    const response = await this.rawRequest(
      `/_matrix/client/v1/media/download/${encodePath(serverName)}/${encodePath(mediaId)}`,
      { query: { allow_remote: 'true' } },
    );
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > maxBytes) {
      throw new MatrixApiError(`Matrix 媒体超过大小上限：${length}`, 413);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > maxBytes) {
      throw new MatrixApiError(`Matrix 媒体超过大小上限：${data.byteLength}`, 413);
    }
    return {
      data,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    options: MatrixRequestOptions = {},
  ): Promise<T> {
    const response = await this.rawRequest(path, options, method);
    const text = await response.text();
    if (text.trim() === '') {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MatrixApiError('Matrix 返回了无效 JSON', response.status, undefined, text);
    }
  }

  private async rawRequest(
    path: string,
    options: MatrixRequestOptions = {},
    method = 'GET',
  ): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      accept: 'application/json',
    };
    let body: string | Uint8Array | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/octet-stream';
      body = options.body;
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.ok) {
      return response;
    }

    const text = await response.text();
    let parsed: MatrixErrorBody | undefined;
    try {
      parsed = asObject(JSON.parse(text)) as MatrixErrorBody | undefined;
    } catch {
      parsed = undefined;
    }
    const message = parsed?.error ?? `Matrix API 请求失败：HTTP ${response.status}`;
    this.log?.warn('Matrix API 请求失败', {
      method,
      path,
      status: response.status,
      errcode: parsed?.errcode,
    });
    throw new MatrixApiError(message, response.status, parsed?.errcode, text);
  }
}
