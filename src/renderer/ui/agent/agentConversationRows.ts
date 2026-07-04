import type { AssistantMessage } from '../../../core/agentTypes';
import type {
  AgentConversationEntry,
  AgentMessageEntry,
  AgentHiddenTurnBoundaryEntry,
  AgentTurnPhase,
} from '../../agent/runtime';

export type AssistantEntry = AgentMessageEntry & { message: AssistantMessage };

export interface AgentConversationRenderRow {
  key: string;
  contentKey?: string;
  entry: AgentConversationEntry;
  endIndex: number;
  isLastInTurn: boolean;
  sourceSeqs: number[];
  streaming: boolean;
  /** Authoritative interrupted verdict for this assistant turn (from the run's real status). */
  turnInterrupted: boolean;
  turnPhase: AgentTurnPhase;
}

export function isBoundaryEntry(entry: AgentConversationEntry): boolean {
  return entry.kind === 'compaction' || entry.kind === 'context-clear' || entry.kind === 'dream';
}

export function getEntryRole(entry: AgentConversationEntry): 'user' | 'assistant' | 'system' {
  if (entry.kind === 'hidden-turn-boundary') return 'system';
  return isBoundaryEntry(entry) ? 'system' : (entry as AgentMessageEntry).message.role;
}

export function getEntryTimestamp(entry: AgentConversationEntry): number {
  if (entry.kind === 'hidden-turn-boundary') return entry.timestamp;
  if (entry.kind === 'dream') return entry.status === 'active' ? entry.dream.startedAt : entry.dream.createdAt;
  if (entry.kind === 'context-clear') return entry.contextClear.createdAt;
  if (entry.kind !== 'compaction') return entry.message.timestamp;
  return entry.status === 'active' ? entry.compaction.startedAt : entry.compaction.createdAt;
}

function isAssistantEntry(entry: AgentConversationEntry): entry is AssistantEntry {
  return entry.kind === 'message' && entry.message.role === 'assistant';
}

export function isTurnBoundaryEntry(entry: AgentConversationEntry): boolean {
  if (entry.kind === 'hidden-turn-boundary') return true;
  return isBoundaryEntry(entry) || (entry as AgentMessageEntry).message.role === 'user';
}

function isHiddenTurnBoundaryEntry(entry: AgentConversationEntry): entry is AgentHiddenTurnBoundaryEntry {
  return entry.kind === 'hidden-turn-boundary';
}

// Channel relay puts back-to-back assistant turns from DIFFERENT agents in the
// transcript; merging across that seam would attribute one agent's words to
// another. The streaming placeholder (actor null) merges with anything.
export function sameAssistantActor(left: AssistantEntry, right: AssistantEntry): boolean {
  const leftAgentId = left.actor?.type === 'agent' ? left.actor.agentId : null;
  const rightAgentId = right.actor?.type === 'agent' ? right.actor.agentId : null;
  if (leftAgentId === null || rightAgentId === null) return true;
  return leftAgentId === rightAgentId;
}

export function mergeAssistantEntries(entries: AssistantEntry[]): AgentMessageEntry {
  const lastEntry = entries[entries.length - 1]!;
  // A multi-run turn (e.g. reactive-compaction retry: run-1 overflows, run-2
  // produces the answer) merges into one row, so its "Worked for …" must reflect
  // the WHOLE turn. Sum each DISTINCT run's wall-clock — spreading only the last
  // entry would drop the earlier runs' time entirely. Entries sharing a runId
  // count once; a run still without a sealed duration contributes nothing.
  const durationByRun = new Map<string, number>();
  for (const entry of entries) {
    if (entry.runId !== null && entry.runDurationMs !== null) {
      durationByRun.set(entry.runId, entry.runDurationMs);
    }
  }
  const runDurationMs = durationByRun.size > 0
    ? [...durationByRun.values()].reduce((sum, ms) => sum + ms, 0)
    : lastEntry.runDurationMs;
  const directSubRunsById = new Map(
    entries.flatMap((entry) => entry.directSubRuns ?? []).map((run) => [run.id, run] as const),
  );
  return {
    ...lastEntry,
    runDurationMs,
    directSubRuns: directSubRunsById.size > 0 ? [...directSubRunsById.values()] : lastEntry.directSubRuns,
    message: {
      ...lastEntry.message,
      content: entries.flatMap((entry) => entry.message.content),
    },
  };
}

function assistantActorKey(entry: AssistantEntry): string {
  if (entry.actor?.type === 'agent') return `agent:${entry.actor.agentId}`;
  if (entry.actor?.type === 'user') return `user:${entry.actor.userId}`;
  if (entry.actor?.type === 'tool') return `tool:${entry.actor.toolCallId}`;
  if (entry.actor?.type === 'system') return 'system';
  return 'actor:none';
}

