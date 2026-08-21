import type {
  CollabAgentToolCallThreadItem,
  ContextEvidenceThreadItem,
  JsonValue,
  Thread,
  ThreadId,
  ThreadItem,
  ThreadItemId,
  ThreadTrajectoryAvailability,
  ThreadTrajectoryDetailReadRequest,
  ThreadTrajectoryDetailReadResponse,
  ThreadTrajectoryDiagnosticsEvidence,
  ThreadTrajectoryEvidenceRef,
  ThreadTrajectoryItemEvidence,
  ThreadTrajectoryProviderCallEvidence,
  ThreadTrajectoryReadRequest,
  ThreadTrajectoryReadResponse,
  ThreadTrajectoryRecordKind,
  ThreadTrajectoryRecordSummary,
  ThreadTrajectoryRuntimeEvidence,
  ThreadTrajectorySummary,
  ThreadTrajectoryTimingSummary,
  ThreadTrajectoryTurnEvidence,
  ThreadTrajectoryUsageSummary,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
} from '../../../core/agent/protocol';
import { ThreadCore } from './ThreadCore';

const DEFAULT_TRAJECTORY_LIMIT = 100;
const MAX_TRAJECTORY_LIMIT = 250;
const PREVIEW_LIMIT = 240;
const MAX_DETAIL_TEXT_LENGTH = 20_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ARRAY_LENGTH = 500;
const MAX_JSON_OBJECT_KEYS = 500;

type DiagnosticsBundle = {
  readonly ref: TurnDiagnosticsPayloadReference;
  readonly payload: TurnDiagnosticsPayload;
};

interface LoadedTurn {
  readonly threadId: ThreadId;
  readonly turn: Turn;
  readonly diagnostics: DiagnosticsBundle | null;
  readonly availability: readonly ThreadTrajectoryAvailability[];
}

interface BuiltTrajectory {
  readonly thread: Thread;
  readonly turns: readonly LoadedTurn[];
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly summary: ThreadTrajectorySummary;
}

interface ThreadTrajectoryThreadEvidence {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly forkedFromId: ThreadId | null;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly name: string | null;
  readonly preview: string;
  readonly ephemeral: boolean;
  readonly source: string;
  readonly threadSource: Thread['threadSource'];
  readonly modelProvider: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: Thread['status'];
  readonly historyMode: Thread['historyMode'];
}

export interface ThreadTrajectoryExportBundle {
  readonly schemaVersion: 1;
  readonly exportedAt: number;
  readonly thread: ThreadTrajectoryThreadEvidence;
  readonly summary: ThreadTrajectorySummary;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly diagnostics: readonly {
    readonly turnId: string;
    readonly ref: TurnDiagnosticsPayloadReference;
    readonly payload: JsonValue;
  }[];
}

export class ThreadTrajectoryProjection {
  constructor(private readonly core: ThreadCore, private readonly now: () => number = Date.now) {}

  async read(request: ThreadTrajectoryReadRequest): Promise<ThreadTrajectoryReadResponse> {
    const built = await this.build(request.threadId);
    const records = pageTrajectoryRecords(built.records, request);
    const selectedRecordId = selectRecordId(records.data, built.records, request);
    return {
      threadId: request.threadId,
      summary: built.summary,
      records: records.data,
      nextCursor: records.nextCursor,
      hasMore: records.nextCursor !== null,
      selectedRecordId,
    };
  }

  async readDetail(request: ThreadTrajectoryDetailReadRequest): Promise<ThreadTrajectoryDetailReadResponse> {
    const built = await this.build(request.threadId);
    const record = built.records.find((candidate) => candidate.id === request.recordId) ?? null;
    if (!record) return { threadId: request.threadId, record: null, detail: null };
    const loaded = built.turns.find((candidate) => candidate.turn.id === record.turnId) ?? null;
    if (!loaded) return { threadId: request.threadId, record, detail: null };
    const detail = await this.detailForRecord(record, loaded);
    return { threadId: request.threadId, record, detail };
  }

  async exportBundle(threadId: ThreadId): Promise<ThreadTrajectoryExportBundle> {
    const built = await this.build(threadId);
    return {
      schemaVersion: 1,
      exportedAt: this.now(),
      thread: threadEvidence(built.thread),
      summary: built.summary,
      records: built.records,
      diagnostics: built.turns.flatMap((entry) => entry.diagnostics
        ? [{
          turnId: entry.turn.id,
          ref: entry.diagnostics.ref,
          payload: sanitizeJsonEvidence(entry.diagnostics.payload),
        }]
        : []),
    };
  }

  private async build(threadId: ThreadId): Promise<BuiltTrajectory> {
    const thread = this.core.requireThread(threadId).thread;
    const turns = await Promise.all(this.core.allTurns(threadId).map(async (turn): Promise<LoadedTurn> => {
      const diagnostics = await this.readDiagnostics(threadId, turn);
      return {
        threadId,
        turn,
        diagnostics: diagnostics.bundle,
        availability: diagnostics.availability,
      };
    }));
    const records: ThreadTrajectoryRecordSummary[] = [];
    for (const loaded of turns) {
      appendTurnRecords(records, loaded);
    }
    return {
      thread,
      turns,
      records,
      summary: summarizeTrajectory(threadId, turns, records),
    };
  }

