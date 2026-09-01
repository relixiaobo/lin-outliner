import { createHash } from 'node:crypto';
import type {
  JsonValue,
  ModelToolCallArguments,
  ModelToolCallEvidenceReason,
  ModelToolCallHistory,
  ModelToolIdentity,
  ModelProviderToolCall,
  ThreadContextPayloadReference,
} from '../../../core/agent/protocol';
import {
  MAX_INLINE_MODEL_TOOL_ARGUMENT_BYTES,
  MAX_MODEL_TOOL_CORRECTION_BYTES,
  MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES,
  MAX_MODEL_TOOL_PROVIDER_NAME_BYTES,
  MAX_MODEL_PROVIDER_CALL_FIELD_BYTES,
  MAX_MODEL_PROVIDER_THOUGHT_SIGNATURE_BYTES,
} from '../../../core/agent/protocol';
import {
  redactSecretLikeContent,
  redactSecretLikeJsonAsync,
  redactSecretLikeTextAsync,
} from '../capabilities/agentSecretRedaction';
import type { AgentTool, AgentToolLargeTextArguments, AssistantMessage } from './kernel/types';
import {
  replaceSelectedLargeTextArguments,
  selectLargeTextArguments,
  type SelectedLargeTextArgument,
} from './largeTextArguments';

export interface ToolCallAdmissionRequest {
  readonly toolCallId: string;
  readonly providerName: string;
  readonly providerCall: ModelProviderToolCall;
  readonly outcome:
    | {
      readonly type: 'admitted';
      readonly identity: ModelToolIdentity;
      /** Exact provider-authored arguments retained for model history. */
      readonly arguments: JsonValue;
      readonly redactedArguments: JsonValue;
      readonly redactedPaths: readonly string[];
      /** Tool-prepared, secret-redacted arguments used by Item presentation. */
      readonly displayArguments: JsonValue;
      readonly schemaDigest: string;
      readonly redactedArgumentsReplayable: boolean;
      readonly largeTextArguments?: AgentToolLargeTextArguments;
      }
    | {
        readonly type: 'rejected';
        readonly identity: ModelToolIdentity | null;
        readonly redactedArguments: JsonValue;
        readonly reason: Extract<
          ModelToolCallEvidenceReason,
          'unresolvedTool' | 'invalidArguments' | 'truncatedArguments'
        >;
        readonly correction: string;
      };
}

export interface ToolCallAdmissionDecision {
  readonly modelCall: ModelToolCallHistory;
  /** Transient, redacted presentation input; admitted calls retain their complete argument structure. */
  readonly displayArguments: JsonValue;
  readonly execute: boolean;
}

export interface AssistantToolCallAdmission {
  readonly toolCallId: string;
  readonly providerToolCallId: string;
  readonly decision: ToolCallAdmissionDecision;
}

export function rewriteAssistantToolCallHistory(
  message: AssistantMessage,
  admissions: readonly AssistantToolCallAdmission[],
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  let admissionIndex = 0;
  for (const part of message.content) {
    if (part.type !== 'toolCall') {
      content.push(part);
      continue;
    }
    const admission = admissions[admissionIndex];
    admissionIndex += 1;
    if (!admission) continue;
    const { modelCall } = admission.decision;
    if (!admission.decision.execute) {
      content.push({
        type: 'text',
        text: modelCall.disposition === 'evidenceOnly'
          ? toolCallEvidenceText(admission.toolCallId, modelCall)
          : `[Tool call ${admission.toolCallId} was not executed.]`,
      });
      continue;
    }
    content.push({ ...part, id: admission.providerToolCallId });
  }
  return { ...message, content };
}

