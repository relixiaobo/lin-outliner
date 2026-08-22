import { createHash } from 'node:crypto';
import {
  MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES,
  type CollabAgentToolCallThreadItem,
  type ContextEvidenceThreadItem,
  type JsonValue,
  type Thread,
  type ThreadId,
  type ThreadFileSource,
  type ThreadImageArtifactReference,
  type ThreadItem,
  type ThreadItemId,
  type ThreadResourceReference,
  type ThreadTrajectoryAvailability,
  type ThreadTrajectoryDetailReadRequest,
  type ThreadTrajectoryDetailReadResponse,
  type ThreadTrajectoryDiagnosticsEvidence,
  type ThreadTrajectoryEvidenceRef,
  type ThreadTrajectoryItemEvidence,
  type ThreadTrajectoryProviderCallEvidence,
  type ThreadTrajectoryReadRequest,
  type ThreadTrajectoryReadResponse,
  type ThreadTrajectoryRecordKind,
  type ThreadTrajectoryRecordSummary,
  type ThreadTrajectoryReplacementRange,
  type ThreadTrajectoryRuntimeEvidence,
  type ThreadTrajectorySummary,
  type ThreadTrajectoryTimingSummary,
  type ThreadTrajectoryTurnEvidence,
  type ThreadTrajectoryUsageSummary,
  type ThreadTrajectoryUserMessageEvidence,
  type Turn,
  type TurnId,
  type TurnDiagnosticsPayload,
  type TurnDiagnosticsPayloadReference,
  type TurnDiagnosticsSystemContextEntry,
  type ThreadUserContent,
  type UserMessageThreadItem,
} from '../../../core/agent/protocol';
import {
  DIAGNOSTIC_SECRET_REDACTION_OMISSION,
  redactSecretLikeContent,
  redactSecretLikeJsonForDiagnostics,
} from '../capabilities/agentSecretRedaction';
import { secretStringFieldConfidence } from '../capabilities/agentSecretStringScanner';
import { ThreadCore } from './ThreadCore';

const DEFAULT_TRAJECTORY_LIMIT = 100;
const MAX_TRAJECTORY_LIMIT = 250;
const PREVIEW_LIMIT = 240;
const MAX_DETAIL_TEXT_LENGTH = 20_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ARRAY_LENGTH = 500;
const MAX_JSON_OBJECT_KEYS = 500;
const DIAGNOSTICS_READ_CONCURRENCY = 4;
const TRAJECTORY_SEQUENCE_STRIDE = 100_000;

type DiagnosticsBundle = {
  readonly ref: TurnDiagnosticsPayloadReference;
  readonly payload: TurnDiagnosticsPayload;
};

type TrajectoryCursor = {
  readonly direction: 'before' | 'after';
  readonly recordId: string;
};

type TrajectoryPage = {
  readonly data: readonly ThreadTrajectoryRecordSummary[];
  readonly replacementRange: ThreadTrajectoryReplacementRange | null;
  readonly olderCursor: string | null;
  readonly newerCursor: string | null;
};

type TrajectoryToolExecution = Extract<
  TurnDiagnosticsPayload['activities'][number],
  { readonly type: 'toolExecutionBatch' }
>['executions'][number];

interface LoadedTurn {
  readonly threadId: ThreadId;
  readonly turn: Turn;
  readonly turnIndex: number;
  readonly diagnostics: DiagnosticsBundle | null;
  readonly availability: readonly ThreadTrajectoryAvailability[];
}

interface BuiltTrajectory {
  readonly thread: Thread;
  readonly turns: readonly LoadedTurn[];
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly summary: ThreadTrajectorySummary;
}

interface BuiltTrajectoryWindow {
  readonly turns: readonly LoadedTurn[];
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly summary: ThreadTrajectorySummary;
  readonly replacementRange: ThreadTrajectoryReplacementRange | null;
  readonly olderCursor: string | null;
  readonly newerCursor: string | null;
}

interface TurnWindow {
  readonly end: number;
  readonly start: number;
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
  constructor(
    private readonly core: ThreadCore,
    private readonly now: () => number = Date.now,
    private readonly readActiveDiagnostics: (
      (threadId: ThreadId, turnId: TurnId) => TurnDiagnosticsPayload | null
  ) | null = null,
  ) {}

  async read(request: ThreadTrajectoryReadRequest): Promise<ThreadTrajectoryReadResponse> {
    const built = await this.buildWindow(request);
    const selectedRecordId = selectRecordId(built.records, request);
    return {
      threadId: request.threadId,
      summary: built.summary,
      records: built.records,
      replacementRange: built.replacementRange,
      olderCursor: built.olderCursor,
      newerCursor: built.newerCursor,
      hasOlder: built.olderCursor !== null,
      hasNewer: built.newerCursor !== null,
      selectedRecordId,
    };
  }

