import {
  isReaderAuthoredUserMessage,
  type UserMessageThreadItem,
} from '../../core/agent/protocol';
import type { Turn } from './projectionTypes';

export type ThreadComposerHistoryDirection = 'older' | 'newer';

export type ThreadComposerHistoryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scratch' }
  | {
      readonly kind: 'browsing';
      readonly selectedItemId: string;
      readonly selectedIndex: number;
    };

export type ThreadComposerHistoryTransition<Entry extends { readonly id: string }> =
  | { readonly kind: 'declined'; readonly state: ThreadComposerHistoryState }
  | { readonly kind: 'boundary'; readonly state: ThreadComposerHistoryState }
  | {
      readonly kind: 'select';
      readonly entry: Entry;
      readonly reanchored: boolean;
      readonly state: ThreadComposerHistoryState;
    }
  | { readonly kind: 'restoreScratch'; readonly state: ThreadComposerHistoryState };

export const IDLE_THREAD_COMPOSER_HISTORY_STATE: ThreadComposerHistoryState = Object.freeze({ kind: 'idle' });
const SCRATCH_THREAD_COMPOSER_HISTORY_STATE: ThreadComposerHistoryState = Object.freeze({ kind: 'scratch' });

export function selectReaderComposerHistoryEntries(
  turns: readonly Turn[],
): readonly UserMessageThreadItem[] {
  return turns.flatMap((turn) => turn.items.filter(isReaderAuthoredUserMessage));
}

export function navigateThreadComposerHistory<Entry extends { readonly id: string }>(
  state: ThreadComposerHistoryState,
  entries: readonly Entry[],
  direction: ThreadComposerHistoryDirection,
): ThreadComposerHistoryTransition<Entry> {
  if (state.kind === 'idle' || state.kind === 'scratch') {
    if (direction === 'newer' || entries.length === 0) return { kind: 'declined', state };
    return select(entries, entries.length - 1, false);
  }

  const selectedIndex = entries.findIndex((entry) => entry.id === state.selectedItemId);
  if (selectedIndex < 0) {
    if (entries.length === 0) {
      return { kind: 'restoreScratch', state: IDLE_THREAD_COMPOSER_HISTORY_STATE };
    }
    return select(entries, Math.min(state.selectedIndex, entries.length - 1), true);
  }

  if (direction === 'older') {
    if (selectedIndex === 0) {
      return {
        kind: 'boundary',
        state: browsingState(entries[selectedIndex]!, selectedIndex),
      };
    }
    return select(entries, selectedIndex - 1, false);
  }

  if (selectedIndex === entries.length - 1) {
    return { kind: 'restoreScratch', state: SCRATCH_THREAD_COMPOSER_HISTORY_STATE };
  }
  return select(entries, selectedIndex + 1, false);
}

function select<Entry extends { readonly id: string }>(
  entries: readonly Entry[],
  index: number,
  reanchored: boolean,
): ThreadComposerHistoryTransition<Entry> {
  const entry = entries[index]!;
  return {
    kind: 'select',
    entry,
    reanchored,
    state: browsingState(entry, index),
  };
}

function browsingState(
  entry: { readonly id: string },
  selectedIndex: number,
): ThreadComposerHistoryState {
  return { kind: 'browsing', selectedItemId: entry.id, selectedIndex };
}
