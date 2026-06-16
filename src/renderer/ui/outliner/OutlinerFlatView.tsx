import {
  Fragment,
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
import type { DocumentIndex, UiState } from '../../state/document';
import { buildVisualRows, type VisualRow } from '../../state/visualRows';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { hiddenFieldKey, readViewConfig } from './row-model';
import { RENDER_PROBE_ENABLED } from './renderProbe';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { ViewToolbar } from './ViewToolbar';
import { HiddenFieldReveal, ViewGroupHeading } from './OutlinerViewChrome';
import { OutlinerEmptyState } from './OutlinerEmptyState';

// The flat renderer is the default outliner path. The old recursive renderer is
// retained as a reload-scoped diagnostic fallback while parity work settles.
function readRecursiveFallbackFlag(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('lin:recursive-outliner') === '1';
  } catch {
    return false;
  }
}

export const RECURSIVE_OUTLINER_FALLBACK_ENABLED = readRecursiveFallbackFlag();

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
  scrollParentRef: RefObject<HTMLElement | null>;
}

// Multi-parent trailing-draft id minter. Mirrors useTrailingDraftId, but a single
// flat view hosts the drafts for many expanded subtrees, so ids are keyed by
// parent: each parent keeps a stable id until that draft materializes (the id
// shows up in `byId`), at which point the next draft for that parent is fresh.
function useFlatDraftIds(byId: Map<NodeId, NodeProjection>): (parentId: NodeId) => NodeId {
  const mapRef = useRef<Map<NodeId, NodeId>>(new Map());
  return useCallback((parentId: NodeId): NodeId => {
    const existing = mapRef.current.get(parentId);
    if (existing && !byId.has(existing)) return existing;
    const fresh = freshNodeId();
    mapRef.current.set(parentId, fresh);
    return fresh;
  }, [byId]);
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

export function OutlinerFlatView(props: OutlinerFlatViewProps) {
  const { index, ui } = props;
  const byId = index.byId;
  const parent = byId.get(props.parentId);
  const selectionRootId = props.selectionRootId ?? props.rootId;
  const draftIdFor = useFlatDraftIds(byId);
  const [rootSearchRefreshing, setRootSearchRefreshing] = useState(false);

  const trailingFocusedParentId = ui.focusSurface === 'trailing' && ui.focusedPanelId === props.panelId
    ? ui.focusedId
    : null;
  const draftFocusedParentId = ui.focusSurface === 'row'
    && ui.focusedPanelId === props.panelId
    && ui.focusedId
    && !byId.has(ui.focusedId)
    ? ui.focusedParentId
    : null;
  const trailingDraftPlacement = ui.trailingDraftPlacement
    && (ui.trailingDraftPlacement.panelId === null || ui.trailingDraftPlacement.panelId === props.panelId)
    ? ui.trailingDraftPlacement
    : null;

  const rows = useMemo(
    () => buildVisualRows(props.parentId, byId, {
      expanded: ui.expanded,
      expandedHiddenFields: ui.expandedHiddenFields,
      showRootToolbar: props.showViewToolbar !== false,
      rootTrailingDraft: props.trailingDraft ?? 'none',
      draftIdFor,
      trailingFocusedParentId,
      draftFocusedParentId,
      trailingDraftPlacement,
    }),
    [
      props.parentId,
      byId,
      ui.expanded,
      ui.expandedHiddenFields,
      props.showViewToolbar,
      props.trailingDraft,
      draftIdFor,
      trailingFocusedParentId,
      draftFocusedParentId,
      trailingDraftPlacement,
    ],
  );

  const virtualize = rows.length > VIRTUALIZE_MIN_ROWS;
  const rootChildCount = useMemo(
    () => rows.filter((row) => row.parentId === props.parentId && row.kind !== 'toolbar' && !(row.kind === 'content' && row.draft)).length,
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
    let el: HTMLElement | null = listRef.current?.parentElement ?? null;
    while (el) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        break;
      }
      el = el.parentElement;
    }
    scrollerRef.current = el ?? props.scrollParentRef.current;
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
    // `scroll` events do not bubble, and the element that actually scrolls may be
    // an ancestor/descendant of the passed container, so listen in the capture
    // phase on the window — that receives scroll from any element in the tree.
    const onScroll = () => scheduleScrollMetrics();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    let observer: ResizeObserver | undefined;
    if (parent && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateScrollMetrics());
      observer.observe(parent);
    }
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
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

  // ── Window selection ──────────────────────────────────────────────────────
  // Force-mount rows that must accept focus even when scrolled out of view: the
  // focused row, the focus-request target, the pending-input target, and every
  // draft row (so the trailing input is always available). A mounted off-screen
  // row's editor can focus; the browser then scrolls it into view.
  const forcedIndices = useMemo(() => {
    if (!virtualize) return [];
    const targets = new Set<NodeId>();
    if (ui.focusedPanelId === props.panelId && ui.focusedId) targets.add(ui.focusedId);
    if (ui.focusRequest && ui.focusRequest.target.panelId === props.panelId) {
      targets.add(ui.focusRequest.target.nodeId);
    }
    if (ui.pendingInputChar && ui.pendingInputChar.target.panelId === props.panelId) {
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

  // ── Live-search refresh ────────────────────────────────────────────────────
  // A search node recomputes its results whenever they are visible — when it is
  // the panel root, or an expanded content row. Mirrors OutlinerView's per-node
  // effect, gathered across the whole flattened tree.
  const searchParentIds = useMemo(() => {
    const ids = new Set<NodeId>();
    if (byId.get(props.parentId)?.type === 'search') ids.add(props.parentId);
    for (const row of rows) {
      if (row.kind === 'content' && !row.draft && ui.expanded.has(row.nodeId) && byId.get(row.nodeId)?.type === 'search') {
        ids.add(row.nodeId);
      }
    }
    return [...ids].sort();
  }, [rows, byId, props.parentId, ui.expanded]);

  const searchKey = searchParentIds.join('|');
  useEffect(() => {
    const ids = searchKey ? searchKey.split('|') : [];
    const rootSearchVisible = ids.includes(props.parentId);
    if (!rootSearchVisible) setRootSearchRefreshing(false);
    let active = true;
    for (const id of ids) {
      if (id === props.parentId) setRootSearchRefreshing(true);
      void api.refreshSearchNodeResults(id)
        .catch((error) => {
          console.error('Failed to refresh live search results', error);
        })
        .finally(() => {
          if (active && id === props.parentId) setRootSearchRefreshing(false);
        });
    }
    return () => {
      active = false;
    };
  }, [searchKey, index.projection, props.parentId]);

  const renderRow = (row: VisualRow): ReactNode => {
    switch (row.kind) {
      case 'toolbar': {
        const node = byId.get(row.nodeId);
        if (!node) return null;
        return (
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
        );
      }
      case 'group':
        return <ViewGroupHeading label={row.label} />;
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
            entryId={row.nodeId}
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
            isFirstInFieldGroup={row.isFirstInFieldGroup}
            isLastInFieldGroup={row.isLastInFieldGroup}
          />
        );
      case 'content':
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
            draftPlaceholder={row.draft && row.parentId === props.parentId ? props.draftPlaceholder : undefined}
            flat
          />
        );
      default:
        return null;
    }
  };

  if (!virtualize || renderIndices === null) {
    return (
      <>
        <OutlinerEmptyState
          childCount={rootChildCount}
          parent={parent}
          parentId={props.parentId}
          projection={index.projection}
          rootLevel={props.parentId === props.rootId}
          searchLoading={rootSearchRefreshing}
        />
        {rows.map((row) => <Fragment key={row.key}>{renderRow(row)}</Fragment>)}
      </>
    );
  }

  const containerStyle: CSSProperties = { height: layout.totalHeight };
  return (
    <>
      <OutlinerEmptyState
        childCount={rootChildCount}
        parent={parent}
        parentId={props.parentId}
        projection={index.projection}
        rootLevel={props.parentId === props.rootId}
        searchLoading={rootSearchRefreshing}
      />
      <div className="outliner-flat" role="presentation" ref={listRef} style={containerStyle}>
        {renderIndices.map((i) => {
          const row = rows[i]!;
          const item = layout.items[i]!;
          return (
            <FlatRowShell key={row.key} onMeasure={measureRow} rowKey={row.key} top={item.top}>
              {renderRow(row)}
            </FlatRowShell>
          );
        })}
      </div>
    </>
  );
}
