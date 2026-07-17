import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { FieldType, NodeId, NodeProjection } from '../../api/types';
import type { Messages } from '../../../core/i18n';
import { projectFieldTypeById } from '../../../core/configProjection';
import {
  CREATED_FIELD,
  DAY_FIELD,
  DONE_AT_FIELD,
  DONE_FIELD,
  NAME_FIELD,
  OWNER_FIELD,
  REF_COUNT_FIELD,
  TAGS_FIELD,
  UPDATED_FIELD,
  isSystemFieldId,
  systemFieldDisplay,
} from '../../../core/systemFields';
import type { DocumentIndex, UiState } from '../../state/document';
import { outlinerChildParentId } from '../../state/document';
import { referenceSummaryForIndex } from '../../state/referenceSummary';
import {
  cursorEnd,
  cursorStart,
  focusTarget,
  requestFocusState,
  requestPendingInputState,
  rowFocusTarget,
} from '../focus/focusModel';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { nearestScrollContainer } from '../interactions/disclosureScrollAnchor';
import {
  AddIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FieldIcon,
  HideIcon,
  ICON_SIZE,
  MoreIcon,
  PencilIcon,
  TrashIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { Input } from '../primitives/Input';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { SelectControl } from '../primitives/SelectControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { FIELD_TYPE_OPTIONS, outlinerChildren } from '../shared';
import { useT } from '../../i18n/I18nProvider';
import { FieldValueOutliner } from './FieldValueOutliner';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { OutlinerView } from './OutlinerView';
import { FieldKindIcon, ViewToolbar } from './ViewToolbar';
import { RowHost } from './RowHost';
import { RowMarker } from './RowMarker';
import {
  buildOutlinerRows,
  fieldChoiceLabel,
  fieldEntryForViewCell,
  hiddenFieldKey,
  readViewConfig,
  viewFieldValuesFor,
  visibleAuthoredTableFieldIds,
  visibleDisplayFields,
  type OutlinerRowItem,
  type ViewDisplayField,
} from './row-model';
import { useTrailingDraftId } from './draftRow';
import { SystemFieldValue } from './SystemFieldValue';
import { FilteredOutHeading, HiddenFieldReveal } from './OutlinerViewChrome';
import { OutlinerEmptyState } from './OutlinerEmptyState';
import {
  nearestTableCell,
  resolveTableCellNavigation,
  TABLE_TITLE_COLUMN_ID,
  type TableCellAddress,
  type TableNavigationKey,
} from './tableNavigation';

const TABLE_VIRTUALIZE_MIN_ROWS = 60;
const TABLE_ROW_ESTIMATE_PX = 34;
const TABLE_OVERSCAN_PX = 800;
const TABLE_TITLE_WIDTH = 152;
const TABLE_COLUMN_DEFAULT_WIDTH = 86;
const TABLE_COLUMN_MIN_WIDTH = 72;
const TABLE_COLUMN_MAX_WIDTH = 520;
const TABLE_ACTION_WIDTH = 82;

type TableMessages = Messages['outliner']['table'];

interface TableLayoutItem {
  top: number;
  height: number;
}

interface TableLayout {
  items: TableLayoutItem[];
  totalHeight: number;
}

interface PendingFieldMaterialization {
  input: string;
}

type TableRenderRow =
  | {
      kind: 'data';
      key: string;
      id: NodeId;
      filtered: boolean;
      draft?: boolean;
      afterId?: NodeId | null;
    }
  | {
      kind: 'filteredHeading';
      key: string;
      id: string;
      count: number;
      expanded: boolean;
    };

export interface OutlinerTableViewProps {
  panelId: string;
  parentId: NodeId;
  rootId: NodeId;
  selectionRootId?: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  depth: number;
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
  referencePath?: readonly NodeId[];
  showViewToolbar?: boolean;
  trailingDraft?: 'always' | 'auto' | 'none';
  draftPlaceholder?: string;
  scrollParentRef?: RefObject<HTMLElement | null>;
  suppressedOwnerFieldDefIds?: ReadonlySet<string>;
}

function clampColumnWidth(width: number | undefined): number {
  if (!Number.isFinite(width)) return TABLE_COLUMN_DEFAULT_WIDTH;
  return Math.min(TABLE_COLUMN_MAX_WIDTH, Math.max(TABLE_COLUMN_MIN_WIDTH, Math.round(width!)));
}

function tableGridTemplate(columns: readonly ViewDisplayField[], previews: ReadonlyMap<string, number>): string {
  const fields = columns.map((column) => `${clampColumnWidth(previews.get(column.id) ?? column.width)}px`);
  return [`${TABLE_TITLE_WIDTH}px`, ...fields, `${TABLE_ACTION_WIDTH}px`].join(' ');
}

function tableGridMinWidth(columns: readonly ViewDisplayField[], previews: ReadonlyMap<string, number>): number {
  return TABLE_TITLE_WIDTH
    + columns.reduce((total, column) => total + clampColumnWidth(previews.get(column.id) ?? column.width), 0)
    + TABLE_ACTION_WIDTH;
}

function buildTableLayout(rows: readonly TableRenderRow[], measured: ReadonlyMap<string, number>): TableLayout {
  const items: TableLayoutItem[] = [];
  let top = 0;
  for (const row of rows) {
    const height = measured.get(row.key) ?? TABLE_ROW_ESTIMATE_PX;
    items.push({ top, height });
    top += height;
  }
  return { items, totalHeight: top };
}

function firstRowEndingAfter(items: readonly TableLayoutItem[], y: number): number {
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

function firstRowStartingAfter(items: readonly TableLayoutItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (items[mid]!.top <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function visibleTableRange(layout: TableLayout, scrollTop: number, viewportHeight: number) {
  if (layout.items.length === 0) return { start: 0, end: 0 };
  const minY = Math.max(0, scrollTop - TABLE_OVERSCAN_PX);
  const maxY = scrollTop + viewportHeight + TABLE_OVERSCAN_PX;
  const start = Math.max(0, firstRowEndingAfter(layout.items, minY) - 1);
  const end = Math.min(layout.items.length, firstRowStartingAfter(layout.items, maxY) + 1);
  return { start, end: Math.max(start + 1, end) };
}

function cellKey(cell: TableCellAddress): string {
  return `${cell.rowId}\u001f${cell.columnId}`;
}

function isTableRecordSelected(rowId: NodeId, ui: UiState): boolean {
  if (ui.focusedId) return false;
  const selected = ui.selectedIds.has(rowId) || ui.selectedId === rowId;
  if (!selected) return false;
  return ui.selectionSource !== 'ref-click' || ui.selectedIds.size > 1;
}

function tableFieldLabel(fieldId: string, index: DocumentIndex, tt: TableMessages): string {
  const labels: Record<string, string> = {
    [NAME_FIELD]: tt.systemFields.name,
    [CREATED_FIELD]: tt.systemFields.created,
    [DAY_FIELD]: tt.systemFields.day,
    [DONE_FIELD]: tt.systemFields.done,
    [DONE_AT_FIELD]: tt.systemFields.doneAt,
    [UPDATED_FIELD]: tt.systemFields.updated,
    [REF_COUNT_FIELD]: tt.systemFields.references,
    [OWNER_FIELD]: tt.systemFields.owner,
    [TAGS_FIELD]: tt.systemFields.tags,
  };
  return labels[fieldId] ?? fieldChoiceLabel(fieldId, index.byId);
}

function tableFieldTypeLabel(fieldType: FieldType, tt: TableMessages): string {
  return tt.fieldTypes[fieldType];
}

function tableFieldChoices(index: DocumentIndex, tt: TableMessages): Array<{ id: string; label: string }> {
  const systemIds = [
    CREATED_FIELD,
    DAY_FIELD,
    DONE_FIELD,
    DONE_AT_FIELD,
    UPDATED_FIELD,
    REF_COUNT_FIELD,
    OWNER_FIELD,
    TAGS_FIELD,
  ];
  const choices = systemIds.map((id) => ({ id, label: tableFieldLabel(id, index, tt) }));
  for (const node of index.projection.nodes) {
    if (node.type !== 'fieldDef' || node.parentId !== index.projection.schemaId) continue;
    choices.push({ id: node.id, label: node.content.text || node.id });
  }
  return choices.sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
}

function tableRenderRows(
  rows: readonly OutlinerRowItem[],
  filteredExpanded: ReadonlySet<NodeId>,
  draft: Extract<TableRenderRow, { kind: 'data' }> | null,
): TableRenderRow[] {
  const result: TableRenderRow[] = [];
  for (const row of rows) {
    if (row.type === 'content') {
      result.push({ kind: 'data', key: `row:${row.id}`, id: row.id, filtered: false });
      continue;
    }
    if (row.type !== 'filteredOut') continue;
    if (draft) result.push(draft);
    result.push({
      kind: 'filteredHeading',
      key: `filtered:${row.id}`,
      id: row.id,
      count: row.count,
      expanded: filteredExpanded.has(row.id),
    });
    if (filteredExpanded.has(row.id)) {
      for (const nested of row.rows) {
        if (nested.type !== 'content') continue;
        result.push({ kind: 'data', key: `filtered-row:${row.id}:${nested.id}`, id: nested.id, filtered: true });
      }
    }
    draft = null;
  }
  if (draft) result.push(draft);
  return result;
}

function MeasuredTableRow({
  children,
  onMeasure,
  rowKey,
  top,
}: {
  children: ReactNode;
  onMeasure: (rowKey: string, height: number) => void;
  rowKey: string;
  top?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
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
      className={top === undefined ? 'outliner-table-flow-row' : 'outliner-table-window-row'}
      data-table-row-key={rowKey}
      ref={ref}
      role="presentation"
      style={top === undefined ? undefined : { transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  );
}

export function OutlinerTableView(props: OutlinerTableViewProps) {
  const t = useT();
  const tt = t.outliner.table;
  const parent = props.index.byId.get(props.parentId);
  const selectionRootId = props.selectionRootId ?? props.rootId;
  const view = useMemo(
    () => readViewConfig(parent, props.index.byId),
    [parent, props.index.byId],
  );
  const columns = useMemo(() => visibleDisplayFields(view), [view]);
  const displayedFieldDefIds = useMemo(() => visibleAuthoredTableFieldIds(view), [view]);
  const builtRows = useMemo(() => buildOutlinerRows(parent, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
    suppressedFieldDefIds: props.suppressedOwnerFieldDefIds,
  }), [parent, props.index.byId, props.suppressedOwnerFieldDefIds, props.ui.expandedHiddenFields]);
  const ownerRows = useMemo(
    () => builtRows.filter((row) => row.type === 'field' || row.type === 'hiddenField'),
    [builtRows],
  );
  const draftId = useTrailingDraftId(props.parentId, props.index.byId);
  const trailingMode = props.trailingDraft ?? 'none';
  const realContentCount = useMemo(() => builtRows.reduce((count, row) => {
    if (row.type === 'content') return count + 1;
    if (row.type === 'filteredOut') return count + row.count;
    return count;
  }, 0), [builtRows]);
  const trailingFocused = props.ui.focusedId === props.parentId
    && props.ui.focusSurface === 'trailing'
    && props.ui.focusedPanelId === props.panelId;
  const draftFocused = props.ui.focusedId === draftId && props.ui.focusedPanelId === props.panelId;
  const showDraft = parent?.type !== 'search' && Boolean(parent) && (
    trailingMode === 'always'
    || (trailingMode === 'auto' && (realContentCount === 0 || trailingFocused || draftFocused))
  );
  const draftRow = useMemo(() => showDraft ? {
    kind: 'data' as const,
    key: `row:${draftId}`,
    id: draftId,
    filtered: false,
    draft: true,
    afterId: null,
  } : null, [draftId, showDraft]);
  const renderRows = useMemo(
    () => tableRenderRows(builtRows, props.ui.expanded, draftRow),
    [builtRows, draftRow, props.ui.expanded],
  );
  const rowIds = useMemo(
    () => renderRows.flatMap((row) => row.kind === 'data' ? [row.id] : []),
    [renderRows],
  );
  const columnIds = useMemo(
    () => [TABLE_TITLE_COLUMN_ID, ...columns.map((column) => column.id)],
    [columns],
  );
  const [activeCell, setActiveCell] = useState<TableCellAddress | null>(null);
  const cellRefs = useRef(new Map<string, HTMLElement>());
  const referencePath = props.referencePath ?? [props.parentId];
  const referenceSummary = useMemo(() => referenceSummaryForIndex(props.index), [props.index]);
  const columnLabels = useMemo(() => new Map(columns.map((column) => [
    column.id,
    column.label?.trim() || tableFieldLabel(column.field, props.index, tt),
  ])), [columns, props.index, tt]);
  const fieldChoices = useMemo(() => tableFieldChoices(props.index, tt), [props.index, tt]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const previewsRef = useRef(new Map<string, number>());
  const widthCommitTokensRef = useRef(new Map<string, symbol>());
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const pendingFieldMaterializationsRef = useRef(new Map<string, PendingFieldMaterialization>());

  const effectiveActiveCell = nearestTableCell(rowIds, columnIds, activeCell);
  useEffect(() => {
    if (
      effectiveActiveCell?.rowId === activeCell?.rowId
      && effectiveActiveCell?.columnId === activeCell?.columnId
    ) return;
    setActiveCell(effectiveActiveCell);
  }, [activeCell, effectiveActiveCell]);
  const applyGridTemplate = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    grid.style.setProperty('--table-columns', tableGridTemplate(columnsRef.current, previewsRef.current));
    grid.style.setProperty('--table-min-width', `${tableGridMinWidth(columnsRef.current, previewsRef.current)}px`);
  }, []);
  useLayoutEffect(() => applyGridTemplate(), [applyGridTemplate, columns]);

  const focusCell = useCallback((cell: TableCellAddress) => {
    setActiveCell(cell);
    window.requestAnimationFrame(() => cellRefs.current.get(cellKey(cell))?.focus());
  }, []);

  const registerCell = useCallback((cell: TableCellAddress, element: HTMLElement | null) => {
    const key = cellKey(cell);
    if (element) cellRefs.current.set(key, element);
    else cellRefs.current.delete(key);
  }, []);

  const focusFieldValue = useCallback((entry: NodeProjection, seed?: string) => {
    const primaryValueId = outlinerChildren(entry, props.index.byId)[0];
    const target = primaryValueId
      ? rowFocusTarget(primaryValueId, entry.id, props.panelId)
      : focusTarget(entry.id, entry.id, props.panelId, 'trailing');
    props.setUi((previous) => seed
      ? requestPendingInputState(previous, target, seed, cursorEnd())
      : requestFocusState(previous, target, cursorEnd()));
  }, [props.index.byId, props.panelId, props.setUi]);

  const beginFieldEdit = useCallback(async (rowId: NodeId, column: ViewDisplayField, seed?: string) => {
    const rowNode = props.index.byId.get(rowId);
    if (!rowNode) return;
    const ownerId = outlinerChildParentId(rowId, props.index.byId) ?? rowId;
    const owner = props.index.byId.get(ownerId);
    if (!owner || owner.locked) return;
    const address = { rowId, columnId: column.id };
    setActiveCell(address);

    if (isSystemFieldId(column.field)) {
      if (column.field === DONE_FIELD) void props.run(() => api.toggleDone(ownerId));
      return;
    }

    const field = props.index.byId.get(column.field);
    if (field?.type !== 'fieldDef') return;
    const existing = fieldEntryForViewCell(rowNode, column.field, props.index.byId);
    if (existing) {
      focusFieldValue(existing, seed);
      return;
    }

    const materializationKey = cellKey(address);
    const existingMaterialization = pendingFieldMaterializationsRef.current.get(materializationKey);
    if (existingMaterialization) {
      if (seed) existingMaterialization.input += seed;
      return;
    }
    const materialization: PendingFieldMaterialization = { input: seed ?? '' };
    pendingFieldMaterializationsRef.current.set(materializationKey, materialization);

    let createdEntryId: NodeId | undefined;
    try {
      await props.run(async () => {
        const outcome = await api.createInlineField(ownerId, null, '', 'plain', column.field);
        createdEntryId = outcome.focus?.nodeId;
        return outcome;
      }, {
        applyFocus: false,
        beforeApply: () => {
          if (!createdEntryId) return;
          const target = focusTarget(createdEntryId, createdEntryId, props.panelId, 'trailing');
          props.setUi((previous) => materialization.input
            ? requestPendingInputState(previous, target, materialization.input, cursorEnd())
            : requestFocusState(previous, target, cursorEnd()));
        },
      });
    } finally {
      if (pendingFieldMaterializationsRef.current.get(materializationKey) === materialization) {
        pendingFieldMaterializationsRef.current.delete(materializationKey);
      }
    }
  }, [focusFieldValue, props.index.byId, props.panelId, props.run, props.setUi]);

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposingEvent(event)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cellElement = target.closest<HTMLElement>('[data-table-cell]');
    if (!cellElement) return;
    const rowId = cellElement.dataset.tableRowId;
    const columnId = cellElement.dataset.tableColumnId;
    if (!rowId || !columnId) return;
    const current = { rowId, columnId };
    if (target !== cellElement) {
      if (event.key === 'Escape') {
        window.requestAnimationFrame(() => {
          const cell = cellRefs.current.get(cellKey(current));
          const focused = document.activeElement;
          if (cell && focused instanceof Node && cell.contains(focused) && focused !== cell) return;
          cell?.focus();
        });
      }
      return;
    }
    if (
      event.key === 'ArrowUp'
      || event.key === 'ArrowDown'
      || event.key === 'ArrowLeft'
      || event.key === 'ArrowRight'
      || event.key === 'Home'
      || event.key === 'End'
      || event.key === 'Tab'
    ) {
      const next = resolveTableCellNavigation({
        rows: rowIds,
        columns: columnIds,
        current,
        key: event.key as TableNavigationKey,
        shiftKey: event.shiftKey,
        primaryModifier: event.metaKey || event.ctrlKey,
      });
      if (!next) return;
      event.preventDefault();
      focusCell(next);
      return;
    }
    const row = renderRows.find((candidate) => candidate.kind === 'data' && candidate.id === rowId);
    if (!row || row.kind !== 'data') return;
    const titleTarget = row.draft
      ? focusTarget(props.parentId, props.parentId, props.panelId, 'trailing')
      : rowFocusTarget(row.id, props.parentId, props.panelId);
    if (event.key === 'Enter') {
      event.preventDefault();
      if (columnId === TABLE_TITLE_COLUMN_ID) {
        props.setUi((previous) => requestFocusState(
          previous,
          titleTarget,
          cursorEnd(),
        ));
      } else {
        const column = columns.find((candidate) => candidate.id === columnId);
        if (column) void beginFieldEdit(row.id, column);
      }
      return;
    }
    if (
      event.key.length === 1
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
    ) {
      event.preventDefault();
      if (columnId === TABLE_TITLE_COLUMN_ID) {
        props.setUi((previous) => requestPendingInputState(
          previous,
          titleTarget,
          event.key,
          cursorEnd(),
        ));
        return;
      }
      const column = columns.find((candidate) => candidate.id === columnId);
      if (!column) return;
      void beginFieldEdit(row.id, column, event.key);
    }
  };

  const updatePreviewWidth = useCallback((columnId: string, width: number) => {
    widthCommitTokensRef.current.delete(columnId);
    previewsRef.current.set(columnId, clampColumnWidth(width));
    applyGridTemplate();
  }, [applyGridTemplate]);
  const commitWidth = useCallback((column: ViewDisplayField, width: number | null) => {
    const token = Symbol(column.id);
    widthCommitTokensRef.current.set(column.id, token);
    if (width === null) previewsRef.current.delete(column.id);
    else previewsRef.current.set(column.id, clampColumnWidth(width));
    applyGridTemplate();
    void props.run(() => api.updateDisplayField(column.id, { width })).finally(() => {
      if (widthCommitTokensRef.current.get(column.id) !== token) return;
      widthCommitTokensRef.current.delete(column.id);
      previewsRef.current.delete(column.id);
      applyGridTemplate();
    });
  }, [applyGridTemplate, props.run]);

  const [searchRefreshing, setSearchRefreshing] = useState(false);
  useEffect(() => {
    if (parent?.type !== 'search') {
      setSearchRefreshing(false);
      return undefined;
    }
    let active = true;
    setSearchRefreshing(true);
    void api.refreshSearchNodeResults(props.parentId)
      .catch((error) => {
        console.error('Failed to refresh live search results', error);
      })
      .finally(() => { if (active) setSearchRefreshing(false); });
    return () => { active = false; };
  }, [parent?.type, props.index.projection, props.parentId]);

  const measuredRef = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const measureRow = useCallback((key: string, height: number) => {
    const current = measuredRef.current.get(key);
    if (current !== undefined && Math.abs(current - height) < 1) return;
    measuredRef.current.set(key, height);
    setMeasureVersion((version) => version + 1);
  }, []);
  const layout = useMemo(
    () => buildTableLayout(renderRows, measuredRef.current),
    [measureVersion, renderRows],
  );
  const virtualize = renderRows.length > TABLE_VIRTUALIZE_MIN_ROWS;
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, height: 0 });
  const resolveScroller = useCallback(() => {
    if (scrollerRef.current) return scrollerRef.current;
    scrollerRef.current = nearestScrollContainer(bodyRef.current, props.scrollParentRef?.current);
    return scrollerRef.current;
  }, [props.scrollParentRef]);
  const updateScrollMetrics = useCallback(() => {
    const scroller = resolveScroller();
    const body = bodyRef.current;
    if (!scroller || !body) return;
    const next = {
      top: scroller.getBoundingClientRect().top - body.getBoundingClientRect().top,
      height: scroller.clientHeight,
    };
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
    const scroller = resolveScroller();
    updateScrollMetrics();
    const onScroll = () => scheduleScrollMetrics();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const observer = scroller && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateScrollMetrics)
      : null;
    if (scroller && observer) observer.observe(scroller);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      observer?.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [resolveScroller, scheduleScrollMetrics, updateScrollMetrics, virtualize]);

  const previousLayoutRef = useRef<TableLayout | null>(null);
  const previousRowsRef = useRef<readonly TableRenderRow[]>(renderRows);
  useLayoutEffect(() => {
    const previousLayout = previousLayoutRef.current;
    const previousRows = previousRowsRef.current;
    previousLayoutRef.current = layout;
    previousRowsRef.current = renderRows;
    if (!virtualize || !previousLayout || previousRows !== renderRows) return;
    if (previousLayout.items.length !== layout.items.length) return;
    const scroller = resolveScroller();
    const body = bodyRef.current;
    if (!scroller || !body) return;
    const anchorY = scroller.getBoundingClientRect().top - body.getBoundingClientRect().top;
    if (anchorY <= 0) return;
    const index = firstRowEndingAfter(previousLayout.items, anchorY);
    if (index >= layout.items.length) return;
    const delta = layout.items[index]!.top - previousLayout.items[index]!.top;
    if (delta !== 0) scroller.scrollTop += delta;
  }, [layout, renderRows, resolveScroller, virtualize]);

  const forcedIndices = useMemo(() => {
    if (!virtualize) return [];
    const targets = new Set<NodeId>();
    if (activeCell) targets.add(activeCell.rowId);
    if (props.ui.focusedPanelId === props.panelId && props.ui.focusedId) targets.add(props.ui.focusedId);
    const indices: number[] = [];
    renderRows.forEach((row, index) => {
      if (row.kind === 'data' && (row.draft || targets.has(row.id))) indices.push(index);
    });
    return indices;
  }, [activeCell, props.panelId, props.ui.focusedId, props.ui.focusedPanelId, renderRows, virtualize]);
  const renderIndices = useMemo(() => {
    if (!virtualize) return null;
    const range = visibleTableRange(layout, scrollMetrics.top, scrollMetrics.height);
    const indices = new Set(forcedIndices);
    for (let index = range.start; index < range.end; index += 1) indices.add(index);
    return [...indices].sort((left, right) => left - right);
  }, [forcedIndices, layout, scrollMetrics.height, scrollMetrics.top, virtualize]);

  const renderDataRow = (row: Extract<TableRenderRow, { kind: 'data' }>, rowIndex: number) => {
    const rowNode = props.index.byId.get(row.id);
    const nextStoredRow = renderRows.slice(rowIndex + 1).find((candidate) => candidate.kind === 'data' && !candidate.draft);
    const selected = !row.draft && isTableRecordSelected(row.id, props.ui);
    const titleAddress = { rowId: row.id, columnId: TABLE_TITLE_COLUMN_ID };
    const activeTitle = effectiveActiveCell?.rowId === row.id
      && effectiveActiveCell.columnId === TABLE_TITLE_COLUMN_ID;
    const ownerId = rowNode ? outlinerChildParentId(row.id, props.index.byId) ?? row.id : row.id;
    const childParent = props.index.byId.get(ownerId);
    const childReferencePath = [...referencePath, ownerId];
    const referenceCycle = referencePath.includes(ownerId) && ownerId !== row.id;
    const expanded = !row.draft && props.ui.expanded.has(row.id) && !referenceCycle;
    const nestedRows = expanded && childParent
      ? buildOutlinerRows(childParent, props.index.byId, {
        expandedHiddenFields: props.ui.expandedHiddenFields,
        suppressedFieldDefIds: displayedFieldDefIds,
      })
      : [];
    const nestedView = childParent ? readViewConfig(childParent, props.index.byId) : null;
    const nestedIsTable = nestedView?.viewMode === 'table';
    const focusedId = props.ui.focusedId;
    const nestedDraftFocused = Boolean(childParent) && props.ui.focusedPanelId === props.panelId && (
      (focusedId === ownerId && props.ui.focusSurface === 'trailing')
      || (
        props.ui.focusedParentId === ownerId
        && focusedId !== null
        && !props.index.byId.has(focusedId)
      )
    );
    const showNested = expanded && Boolean(childParent) && (
      nestedRows.length > 0
      || nestedView?.viewMode === 'table'
      || nestedView?.toolbarVisible
      || nestedDraftFocused
    );
    return (
      <div className={`outliner-table-record ${row.filtered ? 'is-filtered' : ''}`} role="presentation">
        <div
          aria-selected={selected}
          className={`outliner-table-row${selected ? ' is-selected' : ''}`}
          role="row"
          aria-rowindex={rowIndex + 2}
        >
          <div
            aria-colindex={1}
            className={`outliner-table-title-cell ${activeTitle ? 'is-active' : ''}`}
            data-table-cell
            data-table-column-id={TABLE_TITLE_COLUMN_ID}
            data-table-row-id={row.id}
            onFocus={() => setActiveCell(titleAddress)}
            ref={(element) => registerCell(titleAddress, element)}
            role="gridcell"
            tabIndex={activeTitle ? 0 : -1}
          >
            <OutlinerItem
              panelId={props.panelId}
              nodeId={row.id}
              parentId={props.parentId}
              rootId={props.rootId}
              selectionRootId={selectionRootId}
              onRoot={props.onRoot}
              depth={0}
              index={props.index}
              isNodePinned={props.isNodePinned}
              ui={props.ui}
              uiRef={props.uiRef}
              setUi={props.setUi}
              run={props.run}
              onTogglePin={props.onTogglePin}
              trigger={props.trigger}
              setTrigger={props.setTrigger}
              dragId={props.dragId}
              setDragId={props.setDragId}
              referencePath={referencePath}
              draft={row.draft}
              draftAfterId={row.draft ? row.afterId ?? null : undefined}
              draftPlaceholder={row.draft ? props.draftPlaceholder : undefined}
              flat
              semanticRole="presentation"
              hideDisplayFields
              suppressedChildFieldDefIds={displayedFieldDefIds}
              tableNextRowId={nextStoredRow?.kind === 'data' ? nextStoredRow.id : null}
            />
          </div>
          {columns.map((column, columnIndex) => {
            const address = { rowId: row.id, columnId: column.id };
            return (
              <TableFieldCell
                key={column.id}
                active={effectiveActiveCell?.rowId === row.id && effectiveActiveCell.columnId === column.id}
                address={address}
                column={column}
                dragId={props.dragId}
                label={columnLabels.get(column.id) ?? column.field}
                index={props.index}
                isNodePinned={props.isNodePinned}
                onBeginEdit={(seed) => void beginFieldEdit(row.id, column, seed)}
                onFocus={() => setActiveCell(address)}
                onRoot={props.onRoot}
                onTogglePin={props.onTogglePin}
                panelId={props.panelId}
                referenceSummary={referenceSummary}
                register={registerCell}
                rowNode={rowNode}
                run={props.run}
                selectionRootId={selectionRootId}
                setDragId={props.setDragId}
                setTrigger={props.setTrigger}
                setUi={props.setUi}
                tabIndex={effectiveActiveCell?.rowId === row.id && effectiveActiveCell.columnId === column.id ? 0 : -1}
                trigger={props.trigger}
                ui={props.ui}
                uiRef={props.uiRef}
                ariaColIndex={columnIndex + 2}
              />
            );
          })}
          <div className="outliner-table-row-actions" role="presentation" />
        </div>
        {showNested && childParent ? (
          <div
            aria-label={nestedIsTable ? undefined : childParent.content.text.trim() || t.common.untitled}
            aria-multiselectable={nestedIsTable ? undefined : 'true'}
            className="outliner-table-nested"
            role={nestedIsTable ? 'presentation' : 'tree'}
          >
            <OutlinerView
              panelId={props.panelId}
              parentId={ownerId}
              rootId={props.rootId}
              selectionRootId={selectionRootId}
              onRoot={props.onRoot}
              depth={0}
              index={props.index}
              isNodePinned={props.isNodePinned}
              ui={props.ui}
              uiRef={props.uiRef}
              setUi={props.setUi}
              run={props.run}
              onTogglePin={props.onTogglePin}
              trigger={props.trigger}
              setTrigger={props.setTrigger}
              dragId={props.dragId}
              setDragId={props.setDragId}
              referencePath={childReferencePath}
              rows={nestedRows}
              suppressedFieldDefIds={displayedFieldDefIds}
              trailingDraft="auto"
            />
          </div>
        ) : null}
      </div>
    );
  };

  const renderTableRow = (row: TableRenderRow, index: number) => {
    if (row.kind === 'data') return renderDataRow(row, index);
    return (
      <div className="outliner-table-filtered-row" role="row" aria-rowindex={index + 2}>
        <div className="outliner-table-filtered-cell" role="gridcell" aria-colindex={1}>
          <FilteredOutHeading
            count={row.count}
            expanded={row.expanded}
            onToggle={() => props.setUi((previous) => {
              const expanded = new Set(previous.expanded);
              if (expanded.has(row.id)) expanded.delete(row.id);
              else expanded.add(row.id);
              return { ...previous, expanded };
            })}
          />
        </div>
      </div>
    );
  };

  if (!parent) return null;
  const gridStyle = {
    '--table-columns': tableGridTemplate(columns, previewsRef.current),
    '--table-min-width': `${tableGridMinWidth(columns, previewsRef.current)}px`,
  } as CSSProperties;

  return (
    <div className="outliner-table-scope" data-table-owner-id={props.parentId} ref={gridRef} style={gridStyle}>
      {props.showViewToolbar !== false && view.toolbarVisible ? (
        <ViewToolbar
          node={parent}
          view={view}
          index={props.index}
          run={props.run}
          dropdownRequest={props.ui.toolbarDropdownRequest}
          onDropdownRequestConsumed={(request) => props.setUi((previous) => (
            previous.toolbarDropdownRequest === request
              ? { ...previous, toolbarDropdownRequest: null }
              : previous
          ))}
        />
      ) : null}
      {ownerRows.length > 0 ? (
        <div className="outliner-table-owner-fields" role="tree" aria-label={t.outliner.treeAriaLabel}>
          <RowHost
            rows={ownerRows}
            renderField={(row, index, rows) => (
              <OutlinerFieldRow
                panelId={props.panelId}
                entryId={row.id}
                parentId={props.parentId}
                rootId={props.rootId}
                selectionRootId={selectionRootId}
                onRoot={props.onRoot}
                depth={props.depth}
                index={props.index}
                isNodePinned={props.isNodePinned}
                ui={props.ui}
                uiRef={props.uiRef}
                setUi={props.setUi}
                run={props.run}
                onTogglePin={props.onTogglePin}
                trigger={props.trigger}
                setTrigger={props.setTrigger}
                dragId={props.dragId}
                setDragId={props.setDragId}
                isFirstInFieldGroup={rows[index - 1]?.type !== 'field'}
                isLastInFieldGroup={rows[index + 1]?.type !== 'field'}
              />
            )}
            renderContent={() => null}
            renderHiddenField={(row) => (
              <HiddenFieldReveal
                label={row.label}
                onReveal={() => props.setUi((previous) => {
                  const expandedHiddenFields = new Set(previous.expandedHiddenFields);
                  expandedHiddenFields.add(hiddenFieldKey(props.parentId, row.fieldId));
                  return { ...previous, expandedHiddenFields };
                })}
              />
            )}
          />
        </div>
      ) : null}
      <OutlinerEmptyState
        childCount={realContentCount}
        parent={parent}
        parentId={props.parentId}
        projection={props.index.projection}
        rootLevel={props.parentId === props.rootId}
        searchLoading={searchRefreshing}
      />
      <div
        aria-colcount={columnIds.length}
        aria-label={tt.ariaLabel({ title: parent.content.text || t.common.untitled })}
        aria-multiselectable="true"
        aria-rowcount={renderRows.length + 1}
        className="outliner-table-scroll"
        onKeyDown={onGridKeyDown}
        role="grid"
      >
        <div className="outliner-table-header" role="row" aria-rowindex={1}>
          <div className="outliner-table-title-header" role="columnheader" aria-colindex={1}>{tt.title}</div>
          {columns.map((column, index) => {
            const fieldNode = props.index.byId.get(column.field);
            return (
              <TableColumnHeader
                key={column.id}
                column={column}
                fieldIcon={<FieldKindIcon byId={props.index.byId} fieldId={column.field} />}
                index={index}
                isFirst={index === 0}
                isLast={index === columns.length - 1}
                label={columnLabels.get(column.id) ?? column.field}
                onCommitWidth={(width) => commitWidth(column, width)}
                onOpenField={fieldNode?.type === 'fieldDef' ? () => props.onRoot(fieldNode.id) : undefined}
                onPreviewWidth={(width) => updatePreviewWidth(column.id, width)}
                run={props.run}
              />
            );
          })}
          <TableAddColumn
            choices={fieldChoices}
            displayFields={view.displayFields}
            nodeId={props.parentId}
            run={props.run}
          />
        </div>
        <div
          className={virtualize ? 'outliner-table-body is-windowed' : 'outliner-table-body'}
          ref={bodyRef}
          role="presentation"
          style={virtualize ? { height: layout.totalHeight } : undefined}
        >
          {(renderIndices ?? renderRows.map((_, index) => index)).map((index) => {
            const row = renderRows[index]!;
            return (
              <MeasuredTableRow
                key={row.key}
                onMeasure={measureRow}
                rowKey={row.key}
                top={virtualize ? layout.items[index]!.top : undefined}
              >
                {renderTableRow(row, index)}
              </MeasuredTableRow>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface TableFieldCellProps {
  active: boolean;
  address: TableCellAddress;
  ariaColIndex: number;
  column: ViewDisplayField;
  dragId: NodeId | null;
  label: string;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  onBeginEdit: (seed?: string) => void;
  onFocus: () => void;
  onRoot: OutlinerTableViewProps['onRoot'];
  onTogglePin: OutlinerTableViewProps['onTogglePin'];
  panelId: string;
  referenceSummary: ReturnType<typeof referenceSummaryForIndex>;
  register: (address: TableCellAddress, element: HTMLElement | null) => void;
  rowNode: NodeProjection | undefined;
  run: CommandRunner;
  selectionRootId: NodeId;
  setDragId: OutlinerTableViewProps['setDragId'];
  setTrigger: OutlinerTableViewProps['setTrigger'];
  setUi: OutlinerTableViewProps['setUi'];
  tabIndex: number;
  trigger: TriggerState;
  ui: UiState;
  uiRef: MutableRefObject<UiState>;
}

function TableFieldCell(props: TableFieldCellProps) {
  const tt = useT().outliner.table;
  const ownerId = props.rowNode
    ? outlinerChildParentId(props.rowNode.id, props.index.byId) ?? props.rowNode.id
    : null;
  const owner = ownerId ? props.index.byId.get(ownerId) : undefined;
  const entry = props.rowNode
    ? fieldEntryForViewCell(props.rowNode, props.column.field, props.index.byId)
    : undefined;
  const field = props.index.byId.get(props.column.field);
  const hasNodeValue = Boolean(entry && field?.type === 'fieldDef');
  const valueTexts = owner
    ? viewFieldValuesFor(owner, props.column.field, props.index.byId, { referenceSummary: props.referenceSummary })
    : [];
  const valueText = valueTexts.join(', ');

  const setElement = useCallback((element: HTMLDivElement | null) => {
    props.register({ rowId: props.address.rowId, columnId: props.address.columnId }, element);
  }, [props.address.columnId, props.address.rowId, props.register]);

  let content: ReactNode = null;
  if (owner && isSystemFieldId(props.column.field)) {
    const display = systemFieldDisplay(owner, props.column.field, props.index.byId, {
      referenceSummary: props.referenceSummary,
    });
    content = display.kind === 'nodeRefs' || display.kind === 'dayRef'
      ? valueText
      : (
        <SystemFieldValue
          display={display}
          byId={props.index.byId}
          onRoot={props.onRoot}
          onToggleDone={display.kind === 'done' && !owner.locked
            ? () => void props.run(() => api.toggleDone(owner.id))
            : undefined}
        />
      );
  } else if (entry && field?.type === 'fieldDef') {
    const fieldType = projectFieldTypeById(props.index.byId, field.id);
    const placeholder = fieldType === 'options' || fieldType === 'options_from_supertag'
      ? tt.selectOption
      : tt.emptyCell;
    content = (
      <FieldValueOutliner
        panelId={props.panelId}
        entryId={entry.id}
        selectionRootId={props.selectionRootId}
        onRoot={props.onRoot}
        index={props.index}
        isNodePinned={props.isNodePinned}
        ui={props.ui}
        uiRef={props.uiRef}
        setUi={props.setUi}
        run={props.run}
        onTogglePin={props.onTogglePin}
        trigger={props.trigger}
        setTrigger={props.setTrigger}
        dragId={props.dragId}
        setDragId={props.setDragId}
        optionField={field}
        placeholder={placeholder}
        embeddedInGridCell
      />
    );
  }

  return (
    <div
      aria-colindex={props.ariaColIndex}
      aria-label={valueText ? `${props.label}: ${valueText}` : props.label}
      className={`outliner-table-cell ${props.active ? 'is-active' : ''} ${hasNodeValue ? 'has-node-value' : ''}`}
      data-table-cell
      data-table-column-id={props.address.columnId}
      data-table-row-id={props.address.rowId}
      onDoubleClick={() => {
        if (!isSystemFieldId(props.column.field) && !hasNodeValue) props.onBeginEdit();
      }}
      onFocus={props.onFocus}
      ref={setElement}
      role="gridcell"
      tabIndex={props.tabIndex}
    >
      {content || (
        <span className="outliner-table-empty-cell" aria-hidden="true">
          <span className="row-leading outliner-table-empty-leading">
            <span className="row-bullet-button inert">
              <RowMarker className="dimmed" expanded={false} hasChildren={false} variant="content" />
            </span>
          </span>
        </span>
      )}
    </div>
  );
}

function TableColumnHeader({
  column,
  fieldIcon,
  index,
  isFirst,
  isLast,
  label,
  onCommitWidth,
  onOpenField,
  onPreviewWidth,
  run,
}: {
  column: ViewDisplayField;
  fieldIcon: ReactNode;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  label: string;
  onCommitWidth: (width: number | null) => void;
  onOpenField?: () => void;
  onPreviewWidth: (width: number) => void;
  run: CommandRunner;
}) {
  const t = useT();
  const tt = t.outliner.table;
  const openFieldLabel = `${t.outliner.field.openField}: ${label}`;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const cancelRenameRef = useRef(false);
  const renameCommitStartedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(label);
  const closeMenu = useCallback(() => {
    setOpen(false);
    setRenaming(false);
  }, []);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: buttonRef,
    disabled: !open,
    placement: 'bottom-start',
    width: 220,
  });
  useDismissibleOverlay(menuRef, closeMenu, { disabled: !open });
  const { onKeyDown: onMenuKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: closeMenu,
    kind: renaming ? 'dialog' : 'menu',
    active: open,
    getRestoreTarget: () => buttonRef.current,
    focusKey: renaming ? 'rename' : 'menu',
  });

  const commitRename = () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    if (renameCommitStartedRef.current) return;
    renameCommitStartedRef.current = true;
    void run(() => api.updateDisplayField(column.id, { label: renameDraft.trim() || null }));
    closeMenu();
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = clampColumnWidth(column.width);
    let currentWidth = startWidth;
    const onMove = (moveEvent: PointerEvent) => {
      currentWidth = clampColumnWidth(startWidth + moveEvent.clientX - startX);
      onPreviewWidth(currentWidth);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onCommitWidth(currentWidth);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  return (
    <div className="outliner-table-column-header" role="columnheader" aria-colindex={index + 2}>
      {onOpenField ? (
        <ButtonControl
          aria-label={openFieldLabel}
          className="outliner-table-column-kind"
          onClick={onOpenField}
          title={openFieldLabel}
        >
          {fieldIcon}
        </ButtonControl>
      ) : (
        <span className="outliner-table-column-kind" aria-hidden="true">{fieldIcon}</span>
      )}
      <span className="outliner-table-column-label">{label}</span>
      <ButtonControl
        aria-label={tt.columnMenu({ label })}
        aria-expanded={open}
        className="outliner-table-column-menu-button"
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          cancelRenameRef.current = false;
          renameCommitStartedRef.current = false;
          setRenameDraft(label);
          setOpen(true);
        }}
        ref={buttonRef}
      >
        <MoreIcon size={ICON_SIZE.menu} />
      </ButtonControl>
      <div
        aria-label={tt.resizeColumn({ label })}
        aria-valuemax={TABLE_COLUMN_MAX_WIDTH}
        aria-valuemin={TABLE_COLUMN_MIN_WIDTH}
        aria-valuenow={clampColumnWidth(column.width)}
        className="outliner-table-column-resize"
        onDoubleClick={() => onCommitWidth(null)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const delta = event.key === 'ArrowLeft' ? -16 : 16;
          onCommitWidth(clampColumnWidth(column.width) + delta);
        }}
        onPointerDown={beginResize}
        role="separator"
        tabIndex={0}
      />
      {open ? createPortal(
        <MenuSurface
          aria-label={tt.columnMenu({ label })}
          className="outliner-table-column-menu"
          onKeyDown={onMenuKeyDown}
          preserveSelection
          ref={menuRef}
          role={renaming ? 'dialog' : 'menu'}
          style={menuStyle}
        >
          {renaming ? (
            <Input
              autoFocus
              className="outliner-table-column-rename"
              label={tt.renameColumn}
              value={renameDraft}
              onBlur={commitRename}
              onChange={(event) => setRenameDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (isImeComposingEvent(event)) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename();
                }
                if (event.key === 'Escape') {
                  cancelRenameRef.current = true;
                  setRenameDraft(label);
                }
              }}
            />
          ) : (
            <>
              <MenuItem
                className="node-context-item"
                icon={<PencilIcon size={ICON_SIZE.menu} />}
                label={tt.renameColumn}
                onClick={() => {
                  cancelRenameRef.current = false;
                  renameCommitStartedRef.current = false;
                  setRenameDraft(label);
                  setRenaming(true);
                }}
                role="menuitem"
              />
              <MenuItem
                className="node-context-item"
                disabled={isFirst}
                icon={<ChevronLeftIcon size={ICON_SIZE.menu} />}
                label={tt.moveColumnLeft}
                onClick={() => {
                  void run(() => api.updateDisplayField(column.id, { move: 'left' }));
                  closeMenu();
                }}
                role="menuitem"
              />
              <MenuItem
                className="node-context-item"
                disabled={isLast}
                icon={<ChevronRightIcon size={ICON_SIZE.menu} />}
                label={tt.moveColumnRight}
                onClick={() => {
                  void run(() => api.updateDisplayField(column.id, { move: 'right' }));
                  closeMenu();
                }}
                role="menuitem"
              />
              <MenuItem
                className="node-context-item"
                icon={<HideIcon size={ICON_SIZE.menu} />}
                label={tt.hideColumn}
                onClick={() => {
                  void run(() => api.updateDisplayField(column.id, { visible: false }));
                  closeMenu();
                }}
                role="menuitem"
              />
              <MenuItem
                className="node-context-item is-danger"
                icon={<TrashIcon size={ICON_SIZE.menu} />}
                label={tt.removeColumn}
                onClick={() => {
                  void run(() => api.removeDisplayField(column.id));
                  closeMenu();
                }}
                role="menuitem"
              />
            </>
          )}
        </MenuSurface>,
        document.body,
      ) : null}
    </div>
  );
}

