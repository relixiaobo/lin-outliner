import type { ExecutionContextFact } from '../../../core/agent/executionContext';
import type {
  ExecutionContextCheckpoint, ExecutionContextPublicationPayload,
  ThreadContextPayload, ThreadContextPayloadReference, Turn,
} from '../../../core/agent/protocol';
import { escapeXml } from '../../../core/reminderXml';
import { selectEffectiveContext } from './ContextEpoch';

type ReadContext = (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>;
type Entry = ExecutionContextCheckpoint['entries'][number];
const MAX_PUBLICATION_CHARS = 16_000;

export function executionFactKey(fact: ExecutionContextFact): string {
  return JSON.stringify([fact.source, fact.kind, fact.authority, fact.purpose, fact.scope]);
}

/** Only committed publications can advance what a Session has been told. */
export async function reducePublishedExecutionContext(turns: readonly Turn[], read: ReadContext): Promise<Map<string, Entry>> {
  const state = new Map<string, Entry>();
  const visiting = new Set<string>();
  const reduce = async (source: readonly Turn[], depth: number): Promise<void> => {
  if (depth > 32) return;
  for (const turn of selectEffectiveContext(source).turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') state.clear();
      if (item.type === 'contextCompaction') {
        state.clear();
        const payload = await read(item.restoredStateRef).catch(() => null);
        if (payload?.kind === 'compactionRestoredState') {
          for (const entry of payload.executionContext.entries) state.set(executionFactKey(entry.fact), entry);
        }
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext' && !visiting.has(item.payloadRef.id)) {
        const inherited = await read(item.payloadRef).catch(() => null);
        if (inherited?.kind === 'inheritedContext') {
          visiting.add(item.payloadRef.id);
          await reduce(inherited.turns, depth + 1);
          visiting.delete(item.payloadRef.id);
        }
      }
      if (item.type !== 'contextEvidence' || item.kind !== 'executionContextPublication') continue;
      const payload = await read(item.payloadRef).catch(() => null);
      if (payload?.kind !== 'executionContextPublication') {
        // Unavailable newer evidence must not revive an older instruction.
        state.clear();
        continue;
      }
      for (const fact of payload.operations) state.set(executionFactKey(fact), { fact, evidenceRef: item.payloadRef });
    }
  }
  };
  await reduce(turns, 0);
  return state;
}

export async function planExecutionContextPublication(
  turns: readonly Turn[], read: ReadContext,
): Promise<ExecutionContextPublicationPayload | null> {
  const selected = selectEffectiveContext(turns).turns;
  let pending: ThreadContextPayloadReference[] = [];
  for (const turn of selected) {
    for (const item of turn.items) {
      if (item.type === 'contextReset' || item.type === 'contextCompaction') pending = [];
      if (item.type !== 'contextEvidence') continue;
      if (item.kind === 'executionContextPublication') pending = [];
      else pending.push(item.payloadRef);
    }
  }
  if (pending.length === 0) return null;
  const state = await reducePublishedExecutionContext(turns, read);
  const operations: ExecutionContextFact[] = [];
  let text = '';
  let omitted = 0;
  for (const ref of pending) {
    if (ref.kind !== 'taskExecutionContext' && ref.kind !== 'automationDispatch') continue;
    const payload = await read(ref).catch(() => null);
    if (payload?.kind !== 'taskExecutionContext' && payload?.kind !== 'automationDispatch') { omitted += 1; continue; }
    for (const fact of payload.executionContext.snapshot.facts) {
      const key = executionFactKey(fact);
      if (JSON.stringify(state.get(key)?.fact) === JSON.stringify(fact)) continue;
      const body = renderExecutionFact(fact);
      if (text.length + body.length > MAX_PUBLICATION_CHARS) { omitted += 1; continue; }
      text += body;
      operations.push(fact);
      state.set(key, { fact, evidenceRef: ref });
    }
  }
  if (omitted) text += `${omitted} execution-context observations were unavailable or omitted from this input.\n`;
  return { schemaVersion: 1, kind: 'executionContextPublication',
    evidenceRefs: [...new Map(pending.map((ref) => [ref.id, ref])).values()], operations, text };
}

export async function checkpointExecutionContext(turns: readonly Turn[], read: ReadContext): Promise<ExecutionContextCheckpoint> {
  const state = await reducePublishedExecutionContext(turns, read);
  const entries: Entry[] = [];
  let text = '';
  let omitted = 0;
  for (const entry of state.values()) {
    const body = renderExecutionFact(entry.fact);
    if (text.length + body.length > MAX_PUBLICATION_CHARS) { omitted += 1; continue; }
    text += body;
    entries.push(entry);
  }
  if (text) text = `Restored execution observations at their recorded state; checks and Git observations require fresh validation.\n${text}`;
  if (omitted) text += `${omitted} prior scoped observations were omitted; their bodies are not available in this input.\n`;
  return { entries, text, omitted };
}

function renderExecutionFact(fact: ExecutionContextFact): string {
  return `<execution-context source="${escapeXml(fact.source)}" scope="${escapeXml(fact.scope)}" authority="${fact.authority}" purpose="${fact.purpose}" kind="${fact.kind}" invalidated="${fact.invalidated}">\n${escapeXml(fact.text)}\n</execution-context>\n`;
}
