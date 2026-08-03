import type {
  JsonValue,
  ModelToolCallArguments,
  ModelToolCallHistory,
  ModelToolIdentity,
} from './protocol';

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
