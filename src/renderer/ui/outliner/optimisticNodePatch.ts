import { flushSync } from 'react-dom';
import { nextCompletedAt, type DoneStateTransition } from '../../../core/doneState';
import { tagDrivenShowCheckbox } from '../../../core/configProjection';
import type { ContentBearingNodeProjection, NodeId, RichText } from '../../api/types';
import type {
  DocumentIndex,
  PendingNodePatch,
  UiState,
} from '../../state/document';
import type { Dispatch, SetStateAction } from 'react';

type UiStateSetter = Dispatch<SetStateAction<UiState>>;

export function nodeWithPendingPatch(
  node: ContentBearingNodeProjection,
  patch: PendingNodePatch | undefined,
): ContentBearingNodeProjection {
  if (!patch) return node;
  const next = patch.content ? { ...node, content: patch.content } : { ...node };
  if (patch.tags) next.tags = patch.tags;
  if ('completedAt' in patch) {
    if (patch.completedAt === null) delete next.completedAt;
    else next.completedAt = patch.completedAt;
  }
  return next;
}

export function optimisticTagPatch(params: {
  node: ContentBearingNodeProjection;
  ui: Pick<UiState, 'pendingNodePatches'>;
  tagId: NodeId;
  action: 'add' | 'remove';
  content?: RichText;
  pendingTagName?: string;
}): PendingNodePatch {
  const node = optimisticNodeFor(params.node, params.ui);
  const previousTagNames = params.ui.pendingNodePatches.get(node.id)?.pendingTagNames;
  const tags = params.action === 'add'
    ? node.tags.includes(params.tagId) ? node.tags : [...node.tags, params.tagId]
    : node.tags.filter((tagId) => tagId !== params.tagId);
  const pendingTagNames = {
    ...previousTagNames,
    ...(params.pendingTagName ? { [params.tagId]: params.pendingTagName } : {}),
  };
  if (params.action === 'remove') delete pendingTagNames[params.tagId];
  return pendingNodePatch(node.id, {
    ...(params.content ? { content: params.content } : {}),
    tags,
    ...(Object.keys(pendingTagNames).length > 0 ? { pendingTagNames } : {}),
  });
}

export function optimisticNodeFor(
  node: ContentBearingNodeProjection,
  ui: Pick<UiState, 'pendingNodePatches'>,
): ContentBearingNodeProjection {
  return nodeWithPendingPatch(node, ui.pendingNodePatches.get(node.id));
}

export function optimisticDonePatch(params: {
  index: DocumentIndex;
  node: ContentBearingNodeProjection;
  ui: Pick<UiState, 'pendingNodePatches'>;
  transition: DoneStateTransition;
  now?: number;
}): PendingNodePatch {
  const node = optimisticNodeFor(params.node, params.ui);
  const completedAt = nextCompletedAt({
    completedAt: node.completedAt,
    tagDriven: tagDrivenShowCheckbox(params.index.byId, node),
    transition: params.transition,
    now: params.now,
  });
  return pendingNodePatch(node.id, { completedAt: completedAt ?? null });
}

export function startOptimisticDoneTransition<Result>(params: {
  index: DocumentIndex;
  node: ContentBearingNodeProjection;
  currentUi: UiState;
  setUi: UiStateSetter;
  transition: DoneStateTransition;
  command: () => Promise<Result | null>;
  now?: number;
}): Promise<boolean> {
  return startOptimisticNodePatch({
    currentUi: params.currentUi,
    setUi: params.setUi,
    patch: optimisticDonePatch({
      index: params.index,
      node: params.node,
      ui: params.currentUi,
      transition: params.transition,
      now: params.now,
    }),
    command: params.command,
  });
}

export function startOptimisticNodePatch<Result>(params: {
  currentUi: UiState;
  setUi: UiStateSetter;
  patch: PendingNodePatch;
  command: () => Promise<Result | null>;
  onRejected?: () => void;
  onFailed?: () => void;
}): Promise<boolean> {
  return startOptimisticNodePatchBatch({
    currentUi: params.currentUi,
    setUi: params.setUi,
    patches: [params.patch],
    command: params.command,
    onRejected: params.onRejected,
    onFailed: params.onFailed,
  });
}

export function startOptimisticNodePatchBatch<Result>(params: {
  currentUi: UiState;
  setUi: UiStateSetter;
  patches: readonly PendingNodePatch[];
  command: () => Promise<Result | null>;
  onRejected?: () => void;
  onFailed?: () => void;
}): Promise<boolean> {
  const patches = dedupePatches(params.patches);
  if (patches.length === 0) return Promise.resolve(true);
  const dependencies = [...new Set(patches.flatMap((patch) => {
    const dependency = params.currentUi.pendingNodePatches.get(patch.nodeId);
    return dependency ? [dependency.settlement] : [];
  }))];
  let resolveSettlement!: (settled: boolean) => void;
  let rejectSettlement!: (error: unknown) => void;
  const settlement = new Promise<boolean>((resolve, reject) => {
    resolveSettlement = resolve;
    rejectSettlement = reject;
  });
  for (const patch of patches) patch.settlement = settlement;

  flushSync(() => {
    params.setUi((state) => {
      const pendingNodePatches = new Map(state.pendingNodePatches);
      for (const patch of patches) pendingNodePatches.set(patch.nodeId, patch);
      return { ...state, pendingNodePatches };
    });
  });

  const run = (async () => {
    if (dependencies.length > 0) {
      const prior = await Promise.all(dependencies);
      if (prior.some((settled) => !settled)) return false;
    }
    const result = await params.command();
    if (result === null) return false;
    return true;
  })();

  void run.then(resolveSettlement, rejectSettlement);
  void settlement.then(
    (settled) => {
      clearOptimisticNodePatches(params.setUi, patches);
      if (!settled) params.onRejected?.();
    },
    () => {
      clearOptimisticNodePatches(params.setUi, patches);
      params.onFailed?.();
    },
  );
  void settlement.catch(() => undefined);
  return settlement;
}

export function pendingNodePatch(
  nodeId: NodeId,
  values: Omit<PendingNodePatch, 'nodeId' | 'settlement'>,
): PendingNodePatch {
  return {
    nodeId,
    ...values,
    settlement: Promise.resolve(true),
  };
}

function clearOptimisticNodePatches(
  setUi: UiStateSetter,
  patches: readonly PendingNodePatch[],
): void {
  setUi((state) => {
    let pendingNodePatches: Map<NodeId, PendingNodePatch> | null = null;
    for (const patch of patches) {
      if (state.pendingNodePatches.get(patch.nodeId) !== patch) continue;
      pendingNodePatches ??= new Map(state.pendingNodePatches);
      pendingNodePatches.delete(patch.nodeId);
    }
    return pendingNodePatches ? { ...state, pendingNodePatches } : state;
  });
}

function dedupePatches(patches: readonly PendingNodePatch[]): PendingNodePatch[] {
  const byId = new Map<NodeId, PendingNodePatch>();
  for (const patch of patches) byId.set(patch.nodeId, patch);
  return [...byId.values()];
}
