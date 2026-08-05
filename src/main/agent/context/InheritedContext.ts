import type {
  ContextEvidenceThreadItem,
  InheritedContextPayload,
  ThreadContextPayload,
  ThreadContextPayloadReference,
} from '../../../core/agent/protocol';
import { assertContextPayloadDependencies } from './contextDependencies';

export async function readInheritedContextPayload(
  item: ContextEvidenceThreadItem,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<InheritedContextPayload | null> {
  if (item.kind !== 'inheritedContext') {
    throw new Error(`Expected inherited context evidence, received ${item.kind}.`);
  }
  const payload = await readContext(item.payloadRef).catch(() => null);
  if (!payload || payload.kind !== 'inheritedContext') {
    console.warn(`[agent] Inherited context payload is unavailable: ${item.payloadRef.id}`);
    return null;
  }
  try {
    assertContextPayloadDependencies(item, payload);
  } catch (error) {
    console.warn(`[agent] Inherited context dependencies are unavailable: ${item.payloadRef.id}`, error);
    return null;
  }
  return payload;
}
