import type {
  ActiveObservationCheckpointEntry,
  CompactionRestoredStateContextPayload,
  CompactionSummaryContextPayload,
  ContextDegradationCheckpointEntry,
  ContextCatalogCheckpointEntry,
  ContextCursor,
  ContextEvidenceThreadItem,
  SkillInvocationContextPayload,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  Turn,
} from '../../../core/agent/protocol';
import { modelCallArgumentSource } from '../../../core/agent/modelCallHistory';
import { reduceSkillContext } from './SkillContextReducer';
import { reduceRoleContext } from './RoleContextReducer';
import { cursorFor, selectEffectiveContext } from './ContextEpoch';
import { toolItemVisibleOutputText, type HistoryToolItem } from './ContextProjector';
import { readInheritedContextPayload } from './InheritedContext';
import {
  appendContextDegradations,
  contextDegradation,
  recordContextDegradation,
} from './ContextDegradation';
import {
  assertContextPayloadDependencies,
  contextPayloadReferenceKey,
  outputReferenceKey,
} from './contextDependencies';

const MAX_DETERMINISTIC_SUMMARY_CHARS = 24_000;
const DETERMINISTIC_SUMMARY_PREAMBLE = 'This is a deterministic lossy summary of earlier canonical context.';
const DETERMINISTIC_SUMMARY_TRUNCATION = '[Earlier Turns omitted at the deterministic summary limit.]';
const DETERMINISTIC_ENTRY_TRUNCATION = '\n[Turn content truncated at the deterministic summary limit.]\n';

export interface ContextCompactionPlan {
  readonly coveredFrom: ContextCursor;
  readonly coveredThrough: ContextCursor;
  readonly preservedFrom: ContextCursor | null;
  readonly summary: CompactionSummaryContextPayload;
  readonly restoredState: CompactionRestoredStateContextPayload;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
}

export async function planContextCompaction(input: {
  readonly turns: readonly Turn[];
  readonly preserveFrom?: ContextCursor | null;
  readonly readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>;
}): Promise<ContextCompactionPlan | null> {
  const selected = selectEffectiveContext(input.turns).turns;
  const located = selected.flatMap((turn) => turn.items.map((item) => ({ turn, item })));
  const preserveIndex = input.preserveFrom
    ? located.findIndex(({ turn, item }) => (
        turn.id === input.preserveFrom!.turnId && item.id === input.preserveFrom!.itemId
      ))
    : -1;
  if (input.preserveFrom && preserveIndex < 0) {
    console.warn(
      `[agent] Skipping compaction with unreachable preserve cursor: ${input.preserveFrom.turnId}/${input.preserveFrom.itemId}`,
    );
    return null;
  }
  const summarized = preserveIndex < 0 ? located : located.slice(0, preserveIndex);
  const visible = summarized.filter(({ item }) => isCompactionEligibleItem(item));
  if (visible.length === 0) return null;

  const first = located[0]!;
  const last = summarized.at(-1)!;
  const restoredTurns = input.preserveFrom
    ? turnsBeforeCursor(input.turns, input.preserveFrom)
    : input.turns;
  const restoredState = await buildCompactionRestoredState(restoredTurns, input.readContext);
  const contextRefs = uniqueContextRefs([
    ...restoredState.activeSkills.map((entry) => entry.payloadRef),
    ...(restoredState.userViewBaselineRef ? [restoredState.userViewBaselineRef] : []),
    ...(restoredState.additionalContextBaselineRef ? [restoredState.additionalContextBaselineRef] : []),
    ...restoredState.activeObservations.map((entry) => entry.projectionRef),
  ]);
  const outputRefs = uniqueOutputRefs(restoredState.activeObservations.map((entry) => entry.outputRef));
  return {
    coveredFrom: cursorFor(first.turn, first.item),
    coveredThrough: cursorFor(last.turn, last.item),
    preservedFrom: preserveIndex < 0 ? null : cursorFor(located[preserveIndex]!.turn, located[preserveIndex]!.item),
    summary: {
      schemaVersion: 1,
      kind: 'compactionSummary',
      source: 'deterministic',
      text: await deterministicSummary(rebuildLocatedTurns(summarized), input.readContext),
    },
    restoredState,
    contextRefs,
    outputRefs,
  };
}

