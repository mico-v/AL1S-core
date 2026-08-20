const OPENAI_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/** 将插件 canonical 名称映射为稳定的 OpenAI function name；canonical 名称仍保留在 metadata。 */
export function getToolName(canonicalName: string, namespace?: string): string {
  const known: Record<string, string> = {
    '选人': 'xxt_pick',
    '查撤回': 'xxt_query_recall',
    '重放': 'xxt_replay_recall',
    '清空撤回': 'xxt_clear_recall',
    '课堂提醒': 'xxt_class_reminder',
    '今日课表': 'course_today',
    '同步课表': 'course_sync',
    query_course_schedule_sql: 'course_query_schedule_sql',
    edit_local_course_schedule_sql: 'course_edit_local_schedule_sql',
  };
  const direct = known[canonicalName];
  if (direct) return direct;
  if (OPENAI_TOOL_NAME.test(canonicalName)) return canonicalName;
  const prefix = namespace ? asciiPart(namespace) : 'plugin';
  const body = asciiPart(canonicalName);
  return `${prefix}_${body || stableSuffix(canonicalName)}`.slice(0, 64);
}

export function isValidToolName(name: string): boolean {
  return OPENAI_TOOL_NAME.test(name) && name.length <= 64;
}

function asciiPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 48);
}

function stableSuffix(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `tool_${(hash >>> 0).toString(16)}`;
}