export async function persistToolCallAdmission(
  request: ToolCallAdmissionRequest,
  persistArguments: (
    value: JsonValue,
    selected: readonly SelectedLargeTextArgument[],
  ) => Promise<ModelToolCallArguments>,
): Promise<ToolCallAdmissionDecision> {
  if (request.outcome.type === 'rejected') return rejectedAdmission(request);
  const durableValue = request.outcome.redactedArguments;
  if (request.outcome.redactedPaths.length > 0 && !request.outcome.redactedArgumentsReplayable) {
    return incompatibleRedactedAdmission(request, durableValue);
  }
  if (!providerCallIsReplayable(request.providerCall)) {
    return providerReplayUnavailableAdmission(request, durableValue);
  }
  let source: ModelToolCallArguments;
  try {
    source = await modelToolCallArguments(
      durableValue,
      request.outcome.largeTextArguments,
      persistArguments,
    );
  } catch {
    return persistenceRejectedAdmission(request, durableValue);
  }
  if (request.outcome.redactedPaths.length > 0) {
    return {
      modelCall: {
        disposition: 'redactedReplay',
        identity: request.outcome.identity,
        providerName: request.providerName,
        providerCall: request.providerCall,
        redactedArguments: source,
        redactedPaths: request.outcome.redactedPaths,
        schemaDigest: request.outcome.schemaDigest,
      },
      displayArguments: request.outcome.displayArguments,
      execute: true,
    };
  }
  return {
    modelCall: {
      disposition: 'replayable',
      identity: request.outcome.identity,
      providerName: request.providerName,
      providerCall: request.providerCall,
      arguments: source,
      schemaDigest: request.outcome.schemaDigest,
    },
    displayArguments: request.outcome.displayArguments,
    execute: true,
  };
}

export function transientToolCallAdmission(request: ToolCallAdmissionRequest): ToolCallAdmissionDecision {
  if (request.outcome.type === 'rejected') return rejectedAdmission(request);
  const durableValue = request.outcome.redactedArguments;
  if (request.outcome.redactedPaths.length > 0 && !request.outcome.redactedArgumentsReplayable) {
    return incompatibleRedactedAdmission(request, durableValue);
  }
  if (!providerCallIsReplayable(request.providerCall)) {
    return providerReplayUnavailableAdmission(request, durableValue);
  }
  const source = inlineModelToolCallArguments(durableValue);
  if (!source) return persistenceRejectedAdmission(request, durableValue);
  const modelCall = request.outcome.redactedPaths.length > 0
    ? {
        disposition: 'redactedReplay' as const,
        identity: request.outcome.identity,
        providerName: request.providerName,
        providerCall: request.providerCall,
        redactedArguments: source,
        redactedPaths: request.outcome.redactedPaths,
        schemaDigest: request.outcome.schemaDigest,
      }
    : {
        disposition: 'replayable' as const,
        identity: request.outcome.identity,
        providerName: request.providerName,
        providerCall: request.providerCall,
        arguments: source,
        schemaDigest: request.outcome.schemaDigest,
      };
  return {
    modelCall,
    displayArguments: request.outcome.displayArguments,
    execute: true,
  };
}

export function persistenceFailureAdmission(
  request: ToolCallAdmissionRequest,
): ToolCallAdmissionDecision {
  if (request.outcome.type === 'rejected') return rejectedAdmission(request);
  return persistenceRejectedAdmission(request, request.outcome.redactedArguments);
}

export async function prepareToolCallArguments(
  value: unknown,
  contract?: AgentToolLargeTextArguments,
): Promise<{
  readonly arguments: JsonValue;
  readonly redactedArguments: JsonValue;
  readonly redactedPaths: readonly string[];
}> {
  const argumentsValue = jsonValue(value);
  const selected = selectLargeTextArguments(argumentsValue, contract);
  if (selected.length === 0) {
    const redacted = await redactSecretLikeJsonAsync(argumentsValue);
    return {
      arguments: argumentsValue,
      redactedArguments: redacted.value,
      redactedPaths: redacted.redactedPaths,
    };
  }
  const skeleton = replaceSelectedLargeTextArguments(
    argumentsValue,
    selected,
    selected.map(() => null),
  );
  const [redactedSkeleton, ...redactedText] = await Promise.all([
    redactSecretLikeJsonAsync(skeleton),
    ...selected.map((binding) => redactSecretLikeTextAsync(binding.value)),
  ]);
  const redactedArguments = replaceSelectedLargeTextArguments(
    redactedSkeleton.value,
    selected,
    redactedText.map((result) => result.value),
    'null',
  );
  const redactedPaths = [
    ...redactedSkeleton.redactedPaths,
    ...selected.flatMap((binding, index) => (
      redactedText[index]!.value === binding.value ? [] : [binding.path]
    )),
  ].sort();
  return {
    arguments: argumentsValue,
    redactedArguments,
    redactedPaths,
  };
}

