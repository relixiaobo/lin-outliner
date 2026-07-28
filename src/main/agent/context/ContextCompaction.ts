import type {
  ActiveObservationCheckpointEntry,
  CompactionRestoredStateContextPayload,
  CompactionSummaryContextPayload,
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
import { reduceSkillContext } from './SkillContextReducer';
import { reduceRoleContext } from './RoleContextReducer';
import { cursorFor, selectEffectiveContext } from './ContextEpoch';
import { toolItemVisibleOutputText, type HistoryToolItem } from './ContextProjector';
import { readInheritedContextPayload } from './InheritedContext';
import { assertContextPayloadDependencies } from './contextDependencies';

const MAX_FALLBACK_SUMMARY_CHARS = 24_000;

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
    throw new Error(
      `Compaction preserve cursor is unreachable: ${input.preserveFrom.turnId}/${input.preserveFrom.itemId}`,
    );
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
      source: 'fallback',
      text: await fallbackSummary(rebuildLocatedTurns(summarized), input.readContext),
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
  const invocationRefs = await activeSkillPayloadRefs(turns, readContext);
  const roleState = await reduceRoleContext(turns, readContext);
  const selected = selectEffectiveContext(turns).turns;
  const userViewBaselineRef = await latestUserViewBaselineRef(selected, readContext);
  const activeSkills = [...skillState.activeInvocations.values()]
    .map((skill) => {
      const payloadRef = invocationRefs.get(skill.name);
      if (!payloadRef) throw new Error(`Active Skill payload reference is unavailable: ${skill.name}`);
      return {
        name: skill.name,
        identity: skill.identity,
        contentHash: skill.contentHash,
        payloadRef,
      };
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
    activeObservations: await reduceActiveObservations(turns, readContext),
  };
}

async function activeSkillPayloadRefs(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
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
        const inheritedRefs = await activeSkillPayloadRefs(inherited.turns, readContext);
        replaceMap(refs, inheritedRefs);
        continue;
      }
      if (item.type === 'contextCompaction') {
        refs.clear();
        const restored = await readRestoredState(item, readContext);
        for (const skill of restored.activeSkills) refs.set(skill.name, skill.payloadRef);
        continue;
      }
      if (item.type !== 'contextEvidence' || item.kind !== 'skillInvocation') continue;
      const payload = await readContext(item.payloadRef);
      if (!payload || payload.kind !== 'skillInvocation') {
        throw new Error(`Skill invocation payload is unavailable: ${item.payloadRef.id}`);
      }
      if (payload.execution === 'inline') refs.set(payload.name, item.payloadRef);
    }
  }
  return refs;
}

async function reduceActiveObservations(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<ActiveObservationCheckpointEntry[]> {
  const selected = selectEffectiveContext(turns).turns;
  const projections = await collectToolOutputProjectionRefs(selected, readContext);
  const active = new Map<string, ActiveObservationCheckpointEntry>();
  for (const turn of selected) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        active.clear();
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        const inheritedActive = await reduceActiveObservations(inherited.turns, readContext);
        replaceEntries(active, inheritedActive, (entry) => entry.key);
        continue;
      }
      if (item.type === 'contextCompaction') {
        const restored = await readRestoredState(item, readContext);
        replaceEntries(active, restored.activeObservations, (entry) => entry.key);
        continue;
      }
      const invalidation = observationInvalidation(item);
      for (const invalidated of invalidation.keys) active.delete(invalidated);
      if (invalidation.clearNodeObservations) {
        for (const key of active.keys()) {
          if (key.startsWith('node:')) active.delete(key);
        }
      }
      if (!isHistoryTool(item) || !item.outputRef) continue;
      const projectionRef = projections.get(item.outputRef.id);
      if (!projectionRef) continue;
      for (const identity of observationIdentities(item)) {
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
): Promise<Map<string, ThreadContextPayloadReference>> {
  const projections = new Map<string, ThreadContextPayloadReference>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        const nested = await collectToolOutputProjectionRefs(
          selectEffectiveContext(inherited.turns).turns,
          readContext,
        );
        for (const [outputId, ref] of nested) setProjectionRef(projections, outputId, ref);
        continue;
      }
      if (item.type === 'contextCompaction') {
        const restored = await readRestoredState(item, readContext);
        for (const observation of restored.activeObservations) {
          setProjectionRef(projections, observation.outputRef.id, observation.projectionRef);
        }
        continue;
      }
      if (item.type !== 'contextEvidence' || item.kind !== 'toolOutputProjection') continue;
      const payload = await readContext(item.payloadRef);
      if (!payload || payload.kind !== 'toolOutputProjection') {
        throw new Error(`Tool-output projection is unavailable: ${item.payloadRef.id}`);
      }
      setProjectionRef(projections, payload.outputRef.id, item.payloadRef);
    }
  }
  return projections;
}

