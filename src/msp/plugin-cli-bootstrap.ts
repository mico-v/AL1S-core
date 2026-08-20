import type { SkillRegistry } from '../skills/registry';
import { PluginCliRegistry } from './plugin-cli-registry';

/** 插件命令由 manifest 直接注册；旧 Command bootstrap 已移除。 */
export function registerPluginCommandsAsCli(_skills: SkillRegistry, _cli: PluginCliRegistry): void {
  throw new Error('已移除旧插件命令 bootstrap，请直接注册 CLI manifest');
}
