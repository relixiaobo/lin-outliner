// IPC channel names and envelopes for the action seam.
//
// Four inbound messages, all bounded: open an invocation from a sender-checked
// seed, query one parameter slot, request one action, and name one lifecycle
// transition. One outbound push: a renderer step, which main emits only after
// the preceding main step succeeded and whose ack it waits for.

import type { EffectStep } from './bindings';

export const ACTION_OPEN_CHANNEL = 'action:open';
export const ACTION_OBJECT_QUERY_CHANNEL = 'action:objectQuery';
export const ACTION_PARAMETER_QUERY_CHANNEL = 'action:parameterQuery';
export const ACTION_REQUEST_CHANNEL = 'action:request';
export const ACTION_EVENT_CHANNEL = 'action:event';
/** main -> launcher: the opening main created for this summon. */
export const ACTION_OPENED_CHANNEL = 'action:opened';
/** main -> launcher: the authoritative replacement ambient presentation. */
export const ACTION_AMBIENT_CHANGED_CHANNEL = 'action:ambientChanged';
/** main -> renderer */
export const ACTION_STEP_CHANNEL = 'action:step';
/** renderer -> main */
export const ACTION_STEP_ACK_CHANNEL = 'action:stepAck';

export interface ActionStepEnvelope {
  token: string;
  invocationRef: string;
  step: EffectStep;
}

export type ActionStepAck =
  | { token: string; status: 'ok' }
  | { token: string; status: 'reported'; code: string };

/** Main gives up waiting for an ack after this; the result is INDETERMINATE. */
export const ACTION_STEP_ACK_TIMEOUT_MS = 5_000;
