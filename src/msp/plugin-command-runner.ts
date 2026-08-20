import type { MspCommandInvocation, MspCommandResult } from './protocol/types';
import type { CliPluginContext } from './plugin-cli-types';
import { PluginCliRegistry } from './plugin-cli-registry';

/** 通过插件 CLI 注册表执行命令；生产宿主必须已绑定 MSP executor。 */
export class PluginCommandRunner {
  private readonly registry: PluginCliRegistry;

  constructor(registry: PluginCliRegistry) {
    this.registry = registry;
  }

  async run(name: string, args: string[], context: CliPluginContext): Promise<MspCommandResult> {
    const invocation: MspCommandInvocation = { name, arguments: args, rawInput: [name, ...args].join(' ') };
    return this.registry.invoke(name, invocation, context);
  }
}
