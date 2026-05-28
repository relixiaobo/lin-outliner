import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { freshNodeId } from '../../../core/nodeId';
import type { DocumentIndex, UiState } from '../../state/document';
import { buildVisualRows } from '../../state/visualRows';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { hiddenFieldKey, readViewConfig } from './row-model';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { ViewToolbar } from './ViewToolbar';
import { HiddenFieldReveal, ViewGroupHeading } from './OutlinerViewChrome';

// Flag-gated flat (pre-windowing) renderer. Reads localStorage once at module
// load so the choice is stable for the session (toggle then reload):
//   localStorage.setItem('lin:flat-outliner', '1')   // enable
//   localStorage.removeItem('lin:flat-outliner')      // back to recursive
function readFlatFlag(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('lin:flat-outliner') === '1';
  } catch {
    return false;
  }
}

export const FLAT_OUTLINER_ENABLED = readFlatFlag();

interface OutlinerFlatViewProps {
  panelId: string;
  parentId: NodeId;
  rootId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  showViewToolbar?: boolean;
  trailingDraft?: 'always' | 'auto' | 'none';
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

export function OutlinerFlatView(props: OutlinerFlatViewProps) {
  const { index, ui } = props;
  const byId = index.byId;
  const draftIdFor = useFlatDraftIds(byId);

  const trailingFocusedParentId = ui.focusSurface === 'trailing' && ui.focusedPanelId === props.panelId
    ? ui.focusedId
    : null;

  const rows = useMemo(
    () => buildVisualRows(props.parentId, byId, {
      expanded: ui.expanded,
      expandedHiddenFields: ui.expandedHiddenFields,
      showRootToolbar: props.showViewToolbar !== false,
      rootTrailingDraft: props.trailingDraft ?? 'none',
      draftIdFor,
      trailingFocusedParentId,
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
    ],
  );

  // Live-search refresh. A search node recomputes its results whenever they are
  // visible — when it is the panel root, or an expanded content row. Mirrors
  // OutlinerView's per-node effect, gathered across the whole flattened tree.
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
    for (const id of searchKey ? searchKey.split('|') : []) {
      void api.refreshSearchNodeResults(id).catch((error) => {
        console.error('Failed to refresh live search results', error);
      });
    }
  }, [searchKey, index.projection]);

  return (
    <>
      {rows.map((row) => {
        switch (row.kind) {
          case 'toolbar': {
            const node = byId.get(row.nodeId);
            if (!node) return null;
            return (
              <ViewToolbar
                key={row.key}
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
            return <ViewGroupHeading key={row.key} label={row.label} />;
          case 'hiddenField':
            return (
              <HiddenFieldReveal
                key={row.key}
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
                key={row.key}
                panelId={props.panelId}
                entryId={row.nodeId}
                parentId={row.parentId}
                rootId={props.rootId}
                onRoot={props.onRoot}
                depth={row.depth}
                index={index}
                ui={ui}
                setUi={props.setUi}
                run={props.run}
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
                key={row.key}
                panelId={props.panelId}
                nodeId={row.nodeId}
                parentId={row.parentId}
                rootId={props.rootId}
                onRoot={props.onRoot}
                depth={row.depth}
                index={index}
                ui={ui}
                setUi={props.setUi}
                run={props.run}
                trigger={props.trigger}
                setTrigger={props.setTrigger}
                dragId={props.dragId}
                setDragId={props.setDragId}
                referencePath={row.referencePath}
                draft={row.draft}
                flat
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}
