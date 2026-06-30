import type { NodeId, NodeProjection } from '../api/types';
import { buildOutlinerRows, readViewConfig, type OutlinerRowItem } from './outlinerRows';
import { outlinerChildParentId } from './document';
import type { TrailingDraftPlacement } from './document';
import { resolveTrailingDraftAfterId } from './trailingDraftPlacement';

// A single flattened, depth-aware outliner row. The recursive
// OutlinerView/OutlinerItem render is being replaced by one windowed flat list,
// so the whole visible tree is flattened into this ordered array up front.
// `buildVisualRows` is the pure producer; it reuses `buildOutlinerRows` per level
// (so grouping/sort/filter/hidden-field behaviour is identical) and descends
// into reference targets exactly like `flattenVisibleRows`, but keeps every row
// kind plus per-level toolbars and trailing drafts, and carries cumulative depth.
export type VisualRow =
  | { kind: 'toolbar'; key: string; nodeId: NodeId; depth: number; parentId: NodeId }
  | { kind: 'group'; key: string; label: string; depth: number; parentId: NodeId }
  | { kind: 'filteredOut'; key: string; id: string; count: number; depth: number; parentId: NodeId; expanded: boolean }
  | { kind: 'hiddenField'; key: string; fieldId: NodeId; label: string; depth: number; parentId: NodeId }
  | {
    kind: 'field';
    key: string;
    nodeId: NodeId;
    depth: number;
    parentId: NodeId;
    referencePath: NodeId[];
    isFirstInFieldGroup: boolean;
    isLastInFieldGroup: boolean;
  }
  | {
    kind: 'content';
    key: string;
    nodeId: NodeId;
    depth: number;
    parentId: NodeId;
    referencePath: NodeId[];
    draft?: boolean;
    afterId?: NodeId | null;
  };

export type TrailingDraftMode = 'always' | 'auto' | 'none';

export interface VisualRowsOptions {
  expanded: ReadonlySet<NodeId>;
  expandedHiddenFields?: Set<string>;
  // Depth assigned to the root's direct children (indentation = depth * step).
  rootDepth?: number;
  // The panel body shows a toolbar only when the root view opts in; nested levels
  // mirror OutlinerView's default (show whenever the view's toolbar is visible).
  showRootToolbar?: boolean;
  // Trailing-draft behaviour at the root level; nested levels use 'auto' (or
  // 'none' inside a reference cycle), matching OutlinerItem's nested OutlinerView.
  rootTrailingDraft?: TrailingDraftMode;
  // Stable per-parent draft id (renderer-minted, survives until materialization).
  // Returning null suppresses the draft for that parent.
  draftIdFor?: (parentId: NodeId) => NodeId | null;
  // Parent whose trailing surface currently holds keyboard focus (drives the
  // 'auto' trailing draft just like OutlinerView's `trailingFocused`).
  trailingFocusedParentId?: NodeId | null;
  // Parent whose renderer-only draft row currently holds settled row focus.
  draftFocusedParentId?: NodeId | null;
  trailingDraftPlacement?: TrailingDraftPlacement | null;
}

