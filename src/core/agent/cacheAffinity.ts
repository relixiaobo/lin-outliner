export const INITIAL_CONTEXT_EPOCH_ID = 'initial';

export function providerCacheAffinityMaterial(threadId: string, epochId: string): string {
  return `tenon-agent-cache-affinity-v1\0${threadId}\0${epochId}`;
}
