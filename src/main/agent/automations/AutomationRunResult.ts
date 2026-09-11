import { createHash } from 'node:crypto';
import type { AutomationRun } from '../../../core/agent/automation';
import type { ScheduledRunResult } from '../../../core/agent/scheduledResult';
import type { Turn } from '../../../core/agent/protocol';
import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';

const ANSWER_PREVIEW_LIMIT = 32_000;
export interface ScheduledResultReader {
  additionalTurns?(run: AutomationRun): readonly Turn[];
  readTurn(threadId: string, turnId: string): Turn | null;
  recordPath(threadId: string): Promise<string | null>;
  acknowledged(automationRunId: string, issueKey: string): boolean;
}

export async function scheduledRunResult(run: AutomationRun, reader: ScheduledResultReader): Promise<ScheduledRunResult> {
  let state: ScheduledRunResult['state'] = run.state === 'pending' ? 'waiting'
    : run.state === 'failed' ? 'blocked' : run.state === 'omitted' ? 'omitted' : 'unavailable';
  let answer: string | null = null;
  let parts: ScheduledRunResult['parts'] = [];
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let recordPath: string | null = null;
  let issue: string | null = run.error;
  let resultTurnId = run.turnId;
  if (run.state === 'dispatched' && run.threadId && run.turnId) {
    try {
      const original = reader.readTurn(run.threadId, run.turnId);
      let turn = original;
      const trigger = original?.provenance.trigger;
      if (turn && trigger?.kind === 'feature' && trigger.feature === 'automation' && trigger.ref === run.id) {
        let turns: readonly Turn[] = [turn];
        try { turns = [turn, ...(reader.additionalTurns?.(run) ?? [])].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id)); } catch { /* Original execution evidence remains available. */ }
        turn = turns.at(-1)!;
        resultTurnId = turn.id;
        state = turn.status === 'inProgress' ? 'running' : turn.status;
        startedAt = turn.startedAt;
        finishedAt = turn.completedAt;
        const delivery = [...turns].reverse().find((entry) => turnTerminalAnswer(entry.items));
        answer = delivery ? turnTerminalAnswer(delivery.items) : null;
        let remaining = ANSWER_PREVIEW_LIMIT;
        parts = (delivery?.items ?? []).flatMap((item) => {
          if (item.type !== 'agentMessage' || (item.phase !== null && item.phase !== 'final_answer') || remaining <= 0) return [];
          const text = item.text.trim().slice(0, remaining);
          remaining -= text.length + 2;
          return text ? [{ text, itemId: item.id, turnId: delivery!.id, finalCitations: item.finalCitations ?? [] }] : [];
        });
        issue = turn.error?.message ?? (state === 'interrupted' ? 'Execution was interrupted.'
          : state === 'completed' && !answer ? 'Execution ended without a delivered answer.' : null);
        if (state === 'completed' && !answer) state = 'unavailable';
        if (turn.itemsView !== 'full') {
          answer = null; parts = [];
          if (state !== 'running') {
            state = 'unavailable';
            issue = 'Complete outcome evidence is unavailable.';
          }
        }
      } else issue = 'The original execution outcome is unavailable.';
    } catch {
      // An inspection problem is not a failure of the original execution.
      issue = 'The original execution outcome is unavailable.';
    }
    try { recordPath = await reader.recordPath(run.threadId); } catch { /* Shared source remains unavailable. */ }
  }
  const issueKey = issue === null ? null : createHash('sha256')
    .update(JSON.stringify([run.id, run.turnId, state, finishedAt, issue])).digest('hex');
  let acknowledged = false;
  try { acknowledged = issueKey !== null && reader.acknowledged(run.id, issueKey); } catch { /* An attention marker cannot erase canonical outcome evidence. */ }
  return { run, state, resultTurnId, parts, answer: answer?.slice(0, ANSWER_PREVIEW_LIMIT) ?? null,
    answerTruncated: (answer?.length ?? 0) > ANSWER_PREVIEW_LIMIT, startedAt, finishedAt, recordPath, issue, issueKey,
    acknowledged };
}
