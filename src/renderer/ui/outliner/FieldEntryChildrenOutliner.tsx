import type { ReactNode } from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import { plainText } from '../../api/types';
import type { DocumentIndex, FocusRequest } from '../../state/document';
import type { CommandRunner, TriggerState } from '../shared';
import { TrailingInput } from './TrailingInput';
import { createTrailingField, createTrailingTriggerNode } from './trailingTriggers';
import { buildOutlinerRows, shouldShowTrailingInput } from './row-model';

interface FieldEntryChildrenOutlinerProps {
  panelId: string;
  entryId: NodeId;
  childIds: NodeId[];
  index: DocumentIndex;
  expanded: Set<NodeId>;
  focusRequest?: FocusRequest | null;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  run: CommandRunner;
  setTrigger: (trigger: TriggerState) => void;
  onExpand: (nodeId: NodeId) => void;
  onNavigateUp: () => void;
  onCollapseToSelf: () => void;
  onFocusNode: (nodeId: NodeId) => void;
  onCollapseNode: (nodeId: NodeId) => void;
  onUndo: () => void;
  onRedo: () => void;
  children: ReactNode;
}

export function FieldEntryChildrenOutliner(props: FieldEntryChildrenOutlinerProps) {
  const entry = props.index.byId.get(props.entryId);
  const field = entry?.fieldDefId ? props.index.byId.get(entry.fieldDefId) : undefined;
  const rows = buildOutlinerRows(entry, props.index.byId);
  const showTrailingInput = shouldShowTrailingInput(rows);

  return (
    <div className="children field-entry-children">
      {props.children}
      {showTrailingInput && (
        <TrailingInput
          panelId={props.panelId}
          parentId={props.entryId}
          index={props.index}
          expanded={props.expanded}
          focusRequest={props.focusRequest}
          onFocusRequestConsumed={props.onFocusRequestConsumed}
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
            void createTrailingTriggerNode({
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
          onExpand={props.onExpand}
          onFocusNode={props.onFocusNode}
          onUndo={props.onUndo}
          onRedo={props.onRedo}
          onCollapseNode={(nodeId) => {
            if (nodeId === props.entryId) {
              props.onCollapseToSelf();
              return;
            }
            props.onCollapseNode(nodeId);
          }}
          onNavigateOut={(direction) => {
            if (direction === 'up') props.onNavigateUp();
          }}
          optionField={field}
          onSelectOption={(optionId) => (
            props.run(() => api.selectFieldOption(props.entryId, optionId))
          )}
          onCreateOption={(name) => (
            props.run(async () => {
              if (!field) return api.getProjection();
              const outcome = await api.registerCollectedOption(field.id, name);
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
