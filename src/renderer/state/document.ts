import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  DocumentProjection,
  FocusPlacement,
  FocusSurface as CoreFocusSurface,
  InlineRefCursorBias as CoreInlineRefCursorBias,
  NodeId,
  NodeProjection,
  ProjectionSnapshot,
  ProjectionUpdate,
} from '../api/types';
import {
  buildReverseEdges,
  nextRevisions,
  patchRevisions,
  patchReverseEdges,
  propagateDirty,
  type ReverseEdges,
} from './renderRev';
import { projectionNodesView, SparseProjectionMap } from './sparseProjectionMap';
import { measureRenderIndex } from '../ui/outliner/renderProbe';
import {
  resolveSelectableReferenceTargetId,
  selectableChildParentId,
} from './selectableRows';
import {
  buildOutlinerRows,
  hiddenFieldKey,
  readViewConfig,
  type OutlinerRowItem,
} from './outlinerRows';
import {
  buildDayNoteCountIndex,
  patchDayNoteCountIndex,
  type DayNoteCountIndex,
} from './dayNoteCounts';
import type { ReferenceSummary } from '../../core/references';
import {
  buildLinkedReferenceSummary,
  patchLinkedReferenceSummary,
} from './incrementalReferenceSummary';
import {
  buildReferenceCandidateIndex,
  buildReferenceCandidateIndexCooperatively,
  patchReferenceCandidateIndex,
  referenceCandidateIndexNeedsCompaction,
  type ReferenceCandidateIndex,
} from './referenceCandidateIndex';
import {
  buildTrashNodeIds,
  patchTrashNodeIds,
  projectionReferenceGraphChanged,
  projectionStructureChanged,
  projectionTagDefinitionsChanged,
  type ProjectionDeltaFacts,
  type ProjectionSemanticRevisions,
  type SparseNodeIdSet,
} from './projectionDerived';
import { DocumentIndexStore } from './documentIndexStore';

export interface DocumentIndex {
  projection: DocumentProjection;
  byId: Map<NodeId, NodeProjection>;
  revision: number;
  // Per-node data revision, used by OutlinerItem's React.memo to skip rows whose
  // data did not change. Optional because `buildIndex` (tests, non-outliner
  // callers) does not track it; the live app always supplies it through the
  // projection store. UI state (focus/selection/…) is compared per-row in the
  // memo from the `ui` prop, not carried here.
  renderRev?: ReadonlyMap<NodeId, number>;
  dayNoteCounts: DayNoteCountIndex;
  semanticRevisions: ProjectionSemanticRevisions;
  delta: ProjectionDeltaFacts;
  trashNodeIds: SparseNodeIdSet;
  referenceSummary: ReferenceSummary;
  referenceCandidates: ReferenceCandidateIndex;
  tagCandidateCacheKey: object;
  displayGraphCacheKey: object;
}

export type FocusSurface = CoreFocusSurface;
export type CursorPlacement = FocusPlacement;
export type InlineRefCursorBias = CoreInlineRefCursorBias;
export type SelectionSource = 'global' | 'ref-click';

export function buildIndex(projection: DocumentProjection): DocumentIndex {
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  const changedIds = new Set<NodeId>(byId.keys());
  const trashNodeIds = buildTrashNodeIds(byId, projection.trashId);
  return {
    projection,
    byId,
    revision: 0,
    dayNoteCounts: buildDayNoteCountIndex(byId),
    semanticRevisions: initialSemanticRevisions(),
    delta: {
      changedIds,
      dirtyIds: changedIds,
      removedIds: [],
      structureChanged: true,
      trashMembershipChangedIds: trashNodeIds,
    },
    trashNodeIds,
    referenceSummary: buildLinkedReferenceSummary(byId, trashNodeIds),
    referenceCandidates: buildReferenceCandidateIndex(byId, trashNodeIds),
    tagCandidateCacheKey: {},
    displayGraphCacheKey: {},
  };
}

// --- Projection store -------------------------------------------------------
// The renderer holds its index and folds `ProjectionUpdate`s into it, instead of
// rebuilding from a fresh full projection each edit. A `delta` carries only the
// changed/removed nodes, so the renderer never re-`JSON.stringify`s the whole
// document to rediscover the change set (core already told us). Unchanged node
// OBJECTS keep their reference across edits — the stable-identity foundation the
// P3 memo cleanups build on. See docs/plans/incremental-projection.md.