function assistantTurnStableKey(entries: readonly AssistantEntry[]): string {
  const runId = entries.find((entry) => entry.runId)?.runId;
  if (runId) return `assistant-turn-run:${runId}`;
  const first = entries[0]!;
  return `assistant-turn-${first.message.timestamp}:${assistantActorKey(first)}`;
}

function uniqueAssistantTurnStableKey(
  baseKey: string,
  firstEntry: AssistantEntry,
  seenKeys: Map<string, number>,
): string {
  const count = seenKeys.get(baseKey) ?? 0;
  seenKeys.set(baseKey, count + 1);
  if (count === 0) return baseKey;
  return `${baseKey}:${firstEntry.id}`;
}

export function buildConversationRenderRows(
  entries: AgentConversationEntry[],
  turnPhase: AgentTurnPhase,
): AgentConversationRenderRow[] {
  const rows: AgentConversationRenderRow[] = [];
  const assistantTurnKeyCounts = new Map<string, number>();

  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;

    if (isHiddenTurnBoundaryEntry(entry)) {
      index += 1;
      continue;
    }

    if (isAssistantEntry(entry)) {
      const assistantEntries: AssistantEntry[] = [];
      while (index < entries.length) {
        const candidate = entries[index]!;
        if (!isAssistantEntry(candidate)) break;
        if (assistantEntries.length > 0 && !sameAssistantActor(assistantEntries[0]!, candidate)) break;
        assistantEntries.push(candidate);
        index += 1;
      }

      const stableKey = uniqueAssistantTurnStableKey(
        assistantTurnStableKey(assistantEntries),
        assistantEntries[0]!,
        assistantTurnKeyCounts,
      );
      const mergedEntry = assistantEntries.length >= 2
        ? mergeAssistantEntries(assistantEntries)
        : assistantEntries[0]!;
      const endIndex = index - 1;
      rows.push(buildConversationRenderRow({
        contentKey: stableKey,
        entry: mergedEntry,
        endIndex,
        key: stableKey,
        sourceSeqs: assistantEntries.flatMap((entry) => entry.sourceSeqs ?? (typeof entry.sourceSeq === 'number' ? [entry.sourceSeq] : [])),
        turnPhase,
        totalEntryCount: entries.length,
        nextEntry: entries[endIndex + 1],
      }));
      continue;
    }

    rows.push(buildConversationRenderRow({
      entry,
      endIndex: index,
      key: isBoundaryEntry(entry)
        ? entry.id
        : (entry as AgentMessageEntry).nodeId ?? `${entry.kind}-${getEntryTimestamp(entry)}-${index}`,
      sourceSeqs: entry.kind === 'message'
        ? entry.sourceSeqs ?? (typeof entry.sourceSeq === 'number' ? [entry.sourceSeq] : [])
        : [],
      turnPhase,
      totalEntryCount: entries.length,
      nextEntry: entries[index + 1],
    }));
    index += 1;
  }

  return rows;
}

function buildConversationRenderRow({
  contentKey,
  entry,
  endIndex,
  key,
  nextEntry,
  sourceSeqs,
  totalEntryCount,
  turnPhase,
}: {
  contentKey?: string;
  entry: AgentConversationEntry;
  endIndex: number;
  key: string;
  nextEntry: AgentConversationEntry | undefined;
  sourceSeqs: number[];
  totalEntryCount: number;
  turnPhase: AgentTurnPhase;
}): AgentConversationRenderRow {
  const isLastAssistantEntry = endIndex === totalEntryCount - 1 && getEntryRole(entry) === 'assistant';
  // A turn ends at this row when the next entry is a different role OR — in a
  // channel, where back-to-back assistant turns come from different agents — a
  // different assistant actor. Without the actor check the first agent's final
  // message would be denied its action bar because the next agent's turn is also
  // `assistant`.
  const nextIsSameTurn =
    !!nextEntry &&
    getEntryRole(nextEntry) === getEntryRole(entry) &&
    (!isAssistantEntry(entry) || !isAssistantEntry(nextEntry) || sameAssistantActor(entry, nextEntry));
  return {
    key,
    contentKey,
    entry,
    endIndex,
    isLastInTurn: endIndex === totalEntryCount - 1 || !nextIsSameTurn,
    sourceSeqs,
    streaming: isLastAssistantEntry && turnPhase === 'streaming_text',
    turnInterrupted: entry.kind === 'message' ? entry.turnInterrupted : false,
    turnPhase: isLastAssistantEntry ? turnPhase : 'idle',
  };
}
