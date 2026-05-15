import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { FocusHint, NodeId } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import type { CommandRunner, TriggerState } from '../shared';
import { FieldEntryChildrenOutliner } from './FieldEntryChildrenOutliner';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { RowHost } from './RowHost';
import { buildOutlinerRows, hiddenFieldKey } from './row-model';
import { focusRowInput } from '../shared';
import { ViewToolbar } from './ViewToolbar';
import { HiddenFieldReveal, ViewGroupHeading } from './OutlinerViewChrome';

interface OutlinerViewProps {
  parentId: NodeId;
  rootId: NodeId;
  onRoot: (nodeId: NodeId) => void;
  depth: number;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  pendingFocus: FocusHint | null;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
}

export function OutlinerView(props: OutlinerViewProps) {
  const parent = props.index.byId.get(props.parentId);
  const rows = buildOutlinerRows(parent, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  });

  return (
    <>
      {parent?.toolbarVisible && (
        <ViewToolbar node={parent} index={props.index} run={props.run} />
      )}
      <RowHost
        rows={rows}
        renderGroup={(row) => (
          <ViewGroupHeading label={row.label} />
        )}
        renderHiddenField={(row) => (
          <HiddenFieldReveal
            label={row.label}
            onReveal={() => {
              props.setUi((prev) => {
                const expandedHiddenFields = new Set(prev.expandedHiddenFields);
                expandedHiddenFields.add(hiddenFieldKey(props.parentId, row.fieldId));
                return { ...prev, expandedHiddenFields };
              });
            }}
          />
        )}
        renderField={(row) => (
          <OutlinerFieldRow
            entryId={row.id}
            parentId={props.parentId}
            rootId={props.rootId}
            onRoot={props.onRoot}
            depth={props.depth}
            index={props.index}
            ui={props.ui}
            setUi={props.setUi}
            run={props.run}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            pendingFocus={props.pendingFocus}
            dragId={props.dragId}
            setDragId={props.setDragId}
            renderChildren={(controls) => (
              <FieldEntryChildrenOutliner
                entryId={row.id}
                childIds={controls.childIds}
                index={props.index}
                expanded={props.ui.expanded}
                run={props.run}
                setTrigger={props.setTrigger}
                onExpand={(nodeId) => {
                  props.setUi((prev) => {
                    const expanded = new Set(prev.expanded);
                    expanded.add(nodeId);
                    return { ...prev, expanded };
                  });
                }}
                onNavigateUp={controls.focusLastVisibleChild}
                onCollapseToSelf={controls.collapseToSelf}
                onFocusNode={(nodeId) => {
                  props.setUi((prev) => ({
                    ...prev,
                    focusedId: nodeId,
                    selectedId: nodeId,
                    selectedIds: new Set([nodeId]),
                    selectionAnchorId: nodeId,
                  }));
                  focusRowInput(nodeId, 'end');
                }}
                onCollapseNode={(nodeId) => {
                  props.setUi((prev) => {
                    const expanded = new Set(prev.expanded);
                    expanded.delete(nodeId);
                    return { ...prev, expanded };
                  });
                }}
                onUndo={() => props.run(api.undo)}
                onRedo={() => props.run(api.redo)}
              >
                <OutlinerView
                  parentId={row.id}
                  rootId={props.rootId}
                  onRoot={props.onRoot}
                  depth={0}
                  index={props.index}
                  ui={props.ui}
                  setUi={props.setUi}
                  run={props.run}
                  trigger={props.trigger}
                  setTrigger={props.setTrigger}
                  pendingFocus={props.pendingFocus}
                  dragId={props.dragId}
                  setDragId={props.setDragId}
                />
              </FieldEntryChildrenOutliner>
            )}
          />
        )}
        renderContent={(row) => (
          <OutlinerItem
            nodeId={row.id}
            parentId={props.parentId}
            rootId={props.rootId}
            onRoot={props.onRoot}
            depth={props.depth}
            index={props.index}
            ui={props.ui}
            setUi={props.setUi}
            run={props.run}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            pendingFocus={props.pendingFocus}
            dragId={props.dragId}
            setDragId={props.setDragId}
          />
        )}
      />
    </>
  );
}
