import { createHash } from 'node:crypto';
import { modelCallArgumentSource } from '../../../core/agent/modelCallHistory';
import {
  MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES,
  type JsonValue,
  type ThreadId,
  type ThreadItem,
  type ThreadTrajectoryAvailability,
  type ThreadTrajectoryEvidenceRef,
  type ThreadTrajectoryProviderCallEvidence,
  type ThreadTrajectoryRecordSummary,
  type Turn,
  type TurnDiagnosticsPayload,
  type TurnDiagnosticsPayloadReference,
  type TurnDiagnosticsSystemContextEntry,
  type TurnId,
} from '../../../core/agent/protocol';
import { rehydrateLargeTextArguments } from '../runtime/largeTextArguments';
import { ThreadCore } from './ThreadCore';

/** Resolves retained original values without owning storage or presentation. */
export class ThreadRecordSources {
  constructor(
    private readonly core: ThreadCore,
    private readonly readActiveDiagnostics:
      | ((threadId: ThreadId, turnId: TurnId) => TurnDiagnosticsPayload | null)
      | null = null,
  ) {}
  async readDiagnostics(
    threadId: ThreadId,
    turn: Turn,
  ): Promise<{
    readonly bundle: DiagnosticsBundle | null;
    readonly availability: readonly ThreadTrajectoryAvailability[];
  }> {
    const ref = turn.execution.diagnosticsRef;
    if (!ref) {
      const activePayload =
        turn.status === 'inProgress' ? (this.readActiveDiagnostics?.(threadId, turn.id) ?? null) : null;
      if (activePayload) {
        const activeBundle = activeDiagnosticsBundle(activePayload);
        if (activeBundle) return { bundle: activeBundle, availability: [] };
        return {
          bundle: null,
          availability: [availability('diagnosticsUnavailable')],
        };
      }
      return {
        bundle: null,
        availability: turn.status === 'inProgress' ? [] : [availability('diagnosticsUnavailable')],
      };
    }
    try {
      const payload = await this.core.payloads.readTurnDiagnostics(threadId, ref);
      if (!payload) {
        return {
          bundle: null,
          availability: [availability('diagnosticsUnavailable')],
        };
      }
      return { bundle: { ref, payload, retention: 'persisted' }, availability: [] };
    } catch {
      return {
        bundle: null,
        availability: [availability('diagnosticsCorrupt')],
      };
    }
  }

  async readToolInput(
    threadId: ThreadId,
    diagnostics: TurnDiagnosticsPayload | null,
    activityIndex: number | null,
    execution: TrajectoryToolExecution | null,
    item: ThreadItem | null,
    turnId: TurnId,
    retention: 'persisted' | 'live' = 'persisted',
  ) {
    const batch = activityIndex === null ? null : diagnostics?.activities[activityIndex];
    return resolvedSource(await this.toolInputValue(threadId, diagnostics, activityIndex, execution, item), {
      threadId,
      turnId,
      itemId: item?.id ?? null,
      kind: diagnostics ? 'provider-tool-arguments' : 'replay-arguments',
      owner: diagnostics ? 'TurnDiagnosticsCollector' : 'ToolPayloadStore/Rollout',
      retention: diagnostics ? retention : 'persisted',
      coordinates: {
        activityIndex,
        executionIndex:
          batch?.type === 'toolExecutionBatch' && execution ? batch.executions.indexOf(execution) : null,
        callIndex: batch?.type === 'toolExecutionBatch' ? batch.sourceCallIndex : null,
        responsePartIndex: execution?.providerResponsePartIndex ?? null,
      },
    });
  }
  async readToolOutput(threadId: ThreadId, item: ThreadItem | null, turnId: TurnId) {
    return resolvedSource(await this.toolOutputValue(threadId, item), {
      threadId,
      turnId,
      itemId: item?.id ?? null,
      kind: 'recorded-tool-result',
      owner: 'ToolPayloadStore',
      retention: 'persisted',
      coordinates: { ref: item && 'outputRef' in item ? item.outputRef : null },
    });
  }
  async readCompactionSummary(threadId: ThreadId, item: ThreadItem | null, turnId: TurnId) {
    return resolvedSource(await this.compactionSummaryValue(threadId, item), {
      threadId,
      turnId,
      itemId: item?.id ?? null,
      kind: 'compaction-summary',
      owner: 'ToolPayloadStore',
      retention: 'persisted',
      coordinates: { ref: item?.type === 'contextCompaction' ? item.summaryRef : null },
    });
  }

