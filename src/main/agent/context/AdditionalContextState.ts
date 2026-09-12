import type { AdditionalContextPayload, CompactionRestoredStateContextPayload, ContextDegradationCheckpointEntry, ContextTextEntry, ThreadContextPayload, ThreadContextPayloadReference, ThreadItem, Turn } from '../../../core/agent/protocol';
import { selectEffectiveContext } from './ContextEpoch';
import { readInheritedContextPayload } from './InheritedContext';
import { contextDegradation, recordContextDegradation } from './ContextDegradation';
import { assertContextPayloadDependencies } from './contextDependencies';

type ReadContext = (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>;

/** Complete snapshots allow lookup from the tail without rereading every Turn. */
export async function latestAdditionalContextBaselineRef(
  turns: readonly Turn[], readContext: ReadContext, degradations: ContextDegradationCheckpointEntry[],
): Promise<ThreadContextPayloadReference | null> {
  const selected = turns;
  for (let t = selected.length - 1; t >= 0; t--) {
    const items = selected[t].items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'contextReset') return null;
      if (item.type === 'contextCompaction') return (await readRestoredState(item, readContext, degradations))?.additionalContextBaselineRef ?? null;
      if (item.type !== 'contextEvidence') continue;
      if (item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (inherited) return latestAdditionalContextBaselineRef(selectEffectiveContext(inherited.turns).turns, readContext, degradations);
        recordContextDegradation(degradations, contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id));
        return null;
      }
      if (item.kind !== 'additionalContext') continue;
      const payload = await readContext(item.payloadRef).catch(() => null);
      if (!payload || payload.kind !== 'additionalContext') {
        recordContextDegradation(degradations, contextDegradation(payload ? 'payloadInvalid' : 'payloadUnavailable', 'additionalContext', item.payloadRef.id));
        return null;
      }
      if (payload.threadState !== null) return item.payloadRef;
    }
  }
  return null;
}

/** Same owner and complete-state semantics as admission, projection and compaction. */
export async function planAdditionalContextState(
  turns: readonly Turn[], snapshot: AdditionalContextPayload | null, readContext: ReadContext,
): Promise<AdditionalContextPayload | null> {
  if (!snapshot || snapshot.threadState === null) return null;
  const ref = await latestAdditionalContextBaselineRef(selectEffectiveContext(turns).turns, readContext, []);
  const previous = ref ? await readContext(ref).catch(() => null) : null;
  if (previous?.kind === 'additionalContext' && previous.threadState !== null) {
    const byKey = new Map(previous.threadState.map((entry) => [entry.key, entry]));
    if (byKey.size === snapshot.threadState.length && snapshot.threadState.every((entry) => {
      const prior = byKey.get(entry.key);
      return prior && contextEntriesEqual(prior, entry);
    })) return null;
  }
  return snapshot;
}

export function contextEntriesEqual(left: ContextTextEntry, right: ContextTextEntry): boolean {
  return left.key === right.key && left.source === right.source && left.authority === right.authority
    && left.purpose === right.purpose && left.text === right.text && left.scope === right.scope;
}

export async function readRestoredState(
  item: Extract<ThreadItem, { readonly type: 'contextCompaction' }>,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
  degradations: ContextDegradationCheckpointEntry[],
): Promise<CompactionRestoredStateContextPayload | null> {
  const restored = await readContext(item.restoredStateRef).catch(() => null);
  if (!restored || restored.kind !== 'compactionRestoredState') {
    recordContextDegradation(
      degradations,
      contextDegradation(
        restored ? 'payloadInvalid' : 'payloadUnavailable',
        'compactionRestoredState',
        item.restoredStateRef.id,
      ),
    );
    return null;
  }
  try {
    assertContextPayloadDependencies(item, restored);
  } catch {
    recordContextDegradation(
      degradations,
      contextDegradation('payloadInvalid', 'compactionRestoredState', item.restoredStateRef.id),
    );
    return null;
  }
  return restored;
}
