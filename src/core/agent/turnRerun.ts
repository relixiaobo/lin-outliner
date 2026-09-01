import {
  HOST_RESTART_ERROR_CODE,
  SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE,
  type TurnError,
  type TurnStatus,
} from './protocol';

/** Whether replaying the same canonical Turn input could produce a new result. */
export function isRerunnableTurn(turn: {
  readonly status: TurnStatus;
  readonly error: TurnError | null;
}): boolean {
  if (turn.status === 'interrupted') return turn.error?.code === HOST_RESTART_ERROR_CODE;
  return turn.status === 'failed' && turn.error?.code !== SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE;
}
