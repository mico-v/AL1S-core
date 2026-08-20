/** MSP AgentBridge v1 稳定错误码。错误消息不是兼容性键，调用方应只判断 code。 */
export const MSP_ERROR_CODES = {
  inputUnknownField: 'msp-agent.v1.input.unknown_field',
  inputMissingRequired: 'msp-agent.v1.input.missing_required',
  inputInvalidType: 'msp-agent.v1.input.invalid_type',
  inputInvalidValue: 'msp-agent.v1.input.invalid_value',
  inputInvalidJson: 'msp-agent.v1.input.invalid_json',
  inputEmptyCommand: 'msp-agent.v1.input.empty_command',
  inputFreeformMissing: 'msp-agent.v1.input.freeform_missing',
  sessionInactive: 'msp-agent.v1.runtime.session_inactive',
  sessionLimit: 'msp-agent.v1.runtime.session_limit',
  stdinClosed: 'msp-agent.v1.runtime.stdin_closed',
  stdinWriteFailed: 'msp-agent.v1.runtime.stdin_write_failed',
  processStartFailed: 'msp-agent.v1.runtime.process_start_failed',
  processTimeout: 'msp-agent.v1.runtime.process_timeout',
  ptyUnavailable: 'msp-agent.v1.runtime.pty_unavailable',
  ptyStartFailed: 'msp-agent.v1.runtime.pty_start_failed',
  processInterrupted: 'msp-agent.v1.runtime.process_interrupted',
  processTerminated: 'msp-agent.v1.runtime.process_terminated',
  outputTruncated: 'msp-agent.v1.runtime.output_truncated',
  policyDenied: 'msp-agent.v1.runtime.policy_denied',
  capabilityDisabled: 'msp-agent.v1.capability.disabled',
  capabilityUnavailable: 'msp-agent.v1.capability.unavailable',
  planInvalid: 'msp-agent.v1.plan.invalid',
  planStatusInvalid: 'msp-agent.v1.plan.status_invalid',
  planUpdateFailed: 'msp-agent.v1.plan.update_failed',
  patchInvalid: 'msp-agent.v1.patch.invalid',
  patchExecutionFailed: 'msp-agent.v1.patch.execution_failed',
} as const;

export type MspErrorCode = (typeof MSP_ERROR_CODES)[keyof typeof MSP_ERROR_CODES];

export function mspError(
  code: MspErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, string | number | boolean | null>,
  cause?: string,
): { code: MspErrorCode; message: string; retryable: boolean; details?: Record<string, string | number | boolean | null>; cause?: string } {
  return { code, message, retryable, details, cause };
}
