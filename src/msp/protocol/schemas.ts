/** 与 MSP AgentBridge 文档对应的本地 schema 快照。运行时不依赖 MSP 仓库。 */
export const MSP_AGENT_SCHEMAS = {
  execCommand: {
    type: 'object',
    properties: {
      cmd: { type: 'string' },
      workdir: { type: 'string' },
      shell: { type: 'string' },
      tty: { type: 'boolean' },
      yield_time_ms: { type: 'number', minimum: 0, multipleOf: 1 },
      max_output_tokens: { type: 'number', minimum: 0, multipleOf: 1 },
    },
    required: ['cmd'],
    additionalProperties: false,
  },
  writeStdin: {
    type: 'object',
    properties: {
      session_id: { type: 'number', minimum: 0, multipleOf: 1 },
      chars: { type: 'string' },
      yield_time_ms: { type: 'number', minimum: 0, multipleOf: 1 },
      max_output_tokens: { type: 'number', minimum: 0, multipleOf: 1 },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  updatePlan: {
    type: 'object',
    properties: {
      explanation: { type: 'string' },
      plan: { type: 'array' },
    },
    required: ['plan'],
    additionalProperties: false,
  },
} as const;
