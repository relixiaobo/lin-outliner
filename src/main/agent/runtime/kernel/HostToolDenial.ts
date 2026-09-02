import type { JsonValue } from '../../../../core/agent/protocol';

export interface HostToolDenialInput {
  readonly code: string;
  readonly message: string;
  readonly instructions?: string;
  readonly details: JsonValue;
}

/** Private control flow for a refusal produced by Tenon's execution policy. */
export class HostToolDenial extends Error {
  constructor(readonly denial: HostToolDenialInput) {
    super(denial.message);
    this.name = 'HostToolDenial';
  }
}
