/**
 * 插件/命令/工具启停控制：包装 SkillRegistry 的 enabled 状态 + 持久化到
 * `data/plugin-toggles.json`（仿 AstrBot inactivated_plugins）。热生效。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillRegistry } from '../skills/registry';

export interface EnabledSnapshot {
  commands: Record<string, boolean>;
  skills: Record<string, boolean>;
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

  /** 当前命令/skill 列表（含 enabled 状态），供管理后台展示 */
  list(): { commands: Array<{ name: string; description: string; enabled: boolean }>; skills: Array<{ name: string; description: string; enabled: boolean }> } {
    return {
      commands: this.registry.getCommands().map((c) => ({ name: c.name, description: c.description, enabled: this.registry.isCommandEnabled(c.name) })),
      skills: this.registry.getSkills().map((s) => ({ name: s.name, description: s.description, enabled: this.registry.isSkillEnabled(s.name) })),
    };
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
