import { SUBAGENT_STRUCTURAL_LIMIT_ERROR_CODE } from '../../core/agent/protocol';

export const SUBAGENT_DEPTH_LIMIT_ERROR_NAME = 'SubagentDepthLimitError';

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
