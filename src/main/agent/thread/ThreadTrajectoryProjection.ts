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
  ThreadTrajectoryUserMessageEvidence,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
  UserMessageThreadItem,
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

type TrajectoryToolExecution = Extract<
  TurnDiagnosticsPayload['activities'][number],
  { readonly type: 'toolExecutionBatch' }
>['executions'][number];

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
    const selectedRecordId = selectRecordId(records.data, request);
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
    let stablePromptFingerprint: string | null = null;
    for (const loaded of turns) {
      const nextFingerprint = loaded.diagnostics?.payload.stablePrompt?.fingerprints.complete ?? null;
      if (nextFingerprint !== null && nextFingerprint !== stablePromptFingerprint) {
        appendStablePromptRecord(records, loaded, stablePromptFingerprint !== null);
        stablePromptFingerprint = nextFingerprint;
      }
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
      const message = userMessageForEvidence(loaded.turn, record.primaryEvidence);
      const activityIndex = relatedDiagnosticActivityIndex(record, 'acceptedInput');
      const providerCallIndex = relatedProviderCallIndex(record);
      return {
        kind: 'input',
        turn,
        message: message ? userMessageEvidence(message) : null,
        diagnostics: diagnosticsEvidence(diagnostics, activityIndex, providerCallIndex),
        activityIndex,
      };
    }
    if (record.kind === 'context') {
      const item = itemForEvidence(loaded.turn, record.primaryEvidence);
      const payload = record.primaryEvidence.type === 'stablePrompt'
        ? stablePromptEvidence(loaded.diagnostics)
        : await this.readContextPayload(record.threadId, item);
      return {
        kind: 'context',
        turn,
        item: item ? itemEvidence(item) : null,
        modelContextText: modelContextTextForContextRecord(loaded.diagnostics?.payload ?? null, record, item),
        payload,
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
      const execution = toolExecutionForRecord(loaded.diagnostics?.payload ?? null, record);
      return {
        kind: 'tool',
        turn,
        item: item ? itemEvidence(item) : null,
        diagnostics: diagnosticsEvidence(diagnostics, diagnosticActivityIndex(record.primaryEvidence), null),
        activityIndex: diagnosticActivityIndex(record.primaryEvidence),
        executionCallId: toolExecutionCallId(record),
        input: toolInputEvidence(item),
        outputText: await this.readToolOutput(record.threadId, item),
        schema: toolSchemaEvidence(loaded.diagnostics?.payload ?? null, execution?.toolName ?? null),
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
    const execution = toolExecutionForRecord(loaded.diagnostics?.payload ?? null, record);
    return {
      kind: 'delegation',
      turn,
      item: item ? itemEvidence(item) : null,
      diagnostics: diagnosticsEvidence(diagnostics, diagnosticActivityIndex(record.primaryEvidence), null),
      activityIndex: diagnosticActivityIndex(record.primaryEvidence),
      executionCallId: toolExecutionCallId(record),
      input: toolInputEvidence(item),
      outputText: await this.readToolOutput(record.threadId, item),
      schema: toolSchemaEvidence(loaded.diagnostics?.payload ?? null, execution?.toolName ?? null),
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
      : providerCallDiagnosticsEvidence(bundle.payload, bundle.payload.providerCalls[providerCallIndex] ?? null),
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
  payload: TurnDiagnosticsPayload,
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
    request: sanitizeJsonEvidence(materializeProviderRequest(payload, call)),
    response: call.response ? sanitizeJsonEvidence(call.response) : null,
    transportResponse: call.transportResponse,
  };
}

function materializeProviderRequest(
  payload: TurnDiagnosticsPayload,
  call: TurnDiagnosticsPayload['providerCalls'][number],
): JsonValue | null {
  const request = call.request;
  if (request.kind === 'value') return request.value;
  const fragments = new Map(payload.requestFragments.map((fragment) => [fragment.id, fragment.value]));
  const result: Record<string, JsonValue> = {};
  for (const field of request.fields) {
    if (field.representation === 'inline') {
      result[field.name] = field.value;
      continue;
    }
    const values: JsonValue[] = [];
    for (const id of field.fragmentIds) {
      const value = fragments.get(id);
      if (value === undefined) return null;
      values.push(value);
    }
    if (field.container === 'array') {
      result[field.name] = values;
    } else {
      const value = values[0];
      if (value === undefined) return null;
      result[field.name] = value;
    }
  }
  return result;
}

function modelContextTextForContextRecord(
  payload: TurnDiagnosticsPayload | null,
  record: ThreadTrajectoryRecordSummary,
  item: ThreadItem | null,
): string | null {
  if (!payload) return null;
  if (record.primaryEvidence.type === 'stablePrompt') return stablePromptModelText(payload);
  const kind = item?.type === 'contextEvidence' ? item.kind : null;
  if (!kind) return null;
  return systemContextTextForKind(payload, kind);
}

function stablePromptModelText(payload: TurnDiagnosticsPayload): string | null {
  for (const call of payload.providerCalls) {
    const fragment = payload.requestFragments.find((candidate) => (
      candidate.id === call.preparedContext.systemPromptFragmentId
    ));
    const text = semanticText(fragment?.value ?? null);
    if (text) return sanitizeTextEvidence(text);
  }
  const text = payload.stablePrompt?.blocks.map((block) => block.text).filter(Boolean).join('\n\n') ?? '';
  return text ? sanitizeTextEvidence(text) : null;
}

function systemContextTextForKind(
  payload: TurnDiagnosticsPayload,
  kind: ContextEvidenceThreadItem['kind'],
): string | null {
  const messagesById = new Map(payload.canonicalMessages.map((message) => [message.id, message.value]));
  for (const call of payload.providerCalls) {
    for (const [messageIndex, messageId] of call.preparedContext.messageIds.entries()) {
      const message = messagesById.get(messageId);
      const partProvenance = call.preparedContext.messagePartProvenance[messageIndex] ?? [];
      for (const [partIndex, provenance] of partProvenance.entries()) {
        if (provenance.source !== 'systemContext') continue;
        if (!provenance.entries.some((entry) => entry.kind === kind)) continue;
        const text = textForMessagePart(message ?? null, partIndex);
        if (text) return sanitizeTextEvidence(text);
      }
    }
  }
  return null;
}

function textForMessagePart(message: JsonValue | null, partIndex: number): string | null {
  if (message === null) return null;
  if (typeof message === 'string') return partIndex === 0 ? message : null;
  if (typeof message !== 'object' || Array.isArray(message)) return null;
  const record = message as Readonly<Record<string, JsonValue>>;
  const content = record.content ?? record.parts;
  if (Array.isArray(content)) return semanticText(content[partIndex] ?? null);
  return partIndex === 0 ? semanticText(content ?? message) : null;
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

function appendStablePromptRecord(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  update: boolean,
): void {
  const diagnostics = loaded.diagnostics;
  const stablePrompt = diagnostics?.payload.stablePrompt;
  if (!diagnostics || !stablePrompt) return;
  records.push(record({
    kind: 'context',
    lane: 'input',
    threadId: loaded.threadId,
    turn: loaded.turn,
    records,
    title: update ? 'System Prompt Update' : 'Initial System Prompt',
    subtitle: 'stablePrompt',
    preview: compact(stablePrompt.blocks.map((block) => block.text).join(' ')),
    state: 'completed',
    timing: timing(loaded.turn.startedAt, null, loaded.turn.startedAt),
    primaryEvidence: stablePromptEvidenceRef(loaded.threadId, loaded.turn),
    relatedEvidence: [],
    availability: loaded.availability,
    childThreadId: null,
    usage: null,
  }));
}

function stablePromptEvidence(bundle: DiagnosticsBundle | null): JsonValue | null {
  if (!bundle) return null;
  return sanitizeJsonEvidence({
    stablePrompt: bundle.payload.stablePrompt,
    toolSchemas: bundle.payload.toolSchemas,
  });
}

function appendTurnRecords(records: ThreadTrajectoryRecordSummary[], loaded: LoadedTurn): void {
  const { diagnostics, turn } = loaded;
  const itemsById = new Map(turn.items.map((item) => [item.id, item]));
  const coveredCompactionItemIds = new Set<string>();
  let contextInserted = false;

  if (diagnostics) {
    diagnostics.payload.activities.forEach((activity, activityIndex) => {
      if (activity.type === 'acceptedInput') {
        const activityRef = diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type);
        const providerCallRef = activity.consumedByCallIndex === null
          ? null
          : providerCallEvidence(loaded.threadId, turn, activity.consumedByCallIndex);
        for (const itemId of activity.itemIds) {
          const item = itemsById.get(itemId);
          if (item?.type !== 'userMessage') continue;
          records.push(record({
            kind: 'input',
            lane: 'input',
            threadId: loaded.threadId,
            turn,
            records,
            title: activity.source === 'initial' ? 'Input' : 'Steering',
            subtitle: null,
            preview: compact(itemSummary(item)),
            state: 'completed',
            timing: timing(item.acceptedAt, null, item.acceptedAt),
            primaryEvidence: itemEvidenceRef(loaded.threadId, turn, item.id),
            relatedEvidence: [
              activityRef,
              ...(providerCallRef ? [providerCallRef] : []),
            ],
            availability: loaded.availability,
            childThreadId: null,
            usage: null,
          }));
        }
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
            primaryEvidence: toolExecutionEvidence(
              loaded.threadId,
              turn,
              activityIndex,
              execution.callId,
            ),
            relatedEvidence: execution.itemId ? [itemEvidenceRef(loaded.threadId, turn, execution.itemId)] : [],
            availability: loaded.availability,
            childThreadId: childThreadIdForItem(item),
            usage: null,
            parentRecordId: assistantRecordId(turn.id, activity.sourceCallIndex),
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
  for (const item of userItems) {
    records.push(record({
      kind: 'input',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      records,
      title: 'Input',
      subtitle: null,
      preview: compact(itemSummary(item)),
      state: loaded.turn.status === 'inProgress' ? 'running' : 'partial',
      timing: timing(item.acceptedAt, null, null),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, item.id),
      relatedEvidence: [],
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
    if (item.type === 'contextEvidence' && !contextEvidenceWasModelVisible(loaded, item)) continue;
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

function contextEvidenceWasModelVisible(
  loaded: LoadedTurn,
  item: ContextEvidenceThreadItem,
): boolean {
  const payload = loaded.diagnostics?.payload ?? null;
  if (!payload) return true;
  return systemContextTextForKind(payload, item.kind) !== null;
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
}): ThreadTrajectoryRecordSummary {
  const sequence = input.records.length;
  return {
    id: trajectoryRecordId(input.turn.id, input.kind, input.primaryEvidence),
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
  request: ThreadTrajectoryReadRequest,
): string | null {
  const focus = request.focus ?? null;
  if (focus?.recordId && page.some((entry) => entry.id === focus.recordId)) return focus.recordId;
  if (focus?.turnId) return focusRecordForTurn(page, focus.turnId)?.id ?? null;
  return null;
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
): string {
  if (kind === 'assistant' && evidence.type === 'providerCall') return `turn:${turnId}:assistant:${evidence.callIndex}`;
  if (evidence.type === 'toolExecution') {
    return `turn:${turnId}:${kind}:${evidence.activityIndex}:${encodeURIComponent(evidence.callId)}`;
  }
  if (evidence.type === 'diagnosticActivity') {
    return `turn:${turnId}:${kind}:${evidence.activityIndex}`;
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

function stablePromptEvidenceRef(threadId: ThreadId, turn: Turn): ThreadTrajectoryEvidenceRef {
  return { type: 'stablePrompt', threadId, turnId: turn.id };
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

function toolExecutionEvidence(
  threadId: ThreadId,
  turn: Turn,
  activityIndex: number,
  callId: string,
): ThreadTrajectoryEvidenceRef {
  return {
    type: 'toolExecution',
    threadId,
    turnId: turn.id,
    activityIndex,
    callId,
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

function userMessageEvidence(item: UserMessageThreadItem): ThreadTrajectoryUserMessageEvidence {
  return {
    itemId: item.id,
    acceptedAt: item.acceptedAt,
    content: item.content,
  };
}

function evidenceForItems(turn: Turn, itemIds: readonly string[]): readonly ThreadTrajectoryItemEvidence[] {
  const byId = new Map(turn.items.map((item) => [item.id, item]));
  return itemIds.flatMap((itemId) => {
    const item = byId.get(itemId);
    return item ? [itemEvidence(item)] : [];
  });
}

function userMessageForEvidence(turn: Turn, evidence: ThreadTrajectoryEvidenceRef): UserMessageThreadItem | null {
  const item = itemForEvidence(turn, evidence);
  return item?.type === 'userMessage' ? item : null;
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
  return evidence.type === 'diagnosticActivity' || evidence.type === 'toolExecution'
    ? evidence.activityIndex
    : null;
}

function providerCallIndexForEvidence(evidence: ThreadTrajectoryEvidenceRef): number | null {
  return evidence.type === 'providerCall' ? evidence.callIndex : null;
}

function relatedDiagnosticActivityIndex(
  record: ThreadTrajectoryRecordSummary,
  activityType: TurnDiagnosticsPayload['activities'][number]['type'],
): number | null {
  for (const evidence of record.relatedEvidence) {
    if (evidence.type === 'diagnosticActivity' && evidence.activityType === activityType) {
      return evidence.activityIndex;
    }
  }
  return diagnosticActivityIndex(record.primaryEvidence);
}

function relatedProviderCallIndex(record: ThreadTrajectoryRecordSummary): number | null {
  const primary = providerCallIndexForEvidence(record.primaryEvidence);
  if (primary !== null) return primary;
  for (const evidence of record.relatedEvidence) {
    const callIndex = providerCallIndexForEvidence(evidence);
    if (callIndex !== null) return callIndex;
  }
  return null;
}

function relatedItemIds(record: ThreadTrajectoryRecordSummary): readonly string[] {
  return record.relatedEvidence.flatMap((evidence) => (
    evidence.type === 'threadItem' ? [evidence.itemId] : []
  ));
}

function toolExecutionCallId(record: ThreadTrajectoryRecordSummary): string | null {
  return record.primaryEvidence.type === 'toolExecution'
    ? record.primaryEvidence.callId
    : null;
}

function toolExecutionForRecord(
  payload: TurnDiagnosticsPayload | null,
  record: ThreadTrajectoryRecordSummary,
): TrajectoryToolExecution | null {
  if (!payload) return null;
  const activityIndex = diagnosticActivityIndex(record.primaryEvidence);
  const activity = activityIndex === null ? null : payload.activities[activityIndex] ?? null;
  if (activity?.type !== 'toolExecutionBatch') return null;
  const callId = toolExecutionCallId(record);
  if (!callId) return activity.executions.length === 1 ? activity.executions[0] ?? null : null;
  return activity.executions.find((execution) => execution.callId === callId) ?? null;
}

function toolInputEvidence(item: ThreadItem | null): JsonValue | null {
  if (!item) return null;
  switch (item.type) {
    case 'commandExecution':
      return sanitizeJsonEvidence({
        command: item.command,
        description: item.description,
        cwd: item.cwd,
      });
    case 'fileChange':
      return sanitizeJsonEvidence({ changes: item.changes });
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return sanitizeJsonEvidence(item.arguments);
    case 'collabAgentToolCall':
      return sanitizeJsonEvidence({
        tool: item.tool,
        prompt: item.prompt,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        receiverThreadIds: item.receiverThreadIds,
      });
    case 'webSearch':
      return sanitizeJsonEvidence({ query: item.query });
    default:
      return null;
  }
}

function toolSchemaEvidence(
  payload: TurnDiagnosticsPayload | null,
  toolName: string | null,
): JsonValue | null {
  if (!payload || !toolName) return null;
  const schema = payload.toolSchemas.find((candidate) => candidate.name === toolName) ?? null;
  return schema ? sanitizeJsonEvidence(schema) : null;
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

function semanticText(value: JsonValue | null): string | null {
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