  private async readDiagnostics(
    threadId: ThreadId,
    turn: Turn,
  ): Promise<{
    readonly bundle: DiagnosticsBundle | null;
    readonly availability: readonly ThreadTrajectoryAvailability[];
  }> {
    const ref = turn.execution.diagnosticsRef;
    if (!ref) {
      return {
        bundle: null,
        availability: turn.status === 'inProgress'
          ? []
          : [availability('diagnosticsUnavailable', 'Turn diagnostics were not retained for this Turn.')],
      };
    }
    try {
      const payload = await this.core.payloads.readTurnDiagnostics(threadId, ref);
      if (!payload) {
        return {
          bundle: null,
          availability: [availability('diagnosticsUnavailable', 'Turn diagnostics are no longer available.')],
        };
      }
      return { bundle: { ref, payload }, availability: [] };
    } catch {
      return {
        bundle: null,
        availability: [availability('diagnosticsCorrupt', 'Turn diagnostics could not be decoded.')],
      };
    }
  }

  private async detailForRecord(
    record: ThreadTrajectoryRecordSummary,
    loaded: LoadedTurn,
  ): Promise<ThreadTrajectoryDetailReadResponse['detail']> {
    const turn = turnEvidence(loaded.turn);
    const diagnostics = loaded.diagnostics;
    if (record.kind === 'input') {
      const activityIndex = diagnosticActivityIndex(record.primaryEvidence);
      const itemIds = activityIndex === null
        ? relatedItemIds(record)
        : inputActivityItemIds(diagnostics?.payload, activityIndex);
      return {
        kind: 'input',
        turn,
        items: evidenceForItems(loaded.turn, itemIds),
        diagnostics: diagnosticsEvidence(diagnostics, activityIndex, null),
        activityIndex,
      };
    }
    if (record.kind === 'context') {
      const item = itemForEvidence(loaded.turn, record.primaryEvidence);
      return {
        kind: 'context',
        turn,
        item: item ? itemEvidence(item) : null,
        payload: await this.readContextPayload(record.threadId, item),
      };
    }
    if (record.kind === 'assistant') {
      const providerCallIndex = providerCallIndexForEvidence(record.primaryEvidence);
      return {
        kind: 'assistant',
        turn,
        diagnostics: diagnosticsEvidence(diagnostics, null, providerCallIndex ?? 0),
        providerCallIndex: providerCallIndex ?? 0,
        relatedItems: evidenceForItems(loaded.turn, relatedItemIds(record)),
      };
    }
    if (record.kind === 'tool') {
      const item = itemForToolRecord(loaded.turn, record);
      return {
        kind: 'tool',
        turn,
        item: item ? itemEvidence(item) : null,
        diagnostics: diagnosticsEvidence(diagnostics, diagnosticActivityIndex(record.primaryEvidence), null),
        activityIndex: diagnosticActivityIndex(record.primaryEvidence),
        executionCallId: toolExecutionCallId(record),
        outputText: await this.readToolOutput(record.threadId, item),
      };
    }
    if (record.kind === 'retry') {
      return {
        kind: 'retry',
        turn,
        diagnostics: diagnosticsEvidence(diagnostics, diagnosticActivityIndex(record.primaryEvidence), null),
        activityIndex: diagnosticActivityIndex(record.primaryEvidence),
      };
    }
    if (record.kind === 'compaction') {
      const item = itemForEvidence(loaded.turn, record.primaryEvidence)
        ?? itemForRelatedEvidence(loaded.turn, record);
      return {
        kind: 'compaction',
        turn,
        item: item ? itemEvidence(item) : null,
        diagnostics: diagnosticsEvidence(diagnostics, diagnosticActivityIndex(record.primaryEvidence), null),
        activityIndex: diagnosticActivityIndex(record.primaryEvidence),
      };
    }
    const item = itemForToolRecord(loaded.turn, record);
    return {
      kind: 'delegation',
      turn,
      item: item ? itemEvidence(item) : null,
      diagnostics: diagnosticsEvidence(diagnostics, diagnosticActivityIndex(record.primaryEvidence), null),
      activityIndex: diagnosticActivityIndex(record.primaryEvidence),
      executionCallId: toolExecutionCallId(record),
      childThreadId: record.childThreadId,
    };
  }

  private async readContextPayload(
    threadId: ThreadId,
    item: ThreadItem | null,
  ): Promise<JsonValue | null> {
    if (!item) return null;
    try {
      if (item.type === 'contextEvidence') {
        return sanitizeJsonEvidence(await this.core.payloads.readContext(threadId, item.payloadRef));
      }
      if (item.type === 'contextCompaction') {
        return sanitizeJsonEvidence(await this.core.payloads.readContext(threadId, item.summaryRef));
      }
    } catch {
      return null;
    }
    return null;
  }

  private async readToolOutput(threadId: ThreadId, item: ThreadItem | null): Promise<string | null> {
    if (!item || !('outputRef' in item) || !item.outputRef) return null;
    try {
      const text = await this.core.payloads.readTextReference(threadId, item.outputRef);
      return text === null ? null : sanitizeTextEvidence(text);
    } catch {
      return null;
    }
  }
}

