import type {
  JsonValue,
  ModelToolCallArguments,
  ModelToolCallHistory,
  ModelToolIdentity,
  ThreadItem,
} from './protocol';

export const MAX_TOOL_ARGUMENT_DISPLAY_CHARS = 32_000;

export type ToolHistoryInspectionItem = Extract<ThreadItem, {
  type:
    | 'commandExecution'
    | 'fileChange'
    | 'mcpToolCall'
    | 'dynamicToolCall'
    | 'collabAgentToolCall'
    | 'webSearch';
}>;

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
  return {
    storedArguments: {
      payloadId: source.ref.id,
      byteLength: source.ref.byteLength,
    },
  };
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

export function isCanonicalHistoryUnavailable(modelCall: ModelToolCallHistory): boolean {
  return modelCall.disposition === 'evidenceOnly'
    && modelCall.reason === 'canonicalHistoryUnavailable';
}

/**
 * Inspection-only identity. Legacy Item fields may describe rows, observations,
 * transcripts, and memory, but this helper must never feed provider replay.
 */
export function toolItemInspectionIdentity(item: ToolHistoryInspectionItem): ModelToolIdentity | null {
  if (!isCanonicalHistoryUnavailable(item.modelCall)) return item.modelCall.identity;
  switch (item.type) {
    case 'commandExecution': return { namespace: null, name: 'bash' };
    case 'fileChange': {
      const kinds = new Set(item.changes.map((change) => change.kind));
      return {
        namespace: null,
        name: kinds.size === 1 && kinds.has('add')
          ? 'file_write'
          : kinds.size === 1 && kinds.has('delete')
            ? 'file_delete'
            : 'file_edit',
      };
    }
    case 'mcpToolCall': return { namespace: item.server, name: item.tool };
    case 'dynamicToolCall': return { namespace: item.namespace, name: item.tool };
    case 'collabAgentToolCall': return { namespace: 'collaboration', name: item.tool };
    case 'webSearch': return { namespace: null, name: 'web_search' };
  }
}

export function toolItemInspectionName(item: ToolHistoryInspectionItem): string {
  const identity = toolItemInspectionIdentity(item);
  return identity
    ? identity.namespace ? `${identity.namespace}.${identity.name}` : identity.name
    : modelCallDisplayName(item.modelCall);
}

/**
 * Inspection-only arguments for pre-envelope Items. These values preserve the
 * visible historical row; they are not canonical and are never replayable.
 */
export function toolItemInspectionArguments(item: ToolHistoryInspectionItem): JsonValue {
  if (!isCanonicalHistoryUnavailable(item.modelCall)) {
    return modelCallDisplayArguments(item.modelCall);
  }
  switch (item.type) {
    case 'commandExecution': return {
      command: item.command,
      ...(item.description ? { description: item.description } : {}),
    };
    case 'fileChange': return { unavailable: 'canonical model-call history' };
    case 'mcpToolCall':
    case 'dynamicToolCall': return item.arguments;
    case 'collabAgentToolCall': return {
      prompt: item.prompt,
      model: item.model,
      reasoningEffort: item.reasoningEffort,
    };
    case 'webSearch': return { query: item.query };
  }
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
