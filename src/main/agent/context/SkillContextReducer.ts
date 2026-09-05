import type {
  ContextCursor,
  ContextDegradationCheckpointEntry,
  SkillCatalogContextPayload,
  SkillCatalogEntry,
  SkillInvocationContextPayload,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  Turn,
} from '../../../core/agent/protocol';
import { selectEffectiveContext } from './ContextEpoch';
import { readInheritedContextPayload } from './InheritedContext';
import {
  appendContextDegradations,
  contextDegradation,
  recordContextDegradation,
} from './ContextDegradation';

const CORE_FILE_PATH_TOOLS = new Set([
  'file_delete',
  'file_edit',
  'file_glob',
  'file_grep',
  'file_read',
  'file_write',
]);

export interface SkillContextState {
  readonly catalogHash: string | null;
  readonly catalogEntries: ReadonlyMap<string, SkillCatalogEntry>;
  readonly activeInvocations: ReadonlyMap<string, SkillInvocationContextPayload>;
  readonly degradations: readonly ContextDegradationCheckpointEntry[];
}

export async function reduceSkillContext(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<SkillContextState> {
  let catalogHash: string | null = null;
  const catalogEntries = new Map<string, SkillCatalogEntry>();
  const activeInvocations = new Map<string, SkillInvocationContextPayload>();
  const degradations: ContextDegradationCheckpointEntry[] = [];

  for (const turn of selectEffectiveContext(turns).turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        catalogHash = null;
        catalogEntries.clear();
        activeInvocations.clear();
        degradations.length = 0;
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (!inherited) {
          catalogHash = null;
          catalogEntries.clear();
          activeInvocations.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id),
          );
          continue;
        }
        const state = await reduceSkillContext(inherited.turns, readContext);
        catalogHash = state.catalogHash;
        replaceMap(catalogEntries, state.catalogEntries);
        replaceMap(activeInvocations, state.activeInvocations);
        appendContextDegradations(degradations, state.degradations);
        continue;
      }
      if (item.type === 'contextCompaction') {
        const restored = await readContext(item.restoredStateRef).catch(() => null);
        if (!restored || restored.kind !== 'compactionRestoredState') {
          catalogHash = null;
          catalogEntries.clear();
          activeInvocations.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'compactionRestoredState', item.restoredStateRef.id),
          );
          continue;
        }
        const checkpoint = await restoreSkillCatalogCheckpoint(
          turns,
          item.coveredThrough,
          restored,
          readContext,
        );
        catalogEntries.clear();
        for (const [name, entry] of checkpoint.catalogEntries) catalogEntries.set(name, entry);
        catalogHash = checkpoint.catalogHash;
        appendContextDegradations(degradations, checkpoint.degradations);
        activeInvocations.clear();
        for (const checkpoint of restored.activeSkills) {
          const active = await readContext(checkpoint.payloadRef).catch(() => null);
          if (!active || active.kind !== 'skillInvocation') {
            recordContextDegradation(
              degradations,
              contextDegradation('payloadUnavailable', 'skillInvocation', checkpoint.payloadRef.id),
            );
            continue;
          }
          if (
            active.name !== checkpoint.name
            || active.identity !== checkpoint.identity
            || active.contentHash !== checkpoint.contentHash
          ) {
            recordContextDegradation(
              degradations,
              contextDegradation('checkpointMismatch', 'skillInvocation', checkpoint.name),
            );
            continue;
          }
          activeInvocations.set(active.name, active);
        }
        continue;
      }
      if (
        item.type !== 'contextEvidence'
        || (item.kind !== 'skillCatalog' && item.kind !== 'skillInvocation')
      ) continue;
      const payload = await readContext(item.payloadRef).catch(() => null);
      if (!payload) {
        recordContextDegradation(
          degradations,
          contextDegradation('payloadUnavailable', item.kind, item.payloadRef.id),
        );
        continue;
      }
      if (payload.kind === 'skillCatalog') {
        if (payload.mode === 'baseline') {
          catalogEntries.clear();
        } else if (catalogHash !== payload.previousCatalogHash) {
          catalogHash = null;
          catalogEntries.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('journalDiscontinuity', 'skillCatalog', item.payloadRef.id),
          );
          continue;
        }
        applyCatalogEntries(catalogEntries, payload.entries);
        catalogHash = payload.catalogHash;
        continue;
      }
      if (payload.kind === 'skillInvocation') {
        activeInvocations.set(payload.name, payload);
        continue;
      }
    }
  }

  return { catalogHash, catalogEntries, activeInvocations, degradations };
}

type SkillCatalogReduction = Pick<SkillContextState, 'catalogHash' | 'catalogEntries' | 'degradations'>;

