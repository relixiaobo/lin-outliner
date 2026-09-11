import { createHash } from 'node:crypto';
import type { AutomationRun } from '../../../core/agent/automation';
import type { ScheduledRunResult } from '../../../core/agent/scheduledResult';
import type { Turn } from '../../../core/agent/protocol';
import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';

const ANSWER_PREVIEW_LIMIT = 32_000;
export interface ScheduledResultReader {
  stopping?(run: AutomationRun): boolean;
  resourceIssues?(run: AutomationRun): readonly { key: string; text: string; turnId: string; terminal: boolean }[];
  additionalTurns?(run: AutomationRun): readonly Turn[];
  readTurn(threadId: string, turnId: string): Turn | null;
  recordPath(threadId: string): Promise<string | null>;
  acknowledged(automationRunId: string, issueKey: string): boolean;
}

/** A rebuildable view: outcome, availability and exact issue acknowledgement stay independent. */
export async function scheduledRunResult(run: AutomationRun, reader: ScheduledResultReader): Promise<ScheduledRunResult> {
  let state: ScheduledRunResult['state'] = run.state === 'pending' ? 'waiting'
    : run.state === 'failed' ? 'blocked' : run.state === 'omitted' ? 'omitted' : 'unavailable';
  let answer: string | null = null;
  let parts: ScheduledRunResult['parts'] = [];
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let recordPath: string | null = null;
  let resultTurnId = run.turnId;
  const issues: Array<ScheduledRunResult['issues'][number]> = [];
  const addIssue = (text: string, turnId: string | null, status: string, finished: number | null, terminal = true) => {
    const key = createHash('sha256').update(JSON.stringify([run.id, turnId, status, finished, text])).digest('hex');
    if (issues.some((issue) => issue.key === key)) return;
    let acknowledged = false;
    try { acknowledged = reader.acknowledged(run.id, key); } catch { /* Marker availability is not execution evidence. */ }
    issues.push({ key, text: text.slice(0, 32_768), turnId, terminal, acknowledged });
  };
  if (run.error) addIssue(run.error, run.turnId, state, null, run.state !== 'pending');
  if (run.state === 'dispatched' && run.threadId && run.turnId) {
    let original: Turn | null = null;
    try { original = reader.readTurn(run.threadId, run.turnId); } catch { /* Preserve unavailable as its own outcome. */ }
    const trigger = original?.provenance.trigger;
    if (original && trigger?.kind === 'feature' && trigger.feature === 'automation' && trigger.ref === run.id) {
      let additional: readonly Turn[] = [];
      try { additional = reader.additionalTurns?.(run) ?? []; } catch { /* Optional update inspection cannot erase the original evidence. */ }
      const turns = [...new Map([original, ...additional].map((turn) => [turn.id, turn])).values()]
        .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
      const latest = turns.at(-1)!;
      resultTurnId = latest.id;
      state = latest.status === 'inProgress' ? 'running' : latest.status;
      startedAt = original.startedAt;
      finishedAt = latest.completedAt;
      for (const turn of turns) {
        if (turn.status === 'failed') addIssue(turn.error?.message || 'Execution failed.', turn.id, 'failed', turn.completedAt);
        else if (turn.status === 'interrupted') addIssue(turn.error?.message || 'Execution was interrupted.', turn.id, 'interrupted', turn.completedAt);
        else if (turn.status === 'completed' && !turnTerminalAnswer(turn.items)) {
          addIssue('Execution ended without a delivered answer.', turn.id, 'empty', turn.completedAt);
        }
      }
      const delivery = [...turns].reverse().find((turn) => turn.itemsView === 'full' && turnTerminalAnswer(turn.items));
      answer = delivery ? turnTerminalAnswer(delivery.items) : null;
      let remaining = ANSWER_PREVIEW_LIMIT;
      parts = (delivery?.items ?? []).flatMap((item) => {
        if (item.type !== 'agentMessage' || (item.phase !== null && item.phase !== 'final_answer') || remaining <= 0) return [];
        const text = item.text.trim().slice(0, remaining);
        remaining -= text.length + 2;
        return text ? [{ text, itemId: item.id, turnId: delivery!.id, finalCitations: item.finalCitations ?? [] }] : [];
      });
      if (latest.status === 'completed' && !turnTerminalAnswer(latest.items)) state = 'unavailable';
      if (latest.itemsView !== 'full' && latest.status !== 'inProgress') {
        state = 'unavailable';
        addIssue('Complete outcome evidence is unavailable.', latest.id, 'unavailable', latest.completedAt);
      }
    } else addIssue('The original execution outcome is unavailable.', run.turnId, 'unavailable', null);
    try { recordPath = await reader.recordPath(run.threadId); } catch { /* The shared source remains unavailable. */ }
  }
  try {
    for (const issue of reader.resourceIssues?.(run) ?? []) addIssue(issue.text, issue.turnId, issue.key, null, issue.terminal);
  } catch { addIssue('Background work state is unavailable.', run.turnId, 'resources_unavailable', null, false); }
  try {
    if (reader.stopping?.(run)) { state = 'stopping'; finishedAt = null; }
  } catch {
    addIssue('Background work state is unavailable.', run.turnId, 'resources_unavailable', null, false);
  }
  const shown = issues.find((issue) => !issue.acknowledged) ?? issues.at(-1) ?? null;
  return { run, state, resultTurnId, parts, issues, answer: answer?.slice(0, ANSWER_PREVIEW_LIMIT) ?? null,
    answerTruncated: (answer?.length ?? 0) > ANSWER_PREVIEW_LIMIT, startedAt, finishedAt, recordPath,
    issue: shown?.text ?? null, issueKey: shown?.key ?? null, acknowledged: shown?.acknowledged ?? false };
}
