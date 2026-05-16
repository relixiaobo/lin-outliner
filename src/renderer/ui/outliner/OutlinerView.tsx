import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import type { CommandRunner, TriggerState } from '../shared';
import { FieldEntryChildrenOutliner } from './FieldEntryChildrenOutliner';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { RowHost } from './RowHost';
import { buildOutlinerRows, hiddenFieldKey } from './row-model';
import { clearFocusRequestState, cursorEnd, requestFocusState, rowFocusTarget } from '../focus/focusModel';
import { ViewToolbar } from './ViewToolbar';
import { HiddenFieldReveal, ViewGroupHeading } from './OutlinerViewChrome';

interface OutlinerViewProps {
  panelId: string;
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
            panelId={props.panelId}
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
            dragId={props.dragId}
            setDragId={props.setDragId}
            renderChildren={(controls) => (
              <FieldEntryChildrenOutliner
                panelId={props.panelId}
                entryId={row.id}
                childIds={controls.childIds}
                index={props.index}
                expanded={props.ui.expanded}
                focusRequest={props.ui.focusRequest}
                onFocusRequestConsumed={(request) => {
                  props.setUi((prev) => clearFocusRequestState(prev, request));
                }}
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
                  const targetNode = props.index.byId.get(nodeId);
                  props.setUi((prev) => requestFocusState(
                    prev,
                    rowFocusTarget(nodeId, targetNode?.parentId ?? row.id, props.panelId),
                    cursorEnd(),
                  ));
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
                  panelId={props.panelId}
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
                  dragId={props.dragId}
                  setDragId={props.setDragId}
                />
              </FieldEntryChildrenOutliner>
            )}
          />
        )}
        renderContent={(row) => (
          <OutlinerItem
            panelId={props.panelId}
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
            dragId={props.dragId}
            setDragId={props.setDragId}
          />
        )}
      />
    </>
  );
}
