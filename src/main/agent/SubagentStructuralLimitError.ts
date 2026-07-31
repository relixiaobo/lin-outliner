import { SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE } from '../../core/agent/protocol';

export const SUBAGENT_DEPTH_LIMIT_ERROR_NAME = 'SubagentDepthLimitError';
export const SUBAGENT_SPAWN_LIMIT_ERROR_NAME = 'SubagentSpawnLimitError';

export class SubagentDepthLimitError extends Error {
  readonly code = SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE;

  constructor(limit: number) {
    super(
      `Subagent depth limit reached (maximum depth ${limit}); a Thread at depth ${limit} cannot spawn another child. `
      + 'Continue in the current Thread or return the work to its parent.',
    );
    this.name = SUBAGENT_DEPTH_LIMIT_ERROR_NAME;
  }
}

export class SubagentSpawnLimitError extends Error {
  readonly code = SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE;

  constructor(limit: number) {
    super(
      `Subagent spawn limit reached (maximum ${limit} children per Thread); this Thread cannot spawn another child. `
      + 'Reuse an existing child or return the work to its parent.',
    );
    this.name = SUBAGENT_SPAWN_LIMIT_ERROR_NAME;
  }
}

export function isSubagentStructuralLimitError(
  error: unknown,
): error is SubagentDepthLimitError | SubagentSpawnLimitError {
  return error instanceof Error
    && (error.name === SUBAGENT_DEPTH_LIMIT_ERROR_NAME || error.name === SUBAGENT_SPAWN_LIMIT_ERROR_NAME);
}