  private async toolInputValue(
    threadId: ThreadId,
    diagnostics: TurnDiagnosticsPayload | null,
    activityIndex: number | null,
    execution: TrajectoryToolExecution | null,
    item: ThreadItem | null,
  ): Promise<EvidenceReadResult<JsonValue | null>> {
    if (diagnostics) {
      if (activityIndex === null || !execution) return unavailableEvidence('evidenceUnavailable');
      return providerToolInputEvidence(diagnostics, activityIndex, execution);
    }
    if (!item || !('modelCall' in item)) return retainedEvidence(null);
    if (item.modelCall.disposition !== 'replayable') return unavailableEvidence('evidenceUnavailable');
    const source = modelCallArgumentSource(item.modelCall);
    if (source.storage === 'inline') {
      return retainedEvidence(structuredClone(source.value));
    }
    try {
      const payload = await this.core.payloads.readContext(threadId, source.ref);
      if (payload?.kind !== 'toolCallArguments') return unavailableEvidence('payloadUnavailable');
      const rehydrated = await rehydrateLargeTextArguments(payload, source.internalTextRefs, (ref) =>
        this.core.payloads.readInternalText(threadId, ref),
      );
      return rehydrated === null ? unavailableEvidence('payloadUnavailable') : retainedEvidence(rehydrated);
    } catch {
      return unavailableEvidence('payloadUnavailable');
    }
  }

  private async toolOutputValue(
    threadId: ThreadId,
    item: ThreadItem | null,
  ): Promise<EvidenceReadResult<string | null>> {
    if (!item || !('outputRef' in item) || !item.outputRef) return retainedEvidence(null);
    try {
      const text = await this.core.payloads.readTextReference(threadId, item.outputRef);
      return text === null ? unavailableEvidence('evidenceUnavailable') : retainedEvidence(text);
    } catch {
      return unavailableEvidence('evidenceUnavailable');
    }
  }

  private async compactionSummaryValue(
    threadId: ThreadId,
    item: ThreadItem | null,
  ): Promise<EvidenceReadResult<string | null>> {
    if (item?.type !== 'contextCompaction') return retainedEvidence(null);
    try {
      const payload = await this.core.payloads.readContext(threadId, item.summaryRef);
      return payload?.kind === 'compactionSummary'
        ? retainedEvidence(payload.text)
        : unavailableEvidence('payloadUnavailable');
    } catch {
      return unavailableEvidence('payloadUnavailable');
    }
  }
}

export type DiagnosticsBundle = {
  readonly ref: TurnDiagnosticsPayloadReference;
  readonly payload: TurnDiagnosticsPayload;
  readonly retention: 'persisted' | 'live';
};

export function availability(reason: ThreadTrajectoryAvailability['reason']): ThreadTrajectoryAvailability {
  return { reason };
}

export function activeDiagnosticsBundle(payload: TurnDiagnosticsPayload): DiagnosticsBundle | null {
  const encoded = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES) return null;
  return {
    retention: 'live',
    ref: {
      id: createHash('sha256').update(encoded).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
      byteLength,
      schemaVersion: 1,
    },
    payload,
  };
}

export type TrajectoryToolExecution = Extract<
  TurnDiagnosticsPayload['activities'][number],
  { readonly type: 'toolExecutionBatch' }
>['executions'][number];

export interface EvidenceReadResult<T> {
  readonly value: T;
  readonly availability: readonly ThreadTrajectoryAvailability[];
}

export function unavailableEvidence(
  reason: ThreadTrajectoryAvailability['reason'],
): EvidenceReadResult<null> {
  return { value: null, availability: [availability(reason)] };
}

export function providerToolInputEvidence(
  payload: TurnDiagnosticsPayload,
  activityIndex: number,
  execution: TrajectoryToolExecution,
): EvidenceReadResult<JsonValue | null> {
  const batch = payload.activities[activityIndex] ?? null;
  if (batch?.type !== 'toolExecutionBatch') return unavailableEvidence('evidenceUnavailable');
  const response = payload.providerCalls[batch.sourceCallIndex]?.response?.value ?? null;
  const part = modelResponseContent(response)?.[execution.providerResponsePartIndex] ?? null;
  if (typeof part !== 'object' || part === null || Array.isArray(part)) {
    return unavailableEvidence('evidenceUnavailable');
  }
  const record = part as Readonly<Record<string, JsonValue>>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase().replace(/[_-]/g, '') : '';
  if (type !== 'toolcall' && type !== 'functioncall') return unavailableEvidence('evidenceUnavailable');
  for (const key of ['arguments', 'args', 'input'] as const) {
    if (Object.hasOwn(record, key)) return retainedEvidence(structuredClone(record[key] ?? null));
  }
  return unavailableEvidence('evidenceUnavailable');
}

