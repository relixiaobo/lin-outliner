import { createHash } from 'node:crypto';
import type {
  JsonValue,
  ModelToolCallArguments,
  ModelToolCallEvidenceReason,
  ModelToolCallHistory,
  ModelToolIdentity,
  ThreadContextPayloadReference,
} from '../../../core/agent/protocol';
import {
  MAX_INLINE_MODEL_TOOL_ARGUMENT_BYTES,
  MAX_MODEL_TOOL_CORRECTION_BYTES,
  MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES,
  MAX_MODEL_TOOL_PROVIDER_NAME_BYTES,
} from '../../../core/agent/protocol';
import { redactSecretLikeJson } from '../capabilities/agentSecretRedaction';
import type { AgentTool } from './kernel/types';

export interface ToolCallAdmissionRequest {
  readonly toolCallId: string;
  readonly providerName: string;
  readonly outcome:
    | {
        readonly type: 'admitted';
        readonly identity: ModelToolIdentity;
        readonly arguments: JsonValue;
        readonly schemaDigest: string;
      }
    | {
        readonly type: 'rejected';
        readonly identity: ModelToolIdentity | null;
        readonly arguments: unknown;
        readonly reason: Extract<
          ModelToolCallEvidenceReason,
          'unresolvedTool' | 'invalidArguments' | 'truncatedArguments'
        >;
        readonly correction: string;
      };
}

export interface ToolCallAdmissionDecision {
  readonly modelCall: ModelToolCallHistory;
  /** Safe, bounded arguments used only by presentation Item construction. */
  readonly displayArguments: JsonValue;
  readonly execute: boolean;
}

export async function persistToolCallAdmission(
  request: ToolCallAdmissionRequest,
  persistArguments: (value: JsonValue) => Promise<ThreadContextPayloadReference>,
): Promise<ToolCallAdmissionDecision> {
  if (request.outcome.type === 'rejected') return rejectedAdmission(request);
  const redacted = redactSecretLikeJson(request.outcome.arguments);
  const durableValue = redacted.value;
  let source: ModelToolCallArguments;
  try {
    source = await modelToolCallArguments(durableValue, persistArguments);
  } catch {
    return persistenceRejectedAdmission(request, durableValue);
  }
  if (redacted.redactedPaths.length > 0) {
    return {
      modelCall: {
        disposition: 'redactedReplay',
        identity: request.outcome.identity,
        redactedArguments: source,
        redactedPaths: redacted.redactedPaths,
        schemaDigest: request.outcome.schemaDigest,
      },
      displayArguments: boundedJsonSummary(durableValue),
      execute: true,
    };
  }
  return {
    modelCall: {
      disposition: 'replayable',
      identity: request.outcome.identity,
      arguments: source,
      schemaDigest: request.outcome.schemaDigest,
    },
    displayArguments: boundedJsonSummary(durableValue),
    execute: true,
  };
}

export function transientToolCallAdmission(request: ToolCallAdmissionRequest): ToolCallAdmissionDecision {
  if (request.outcome.type === 'rejected') return rejectedAdmission(request);
  const redacted = redactSecretLikeJson(request.outcome.arguments);
  const source = inlineModelToolCallArguments(redacted.value);
  if (!source) return persistenceRejectedAdmission(request, redacted.value);
  const modelCall = redacted.redactedPaths.length > 0
    ? {
        disposition: 'redactedReplay' as const,
        identity: request.outcome.identity,
        redactedArguments: source,
        redactedPaths: redacted.redactedPaths,
        schemaDigest: request.outcome.schemaDigest,
      }
    : {
        disposition: 'replayable' as const,
        identity: request.outcome.identity,
        arguments: source,
        schemaDigest: request.outcome.schemaDigest,
      };
  return {
    modelCall,
    displayArguments: boundedJsonSummary(redacted.value),
    execute: true,
  };
}

export function persistenceFailureAdmission(
  request: ToolCallAdmissionRequest,
): ToolCallAdmissionDecision {
  if (request.outcome.type === 'rejected') return rejectedAdmission(request);
  const redacted = redactSecretLikeJson(request.outcome.arguments).value;
  return persistenceRejectedAdmission(request, redacted);
}

export function providerHistoryArguments(
  request: ToolCallAdmissionRequest,
  decision: ToolCallAdmissionDecision,
): JsonValue | null {
  if (request.outcome.type === 'rejected' || decision.modelCall.disposition === 'evidenceOnly') return null;
  return decision.modelCall.disposition === 'redactedReplay'
    ? redactSecretLikeJson(request.outcome.arguments).value
    : request.outcome.arguments;
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

export function boundedJsonSummary(value: unknown): JsonValue {
  const normalized = redactSecretLikeJson(jsonValue(value)).value;
  const encoded = JSON.stringify(normalized);
  const originalBytes = utf8Bytes(encoded);
  if (originalBytes <= MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES) return normalized;
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
    if (serializedBytes(summary(encoded.slice(0, midpoint))) <= MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES) {
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
    case 'toolUnavailable':
      return 'Choose a currently exposed tool and derive a new call from its active schema.';
    case 'invalidArguments':
    case 'schemaIncompatible':
      return 'Derive a new call from the active schema; do not copy the rejected historical arguments.';
    case 'truncatedArguments':
      return 'Re-derive the complete arguments before issuing another call.';
    case 'argumentPersistenceUnavailable':
    case 'argumentPayloadUnavailable':
      return 'Do not retry from this record; re-derive any later call from an authorized source.';
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
  const summary = boundedJsonSummary(request.outcome.arguments);
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
  return {
    modelCall: {
      disposition: 'evidenceOnly',
      identity: request.outcome.identity,
      providerName: boundedEvidenceText(request.providerName, MAX_MODEL_TOOL_PROVIDER_NAME_BYTES),
      redactedArgumentsSummary: boundedJsonSummary(redactedArguments),
      reason: 'argumentPersistenceUnavailable',
      correction: evidenceCorrection('argumentPersistenceUnavailable'),
    },
    displayArguments: boundedJsonSummary(redactedArguments),
    execute: false,
  };
}

async function modelToolCallArguments(
  value: JsonValue,
  persistArguments: (value: JsonValue) => Promise<ThreadContextPayloadReference>,
): Promise<ModelToolCallArguments> {
  const inline = inlineModelToolCallArguments(value);
  if (inline) return inline;
  return { storage: 'payload', ref: await persistArguments(value) };
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
  return boundedUtf8Text(redactSecretLikeJson(value).value, maxBytes);
}

function serializedBytes(value: JsonValue): number {
  return utf8Bytes(JSON.stringify(value));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