async function latestUserViewBaselineRef(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
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
        baseline = await latestUserViewBaselineRef(
          selectEffectiveContext(inherited.turns).turns,
          readContext,
        );
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'userView') {
        baseline = item.payloadRef;
        continue;
      }
      if (item.type === 'contextCompaction') {
        baseline = (await readRestoredState(item, readContext)).userViewBaselineRef;
      }
    }
  }
  return baseline;
}

async function readRestoredState(
  item: Extract<ThreadItem, { readonly type: 'contextCompaction' }>,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<CompactionRestoredStateContextPayload> {
  const restored = await readContext(item.restoredStateRef);
  if (!restored || restored.kind !== 'compactionRestoredState') {
    throw new Error(`Compaction restored-state checkpoint is unavailable: ${item.restoredStateRef.id}`);
  }
  assertContextPayloadDependencies(item, restored);
  return restored;
}

function setProjectionRef(
  projections: Map<string, ThreadContextPayloadReference>,
  outputId: string,
  ref: ThreadContextPayloadReference,
): void {
  const previous = projections.get(outputId);
  if (previous && previous.id !== ref.id) {
    throw new Error(`Tool output has conflicting frozen projections: ${outputId}`);
  }
  projections.set(outputId, ref);
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

function observationIdentities(item: HistoryToolItem): Array<{ key: string; tool: string; subject: string }> {
  if (item.type !== 'dynamicToolCall' || item.namespace !== null || item.status !== 'completed') return [];
  const args = isRecord(item.arguments) ? item.arguments : {};
  if (item.tool === 'file_read') {
    const path = stringArgument(args, ['file_path', 'path']);
    return path ? [{ key: `file:${path}`, tool: item.tool, subject: path }] : [];
  }
  if (item.tool === 'node_read') {
    const nodeIds = uniqueStrings([
      ...stringArguments(args, ['node_ids', 'nodeIds']),
      ...singleStringArguments(args, ['node_id', 'nodeId', 'id']),
    ]);
    return nodeIds.map((nodeId) => ({
      key: `node:${nodeId}`,
      tool: item.tool,
      subject: nodeId,
    }));
  }
  return [];
}

interface ObservationInvalidation {
  readonly keys: readonly string[];
  readonly clearNodeObservations: boolean;
}

function observationInvalidation(item: ThreadItem): ObservationInvalidation {
  if (item.type === 'fileChange') {
    return {
      keys: item.status === 'completed'
        ? item.changes.flatMap((change) => [
            `file:${change.path}`,
            ...(change.movedTo ? [`file:${change.movedTo}`] : []),
          ])
        : [],
      clearNodeObservations: false,
    };
  }
  if (item.type !== 'dynamicToolCall' || item.namespace !== null) return noObservationInvalidation();
  const args = isRecord(item.arguments) ? item.arguments : {};
  if (item.status !== 'completed' || item.success !== true) return noObservationInvalidation();
  if (isFileMutation(item.tool)) {
    const path = stringArgument(args, ['file_path', 'path']);
    return { keys: path ? [`file:${path}`] : [], clearNodeObservations: false };
  }
  if (isNodeMutation(item.tool) && args.preview_only !== true) {
    return { keys: [], clearNodeObservations: true };
  }
  if (item.tool === 'outline_undo_stack' && (args.action === 'undo' || args.action === 'redo')) {
    return { keys: [], clearNodeObservations: true };
  }
  return noObservationInvalidation();
}

async function fallbackSummary(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<string> {
  const lines: string[] = ['This is a lossy fallback summary of earlier canonical context.'];
  for (const turn of turns) {
    for (const item of turn.items) {
      const line = await summaryLine(item, readContext);
      if (!line) continue;
      lines.push(line);
      if (lines.join('\n').length >= MAX_FALLBACK_SUMMARY_CHARS) {
        lines.push('[Summary truncated at the deterministic fallback limit.]');
        return lines.join('\n').slice(0, MAX_FALLBACK_SUMMARY_CHARS);
      }
    }
  }
  return lines.join('\n');
}

async function summaryLine(
  item: ThreadItem,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
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
    case 'contextEvidence': return `Context: ${item.summary}`;
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
  if (item.type === 'collabAgentToolCall') return `collaboration.${item.tool}`;
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

function noObservationInvalidation(): ObservationInvalidation {
  return { keys: [], clearNodeObservations: false };
}

function catalogCheckpoint(
  entry: Pick<ContextCatalogCheckpointEntry, 'name' | 'identity' | 'contentHash'>,
): ContextCatalogCheckpointEntry {
  return { name: entry.name, identity: entry.identity, contentHash: entry.contentHash };
}

function uniqueContextRefs(refs: readonly ThreadContextPayloadReference[]): ThreadContextPayloadReference[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

function uniqueOutputRefs(refs: readonly ThreadItemOutputReference[]): ThreadItemOutputReference[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