function TableAddColumn({
  choices,
  displayFields,
  nodeId,
  run,
}: {
  choices: Array<{ id: string; label: string }>;
  displayFields: readonly ViewDisplayField[];
  nodeId: NodeId;
  run: CommandRunner;
}) {
  const tt = useT().outliner.table;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [fieldType, setFieldType] = useState<FieldType>('plain');
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: buttonRef,
    disabled: !open,
    placement: 'bottom-end',
    width: 280,
    maxHeight: 420,
  });
  useDismissibleOverlay(menuRef, () => setOpen(false), { disabled: !open });
  const visibleFieldIds = useMemo(() => new Set(
    displayFields.filter((field) => field.visible).map((field) => field.field),
  ), [displayFields]);
  const normalized = query.trim().toLocaleLowerCase();
  const available = choices.filter((choice) => (
    !visibleFieldIds.has(choice.id)
    && (!normalized || choice.label.toLocaleLowerCase().includes(normalized))
  ));

  const createField = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(() => api.createDisplayField(nodeId, trimmed, fieldType));
    setName('');
    setCreating(false);
    setOpen(false);
  };

  return (
    <div className="outliner-table-add-column" role="presentation">
      <ButtonControl
        aria-label={tt.addColumn}
        aria-expanded={open}
        className="outliner-table-add-column-button"
        onClick={() => setOpen((current) => !current)}
        ref={buttonRef}
      >
        <AddIcon size={ICON_SIZE.menu} />
        <span>{tt.add}</span>
      </ButtonControl>
      {open ? createPortal(
        <MenuSurface
          aria-label={tt.addColumn}
          className="outliner-table-add-column-menu"
          preserveSelection
          ref={menuRef}
          role="dialog"
          style={menuStyle}
        >
          {creating ? (
            <div className="outliner-table-create-field">
              <Input
                autoFocus
                label={tt.fieldName}
                placeholder={tt.fieldName}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (isImeComposingEvent(event)) return;
                  if (event.key === 'Enter') createField();
                  if (event.key === 'Escape') setCreating(false);
                }}
              />
              <SelectControl
                label={tt.fieldType}
                value={fieldType}
                variant="boxed"
                onChange={(event) => setFieldType(event.currentTarget.value as FieldType)}
              >
                {FIELD_TYPE_OPTIONS.map((type) => (
                  <option key={type} value={type}>{tableFieldTypeLabel(type, tt)}</option>
                ))}
              </SelectControl>
              <div className="outliner-table-create-field-actions">
                <ButtonControl className="outliner-table-create-cancel" onClick={() => setCreating(false)}>
                  {tt.cancel}
                </ButtonControl>
                <ButtonControl className="outliner-table-create-confirm" disabled={!name.trim()} onClick={createField}>
                  {tt.createField}
                </ButtonControl>
              </div>
            </div>
          ) : (
            <>
              <Input
                autoFocus
                className="outliner-table-field-search"
                label={tt.searchFields}
                placeholder={tt.searchFields}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <div className="outliner-table-field-options">
                {available.map((choice) => (
                  <MenuItem
                    key={choice.id}
                    className="node-context-item"
                    icon={<FieldIcon size={ICON_SIZE.menu} />}
                    label={choice.label}
                    onClick={() => {
                      void run(() => api.addDisplayField(nodeId, choice.id));
                      setOpen(false);
                    }}
                  />
                ))}
                {available.length === 0 ? <div className="outliner-table-no-fields">{tt.noMatchingFields}</div> : null}
              </div>
              <MenuItem
                className="node-context-item outliner-table-new-field"
                icon={<AddIcon size={ICON_SIZE.menu} />}
                label={tt.newField}
                onClick={() => setCreating(true)}
              />
            </>
          )}
        </MenuSurface>,
        document.body,
      ) : null}
    </div>
  );
}