function threadEvidence(thread: Thread): ThreadTrajectoryThreadEvidence {
  return {
    id: thread.id,
    parentThreadId: thread.parentThreadId,
    forkedFromId: thread.forkedFromId,
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
    name: thread.name,
    preview: thread.preview,
    ephemeral: thread.ephemeral,
    source: thread.source,
    threadSource: thread.threadSource,
    modelProvider: thread.modelProvider,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    historyMode: thread.historyMode,
  };
}

function diagnosticsEvidence(
  bundle: DiagnosticsBundle | null,
  activityIndex: number | null,
  providerCallIndex: number | null,
): ThreadTrajectoryDiagnosticsEvidence | null {
  if (!bundle) return null;
  return {
    ref: bundle.ref,
    runtime: runtimeEvidence(bundle.payload.runtime),
    activity: activityIndex === null
      ? null
      : sanitizeJsonEvidence(bundle.payload.activities[activityIndex] ?? null),
    providerCall: providerCallIndex === null
      ? null
      : providerCallDiagnosticsEvidence(bundle.payload.providerCalls[providerCallIndex] ?? null),
  };
}

function runtimeEvidence(runtime: TurnDiagnosticsPayload['runtime']): ThreadTrajectoryRuntimeEvidence {
  return {
    provider: runtime.provider,
    model: runtime.model,
    api: runtime.api,
    transportSelection: runtime.transportSelection,
    contextWindow: runtime.contextWindow,
    maxOutputTokens: runtime.maxOutputTokens,
    thinkingLevel: runtime.thinkingLevel,
    timeoutMs: runtime.timeoutMs,
    maxRetries: runtime.maxRetries,
    maxRetryDelayMs: runtime.maxRetryDelayMs,
    cacheRetention: runtime.cacheRetention,
    toolExecution: runtime.toolExecution,
    steeringMode: runtime.steeringMode,
  };
}

function providerCallDiagnosticsEvidence(
  call: TurnDiagnosticsPayload['providerCalls'][number] | null,
): ThreadTrajectoryProviderCallEvidence | null {
  if (!call) return null;
  return {
    index: call.index,
    requestedAt: call.requestedAt,
    estimatedInputTokens: call.estimatedInputTokens,
    inputTokenLimit: call.inputTokenLimit,
    reservedOutputTokens: call.reservedOutputTokens,
    commonPrefixMessageCount: call.commonPrefixMessageCount,
    requestFingerprint: call.requestFingerprint,
    cacheBreakpoints: call.cacheBreakpoints,
    request: sanitizeJsonEvidence(call.request),
    response: call.response ? sanitizeJsonEvidence(call.response) : null,
    transportResponse: call.transportResponse,
  };
}

function sanitizeJsonEvidence(value: unknown, depth = 0): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string') return sanitizeStringEvidence(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) return '[truncated:depth]';
    const items = value
      .slice(0, MAX_JSON_ARRAY_LENGTH)
      .map((entry) => sanitizeJsonEvidence(entry, depth + 1));
    return value.length > MAX_JSON_ARRAY_LENGTH ? [...items, '[truncated:array]'] : items;
  }
  if (typeof value !== 'object' || value === undefined) return null;
  if (depth >= MAX_JSON_DEPTH) return { truncated: 'depth' };
  const result: Record<string, JsonValue> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_JSON_OBJECT_KEYS) {
      result.truncated = 'object';
      break;
    }
    result[key] = sensitiveEvidenceKey(key) ? '‹redacted›' : sanitizeJsonEvidence(entry, depth + 1);
    count += 1;
  }
  return result;
}

