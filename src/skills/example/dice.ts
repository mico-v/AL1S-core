/**
 * 示例插件：掷骰子工具，演示 LLM function calling 全链路。
 * 群成员说「帮我掷个骰子」时，模型会调用 roll_dice 工具。
 */
import type { Plugin, Skill, SkillRegistry } from '../registry';

export const diceSkill: Skill = {
  name: 'roll_dice',
  description: '掷骰子，可指定面数与次数，返回点数列表',
  inputSchema: {
    type: 'object',
    properties: {
      sides: { type: 'integer', default: 6, description: '骰子面数（如 6）' },
      times: { type: 'integer', default: 1, minimum: 1, maximum: 10, description: '掷几次' },
    },
    required: [],
  },
  async run(args) {
    const sides = typeof args.sides === 'number' ? args.sides : 6;
    const times = typeof args.times === 'number' ? args.times : 1;
    const rolls: number[] = [];
    for (let i = 0; i < times; i++) {
      rolls.push(Math.floor(Math.random() * sides) + 1);
    }
    return `掷骰结果：[${rolls.join(', ')}]`;
  },
};

export const dicePlugin: Plugin = {
  name: 'dice',
  description: '示例工具：掷骰子',
  register(registry: SkillRegistry): void {
    registry.registerSkill(diceSkill);
  },
};
