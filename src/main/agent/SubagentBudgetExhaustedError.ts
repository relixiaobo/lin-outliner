export const SUBAGENT_BUDGET_EXHAUSTED_ERROR_NAME = 'SubagentBudgetExhaustedError';

export class SubagentBudgetExhaustedError extends Error {
  constructor(tokensUsed: number, tokenBudget: number) {
    super(
      `Subagent token budget exhausted (${tokensUsed} of ${tokenBudget} tokens); the child refuses new work. `
      + 'Interrupt, review its output, or spawn a fresh child.',
    );
    this.name = SUBAGENT_BUDGET_EXHAUSTED_ERROR_NAME;
  }
}

export function isSubagentBudgetExhaustedError(error: unknown): error is Error {
  return error instanceof Error && error.name === SUBAGENT_BUDGET_EXHAUSTED_ERROR_NAME;
}