export function modelToolSchemaDigest(schema: unknown): string {
  return createHash('sha256').update(stableJson(jsonValue(schema))).digest('hex');
}

export function canonicalToolIdentity(tool: AgentTool): ModelToolIdentity {
  if (tool.canonicalIdentity) return tool.canonicalIdentity;
  const separator = tool.name.indexOf('__');
  return separator < 0
    ? { namespace: null, name: tool.name }
    : { namespace: tool.name.slice(0, separator), name: tool.name.slice(separator + 2) };
}

export function boundedRedactedJsonSummary(
  normalized: JsonValue,
  maxBytes = MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES,
): JsonValue {
  const encoded = JSON.stringify(normalized);
  const originalBytes = utf8Bytes(encoded);
  if (originalBytes <= maxBytes) return normalized;
  const summary = (preview: string): JsonValue => ({
    truncated: true,
    originalChars: encoded.length,
    originalBytes,
    preview,
  });
  let low = 0;
  let high = encoded.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (serializedBytes(summary(encoded.slice(0, midpoint))) <= maxBytes) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return summary(encoded.slice(0, low));
}

export function evidenceCorrection(reason: ModelToolCallEvidenceReason): string {
  switch (reason) {
    case 'unresolvedTool':
      return 'Choose a currently exposed tool and derive a new call from its active schema.';
    case 'invalidArguments':
    case 'schemaIncompatible':
      return 'Derive a new call from the active schema; do not copy the rejected historical arguments.';
    case 'truncatedArguments':
      return 'Re-derive the complete arguments before issuing another call.';
    case 'argumentPersistenceUnavailable':
    case 'argumentPayloadUnavailable':
      return 'Do not retry from this record; re-derive any later call from an authorized source.';
    case 'providerReplayUnavailable':
      return 'The call executed, but its provider replay metadata was not retained. Inspect current state before acting.';
    case 'resultPayloadUnavailable':
      return 'Treat the historical outcome as incomplete and inspect current state before acting.';
  }
}

export function redactedReplayMarker(callId: string, redactedPaths: readonly string[]): string {
  return `[Tool call ${callId} replay notice: executed argument values at ${redactedPaths.join(', ')} `
    + 'were redacted after execution. Do not retry the call or copy redacted placeholders. '
    + 'Re-derive any later value from an authorized source.]';
}

export function toolCallEvidenceText(
  callId: string,
  evidence: Extract<ModelToolCallHistory, { readonly disposition: 'evidenceOnly' }>,
): string {
  return `[Tool call admission evidence: ${JSON.stringify({
    callId,
    providerName: evidence.providerName,
    identity: evidence.identity,
    reason: evidence.reason,
    redactedArgumentsSummary: evidence.redactedArgumentsSummary,
    correction: evidence.correction,
  })}]`;
}

function rejectedAdmission(request: ToolCallAdmissionRequest): ToolCallAdmissionDecision {
  if (request.outcome.type !== 'rejected') throw new Error('Expected a rejected tool-call admission.');
  const summary = boundedRedactedJsonSummary(request.outcome.redactedArguments);
  return {
    modelCall: {
      disposition: 'evidenceOnly',
      identity: request.outcome.identity,
      providerName: boundedEvidenceText(request.providerName, MAX_MODEL_TOOL_PROVIDER_NAME_BYTES),
      redactedArgumentsSummary: summary,
      reason: request.outcome.reason,
      correction: boundedEvidenceText(request.outcome.correction, MAX_MODEL_TOOL_CORRECTION_BYTES),
    },
    displayArguments: summary,
    execute: false,
  };
}

function persistenceRejectedAdmission(
  request: ToolCallAdmissionRequest,
  redactedArguments: JsonValue,
): ToolCallAdmissionDecision {
  if (request.outcome.type !== 'admitted') throw new Error('Expected an admitted tool-call request.');
  const summary = boundedRedactedJsonSummary(redactedArguments);
  return {
    modelCall: {
      disposition: 'evidenceOnly',
      identity: request.outcome.identity,
      providerName: boundedEvidenceText(request.providerName, MAX_MODEL_TOOL_PROVIDER_NAME_BYTES),
      redactedArgumentsSummary: summary,
      reason: 'argumentPersistenceUnavailable',
      correction: evidenceCorrection('argumentPersistenceUnavailable'),
    },
    displayArguments: boundedRedactedJsonSummary(request.outcome.displayArguments),
    execute: false,
  };
}

