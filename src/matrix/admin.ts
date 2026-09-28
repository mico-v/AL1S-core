/**
 * Matrix 房间成员管理：供 CLI 和集成检查共用。
 *
 * 所有参数先完成校验，再解析 room alias 或调用 Matrix API。
 */

import type { MatrixBridgeConfig } from '../config.js';
import { MatrixClient } from './client.js';

export type MatrixAdminAction = 'status' | 'invite' | 'kick';

export interface MatrixAdminRequest {
  action: MatrixAdminAction;
  room: string;
  user: string;
  actor?: string;
  reason?: string;
}

export interface MatrixAdminStatusResult {
  action: 'status';
  roomId: string;
  userId: string;
  membership: string;
  displayName?: string;
  powerLevel: number;
  minimumPowerLevel: number;
  globallyAllowed: boolean;
  canForward: boolean;
}

export interface MatrixAdminMutationResult {
  action: 'invite' | 'kick';
  roomId: string;
  userId: string;
  actor: string;
  reason?: string;
}

export type MatrixAdminResult = MatrixAdminStatusResult | MatrixAdminMutationResult;

export class MatrixAdminArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatrixAdminArgumentError';
  }
}

export const MATRIX_ADMIN_USAGE = [
  '用法：',
  '  pnpm matrix:admin status --room <room-id|alias> --user <user-id>',
  '  pnpm matrix:admin invite --room <room-id|alias> --user <user-id> --actor <user-id>',
  '  pnpm matrix:admin kick --room <room-id|alias> --user <user-id> --actor <user-id> [--reason <text>]',
  '',
  '说明：invite/kick 的 actor 必须具备对应房间的邀请或踢出权限。',
].join('\n');

function parseMatrixId(
  value: string,
  label: string,
  prefixes: readonly string[],
): { localpart: string; domain: string } {
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  if (prefix === undefined) {
    throw new MatrixAdminArgumentError(`${label} 格式无效：${value}`);
  }
  const separator = value.indexOf(':', prefix.length);
  if (separator <= prefix.length || separator === value.length - 1) {
    throw new MatrixAdminArgumentError(`${label} 格式无效：${value}`);
  }
  const localpart = value.slice(prefix.length, separator);
  const domain = value.slice(separator + 1);
  if (
    localpart === '' ||
    domain === '' ||
    /[\s/\\]/.test(localpart) ||
    /[\s/\\]/.test(domain)
  ) {
    throw new MatrixAdminArgumentError(`${label} 格式无效：${value}`);
  }
  return { localpart, domain };
}

