/**
 * 运行时指标计数：消息收发、工具调用、出错次数。
 * 由 pipeline 在关键路径自增，供管理后台仪表盘展示。
 */
export interface BotMetrics {
  messagesReceived: number;
  messagesSent: number;
  toolCalls: number;
  errors: number;
}

export const metrics: BotMetrics = {
  messagesReceived: 0,
  messagesSent: 0,
  toolCalls: 0,
  errors: 0,
};

/** 快照（避免外部直接改） */
export function metricsSnapshot(): BotMetrics {
  return { ...metrics };
}
