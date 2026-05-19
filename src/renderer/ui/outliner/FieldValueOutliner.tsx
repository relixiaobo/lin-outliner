import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import type { DocumentIndex, FocusRequest, UiState } from '../../state/document';
import { clearFocusRequestState, cursorEnd, requestFocusState, rowFocusTarget } from '../focus/focusModel';
import { fieldTypeInteraction, isOptionsFieldType } from '../fields/fieldTypeRegistry';
import type { CommandRunner, TriggerState } from '../shared';
import { FieldOptionPicker } from './FieldOptionPicker';
import { OutlinerFieldRow } from './OutlinerFieldRow';
import { OutlinerItem } from './OutlinerItem';
import { RowHost } from './RowHost';
import { buildOutlinerRows, shouldShowTrailingInput } from './row-model';
import { TrailingInput } from './TrailingInput';
import {
  applyTrailingReferenceTrigger,
  applyTrailingTagTrigger,
  createAndApplyTrailingTagTrigger,
  createTrailingField,
  executeTrailingSlashTrigger,
} from './trailingTriggers';
import { TypedFieldValueControl } from './TypedFieldValueControl';

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
  const showTrailingInput = shouldShowTrailingInput(rows, { mode: 'fieldValue' });
  const empty = rows.length === 0;
  const singleValueNode = rows.length === 1 ? props.index.byId.get(rows[0].id) : undefined;
  const singleValueField = props.optionField?.cardinality !== 'list';
  const valueInteraction = fieldTypeInteraction(props.optionField?.fieldType);
  const canUseOptionPicker = Boolean(
    props.optionField
    && singleValueField
    && isOptionsFieldType(props.optionField.fieldType)
    && rows.length <= 1,
  );
  const canUseTypedControl = Boolean(
    props.optionField
    && singleValueField
    && rows.length <= 1
    && valueInteraction !== 'outliner'
    && valueInteraction !== 'optionPicker'
    && valueInteraction !== 'reserved',
  );

  return (
    <div
      className={`field-value-outliner field-value-node-preview ${empty ? 'empty' : ''}`}
      data-field-value
      aria-label={empty ? props.placeholder : 'Field value'}
    >
      {canUseOptionPicker && props.optionField ? (
        <FieldOptionPicker
          byId={props.index.byId}
          field={props.optionField}
          valueNode={singleValueNode}
          placeholder={props.placeholder}
          onSelectOption={(optionId) => (
            props.run(() => api.selectFieldOption(props.entryId, optionId))
          )}
          onCreateOption={(name) => (
            props.run(() => api.createCollectedFieldOption(props.entryId, name))
          )}
          onClearValue={() => props.run(() => api.clearFieldValue(props.entryId))}
        />
      ) : canUseTypedControl && props.optionField ? (
        <TypedFieldValueControl
          entryId={props.entryId}
          fieldType={props.optionField.fieldType ?? 'plain'}
          placeholder={props.placeholder}
          run={props.run}
          valueNode={singleValueNode}
        />
      ) : (
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
      )}
      {!canUseOptionPicker && !canUseTypedControl && showTrailingInput && (
        <TrailingInput
          panelId={props.panelId}
          parentId={props.entryId}
          index={props.index}
          expanded={props.ui.expanded}
          run={props.run}
          focusRequest={props.ui.focusRequest}
          focusedId={props.ui.focusedId}
          focusSurface={props.ui.focusSurface}
          onFocusRequestConsumed={(request: FocusRequest) => {
            props.setUi((prev) => clearFocusRequestState(prev, request));
          }}
          placeholder={props.placeholder}
          onCreate={async (parentId, text) => {
            let createdId: string | null = null;
            await props.run(async () => {
              const outcome = await api.createNode(parentId, null, text);
              createdId = outcome.focus?.nodeId ?? null;
              return outcome.projection;
            });
            return createdId;
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
          onApplyTagTrigger={applyTrailingTagTrigger}
          onCreateTagTrigger={createAndApplyTrailingTagTrigger}
          onApplyReferenceTrigger={applyTrailingReferenceTrigger}
          onExecuteSlashTrigger={executeTrailingSlashTrigger}
          onOpenCommandPalette={() => props.setUi((prev) => ({ ...prev, commandOpen: true }))}
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
          continueOnEnter={!singleValueField}
          onSelectOption={(optionId) => (
            props.run(() => api.selectFieldOption(props.entryId, optionId))
          )}
          onCreateOption={(name) => (
            props.run(() => api.createCollectedFieldOption(props.entryId, name))
          )}
        />
      )}
    </div>
  );
}