function normalizeRequest(
  request: MatrixAdminRequest,
  config: MatrixBridgeConfig,
): MatrixAdminRequest {
  if (!['status', 'invite', 'kick'].includes(request.action)) {
    throw new MatrixAdminArgumentError(`不支持的操作：${request.action}`);
  }

  const room =
    request.room.startsWith('!') && !request.room.includes(':')
      ? parseMatrixId(`!${request.room.slice(1)}:${config.domain}`, '房间 ID/别名', ['!'])
      : parseMatrixId(request.room, '房间 ID/别名', ['!', '#']);
  if (room.domain !== config.domain) {
    throw new MatrixAdminArgumentError(`房间不属于配置的 Matrix domain：${config.domain}`);
  }
  parseMatrixId(request.user, 'Matrix 用户 ID', ['@']);

  if (request.actor === undefined) {
    if (request.action !== 'status') {
      throw new MatrixAdminArgumentError(`${request.action} 需要 --actor`);
    }
  } else {
    if (request.action === 'status') {
      throw new MatrixAdminArgumentError('status 不接受 --actor');
    }
    const actor = parseMatrixId(request.actor, '操作者 Matrix 用户 ID', ['@']);
    if (actor.domain !== config.domain) {
      throw new MatrixAdminArgumentError('操作者必须是本 homeserver 用户');
    }
    if (request.actor === request.user) {
      throw new MatrixAdminArgumentError('操作者不能邀请或踢出自己');
    }
  }

  if (request.reason !== undefined) {
    if (request.action !== 'kick') {
      throw new MatrixAdminArgumentError('仅 kick 支持 --reason');
    }
    if (
      request.reason.trim() === '' ||
      request.reason.length > 1_024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(request.reason)
    ) {
      throw new MatrixAdminArgumentError('--reason 必须是 1-1024 字符的文本');
    }
  }

  return {
    action: request.action,
    room: request.room,
    user: request.user,
    ...(request.actor !== undefined ? { actor: request.actor } : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  };
}

export function parseMatrixAdminArgs(args: readonly string[]): MatrixAdminRequest {
  const [action, ...options] = args;
  if (action === undefined || !['status', 'invite', 'kick'].includes(action)) {
    throw new MatrixAdminArgumentError('缺少或使用了无效的操作');
  }

  const values: Partial<Record<'room' | 'user' | 'actor' | 'reason', string>> = {};
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (option === undefined || !['--room', '--user', '--actor', '--reason'].includes(option)) {
      throw new MatrixAdminArgumentError(`未知参数：${option ?? ''}`);
    }
    if (value === undefined || value === '') {
      throw new MatrixAdminArgumentError(`${option} 缺少值`);
    }
    const key = option.slice(2) as keyof typeof values;
    if (values[key] !== undefined) {
      throw new MatrixAdminArgumentError(`${option} 重复出现`);
    }
    values[key] = value;
  }

  if (values.room === undefined) {
    throw new MatrixAdminArgumentError('缺少 --room');
  }
  if (values.user === undefined) {
    throw new MatrixAdminArgumentError('缺少 --user');
  }

  return {
    action: action as MatrixAdminAction,
    room: values.room,
    user: values.user,
    ...(values.actor !== undefined ? { actor: values.actor } : {}),
    ...(values.reason !== undefined ? { reason: values.reason } : {}),
  };
}

export async function runMatrixAdmin(
  client: MatrixClient,
  config: MatrixBridgeConfig,
  request: MatrixAdminRequest,
): Promise<MatrixAdminResult> {
  const normalized = normalizeRequest(request, config);
  const roomId = normalized.room.startsWith('#')
    ? (await client.resolveAlias(normalized.room)).room_id
    : normalized.room;

  if (normalized.action === 'status') {
    const [member, levels] = await Promise.all([
      client.getRoomMember(roomId, normalized.user),
      client.getRoomPowerLevels(roomId),
    ]);
    const powerLevel = levels?.users?.[normalized.user] ?? levels?.users_default ?? 0;
    const membership = member?.membership ?? 'none';
    const globallyAllowed =
      config.allowedSenders.includes('*') || config.allowedSenders.includes(normalized.user);
    return {
      action: 'status',
      roomId,
      userId: normalized.user,
      membership,
      ...(member?.displayname !== undefined ? { displayName: member.displayname } : {}),
      powerLevel,
      minimumPowerLevel: config.minPowerLevel,
      globallyAllowed,
      canForward:
        membership === 'join' &&
        globallyAllowed &&
        powerLevel >= config.minPowerLevel,
    };
  }

  const actor = normalized.actor as string;
  if (normalized.action === 'invite') {
    await client.inviteUser(roomId, normalized.user, actor);
    return {
      action: 'invite',
      roomId,
      userId: normalized.user,
      actor,
    };
  }

  await client.kickUser(roomId, normalized.user, actor, normalized.reason);
  return {
    action: 'kick',
    roomId,
    userId: normalized.user,
    actor,
    ...(normalized.reason !== undefined ? { reason: normalized.reason } : {}),
  };
}

export async function runMatrixAdminCommand(
  args: readonly string[],
  client: MatrixClient,
  config: MatrixBridgeConfig,
): Promise<MatrixAdminResult> {
  return runMatrixAdmin(client, config, parseMatrixAdminArgs(args));
}
