/**
 * 目标类型（kind）与各自的能力包。
 *
 * 设计取向：加能力，不是减能力。每个 kind 说明「这类活怎么干、算干完」，
 * 并给出该类型需要的工具；`code` 不设白名单（拿该身份的全部工具），
 * 其余类型按需收窄到安全集合 —— 收窄的目的是别让调研去改仓库，
 * 而不是给 agent 上锁。
 */

export const GOAL_KINDS = ['code', 'research', 'ops', 'review'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export function isGoalKind(value: unknown): value is GoalKind {
  return typeof value === 'string' && (GOAL_KINDS as readonly string[]).includes(value);
}

export interface KindPack {
  id: GoalKind;
  label: string;
  /** 拼进 system 的干法与验收口径。 */
  prompt: string;
  /** 允许的工具名；undefined = 该身份的全部工具。 */
  tools?: string[];
  /** 判据模板：模型立目标时照着写。 */
  criteria: string[];
}

const READ_ONLY = [
  'search_messages',
  'web_search',
  'member_profile',
  'search_topics',
  'recent_digests',
  'chat_stats',
  'memory_query',
  'memory_status',
  'goal_status',
  'goal_watch',
  'repo_status',
  'ci_status',
  'list_dir',
  'read_file',
  'grep_files',
  'cnb_issue_list',
  'cnb_issue_get',
  'cnb_pull_list',
];

const GOAL_WRITE = ['goal_create', 'goal_step', 'goal_finish', 'goal_block'];

export const KIND_PACKS: Record<GoalKind, KindPack> = {
  code: {
    id: 'code',
    label: '写代码',
    prompt: [
      '这类活按片推进：一片一个 PR，先看现有测试再动手，改完自己跑 tsc / 单测 / build。',
      '验收看证据（CI 结论、页面 hash、命令输出），不看自我感觉；等外部交货就挂 goal_watch，别轮询。',
    ].join('\n'),
    criteria: ['tsc 干净、单测全绿、build 通过', 'PR 合入且线上与本地构建一致'],
  },
  research: {
    id: 'research',
    label: '调研',
    prompt: [
      '这类活先查再写：每条结论都带出处（链接或文件行号），查不到就写「未核实」，别补全。',
      '结论按「事实 / 推断 / 建议」分开写；同类项目要列差异点，不堆功能清单。',
    ].join('\n'),
    tools: [...READ_ONLY, ...GOAL_WRITE],
    criteria: ['每条结论都有出处', '给出可执行的下一步建议'],
  },
  ops: {
    id: 'ops',
    label: '运维巡检',
    prompt: [
      '这类活先看现状再动手：改配置前备份，写清回滚步骤，改完立刻验证服务状态与日志。',
      '能用只读命令看清楚的，不要改东西；要重启自己这类进程时按既定流程走。',
    ].join('\n'),
    tools: [...READ_ONLY, ...GOAL_WRITE, 'run_command'],
    criteria: ['改动前后状态与日志都有记录', '回滚步骤写清楚了'],
  },
  review: {
    id: 'review',
    label: '评审',
    prompt: [
      '这类活只读：按判据逐条给证据（文件行号、CI 结论、issue 评论），不写仓库、不跑改文件的命令。',
      '结论分「必须改 / 建议改 / 可以不改」三档，每条指出具体位置。',
    ].join('\n'),
    tools: [...READ_ONLY, 'goal_step', 'goal_finish', 'goal_block'],
    criteria: ['每条意见都有位置与依据', '结论分档清楚'],
  },
};

export function kindPack(kind: GoalKind | undefined): KindPack {
  return KIND_PACKS[kind ?? 'code'] ?? KIND_PACKS.code;
}

/** 按 kind 过滤工具定义；包不设白名单就原样返回。 */
export function filterToolsForKind<T>(tools: T[], kind: GoalKind | undefined): T[] {
  const allow = kindPack(kind).tools;
  if (!allow) {
    return tools;
  }
  const set = new Set(allow);
  return tools.filter((tool) => {
    const name = (tool as { function?: { name?: string } }).function?.name;
    return !name || set.has(name);
  });
}