async function reduceSkillCatalogThroughCursor(
  turns: readonly Turn[],
  cursor: ContextCursor,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<SkillCatalogReduction> {
  let catalogHash: string | null = null;
  const catalogEntries = new Map<string, SkillCatalogEntry>();
  const degradations: ContextDegradationCheckpointEntry[] = [];
  let reached = false;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        catalogHash = null;
        catalogEntries.clear();
        degradations.length = 0;
      } else if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        if (!inherited) {
          catalogHash = null;
          catalogEntries.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'inheritedContext', item.payloadRef.id),
          );
          if (turn.id === cursor.turnId && item.id === cursor.itemId) {
            reached = true;
            break;
          }
          continue;
        }
        const state = await reduceSkillContext(inherited.turns, readContext);
        catalogHash = state.catalogHash;
        replaceMap(catalogEntries, state.catalogEntries);
        appendContextDegradations(degradations, state.degradations);
      } else if (item.type === 'contextEvidence' && item.kind === 'skillCatalog') {
        const payload = await readContext(item.payloadRef).catch(() => null);
        if (!payload || payload.kind !== 'skillCatalog') {
          recordContextDegradation(
            degradations,
            contextDegradation('payloadUnavailable', 'skillCatalog', item.payloadRef.id),
          );
          if (turn.id === cursor.turnId && item.id === cursor.itemId) {
            reached = true;
            break;
          }
          continue;
        }
        if (payload.mode === 'baseline') catalogEntries.clear();
        else if (catalogHash !== payload.previousCatalogHash) {
          catalogHash = null;
          catalogEntries.clear();
          recordContextDegradation(
            degradations,
            contextDegradation('journalDiscontinuity', 'skillCatalog', item.payloadRef.id),
          );
          if (turn.id === cursor.turnId && item.id === cursor.itemId) {
            reached = true;
            break;
          }
          continue;
        }
        applyCatalogEntries(catalogEntries, payload.entries);
        catalogHash = payload.catalogHash;
      }
      if (turn.id === cursor.turnId && item.id === cursor.itemId) {
        reached = true;
        break;
      }
    }
    if (reached) break;
  }
  if (!reached) {
    catalogHash = null;
    catalogEntries.clear();
    recordContextDegradation(
      degradations,
      contextDegradation('checkpointMismatch', 'skillCatalogCursor', `${cursor.turnId}/${cursor.itemId}`),
    );
  }
  return { catalogHash, catalogEntries, degradations };
}

export async function restoreSkillCatalogCheckpoint(
  turns: readonly Turn[],
  cursor: ContextCursor,
  restored: Extract<ThreadContextPayload, { readonly kind: 'compactionRestoredState' }>,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<SkillCatalogReduction> {
  const journal = await reduceSkillCatalogThroughCursor(turns, cursor, readContext);
  const invalid = (reference: string): SkillCatalogReduction => {
    const degradations = [...journal.degradations];
    recordContextDegradation(
      degradations,
      contextDegradation('checkpointMismatch', 'skillCatalog', reference),
    );
    return { catalogHash: null, catalogEntries: new Map(), degradations };
  };
  if (journal.catalogHash !== restored.skillCatalogHash) {
    return invalid(restored.skillCatalogHash ?? 'null');
  }
  if (restored.announcedSkills.length !== journal.catalogEntries.size) {
    return invalid('announcedSkills');
  }
  const announcedNames = new Set<string>();
  for (const checkpoint of restored.announcedSkills) {
    const entry = journal.catalogEntries.get(checkpoint.name);
    if (
      announcedNames.has(checkpoint.name)
      || !entry
      || entry.identity !== checkpoint.identity
      || entry.contentHash !== checkpoint.contentHash
    ) {
      return invalid(checkpoint.name);
    }
    announcedNames.add(checkpoint.name);
  }
  return journal;
}

export async function planSkillCatalogEvidence(input: {
  readonly turns: readonly Turn[];
  readonly snapshot: SkillCatalogContextPayload | null;
  readonly readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>;
}): Promise<SkillCatalogContextPayload | null> {
  if (!input.snapshot) return null;
  if (input.snapshot.mode !== 'baseline' || input.snapshot.previousCatalogHash !== null) {
    throw new Error('Skill registry snapshots must be complete baselines before journal reduction.');
  }
  const previous = await reduceSkillContext(input.turns, input.readContext);
  if (previous.catalogHash === input.snapshot.catalogHash) return null;
  if (previous.catalogHash === null) return input.snapshot;

  const nextEntries = new Map(input.snapshot.entries.map((entry) => [entry.name, entry]));
  const delta: SkillCatalogEntry[] = [];
  for (const entry of input.snapshot.entries) {
    const prior = previous.catalogEntries.get(entry.name);
    if (!prior) {
      delta.push({ ...entry, change: 'added' });
    } else if (!sameCatalogEntry(prior, entry)) {
      delta.push({ ...entry, change: 'changed' });
    }
  }
  for (const prior of previous.catalogEntries.values()) {
    if (!nextEntries.has(prior.name)) delta.push({ ...prior, change: 'removed' });
  }
  delta.sort((left, right) => compareStableText(left.name, right.name));

  return {
    schemaVersion: 1,
    kind: 'skillCatalog',
    mode: 'delta',
    previousCatalogHash: previous.catalogHash,
    catalogHash: input.snapshot.catalogHash,
    entries: delta,
  };
}

export function observedSkillFilePaths(turns: readonly Turn[]): string[] {
  const paths = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'fileChange' && item.status === 'completed') {
        for (const change of item.changes) {
          if (change.path.trim()) paths.add(change.path);
        }
        continue;
      }
      if (
        item.type !== 'dynamicToolCall'
        || item.status !== 'completed'
        || item.success !== true
        || item.namespace !== null
        || !CORE_FILE_PATH_TOOLS.has(item.tool)
      ) continue;
      addObservedFilePath(paths, item.arguments);
    }
  }
  return [...paths].sort(compareStableText);
}

function addObservedFilePath(paths: Set<string>, args: unknown): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const value = 'file_path' in args
    ? args.file_path
    : 'path' in args
      ? args.path
      : null;
  if (typeof value === 'string' && value.trim()) paths.add(value);
}

function applyCatalogEntries(
  state: Map<string, SkillCatalogEntry>,
  entries: readonly SkillCatalogEntry[],
): void {
  for (const entry of entries) {
    if (entry.change === 'removed') state.delete(entry.name);
    else state.set(entry.name, { ...entry, change: 'available' });
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function sameCatalogEntry(left: SkillCatalogEntry, right: SkillCatalogEntry): boolean {
  return left.name === right.name
    && left.displayName === right.displayName
    && left.source === right.source
    && left.identity === right.identity
    && left.contentHash === right.contentHash
    && left.description === right.description;
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