export function buildVisualRows(
  rootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  options: VisualRowsOptions,
): VisualRow[] {
  const out: VisualRow[] = [];
  const expanded = options.expanded;
  const expandedHiddenFields = options.expandedHiddenFields ?? new Set<string>();

  // referencePath: chain of resolved child-parent ids, used only for the
  // reference cycle guard (matches flattenVisibleRows). keyPath: chain of the
  // actual rendered row ids from the root, used for stable, unique React keys
  // (two sibling references to the same target resolve to the same parent but
  // have distinct row ids, so keys must key off the rows, not the targets).
  const visit = (
    parentId: NodeId,
    depth: number,
    referencePath: NodeId[],
    keyPath: NodeId[],
    trailingMode: TrailingDraftMode,
  ) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const prefix = keyPath.join('>');

    const isRoot = referencePath.length === 1;
    const view = readViewConfig(parent, byId);
    if (view.toolbarVisible && (!isRoot || options.showRootToolbar !== false)) {
      out.push({ kind: 'toolbar', key: `toolbar>${prefix}`, nodeId: parentId, depth, parentId });
    }

    const builtRows = buildOutlinerRows(parent, byId, { expandedHiddenFields });
    const showDraft = trailingMode === 'always'
      || (
        trailingMode === 'auto'
        && (
          builtRows.length === 0
          || options.trailingFocusedParentId === parentId
          || options.draftFocusedParentId === parentId
        )
      );
    const draftId = showDraft ? options.draftIdFor?.(parentId) ?? null : null;
    const placementAfterId = resolveTrailingDraftAfterId({
      placement: options.trailingDraftPlacement,
      parentId,
      rows: builtRows,
    });
    const pushDraft = () => {
      if (!draftId) return;
      // Key by the draft's own id (not its position), identical to the key the
      // row will have once the draft materializes into a real child under the
      // same id. This keeps the React component — and its editor — mounted
      // across materialization, so eager input is never interrupted.
      out.push({
        kind: 'content',
        key: `${prefix}>${draftId}`,
        nodeId: draftId,
        depth,
        parentId,
        referencePath,
        draft: true,
        afterId: placementAfterId,
      });
    };
    let draftInserted = false;
    const maybePushDraftAfter = (rowId: NodeId) => {
      if (!draftId || !placementAfterId || draftInserted || placementAfterId !== rowId) return;
      pushDraft();
      draftInserted = true;
    };

    const pushRows = (
      rows: OutlinerRowItem[],
      rowDepth: number,
      rowKeyPath: NodeId[],
    ) => {
      const rowPrefix = rowKeyPath.join('>');
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row.type === 'group') {
          out.push({ kind: 'group', key: `group>${rowPrefix}>${row.id}`, label: row.label, depth: rowDepth, parentId });
          continue;
        }
        if (row.type === 'filteredOut') {
          const expandedSection = expanded.has(row.id);
          out.push({
            kind: 'filteredOut',
            key: `filtered>${rowPrefix}>${row.id}`,
            id: row.id,
            count: row.count,
            depth: rowDepth,
            parentId,
            expanded: expandedSection,
          });
          if (expandedSection) pushRows(row.rows, rowDepth, [...rowKeyPath, row.id]);
          continue;
        }
        if (row.type === 'hiddenField') {
          out.push({
            kind: 'hiddenField',
            key: `hidden>${rowPrefix}>${row.id}`,
            fieldId: row.fieldId,
            label: row.label,
            depth: rowDepth,
            parentId,
          });
          continue;
        }
        if (row.type === 'field') {
          out.push({
            kind: 'field',
            key: `${rowPrefix}>${row.id}`,
            nodeId: row.id,
            depth: rowDepth,
            parentId,
            referencePath,
            isFirstInFieldGroup: rows[i - 1]?.type !== 'field',
            isLastInFieldGroup: rows[i + 1]?.type !== 'field',
          });
          if (expanded.has(row.id)) descend(row.id, rowDepth, referencePath, rowKeyPath);
          maybePushDraftAfter(row.id);
          continue;
        }
        out.push({
          kind: 'content',
          key: `${rowPrefix}>${row.id}`,
          nodeId: row.id,
          depth: rowDepth,
          parentId,
          referencePath,
        });
        if (expanded.has(row.id)) descend(row.id, rowDepth, referencePath, rowKeyPath);
        maybePushDraftAfter(row.id);
      }
    };

    pushRows(builtRows, depth, keyPath);

    if (draftId && !draftInserted) pushDraft();
  };

  const descend = (rowId: NodeId, depth: number, referencePath: NodeId[], keyPath: NodeId[]) => {
    const childParentId = outlinerChildParentId(rowId, byId);
    if (!childParentId || referencePath.includes(childParentId)) return;
    visit(childParentId, depth + 1, [...referencePath, childParentId], [...keyPath, rowId], 'auto');
  };

  visit(rootId, options.rootDepth ?? 0, [rootId], [rootId], options.rootTrailingDraft ?? 'none');
  return out;
}

// The content/field subsequence of the visual rows, in order. Body/reference rows
// stay parity-pinned to the legacy visible-row order; field value rows are rendered
// inside their field row and live in the selectable-row model instead.
export function visualRowNodeIds(rows: readonly VisualRow[]): NodeId[] {
  const ids: NodeId[] = [];
  for (const row of rows) {
    if ((row.kind === 'content' && !row.draft) || row.kind === 'field') ids.push(row.nodeId);
  }
  return ids;
}