  async readDetail(request: ThreadTrajectoryDetailReadRequest): Promise<ThreadTrajectoryDetailReadResponse> {
    const built = await this.buildDetailWindow(request.threadId, request.recordId);
    if (!built) return { threadId: request.threadId, record: null, detail: null };
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

  private async buildWindow(request: ThreadTrajectoryReadRequest): Promise<BuiltTrajectoryWindow> {
    this.core.requireThread(request.threadId);
    const allTurns = this.core.allTurns(request.threadId);
    const window = turnWindowForTrajectoryRead(allTurns, request);
    const turns = await this.loadTurns(
      request.threadId,
      allTurns.slice(window.start, window.end).map((turn, offset) => ({
        turn,
        turnIndex: window.start + offset,
      })),
    );
    const records = this.projectRecords(turns);
    const page = pageTrajectoryRecords(records, request, window, allTurns.length);
    return {
      turns,
      records: page.data,
      summary: summarizeLightweightTrajectory(request.threadId, allTurns, turns),
      replacementRange: page.replacementRange,
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
    };
  }

  private async buildDetailWindow(threadId: ThreadId, recordId: string): Promise<BuiltTrajectory | null> {
    const thread = this.core.requireThread(threadId).thread;
    const turnId = turnIdFromTrajectoryRecordId(recordId);
    if (!turnId) return null;
    const allTurns = this.core.allTurns(threadId);
    const turnIndex = allTurns.findIndex((candidate) => candidate.id === turnId);
    const turn = turnIndex < 0 ? null : allTurns[turnIndex] ?? null;
    if (!turn) return null;
    const turns = await this.loadTurns(threadId, [{ turn, turnIndex }]);
    const records = this.projectRecords(turns);
    return {
      thread,
      turns,
      records,
      summary: summarizeProjectedTrajectory(threadId, allTurns, records, turns),
    };
  }

  private async build(threadId: ThreadId): Promise<BuiltTrajectory> {
    const thread = this.core.requireThread(threadId).thread;
    const allTurns = this.core.allTurns(threadId);
    const turns = await this.loadTurns(threadId, allTurns.map((turn, turnIndex) => ({ turn, turnIndex })));
    const records = this.projectRecords(turns);
    return {
      thread,
      turns,
      records,
      summary: summarizeProjectedTrajectory(threadId, allTurns, records, turns),
    };
  }

  private async loadTurns(
    threadId: ThreadId,
    turns: readonly { readonly turn: Turn; readonly turnIndex: number }[],
  ): Promise<readonly LoadedTurn[]> {
    return await mapWithConcurrency(turns, DIAGNOSTICS_READ_CONCURRENCY, async ({ turn, turnIndex }) => {
      const diagnostics = await this.readDiagnostics(threadId, turn);
      return {
        threadId,
        turn,
        turnIndex,
        diagnostics: diagnostics.bundle,
        availability: diagnostics.availability,
      };
    });
  }

  private projectRecords(turns: readonly LoadedTurn[]): readonly ThreadTrajectoryRecordSummary[] {
    const records: ThreadTrajectoryRecordSummary[] = [];
    let stablePromptFingerprint: string | null = null;
    const toolCatalogState: ToolCatalogProjectionState = { fingerprint: null };
    for (const loaded of turns) {
      const nextFingerprint = loaded.diagnostics?.payload.stablePrompt?.fingerprints.complete ?? null;
      if (nextFingerprint !== null && nextFingerprint !== stablePromptFingerprint) {
        appendStablePromptRecord(records, loaded, stablePromptFingerprint !== null);
        stablePromptFingerprint = nextFingerprint;
      }
      appendToolCatalogRecords(records, loaded, toolCatalogState);
      appendTurnRecords(records, loaded);
    }
    return records;
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
      const activePayload = turn.status === 'inProgress'
        ? this.readActiveDiagnostics?.(threadId, turn.id) ?? null
        : null;
      if (activePayload) {
        const activeBundle = activeDiagnosticsBundle(activePayload);
        if (activeBundle) return { bundle: activeBundle, availability: [] };
        return {
          bundle: null,
          availability: [availability('partialCoverage', 'Active Turn diagnostics exceeded the inspection budget.')],
        };
      }
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
        : record.primaryEvidence.type === 'toolCatalog'
          ? toolCatalogEvidence(loaded.diagnostics?.payload ?? null, record.primaryEvidence.callIndex)
        : await this.readContextPayload(record.threadId, item);
      return {
        kind: 'context',
        turn,
        item: item ? itemEvidence(item) : null,
        modelContextText: modelContextTextForContextRecord(loaded.diagnostics?.payload ?? null, record),
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
        return await sanitizeJsonEvidenceAsync(await this.core.payloads.readContext(threadId, item.payloadRef));
      }
      if (item.type === 'contextCompaction') {
        return await sanitizeJsonEvidenceAsync(await this.core.payloads.readContext(threadId, item.summaryRef));
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
      return text === null ? null : await sanitizeTextEvidenceAsync(text);
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
    agentNickname: thread.agentNickname ? sanitizeStringEvidence(thread.agentNickname) : null,
    agentRole: thread.agentRole ? sanitizeStringEvidence(thread.agentRole) : null,
    name: thread.name ? sanitizeStringEvidence(thread.name) : null,
    preview: sanitizeTextEvidence(thread.preview),
    ephemeral: thread.ephemeral,
    source: sanitizeStringEvidence(thread.source),
    threadSource: thread.threadSource,
    modelProvider: sanitizeStringEvidence(thread.modelProvider),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    historyMode: thread.historyMode,
  };
}

function activeDiagnosticsBundle(payload: TurnDiagnosticsPayload): DiagnosticsBundle | null {
  const encoded = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES) return null;
  return {
    ref: {
      id: createHash('sha256').update(encoded).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
      byteLength,
      schemaVersion: 1,
    },
    payload,
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
): string | null {
  if (!payload) return null;
  if (record.primaryEvidence.type === 'stablePrompt') return stablePromptModelText(payload);
  if (record.primaryEvidence.type === 'preparedContextPart') {
    return modelContextTextForPreparedContextPart(payload, record.primaryEvidence);
  }
  return null;
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

type PreparedContextPartEvidenceRef = Extract<ThreadTrajectoryEvidenceRef, { readonly type: 'preparedContextPart' }>;
interface PreparedContextPartRecord {
  readonly callIndex: number;
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly entries: readonly TurnDiagnosticsSystemContextEntry[];
  readonly text: string;
  readonly requestedAt: number;
}

interface ToolCatalogRecord {
  readonly callIndex: number;
  readonly toolNames: readonly string[];
  readonly tools: readonly JsonValue[];
  readonly fingerprint: string;
  readonly requestedAt: number;
}

interface ToolCatalogProjectionState {
  fingerprint: string | null;
}

function modelContextTextForPreparedContextPart(
  payload: TurnDiagnosticsPayload,
  ref: PreparedContextPartEvidenceRef,
): string | null {
  return preparedContextPartRecord(payload, ref)?.text ?? null;
}

function preparedContextPartRecord(
  payload: TurnDiagnosticsPayload,
  ref: PreparedContextPartEvidenceRef,
): PreparedContextPartRecord | null {
  const messagesById = new Map(payload.canonicalMessages.map((message) => [message.id, message.value]));
  const call = payload.providerCalls[ref.callIndex] ?? null;
  if (!call) return null;
  const messageId = call.preparedContext.messageIds[ref.messageIndex];
  if (!messageId) return null;
  const provenance = call.preparedContext.messagePartProvenance[ref.messageIndex]?.[ref.partIndex] ?? null;
  if (provenance?.source !== 'systemContext') return null;
  const partText = textForMessagePart(messagesById.get(messageId) ?? null, ref.partIndex);
  if (!partText) return null;
  return {
    callIndex: ref.callIndex,
    messageIndex: ref.messageIndex,
    partIndex: ref.partIndex,
    entries: provenance.entries,
    text: sanitizeTextEvidence(partText),
    requestedAt: call.requestedAt,
  };
}

function preparedContextPartRecords(
  payload: TurnDiagnosticsPayload,
  callIndex: number | null,
): readonly PreparedContextPartRecord[] {
  const call = callIndex === null ? payload.providerCalls[0] ?? null : payload.providerCalls[callIndex] ?? null;
  if (!call) return [];
  const messagesById = new Map(payload.canonicalMessages.map((message) => [message.id, message.value]));
  const messageIndex = call.protectedFromMessageIndex;
  const messageId = call.preparedContext.messageIds[messageIndex];
  if (!messageId) return [];
  const message = messagesById.get(messageId) ?? null;
  const parts = call.preparedContext.messagePartProvenance[messageIndex] ?? [];
  return parts.flatMap((provenance, partIndex): PreparedContextPartRecord[] => {
    if (provenance.source !== 'systemContext') return [];
    const partText = textForMessagePart(message, partIndex);
    if (!partText) return [];
    return [{
      callIndex: call.index,
      messageIndex,
      partIndex,
      entries: provenance.entries,
      text: sanitizeTextEvidence(partText),
      requestedAt: call.requestedAt,
    }];
  });
}

function preparedContextFingerprint(context: PreparedContextPartRecord): string {
  return JSON.stringify({
    entries: context.entries,
    text: context.text,
  });
}

function toolCatalogRecord(
  payload: TurnDiagnosticsPayload,
  callIndex: number,
): ToolCatalogRecord | null {
  const call = payload.providerCalls[callIndex] ?? null;
  if (!call) return null;
  const schemasByName = new Map(payload.toolSchemas.map((schema) => [schema.name, schema]));
  const tools = call.preparedContext.toolNames.map((name): JsonValue => {
    const schema = schemasByName.get(name);
    return schema ? sanitizeJsonEvidence(schema) : { name, schemaUnavailable: true };
  });
  return {
    callIndex: call.index,
    toolNames: call.preparedContext.toolNames,
    tools,
    fingerprint: JSON.stringify(tools),
    requestedAt: call.requestedAt,
  };
}

function toolCatalogEvidence(
  payload: TurnDiagnosticsPayload | null,
  callIndex: number,
): JsonValue | null {
  if (!payload) return null;
  const catalog = toolCatalogRecord(payload, callIndex);
  if (!catalog) return null;
  return sanitizeJsonEvidence({
    kind: 'toolCatalog',
    requestIndex: catalog.callIndex,
    toolNames: catalog.toolNames,
    tools: catalog.tools,
  });
}

function toolCatalogTitle(update: boolean): string {
  return update ? 'Tools Updated' : 'Available Tools';
}

function toolCatalogSubtitle(catalog: ToolCatalogRecord): string {
  const count = catalog.toolNames.length;
  return `${count} ${count === 1 ? 'tool' : 'tools'} · Request #${catalog.callIndex + 1}`;
}

function toolCatalogPreview(catalog: ToolCatalogRecord): string {
  return catalog.toolNames.length > 0 ? catalog.toolNames.join(', ') : 'No tools in this request';
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

async function sanitizeJsonEvidenceAsync(value: unknown): Promise<JsonValue> {
  try {
    const redacted = await redactSecretLikeJsonForDiagnostics(value);
    if (redacted.value === DIAGNOSTIC_SECRET_REDACTION_OMISSION) return '‹redacted›';
    return sanitizeJsonEvidence(redacted.value);
  } catch {
    return '‹redacted›';
  }
}

function sanitizeTextEvidence(value: string): string {
  const sanitized = sanitizeStringEvidence(value);
  if (sanitized.length <= MAX_DETAIL_TEXT_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_DETAIL_TEXT_LENGTH)}\n… [truncated]`;
}

async function sanitizeTextEvidenceAsync(value: string): Promise<string> {
  try {
    const redacted = await redactSecretLikeJsonForDiagnostics({ body: value });
    if (redacted.value === DIAGNOSTIC_SECRET_REDACTION_OMISSION) return '‹redacted›';
    const candidate = typeof redacted.value === 'object'
      && redacted.value !== null
      && !Array.isArray(redacted.value)
      && typeof (redacted.value as { readonly body?: unknown }).body === 'string'
      ? (redacted.value as { readonly body: string }).body
      : DIAGNOSTIC_SECRET_REDACTION_OMISSION;
    return sanitizeTextEvidence(candidate);
  } catch {
    return '‹redacted›';
  }
}

function sensitiveEvidenceKey(key: string): boolean {
  if (secretStringFieldConfidence(key) !== null) return true;
  const normalized = key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
  return /^(?:authorization|cookie|cookies|setcookie|header|headers|configuredbaseurl|workingdirectory|cwd|path|resourceroot)$/u
    .test(normalized);
}

function sanitizeStringEvidence(value: string): string {
  if (/^data:image\//iu.test(value) || /^data:application\/octet-stream/iu.test(value)) {
    return '‹binary:redacted›';
  }
  const pathRedacted = value
    .replace(/(^|[\s([{"'=])\/(?:Users|private|var|tmp|Volumes|Applications|workspace)(?:\/[^\s'",)\]}<>]+)+/gu, '$1‹path:redacted›')
    .replace(/(^|[\s([{"'=])[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)+/gu, '$1‹path:redacted›');
  const structuredRedacted = redactJsonEncodedStringEvidence(pathRedacted);
  try {
    return redactSecretLikeContent(structuredRedacted);
  } catch {
    return '‹redacted›';
  }
}

function redactJsonEncodedStringEvidence(value: string): string {
  const trimmed = value.trim();
  if (!/^[{["]/u.test(trimmed)) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') {
      const redacted = redactJsonEncodedStringEvidence(parsed);
      return redacted === parsed ? value : JSON.stringify(redacted);
    }
    if (parsed === null || typeof parsed !== 'object') return value;
    const redacted = sanitizeJsonEvidence(parsed);
    return JSON.stringify(redacted);
  } catch {
    return value;
  }
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
    sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
  });
}

function appendTurnRecords(records: ThreadTrajectoryRecordSummary[], loaded: LoadedTurn): void {
  const { diagnostics, turn } = loaded;
  const itemsById = new Map(turn.items.map((item) => [item.id, item]));
  const coveredCompactionItemIds = new Set<string>();
  const insertedPreparedContexts = new Set<string>();

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
            sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
        if (activity.consumedByCallIndex !== null) {
          appendPreparedContextRecords(records, loaded, activity.consumedByCallIndex, insertedPreparedContexts);
        }
        return;
      }
      if (activity.type === 'modelCall') {
        const call = diagnostics.payload.providerCalls[activity.callIndex];
        if (!call) return;
        appendPreparedContextRecords(records, loaded, call.index, insertedPreparedContexts);
        records.push(record({
          kind: 'assistant',
          lane: 'assistant',
          threadId: loaded.threadId,
          turn,
          records,
          sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
            sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
          sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
        sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
    for (const call of diagnostics.payload.providerCalls) {
      appendPreparedContextRecords(records, loaded, call.index, insertedPreparedContexts);
    }
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
      sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
      sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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

function appendPreparedContextRecords(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  callIndex: number | null,
  inserted: Set<string>,
): void {
  const payload = loaded.diagnostics?.payload ?? null;
  if (!payload) return;
  for (const context of preparedContextPartRecords(payload, callIndex)) {
    const fingerprint = preparedContextFingerprint(context);
    if (inserted.has(fingerprint)) continue;
    inserted.add(fingerprint);
    records.push(record({
      kind: 'context',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      records,
      sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
      title: contextPartTitle(context.entries),
      subtitle: contextPartSubtitle(context.entries),
      preview: compact(context.text),
      state: 'completed',
      timing: timing(context.requestedAt, null, context.requestedAt),
      primaryEvidence: preparedContextPartEvidence(loaded.threadId, loaded.turn, context),
      relatedEvidence: [providerCallEvidence(loaded.threadId, loaded.turn, context.callIndex)],
      availability: loaded.availability,
      childThreadId: null,
      usage: null,
    }));
  }
}

function appendToolCatalogRecords(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  state: ToolCatalogProjectionState,
): void {
  const calls = loaded.diagnostics?.payload.providerCalls ?? [];
  for (const call of calls) {
    appendToolCatalogRecordIfChanged(records, loaded, call.index, state);
  }
}

function appendToolCatalogRecordIfChanged(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  callIndex: number,
  state: ToolCatalogProjectionState,
): void {
  const payload = loaded.diagnostics?.payload ?? null;
  if (!payload) return;
  const catalog = toolCatalogRecord(payload, callIndex);
  if (!catalog) return;
  if (catalog.fingerprint === state.fingerprint) return;
  const initial = state.fingerprint === null;
  if (initial && catalog.toolNames.length === 0) return;
  state.fingerprint = catalog.fingerprint;
  records.push(record({
    kind: 'context',
    lane: 'input',
    threadId: loaded.threadId,
    turn: loaded.turn,
    records,
    sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
    title: toolCatalogTitle(!initial),
    subtitle: toolCatalogSubtitle(catalog),
    preview: compact(toolCatalogPreview(catalog)),
    state: 'completed',
    timing: timing(catalog.requestedAt, null, catalog.requestedAt),
    primaryEvidence: toolCatalogEvidenceRef(loaded.threadId, loaded.turn, catalog.callIndex),
    relatedEvidence: [providerCallEvidence(loaded.threadId, loaded.turn, catalog.callIndex)],
    availability: loaded.availability,
    childThreadId: null,
    usage: null,
  }));
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
      sequenceBase: loaded.turnIndex * TRAJECTORY_SEQUENCE_STRIDE,
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
  readonly sequenceBase: number;
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
  const sequence = input.sequenceBase + input.records.filter((entry) => entry.turnId === input.turn.id).length;
  return {
    id: trajectoryRecordId(input.turn.id, input.kind, input.primaryEvidence),
    kind: input.kind,
    lane: input.lane,
    threadId: input.threadId,
    turnId: input.turn.id,
    sequence,
    parentRecordId: input.parentRecordId ?? null,
    title: sanitizeStringEvidence(input.title),
    subtitle: input.subtitle === null ? null : sanitizeStringEvidence(input.subtitle),
    preview: input.preview === null ? null : sanitizeTextEvidence(input.preview),
    state: input.availability.length > 0 && input.state === 'completed' ? 'partial' : input.state,
    timing: input.timing,
    usage: input.usage,
    primaryEvidence: input.primaryEvidence,
    relatedEvidence: input.relatedEvidence,
    availability: input.availability,
    childThreadId: input.childThreadId,
  };
}

function summarizeProjectedTrajectory(
  threadId: ThreadId,
  allTurns: readonly Turn[],
  records: readonly ThreadTrajectoryRecordSummary[],
  loadedTurns: readonly LoadedTurn[],
): ThreadTrajectorySummary {
  const usage = usageSummaryFromTurns(allTurns) ?? records.reduce<ThreadTrajectoryUsageSummary | null>((accumulator, entry) => (
    entry.usage ? addUsage(accumulator, entry.usage) : accumulator
  ), null);
  const startedAt = minNullable(allTurns.map((turn) => turn.startedAt));
  const completedAt = allTurns.some((turn) => turn.completedAt === null)
    ? null
    : maxNullable(allTurns.map((turn) => turn.completedAt));
  return {
    threadId,
    turnCount: allTurns.length,
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
    availability: canonicalTrajectoryAvailability(allTurns, loadedTurns),
  };
}

function summarizeLightweightTrajectory(
  threadId: ThreadId,
  allTurns: readonly Turn[],
  loadedTurns: readonly LoadedTurn[],
): ThreadTrajectorySummary {
  const counts = lightweightTrajectoryCounts(allTurns);
  const usage = usageSummaryFromTurns(allTurns);
  const startedAt = minNullable(allTurns.map((turn) => turn.startedAt));
  const completedAt = allTurns.some((turn) => turn.completedAt === null)
    ? null
    : maxNullable(allTurns.map((turn) => turn.completedAt));
  return {
    threadId,
    turnCount: allTurns.length,
    recordCount: counts.recordCount,
    inputCount: counts.inputCount,
    contextCount: counts.contextCount,
    assistantCount: counts.assistantCount,
    toolCount: counts.toolCount,
    retryCount: 0,
    compactionCount: counts.compactionCount,
    delegationCount: counts.delegationCount,
    startedAt,
    completedAt,
    durationMs: startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt),
    usage,
    availability: canonicalTrajectoryAvailability(allTurns, loadedTurns),
  };
}

function lightweightTrajectoryCounts(turns: readonly Turn[]): {
  readonly assistantCount: number;
  readonly compactionCount: number;
  readonly contextCount: number;
  readonly delegationCount: number;
  readonly inputCount: number;
  readonly recordCount: number;
  readonly toolCount: number;
} {
  let assistantCount = 0;
  let compactionCount = 0;
  let contextCount = 0;
  let delegationCount = 0;
  let inputCount = 0;
  let toolCount = 0;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'userMessage') inputCount += 1;
      else if (item.type === 'contextEvidence') contextCount += 1;
      else if (item.type === 'contextCompaction') compactionCount += 1;
      else if (item.type === 'agentMessage') assistantCount += 1;
      else if (item.type === 'collabAgentToolCall') delegationCount += 1;
      else if (isToolItem(item)) toolCount += 1;
    }
  }
  return {
    assistantCount,
    compactionCount,
    contextCount,
    delegationCount,
    inputCount,
    recordCount: inputCount + contextCount + assistantCount + toolCount + compactionCount + delegationCount,
    toolCount,
  };
}

function canonicalTrajectoryAvailability(
  allTurns: readonly Turn[],
  loadedTurns: readonly LoadedTurn[],
): readonly ThreadTrajectoryAvailability[] {
  const entries: ThreadTrajectoryAvailability[] = [];
  const seen = new Set<string>();
  const push = (entry: ThreadTrajectoryAvailability) => {
    const key = `${entry.reason}\n${entry.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  for (const turn of allTurns) {
    if (turn.status !== 'inProgress' && !turn.execution.diagnosticsRef) {
      push(availability('diagnosticsUnavailable', 'One or more Turns did not retain diagnostics.'));
    }
  }
  for (const loaded of loadedTurns) {
    for (const entry of loaded.availability) push(entry);
  }
  return entries;
}

function usageSummaryFromTurns(turns: readonly Turn[]): ThreadTrajectoryUsageSummary | null {
  return turns.reduce<ThreadTrajectoryUsageSummary | null>((accumulator, turn) => {
    const usage = turn.execution.usage;
    if (!usage) return accumulator;
    return addUsage(accumulator, {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      reasoning: null,
      totalTokens: usage.totalTokens,
      costUsd: usage.cost?.total ?? null,
    });
  }, null);
}

function pageTrajectoryRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
  turnWindow: TurnWindow | null = null,
  turnCount: number | null = null,
): TrajectoryPage {
  const limit = trajectoryLimit(request.limit);
  const cursor = decodeTrajectoryCursor(request.cursor ?? null);
  const page = (() => {
    if (cursor?.direction === 'before') {
      const boundary = records.findIndex((entry) => entry.id === cursor.recordId);
      const end = boundary < 0 ? records.length : boundary;
      return trajectoryPage(records, Math.max(0, end - limit), end);
    }
    if (cursor?.direction === 'after') {
      const boundary = records.findIndex((entry) => entry.id === cursor.recordId);
      const start = boundary < 0 ? 0 : boundary + 1;
      return trajectoryPage(records, start, Math.min(records.length, start + limit));
    }
    const focusIndex = focusIndexForRecords(records, request);
    if (focusIndex >= 0) {
      const end = Math.min(records.length, focusIndex + Math.ceil(limit / 3) + 1);
      const start = Math.max(0, end - limit);
      return trajectoryPage(records, start, end);
    }
    return trajectoryPage(records, Math.max(0, records.length - limit), records.length);
  })();
  if (!turnWindow || turnCount === null) return page;
  const first = page.data[0] ?? null;
  const last = page.data.at(-1) ?? null;
  return {
    ...page,
    olderCursor: page.olderCursor ?? (first && turnWindow.start > 0
      ? encodeTrajectoryCursor('before', first.id)
      : null),
    newerCursor: page.newerCursor ?? (last && turnWindow.end < turnCount
      ? encodeTrajectoryCursor('after', last.id)
      : null),
  };
}

function turnWindowForTrajectoryRead(
  turns: readonly Turn[],
  request: ThreadTrajectoryReadRequest,
): TurnWindow {
  const count = turns.length;
  if (count === 0) return { start: 0, end: 0 };
  const limit = trajectoryLimit(request.limit);
  const cursor = decodeTrajectoryCursor(request.cursor ?? null);
  const cursorTurnIndex = cursor
    ? turnIndexFromRecordId(turns, cursor.recordId)
    : -1;
  if (cursor?.direction === 'before' && cursorTurnIndex >= 0) {
    const end = Math.min(count, cursorTurnIndex + 1);
    return { start: Math.max(0, end - limit - 1), end };
  }
  if (cursor?.direction === 'after' && cursorTurnIndex >= 0) {
    const start = Math.max(0, cursorTurnIndex);
    return { start, end: Math.min(count, start + limit + 1) };
  }
  const focusTurnIndex = focusTurnIndexForRead(turns, request);
  if (focusTurnIndex >= 0) {
    const before = Math.floor(limit * 2 / 3);
    const start = Math.max(0, focusTurnIndex - before);
    return { start, end: Math.min(count, start + limit) };
  }
  return { start: Math.max(0, count - limit), end: count };
}

function focusTurnIndexForRead(
  turns: readonly Turn[],
  request: ThreadTrajectoryReadRequest,
): number {
  const focus = request.focus ?? null;
  if (!focus) return -1;
  if (focus.turnId) return turns.findIndex((turn) => turn.id === focus.turnId);
  if (focus.recordId) return turnIndexFromRecordId(turns, focus.recordId);
  return -1;
}

function turnIndexFromRecordId(turns: readonly Turn[], recordId: string): number {
  const turnId = turnIdFromTrajectoryRecordId(recordId);
  return turnId ? turns.findIndex((turn) => turn.id === turnId) : -1;
}

function trajectoryPage(
  records: readonly ThreadTrajectoryRecordSummary[],
  start: number,
  end: number,
): TrajectoryPage {
  const coveredRecords = records.slice(start, end);
  const data = expandStructuralRecords(records, start, end);
  const first = data[0] ?? null;
  const last = data.at(-1) ?? null;
  const firstIndex = first ? records.findIndex((record) => record.id === first.id) : -1;
  const lastIndex = last ? records.findIndex((record) => record.id === last.id) : -1;
  const replacementRange = trajectoryReplacementRange(coveredRecords);
  return {
    data,
    replacementRange,
    olderCursor: first && firstIndex > 0 ? encodeTrajectoryCursor('before', first.id) : null,
    newerCursor: last && (lastIndex >= 0 && lastIndex < records.length - 1)
      ? encodeTrajectoryCursor('after', last.id)
      : null,
  };
}

function trajectoryReplacementRange(
  records: readonly ThreadTrajectoryRecordSummary[],
): ThreadTrajectoryReplacementRange | null {
  const first = records[0] ?? null;
  const last = records.at(-1) ?? null;
  return first && last
    ? { startSequence: first.sequence, endSequence: last.sequence + 1 }
    : null;
}

function expandStructuralRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
  start: number,
  end: number,
): readonly ThreadTrajectoryRecordSummary[] {
  const included = new Set(records.slice(start, end).map((record) => record.id));
  const byId = new Map(records.map((record) => [record.id, record]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      const parentIncluded = record.parentRecordId !== null && included.has(record.parentRecordId);
      const selfIncluded = included.has(record.id);
      if (selfIncluded && record.parentRecordId && !included.has(record.parentRecordId)) {
        const parent = byId.get(record.parentRecordId);
        if (parent) {
          included.add(parent.id);
          changed = true;
        }
      }
      if (parentIncluded && !selfIncluded) {
        included.add(record.id);
        changed = true;
      }
    }
  }
  return records.filter((record) => included.has(record.id));
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

function encodeTrajectoryCursor(direction: TrajectoryCursor['direction'], recordId: string): string {
  return `${direction}:${encodeURIComponent(recordId)}`;
}

function decodeTrajectoryCursor(value: string | null): TrajectoryCursor | null {
  if (!value) return null;
  const match = /^(before|after):(.+)$/.exec(value);
  if (!match) return null;
  const direction = match[1];
  const encoded = match[2];
  if ((direction !== 'before' && direction !== 'after') || !encoded) return null;
  try {
    return { direction, recordId: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
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
  if (evidence.type === 'preparedContextPart') {
    return [
      `turn:${turnId}:${kind}:prepared`,
      evidence.callIndex,
      evidence.messageIndex,
      evidence.partIndex,
    ].join(':');
  }
  if (evidence.type === 'toolCatalog') return `turn:${turnId}:${kind}:tools:${evidence.callIndex}`;
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

function toolCatalogEvidenceRef(threadId: ThreadId, turn: Turn, callIndex: number): ThreadTrajectoryEvidenceRef {
  return { type: 'toolCatalog', threadId, turnId: turn.id, callIndex };
}

function preparedContextPartEvidence(
  threadId: ThreadId,
  turn: Turn,
  context: Pick<PreparedContextPartRecord, 'callIndex' | 'messageIndex' | 'partIndex'>,
): ThreadTrajectoryEvidenceRef {
  return {
    type: 'preparedContextPart',
    threadId,
    turnId: turn.id,
    callIndex: context.callIndex,
    messageIndex: context.messageIndex,
    partIndex: context.partIndex,
  };
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

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const limit = Math.max(1, Math.min(concurrency, values.length || 1));
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!, index);
    }
  }));
  return results;
}

function turnIdFromTrajectoryRecordId(recordId: string): TurnId | null {
  const match = /^turn:([^:]+):/.exec(recordId);
  return match?.[1] ?? null;
}

function availability(reason: ThreadTrajectoryAvailability['reason'], message: string): ThreadTrajectoryAvailability {
  return { reason, message };
}

function turnEvidence(turn: Turn): ThreadTrajectoryTurnEvidence {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error ? {
      ...turn.error,
      message: sanitizeTextEvidence(turn.error.message),
      ...(turn.error.detail === undefined ? {} : { detail: sanitizeTextEvidence(turn.error.detail) }),
    } : null,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    modelProvider: sanitizeStringEvidence(turn.execution.modelProvider),
    model: sanitizeStringEvidence(turn.execution.model),
    reasoningEffort: turn.execution.reasoningEffort,
  };
}

