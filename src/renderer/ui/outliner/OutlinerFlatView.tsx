import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { freshNodeId } from '../../../core/nodeId';
import {
  outlinerChildParentId,
  type DocumentIndex,
  type PendingStructuralChange,
  type UiState,
} from '../../state/document';
import {
  buildVisualRowsIncrementally,
  type VisualRow,
  type VisualRowsSnapshot,
} from '../../state/visualRows';
import {
  applyPendingRowPlacement,
  applyPendingRowsPlacement,
  pendingStructuralRowIsDraft,
  resolvePendingRowPlacement,
} from '../../state/trailingDraftPlacement';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import type { FieldValueContext } from '../fields/fieldValueEditors';
import { outlinerChildren } from '../shared';
import { hiddenFieldKey, readViewConfig } from './row-model';
import { RENDER_PROBE_ENABLED } from './renderProbe';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { ViewToolbar } from './ViewToolbar';
import { FilteredOutHeading, HiddenFieldReveal, ViewGroupHeading } from './OutlinerViewChrome';
import { OutlinerEmptyState } from './OutlinerEmptyState';
import { OutlinerTableView } from './OutlinerTableView';
import { IndentGuide } from './IndentGuide';
import { nodeSourceValues } from '../preview/nodeSources';
import { shouldMintNextDraftId, type PendingDraftPolicy } from './draftRow';
import {
  captureDisclosureScrollAnchor,
  nearestScrollContainer,
  usePendingDisclosureAnchor,
} from '../interactions/disclosureScrollAnchor';
import { MAX_OUTLINE_INDENT_DEPTH } from '../workspaceResponsiveLayout';
import {
  resolveFlatGuideMeasurements,
  sameFlatGuides,
  type FlatGuideGeometry,
  type FlatGuideMeasurement,
} from './flatGuideGeometry';
import { registerOutlinerScrollListener } from './outlinerScrollDispatcher';

// Below this many rows, windowing overhead is not worth it: render the whole flat
// list in normal flow (rows are direct `.outliner` children, like the recursive
// path's top level). Above it, only the viewport window (plus focus targets) is
// mounted, positioned absolutely inside a spacer of the full content height.
const VIRTUALIZE_MIN_ROWS = 60;
// Render this many px of rows above/below the viewport so scrolling does not
// flash blank rows before measurement catches up.
const OVERSCAN_PX = 800;
// Initial guess for an unmeasured row (a single line of content). Real heights
// replace it as rows mount and are measured.
const ROW_ESTIMATE_PX = 32;

interface RowLayoutItem {
  top: number;
  height: number;
}

interface RowLayout {
  items: RowLayoutItem[];
  totalHeight: number;
}

function buildRowLayout(rows: readonly VisualRow[], measured: Map<string, number>): RowLayout {
  const items: RowLayoutItem[] = [];
  let top = 0;
  for (const row of rows) {
    const height = measured.get(row.key) ?? ROW_ESTIMATE_PX;
    items.push({ top, height });
    top += height;
  }
  return { items, totalHeight: top };
}

function descendantEndIndexFor(rows: readonly VisualRow[], rowIndex: number): number {
  const row = rows[rowIndex];
  if (!row) return rowIndex;
  let endIndex = rowIndex + 1;
  while (endIndex < rows.length && rows[endIndex]!.depth > row.depth) {
    endIndex += 1;
  }
  return endIndex;
}

