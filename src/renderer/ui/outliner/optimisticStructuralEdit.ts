import { flushSync } from 'react-dom';
import { freshNodeId } from '../../../core/nodeId';
import {
  nodeReferenceTarget,
  type ContentBearingNodeProjection,
  type NodeId,
  type RichText,
} from '../../api/types';
import type {
  CursorPlacement,
  PendingStructuralChange,
  PendingStructuralPresentation,
  UiState,
} from '../../state/document';
import {
  focusTarget,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from '../focus/focusModel';
import type { Dispatch, SetStateAction } from 'react';
import { concatRichText } from '../editor/richTextCodec';

type UiStateSetter = Dispatch<SetStateAction<UiState>>;

export function optimisticReplacementAnchors(
  siblingIds: readonly NodeId[],
  sourceId: NodeId,
): { beforeId?: NodeId; afterId?: NodeId } {
  const sourceIndex = siblingIds.indexOf(sourceId);
  if (sourceIndex < 0) return {};
  const beforeId = siblingIds[sourceIndex + 1];
  if (beforeId) return { beforeId };
  const afterId = siblingIds[sourceIndex - 1];
  return afterId ? { afterId } : {};
}

export function createOptimisticStructuralSettlement(): PendingStructuralChange['settlement'] {
  let bindSettlement: ((settlement: Promise<boolean>) => void) | null = null;
  const current = new Promise<boolean>((resolve, reject) => {
    let bound = false;
    bindSettlement = (settlement) => {
      if (bound) throw new Error('Optimistic structural settlement is already bound.');
      bound = true;
      void settlement.then(resolve, reject);
    };
  });
  return {
    current,
    bind: (settlement) => bindSettlement!(settlement),
  };
}

export function optimisticMergedNode(params: {
  target: ContentBearingNodeProjection;
  source: ContentBearingNodeProjection;
  sourceContent: RichText;
  resolvedReferenceTargetId?: NodeId;
  referenceDisplayName?: string;
}): ContentBearingNodeProjection {
  const { source, sourceContent, target } = params;
  const children = source.parentId === target.id
    ? target.children.flatMap((childId) => childId === source.id ? source.children : [childId])
    : [...target.children, ...source.children];
  if (target.type !== 'reference' || !params.resolvedReferenceTargetId) {
    return {
      ...target,
      children,
      content: concatRichText(target.content, sourceContent),
    };
  }
  const { targetId: _targetId, refRole: _refRole, ...plainTarget } = target;
  return {
    ...plainTarget,
    type: undefined,
    children,
    content: concatRichText({
      text: '',
      marks: [],
      inlineRefs: [{
        offset: 0,
        target: nodeReferenceTarget(params.resolvedReferenceTargetId),
        ...(params.referenceDisplayName ? { displayName: params.referenceDisplayName } : {}),
      }],
    }, sourceContent),
  };
}

export interface BeginOptimisticStructuralEditInput {
  id?: NodeId;
  parentId: NodeId;
  sourceParentId?: NodeId;
  originatesFromDraft?: boolean;
  retainsTrailingDraftMarker?: boolean;
  beforeId?: NodeId | null;
  afterId?: NodeId | null;
  presentation?: PendingStructuralPresentation;
  resolvedFieldDefId?: NodeId;
  content: RichText;
  nodeOverride?: ContentBearingNodeProjection;
  placement: CursorPlacement;
  preserveFocus?: boolean;
  updateSource?: () => void;
  updateUi?: (previous: UiState) => UiState;
}

function createPendingStructuralChange(
  panelId: string,
  input: BeginOptimisticStructuralEditInput,
): PendingStructuralChange {
  return {
    id: input.id ?? freshNodeId(),
    parentId: input.parentId,
    ...(input.sourceParentId ? { sourceParentId: input.sourceParentId } : {}),
    ...(input.originatesFromDraft ? { originatesFromDraft: true } : {}),
    ...(input.retainsTrailingDraftMarker ? { retainsTrailingDraftMarker: true } : {}),
    panelId,
    beforeId: input.beforeId ?? null,
    afterId: input.afterId ?? null,
    presentation: input.presentation ?? 'content',
    phase: 'submitting',
    initialContent: input.content,
    latestContent: { current: input.content },
    ...(input.nodeOverride ? { nodeOverride: { current: input.nodeOverride } } : {}),
    stableRenderKey: { current: null },
    ...(input.presentation === 'field'
      ? {
          latestFieldName: { current: '' },
          resolvedFieldDefId: { current: input.resolvedFieldDefId ?? null },
        }
      : {}),
    settlement: createOptimisticStructuralSettlement(),
  };
}

function applyPendingStructuralChange(
  previous: UiState,
  change: PendingStructuralChange,
  input: BeginOptimisticStructuralEditInput,
): UiState {
  const updated = input.updateUi?.(previous) ?? previous;
  const target = input.presentation === 'field'
    ? focusTarget(change.id, change.parentId, change.panelId, 'field-name')
    : rowFocusTarget(change.id, change.parentId, change.panelId);
  const withFocus = input.preserveFocus
    ? updated
    : {
        ...selectFocusState(updated, target),
        focusRequest: { target, placement: input.placement },
        trailingDraftPlacement: input.originatesFromDraft
          ? { parentId: change.parentId, afterId: change.id, panelId: change.panelId }
          : null,
      };
  return {
    ...withFocus,
    pendingStructuralChanges: [
      ...withFocus.pendingStructuralChanges.filter((candidate) => candidate.id !== change.id),
      change,
    ],
  };
}

export function beginOptimisticStructuralEdit(params: {
  panelId: string;
  setUi: UiStateSetter;
  input: BeginOptimisticStructuralEditInput;
}): PendingStructuralChange {
  const { input, panelId, setUi } = params;
  const change = createPendingStructuralChange(panelId, input);

  flushSync(() => {
    input.updateSource?.();
    setUi((previous) => applyPendingStructuralChange(previous, change, input));
  });
  return change;
}

export function bindOptimisticStructuralSettlement(
  change: PendingStructuralChange,
  settlement: Promise<boolean>,
): Promise<boolean> {
  change.settlement.bind(settlement);
  return settlement;
}

export function startOptimisticStructuralEdit<Result>(params: {
  panelId: string;
  setUi: UiStateSetter;
  input: BeginOptimisticStructuralEditInput;
  command: (change: PendingStructuralChange) => Promise<Result | null>;
  reconcile?: (result: Result, change: PendingStructuralChange) => Promise<boolean | void>;
  onRejected?: (change: PendingStructuralChange) => void;
  onFailed?: (change: PendingStructuralChange) => void;
  retainOnRejected?: boolean;
  preserveFocus?: boolean;
}): { change: PendingStructuralChange; settlement: Promise<boolean> } {
  const change = beginOptimisticStructuralEdit(params);
  const settlement = settleOptimisticStructuralEdit({
    change,
    setUi: params.setUi,
    command: params.command,
    reconcile: params.reconcile,
    onRejected: params.onRejected,
    onFailed: params.onFailed,
    retainOnRejected: params.retainOnRejected,
  });
  return { change, settlement };
}

export function startOptimisticStructuralBatch<Result>(params: {
  panelId: string;
  setUi: UiStateSetter;
  inputs: readonly BeginOptimisticStructuralEditInput[];
  command: () => Promise<Result | null>;
  onRejected?: () => void;
  onFailed?: () => void;
}): { changes: PendingStructuralChange[]; settlement: Promise<boolean> } {
  const changes = params.inputs.map((input) => createPendingStructuralChange(params.panelId, input));
  flushSync(() => {
    for (const input of params.inputs) input.updateSource?.();
    params.setUi((previous) => params.inputs.reduce(
      (state, input, index) => applyPendingStructuralChange(state, changes[index]!, input),
      previous,
    ));
  });
  const command = params.command();
  const settlements = changes.map((change, index) => settleOptimisticStructuralEdit({
    change,
    setUi: params.setUi,
    command: () => command,
    onRejected: index === 0 ? params.onRejected : undefined,
    onFailed: index === 0 ? params.onFailed : undefined,
  }));
  const settlement = Promise.all(settlements).then((results) => results.every(Boolean));
  void settlement.catch(() => undefined);
  return { changes, settlement };
}

export function settleOptimisticStructuralEdit<Result>(params: {
  change: PendingStructuralChange;
  setUi: UiStateSetter;
  command: (change: PendingStructuralChange) => Promise<Result | null>;
  reconcile?: (result: Result, change: PendingStructuralChange) => Promise<boolean | void>;
  onRejected?: (change: PendingStructuralChange) => void;
  onFailed?: (change: PendingStructuralChange) => void;
  retainOnRejected?: boolean;
}): Promise<boolean> {
  const { change } = params;
  const settlement = (async () => {
    const result = await params.command(change);
    if (result === null) {
      if (params.retainOnRejected) failOptimisticStructuralEdit(params.setUi, change);
      else clearOptimisticStructuralEdit(params.setUi, change);
      params.onRejected?.(change);
      return false;
    }
    if (await params.reconcile?.(result, change) === false) {
      failOptimisticStructuralEdit(params.setUi, change);
      params.onFailed?.(change);
      return false;
    }
    clearOptimisticStructuralEdit(params.setUi, change);
    return true;
  })().catch((error) => {
    failOptimisticStructuralEdit(params.setUi, change);
    params.onFailed?.(change);
    throw error;
  });
  bindOptimisticStructuralSettlement(change, settlement);
  void settlement.catch(() => undefined);
  return settlement;
}

export function startOptimisticRelocation<Result>(params: {
  panelId: string;
  setUi: UiStateSetter;
  currentUi: UiState;
  id: NodeId;
  sourceParentId: NodeId;
  targetParentId: NodeId;
  beforeId?: NodeId | null;
  afterId?: NodeId | null;
  presentation?: PendingStructuralPresentation;
  resolvedFieldDefId?: NodeId;
  content: RichText;
  placement: CursorPlacement;
  expandId?: NodeId;
  collapseIds?: ReadonlySet<NodeId>;
  retainOnRejected?: boolean;
  preserveFocus?: boolean;
  command: () => Promise<Result | null>;
  reconcile?: (result: Result, change: PendingStructuralChange) => Promise<boolean | void>;
}): { change: PendingStructuralChange; settlement: Promise<boolean> } {
  const expandWasActive = params.expandId
    ? params.currentUi.expanded.has(params.expandId)
    : false;
  const collapsedWereActive = new Set(
    [...(params.collapseIds ?? [])].filter((id) => params.currentUi.expanded.has(id)),
  );
  return startOptimisticStructuralEdit({
    panelId: params.panelId,
    setUi: params.setUi,
    input: {
      id: params.id,
      sourceParentId: params.sourceParentId,
      parentId: params.targetParentId,
      beforeId: params.beforeId,
      afterId: params.afterId,
      presentation: params.presentation,
      resolvedFieldDefId: params.resolvedFieldDefId,
      content: params.content,
      placement: params.placement,
      preserveFocus: params.preserveFocus,
      updateUi: (previous) => {
        const expanded = new Set(previous.expanded);
        if (params.expandId) expanded.add(params.expandId);
        for (const id of params.collapseIds ?? []) expanded.delete(id);
        return { ...previous, expanded };
      },
    },
    command: params.command,
    reconcile: params.reconcile,
    retainOnRejected: params.retainOnRejected,
    onRejected: () => {
      if (params.retainOnRejected) return;
      if (params.preserveFocus) return;
      flushSync(() => {
        params.setUi((previous) => {
          const expanded = new Set(previous.expanded);
          if (params.expandId && !expandWasActive) expanded.delete(params.expandId);
          for (const id of collapsedWereActive) expanded.add(id);
          const target = params.presentation === 'field'
            ? focusTarget(params.id, params.sourceParentId, params.panelId, 'field-name')
            : rowFocusTarget(params.id, params.sourceParentId, params.panelId);
          return requestFocusState({ ...previous, expanded }, target, params.placement);
        });
      });
    },
  });
}

export function clearOptimisticStructuralEdit(
  setUi: UiStateSetter,
  change: PendingStructuralChange,
): void {
  setUi((previous) => {
    const pendingStructuralChanges = previous.pendingStructuralChanges.filter(
      (candidate) => candidate !== change,
    );
    return pendingStructuralChanges.length === previous.pendingStructuralChanges.length
      ? previous
      : { ...previous, pendingStructuralChanges };
  });
}

export function failOptimisticStructuralEdit(
  setUi: UiStateSetter,
  change: PendingStructuralChange,
): void {
  change.phase = 'failed';
  setUi((previous) => (
    previous.pendingStructuralChanges.includes(change)
      ? { ...previous, pendingStructuralChanges: [...previous.pendingStructuralChanges] }
      : previous
  ));
}

export function addOptimisticRemovals(
  state: UiState,
  ids: readonly NodeId[],
  updateUi?: (state: UiState) => UiState,
): UiState {
  const next = updateUi?.(state) ?? state;
  const pendingRemovalIds = new Set(next.pendingRemovalIds);
  for (const id of ids) pendingRemovalIds.add(id);
  return { ...next, pendingRemovalIds };
}

export function clearOptimisticRemovals(
  state: UiState,
  ids: readonly NodeId[],
): UiState {
  if (!ids.some((id) => state.pendingRemovalIds.has(id))) return state;
  const pendingRemovalIds = new Set(state.pendingRemovalIds);
  for (const id of ids) pendingRemovalIds.delete(id);
  return { ...state, pendingRemovalIds };
}

export function startOptimisticRemoval<Result>(params: {
  ids: readonly NodeId[];
  setUi: UiStateSetter;
  updateUi?: (state: UiState) => UiState;
  command: () => Promise<Result | null>;
  onRejected?: () => void;
  onFailed?: () => void;
}): Promise<boolean> {
  const ids = [...new Set(params.ids)];
  flushSync(() => {
    params.setUi((state) => addOptimisticRemovals(state, ids, params.updateUi));
  });
  const settlement = (async () => {
    const result = await params.command();
    if (result === null) {
      flushSync(() => params.setUi((state) => clearOptimisticRemovals(state, ids)));
      params.onRejected?.();
      return false;
    }
    params.setUi((state) => clearOptimisticRemovals(state, ids));
    return true;
  })().catch((error) => {
    flushSync(() => params.setUi((state) => clearOptimisticRemovals(state, ids)));
    params.onFailed?.();
    throw error;
  });
  void settlement.catch(() => undefined);
  return settlement;
}

export function latestOptimisticStructuralDependency(
  ui: UiState,
  panelId: string,
  parentId: NodeId,
  excludedId: NodeId,
): PendingStructuralChange | null {
  return [...ui.pendingStructuralChanges].reverse().find((change) => (
    change.panelId === panelId
    && change.parentId === parentId
    && change.id !== excludedId
    && change.phase === 'submitting'
  )) ?? null;
}
