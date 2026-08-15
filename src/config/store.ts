/**
 * 运行时 ConfigStore：把配置从「启动时读一次」变为「运行时可变对象」。
 *
 * - env 作默认值；`data/settings.json` 作覆盖层（只持久化「与启动默认不同的字段」）。
 * - `config` 是就地可变对象，消费方在调用点现读即热生效。
 * - `env.XXX` 字段写回 process.env（插件配置）；`requiresRestart` 字段仅持久化，
 *   本次运行内标记 pendingRestart，重启后由 loadOverlay 重新应用（不再标记）。
 * - 更新时按 schema 类型做归一化（coerce），非法值跳过不应用。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type BotConfig } from '../config';
import { CONFIG_FIELD_MAP, fieldRequiresRestart, isEnvField, type ConfigFieldMeta } from './schema';

/** 覆盖层文件结构 */
interface SettingsFile {
  version: number;
  values: Record<string, unknown>;
}

/** 按点路径取值 */
function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 按点路径就地赋值（中间对象缺失时自动创建） */
function setByPath(obj: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next === null || typeof next !== 'object') cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** 按 schema 类型归一化字段值；返回 undefined 表示非法（调用方跳过该字段） */
function coerceFieldValue(meta: ConfigFieldMeta, value: unknown): unknown {
  switch (meta.type) {
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(s)) return true;
      if (['false', '0', 'off', 'no'].includes(s)) return false;
      return undefined; // 无法识别 → 跳过
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'number-list': {
      if (Array.isArray(value)) {
        return value.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      }
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isFinite(n));
      }
      return undefined;
    }
    case 'string-list': {
      if (Array.isArray(value)) return value.map(String);
      if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
      return undefined;
    }
    case 'string':
    case 'password':
    case 'textarea':
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

export class ConfigStore {
  /** 运行时可变配置对象（消费方持有此引用，现读即热） */
  readonly config: BotConfig;
  private readonly settingsFile: string;
  private readonly restartKeys = new Set<string>();
  private readonly appliers: Array<(store: ConfigStore) => void> = [];
  private readonly listeners = new Set<() => void>();
  /** 启动时（应用覆盖层前）的 env 默认值快照，用于增量持久化 */
  private readonly initialValues: Record<string, unknown>;

  constructor(settingsFile = process.env.ADMIN_SETTINGS_FILE || './data/settings.json') {
    this.settingsFile = settingsFile;
    this.config = loadConfig();
    this.initialValues = this.snapshotValues();
    this.loadOverlay();
  }

  /** 注册「配置变更后要主动干活」的 applier（如 provider.setModel） */
  registerApplier(fn: (store: ConfigStore) => void): void {
    this.appliers.push(fn);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 读取某字段当前生效值 */
  getField(key: string): unknown {
    if (isEnvField(key)) {
      const envKey = key.slice('env.'.length);
      return process.env[envKey] ?? '';
    }
    if (CONFIG_FIELD_MAP[key]) return getByPath(this.config, key);
    return undefined;
  }

  /** 全部字段 → 当前生效值 */
  getValues(): Record<string, unknown> {
    return this.snapshotValues();
  }

  /**
   * 应用部分字段改动并持久化。
   * 返回：applied（已即时生效）/ pendingRestart（仅持久化，重启生效）的字段 key 列表。
   */
  updateValues(patch: Record<string, unknown>): { applied: string[]; pendingRestart: string[] } {
    const applied: string[] = [];
    const pendingRestart: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const meta = CONFIG_FIELD_MAP[key];
      if (!meta) continue; // 未知字段忽略
      const coerced = coerceFieldValue(meta, value);
      if (coerced === undefined) continue; // 非法值忽略
      this.applyField(key, coerced);
      if (fieldRequiresRestart(key)) {
        this.restartKeys.add(key);
        pendingRestart.push(key);
      } else {
        applied.push(key);
      }
    }
    if (applied.length + pendingRestart.length > 0) {
      this.persist();
      for (const fn of [...this.appliers]) {
        try {
          fn(this);
        } catch {
          // applier 抛错不阻断
        }
      }
      this.emit();
    }
    return { applied, pendingRestart };
  }

  /** 是否存在本运行内未生效的「需重启」改动 */
  get restartRequired(): boolean {
    return this.restartKeys.size > 0;
  }

  private snapshotValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(CONFIG_FIELD_MAP)) out[key] = this.getField(key);
    return out;
  }

  private applyField(key: string, value: unknown): void {
    if (isEnvField(key)) {
      const envKey = key.slice('env.'.length);
      process.env[envKey] = value === null || value === undefined ? '' : String(value);
    } else if (CONFIG_FIELD_MAP[key]) {
      setByPath(this.config, key, value);
    }
  }

  /** 启动时从 settings.json 应用覆盖层（已生效，不置 restartKeys） */
  private loadOverlay(): void {
    let raw: SettingsFile | null = null;
    try {
      raw = JSON.parse(readFileSync(this.settingsFile, 'utf-8')) as SettingsFile;
    } catch {
      return; // 无覆盖文件或损坏 → 用 env 默认
    }
    const values = raw?.values ?? {};
    for (const [key, value] of Object.entries(values)) {
      const meta = CONFIG_FIELD_MAP[key];
      if (!meta) continue;
      const coerced = coerceFieldValue(meta, value);
      if (coerced === undefined) continue;
      this.applyField(key, coerced);
    }
  }

  /** 只把「与启动默认不同」的字段写回 settings.json（原子 tmp+rename） */
  private persist(): void {
    try {
      mkdirSync(dirname(this.settingsFile), { recursive: true });
      const values: Record<string, unknown> = {};
      for (const key of Object.keys(CONFIG_FIELD_MAP)) {
        const current = this.getField(key);
        if (JSON.stringify(current) !== JSON.stringify(this.initialValues[key])) {
          values[key] = current;
        }
      }
      const payload: SettingsFile = { version: 1, values };
      const tmp = `${this.settingsFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(tmp, this.settingsFile);
    } catch {
      // 持久化失败仅降级，不影响运行
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 忽略
      }
    }
  }
}