function rebuildLocatedTurns(located: readonly { readonly turn: Turn; readonly item: ThreadItem }[]): Turn[] {
  const byTurn = new Map<string, { turn: Turn; items: ThreadItem[] }>();
  for (const entry of located) {
    const state = byTurn.get(entry.turn.id) ?? { turn: entry.turn, items: [] };
    state.items.push(entry.item);
    byTurn.set(entry.turn.id, state);
  }
  return [...byTurn.values()].map(({ turn, items }) => ({ ...turn, items }));
}

function turnsBeforeCursor(turns: readonly Turn[], cursor: ContextCursor): Turn[] {
  const turnIndex = turns.findIndex((turn) => turn.id === cursor.turnId);
  const itemIndex = turnIndex < 0
    ? -1
    : turns[turnIndex]!.items.findIndex((item) => item.id === cursor.itemId);
  if (turnIndex < 0 || itemIndex < 0) {
    throw new Error(`Compaction preserve cursor is unreachable: ${cursor.turnId}/${cursor.itemId}`);
  }
  return [
    ...turns.slice(0, turnIndex),
    ...(itemIndex > 0
      ? [{ ...turns[turnIndex]!, items: turns[turnIndex]!.items.slice(0, itemIndex) }]
      : []),
  ];
}

async function buildCompactionRestoredState(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<CompactionRestoredStateContextPayload> {
  const skillState = await reduceSkillContext(turns, readContext);
  const roleState = await reduceRoleContext(turns, readContext);
  const degradations: ContextDegradationCheckpointEntry[] = [];
  appendContextDegradations(degradations, skillState.degradations);
  appendContextDegradations(degradations, roleState.degradations);
  const invocationRefs = await activeSkillPayloadRefs(turns, readContext, degradations);
  const selected = selectEffectiveContext(turns).turns;
  const userViewBaselineRef = await latestUserViewBaselineRef(selected, readContext, degradations);
  const additionalContextBaselineRef = await latestAdditionalContextBaselineRef(
    selected,
    readContext,
    degradations,
  );
  const activeSkills = [...skillState.activeInvocations.values()]
    .flatMap((skill) => {
      const payloadRef = invocationRefs.get(skill.name);
      if (!payloadRef) {
        recordContextDegradation(
          degradations,
          contextDegradation('payloadUnavailable', 'skillInvocation', skill.name),
        );
        return [];
      }
      return [{
        name: skill.name,
        identity: skill.identity,
        contentHash: skill.contentHash,
        payloadRef,
      }];
    })
    .sort((left, right) => compareStableText(left.name, right.name));
  return {
    schemaVersion: 1,
    kind: 'compactionRestoredState',
    skillCatalogHash: skillState.catalogHash,
    announcedSkills: [...skillState.catalogEntries.values()]
      .map(catalogCheckpoint)
      .sort((left, right) => compareStableText(left.name, right.name)),
    activeSkills,
    roleCatalogHash: roleState.catalogHash,
    announcedRoles: [...roleState.catalogEntries.values()]
      .map(catalogCheckpoint)
      .sort((left, right) => compareStableText(left.name, right.name)),
    userViewBaselineRef,
    additionalContextBaselineRef,
    activeObservations: await reduceActiveObservations(turns, readContext, degradations),
    degradations: degradations.sort(compareContextDegradation),
  };
}

async function activeSkillPayloadRefs(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  degradations: ContextDegradationCheckpointEntry[],
): Promise<Map<string, ThreadContextPayloadReference>> {
  const refs = new Map<string, ThreadContextPayloadReference>();
  for (const turn of selectEffectiveContext(turns).turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        refs.clear();
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (!inherited) {
          refs.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id),
          );
          continue;
        }
        const inheritedRefs = await activeSkillPayloadRefs(inherited.turns, readContext, degradations);
        replaceMap(refs, inheritedRefs);
        continue;
      }
      if (item.type === 'contextCompaction') {
        refs.clear();
        const restored = await readRestoredState(item, readContext, degradations);
        if (!restored) continue;
        for (const skill of restored.activeSkills) refs.set(skill.name, skill.payloadRef);
        continue;
      }
      if (item.type !== 'contextEvidence' || item.kind !== 'skillInvocation') continue;
      const payload = await readContext(item.payloadRef).catch(() => null);
      if (!payload || payload.kind !== 'skillInvocation') {
        recordContextDegradation(
          degradations,
          contextDegradation('payloadUnavailable', 'skillInvocation', item.payloadRef.id),
        );
        continue;
      }
      if (payload.execution === 'inline') refs.set(payload.name, item.payloadRef);
    }
  }
  return refs;
}