interface ProjectionState {
  index: DocumentIndex & { renderRev: Map<NodeId, number> };
  revision: number;
  // The reverse-edge index, carried across edits and patched per delta. Internal
  // to the store (not exposed on DocumentIndex); a new state owns a freshly
  // copy-on-write-patched one, so `prev`'s is never mutated.
  reverseEdges: ReverseEdges;
}

const REFERENCE_CANDIDATE_COMPACTION_IDLE_MS = 150;
const REFERENCE_CANDIDATE_COMPACTION_MAX_WAIT_MS = 750;
const REFERENCE_CANDIDATE_COMPACTION_FORCE_PENDING = 256;
const REFERENCE_CANDIDATE_REBASE_CHUNK_SIZE = 256;

interface CandidateCompactionFlight {
  readonly controller: AbortController;
  readonly dirtyIds: Set<NodeId>;
}

// Fold a ProjectionUpdate into the previous state. Returns the next state, the
// unchanged `prev` (already-applied duplicate / identical reseed), or `null` to
// signal the caller must resync (a delta with no base, or a revision gap).
export function reduceProjection(
  prev: ProjectionState | null,
  update: ProjectionUpdate,
): ProjectionState | null {
  if (update.kind === 'full') {
    // A reseed at a revision we already hold (or older) is an identical no-op —
    // refresh snapshots can return the current snapshot without mutating. Return
    // `prev` so we don't bump every node's renderRev and force a full-tree memo
    // invalidation for a pure refresh. (Core bumps the revision on every change,
    // so equal revision ⇒ identical content.)
    if (prev && update.revision <= prev.revision) return prev;
    const byId = SparseProjectionMap.fromEntries(update.projection.nodes.map((node) => [node.id, node] as const));
    const affected = new Set<NodeId>(byId.keys());
    const renderRev = nextRevisions(prev?.index.renderRev ?? null, affected, byId.keys());
    const trashNodeIds = buildTrashNodeIds(byId, update.projection.trashId);
    const semanticRevisions = nextFullSemanticRevisions(prev?.index.semanticRevisions);
    return {
      index: {
        projection: update.projection,
        byId,
        revision: update.revision,
        renderRev,
        dayNoteCounts: buildDayNoteCountIndex(byId),
        semanticRevisions,
        delta: {
          changedIds: affected,
          dirtyIds: affected,
          removedIds: [],
          structureChanged: true,
          trashMembershipChangedIds: trashNodeIds,
        },
        trashNodeIds,
        referenceSummary: buildLinkedReferenceSummary(byId, trashNodeIds),
        referenceCandidates: buildReferenceCandidateIndex(byId, trashNodeIds),
        tagCandidateCacheKey: {},
        displayGraphCacheKey: {},
      },
      revision: update.revision,
      reverseEdges: buildReverseEdges(byId),
    };
  }
  if (!prev) return null;
  if (update.revision <= prev.revision) return prev; // dual-channel duplicate — already applied
  if (update.revision !== prev.revision + 1) return null; // gap — resync

  const previousById = SparseProjectionMap.fromReadonlyMap(prev.index.byId);
  const changed = new Set<NodeId>();
  // Delete EXACTLY the removed ids — no stale-subtree walk. Core enumerates every
  // genuinely-removed node in the change set (`loro.deleteNode` touches the whole
  // subtree, asserted by `verifyCaches`), so `removedIds` is complete. Walking the
  // *previous* tree to prune descendants would wrongly drop a child that a single
  // revision moved OUT of the removed node before deleting it (e.g.
  // `merge_node_into` re-parents grandchildren, then removes the emptied node):
  // those survivors arrive in `changedNodes`, not `removedIds`.
  for (const id of update.removedIds) {
    changed.add(id);
  }
  for (const node of update.changedNodes) {
    changed.add(node.id);
  }
  const byId = previousById.patch(
    update.changedNodes.map((node) => [node.id, node] as const),
    update.removedIds,
  );
  // `nodes` follows the same compatibility order as the held map (newly-created
  // nodes append at the end), whereas a full projection from core is id-sorted.
  // The delta path exposes a lazy immutable array snapshot so reducers do not
  // materialize every node just to preserve the legacy `projection.nodes` surface.
  // Display lists are still defined by each node's `children`, not by this order.
  const projection: DocumentProjection = {
    ...prev.index.projection,
    todayId: update.todayId,
    nodes: byId === prev.index.byId
      ? prev.index.projection.nodes
      : projectionNodesView(byId, byId.orderedIds),
  };
  const reverseEdges = patchReverseEdges(prev.reverseEdges, prev.index.byId, update.changedNodes, update.removedIds);
  const affected = propagateDirty(changed, byId, reverseEdges);
  const renderRev = patchRevisions(prev.index.renderRev, affected, byId, update.removedIds);
  const structureChanged = projectionStructureChanged(prev.index.byId, update.changedNodes, update.removedIds);
  const referenceGraphChanged = projectionReferenceGraphChanged(
    prev.index.byId,
    update.changedNodes,
    update.removedIds,
  );
  const trashPatch = patchTrashNodeIds({
    previous: prev.index.trashNodeIds,
    previousById: prev.index.byId,
    nextById: byId,
    changedNodes: update.changedNodes,
    removedIds: update.removedIds,
    trashId: projection.trashId,
  });
  const tagDefinitionsChanged = projectionTagDefinitionsChanged({
    previousById: prev.index.byId,
    nextById: byId,
    changedNodes: update.changedNodes,
    removedIds: update.removedIds,
    trashMembershipChangedIds: trashPatch.changedIds,
  });
  const semanticRevisions: ProjectionSemanticRevisions = {
    structure: prev.index.semanticRevisions.structure + Number(structureChanged),
    referenceGraph: prev.index.semanticRevisions.referenceGraph + Number(referenceGraphChanged),
    tagDefinitions: prev.index.semanticRevisions.tagDefinitions + Number(tagDefinitionsChanged),
    trashMembership: prev.index.semanticRevisions.trashMembership + Number(trashPatch.changedIds.size > 0),
  };
  const referenceSummary = patchLinkedReferenceSummary({
    previous: prev.index.referenceSummary,
    previousById: prev.index.byId,
    nextById: byId,
    changedNodes: update.changedNodes,
    trashNodeIds: trashPatch.nodeIds,
    rebuild: referenceGraphChanged || trashPatch.changedIds.size > 0,
  });
  const referenceCandidates = patchReferenceCandidateIndex({
    previous: prev.index.referenceCandidates,
    nextById: byId,
    changedIds: changed,
    trashMembershipChangedIds: trashPatch.changedIds,
    trashNodeIds: trashPatch.nodeIds,
  });
  const dayNoteCounts = patchDayNoteCountIndex({
    previous: prev.index.dayNoteCounts,
    previousById: prev.index.byId,
    nextById: byId,
    changedNodes: update.changedNodes,
    removedIds: update.removedIds,
  });
  return {
    index: {
      projection,
      byId,
      revision: update.revision,
      renderRev,
      dayNoteCounts,
      semanticRevisions,
      delta: {
        changedIds: changed,
        dirtyIds: affected,
        removedIds: update.removedIds,
        structureChanged,
        trashMembershipChangedIds: trashPatch.changedIds,
      },
      trashNodeIds: trashPatch.nodeIds,
      referenceSummary,
      referenceCandidates,
      tagCandidateCacheKey: tagDefinitionsChanged ? {} : prev.index.tagCandidateCacheKey,
      displayGraphCacheKey: structureChanged || referenceGraphChanged ? {} : prev.index.displayGraphCacheKey,
    },
    revision: update.revision,
    reverseEdges,
  };
}

