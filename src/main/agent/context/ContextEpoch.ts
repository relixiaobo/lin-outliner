import type {
  ContextCompactionThreadItem,
  ContextCursor,
  ContextResetThreadItem,
  ThreadItem,
  Turn,
} from '../../../core/agent/protocol';

interface LocatedItem {
  readonly turn: Turn;
  readonly item: ThreadItem;
}

export interface EffectiveContextSelection {
  readonly turns: readonly Turn[];
  readonly latestReset: ContextResetThreadItem | null;
  readonly latestCompaction: ContextCompactionThreadItem | null;
}

export function selectEffectiveContext(turns: readonly Turn[]): EffectiveContextSelection {
  const all = locatedItems(turns);
  let start = 0;
  let latestReset: ContextResetThreadItem | null = null;
  for (let index = 0; index < all.length; index += 1) {
    const item = all[index]!.item;
    if (item.type !== 'contextReset') continue;
    latestReset = item;
    start = index + 1;
  }

  const epoch = all.slice(start);
  let latestCompaction: ContextCompactionThreadItem | null = null;
  for (const entry of epoch) {
    if (entry.item.type === 'contextCompaction') latestCompaction = entry.item;
  }
  if (!latestCompaction) {
    return { turns: rebuildTurns(turns, new Set(epoch.map(entryKey))), latestReset, latestCompaction: null };
  }

  const coveredFrom = findCursor(epoch, latestCompaction.coveredFrom, 'coveredFrom');
  const coveredThrough = findCursor(epoch, latestCompaction.coveredThrough, 'coveredThrough');
  if (coveredFrom > coveredThrough) throw new Error('Context compaction coverage is reversed.');
  const compactionIndex = epoch.findIndex((entry) => entry.item.id === latestCompaction.id);
  if (compactionIndex < 0) throw new Error('Latest context compaction Item is unreachable.');
  if (coveredThrough >= compactionIndex) {
    throw new Error('Context compaction coverage must precede its Item.');
  }
  const preservedFrom = latestCompaction.preservedFrom
    ? findCursor(epoch, latestCompaction.preservedFrom, 'preservedFrom')
    : coveredThrough + 1;
  if (latestCompaction.preservedFrom && (
    preservedFrom <= coveredThrough || preservedFrom >= compactionIndex
  )) {
    throw new Error('Context compaction preserved tail must follow its covered range and precede its Item.');
  }

  const retained = new Set<string>();
  for (let index = 0; index < epoch.length; index += 1) {
    if (index < coveredFrom || index >= preservedFrom) retained.add(entryKey(epoch[index]!));
  }
  const ordered = epoch.filter((entry) => retained.has(entryKey(entry)) && entry.item.id !== latestCompaction.id);
  const compactionEntry = epoch[compactionIndex]!;
  const epochOrder = new Map(epoch.map((entry, index) => [entryKey(entry), index]));
  const insertion = latestCompaction.preservedFrom
    ? ordered.findIndex(({ turn, item }) => (
        turn.id === latestCompaction.preservedFrom!.turnId
        && item.id === latestCompaction.preservedFrom!.itemId
      ))
    : ordered.findIndex((entry) => (epochOrder.get(entryKey(entry)) ?? -1) > compactionIndex);
  if (latestCompaction.preservedFrom && insertion < 0) {
    throw new Error('Context compaction preserved tail was removed.');
  }
  ordered.splice(insertion < 0 ? ordered.length : insertion, 0, compactionEntry);
  return {
    turns: rebuildOrderedTurns(ordered),
    latestReset,
    latestCompaction,
  };
}

export function latestContextEpochId(turns: readonly Turn[], fallback: string): string {
  return selectEffectiveContext(turns).latestReset?.id ?? fallback;
}

export function cursorFor(turn: Turn, item: ThreadItem): ContextCursor {
  return { turnId: turn.id, itemId: item.id };
}

function locatedItems(turns: readonly Turn[]): LocatedItem[] {
  return turns.flatMap((turn) => turn.items.map((item) => ({ turn, item })));
}

function findCursor(entries: readonly LocatedItem[], cursor: ContextCursor, field: string): number {
  const index = entries.findIndex(({ turn, item }) => turn.id === cursor.turnId && item.id === cursor.itemId);
  if (index < 0) throw new Error(`Context compaction ${field} cursor is unreachable: ${cursor.turnId}/${cursor.itemId}`);
  return index;
}

function rebuildTurns(turns: readonly Turn[], retained: ReadonlySet<string>): Turn[] {
  return turns.flatMap((turn) => {
    const items = turn.items.filter((item) => retained.has(itemKey(turn.id, item.id)));
    return items.length > 0 ? [{ ...turn, items }] : [];
  });
}

function rebuildOrderedTurns(entries: readonly LocatedItem[]): Turn[] {
  const ordered: Array<{ turn: Turn; items: ThreadItem[] }> = [];
  for (const entry of entries) {
    let state = ordered.at(-1);
    if (!state || state.turn.id !== entry.turn.id) {
      state = { turn: entry.turn, items: [] };
      ordered.push(state);
    }
    state.items.push(entry.item);
  }
  return ordered.map(({ turn, items }) => ({ ...turn, items }));
}

function entryKey(entry: LocatedItem): string {
  return itemKey(entry.turn.id, entry.item.id);
}

function itemKey(turnId: string, itemId: string): string {
  return `${turnId}\0${itemId}`;
}
