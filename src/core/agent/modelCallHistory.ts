import type {
  JsonValue,
  ModelToolCallArguments,
  ModelToolCallHistory,
  ModelToolIdentity,
} from './protocol';

export const MAX_TOOL_ARGUMENT_DISPLAY_CHARS = 32_000;
const UNAVAILABLE_STORED_TOOL_ARGUMENTS = { unavailable: 'stored tool arguments' } as const;

export function modelCallArgumentSource(
  modelCall: Exclude<ModelToolCallHistory, { readonly disposition: 'evidenceOnly' }>,
): ModelToolCallArguments {
  return modelCall.disposition === 'replayable'
    ? modelCall.arguments
    : modelCall.redactedArguments;
}

export function modelCallIdentity(modelCall: ModelToolCallHistory): ModelToolIdentity | null {
  return modelCall.identity;
}

export function modelCallDisplayArguments(modelCall: ModelToolCallHistory): JsonValue {
  if (modelCall.disposition === 'evidenceOnly') return modelCall.redactedArgumentsSummary;
  const source = modelCallArgumentSource(modelCall);
  if (source.storage === 'inline') return source.value;
  return UNAVAILABLE_STORED_TOOL_ARGUMENTS;
}

export function modelCallDisplayName(modelCall: ModelToolCallHistory): string {
  if (modelCall.disposition !== 'evidenceOnly' || modelCall.identity) {
    const identity = modelCall.identity!;
    return identity.namespace
      ? `${identity.namespace}.${identity.name}`
      : identity.name;
  }
  return modelCall.providerName;
}

export function boundedToolArgumentsForDisplay(
  value: JsonValue,
  maxChars = MAX_TOOL_ARGUMENT_DISPLAY_CHARS,
): JsonValue {
  const formatted = JSON.stringify(value, null, 2);
  if (formatted.length <= maxChars) return value;
  const summary = (preview: string): JsonValue => ({
    truncated: true,
    originalChars: formatted.length,
    preview,
  });
  const emptySummaryChars = JSON.stringify(summary(''), null, 2).length;
  let low = 0;
  let high = Math.min(formatted.length, Math.max(0, maxChars - emptySummaryChars));
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (JSON.stringify(summary(formatted.slice(0, midpoint)), null, 2).length <= maxChars) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return summary(formatted.slice(0, low));
}