async function reduceActiveObservations(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  degradations: ContextDegradationCheckpointEntry[],
): Promise<ActiveObservationCheckpointEntry[]> {
  const selected = selectEffectiveContext(turns).turns;
  const projections = await collectToolOutputProjectionRefs(selected, readContext, degradations);
  const active = new Map<string, ActiveObservationCheckpointEntry>();
  for (const turn of selected) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        active.clear();
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (!inherited) {
          active.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id),
          );
          continue;
        }
        const inheritedActive = await reduceActiveObservations(inherited.turns, readContext, degradations);
        replaceEntries(active, inheritedActive, (entry) => entry.key);
        continue;
      }
      if (item.type === 'contextCompaction') {
        const restored = await readRestoredState(item, readContext, degradations);
        if (!restored) {
          active.clear();
          continue;
        }
        appendContextDegradations(degradations, restored.degradations);
        replaceEntries(active, restored.activeObservations, (entry) => entry.key);
        continue;
      }
      const resolvedArguments = needsObservationArguments(item)
        ? await canonicalToolArguments(item, readContext)
        : null;
      const invalidation = observationInvalidation(item, resolvedArguments);
      for (const invalidated of invalidation.keys) active.delete(invalidated);
      if (invalidation.clearNodeObservations || invalidation.clearFileObservations) {
        for (const key of active.keys()) {
          if (
            (invalidation.clearNodeObservations && key.startsWith('node:'))
            || (invalidation.clearFileObservations && key.startsWith('file:'))
          ) active.delete(key);
        }
      }
      if (!isHistoryTool(item) || !item.outputRef || !resolvedArguments) continue;
      const projectionRef = projections.get(outputReferenceKey(item.outputRef));
      if (!projectionRef) {
        recordContextDegradation(
          degradations,
          contextDegradation(
            'payloadUnavailable',
            'toolOutputProjection',
            outputReferenceKey(item.outputRef),
          ),
        );
        continue;
      }
      for (const identity of observationIdentities(item, resolvedArguments)) {
        active.set(identity.key, {
          key: identity.key,
          tool: identity.tool,
          subject: identity.subject,
          outputRef: item.outputRef,
          projectionRef,
        });
      }
    }
  }
  return [...active.values()].sort((left, right) => compareStableText(left.key, right.key));
}