function itemEvidence(item: ThreadItem): ThreadTrajectoryItemEvidence {
  return {
    itemId: item.id,
    type: item.type,
    title: sanitizeStringEvidence(itemTitle(item)),
    preview: compact(itemSummary(item)),
    status: isToolItem(item) ? item.status : null,
  };
}

function userMessageEvidence(item: UserMessageThreadItem): ThreadTrajectoryUserMessageEvidence {
  return {
    itemId: item.id,
    acceptedAt: item.acceptedAt,
    content: item.content.map(userContentEvidence),
  };
}

function userContentEvidence(content: ThreadUserContent): ThreadUserContent {
  if (content.type === 'text') {
    return { ...content, text: sanitizeTextEvidence(content.text) };
  }
  if (content.type === 'nodeReference') {
    return {
      ...content,
      ...(content.note === undefined ? {} : { note: sanitizeTextEvidence(content.note) }),
    };
  }
  return {
    ...content,
    name: sanitizeStringEvidence(content.name),
    source: fileSourceEvidence(content.source),
    ...(content.extractedText === undefined ? {} : { extractedText: sanitizeTextEvidence(content.extractedText) }),
    ...(content.artifactRef === undefined ? {} : {
      artifactRef: imageArtifactEvidence(content.artifactRef),
    }),
  };
}

