export const OUTLINE_ERROR_CODES = [
  'invalid_input',
  'not_found',
  'ambiguous_selector',
  'cardinality_mismatch',
  'precondition_failed',
  'stale_revision',
  'diff_mismatch',
  'idempotency_conflict',
  'confirmation_required',
  'revert_conflict',
  'recovery_expired',
  'recovery_capacity_exceeded',
  'recovery_inconsistent',
  'operation_settlement_unknown',
  'runtime_unavailable',
  'agent_attestation_required',
  'unauthorized',
  'protocol_incompatible',
  'durability_failed',
  'internal_error',
] as const;

export type OutlineErrorCode = typeof OUTLINE_ERROR_CODES[number];

export type OutlineErrorCategory =
  | 'usage'
  | 'selection'
  | 'conflict'
  | 'confirmation'
  | 'unavailable'
  | 'protocol'
  | 'durability'
  | 'internal';

export interface OutlineError {
  code: OutlineErrorCode;
  category: OutlineErrorCategory;
  message: string;
  retryable: boolean;
  details?: unknown;
  next?: readonly string[];
}

export const OUTLINE_EXIT_CODES = {
  success: 0,
  usage: 2,
  conflict: 3,
  confirmation: 4,
  unavailable: 5,
  protocol: 6,
  durability: 7,
  internal: 8,
  interrupted: 130,
  terminated: 143,
} as const;

export type OutlineExitCode = typeof OUTLINE_EXIT_CODES[keyof typeof OUTLINE_EXIT_CODES];

const CATEGORY_EXIT_CODE: Readonly<Record<OutlineErrorCategory, OutlineExitCode>> = {
  usage: OUTLINE_EXIT_CODES.usage,
  selection: OUTLINE_EXIT_CODES.conflict,
  conflict: OUTLINE_EXIT_CODES.conflict,
  confirmation: OUTLINE_EXIT_CODES.confirmation,
  unavailable: OUTLINE_EXIT_CODES.unavailable,
  protocol: OUTLINE_EXIT_CODES.protocol,
  durability: OUTLINE_EXIT_CODES.durability,
  internal: OUTLINE_EXIT_CODES.internal,
};

export function outlineExitCodeForError(error: Pick<OutlineError, 'category'>): OutlineExitCode {
  return CATEGORY_EXIT_CODE[error.category];
}

export class OutlineContractError extends Error {
  readonly outlineError: OutlineError;

  constructor(error: OutlineError) {
    super(error.message);
    this.name = 'OutlineContractError';
    this.outlineError = error;
  }
}

export function outlineError(
  code: OutlineErrorCode,
  category: OutlineErrorCategory,
  message: string,
  options: Pick<OutlineError, 'details' | 'next'> & { retryable?: boolean } = {},
): OutlineError {
  return {
    code,
    category,
    message,
    retryable: options.retryable ?? false,
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.next === undefined ? {} : { next: options.next }),
  };
}