export function modelResponseContent(value: JsonValue | null): readonly JsonValue[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [value];
  const record = value as Readonly<Record<string, JsonValue>>;
  const content = record.content ?? record.parts;
  if (Array.isArray(content)) return content;
  if (content !== undefined && content !== null) return [content];
  return [value];
}

export function retainedEvidence<T>(value: T): EvidenceReadResult<T> {
  return { value, availability: [] };
}

export function materializeProviderRequest(
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

export function modelContextTextForContextRecord(
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

export function stablePromptModelText(payload: TurnDiagnosticsPayload): string | null {
  for (const call of payload.providerCalls) {
    const fragment = payload.requestFragments.find(
      (candidate) => candidate.id === call.preparedContext.systemPromptFragmentId,
    );
    const text = semanticText(fragment?.value ?? null);
    if (text) return text;
  }
  return null;
}

export function semanticText(value: JsonValue | null): string | null {
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

export function modelContextTextForPreparedContextPart(
  payload: TurnDiagnosticsPayload,
  ref: PreparedContextPartEvidenceRef,
): string | null {
  return preparedContextPartRecord(payload, ref)?.text ?? null;
}

export type PreparedContextPartEvidenceRef = Extract<
  ThreadTrajectoryEvidenceRef,
  { readonly type: 'preparedContextPart' }
>;

export function preparedContextPartRecord(
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
    text: partText,
    requestedAt: call.requestedAt,
  };
}

export interface PreparedContextPartRecord {
  readonly callIndex: number;
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly entries: readonly TurnDiagnosticsSystemContextEntry[];
  readonly text: string;
  readonly requestedAt: number;
}

export function textForMessagePart(message: JsonValue | null, partIndex: number): string | null {
  return semanticText(messagePart(message, partIndex));
}

export function messagePart(message: JsonValue | null, partIndex: number): JsonValue | null {
  if (message === null) return null;
  if (typeof message === 'string') return partIndex === 0 ? message : null;
  if (typeof message !== 'object' || Array.isArray(message)) return null;
  const record = message as Readonly<Record<string, JsonValue>>;
  const content = record.content ?? record.parts;
  if (Array.isArray(content)) return content[partIndex] ?? null;
  return partIndex === 0 ? (content ?? message) : null;
}

export function toolCatalogEvidence(
  payload: TurnDiagnosticsPayload | null,
  callIndex: number,
): JsonValue | null {
  if (!payload) return null;
  const catalog = toolCatalogRecord(payload, callIndex);
  if (!catalog) return null;
  return {
    kind: 'toolCatalog',
    requestIndex: catalog.callIndex,
    toolNames: [...catalog.toolNames],
    tools: structuredClone(catalog.tools),
  };
}

export function toolCatalogRecord(
  payload: TurnDiagnosticsPayload,
  callIndex: number,
): ToolCatalogRecord | null {
  const call = payload.providerCalls[callIndex] ?? null;
  if (!call) return null;
  const schemasByName = new Map(payload.toolSchemas.map((schema) => [schema.name, schema]));
  const tools = call.preparedContext.toolNames.map((name): JsonValue => {
    const schema = schemasByName.get(name);
    return schema ? exactJsonValue(schema) : { name, schemaUnavailable: true };
  });
  return {
    callIndex: call.index,
    toolNames: call.preparedContext.toolNames,
    tools,
    fingerprint: JSON.stringify(tools),
    requestedAt: call.requestedAt,
  };
}

export interface ToolCatalogRecord {
  readonly callIndex: number;
  readonly toolNames: readonly string[];
  readonly tools: readonly JsonValue[];
  readonly fingerprint: string;
  readonly requestedAt: number;
}

export function exactJsonValue(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

export function providerCallDiagnosticsEvidence(
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
    request: structuredClone(materializeProviderRequest(payload, call)),
    response: call.response ? exactJsonValue(call.response) : null,
    transportResponse: call.transportResponse,
  };
}

export interface ThreadRecordSource {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: string | null;
  readonly kind: string;
  readonly owner: string;
  readonly retention: 'persisted' | 'live';
  readonly coordinates: unknown;
}
function resolvedSource<T>(result: EvidenceReadResult<T>, source: ThreadRecordSource) {
  return {
    ...result,
    source,
    contentIdentity:
      result.value === null ? null : createHash('sha256').update(JSON.stringify(result.value)).digest('hex'),
  };
}
