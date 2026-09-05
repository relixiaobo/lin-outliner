export const DELEGATE_PROTOCOL_VERSION = 1 as const;
export const DELEGATE_CLI_VERSION = '1.0.0' as const;

export const DELEGATE_MAX_PROMPT_BYTES = 256 * 1024;
export const DELEGATE_MAX_MESSAGE_BYTES = 64 * 1024;

export const DELEGATE_EXIT_CODES = {
  success: 0,
  usage: 2,
  unavailable: 5,
  unauthorized: 6,
  failed: 7,
  interrupted: 130,
  terminated: 143,
} as const;

export type DelegateExitCode = typeof DELEGATE_EXIT_CODES[keyof typeof DELEGATE_EXIT_CODES];
