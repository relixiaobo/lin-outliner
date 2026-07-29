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
): Promise<InheritedContextPayload> {
  if (item.kind !== 'inheritedContext') {
    throw new Error(`Expected inherited context evidence, received ${item.kind}.`);
  }
  const payload = await readContext(item.payloadRef);
  if (!payload || payload.kind !== 'inheritedContext') {
    throw new Error(`Inherited context payload is unavailable: ${item.payloadRef.id}`);
  }
  assertContextPayloadDependencies(item, payload);
  return payload;
}
