/**
 * 触发判定：@ 机器人或命中任一关键词即触发回复。
 */
export interface TriggerContext {
  atBot: boolean;
  rawText: string;
  keywords: string[];
}

/** 返回 true 表示应当触发（@ 到机器人，或文本包含任一非空关键词） */
export function evaluateTrigger(tc: TriggerContext): boolean {
  return tc.atBot || tc.keywords.some((k) => k && tc.rawText.includes(k));
}
