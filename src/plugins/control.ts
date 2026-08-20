/**
 * 插件/命令/工具启停控制：包装 SkillRegistry 的 enabled 状态 + 持久化到
 * `data/plugin-toggles.json`（仿 AstrBot inactivated_plugins）。热生效。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillRegistry, PluginCommandInfo } from '../skills/registry';

export interface EnabledSnapshot {
  plugins?: Record<string, boolean>;
  commands: Record<string, boolean>;
  skills?: Record<string, boolean>;
}

/** 单个插件在管理后台的展示项：含其命令/工具与其启停状态 */
export interface PluginItem {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  hasSettings: boolean;
  commands: PluginCommandInfo[];
}

export class PluginControl {
  private readonly file: string;
  private readonly registry: SkillRegistry;

  constructor(registry: SkillRegistry, file = './data/plugin-toggles.json') {
    this.registry = registry;
    this.file = file;
  }

  /** 启动时从磁盘恢复启停状态 */
  attach(): void {
    let data: EnabledSnapshot | null = null;
    try {
      if (existsSync(this.file)) {
        data = JSON.parse(readFileSync(this.file, 'utf-8')) as EnabledSnapshot;
      }
    } catch {
      data = null;
    }
    this.registry.restoreEnabled(data);
  }

  /** 设置命令/skill 启停；成功则持久化 */
  setEnabled(kind: 'command' | 'skill', name: string, enabled: boolean): boolean {
    const ok = this.registry.setEnabled(kind, name, enabled);
    if (ok) this.persist();
    return ok;
  }

  /** 设置插件整体启停；禁用时后台钩子也会停止执行 */
  setPluginEnabled(name: string, enabled: boolean): boolean {
    const ok = this.registry.setPluginEnabled(name, enabled);
    if (ok) this.persist();
    return ok;
  }
  reloadPlugin(name: string): void {
    this.registry.reloadPlugin(name);
  }

  list(): { plugins: PluginItem[] } {
    const plugins = this.registry.getPluginMetas().map((m) => ({
      name: m.name,
      displayName: m.displayName,
      description: m.description,
      enabled: this.registry.isPluginEnabled(m.name),
      hasSettings: Boolean(m.settings && m.settings.fields.length > 0),
      commands: this.registry.getPluginCommands(m.name),
    }));
    return { plugins };
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const payload = this.registry.serializeEnabled();
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(tmp, this.file);
    } catch {
      // 持久化失败仅降级
    }
  }
}
