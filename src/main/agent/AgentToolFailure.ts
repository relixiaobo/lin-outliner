/** A recoverable domain refusal that a model-facing tool can act on. */
export class AgentToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instructions: string,
  ) {
    super(message);
    this.name = 'AgentToolFailure';
  }
}