function initialSemanticRevisions(): ProjectionSemanticRevisions {
  return { structure: 1, referenceGraph: 1, tagDefinitions: 1, trashMembership: 1 };
}

function nextFullSemanticRevisions(
  previous: ProjectionSemanticRevisions | undefined,
): ProjectionSemanticRevisions {
  if (!previous) return initialSemanticRevisions();
  return {
    structure: previous.structure + 1,
    referenceGraph: previous.referenceGraph + 1,
    tagDefinitions: previous.tagDefinitions + 1,
    trashMembership: previous.trashMembership + 1,
  };
}

// Find a node by id within a ProjectionUpdate: the changed set for a `delta`, the
// full node list for a `full`. Interaction handlers use this to read the
// just-created/edited node straight out of a command result (a freshly created or
// mutated node is always present in its own delta's changed set).
export function nodeFromProjectionUpdate(
  update: ProjectionUpdate,
  id: NodeId | undefined,
): NodeProjection | undefined {
  if (!id) return undefined;
  return update.kind === 'full'
    ? update.projection.nodes.find((node) => node.id === id)
    : update.changedNodes.find((node) => node.id === id);
}

export interface ProjectionStore {
  index: DocumentIndex | null;
  indexStore: DocumentIndexStore | null;
  applyProjectionUpdate: (update: ProjectionUpdate) => void;
}

