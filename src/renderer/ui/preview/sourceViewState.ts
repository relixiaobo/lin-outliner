import { useEffect, useMemo, useSyncExternalStore } from 'react';

interface OwnerSourceViewState {
  previewVisible: boolean;
  selectedValueId?: string;
}

interface SourceViewSnapshot {
  owners: Readonly<Record<string, OwnerSourceViewState>>;
}

const STORAGE_KEY = 'lin-outliner:source-view:v1';
const listeners = new Set<() => void>();
let snapshot: SourceViewSnapshot = readSnapshot();

export function resetNodeSourceViewStateForTests(): void {
  snapshot = { owners: {} };
  for (const listener of listeners) listener();
}

export function useNodeSourceViewState(ownerId: string, valueIds: readonly string[]) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const owner = current.owners[ownerId];
  const selectedValueId = owner?.selectedValueId && valueIds.includes(owner.selectedValueId)
    ? owner.selectedValueId
    : valueIds[0] ?? null;
  const previewVisible = owner?.previewVisible ?? true;

  useEffect(() => {
    if (selectedValueId === owner?.selectedValueId) return;
    updateOwner(ownerId, { selectedValueId: selectedValueId ?? undefined });
  }, [owner?.selectedValueId, ownerId, selectedValueId]);

  return useMemo(() => ({
    selectedValueId,
    previewVisible,
    select: (valueId: string) => updateOwner(ownerId, { selectedValueId: valueId }),
    setPreviewVisible: (visible: boolean) => updateOwner(ownerId, { previewVisible: visible }),
  }), [ownerId, previewVisible, selectedValueId]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SourceViewSnapshot {
  return snapshot;
}

function getServerSnapshot(): SourceViewSnapshot {
  return snapshot;
}

function updateOwner(ownerId: string, patch: Partial<OwnerSourceViewState>): void {
  const previous = snapshot.owners[ownerId] ?? { previewVisible: true };
  const next = { ...previous, ...patch };
  if (next.previewVisible === previous.previewVisible
    && next.selectedValueId === previous.selectedValueId) return;
  snapshot = { owners: { ...snapshot.owners, [ownerId]: next } };
  persistSnapshot(snapshot);
  for (const listener of listeners) listener();
}

function readSnapshot(): SourceViewSnapshot {
  if (typeof window === 'undefined') return { owners: {} };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '') as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.owners)) return { owners: {} };
    const owners: Record<string, OwnerSourceViewState> = {};
    for (const [ownerId, value] of Object.entries(parsed.owners)) {
      if (!isRecord(value) || typeof value.previewVisible !== 'boolean') continue;
      owners[ownerId] = {
        previewVisible: value.previewVisible,
        ...(typeof value.selectedValueId === 'string' ? { selectedValueId: value.selectedValueId } : {}),
      };
    }
    return { owners };
  } catch {
    return { owners: {} };
  }
}

function persistSnapshot(value: SourceViewSnapshot): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // View state is best-effort and never affects document state.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