async function collectToolOutputProjectionRefs(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  degradations: ContextDegradationCheckpointEntry[],
  projections = new Map<string, ThreadContextPayloadReference>(),
  conflicting = new Set<string>(),
): Promise<Map<string, ThreadContextPayloadReference>> {
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        projections.clear();
        conflicting.clear();
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (!inherited) {
          projections.clear();
          conflicting.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id),
          );
          continue;
        }
        await collectToolOutputProjectionRefs(
          selectEffectiveContext(inherited.turns).turns,
          readContext,
          degradations,
          projections,
          conflicting,
        );
        continue;
      }
      if (item.type === 'contextCompaction') {
        projections.clear();
        conflicting.clear();
        const restored = await readRestoredState(item, readContext, degradations);
        if (!restored) continue;
        appendContextDegradations(degradations, restored.degradations);
        for (const observation of restored.activeObservations) {
          setProjectionRef(
            projections,
            conflicting,
            outputReferenceKey(observation.outputRef),
            observation.projectionRef,
            degradations,
          );
        }
        continue;
      }
      if (item.type !== 'contextEvidence' || item.kind !== 'toolOutputProjection') continue;
      const payload = await readContext(item.payloadRef).catch(() => null);
      if (!payload || payload.kind !== 'toolOutputProjection') {
        console.warn(`[agent] Compaction skipped unavailable tool-output projection: ${item.payloadRef.id}`);
        for (const ref of item.outputRefs) projections.delete(outputReferenceKey(ref));
        recordContextDegradation(
          degradations,
          contextDegradation('payloadUnavailable', 'toolOutputProjection', item.payloadRef.id),
        );
        continue;
      }
      setProjectionRef(
        projections,
        conflicting,
        outputReferenceKey(payload.outputRef),
        item.payloadRef,
        degradations,
      );
    }
  }
  return projections;
}

async function latestUserViewBaselineRef(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  degradations: ContextDegradationCheckpointEntry[],
): Promise<ThreadContextPayloadReference | null> {
  let baseline: ThreadContextPayloadReference | null = null;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        baseline = null;
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (!inherited) {
          baseline = null;
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id),
          );
          continue;
        }
        baseline = await latestUserViewBaselineRef(
          selectEffectiveContext(inherited.turns).turns,
          readContext,
          degradations,
        );
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'userView') {
        const payload = await readContext(item.payloadRef).catch(() => null);
        if (!payload || payload.kind !== 'userView') {
          baseline = null;
          recordContextDegradation(
            degradations,
            contextDegradation(
              payload ? 'payloadInvalid' : 'payloadUnavailable',
              'userView',
              item.payloadRef.id,
            ),
          );
        } else {
          baseline = item.payloadRef;
        }
        continue;
      }
      if (item.type === 'contextCompaction') {
        baseline = (await readRestoredState(item, readContext, degradations))?.userViewBaselineRef ?? null;
      }
    }
  }
  return baseline;
}

async function latestAdditionalContextBaselineRef(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  degradations: ContextDegradationCheckpointEntry[],
): Promise<ThreadContextPayloadReference | null> {
  let baseline: ThreadContextPayloadReference | null = null;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        baseline = null;
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (!inherited) {
          baseline = null;
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id),
          );
          continue;
        }
        baseline = await latestAdditionalContextBaselineRef(
          selectEffectiveContext(inherited.turns).turns,
          readContext,
          degradations,
        );
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'additionalContext') {
        const payload = await readContext(item.payloadRef).catch(() => null);
        if (!payload || payload.kind !== 'additionalContext') {
          baseline = null;
          recordContextDegradation(
            degradations,
            contextDegradation(
              payload ? 'payloadInvalid' : 'payloadUnavailable',
              'additionalContext',
              item.payloadRef.id,
            ),
          );
          continue;
        }
        if (payload.threadState !== null) baseline = item.payloadRef;
        continue;
      }
      if (item.type === 'contextCompaction') {
        baseline = (await readRestoredState(item, readContext, degradations))?.additionalContextBaselineRef ?? null;
      }
    }
  }
  return baseline;
}