function fileSourceEvidence(source: ThreadFileSource): ThreadFileSource {
  return source.kind === 'localFile'
    ? { ...source, path: sanitizeStringEvidence(source.path) }
    : { ...source, ref: resourceEvidence(source.ref) };
}

function resourceEvidence(ref: ThreadResourceReference): ThreadResourceReference {
  return { ...ref, fileName: sanitizeStringEvidence(ref.fileName) };
}

function imageArtifactEvidence(ref: ThreadImageArtifactReference): ThreadImageArtifactReference {
  return {
    ...ref,
    original: ref.original ? fileSourceEvidence(ref.original) : null,
    observation: resourceEvidence(ref.observation),
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
  return contextKindTitle(item.kind);
}

function contextPartTitle(entries: readonly TurnDiagnosticsSystemContextEntry[]): string {
  return entries.length === 1 ? contextKindTitle(entries[0]!.kind) : 'System Reminder';
}

function contextPartSubtitle(entries: readonly TurnDiagnosticsSystemContextEntry[]): string | null {
  if (entries.length === 1) {
    const entry = entries[0]!;
    return `${entry.authority} · ${entry.purpose}`;
  }
  return `${entries.length} context blocks`;
}

function contextKindTitle(kind: string): string {
  return kind.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
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
  const normalized = sanitizeStringEvidence(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > PREVIEW_LIMIT ? `${normalized.slice(0, PREVIEW_LIMIT - 1)}…` : normalized;
}