function insertPendingStructuralChange(
  rows: readonly VisualRow[],
  change: PendingStructuralChange | null,
): readonly VisualRow[] {
  if (!change) return rows;
  const sourceIndex = change.sourceParentId
    ? rows.findIndex((row) => (
        (row.kind === 'content' || row.kind === 'field')
        && row.nodeId === change.id
        && row.parentId === change.sourceParentId
      ))
    : -1;
  const sourceEndIndex = sourceIndex >= 0 ? descendantEndIndexFor(rows, sourceIndex) : sourceIndex;
  const sourceRows = sourceIndex >= 0 ? rows.slice(sourceIndex, sourceEndIndex) : [];
  const placementRows = sourceIndex >= 0
    ? [...rows.slice(0, sourceIndex), ...rows.slice(sourceEndIndex)]
    : rows;
  const placement = resolvePendingRowPlacement({
    rows: placementRows,
    change,
    matches: (row, id, parentId) => (
      (row.kind === 'content' || row.kind === 'field')
      && row.nodeId === id
      && row.parentId === parentId
    ),
    fallbackIndex: (currentRows, parentId) => {
      const index = currentRows.findIndex((row) => (
        row.kind === 'content' && row.draft && row.parentId === parentId
      ));
      return index >= 0 ? index : null;
    },
    afterAnchorIndex: (currentRows, anchorIndex) => descendantEndIndexFor(currentRows, anchorIndex),
  });
  if (!placement) return rows;
  const anchor = placement.referenceIndex === null ? undefined : placementRows[placement.referenceIndex];
  if (!anchor || (anchor.kind !== 'content' && anchor.kind !== 'field')) return rows;
  const separator = anchor.key.lastIndexOf('>');
  const key = change.stableRenderKey.current
    ?? sourceRows[0]?.key
    ?? (separator >= 0 ? `${anchor.key.slice(0, separator + 1)}${change.id}` : change.id);
  change.stableRenderKey.current = key;
  const common = {
    key,
    nodeId: change.id,
    depth: anchor.depth,
    parentId: change.parentId,
    referencePath: anchor.referencePath,
  };
  const pendingRow: VisualRow = change.presentation === 'field'
    ? {
        kind: 'field',
        ...common,
        slot: {
          id: change.id,
          fieldDefId: change.resolvedFieldDefId?.current ?? `pending-field-def:${change.id}`,
          source: 'own',
          entryId: change.id,
        },
        isFirstInFieldGroup: true,
        isLastInFieldGroup: true,
      }
    : {
        kind: 'content',
        ...common,
        ...(pendingStructuralRowIsDraft(
          change,
          placement.kind === 'insert' || (anchor.kind === 'content' && anchor.draft === true),
        )
          ? { draft: true }
          : {}),
        afterId: change.afterId,
      };
  const placedRows = sourceRows.length <= 1
    ? applyPendingRowPlacement(placementRows, pendingRow, placement)
    : (() => {
        const sourceRoot = sourceRows[0]!;
        const depthDelta = pendingRow.depth - sourceRoot.depth;
        const relocatedDescendants = sourceRows.slice(1).map((row) => ({
          ...row,
          depth: row.depth + depthDelta,
        }));
        return applyPendingRowsPlacement(
          placementRows,
          [pendingRow, ...relocatedDescendants],
          placement,
        );
      })();
  if (!change.originatesFromDraft) return placedRows;

  const nextDraftIndex = placedRows.findIndex((row) => (
    row.kind === 'content'
    && row.draft
    && row.parentId === change.parentId
    && row.nodeId !== change.id
  ));
  if (nextDraftIndex < 0) return placedRows;
  const nextDraft = placedRows[nextDraftIndex]!;
  if (nextDraft.kind !== 'content') return placedRows;
  const withoutNextDraft = [
    ...placedRows.slice(0, nextDraftIndex),
    ...placedRows.slice(nextDraftIndex + 1),
  ];
  const pendingIndex = withoutNextDraft.findIndex((row) => (
    (row.kind === 'content' || row.kind === 'field')
    && row.nodeId === change.id
    && row.parentId === change.parentId
  ));
  if (pendingIndex < 0) return placedRows;
  const nextDraftPlacement = descendantEndIndexFor(withoutNextDraft, pendingIndex);
  return [
    ...withoutNextDraft.slice(0, nextDraftPlacement),
    { ...nextDraft, afterId: change.id },
    ...withoutNextDraft.slice(nextDraftPlacement),
  ];
}

function rowCanAnchorGuide(row: VisualRow): row is Extract<VisualRow, { kind: 'content' | 'field' }> {
  return row.kind === 'content' || row.kind === 'field';
}

function flatDepthStyle(depth: number): CSSProperties {
  return { marginLeft: Math.min(depth, MAX_OUTLINE_INDENT_DEPTH) * 28 };
}