export interface ProjectionStoreOptions {
  readonly candidateCompactionYieldControl?: () => Promise<void>;
}

// Holds the projection-derived index across edits and folds in ProjectionUpdates.
// If a delta can't apply (no base or a revision gap), it pulls a full snapshot via
// `resync` and reseeds — the safety valve; in steady state (one ordered channel,
// init seeds full) it never fires.
//
// `stateRef` mirrors `state` and is the authoritative `prev` for the reducer, so
// the reduce stays a pure function call OUTSIDE the setState updater (no resync
// side effect inside an updater that StrictMode double-invokes) and back-to-back
// applies in one tick chain correctly before React commits. A single in-flight
// guard collapses duplicate resync requests. Every accepted update also prunes
// node ids that left the projection from renderer-local UI state at this same
// boundary, including full reseeds returned by commands or resync.
export function useProjectionStore(
  resync: () => Promise<ProjectionSnapshot>,
  setUi: Dispatch<SetStateAction<UiState>>,
  options: ProjectionStoreOptions = {},
): ProjectionStore {
  const [state, setState] = useState<ProjectionState | null>(null);
  const stateRef = useRef<ProjectionState | null>(null);
  const indexStoreRef = useRef<DocumentIndexStore | null>(null);
  const resyncInFlight = useRef(false);
  const candidateCompactionIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateCompactionMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateCompactionFlightRef = useRef<CandidateCompactionFlight | null>(null);
  const startCandidateCompactionRef = useRef<() => void>(() => undefined);
  const disposedRef = useRef(false);

  const commit = useCallback((next: ProjectionState | null) => {
    if (next !== null && next !== stateRef.current) {
      stateRef.current = next;
      if (indexStoreRef.current) indexStoreRef.current.commit(next.index);
      else indexStoreRef.current = new DocumentIndexStore(next.index);
      setState(next);
    }
  }, []);

  const clearCandidateCompactionTimers = useCallback(() => {
    if (candidateCompactionIdleTimerRef.current !== null) {
      clearTimeout(candidateCompactionIdleTimerRef.current);
      candidateCompactionIdleTimerRef.current = null;
    }
    if (candidateCompactionMaxTimerRef.current !== null) {
      clearTimeout(candidateCompactionMaxTimerRef.current);
      candidateCompactionMaxTimerRef.current = null;
    }
  }, []);

  const scheduleCandidateCompaction = useCallback((
    next: ProjectionState,
    update: ProjectionUpdate | null,
  ) => {
    const activeFlight = candidateCompactionFlightRef.current;
    if (activeFlight) {
      if (update?.kind === 'full') {
        activeFlight.controller.abort();
        candidateCompactionFlightRef.current = null;
      } else {
        for (const nodeId of next.index.delta.changedIds) activeFlight.dirtyIds.add(nodeId);
        for (const nodeId of next.index.delta.trashMembershipChangedIds) {
          activeFlight.dirtyIds.add(nodeId);
        }
        return;
      }
    }

    if (!referenceCandidateIndexNeedsCompaction(next.index.referenceCandidates)) {
      clearCandidateCompactionTimers();
      return;
    }

    if (candidateCompactionIdleTimerRef.current !== null) {
      clearTimeout(candidateCompactionIdleTimerRef.current);
    }
    const idleDelay = next.index.referenceCandidates.pending.size
      >= REFERENCE_CANDIDATE_COMPACTION_FORCE_PENDING
      ? 0
      : REFERENCE_CANDIDATE_COMPACTION_IDLE_MS;
    candidateCompactionIdleTimerRef.current = setTimeout(() => {
      candidateCompactionIdleTimerRef.current = null;
      startCandidateCompactionRef.current();
    }, idleDelay);

    // The idle timer follows typing, but this timer does not. A continuous
    // Agent delta stream therefore cannot starve compaction indefinitely.
    candidateCompactionMaxTimerRef.current ??= setTimeout(() => {
      candidateCompactionMaxTimerRef.current = null;
      startCandidateCompactionRef.current();
    }, REFERENCE_CANDIDATE_COMPACTION_MAX_WAIT_MS);
  }, [clearCandidateCompactionTimers]);

  const startCandidateCompaction = useCallback(() => {
    clearCandidateCompactionTimers();
    if (disposedRef.current || candidateCompactionFlightRef.current) return;
    const snapshot = stateRef.current;
    if (!snapshot || !referenceCandidateIndexNeedsCompaction(snapshot.index.referenceCandidates)) return;

    const flight: CandidateCompactionFlight = {
      controller: new AbortController(),
      dirtyIds: new Set<NodeId>(),
    };
    candidateCompactionFlightRef.current = flight;
    void (async () => {
      let failed = false;
      try {
        let referenceCandidates = await buildReferenceCandidateIndexCooperatively(
          snapshot.index.byId,
          snapshot.index.trashNodeIds,
          {
            signal: flight.controller.signal,
            yieldControl: options.candidateCompactionYieldControl,
          },
        );
        if (!referenceCandidates) return;

        // Deltas continue to commit while the base builds. Drain every id that
        // changed after the snapshot in bounded batches; updates arriving during
        // a yield re-enter `dirtyIds` and are applied by the next pass.
        while (!flight.controller.signal.aborted) {
          const dirtyIds = [...flight.dirtyIds];
          flight.dirtyIds.clear();
          if (dirtyIds.length === 0) break;
          const current = stateRef.current;
          if (!current) return;
          referenceCandidates = await patchCandidateIndexCooperatively({
            previous: referenceCandidates,
            nextById: current.index.byId,
            trashNodeIds: current.index.trashNodeIds,
            dirtyIds,
            signal: flight.controller.signal,
          });
          if (!referenceCandidates) return;
        }

        if (
          disposedRef.current
          || flight.controller.signal.aborted
          || candidateCompactionFlightRef.current !== flight
        ) return;
        const current = stateRef.current;
        if (!current) return;
        const compacted = {
          ...current,
          index: { ...current.index, referenceCandidates },
        };
        candidateCompactionFlightRef.current = null;
        commit(compacted);
        scheduleCandidateCompaction(compacted, null);
      } catch (error: unknown) {
        failed = true;
        console.error('[renderer] reference candidate compaction failed', error);
      } finally {
        if (candidateCompactionFlightRef.current === flight) {
          candidateCompactionFlightRef.current = null;
          const current = stateRef.current;
          if (!failed && !disposedRef.current && current) {
            scheduleCandidateCompaction(current, null);
          }
        }
      }
    })();
  }, [
    clearCandidateCompactionTimers,
    commit,
    options.candidateCompactionYieldControl,
    scheduleCandidateCompaction,
  ]);
  startCandidateCompactionRef.current = startCandidateCompaction;

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      clearCandidateCompactionTimers();
      const activeFlight = candidateCompactionFlightRef.current;
      candidateCompactionFlightRef.current = null;
      activeFlight?.controller.abort();
    };
  }, [clearCandidateCompactionTimers]);

  const commitAcceptedUpdate = useCallback((
    previous: ProjectionState | null,
    next: ProjectionState,
    update: ProjectionUpdate,
  ) => {
    if (next === previous) return;
    const removals = projectionRemovals(
      previous?.index ?? null,
      next.index,
      update,
    );
    if (removals !== null) {
      setUi((current) => reduceUiStateForProjectionRemovals(current, removals));
    }
    commit(next);
    scheduleCandidateCompaction(next, update);
  }, [commit, scheduleCandidateCompaction, setUi]);

  const applyProjectionUpdate = useCallback((update: ProjectionUpdate) => {
    const previous = stateRef.current;
    const next = measureRenderIndex(() => reduceProjection(previous, update));
    if (next !== null) {
      commitAcceptedUpdate(previous, next, update);
      return;
    }
    if (resyncInFlight.current) return;
    resyncInFlight.current = true;
    void resync()
      .then((snapshot) => {
        const fullUpdate: ProjectionUpdate = {
          kind: 'full',
          revision: snapshot.revision,
          projection: snapshot.projection,
        };
        const previous = stateRef.current;
        const next = reduceProjection(previous, fullUpdate);
        if (next !== null) commitAcceptedUpdate(previous, next, fullUpdate);
      })
      .finally(() => { resyncInFlight.current = false; });
  }, [commitAcceptedUpdate, resync]);

  return {
    index: state?.index ?? null,
    indexStore: state === null ? null : indexStoreRef.current,
    applyProjectionUpdate,
  };
}

