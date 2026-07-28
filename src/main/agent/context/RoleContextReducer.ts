import type {
  ContextCursor,
  RoleCatalogContextPayload,
  RoleCatalogEntry,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  Turn,
} from '../../../core/agent/protocol';
import { selectEffectiveContext } from './ContextEpoch';
import { readInheritedContextPayload } from './InheritedContext';

export interface RoleContextState {
  readonly catalogHash: string | null;
  readonly catalogEntries: ReadonlyMap<string, RoleCatalogEntry>;
}

export async function reduceRoleContext(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<RoleContextState> {
  let catalogHash: string | null = null;
  const catalogEntries = new Map<string, RoleCatalogEntry>();

  for (const turn of selectEffectiveContext(turns).turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        catalogHash = null;
        catalogEntries.clear();
        continue;
      }
      if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        const state = await reduceRoleContext(inherited.turns, readContext);
        catalogHash = state.catalogHash;
        replaceMap(catalogEntries, state.catalogEntries);
        continue;
      }
      if (item.type === 'contextCompaction') {
        const restored = await readContext(item.restoredStateRef);
        if (!restored || restored.kind !== 'compactionRestoredState') {
          throw new Error(`Compaction Role checkpoint is unavailable: ${item.restoredStateRef.id}`);
        }
        const checkpoint = await restoreRoleCatalogCheckpoint(
          turns,
          item.coveredThrough,
          restored,
          readContext,
        );
        catalogEntries.clear();
        for (const [name, entry] of checkpoint.catalogEntries) catalogEntries.set(name, entry);
        catalogHash = checkpoint.catalogHash;
        continue;
      }
      if (item.type !== 'contextEvidence' || item.kind !== 'roleCatalog') continue;
      const payload = await readContext(item.payloadRef);
      if (!payload || payload.kind !== 'roleCatalog') {
        throw new Error(`Role catalog payload is unavailable: ${item.payloadRef.id}`);
      }
      if (payload.mode === 'baseline') {
        catalogEntries.clear();
      } else if (catalogHash !== payload.previousCatalogHash) {
        throw new Error('Role catalog journal does not continue from the canonical catalog hash.');
      }
      applyCatalogEntries(catalogEntries, payload.entries);
      catalogHash = payload.catalogHash;
    }
  }

  return { catalogHash, catalogEntries };
}

async function reduceRoleCatalogThroughCursor(
  turns: readonly Turn[],
  cursor: ContextCursor,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<RoleContextState> {
  let catalogHash: string | null = null;
  const catalogEntries = new Map<string, RoleCatalogEntry>();
  let reached = false;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        catalogHash = null;
        catalogEntries.clear();
      } else if (item.type === 'contextEvidence' && item.kind === 'inheritedContext') {
        const inherited = await readInheritedContextPayload(item, readContext);
        const state = await reduceRoleContext(inherited.turns, readContext);
        catalogHash = state.catalogHash;
        replaceMap(catalogEntries, state.catalogEntries);
      } else if (item.type === 'contextEvidence' && item.kind === 'roleCatalog') {
        const payload = await readContext(item.payloadRef);
        if (!payload || payload.kind !== 'roleCatalog') {
          throw new Error(`Role catalog payload is unavailable: ${item.payloadRef.id}`);
        }
        if (payload.mode === 'baseline') catalogEntries.clear();
        else if (catalogHash !== payload.previousCatalogHash) {
          throw new Error('Role catalog journal does not continue from the canonical catalog hash.');
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
    throw new Error(`Compaction Role covered cursor is unreachable: ${cursor.turnId}/${cursor.itemId}`);
  }
  return { catalogHash, catalogEntries };
}

export async function restoreRoleCatalogCheckpoint(
  turns: readonly Turn[],
  cursor: ContextCursor,
  restored: Extract<ThreadContextPayload, { readonly kind: 'compactionRestoredState' }>,
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<RoleContextState> {
  const journal = await reduceRoleCatalogThroughCursor(turns, cursor, readContext);
  if (journal.catalogHash !== restored.roleCatalogHash) {
    throw new Error('Compaction Role checkpoint does not match the canonical catalog journal.');
  }
  if (restored.announcedRoles.length !== journal.catalogEntries.size) {
    throw new Error('Compaction Role checkpoint does not contain the complete announced catalog.');
  }
  const announcedNames = new Set<string>();
  for (const checkpoint of restored.announcedRoles) {
    const entry = journal.catalogEntries.get(checkpoint.name);
    if (
      announcedNames.has(checkpoint.name)
      || !entry
      || entry.identity !== checkpoint.identity
      || entry.contentHash !== checkpoint.contentHash
    ) {
      throw new Error(`Compaction Role catalog entry is unavailable: ${checkpoint.name}`);
    }
    announcedNames.add(checkpoint.name);
  }
  return journal;
}

export async function planRoleCatalogEvidence(input: {
  readonly turns: readonly Turn[];
  readonly snapshot: RoleCatalogContextPayload | null;
  readonly readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>;
}): Promise<RoleCatalogContextPayload | null> {
  if (!input.snapshot) return null;
  if (input.snapshot.mode !== 'baseline' || input.snapshot.previousCatalogHash !== null) {
    throw new Error('Role registry snapshots must be complete baselines before journal reduction.');
  }
  const previous = await reduceRoleContext(input.turns, input.readContext);
  if (previous.catalogHash === input.snapshot.catalogHash) return null;
  if (previous.catalogHash === null) return input.snapshot;

  const nextEntries = new Map(input.snapshot.entries.map((entry) => [entry.name, entry]));
  const delta: RoleCatalogEntry[] = [];
  for (const entry of input.snapshot.entries) {
    const prior = previous.catalogEntries.get(entry.name);
    if (!prior) delta.push({ ...entry, change: 'added' });
    else if (!sameCatalogEntry(prior, entry)) delta.push({ ...entry, change: 'changed' });
  }
  for (const prior of previous.catalogEntries.values()) {
    if (!nextEntries.has(prior.name)) delta.push({ ...prior, change: 'removed' });
  }
  delta.sort((left, right) => compareStableText(left.name, right.name));
  return {
    schemaVersion: 1,
    kind: 'roleCatalog',
    mode: 'delta',
    previousCatalogHash: previous.catalogHash,
    catalogHash: input.snapshot.catalogHash,
    entries: delta,
  };
}

function applyCatalogEntries(
  state: Map<string, RoleCatalogEntry>,
  entries: readonly RoleCatalogEntry[],
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

function sameCatalogEntry(left: RoleCatalogEntry, right: RoleCatalogEntry): boolean {
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
