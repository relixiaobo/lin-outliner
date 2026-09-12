import { decodeAgentFinalCitationBinding } from './codec';
import type { AgentFinalCitationBinding } from './protocol';
import type { AutomationRun } from './automation';
import { decodeAutomationRun } from './automation';

export const SCHEDULED_RESULT_STATES = ['waiting', 'running', 'stopping', 'completed', 'blocked', 'failed', 'interrupted', 'omitted', 'unavailable'] as const;
export type ScheduledResultState = typeof SCHEDULED_RESULT_STATES[number];

/** Rebuilt from canonical execution owners. Never stored as a second outcome ledger. */
export interface ScheduledRunResult {
  readonly run: AutomationRun;
  readonly state: ScheduledResultState;
  readonly resultTurnId: string | null;
  readonly answer: string | null;
  readonly parts: readonly { readonly text: string; readonly turnId: string; readonly itemId: string; readonly finalCitations: readonly AgentFinalCitationBinding[] }[];
  readonly answerTruncated: boolean;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly recordPath: string | null;
  readonly issues: readonly { readonly key: string; readonly text: string; readonly turnId: string | null; readonly terminal: boolean; readonly acknowledged: boolean }[];
  readonly issue: string | null;
  readonly issueKey: string | null;
  readonly acknowledged: boolean;
}

export function decodeScheduledRunResult(value: unknown): ScheduledRunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scheduled result');
  const row = value as Record<string, unknown>;
  const keys = ['run', 'state', 'resultTurnId', 'answer', 'parts', 'issues', 'answerTruncated', 'startedAt', 'finishedAt', 'recordPath', 'issue', 'issueKey', 'acknowledged'];
  if (Object.keys(row).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(row, key))) throw new Error('Invalid scheduled result fields');
  if (!SCHEDULED_RESULT_STATES.includes(row.state as ScheduledResultState)) throw new Error('Invalid scheduled outcome');
  for (const key of ['answer', 'recordPath', 'issue', 'issueKey', 'resultTurnId']) if (row[key] !== null && typeof row[key] !== 'string') throw new Error(`Invalid ${key}`);
  for (const key of ['startedAt', 'finishedAt']) if (row[key] !== null && (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0)) throw new Error(`Invalid ${key}`);
  for (const key of ['answerTruncated', 'acknowledged']) if (typeof row[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  if (!Array.isArray(row.issues)) throw new Error('Invalid scheduled issues');
  const issues = row.issues.map((issue: unknown) => {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('Invalid scheduled issue');
    const value = issue as Record<string, unknown>;
    if (Object.keys(value).some((key) => !['key', 'text', 'turnId', 'terminal', 'acknowledged'].includes(key))
      || typeof value.key !== 'string' || typeof value.text !== 'string' || (value.turnId !== null && typeof value.turnId !== 'string')
      || typeof value.terminal !== 'boolean' || typeof value.acknowledged !== 'boolean') throw new Error('Invalid scheduled issue fields');
    return value;
  });
  if (!Array.isArray(row.parts)) throw new Error('Invalid scheduled answer parts');
  const parts = row.parts.map((part: unknown) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Invalid answer part');
    const value = part as Record<string, unknown>;
    if (Object.keys(value).some((key) => !['text', 'turnId', 'itemId', 'finalCitations'].includes(key))
      || typeof value.text !== 'string' || typeof value.turnId !== 'string' || typeof value.itemId !== 'string'
      || !Array.isArray(value.finalCitations)) throw new Error('Invalid answer part fields');
    return { text: value.text, turnId: value.turnId, itemId: value.itemId,
      finalCitations: value.finalCitations.map((citation, index) => decodeAgentFinalCitationBinding(citation, `parts.finalCitations[${index}]`)) };
  });
  return { ...row, parts, issues, run: decodeAutomationRun(row.run) } as unknown as ScheduledRunResult;
}