function sanitizeTextEvidence(value: string): string {
  const sanitized = sanitizeStringEvidence(value);
  if (sanitized.length <= MAX_DETAIL_TEXT_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_DETAIL_TEXT_LENGTH)}\n… [truncated]`;
}

function sensitiveEvidenceKey(key: string): boolean {
  return /(^|[-_])(?:authorization|api[-_]?key|token|secret|password|cookie|set[-_]?cookie|headers?|configuredbaseurl|workingdirectory|cwd|path|resource[-_]?root)(?:$|[-_])/iu
    .test(key);
}

function sanitizeStringEvidence(value: string): string {
  if (/^data:image\//iu.test(value) || /^data:application\/octet-stream/iu.test(value)) {
    return '‹binary:redacted›';
  }
  return value
    .replace(/(^|[\s([{"'=])\/(?:Users|private|var|tmp|Volumes|Applications|workspace)(?:\/[^\s'",)\]}<>]+)+/gu, '$1‹path:redacted›')
    .replace(/(^|[\s([{"'=])[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)+/gu, '$1‹path:redacted›');
}

function appendTurnRecords(records: ThreadTrajectoryRecordSummary[], loaded: LoadedTurn): void {
  const { diagnostics, turn } = loaded;
  const itemsById = new Map(turn.items.map((item) => [item.id, item]));
  const coveredCompactionItemIds = new Set<string>();
  let contextInserted = false;

  if (diagnostics) {
    diagnostics.payload.activities.forEach((activity, activityIndex) => {
      if (activity.type === 'acceptedInput') {
        records.push(record({
          kind: 'input',
          lane: 'input',
          threadId: loaded.threadId,
          turn,
          records,
          title: activity.source === 'initial' ? 'Input' : 'Steering',
          subtitle: null,
          preview: compact(activity.itemIds.map((itemId) => itemSummary(itemsById.get(itemId))).filter(Boolean).join(' ')),
          state: 'completed',
          timing: timing(activity.acceptedAt, null, activity.acceptedAt),
          primaryEvidence: diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type),
          relatedEvidence: activity.itemIds.map((itemId) => itemEvidenceRef(loaded.threadId, turn, itemId)),
          availability: loaded.availability,
          childThreadId: null,
          usage: null,
        }));
        if (!contextInserted) {
          appendContextRecords(records, loaded);
          contextInserted = true;
        }
        return;
      }
      if (!contextInserted) {
        appendContextRecords(records, loaded);
        contextInserted = true;
      }
      if (activity.type === 'modelCall') {
        const call = diagnostics.payload.providerCalls[activity.callIndex];
        if (!call) return;
        records.push(record({
          kind: 'assistant',
          lane: 'assistant',
          threadId: loaded.threadId,
          turn,
          records,
          title: `Assistant call ${call.index + 1}`,
          subtitle: `${diagnostics.payload.runtime.provider} · ${diagnostics.payload.runtime.model}`,
          preview: compact(providerResponsePreview(call.response?.value ?? null)),
          state: providerCallState(call, turn),
          timing: timing(call.requestedAt, null, call.response?.receivedAt ?? null),
          primaryEvidence: providerCallEvidence(loaded.threadId, turn, call.index),
          relatedEvidence: relatedAssistantItems(turn, diagnostics.payload)
            .map((item) => itemEvidenceRef(loaded.threadId, turn, item.id)),
          availability: loaded.availability,
          childThreadId: null,
          usage: call.response ? providerUsageSummary(call.response.usage) : null,
        }));
        return;
      }
      if (activity.type === 'toolExecutionBatch') {
        for (const execution of activity.executions) {
          const item = execution.itemId ? itemsById.get(execution.itemId) ?? null : null;
          const delegation = isDelegationExecution(execution.toolName, item);
          records.push(record({
            kind: delegation ? 'delegation' : 'tool',
            lane: 'tools',
            threadId: loaded.threadId,
            turn,
            records,
            title: delegation ? delegationTitle(item, execution.toolName) : toolTitle(item, execution.toolName),
            subtitle: execution.canonicalIdentity
              ? [execution.canonicalIdentity.namespace, execution.canonicalIdentity.name].filter(Boolean).join('.')
              : execution.toolName,
            preview: compact(itemSummary(item) ?? execution.callId),
            state: execution.status === 'inProgress' ? 'running' : execution.status,
            timing: timing(execution.startedAt, null, execution.completedAt),
            primaryEvidence: diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type),
            relatedEvidence: execution.itemId ? [itemEvidenceRef(loaded.threadId, turn, execution.itemId)] : [],
            availability: loaded.availability,
            childThreadId: childThreadIdForItem(item),
            usage: null,
            parentRecordId: assistantRecordId(turn.id, activity.sourceCallIndex),
            toolCallId: execution.callId,
          }));
        }
        return;
      }
      if (activity.type === 'providerRetry') {
        records.push(record({
          kind: 'retry',
          lane: 'assistant',
          threadId: loaded.threadId,
          turn,
          records,
          title: `${activity.retryKind === 'request' ? 'Request' : 'Stream'} retry ${activity.attempt}/${activity.maxRetries}`,
          subtitle: `After assistant call ${activity.sourceCallIndex + 1}`,
          preview: null,
          state: activity.nextCallIndex === null && turn.status === 'failed' ? 'failed' : 'completed',
          timing: timing(activity.occurredAt, null, activity.occurredAt),
          primaryEvidence: diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type),
          relatedEvidence: [
            providerCallEvidence(loaded.threadId, turn, activity.sourceCallIndex),
            ...(activity.nextCallIndex === null ? [] : [
              providerCallEvidence(loaded.threadId, turn, activity.nextCallIndex),
            ]),
          ],
          availability: loaded.availability,
          childThreadId: null,
          usage: null,
          parentRecordId: assistantRecordId(turn.id, activity.sourceCallIndex),
        }));
        return;
      }
      coveredCompactionItemIds.add(activity.itemId);
      records.push(record({
        kind: 'compaction',
        lane: 'input',
        threadId: loaded.threadId,
        turn,
        records,
        title: 'Context compaction',
        subtitle: activity.trigger,
        preview: compact(itemSummary(itemsById.get(activity.itemId)) ?? activity.trigger),
        state: 'completed',
        timing: timing(activity.completedAt, null, activity.completedAt),
        primaryEvidence: diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type),
        relatedEvidence: [itemEvidenceRef(loaded.threadId, turn, activity.itemId)],
        availability: loaded.availability,
        childThreadId: null,
        usage: null,
      }));
    });
    if (!contextInserted) appendContextRecords(records, loaded);
    appendManualCompactionRecords(records, loaded, coveredCompactionItemIds);
    return;
  }

  appendFallbackTurnRecords(records, loaded);
}

function appendFallbackTurnRecords(records: ThreadTrajectoryRecordSummary[], loaded: LoadedTurn): void {
  const userItems = loaded.turn.items.filter((item) => item.type === 'userMessage');
  if (userItems.length > 0) {
    records.push(record({
      kind: 'input',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      records,
      title: 'Input',
      subtitle: null,
      preview: compact(userItems.map(itemSummary).filter(Boolean).join(' ')),
      state: loaded.turn.status === 'inProgress' ? 'running' : 'partial',
      timing: timing(userItems[0]?.acceptedAt ?? loaded.turn.startedAt, null, null),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, userItems[0]!.id),
      relatedEvidence: userItems.map((item) => itemEvidenceRef(loaded.threadId, loaded.turn, item.id)),
      availability: loaded.availability,
      childThreadId: null,
      usage: null,
    }));
  }
  appendContextRecords(records, loaded);
  appendManualCompactionRecords(records, loaded, new Set());
  for (const item of loaded.turn.items) {
    if (!isToolItem(item)) continue;
    const delegation = isDelegationItem(item);
    records.push(record({
      kind: delegation ? 'delegation' : 'tool',
      lane: 'tools',
      threadId: loaded.threadId,
      turn: loaded.turn,
      records,
      title: delegation ? delegationTitle(item, item.type) : toolTitle(item, item.type),
      subtitle: item.type,
      preview: compact(itemSummary(item)),
      state: item.status === 'inProgress' ? 'running' : item.status,
      timing: timing(loaded.turn.startedAt, null, itemCompletedAt(item, loaded.turn)),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, item.id),
      relatedEvidence: [],
      availability: loaded.availability,
      childThreadId: childThreadIdForItem(item),
      usage: null,
    }));
  }
}

function appendContextRecords(records: ThreadTrajectoryRecordSummary[], loaded: LoadedTurn): void {
  for (const item of loaded.turn.items) {
    if (item.type !== 'contextEvidence' && item.type !== 'contextReset') continue;
    records.push(record({
      kind: 'context',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      records,
      title: item.type === 'contextReset' ? 'Context reset' : contextEvidenceTitle(item),
      subtitle: item.type,
      preview: compact(itemSummary(item)),
      state: 'completed',
      timing: timing(loaded.turn.startedAt, null, loaded.turn.startedAt),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, item.id),
      relatedEvidence: [],
      availability: loaded.availability,
      childThreadId: null,
      usage: null,
    }));
  }
}

function appendManualCompactionRecords(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  coveredItemIds: ReadonlySet<string>,
): void {
  for (const item of loaded.turn.items) {
    if (item.type !== 'contextCompaction' || coveredItemIds.has(item.id)) continue;
    records.push(record({
      kind: 'compaction',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      records,
      title: 'Context compaction',
      subtitle: item.trigger,
      preview: compact(itemSummary(item)),
      state: 'completed',
      timing: timing(loaded.turn.startedAt, null, loaded.turn.startedAt),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, item.id),
      relatedEvidence: [],
      availability: loaded.availability,
      childThreadId: null,
      usage: null,
    }));
  }
}

function record(input: {
  readonly kind: ThreadTrajectoryRecordKind;
  readonly lane: ThreadTrajectoryRecordSummary['lane'];
  readonly threadId: ThreadId;
  readonly turn: Turn;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly title: string;
  readonly subtitle: string | null;
  readonly preview: string | null;
  readonly state: ThreadTrajectoryRecordSummary['state'];
  readonly timing: ThreadTrajectoryTimingSummary;
  readonly primaryEvidence: ThreadTrajectoryEvidenceRef;
  readonly relatedEvidence: readonly ThreadTrajectoryEvidenceRef[];
  readonly availability: readonly ThreadTrajectoryAvailability[];
  readonly childThreadId: ThreadId | null;
  readonly usage: ThreadTrajectoryUsageSummary | null;
  readonly parentRecordId?: string | null;
  readonly toolCallId?: string;
}): ThreadTrajectoryRecordSummary {
  const sequence = input.records.length;
  return {
    id: trajectoryRecordId(input.turn.id, input.kind, input.primaryEvidence, input.toolCallId),
    kind: input.kind,
    lane: input.lane,
    threadId: input.threadId,
    turnId: input.turn.id,
    sequence,
    parentRecordId: input.parentRecordId ?? null,
    title: input.title,
    subtitle: input.subtitle,
    preview: input.preview,
    state: input.availability.length > 0 && input.state === 'completed' ? 'partial' : input.state,
    timing: input.timing,
    usage: input.usage,
    primaryEvidence: input.primaryEvidence,
    relatedEvidence: input.relatedEvidence,
    availability: input.availability,
    childThreadId: input.childThreadId,
  };
}

function summarizeTrajectory(
  threadId: ThreadId,
  turns: readonly LoadedTurn[],
  records: readonly ThreadTrajectoryRecordSummary[],
): ThreadTrajectorySummary {
  const usage = records.reduce<ThreadTrajectoryUsageSummary | null>((accumulator, entry) => (
    entry.usage ? addUsage(accumulator, entry.usage) : accumulator
  ), null);
  const startedAt = minNullable(turns.map((entry) => entry.turn.startedAt));
  const completedAt = turns.some((entry) => entry.turn.completedAt === null)
    ? null
    : maxNullable(turns.map((entry) => entry.turn.completedAt));
  return {
    threadId,
    turnCount: turns.length,
    recordCount: records.length,
    inputCount: countKind(records, 'input'),
    contextCount: countKind(records, 'context'),
    assistantCount: countKind(records, 'assistant'),
    toolCount: countKind(records, 'tool'),
    retryCount: countKind(records, 'retry'),
    compactionCount: countKind(records, 'compaction'),
    delegationCount: countKind(records, 'delegation'),
    startedAt,
    completedAt,
    durationMs: startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt),
    usage,
    availability: turns.flatMap((entry) => entry.availability),
  };
}

function pageTrajectoryRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
): { readonly data: readonly ThreadTrajectoryRecordSummary[]; readonly nextCursor: string | null } {
  const limit = trajectoryLimit(request.limit);
  const beforeSequence = decodeTrajectoryCursor(request.cursor ?? null);
  if (beforeSequence !== null) {
    const older = records.filter((entry) => entry.sequence < beforeSequence);
    const data = older.slice(Math.max(0, older.length - limit));
    return { data, nextCursor: data[0] && data[0].sequence > 0 ? encodeTrajectoryCursor(data[0].sequence) : null };
  }
  const focusIndex = focusIndexForRecords(records, request);
  if (focusIndex >= 0) {
    const end = Math.min(records.length, focusIndex + Math.ceil(limit / 3) + 1);
    const start = Math.max(0, end - limit);
    const data = records.slice(start, end);
    return { data, nextCursor: data[0] && data[0].sequence > 0 ? encodeTrajectoryCursor(data[0].sequence) : null };
  }
  const data = records.slice(Math.max(0, records.length - limit));
  return { data, nextCursor: data[0] && data[0].sequence > 0 ? encodeTrajectoryCursor(data[0].sequence) : null };
}

function selectRecordId(
  page: readonly ThreadTrajectoryRecordSummary[],
  all: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
): string | null {
  const focus = request.focus ?? null;
  if (focus?.recordId && page.some((entry) => entry.id === focus.recordId)) return focus.recordId;
  if (focus?.turnId) return focusRecordForTurn(page, focus.turnId)?.id ?? null;
  return page.at(-1)?.id ?? all.at(-1)?.id ?? null;
}

function focusRecordForTurn(
  records: readonly ThreadTrajectoryRecordSummary[],
  turnId: string,
): ThreadTrajectoryRecordSummary | null {
  const candidates = records.filter((entry) => entry.turnId === turnId);
  if (candidates.length === 0) return null;
  for (const kind of ['assistant', 'tool', 'delegation', 'compaction', 'context', 'input'] as const) {
    const match = candidates.find((entry) => entry.kind === kind);
    if (match) return match;
  }
  return candidates[0] ?? null;
}

function focusIndexForRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
): number {
  const focus = request.focus ?? null;
  if (!focus) return -1;
  if (focus.recordId) return records.findIndex((entry) => entry.id === focus.recordId);
  if (focus.turnId) return records.findIndex((entry) => entry.turnId === focus.turnId);
  return -1;
}

function trajectoryLimit(value: number | null | undefined): number {
  if (!value || !Number.isSafeInteger(value) || value <= 0) return DEFAULT_TRAJECTORY_LIMIT;
  return Math.min(value, MAX_TRAJECTORY_LIMIT);
}

function encodeTrajectoryCursor(sequence: number): string {
  return `before:${sequence}`;
}

function decodeTrajectoryCursor(value: string | null): number | null {
  if (!value) return null;
  const match = /^before:(\d+)$/.exec(value);
  if (!match) return null;
  return Number(match[1]);
}

function trajectoryRecordId(
  turnId: string,
  kind: ThreadTrajectoryRecordKind,
  evidence: ThreadTrajectoryEvidenceRef,
  toolCallId?: string,
): string {
  if (kind === 'assistant' && evidence.type === 'providerCall') return `turn:${turnId}:assistant:${evidence.callIndex}`;
  if (evidence.type === 'diagnosticActivity') {
    return toolCallId
      ? `turn:${turnId}:${kind}:${evidence.activityIndex}:${toolCallId}`
      : `turn:${turnId}:${kind}:${evidence.activityIndex}`;
  }
  if (evidence.type === 'threadItem') return `turn:${turnId}:${kind}:item:${evidence.itemId}`;
  if (evidence.type === 'subagent') return `turn:${turnId}:delegation:${evidence.agentThreadId}`;
  return `turn:${turnId}:${kind}`;
}

function assistantRecordId(turnId: string, callIndex: number): string {
  return `turn:${turnId}:assistant:${callIndex}`;
}

function providerCallEvidence(threadId: ThreadId, turn: Turn, callIndex: number): ThreadTrajectoryEvidenceRef {
  return { type: 'providerCall', threadId, turnId: turn.id, callIndex };
}

function itemEvidenceRef(threadId: ThreadId, turn: Turn, itemId: string): ThreadTrajectoryEvidenceRef {
  return { type: 'threadItem', threadId, turnId: turn.id, itemId };
}

function diagnosticEvidence(
  threadId: ThreadId,
  turn: Turn,
  activityIndex: number,
  activityType: TurnDiagnosticsPayload['activities'][number]['type'],
): ThreadTrajectoryEvidenceRef {
  return {
    type: 'diagnosticActivity',
    threadId,
    turnId: turn.id,
    activityIndex,
    activityType,
  };
}

function timing(
  startedAt: number | null,
  firstTokenAt: number | null,
  completedAt: number | null,
): ThreadTrajectoryTimingSummary {
  return {
    startedAt,
    firstTokenAt,
    completedAt,
    durationMs: startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt),
  };
}

function providerUsageSummary(
  usage: NonNullable<TurnDiagnosticsPayload['providerCalls'][number]['response']>['usage'],
): ThreadTrajectoryUsageSummary {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost.total,
  };
}

function addUsage(
  left: ThreadTrajectoryUsageSummary | null,
  right: ThreadTrajectoryUsageSummary,
): ThreadTrajectoryUsageSummary {
  if (!left) return right;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning === null || right.reasoning === null ? null : left.reasoning + right.reasoning,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd === null || right.costUsd === null ? null : left.costUsd + right.costUsd,
  };
}

function countKind(records: readonly ThreadTrajectoryRecordSummary[], kind: ThreadTrajectoryRecordKind): number {
  return records.filter((entry) => entry.kind === kind).length;
}

function minNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.min(...present);
}

function maxNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function availability(reason: ThreadTrajectoryAvailability['reason'], message: string): ThreadTrajectoryAvailability {
  return { reason, message };
}

function turnEvidence(turn: Turn): ThreadTrajectoryTurnEvidence {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    modelProvider: turn.execution.modelProvider,
    model: turn.execution.model,
    reasoningEffort: turn.execution.reasoningEffort,
  };
}

function itemEvidence(item: ThreadItem): ThreadTrajectoryItemEvidence {
  return {
    itemId: item.id,
    type: item.type,
    title: itemTitle(item),
    preview: compact(itemSummary(item)),
    status: isToolItem(item) ? item.status : null,
  };
}

function evidenceForItems(turn: Turn, itemIds: readonly string[]): readonly ThreadTrajectoryItemEvidence[] {
  const byId = new Map(turn.items.map((item) => [item.id, item]));
  return itemIds.flatMap((itemId) => {
    const item = byId.get(itemId);
    return item ? [itemEvidence(item)] : [];
  });
}

function itemForEvidence(turn: Turn, evidence: ThreadTrajectoryEvidenceRef): ThreadItem | null {
  return evidence.type === 'threadItem'
    ? turn.items.find((item) => item.id === evidence.itemId) ?? null
    : null;
}

function itemForRelatedEvidence(turn: Turn, record: ThreadTrajectoryRecordSummary): ThreadItem | null {
  for (const evidence of record.relatedEvidence) {
    const item = itemForEvidence(turn, evidence);
    if (item) return item;
  }
  return null;
}

function itemForToolRecord(turn: Turn, record: ThreadTrajectoryRecordSummary): ThreadItem | null {
  return itemForEvidence(turn, record.primaryEvidence) ?? itemForRelatedEvidence(turn, record);
}

function diagnosticActivityIndex(evidence: ThreadTrajectoryEvidenceRef): number | null {
  return evidence.type === 'diagnosticActivity' ? evidence.activityIndex : null;
}

function providerCallIndexForEvidence(evidence: ThreadTrajectoryEvidenceRef): number | null {
  return evidence.type === 'providerCall' ? evidence.callIndex : null;
}

function relatedItemIds(record: ThreadTrajectoryRecordSummary): readonly string[] {
  return record.relatedEvidence.flatMap((evidence) => (
    evidence.type === 'threadItem' ? [evidence.itemId] : []
  ));
}

function inputActivityItemIds(payload: TurnDiagnosticsPayload | null | undefined, activityIndex: number): readonly string[] {
  const activity = payload?.activities[activityIndex];
  return activity?.type === 'acceptedInput' ? activity.itemIds : [];
}

function toolExecutionCallId(record: ThreadTrajectoryRecordSummary): string | null {
  const match = /:([^:]+)$/.exec(record.id);
  if (!match) return null;
  return record.primaryEvidence.type === 'diagnosticActivity' ? match[1]! : null;
}

function providerCallState(
  call: TurnDiagnosticsPayload['providerCalls'][number],
  turn: Turn,
): ThreadTrajectoryRecordSummary['state'] {
  if (!call.response) return turn.status === 'inProgress' ? 'running' : 'partial';
  if (call.response.stopReason === 'error') return 'failed';
  if (call.response.stopReason === 'aborted') return 'interrupted';
  return 'completed';
}

function relatedAssistantItems(turn: Turn, payload: TurnDiagnosticsPayload): readonly ThreadItem[] {
  if (payload.providerCalls.length !== 1) return [];
  return turn.items.filter((item) => item.type === 'agentMessage' || item.type === 'reasoning');
}

function isToolItem(item: ThreadItem): item is Extract<ThreadItem, { readonly status: string }> {
  return 'status' in item;
}

function isDelegationExecution(toolName: string, item: ThreadItem | null): boolean {
  if (item && isDelegationItem(item)) return true;
  return toolName === 'agent' || toolName === 'agent_message' || toolName === 'task_stop';
}

function isDelegationItem(item: ThreadItem): item is CollabAgentToolCallThreadItem {
  return item.type === 'collabAgentToolCall';
}

function childThreadIdForItem(item: ThreadItem | null): ThreadId | null {
  if (!item) return null;
  if (item.type === 'collabAgentToolCall') return item.receiverThreadIds[0] ?? null;
  if (item.type === 'subAgentActivity') return item.agentThreadId;
  return null;
}

function itemCompletedAt(item: ThreadItem, turn: Turn): number | null {
  if (!isToolItem(item)) return null;
  if (item.status === 'inProgress') return null;
  if ('durationMs' in item && typeof item.durationMs === 'number') return turn.startedAt + item.durationMs;
  return turn.completedAt;
}

function contextEvidenceTitle(item: ContextEvidenceThreadItem): string {
  return item.kind.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
}

function toolTitle(item: ThreadItem | null, fallback: string): string {
  if (!item) return fallback;
  if (item.type === 'commandExecution') return item.description ?? 'Shell command';
  if (item.type === 'mcpToolCall') return `${item.server}.${item.tool}`;
  if (item.type === 'dynamicToolCall') return [item.namespace, item.tool].filter(Boolean).join('.') || item.tool;
  if (item.type === 'webSearch') return 'Web search';
  if (item.type === 'fileChange') return 'File changes';
  return itemTitle(item);
}

function delegationTitle(item: ThreadItem | null, fallback: string): string {
  if (item?.type === 'collabAgentToolCall') {
    if (item.tool === 'agent') return 'Agent delegation';
    if (item.tool === 'agent_message') return 'Agent message';
    if (item.tool === 'task_stop') return 'Agent stop';
  }
  return fallback;
}

function itemTitle(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage': return 'User message';
    case 'agentMessage': return 'Assistant message';
    case 'reasoning': return 'Reasoning';
    case 'commandExecution': return item.description ?? 'Shell command';
    case 'fileChange': return 'File changes';
    case 'mcpToolCall': return `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return [item.namespace, item.tool].filter(Boolean).join('.') || item.tool;
    case 'collabAgentToolCall': return delegationTitle(item, item.tool);
    case 'subAgentActivity': return 'Agent activity';
    case 'webSearch': return 'Web search';
    case 'imageView': return 'Image view';
    case 'contextEvidence': return contextEvidenceTitle(item);
    case 'contextReset': return 'Context reset';
    case 'contextCompaction': return 'Context compaction';
  }
}