// First index whose row ends at or after `y` (rows are sorted by top, contiguous).
function firstRowEndingAfter(items: readonly RowLayoutItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const item = items[mid]!;
    if (item.top + item.height < y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function firstRowStartingAfter(items: readonly RowLayoutItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (items[mid]!.top <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function visibleRowRange(
  layout: RowLayout,
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  if (layout.items.length === 0) return { start: 0, end: 0 };
  const minY = Math.max(0, scrollTop - OVERSCAN_PX);
  const maxY = scrollTop + viewportHeight + OVERSCAN_PX;
  const start = Math.max(0, firstRowEndingAfter(layout.items, minY) - 1);
  const end = Math.min(layout.items.length, firstRowStartingAfter(layout.items, maxY) + 1);
  return { start, end: Math.max(end, start + 1) };
}

interface OutlinerFlatViewProps {
  panelId: string;
  parentId: NodeId;
  rootId: NodeId;
  rootSourcePreview?: boolean;
  selectionRootId?: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  ui: UiState;
  uiRef: MutableRefObject<UiState>;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  onTogglePin: (nodeId: NodeId) => void;
  showViewToolbar?: boolean;
  trailingDraft?: 'always' | 'auto' | 'none';
  // Empty-state placeholder for the root-level trailing draft (definition
  // template / options blocks). Only the draft directly under `parentId` gets it.
  draftPlaceholder?: string;
  // The panel's scroll container (NodePanel's <main>). Windowing measures the
  // flat list's offset within it to decide which rows fall in the viewport.
  scrollParentRef?: RefObject<HTMLElement | null>;
  // Embedded field values use the same flat structural renderer as body rows.
  // Only root-level rows route creates through the field command adapter;
  // descendants remain ordinary outline nodes.
  fieldValue?: FieldValueContext;
  draftOwnerKey?: NodeId;
  pendingDraftPolicy?: PendingDraftPolicy;
  rowSemanticRole?: 'treeitem' | 'presentation';
  referencePath?: readonly NodeId[];
  rootParent?: NodeProjection;
  suppressRootFieldEntries?: boolean;
  // Embedded outlines stay in normal flow instead of enabling windowing. They
  // still use the shared flat-flow shells, measurement, guides, and row keys.
  embeddedFlow?: boolean;
}

// Multi-parent trailing-draft id minter. Mirrors useTrailingDraftId, but a single
// flat view hosts the drafts for many expanded subtrees, so ids are keyed by
// parent: each parent keeps a stable id until that draft materializes (the id
// shows up in `byId`), at which point the next draft for that parent is fresh.
function useFlatDraftIds(
  byId: Map<NodeId, NodeProjection>,
  reservedChanges: readonly PendingStructuralChange[],
  rootParentId: NodeId,
  rootOwnerKey?: NodeId,
  rootPendingPolicy: PendingDraftPolicy = 'advance',
): (parentId: NodeId) => NodeId {
  const mapRef = useRef<Map<NodeId, NodeId>>(new Map());
  return useCallback((parentId: NodeId): NodeId => {
    const ownerKey = parentId === rootParentId ? rootOwnerKey ?? parentId : parentId;
    const pendingPolicy = parentId === rootParentId ? rootPendingPolicy : 'advance';
    const existing = mapRef.current.get(ownerKey);
    const reserved = existing
      ? reservedChanges.some((change) => change.parentId === parentId && change.id === existing)
      : false;
    if (existing && !shouldMintNextDraftId(existing, byId, reserved, pendingPolicy)) return existing;
    const fresh = freshNodeId();
    mapRef.current.set(ownerKey, fresh);
    return fresh;
  }, [byId, reservedChanges, rootOwnerKey, rootParentId, rootPendingPolicy]);
}

// A measured, absolutely-positioned wrapper for one windowed row. Reports its
// height on mount and whenever it changes (content wrap, image load, editor
// growth) so the layout's offsets stay accurate without a full remeasure.
function FlatRowShell({
  children,
  onMeasure,
  rowKey,
  top,
}: {
  children: ReactNode;
  onMeasure: (rowKey: string, height: number) => void;
  rowKey: string;
  top: number;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return undefined;
    const measure = () => onMeasure(rowKey, element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, rowKey]);
  return (
    <div
      className="outliner-flat-row"
      // Transparent to assistive tech so the windowed `treeitem` rows read as
      // direct children of the surrounding role="tree" container.
      role="presentation"
      data-flat-row-key={rowKey}
      ref={rowRef}
      style={{ transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  );
}

function FlowRowShell({
  children,
  rowKey,
}: {
  children: ReactNode;
  rowKey: string;
}) {
  return (
    <div
      className="outliner-flat-flow-row"
      role="presentation"
      data-flat-row-key={rowKey}
    >
      {children}
    </div>
  );
}

interface FlatGuideOverlayProps {
  byId: Map<NodeId, NodeProjection>;
  listRef: RefObject<HTMLDivElement | null>;
  measurementVersion: number;
  onToggleChildren: (nodeId: NodeId, anchorElement: HTMLElement | null) => void;
  renderIndices: readonly number[] | null;
  resolveScroller: () => HTMLElement | null;
  rows: readonly VisualRow[];
  scrollHeight: number;
  scrollTop: number;
  virtualize: boolean;
}

function FlatGuideOverlay(props: FlatGuideOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [flatGuides, setFlatGuides] = useState<FlatGuideGeometry[]>([]);
  const [flowResizeVersion, setFlowResizeVersion] = useState(0);

  useLayoutEffect(() => {
    if (props.virtualize || typeof ResizeObserver === 'undefined') return undefined;
    const list = props.listRef.current;
    if (!list) return undefined;
    const observer = new ResizeObserver(() => {
      setFlowResizeVersion((version) => version + 1);
    });
    list.querySelectorAll<HTMLElement>('[data-flat-row-key]').forEach((shell) => observer.observe(shell));
    return () => observer.disconnect();
  }, [props.listRef, props.rows, props.virtualize]);

  useLayoutEffect(() => {
    const list = props.listRef.current;
    const overlay = overlayRef.current;
    if (!list || !overlay) {
      setFlatGuides((current) => (current.length === 0 ? current : []));
      return;
    }

    const overlayRect = overlay.getBoundingClientRect();
    const viewportRect = props.resolveScroller()?.getBoundingClientRect() ?? overlayRect;
    const markerByRowKey = new Map<string, HTMLElement>();
    list.querySelectorAll<HTMLElement>('[data-flat-row-key]').forEach((shell) => {
      const key = shell.dataset.flatRowKey;
      const marker = shell.querySelector<HTMLElement>('.row-bullet-button');
      if (key && marker) markerByRowKey.set(key, marker);
    });

    const renderedIndices = props.virtualize && props.renderIndices
      ? new Set(props.renderIndices)
      : null;
    const measurements: FlatGuideMeasurement[] = [];
    for (let i = 0; i < props.rows.length; i += 1) {
      const row = props.rows[i];
      if (!row || row.kind !== 'content' || row.draft) continue;
      if (renderedIndices && !renderedIndices.has(i)) continue;
      const endIndex = descendantEndIndexFor(props.rows, i);
      if (endIndex <= i + 1) continue;

      let lastAnchorIndex = -1;
      for (let j = endIndex - 1; j > i; j -= 1) {
        const descendant = props.rows[j];
        if (!descendant || !rowCanAnchorGuide(descendant)) continue;
        if (renderedIndices && !renderedIndices.has(j)) continue;
        lastAnchorIndex = j;
        break;
      }
      if (lastAnchorIndex < 0) continue;

      const parentMarker = markerByRowKey.get(row.key);
      const lastAnchor = props.rows[lastAnchorIndex]!;
      const lastMarker = markerByRowKey.get(lastAnchor.key);
      if (!parentMarker || !lastMarker) {
        // The row structure still owns a guide, but preview resize, optimistic
        // insertion, and virtualization can briefly commit before every marker
        // is measurable. Keep the prior geometry for that incomplete frame.
        measurements.push({ key: row.key, nodeId: row.nodeId });
        continue;
      }

      const parentRect = parentMarker.getBoundingClientRect();
      const lastRect = lastMarker.getBoundingClientRect();
      if (parentRect.bottom < viewportRect.top || parentRect.top > viewportRect.bottom) continue;
      const topAbs = parentRect.top + parentRect.height / 2;
      const bottomAbs = lastRect.top + lastRect.height / 2;
      if (bottomAbs <= topAbs) {
        measurements.push({ key: row.key, nodeId: row.nodeId });
        continue;
      }
      if (bottomAbs < viewportRect.top || topAbs > viewportRect.bottom) continue;

      measurements.push({
        key: row.key,
        nodeId: row.nodeId,
        geometry: {
          key: row.key,
          nodeId: row.nodeId,
          left: parentRect.left + parentRect.width / 2 - overlayRect.left,
          top: topAbs - overlayRect.top,
          height: bottomAbs - topAbs,
        },
      });
    }

    setFlatGuides((current) => {
      const nextGuides = resolveFlatGuideMeasurements(current, measurements);
      return sameFlatGuides(current, nextGuides) ? current : nextGuides;
    });
  }, [
    flowResizeVersion,
    props.listRef,
    props.measurementVersion,
    props.renderIndices,
    props.resolveScroller,
    props.rows,
    props.scrollHeight,
    props.scrollTop,
    props.virtualize,
  ]);

  return (
    <div className="outliner-flat-guides" role="presentation" ref={overlayRef}>
      {flatGuides.map((guide) => (
        <IndentGuide
          key={`guide>${guide.key}`}
          guideFor={guide.nodeId}
          reference={props.byId.get(guide.nodeId)?.type === 'reference'}
          flatMetrics={guide}
          onToggleChildren={(anchorElement) => props.onToggleChildren(guide.nodeId, anchorElement ?? null)}
        />
      ))}
    </div>
  );
}

export function OutlinerFlatView(props: OutlinerFlatViewProps) {
  const { ui } = props;
  const index = useMemo(() => {
    const rootParent = props.rootParent;
    if (!rootParent || props.index.byId.get(rootParent.id) === rootParent) return props.index;
    const byId = new Map(props.index.byId);
    byId.set(rootParent.id, rootParent);
    return { ...props.index, byId };
  }, [props.index, props.rootParent]);
  const byId = index.byId;
  const parent = byId.get(props.parentId);
  const selectionRootId = props.selectionRootId ?? props.rootId;
  const pendingChanges = useMemo(
    () => ui.pendingStructuralChanges.filter((change) => (
      change.panelId === props.panelId && !ui.pendingRemovalIds.has(change.id)
    )),
    [props.panelId, ui.pendingRemovalIds, ui.pendingStructuralChanges],
  );
  const optimisticIndex = useMemo(() => {
    const overrides = pendingChanges.flatMap((change) => (
      change.nodeOverride ? [change.nodeOverride.current] : []
    ));
    if (overrides.length === 0) return index;
    const optimisticById = new Map(index.byId);
    for (const node of overrides) optimisticById.set(node.id, node);
    return { ...index, byId: optimisticById };
  }, [index, pendingChanges]);
  const draftIdFor = useFlatDraftIds(
    byId,
    pendingChanges,
    props.parentId,
    props.draftOwnerKey,
    props.pendingDraftPolicy,
  );
  const [rootSearchRefreshing, setRootSearchRefreshing] = useState(false);
  const visualRowsSnapshotRef = useRef<VisualRowsSnapshot | null>(null);

  const focusTargetsPanel = ui.focusedPanelId === props.panelId;
  const trailingFocusedParentId = ui.focusSurface === 'trailing' && focusTargetsPanel
    ? ui.focusedId
    : null;
  const focusedPendingChange = ui.focusedId
    ? pendingChanges.find((change) => change.id === ui.focusedId)
    : undefined;
  const draftFocusedParentId = ui.focusSurface === 'row'
    && focusTargetsPanel
    && ui.focusedId
    && !byId.has(ui.focusedId)
    // A newly created optimistic sibling is already the row accepting input.
    // Only materializing an actual trailing draft should advance another draft.
    && (!focusedPendingChange || focusedPendingChange.originatesFromDraft)
    ? ui.focusedParentId
    : null;
  const trailingDraftPlacement = ui.trailingDraftPlacement
    && (ui.trailingDraftPlacement.panelId === null || ui.trailingDraftPlacement.panelId === props.panelId)
    ? ui.trailingDraftPlacement
    : null;

  const projectedRows = useMemo(
    () => {
      const snapshot = buildVisualRowsIncrementally(
        visualRowsSnapshotRef.current,
        props.parentId,
        optimisticIndex,
        {
          expanded: ui.expanded,
          expandedHiddenFields: ui.expandedHiddenFields,
          showRootToolbar: props.showViewToolbar !== false,
          rootTrailingDraft: props.trailingDraft ?? 'none',
          draftIdFor,
          trailingFocusedParentId,
          draftFocusedParentId,
          trailingDraftPlacement,
          pendingRemovalIds: ui.pendingRemovalIds,
          systemFieldContext: { referenceSummary: optimisticIndex.referenceSummary },
          rootReferencePath: props.referencePath,
          suppressRootFieldEntries: props.suppressRootFieldEntries,
        },
      );
      visualRowsSnapshotRef.current = snapshot;
      return snapshot.rows;
    },
    [
      props.parentId,
      optimisticIndex,
      ui.expanded,
      ui.expandedHiddenFields,
      props.showViewToolbar,
      props.trailingDraft,
      draftIdFor,
      trailingFocusedParentId,
      draftFocusedParentId,
      trailingDraftPlacement,
      ui.pendingRemovalIds,
      props.referencePath,
      props.suppressRootFieldEntries,
    ],
  );
  const rows = useMemo(
    () => pendingChanges.reduce(insertPendingStructuralChange, projectedRows),
    [pendingChanges, projectedRows],
  );
  const optimisticChangesById = useMemo(
    () => new Map(pendingChanges.map((change) => [change.id, change])),
    [pendingChanges],
  );

  const virtualize = !props.embeddedFlow && rows.length > VIRTUALIZE_MIN_ROWS;
  const rootChildCount = useMemo(
    () => rows.reduce((count, row) => {
      if (row.parentId !== props.parentId || row.kind === 'toolbar') return count;
      if (row.kind === 'content') return row.draft ? count : count + 1;
      if (row.kind === 'filteredOut') return count + row.count;
      return count + 1;
    }, 0),
    [rows, props.parentId],
  );

  // ── Measurement + layout ──────────────────────────────────────────────────
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowHeightsRef = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, height: 0 });

  const measureRow = useCallback((rowKey: string, height: number) => {
    const current = rowHeightsRef.current.get(rowKey);
    if (current !== undefined && Math.abs(current - height) < 1) return;
    rowHeightsRef.current.set(rowKey, height);
    setMeasureVersion((version) => version + 1);
  }, []);

  const layout = useMemo(
    () => buildRowLayout(rows, rowHeightsRef.current),
    [rows, measureVersion],
  );

  // The element that actually scrolls is whichever ancestor has overflow and
  // taller content — not necessarily the passed container. Using a non-scrolling
  // reference would freeze the window (its rect moves together with the list), so
  // detect the real scroll container and use it as the fixed viewport reference.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const resolveScroller = useCallback((): HTMLElement | null => {
    if (scrollerRef.current) return scrollerRef.current;
    scrollerRef.current = nearestScrollContainer(listRef.current, props.scrollParentRef?.current);
    return scrollerRef.current;
  }, [props.scrollParentRef]);

  // Effective scroll offset = how far the flat list has scrolled above the scroll
  // container's top. Recomputed on scroll and on container resize.
  const updateScrollMetrics = useCallback(() => {
    const parent = resolveScroller();
    const list = listRef.current;
    if (!parent || !list) return;
    const parentRect = parent.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const next = { top: parentRect.top - listRect.top, height: parent.clientHeight };
    setScrollMetrics((current) => (
      Math.abs(current.top - next.top) < 1 && Math.abs(current.height - next.height) < 1
        ? current
        : next
    ));
  }, [resolveScroller]);

  const { capturePendingAnchor, restorePendingAnchor } = usePendingDisclosureAnchor(updateScrollMetrics);

  const captureDisclosureAnchor = useCallback((anchorElement: HTMLElement | null) => {
    const scroller = resolveScroller();
    const guideAnchor = anchorElement?.classList.contains('indent-guide') ?? false;
    const guideNodeId = anchorElement?.dataset.guideNodeId ?? null;
    const rowId = guideNodeId
      ?? anchorElement?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
      ?? null;
    const resolveElement = rowId && scroller
      ? () => {
        const chevron = scroller.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(rowId)}"] .row-chevron-button`);
        if (!guideAnchor) return chevron;
        return scroller.querySelector<HTMLElement>(`.indent-guide[data-guide-node-id="${CSS.escape(rowId)}"]`) ?? chevron;
      }
      : undefined;
    const snapshot = captureDisclosureScrollAnchor(anchorElement, scroller, resolveElement);
    capturePendingAnchor(snapshot);
  }, [capturePendingAnchor, resolveScroller]);

  const scrollFrameRef = useRef<number | null>(null);
  const scheduleScrollMetrics = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateScrollMetrics();
    });
  }, [updateScrollMetrics]);

  useLayoutEffect(() => {
    if (!virtualize) return undefined;
    scrollerRef.current = null;
    const parent = resolveScroller();
    if (RENDER_PROBE_ENABLED) {
      console.log('[flat] scroller=', parent?.className ?? parent?.tagName ?? 'none');
    }
    updateScrollMetrics();
    // `scroll` events do not bubble; the shared capture dispatcher routes only
    // events belonging to this view's scroll container.
    const unregisterScroll = registerOutlinerScrollListener(resolveScroller, scheduleScrollMetrics);
    let observer: ResizeObserver | undefined;
    if (parent && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateScrollMetrics());
      observer.observe(parent);
    }
    return () => {
      unregisterScroll();
      observer?.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [virtualize, resolveScroller, updateScrollMetrics, scheduleScrollMetrics]);

  // ── Scroll anchoring ───────────────────────────────────────────────────────
  // Row heights start at ROW_ESTIMATE_PX and are corrected once a row mounts and is
  // measured. When a row ABOVE the viewport is corrected, every offset below it (the
  // whole visible window) shifts — but scrollTop does not, so the content visibly
  // jumps. Only felt scrolling UP: scrolling down, corrections land below the viewport
  // (off-screen). Fix: when the layout changes for the SAME rows (a pure height
  // correction), find the row sitting at the viewport top and shift scrollTop by how
  // far that row moved — synchronously, before paint — so the visible rows stay put.
  const prevLayoutRef = useRef<RowLayout | null>(null);
  const prevRowsRef = useRef<readonly VisualRow[]>(rows);
  useLayoutEffect(() => {
    const prevLayout = prevLayoutRef.current;
    const prevRows = prevRowsRef.current;
    prevLayoutRef.current = layout;
    prevRowsRef.current = rows;
    // Only compensate for height-only changes (same rows array): row add/remove or a
    // re-projection is a different scroll context and must not be anchored blindly.
    if (!virtualize || !prevLayout || prevRows !== rows) return;
    if (prevLayout.items.length !== layout.items.length) return;
    const scroller = resolveScroller();
    const list = listRef.current;
    if (!scroller || !list) return;
    // List-Y currently at the scroller's top edge (= viewport top, in row coordinates).
    // Independent of internal row layout, so it reflects the pre-adjustment scroll pos.
    const anchorY = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (anchorY <= 0) return; // at/above the list top — nothing above to shift us.
    const idx = firstRowEndingAfter(prevLayout.items, anchorY);
    if (idx >= layout.items.length) return;
    const delta = layout.items[idx]!.top - prevLayout.items[idx]!.top;
    if (delta !== 0) scroller.scrollTop += delta;
  }, [layout, rows, virtualize, resolveScroller]);

  useLayoutEffect(() => {
    return restorePendingAnchor();
  }, [layout, restorePendingAnchor, rows]);

  // ── Window selection ──────────────────────────────────────────────────────
  // Force-mount rows that must accept focus even when scrolled out of view: the
  // focused row, the focus-request target, the pending-input target, and every
  // draft row (so the trailing input is always available). A mounted off-screen
  // row's editor can focus; the browser then scrolls it into view.
  const forcedIndices = useMemo(() => {
    if (!virtualize) return [];
    const targets = new Set<NodeId>();
    if (ui.focusedPanelId === props.panelId && ui.focusedId) targets.add(ui.focusedId);
    if (ui.focusRequest?.target.panelId === props.panelId) {
      targets.add(ui.focusRequest.target.nodeId);
    }
    if (ui.pendingInputChar?.target.panelId === props.panelId) {
      targets.add(ui.pendingInputChar.target.nodeId);
    }
    const indices: number[] = [];
    rows.forEach((row, i) => {
      if ('draft' in row && row.draft) indices.push(i);
      else if ((row.kind === 'content' || row.kind === 'field') && targets.has(row.nodeId)) indices.push(i);
    });
    return indices;
  }, [virtualize, rows, ui.focusedId, ui.focusedPanelId, ui.focusRequest, ui.pendingInputChar, props.panelId]);

  const renderIndices = useMemo(() => {
    if (!virtualize) return null;
    const range = visibleRowRange(layout, scrollMetrics.top, scrollMetrics.height);
    const set = new Set<number>(forcedIndices);
    for (let i = range.start; i < range.end; i += 1) set.add(i);
    return [...set].sort((a, b) => a - b);
  }, [virtualize, layout, scrollMetrics.top, scrollMetrics.height, forcedIndices]);

  const toggleDirectChildrenExpansion = useCallback((rowId: NodeId, anchorElement?: HTMLElement | null) => {
    const childParentId = outlinerChildParentId(rowId, byId);
    const childParentNode = childParentId ? byId.get(childParentId) : undefined;
    const childIds = outlinerChildren(childParentNode, byId);
    if (childIds.length === 0) return;
    captureDisclosureAnchor(anchorElement ?? null);
    props.setUi((prev) => {
      const expandedSet = new Set(prev.expanded);
      const anyChildExpanded = childIds.some((childId) => expandedSet.has(childId));
      for (const childId of childIds) {
        if (anyChildExpanded) expandedSet.delete(childId);
        else expandedSet.add(childId);
      }
      return { ...prev, expanded: expandedSet };
    });
  }, [byId, captureDisclosureAnchor, props.setUi]);

  const flatGuideOverlay = (
    <FlatGuideOverlay
      byId={byId}
      listRef={listRef}
      measurementVersion={measureVersion}
      onToggleChildren={toggleDirectChildrenExpansion}
      renderIndices={renderIndices}
      resolveScroller={resolveScroller}
      rows={rows}
      scrollHeight={scrollMetrics.height}
      scrollTop={scrollMetrics.top}
      virtualize={virtualize}
    />
  );

  // ── Live-search refresh ────────────────────────────────────────────────────
  // A search node recomputes its results whenever they are visible — when it is
  // the panel root, or an expanded content row. This gathers the former per-node
  // effect, gathered across the whole flattened tree.
  const searchParentIds = useMemo(() => {
    const ids = new Set<NodeId>();
    const ownsSearchRefresh = (nodeId: NodeId) => {
      const node = byId.get(nodeId);
      return node?.type === 'search' && readViewConfig(node, byId).viewMode !== 'table';
    };
    if (ownsSearchRefresh(props.parentId)) ids.add(props.parentId);
    for (const row of rows) {
      if (row.kind === 'content' && !row.draft && ui.expanded.has(row.nodeId) && ownsSearchRefresh(row.nodeId)) {
        ids.add(row.nodeId);
      }
    }
    return [...ids].sort();
  }, [rows, byId, props.parentId, ui.expanded]);

  const searchKey = searchParentIds.join('|');
  const searchRefreshInFlightRef = useRef(new Set<NodeId>());
  useEffect(() => {
    const ids = searchKey ? searchKey.split('|') : [];
    const rootSearchVisible = ids.includes(props.parentId);
    if (!rootSearchVisible) setRootSearchRefreshing(false);
    for (const id of ids) {
      if (searchRefreshInFlightRef.current.has(id)) continue;
      searchRefreshInFlightRef.current.add(id);
      if (id === props.parentId) setRootSearchRefreshing(true);
      void props.run(() => api.refreshSearchNodeResults(id), { applyFocus: false })
        .finally(() => {
          searchRefreshInFlightRef.current.delete(id);
          if (id === props.parentId) setRootSearchRefreshing(false);
        });
    }
  }, [searchKey, index.projection, props.parentId, props.run]);

  const renderRow = (row: VisualRow, rowIndex: number): ReactNode => {
    switch (row.kind) {
      case 'toolbar': {
        const node = byId.get(row.nodeId);
        if (!node) return null;
        return (
          <div className="view-toolbar-flat-scope" style={flatDepthStyle(row.indentDepth)}>
            <ViewToolbar
              node={node}
              view={readViewConfig(node, byId)}
              index={index}
              run={props.run}
              dropdownRequest={ui.toolbarDropdownRequest}
              onDropdownRequestConsumed={(request) => {
                props.setUi((prev) => (
                  prev.toolbarDropdownRequest === request
                    ? { ...prev, toolbarDropdownRequest: null }
                    : prev
                ));
              }}
            />
          </div>
        );
      }
      case 'table':
        return (
          <div className="outliner-table-flat-scope" style={flatDepthStyle(row.depth)}>
            <OutlinerTableView
              panelId={props.panelId}
              parentId={row.nodeId}
              rootId={props.rootId}
              selectionRootId={selectionRootId}
              onRoot={props.onRoot}
              depth={0}
              index={index}
              isNodePinned={props.isNodePinned}
              ui={ui}
              uiRef={props.uiRef}
              setUi={props.setUi}
              run={props.run}
              onTogglePin={props.onTogglePin}
              trigger={props.trigger}
              setTrigger={props.setTrigger}
              dragId={props.dragId}
              setDragId={props.setDragId}
              referencePath={row.referencePath}
              trailingDraft="auto"
              scrollParentRef={props.scrollParentRef}
            />
          </div>
        );
      case 'group':
        return <ViewGroupHeading label={row.label} />;
      case 'filteredOut':
        return (
          <FilteredOutHeading
            count={row.count}
            expanded={row.expanded}
            onToggle={() => {
              props.setUi((prev) => {
                const expanded = new Set(prev.expanded);
                if (expanded.has(row.id)) expanded.delete(row.id);
                else expanded.add(row.id);
                return { ...prev, expanded };
              });
            }}
          />
        );
      case 'hiddenField':
        return (
          <HiddenFieldReveal
            label={row.label}
            onReveal={() => {
              props.setUi((prev) => {
                const expandedHiddenFields = new Set(prev.expandedHiddenFields);
                expandedHiddenFields.add(hiddenFieldKey(row.parentId, row.fieldId));
                return { ...prev, expandedHiddenFields };
              });
            }}
          />
        );
      case 'field':
        return (
          <OutlinerFieldRow
            panelId={props.panelId}
            slot={row.slot}
            parentId={row.parentId}
            rootId={props.rootId}
            pagePreviewOwnerId={props.rootSourcePreview && row.depth === 0 ? row.parentId : undefined}
            selectionRootId={selectionRootId}
            onRoot={props.onRoot}
            depth={row.depth}
            index={index}
            isNodePinned={props.isNodePinned}
            ui={ui}
            uiRef={props.uiRef}
            setUi={props.setUi}
            run={props.run}
            onTogglePin={props.onTogglePin}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            dragId={props.dragId}
            setDragId={props.setDragId}
            isFirstInFieldGroup={row.isFirstInFieldGroup}
            isLastInFieldGroup={row.isLastInFieldGroup}
            optimisticChange={optimisticChangesById.get(row.nodeId)}
          />
        );
      case 'content':
        const fieldValue = row.parentId === props.parentId ? props.fieldValue : undefined;
        const sourceOwner = index.byId.get(row.nodeId);
        const sourceValues = fieldValue || sourceOwner?.type !== undefined
          ? []
          : nodeSourceValues(row.nodeId, index.byId);
        const outlineSourcePreviewKey = sourceValues.length > 0
          ? sourceValues.map((value) => `${value.sourceValueId}\0${value.sourceText}`).join('\x01')
          : undefined;
        return (
          <OutlinerItem
            panelId={props.panelId}
            nodeId={row.nodeId}
            parentId={row.parentId}
            rootId={props.rootId}
            selectionRootId={selectionRootId}
            onRoot={props.onRoot}
            depth={row.depth}
            index={index}
            isNodePinned={props.isNodePinned}
            ui={ui}
            uiRef={props.uiRef}
            setUi={props.setUi}
            run={props.run}
            onTogglePin={props.onTogglePin}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            dragId={props.dragId}
            setDragId={props.setDragId}
            referencePath={row.referencePath}
            draft={row.draft}
            draftAfterId={row.draft ? row.afterId ?? null : undefined}
            optimisticChange={optimisticChangesById.get(row.nodeId)}
            draftPlaceholder={row.draft && row.parentId === props.parentId ? props.draftPlaceholder : undefined}
            fieldValue={fieldValue}
            outlineSourcePreviewKey={outlineSourcePreviewKey}
            optionField={row.parentId === props.parentId ? props.fieldValue?.optionField : undefined}
            onSelectOption={row.parentId === props.parentId && props.fieldValue
              ? (optionId, id) => props.run(
                  () => props.fieldValue!.onSelectOption(optionId, id),
                  { applyFocus: false },
                )
              : undefined}
            semanticRole={row.parentId === props.parentId ? props.rowSemanticRole : undefined}
            onDisclosureToggleAnchor={captureDisclosureAnchor}
          />
        );
      default:
        return null;
    }
  };

  if (!virtualize || renderIndices === null) {
    return (
      <>
        <div className="outliner-flat-flow" role="presentation" ref={listRef}>
          {flatGuideOverlay}
          {rows.map((row, i) => (
            <FlowRowShell key={row.key} rowKey={row.key}>
              {renderRow(row, i)}
            </FlowRowShell>
          ))}
        </div>
        <OutlinerEmptyState
          childCount={rootChildCount}
          parent={parent}
          parentId={props.parentId}
          projection={index.projection}
          rootLevel={props.parentId === props.rootId && !props.fieldValue}
          searchLoading={rootSearchRefreshing}
        />
      </>
    );
  }

  const containerStyle: CSSProperties = { height: layout.totalHeight };
  return (
    <>
      <div className="outliner-flat" role="presentation" ref={listRef} style={containerStyle}>
        {flatGuideOverlay}
        {renderIndices.map((i) => {
          const row = rows[i]!;
          const item = layout.items[i]!;
          return (
            <FlatRowShell key={row.key} onMeasure={measureRow} rowKey={row.key} top={item.top}>
              {renderRow(row, i)}
            </FlatRowShell>
          );
        })}
      </div>
      <OutlinerEmptyState
        childCount={rootChildCount}
        parent={parent}
        parentId={props.parentId}
        projection={index.projection}
        rootLevel={props.parentId === props.rootId && !props.fieldValue}
        searchLoading={rootSearchRefreshing}
      />
    </>
  );
}
