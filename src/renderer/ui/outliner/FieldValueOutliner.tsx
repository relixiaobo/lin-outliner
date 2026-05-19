import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import type { DocumentIndex, FocusRequest, UiState } from '../../state/document';
import { clearFocusRequestState, cursorEnd, requestFocusState, rowFocusTarget } from '../focus/focusModel';
import type { CommandRunner, TriggerState } from '../shared';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { RowHost } from './RowHost';
import { buildOutlinerRows, shouldShowTrailingInput } from './row-model';
import { TrailingInput } from './TrailingInput';
import { createTrailingField, createTrailingTriggerNode } from './trailingTriggers';

interface FieldValueOutlinerProps {
  panelId: string;
  entryId: NodeId;
  onRoot: (nodeId: NodeId) => void;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  optionField?: NodeProjection;
  placeholder: string;
}

export function FieldValueOutliner(props: FieldValueOutlinerProps) {
  const entry = props.index.byId.get(props.entryId);
  const rows = buildOutlinerRows(entry, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  });
  const showTrailingInput = shouldShowTrailingInput(rows);
  const empty = rows.length === 0;

  return (
    <div
      className={`field-value-outliner field-value-node-preview ${empty ? 'empty' : ''}`}
      data-field-value
      aria-label={empty ? props.placeholder : 'Field value'}
    >
      <RowHost
        rows={rows}
        renderField={(row, index, rows) => (
          <OutlinerFieldRow
            panelId={props.panelId}
            entryId={row.id}
            parentId={props.entryId}
            rootId={props.entryId}
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
            isFirstInFieldGroup={rows[index - 1]?.type !== 'field'}
            isLastInFieldGroup={rows[index + 1]?.type !== 'field'}
          />
        )}
        renderContent={(row) => (
          <OutlinerItem
            panelId={props.panelId}
            nodeId={row.id}
            parentId={props.entryId}
            rootId={props.entryId}
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
        )}
      />
      {showTrailingInput && (
        <TrailingInput
          panelId={props.panelId}
          parentId={props.entryId}
          index={props.index}
          expanded={props.ui.expanded}
          focusRequest={props.ui.focusRequest}
          onFocusRequestConsumed={(request: FocusRequest) => {
            props.setUi((prev) => clearFocusRequestState(prev, request));
          }}
          placeholder={props.placeholder}
          onCreate={async (parentId, text) => {
            const result = await props.run(() => api.createNode(parentId, null, text));
            return result && 'focus' in result ? result.focus?.nodeId ?? null : null;
          }}
          onCreateTree={(parentId, nodes) => (
            props.run(() => api.createNodesFromTree(parentId, nodes))
          )}
          onUpdateCreated={async (nodeId, text) => {
            await props.run(() => api.replaceNodeText(nodeId, plainText(text)));
          }}
          onToggleCreated={async (nodeId) => {
            await props.run(() => api.toggleDone(nodeId));
          }}
          onCreateTrigger={(params) => {
            return createTrailingTriggerNode({
              getText: params.getText,
              parentId: params.parentId,
              text: params.text,
              trigger: params.trigger,
              run: props.run,
              setTrigger: props.setTrigger,
            });
          }}
          onCreateField={(parentId) => {
            void createTrailingField({
              parentId,
              run: props.run,
            });
          }}
          onExpand={(nodeId) => {
            props.setUi((prev) => {
              const expanded = new Set(prev.expanded);
              expanded.add(nodeId);
              return { ...prev, expanded };
            });
          }}
          onFocusNode={(nodeId) => {
            const targetNode = props.index.byId.get(nodeId);
            props.setUi((prev) => requestFocusState(
              prev,
              rowFocusTarget(nodeId, targetNode?.parentId ?? props.entryId, props.panelId),
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
          onUndo={() => void props.run(() => api.undo())}
          onRedo={() => void props.run(() => api.redo())}
          optionField={props.optionField}
          onSelectOption={(optionId) => (
            props.run(() => api.selectFieldOption(props.entryId, optionId))
          )}
          onCreateOption={(name) => (
            props.run(async () => {
              if (!props.optionField) return api.getProjection();
              const outcome = await api.registerCollectedOption(props.optionField.id, name);
              const optionId = outcome.focus?.nodeId;
              if (!optionId) return outcome;
              return api.selectFieldOption(props.entryId, optionId);
            })
          )}
        />
      )}
    </div>
  );
}
