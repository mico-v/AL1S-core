import { realpath, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MSP_ERROR_CODES, mspError } from './protocol/error-codes';
import type { MspErrorRecord } from './protocol/types';

export class MspWorkspaceError extends Error {
  readonly record: MspErrorRecord;

  constructor(record: MspErrorRecord) {
    super(record.message);
    this.name = 'MspWorkspaceError';
    this.record = record;
  }
}

/** 将单一物理目录暴露为 MSP 虚拟路径 `/`。 */
export class MspWorkspace {
  readonly id: string;
  readonly virtualRoot = '/';
  private readonly physicalRoot: string;
  private initialized = false;

  constructor(physicalRoot: string, id = 'default') {
    this.id = id;
    this.physicalRoot = resolve(physicalRoot);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.physicalRoot, { recursive: true });
    this.initialized = true;
  }

  /** 仅供 runtime 内部使用；不得写入模型输出。 */
  get hostRoot(): string {
    return this.physicalRoot;
  }

  async health(): Promise<{ exists: boolean; virtualRoot: '/'; entries?: number }> {
    try {
      const info = await stat(this.physicalRoot);
      return { exists: info.isDirectory(), virtualRoot: '/' };
    } catch {
      return { exists: false, virtualRoot: '/' };
    }
  }

  async resolveVirtualPath(path: string | undefined, currentDirectory = '/'): Promise<{ virtualPath: string; hostPath: string }> {
    await this.initialize();
    const raw = path?.trim() || currentDirectory || '/';
    const virtualPath = normalizeVirtualPath(raw, isAbsolute(raw) ? '/' : currentDirectory);
    const hostPath = resolve(this.physicalRoot, `.${virtualPath}`);
    if (!isWithin(this.physicalRoot, hostPath)) {
      throw new MspWorkspaceError(mspError(MSP_ERROR_CODES.policyDenied, '路径超出工作区范围'));
    }
    await assertSymlinkSafe(this.physicalRoot, hostPath);
    return { virtualPath, hostPath };
  }
}

export function normalizeVirtualPath(path: string, currentDirectory = '/'): string {
  const base = path.startsWith('/') ? path : `${currentDirectory.replace(/\/+$/, '')}/${path}`;
  const parts: string[] = [];
  for (const part of base.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertSymlinkSafe(root: string, target: string): Promise<void> {
  let existing = target;
  while (existing !== root && !isWithin(root, existing)) existing = resolve(existing, '..');
  try {
    const real = await realpath(existing);
    if (!isWithin(root, real)) throw new MspWorkspaceError(mspError(MSP_ERROR_CODES.policyDenied, '路径符号链接超出工作区范围'));
  } catch (error) {
    if (error instanceof MspWorkspaceError) throw error;
    // 目标可能尚未创建；检查最近存在的父路径即可。
    const parent = resolve(existing, '..');
    if (parent !== existing) await assertSymlinkSafe(root, parent);
  }
}
