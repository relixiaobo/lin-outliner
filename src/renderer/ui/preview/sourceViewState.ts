import { useEffect, useMemo, useSyncExternalStore } from 'react';

interface OwnerSourceViewState {
  previewVisible?: boolean;
  selectedValueId?: string;
}

interface SourceViewSnapshot {
  owners: Readonly<Record<string, OwnerSourceViewState>>;
}

export interface SourceViewValue {
  id: string;
  previewVisibleByDefault: boolean;
}

const STORAGE_KEY = 'lin-outliner:source-view:v1';
const listeners = new Set<() => void>();
let snapshot: SourceViewSnapshot = readSnapshot();

export function resetNodeSourceViewStateForTests(): void {
  snapshot = { owners: {} };
  for (const listener of listeners) listener();
}

export function useNodeSourceViewState(ownerId: string, values: readonly SourceViewValue[]) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const owner = current.owners[ownerId];
  const valueIds = values.map((value) => value.id);
  const selectedValueId = owner?.selectedValueId && valueIds.includes(owner.selectedValueId)
    ? owner.selectedValueId
    : valueIds[0] ?? null;
  const selectedValue = values.find((value) => value.id === selectedValueId);
  const previewVisible = owner?.previewVisible ?? selectedValue?.previewVisibleByDefault ?? true;

  useEffect(() => {
    if (valueIds.length === 0) {
      removeOwner(ownerId);
      return;
    }
    if (selectedValueId === owner?.selectedValueId) return;
    updateOwner(ownerId, { selectedValueId: selectedValueId ?? undefined });
  }, [owner?.selectedValueId, ownerId, selectedValueId, valueIds.length]);

  return useMemo(() => ({
    selectedValueId,
    previewVisible,
    select: (valueId: string) => updateOwner(ownerId, { selectedValueId: valueId }),
    show: (valueId = selectedValueId) => updateOwner(ownerId, {
      previewVisible: true,
      selectedValueId: valueId ?? undefined,
    }),
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
  const previous = snapshot.owners[ownerId] ?? {};
  const next = { ...previous, ...patch };
  if (next.previewVisible === previous.previewVisible
    && next.selectedValueId === previous.selectedValueId) return;
  snapshot = { owners: { ...snapshot.owners, [ownerId]: next } };
  persistSnapshot(snapshot);
  for (const listener of listeners) listener();
}

function removeOwner(ownerId: string): void {
  if (!snapshot.owners[ownerId]) return;
  const owners = { ...snapshot.owners };
  delete owners[ownerId];
  snapshot = { owners };
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
      if (!isRecord(value)) continue;
      const previewVisible = typeof value.previewVisible === 'boolean'
        ? value.previewVisible
        : undefined;
      const selectedValueId = typeof value.selectedValueId === 'string'
        ? value.selectedValueId
        : undefined;
      if (previewVisible === undefined && selectedValueId === undefined) continue;
      owners[ownerId] = {
        ...(previewVisible !== undefined ? { previewVisible } : {}),
        ...(selectedValueId !== undefined ? { selectedValueId } : {}),
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
