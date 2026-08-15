/**
 * 插件注册入口：显式 import 各内置/示例插件并逐一注册。
 * tsx 友好（不用 import.meta.glob），新增插件只需在此加一行。
 */
import type { SkillRegistry } from './registry';
import { helpPlugin } from './builtin/help';
import { resetPlugin } from './builtin/reset';
import { personaPlugin } from './builtin/persona';
import { dicePlugin } from './example/dice';

export function registerPlugins(registry: SkillRegistry): void {
  helpPlugin.register(registry);
  resetPlugin.register(registry);
  personaPlugin.register(registry);
  dicePlugin.register(registry);
}
