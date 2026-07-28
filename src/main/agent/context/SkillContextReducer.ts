import type {
  SkillCatalogContextPayload,
  SkillCatalogEntry,
  SkillInvocationContextPayload,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  Turn,
} from '../../../core/agent/protocol';

export interface SkillContextState {
  readonly catalogHash: string | null;
  readonly catalogEntries: ReadonlyMap<string, SkillCatalogEntry>;
  readonly activeInvocations: ReadonlyMap<string, SkillInvocationContextPayload>;
}

export async function reduceSkillContext(
  turns: readonly Turn[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<SkillContextState> {
  let catalogHash: string | null = null;
  const catalogEntries = new Map<string, SkillCatalogEntry>();
  const activeInvocations = new Map<string, SkillInvocationContextPayload>();

  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextReset') {
        catalogHash = null;
        catalogEntries.clear();
        activeInvocations.clear();
        continue;
      }
      if (item.type === 'contextCompaction') {
        const restored = await readContext(item.restoredStateRef);
        if (!restored || restored.kind !== 'compactionRestoredState') {
          throw new Error(`Compaction Skill checkpoint is unavailable: ${item.restoredStateRef.id}`);
        }
        if (restored.skillCatalogHash === null) {
          catalogHash = null;
          catalogEntries.clear();
        } else {
          if (catalogHash !== restored.skillCatalogHash) {
            throw new Error('Compaction Skill checkpoint does not match the canonical catalog journal.');
          }
          const announcedNames = new Set<string>();
          for (const checkpoint of restored.announcedSkills) {
            const entry = catalogEntries.get(checkpoint.name);
            if (
              !entry
              || entry.identity !== checkpoint.identity
              || entry.contentHash !== checkpoint.contentHash
            ) {
              throw new Error(`Compaction Skill catalog entry is unavailable: ${checkpoint.name}`);
            }
            announcedNames.add(checkpoint.name);
          }
          for (const name of catalogEntries.keys()) {
            if (!announcedNames.has(name)) catalogEntries.delete(name);
          }
        }
        activeInvocations.clear();
        for (const checkpoint of restored.activeSkills) {
          const active = await readContext(checkpoint.payloadRef);
          if (!active || active.kind !== 'skillInvocation' || active.execution !== 'inline') {
            throw new Error(`Compaction Skill checkpoint is unavailable: ${checkpoint.payloadRef.id}`);
          }
          if (
            active.name !== checkpoint.name
            || active.identity !== checkpoint.identity
            || active.contentHash !== checkpoint.contentHash
          ) {
            throw new Error(`Compaction Skill checkpoint does not match its invocation: ${checkpoint.name}`);
          }
          activeInvocations.set(active.name, active);
        }
        continue;
      }
      if (item.type !== 'contextEvidence') continue;
      const payload = await readContext(item.payloadRef);
      if (!payload) throw new Error(`Canonical context payload is unavailable: ${item.payloadRef.id}`);
      if (payload.kind === 'skillCatalog') {
        if (payload.mode === 'baseline') {
          catalogEntries.clear();
        } else if (catalogHash !== payload.previousCatalogHash) {
          throw new Error('Skill catalog journal does not continue from the canonical catalog hash.');
        }
        applyCatalogEntries(catalogEntries, payload.entries);
        catalogHash = payload.catalogHash;
        continue;
      }
      if (payload.kind === 'skillInvocation') {
        if (payload.execution === 'inline') activeInvocations.set(payload.name, payload);
        continue;
      }
    }
  }

  return { catalogHash, catalogEntries, activeInvocations };
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
      if (item.type === 'fileChange') {
        for (const change of item.changes) {
          if (change.path.trim()) paths.add(change.path);
        }
        continue;
      }
      if (item.type !== 'dynamicToolCall' || !item.tool.startsWith('file_')) continue;
      if (!item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) continue;
      const value = 'file_path' in item.arguments
        ? item.arguments.file_path
        : 'path' in item.arguments
          ? item.arguments.path
          : null;
      if (typeof value === 'string' && value.trim()) paths.add(value);
    }
  }
  return [...paths].sort(compareStableText);
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