function itemSummary(item: ThreadItem | null | undefined): string | null {
  if (!item) return null;
  switch (item.type) {
    case 'userMessage':
      return item.content.map((content) => {
        if (content.type === 'text') return content.text;
        if (content.type === 'attachment') return content.name;
        return content.note ?? content.nodeId;
      }).join(' ');
    case 'agentMessage': return item.text;
    case 'reasoning': return [...item.summary, ...item.content].find(Boolean) ?? null;
    case 'commandExecution': return item.description ?? item.command;
    case 'fileChange': return item.changes.map((change) => change.path).join(', ');
    case 'mcpToolCall': return item.error ?? jsonPreview(item.result) ?? `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return item.contentItems?.map((content) => {
      if (content.type === 'text') return content.text;
      if (content.type === 'json') return jsonPreview(content.value);
      return content.alt ?? 'image';
    }).filter(Boolean).join(' ') ?? null;
    case 'collabAgentToolCall': return item.summary ?? item.prompt ?? item.tool;
    case 'subAgentActivity': return item.error?.message ?? item.agentPath;
    case 'webSearch': return item.query;
    case 'imageView': return 'Image viewed';
    case 'contextEvidence': return item.summary;
    case 'contextReset': return 'Context cleared';
    case 'contextCompaction': return `${item.trigger} compaction`;
  }
}

function providerResponsePreview(value: JsonValue | null): string | null {
  if (value === null) return null;
  return semanticText(value) ?? jsonPreview(value);
}

function semanticText(value: JsonValue): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, JsonValue>>;
  for (const key of ['text', 'input_text', 'output_text', 'content']) {
    const text = record[key];
    if (typeof text === 'string' && text.length > 0) return text;
  }
  const content = record.content ?? record.parts;
  if (Array.isArray(content)) {
    return content.map(semanticText).filter(Boolean).join(' ');
  }
  return null;
}

function jsonPreview(value: JsonValue | null): string | null {
  if (value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function compact(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > PREVIEW_LIMIT ? `${normalized.slice(0, PREVIEW_LIMIT - 1)}…` : normalized;
}
