import type { Plugin, Skill, SkillRegistry } from '../registry';

export function rollDice(args: Record<string, unknown>): string {
  const sides = typeof args.sides === 'number' && Number.isInteger(args.sides) && args.sides >= 2 ? args.sides : 6;
  const times = typeof args.times === 'number' && Number.isInteger(args.times) && args.times >= 1 ? Math.min(args.times, 10) : 1;
  const rolls: number[] = [];
  for (let i = 0; i < times; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
  return `掷骰结果：[${rolls.join(', ')}]`;
}

export const diceSkill: Skill = {
  name: 'roll_dice',
  description: '掷骰子，可指定面数与次数，返回点数列表',
  inputSchema: {
    type: 'object',
    properties: {
      sides: { type: 'integer', default: 6, minimum: 2, description: '骰子面数' },
      times: { type: 'integer', default: 1, minimum: 1, maximum: 10, description: '掷几次' },
    },
    required: [],
  },
  async run(args) { return rollDice(args); },
};

export const dicePlugin: Plugin = {
  name: 'dice',
  displayName: '骰子',
  description: '示例命令：掷骰子',
  register(registry: SkillRegistry): void {
    registry.registerSkill(diceSkill);
  },
};