async function patchCandidateIndexCooperatively(params: {
  readonly previous: ReferenceCandidateIndex;
  readonly nextById: ReadonlyMap<NodeId, NodeProjection>;
  readonly trashNodeIds: ReadonlySet<NodeId>;
  readonly dirtyIds: readonly NodeId[];
  readonly signal: AbortSignal;
}): Promise<ReferenceCandidateIndex | null> {
  let index = params.previous;
  for (let offset = 0; offset < params.dirtyIds.length; offset += REFERENCE_CANDIDATE_REBASE_CHUNK_SIZE) {
    await yieldToRenderer();
    if (params.signal.aborted) return null;
    const changedIds = new Set(params.dirtyIds.slice(
      offset,
      offset + REFERENCE_CANDIDATE_REBASE_CHUNK_SIZE,
    ));
    index = patchReferenceCandidateIndex({
      previous: index,
      nextById: params.nextById,
      changedIds,
      trashMembershipChangedIds: new Set<NodeId>(),
      trashNodeIds: params.trashNodeIds,
    });
  }
  return index;
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface UiState {
  focusedId: NodeId | null;
  focusedParentId: NodeId | null;
  focusedPanelId: string | null;
  focusSurface: FocusSurface | null;
  selectedId: NodeId | null;
  selectedIds: Set<NodeId>;
  selectionAnchorId: NodeId | null;
  selectionRootId: NodeId | null;
  selectionSource: SelectionSource | null;
  focusRequest: FocusRequest | null;
  pendingInputChar: PendingInputChar | null;
  pendingReferenceConversion: PendingReferenceConversion | null;
  pendingReferenceTypeAhead: PendingReferenceTypeAhead | null;
  trailingDraftPlacement: TrailingDraftPlacement | null;
  expanded: Set<NodeId>;
  expandedHiddenFields: Set<string>;
  editingDescriptionId: NodeId | null;
  batchTagSelectorOpen: boolean;
  toolbarDropdownRequest: ToolbarDropdownRequest | null;
}

export interface FocusTarget {
  nodeId: NodeId;
  parentId: NodeId | null;
  panelId: string | null;
  surface: FocusSurface;
}

export interface FocusRequest {
  target: FocusTarget;
  placement: CursorPlacement;
}

export interface PendingInputChar {
  target: FocusTarget;
  char: string;
}

export interface PendingReferenceConversion {
  nodeId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
}

export interface PendingReferenceTypeAhead {
  nodeId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
}

export interface TrailingDraftPlacement {
  parentId: NodeId;
  afterId: NodeId | null;
  panelId: string | null;
}

export type ToolbarDropdownSection = 'sort' | 'filter' | 'group' | 'display';

export interface ToolbarDropdownRequest {
  nodeId: NodeId;
  section: ToolbarDropdownSection;
  nonce: number;
}

export const CLEARED_FOCUS_STATE = {
  focusedId: null,
  focusedParentId: null,
  focusedPanelId: null,
  focusSurface: null,
  focusRequest: null,
  pendingInputChar: null,
  pendingReferenceTypeAhead: null,
  trailingDraftPlacement: null,
} satisfies Pick<
  UiState,
  | 'focusedId'
  | 'focusedParentId'
  | 'focusedPanelId'
  | 'focusSurface'
  | 'focusRequest'
  | 'pendingInputChar'
  | 'pendingReferenceTypeAhead'
  | 'trailingDraftPlacement'
>;

export function useUiState() {
  return useState<UiState>({
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set<NodeId>(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    pendingReferenceTypeAhead: null,
    trailingDraftPlacement: null,
    expanded: new Set<NodeId>(),
    expandedHiddenFields: new Set<string>(),
    editingDescriptionId: null,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
  });
}

export function reduceUiStateForProjectionUpdate(
  state: UiState,
  previous: DocumentIndex | null,
  next: DocumentIndex,
  update: ProjectionUpdate,
): UiState {
  const removals = projectionRemovals(previous, next, update);
  return removals === null ? state : reduceUiStateForProjectionRemovals(state, removals);
}

function reduceUiStateForProjectionRemovals(
  state: UiState,
  removals: ProjectionRemovals,
): UiState {
  const { nodeIds: removedIds, hiddenFieldKeys: removedHiddenFieldKeys } = removals;
  const selectedIds = withoutRemovedIds(state.selectedIds, removedIds);
  const expanded = withoutRemovedIds(state.expanded, removedIds);
  const expandedHiddenFields = withoutRemovedIds(state.expandedHiddenFields, removedHiddenFieldKeys);
  const focusStateRemoved = nodeIdRemoved(state.focusedId, removedIds)
    || nodeIdRemoved(state.focusedParentId, removedIds);
  const focusRequestRemoved = state.focusRequest !== null
    && focusTargetReferencesRemovedNode(state.focusRequest.target, removedIds);
  const pendingInputRemoved = state.pendingInputChar !== null
    && focusTargetReferencesRemovedNode(state.pendingInputChar.target, removedIds);
  const pendingReferenceConversionRemoved = state.pendingReferenceConversion !== null
    && referenceRequestReferencesRemovedNode(state.pendingReferenceConversion, removedIds);
  const pendingReferenceTypeAheadRemoved = state.pendingReferenceTypeAhead !== null
    && referenceRequestReferencesRemovedNode(state.pendingReferenceTypeAhead, removedIds);
  const trailingDraftPlacementRemoved = state.trailingDraftPlacement !== null
    && (
      removedIds.has(state.trailingDraftPlacement.parentId)
      || nodeIdRemoved(state.trailingDraftPlacement.afterId, removedIds)
    );
  const selectedIdRemoved = nodeIdRemoved(state.selectedId, removedIds);
  const selectionAnchorRemoved = nodeIdRemoved(state.selectionAnchorId, removedIds);
  const selectionRootRemoved = nodeIdRemoved(state.selectionRootId, removedIds);
  const editingDescriptionRemoved = nodeIdRemoved(state.editingDescriptionId, removedIds);
  const toolbarDropdownRemoved = state.toolbarDropdownRequest !== null
    && removedIds.has(state.toolbarDropdownRequest.nodeId);

  if (
    selectedIds === state.selectedIds
    && expanded === state.expanded
    && expandedHiddenFields === state.expandedHiddenFields
    && !focusStateRemoved
    && !focusRequestRemoved
    && !pendingInputRemoved
    && !pendingReferenceConversionRemoved
    && !pendingReferenceTypeAheadRemoved
    && !trailingDraftPlacementRemoved
    && !selectedIdRemoved
    && !selectionAnchorRemoved
    && !selectionRootRemoved
    && !editingDescriptionRemoved
    && !toolbarDropdownRemoved
  ) return state;

  const selectedId = selectedIdRemoved ? lastSetValue(selectedIds) : state.selectedId;
  const selectionEmptied = selectedIds !== state.selectedIds && selectedIds.size === 0;
  const focusPatch = focusStateRemoved
    ? CLEARED_FOCUS_STATE
    : {
        focusRequest: focusRequestRemoved ? null : state.focusRequest,
        pendingInputChar: pendingInputRemoved ? null : state.pendingInputChar,
        pendingReferenceTypeAhead: pendingReferenceTypeAheadRemoved
          ? null
          : state.pendingReferenceTypeAhead,
        trailingDraftPlacement: trailingDraftPlacementRemoved
          ? null
          : state.trailingDraftPlacement,
      };
  return {
    ...state,
    ...focusPatch,
    selectedId,
    selectedIds,
    selectionAnchorId: selectionAnchorRemoved ? selectedId : state.selectionAnchorId,
    selectionRootId: selectionRootRemoved ? null : state.selectionRootId,
    selectionSource: selectionEmptied ? null : state.selectionSource,
    pendingReferenceConversion: pendingReferenceConversionRemoved
      ? null
      : state.pendingReferenceConversion,
    expanded,
    expandedHiddenFields,
    editingDescriptionId: editingDescriptionRemoved ? null : state.editingDescriptionId,
    batchTagSelectorOpen: selectionEmptied ? false : state.batchTagSelectorOpen,
    toolbarDropdownRequest: toolbarDropdownRemoved ? null : state.toolbarDropdownRequest,
  };
}

interface ProjectionRemovals {
  nodeIds: ReadonlySet<NodeId>;
  hiddenFieldKeys: ReadonlySet<string>;
}

function projectionRemovals(
  previous: DocumentIndex | null,
  next: DocumentIndex,
  update: ProjectionUpdate,
): ProjectionRemovals | null {
  if (previous === null) return null;

  const nodeIds = new Set<NodeId>();
  if (update.kind === 'delta') {
    for (const id of update.removedIds) nodeIds.add(id);
  } else {
    for (const id of previous.byId.keys()) {
      if (!next.byId.has(id)) nodeIds.add(id);
    }
  }
  if (nodeIds.size === 0) return null;

  const hiddenFieldKeys = new Set<string>();
  for (const id of nodeIds) {
    const removedNode = previous.byId.get(id);
    if (!removedNode) continue;
    if (removedNode.type === 'fieldEntry' && removedNode.parentId) {
      hiddenFieldKeys.add(hiddenFieldKey(removedNode.parentId, id));
    }
    for (const childId of removedNode.children) {
      if (previous.byId.get(childId)?.type === 'fieldEntry') {
        hiddenFieldKeys.add(hiddenFieldKey(id, childId));
      }
    }
  }
  return { nodeIds, hiddenFieldKeys };
}

function nodeIdRemoved(id: NodeId | null | undefined, removedIds: ReadonlySet<NodeId>): boolean {
  return id !== null && id !== undefined && removedIds.has(id);
}

function focusTargetReferencesRemovedNode(
  target: FocusTarget,
  removedIds: ReadonlySet<NodeId>,
): boolean {
  return removedIds.has(target.nodeId) || nodeIdRemoved(target.parentId, removedIds);
}

function referenceRequestReferencesRemovedNode(
  request: PendingReferenceConversion | PendingReferenceTypeAhead,
  removedIds: ReadonlySet<NodeId>,
): boolean {
  return removedIds.has(request.nodeId)
    || removedIds.has(request.parentId)
    || removedIds.has(request.targetId);
}

function lastSetValue<T>(values: ReadonlySet<T>): T | null {
  let last: T | null = null;
  for (const value of values) last = value;
  return last;
}

function withoutRemovedIds<T>(current: Set<T>, removedIds: ReadonlySet<T>): Set<T> {
  if (current.size === 0 || removedIds.size === 0) return current;
  let next: Set<T> | null = null;
  for (const id of current) {
    if (!removedIds.has(id)) continue;
    next ??= new Set(current);
    next.delete(id);
  }
  return next ?? current;
}

export function isRowExpanded(
  nodeId: NodeId,
  _byId: Map<NodeId, NodeProjection>,
  expanded: Set<NodeId>,
): boolean {
  return expanded.has(nodeId);
}

export function flattenVisibleRows(
  rootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  expanded: Set<NodeId>,
  expandedHiddenFields: Set<string> = new Set(),
): NodeId[] {
  const result: NodeId[] = [];
  const visit = (
    parentId: NodeId,
    referencePath: NodeId[],
    suppressFieldEntries = false,
  ) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const tableMode = readViewConfig(parent, byId).viewMode === 'table';
    const rows = buildOutlinerRows(parent, byId, {
      expandedHiddenFields,
      suppressFieldEntries,
    });
    const visitRows = (currentRows: OutlinerRowItem[]) => {
      for (const row of currentRows) {
        if (row.type === 'filteredOut') {
          if (expanded.has(row.id)) visitRows(row.rows);
          continue;
        }
        if (row.type !== 'field' && row.type !== 'content') continue;
        result.push(row.id);
        if (!isRowExpanded(row.id, byId, expanded)) continue;
        const childParentId = outlinerChildParentId(row.id, byId);
        if (!childParentId || referencePath.includes(childParentId)) continue;
        visit(
          childParentId,
          [...referencePath, childParentId],
          row.type === 'content' && tableMode,
        );
      }
    }
    visitRows(rows);
  };
  visit(rootId, [rootId]);
  return result;
}

export function outlinerChildParentId(
  rowId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  return selectableChildParentId(rowId, byId);
}

export function resolveReferenceTargetId(
  targetId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  return resolveSelectableReferenceTargetId(targetId, byId);
}
