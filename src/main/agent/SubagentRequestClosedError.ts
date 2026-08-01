import type { TurnId } from '../../core/agent/protocol';

export const SUBAGENT_REQUEST_CLOSED_ERROR_NAME = 'SubagentRequestClosedError';

/**
 * The user stopped the request this work belongs to.
 *
 * Refuses admission only — it never terminalizes a Turn, so it needs no
 * `Turn.error.code`: members that were running were interrupted by the same
 * Stop and settle as `interrupted`.
 */
export class SubagentRequestClosedError extends Error {
  readonly name = SUBAGENT_REQUEST_CLOSED_ERROR_NAME;

  constructor(readonly originTurnId: TurnId) {
    super(
      'The user stopped this delegation request; it accepts no new work. '
      + 'Report what the completed children returned, or wait for the next instruction.',
    );
  }
}

export function isSubagentRequestClosedError(error: unknown): error is SubagentRequestClosedError {
  return error instanceof Error && error.name === SUBAGENT_REQUEST_CLOSED_ERROR_NAME;
}