async function readRestoredState(
  item: Extract<ThreadItem, { readonly type: 'contextCompaction' }>,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  degradations: ContextDegradationCheckpointEntry[],
): Promise<CompactionRestoredStateContextPayload | null> {
  const restored = await readContext(item.restoredStateRef).catch(() => null);
  if (!restored || restored.kind !== 'compactionRestoredState') {
    recordContextDegradation(
      degradations,
      contextDegradation(
        restored ? 'payloadInvalid' : 'payloadUnavailable',
        'compactionRestoredState',
        item.restoredStateRef.id,
      ),
    );
    return null;
  }
  try {
    assertContextPayloadDependencies(item, restored);
  } catch {
    recordContextDegradation(
      degradations,
      contextDegradation('payloadInvalid', 'compactionRestoredState', item.restoredStateRef.id),
    );
    return null;
  }
  return restored;
}

function setProjectionRef(
  projections: Map<string, ThreadContextPayloadReference>,
  conflicting: Set<string>,
  outputKey: string,
  ref: ThreadContextPayloadReference,
  degradations: ContextDegradationCheckpointEntry[],
): void {
  if (conflicting.has(outputKey)) return;
  const previous = projections.get(outputKey);
  if (previous && previous.id !== ref.id) {
    console.warn(`[agent] Compaction skipped conflicting tool-output projections: ${outputKey}`);
    projections.delete(outputKey);
    conflicting.add(outputKey);
    recordContextDegradation(
      degradations,
      contextDegradation('projectionConflict', 'toolOutputProjection', outputKey),
    );
    return;
  }
  projections.set(outputKey, ref);
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function replaceEntries<K, V>(
  target: Map<K, V>,
  source: readonly V[],
  keyOf: (value: V) => K,
): void {
  target.clear();
  for (const value of source) target.set(keyOf(value), value);
}

function observationIdentities(
  item: HistoryToolItem,
  resolvedArguments: CanonicalToolArgumentsResolution,
): Array<{ key: string; tool: string; subject: string }> {
  if (item.status !== 'completed' || item.modelCall.identity?.namespace !== null) return [];
  if (resolvedArguments.kind !== 'canonical') return [];
  const args = resolvedArguments.value;
  const tool = item.modelCall.identity.name;
  if (tool === 'file_read') {
    const path = stringArgument(args, ['file_path', 'path']);
    return path ? [{ key: `file:${path}`, tool, subject: path }] : [];
  }
  if (tool === 'node_read') {
    const nodeIds = uniqueStrings([
      ...stringArguments(args, ['node_ids', 'nodeIds']),
      ...singleStringArguments(args, ['node_id', 'nodeId', 'id']),
    ]);
    return nodeIds.map((nodeId) => ({
      key: `node:${nodeId}`,
      tool,
      subject: nodeId,
    }));
  }
  return [];
}

interface ObservationInvalidation {
  readonly keys: readonly string[];
  readonly clearNodeObservations: boolean;
  readonly clearFileObservations: boolean;
}

function observationInvalidation(
  item: ThreadItem,
  resolvedArguments: CanonicalToolArgumentsResolution | null,
): ObservationInvalidation {
  if (item.type === 'fileChange') {
    return {
      keys: item.status === 'completed'
        ? item.changes.flatMap((change) => [
            `file:${change.path}`,
            ...(change.movedTo ? [`file:${change.movedTo}`] : []),
          ])
        : [],
      clearNodeObservations: false,
      clearFileObservations: false,
    };
  }
  if (item.type !== 'dynamicToolCall' || item.modelCall.identity?.namespace !== null) {
    return noObservationInvalidation();
  }
  if (item.status !== 'completed' || item.success !== true) return noObservationInvalidation();
  const tool = item.modelCall.identity.name;
  const args = resolvedArguments?.value ?? null;
  if (isFileMutation(tool)) {
    const path = args ? stringArgument(args, ['file_path', 'path']) : null;
    return {
      keys: path ? [`file:${path}`] : [],
      clearNodeObservations: false,
      clearFileObservations: path === null,
    };
  }
  if (isNodeMutation(tool) && args?.preview_only !== true) {
    return { keys: [], clearNodeObservations: true, clearFileObservations: false };
  }
  if (
    tool === 'outline_undo_stack'
    && (!args || args.action === 'undo' || args.action === 'redo')
  ) {
    return { keys: [], clearNodeObservations: true, clearFileObservations: false };
  }
  return noObservationInvalidation();
}

type CanonicalToolArgumentsResolution =
  | { readonly kind: 'canonical'; readonly value: Record<string, unknown> }
  | { readonly kind: 'summary'; readonly value: Record<string, unknown> }
  | { readonly kind: 'unavailable'; readonly value: null };

async function canonicalToolArguments(
  item: HistoryToolItem,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<CanonicalToolArgumentsResolution> {
  if (item.modelCall.disposition === 'evidenceOnly') {
    return isRecord(item.modelCall.redactedArgumentsSummary)
      ? { kind: 'summary', value: item.modelCall.redactedArgumentsSummary }
      : { kind: 'unavailable', value: null };
  }
  const source = modelCallArgumentSource(item.modelCall);
  let value: import('../../../core/agent/protocol').JsonValue | null;
  if (source.storage === 'inline') {
    value = source.value;
  } else {
    const payload = await readContext(source.ref).catch(() => null);
    value = payload?.kind === 'toolCallArguments' ? payload.value : null;
  }
  return isRecord(value)
    ? { kind: 'canonical', value }
    : { kind: 'unavailable', value: null };
}

async function deterministicSummary(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  inheritedPath: ReadonlySet<string> = new Set(),
): Promise<string> {
  const turnSummaries: string[] = [];
  for (const turn of turns) {
    const lines: string[] = [];
    for (const item of turn.items) {
      const line = await summaryLine(item, readContext, inheritedPath);
      if (!line) continue;
      lines.push(line);
    }
    if (lines.length > 0) turnSummaries.push(lines.join('\n'));
  }
  const complete = [DETERMINISTIC_SUMMARY_PREAMBLE, ...turnSummaries].join('\n');
  if (complete.length <= MAX_DETERMINISTIC_SUMMARY_CHARS) return complete;

  const prefix = `${DETERMINISTIC_SUMMARY_PREAMBLE}\n${DETERMINISTIC_SUMMARY_TRUNCATION}\n`;
  const available = MAX_DETERMINISTIC_SUMMARY_CHARS - prefix.length;
  let retained = '';
  for (let index = turnSummaries.length - 1; index >= 0; index -= 1) {
    const turnSummary = turnSummaries[index]!;
    const candidate = retained ? `${turnSummary}\n${retained}` : turnSummary;
    if (candidate.length > available) {
      if (!retained) retained = truncateSummaryEntry(turnSummary, available);
      break;
    }
    retained = candidate;
  }
  return `${prefix}${retained}`;
}

function truncateSummaryEntry(value: string, available: number): string {
  if (value.length <= available) return value;
  if (available <= DETERMINISTIC_ENTRY_TRUNCATION.length) {
    return DETERMINISTIC_ENTRY_TRUNCATION.slice(0, available);
  }
  const contentBudget = available - DETERMINISTIC_ENTRY_TRUNCATION.length;
  const leadingLength = Math.ceil(contentBudget / 2);
  const trailingLength = contentBudget - leadingLength;
  const trailing = trailingLength > 0 ? value.slice(-trailingLength) : '';
  return `${value.slice(0, leadingLength)}${DETERMINISTIC_ENTRY_TRUNCATION}${trailing}`;
}

async function summaryLine(
  item: ThreadItem,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  inheritedPath: ReadonlySet<string>,
): Promise<string | null> {
  switch (item.type) {
    case 'userMessage':
      return `User: ${item.content.map((part) => part.type === 'text' ? part.text : part.type === 'attachment'
        ? `[Attachment: ${part.name}]`
        : `[Outliner Node: ${part.nodeId}]`).join('\n')}`;
    case 'agentMessage': return item.text ? `Assistant: ${item.text}` : null;
    case 'reasoning': return item.summary.length > 0 ? `Reasoning summary: ${item.summary.join(' ')}` : null;
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch':
      return `Tool ${toolLabel(item)}: ${item.outputRef?.summary ?? toolItemVisibleOutputText(item)}`;
    case 'contextEvidence': {
      if (item.kind !== 'inheritedContext') return `Context: ${item.summary}`;
      const key = contextPayloadReferenceKey(item.payloadRef);
      if (inheritedPath.has(key)) return `Context: ${item.summary}\n[Recursive inherited context omitted.]`;
      const inherited = await readInheritedContextPayload(item, readContext);
      if (!inherited) {
        return `Context: ${item.summary}\n[Inherited context unavailable: ${item.payloadRef.id}]`;
      }
      const nestedPath = new Set(inheritedPath);
      nestedPath.add(key);
      return `Context: ${item.summary}\n${await deterministicSummary(inherited.turns, readContext, nestedPath)}`;
    }
    case 'contextCompaction': {
      const prior = await readContext(item.summaryRef);
      return prior?.kind === 'compactionSummary' ? `Earlier compacted context: ${prior.text}` : 'Earlier compacted context.';
    }
    case 'subAgentActivity': return `Subagent ${item.kind}: ${item.agentPath}`;
    case 'imageView': return `Viewed image: ${item.path}`;
    case 'contextReset': return null;
  }
}

function toolLabel(item: HistoryToolItem): string {
  if (item.type === 'mcpToolCall') return `${item.server}.${item.tool}`;
  if (item.type === 'dynamicToolCall') return item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
  if (item.type === 'collabAgentToolCall') return item.tool;
  return item.type;
}

function isCompactionEligibleItem(item: ThreadItem): boolean {
  return item.type !== 'contextReset'
    && item.type !== 'contextCompaction'
    && !(item.type === 'contextEvidence' && item.kind === 'toolOutputProjection');
}

function isHistoryTool(item: ThreadItem): item is HistoryToolItem {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch';
}

function isFileMutation(tool: string): boolean {
  return tool === 'file_write' || tool === 'file_edit' || tool === 'file_delete' || tool === 'file_move';
}

function isNodeMutation(tool: string): boolean {
  return tool === 'node_create' || tool === 'node_edit' || tool === 'node_delete';
}

function needsObservationArguments(item: ThreadItem): item is HistoryToolItem {
  if (item.type !== 'dynamicToolCall' || item.modelCall.identity?.namespace !== null) return false;
  const tool = item.modelCall.identity.name;
  return tool === 'file_read'
    || tool === 'node_read'
    || tool === 'outline_undo_stack'
    || isFileMutation(tool)
    || isNodeMutation(tool);
}

function noObservationInvalidation(): ObservationInvalidation {
  return { keys: [], clearNodeObservations: false, clearFileObservations: false };
}

function catalogCheckpoint(
  entry: Pick<ContextCatalogCheckpointEntry, 'name' | 'identity' | 'contentHash'>,
): ContextCatalogCheckpointEntry {
  return { name: entry.name, identity: entry.identity, contentHash: entry.contentHash };
}

function uniqueContextRefs(refs: readonly ThreadContextPayloadReference[]): ThreadContextPayloadReference[] {
  return [...new Map(refs.map((ref) => [contextPayloadReferenceKey(ref), ref])).values()];
}

function uniqueOutputRefs(refs: readonly ThreadItemOutputReference[]): ThreadItemOutputReference[] {
  return [...new Map(refs.map((ref) => [outputReferenceKey(ref), ref])).values()];
}

function stringArgument(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function singleStringArguments(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const value = stringArgument(record, keys);
  return value ? [value] : [];
}

function stringArguments(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    return value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry] : []);
  }
  return [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareContextDegradation(
  left: ContextDegradationCheckpointEntry,
  right: ContextDegradationCheckpointEntry,
): number {
  return compareStableText(
    `${left.code}\u0000${left.source}\u0000${left.reference}`,
    `${right.code}\u0000${right.source}\u0000${right.reference}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