function incompatibleRedactedAdmission(
  request: ToolCallAdmissionRequest,
  redactedArguments: JsonValue,
): ToolCallAdmissionDecision {
  if (request.outcome.type !== 'admitted') throw new Error('Expected an admitted tool-call request.');
  return {
    modelCall: {
      disposition: 'evidenceOnly',
      identity: request.outcome.identity,
      providerName: request.providerName,
      redactedArgumentsSummary: boundedRedactedJsonSummary(redactedArguments),
      reason: 'schemaIncompatible',
      correction: 'The executed values were redacted and cannot be replayed. Preserve the outcome as evidence only.',
    },
    displayArguments: request.outcome.displayArguments,
    execute: true,
  };
}

function providerReplayUnavailableAdmission(
  request: ToolCallAdmissionRequest,
  redactedArguments: JsonValue,
): ToolCallAdmissionDecision {
  if (request.outcome.type !== 'admitted') throw new Error('Expected an admitted tool-call request.');
  return {
    modelCall: {
      disposition: 'evidenceOnly',
      identity: request.outcome.identity,
      providerName: boundedEvidenceText(request.providerName, MAX_MODEL_TOOL_PROVIDER_NAME_BYTES),
      redactedArgumentsSummary: boundedRedactedJsonSummary(redactedArguments),
      reason: 'providerReplayUnavailable',
      correction: evidenceCorrection('providerReplayUnavailable'),
    },
    displayArguments: boundedRedactedJsonSummary(request.outcome.displayArguments),
    execute: true,
  };
}

function providerCallIsReplayable(providerCall: ModelProviderToolCall): boolean {
  return providerCall.id.length > 0
    && providerCall.api.length > 0
    && providerCall.provider.length > 0
    && providerCall.model.length > 0
    && utf8Bytes(providerCall.id) <= MAX_MODEL_PROVIDER_CALL_FIELD_BYTES
    && utf8Bytes(providerCall.api) <= MAX_MODEL_PROVIDER_CALL_FIELD_BYTES
    && utf8Bytes(providerCall.provider) <= MAX_MODEL_PROVIDER_CALL_FIELD_BYTES
    && utf8Bytes(providerCall.model) <= MAX_MODEL_PROVIDER_CALL_FIELD_BYTES
    && (
      providerCall.thoughtSignature === null
      || (
        providerCall.thoughtSignature.length > 0
        && utf8Bytes(providerCall.thoughtSignature) <= MAX_MODEL_PROVIDER_THOUGHT_SIGNATURE_BYTES
      )
    );
}

async function modelToolCallArguments(
  value: JsonValue,
  contract: AgentToolLargeTextArguments | undefined,
  persistArguments: (
    value: JsonValue,
    selected: readonly SelectedLargeTextArgument[],
  ) => Promise<ModelToolCallArguments>,
): Promise<ModelToolCallArguments> {
  const inline = inlineModelToolCallArguments(value);
  if (inline) return inline;
  return persistArguments(value, selectLargeTextArguments(value, contract));
}

function inlineModelToolCallArguments(value: JsonValue): ModelToolCallArguments | null {
  return serializedBytes(value) <= MAX_INLINE_MODEL_TOOL_ARGUMENT_BYTES
    ? { storage: 'inline', value }
    : null;
}

function jsonValue(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value ?? null);
    return JSON.parse(encoded) as JsonValue;
  } catch {
    return '[unserializable arguments]';
  }
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key]!)}`
  )).join(',')}}`;
}

function boundedUtf8Text(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = '...[truncated]';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (utf8Bytes(`${value.slice(0, midpoint)}${suffix}`) <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function boundedEvidenceText(value: string, maxBytes: number): string {
  return boundedUtf8Text(redactSecretLikeContent(value), maxBytes);
}

function serializedBytes(value: JsonValue): number {
  return utf8Bytes(JSON.stringify(value));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
