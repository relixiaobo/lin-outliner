import type { TaskContinuation, TaskControlReceipt } from '../../../core/agent/taskContinuation';

/** Guidance describes receipt facts; it never reconstructs their historical cause. */
export function taskControlInstructions(receipt: TaskControlReceipt): string {
  switch (receipt.status) {
    case 'accepted':
      return 'This exact operation was accepted. An identical replay returns the same historical receipt, not a new mutation. Acceptance does not establish current process liveness, application health, or new repair/restart authority.';
    case 'already_handled':
      return 'This event already has a handler. Do not acknowledge it again or create another handling operation. No new responsibility was transferred. Inspect current Task state only if the user request still needs it.';
    case 'conflict':
      return 'The operation was not accepted. Its historical cause is unknown: current stopped state cannot prove why an earlier operation conflicted. Inspect task_status for this Task and operation_id before deciding whether a new operation is applicable. A changed operation_id alone does not resolve the conflict. The receipt does not identify its historical cause; current state may have changed. A stopped/completed service cannot receive a new handoff; that is a current precondition, not the cause of the historical refusal. Do not restart or adopt another process from this result.';
  }
}

export function taskStatusInstructions(state: string, continuation: TaskContinuation | null, operation: TaskControlReceipt | null): string {
  const reconciliation = operation
    ? `Recorded operation receipt (historical): ${taskControlInstructions(operation)} `
    : '';
  const event = continuation?.event;
  const eventGuidance = event?.disposition === 'pending'
    ? 'If this Turn is handling the pending terminal result, acknowledge its exact event_id before reporting it. '
    : 'There is no pending terminal event to acknowledge in this observation. Do not acknowledge a handled, admitted or silent event. ';
  const outcome = state === 'running' || state === 'settling'
    ? 'Running/settling is not application readiness. Verify requested behavior before service handoff; retain any explicit watch. Avoid unchanged polling.'
    : 'Exit facts describe this execution only. Exit zero does not establish that an application remains available or that another process belongs to this Task. Without an independent current application check, availability is unknown, not proven unavailable. Inspect the authorized target before recommending another launch; an ended Task alone does not justify replacement. Evaluate the requested outcome separately; no repair/restart authority is granted.';
  return reconciliation + eventGuidance + outcome;
}
