import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import type { CommandRunner, TriggerState } from '../shared';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { RowHost } from './RowHost';
import { buildOutlinerRows, hiddenFieldKey, type OutlinerRowItem } from './row-model';
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
  rows?: OutlinerRowItem[];
  showViewToolbar?: boolean;
}

export function OutlinerView(props: OutlinerViewProps) {
  const parent = props.index.byId.get(props.parentId);
  const rows = props.rows ?? buildOutlinerRows(parent, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  });

  useEffect(() => {
    if (parent?.type !== 'search') return;
    void api.refreshSearchNodeResults(props.parentId).catch((error) => {
      console.error('Failed to refresh live search results', error);
    });
  }, [parent?.type, props.parentId, props.index.projection]);

  return (
    <>
      {props.showViewToolbar !== false && parent?.toolbarVisible && (
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
        renderField={(row, index, rows) => (
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
            isFirstInFieldGroup={rows[index - 1]?.type !== 'field'}
            isLastInFieldGroup={rows[index + 1]?.type !== 'field'}
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
