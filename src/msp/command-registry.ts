import type { MspCommandDescriptor, MspCommandInvocation, MspCommandResult } from './protocol/types';

export interface MspCommand {
  name: string;
  summary?: string;
  plugin?: string;
  executable?: string;
  lookupPaths?: string[];
  enabled?: boolean;
  run(invocation: MspCommandInvocation): Promise<MspCommandResult>;
}

export interface MspCommandPack {
  name: string;
  registerCommands(registry: MspCommandRegistry): void;
}

/** 对齐 MSPCommandRegistry / MSPCommandPack 的 TS 侧命令注册表。 */
export class MspCommandRegistry {
  private readonly commands = new Map<string, MspCommand>();

  register(command: MspCommand): void {
    if (this.commands.has(command.name)) throw new Error(`command already registered: ${command.name}`);
    this.commands.set(command.name, command);
  }

  registerPack(pack: MspCommandPack): void { pack.registerCommands(this); }
  command(name: string): MspCommand | undefined { return this.commands.get(name); }
  get commandNames(): string[] { return [...this.commands.keys()].sort(); }
  list(): MspCommandDescriptor[] {
    return [...this.commands.values()].map((command) => ({ name: command.name, summary: command.summary, plugin: command.plugin, executable: command.executable, lookupPaths: command.lookupPaths, enabled: command.enabled ?? true }));
  }
  setEnabled(name: string, enabled: boolean): boolean {
    const command = this.commands.get(name);
    if (!command) return false;
    command.enabled = enabled;
    return true;
  }
}
