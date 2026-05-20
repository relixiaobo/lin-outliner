import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type SetStateAction,
} from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import {
  clearFocusState,
  clearFocusRequestState,
  clearPendingInputState,
  cursorEnd,
  cursorOffset as cursorAtOffset,
  focusTarget,
  focusTargetMatches,
  rowFocusTarget,
  requestFocusState,
  selectFocusState,
} from '../focus/focusModel';
import {
  insertTextIntoControlValue,
  setTextControlCursor,
} from '../focus/textControlFocus';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { indentTargetParentId } from '../interactions/outlinerStructure';
import { TextInputControl } from '../primitives/TextInputControl';
import type { CommandRunner, TriggerState } from '../shared';
import { outlinerChildren } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { fieldTypeLabel } from './fieldTypePresentation';
import { FieldEntryGrid } from './FieldEntryGrid';
import { FieldValueOutliner } from './FieldValueOutliner';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { OutlinerRowShell } from './OutlinerRowShell';
import { RowLeading } from './RowLeading';
import { useOutlinerRowInteraction } from './useOutlinerRowInteraction';

interface OutlinerFieldRowProps {
  panelId: string;
  entryId: NodeId;
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
  isFirstInFieldGroup: boolean;
  isLastInFieldGroup: boolean;
}

function resolveFieldOwnerColor(
  entry: NodeProjection,
  field: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): string | undefined {
  const lookupIds = [entry.templateId, field?.id ?? entry.fieldDefId, field?.sourceSupertag]
    .filter((id): id is NodeId => Boolean(id));

  for (const lookupId of lookupIds) {
    const lookup = byId.get(lookupId);
    const ownerId = lookup?.type === 'tagDef'
      ? lookup.id
      : lookup?.type === 'fieldEntry'
        ? lookup.parentId
        : lookup?.type === 'fieldDef'
          ? lookup.sourceSupertag ?? lookup.parentId
          : undefined;
    const owner = ownerId ? byId.get(ownerId) : undefined;
    if (owner?.type === 'tagDef') return resolveTagColor(owner).text;
  }

  return undefined;
}

export function OutlinerFieldRow(props: OutlinerFieldRowProps) {
  const entry = props.index.byId.get(props.entryId);
  const field = entry?.fieldDefId ? props.index.byId.get(entry.fieldDefId) : undefined;
  const rowChildIds = outlinerChildren(entry, props.index.byId);
  const primaryValueId = rowChildIds[0];
  const row = useOutlinerRowInteraction({
    rowId: props.entryId,
    parentId: props.parentId,
    panelId: props.panelId,
    rootId: props.rootId,
    depth: props.depth,
    childIds: rowChildIds,
    index: props.index,
    ui: props.ui,
    setUi: props.setUi,
    run: props.run,
    locked: entry?.locked ?? true,
    dragId: props.dragId,
    setDragId: props.setDragId,
  });
  const [nameDraft, setNameDraft] = useState(field?.content.text ?? '');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fieldNameFocusTarget = focusTarget(props.entryId, props.parentId, props.panelId, 'field-name');
  const descriptionFocusTarget = focusTarget(props.entryId, props.parentId, props.panelId, 'description');

  useEffect(() => {
    setNameDraft(field?.content.text ?? '');
  }, [field?.id, field?.content.text]);

  useEffect(() => {
    const request = props.ui.focusRequest;
    if (!request || !focusTargetMatches(request.target, fieldNameFocusTarget)) return;
    window.requestAnimationFrame(() => {
      const target = nameInputRef.current;
      if (!target) return;
      target.focus();
      setTextControlCursor(target, request.placement);
      props.setUi((prev) => clearFocusRequestState(prev, request));
    });
  }, [fieldNameFocusTarget, props.setUi, props.ui.focusRequest]);

  useEffect(() => {
    const input = props.ui.pendingInputChar;
    if (!input || !focusTargetMatches(input.target, fieldNameFocusTarget)) return;
    window.requestAnimationFrame(() => {
      const target = nameInputRef.current;
      if (!target) return;
      target.focus();
      const next = insertTextIntoControlValue({
        value: target.value,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        text: input.char,
      });
      setNameDraft(next.value);
      window.requestAnimationFrame(() => {
        const current = nameInputRef.current;
        if (!current) return;
        current.setSelectionRange(next.cursor, next.cursor);
      });
      props.setUi((prev) => clearPendingInputState(prev, input));
    });
  }, [fieldNameFocusTarget, props.setUi, props.ui.pendingInputChar]);

  if (!entry) return null;

  const fieldType = field?.fieldType ?? entry.fieldType ?? 'plain';
  const drillDownId = field?.id ?? props.entryId;
  const fieldOwnerColor = resolveFieldOwnerColor(entry, field, props.index.byId);

  const commitName = async (nextName = nameDraft) => {
    const normalized = nextName.trim();
    if (!normalized) {
      setNameDraft(field?.content.text ?? '');
      return;
    }
    if (field && normalized !== field.content.text) {
      await props.run(async () => {
        await api.replaceNodeText(field.id, plainText(normalized));
        return api.getProjection();
      });
    }
  };

  const commitDrafts = async () => {
    await commitName();
  };

  const exitToSelection = async () => {
    await commitDrafts();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: props.entryId,
      selectedIds: new Set([props.entryId]),
      selectionAnchorId: props.entryId,
      selectionRootId: props.rootId,
      selectionSource: 'global',
    }));
  };

  const shiftDepth = async (shiftKey: boolean, cursorOffset: number) => {
    await commitDrafts();
    const fieldNameTargetAfterStructureChange = focusTarget(props.entryId, null, props.panelId, 'field-name');
    if (!shiftKey) {
      const targetParentId = indentTargetParentId(props.entryId, props.index.byId);
      if (!targetParentId) return;
      const expandTargetAndRememberCursor = () => props.setUi((prev) => {
        const expanded = new Set(prev.expanded);
        expanded.add(targetParentId);
        return requestFocusState(
          { ...prev, expanded },
          fieldNameTargetAfterStructureChange,
          cursorAtOffset(cursorOffset),
        );
      });
      expandTargetAndRememberCursor();
      const result = await props.run(() => api.indentNode(props.entryId));
      if (result) {
        expandTargetAndRememberCursor();
      }
      return;
    }
    props.setUi((prev) => requestFocusState(
      prev,
      fieldNameTargetAfterStructureChange,
      cursorAtOffset(cursorOffset),
    ));
    const result = await props.run(() => api.outdentNode(props.entryId));
    if (result) {
      props.setUi((prev) => requestFocusState(
        prev,
        fieldNameTargetAfterStructureChange,
        cursorAtOffset(cursorOffset),
      ));
    }
  };

  const focusFieldValueNode = () => {
    props.setUi((prev) => {
      if (primaryValueId) {
        return requestFocusState(
          prev,
          rowFocusTarget(primaryValueId, props.entryId, props.panelId),
          cursorEnd(),
        );
      }
      return requestFocusState(
        prev,
        focusTarget(props.entryId, props.entryId, props.panelId, 'trailing'),
        cursorEnd(),
      );
    });
  };

  const createSiblingAfterField = async () => {
    await commitName();
    const parent = props.index.byId.get(props.parentId);
    const currentIndex = parent?.children.indexOf(props.entryId) ?? -1;
    const insertIndex = currentIndex >= 0 ? currentIndex + 1 : null;
    await props.run(() => api.createNode(props.parentId, insertIndex, ''));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, column: 'name' | 'value') => {
    if (isImeComposingEvent(event)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void props.run(() => event.shiftKey ? api.redo() : api.undo());
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      void props.run(() => api.redo());
      return;
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      void commitDrafts().then(() => props.run(() => api.cycleDoneState(props.entryId)));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      void exitToSelection();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const cursorOffset = event.currentTarget instanceof HTMLInputElement
        ? event.currentTarget.selectionStart ?? event.currentTarget.value.length
        : 0;
      void shiftDepth(event.shiftKey, cursorOffset);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      void commitDrafts().then(() => row.moveFocus(direction));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (column === 'name') {
        void createSiblingAfterField();
      } else {
        void commitName().then(() => focusFieldValueNode());
      }
    }
  };

  const openContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: props.entryId,
      selectedIds: prev.selectedIds.has(props.entryId) ? new Set(prev.selectedIds) : new Set([props.entryId]),
      selectionAnchorId: prev.selectedIds.has(props.entryId) ? prev.selectionAnchorId ?? props.entryId : props.entryId,
      selectionRootId: props.rootId,
      selectionSource: 'global',
    }));
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const nameControl = (
    <TextInputControl
      ref={nameInputRef}
      className={`field-name-input ${entry.completedAt ? 'done' : ''}`}
      data-focus-node-id={props.entryId}
      label="Field name"
      value={nameDraft}
      placeholder="Field name"
      title={`${nameDraft || 'Field name'} (${fieldTypeLabel(fieldType)})`}
      onFocus={() => {
        props.setUi((prev) => selectFocusState(prev, fieldNameFocusTarget));
      }}
      onChange={(event) => setNameDraft(event.target.value)}
      onBlur={() => void commitName()}
      onKeyDown={(event) => onKeyDown(event, 'name')}
    />
  );

  const valuePlaceholder = fieldType === 'options' || fieldType === 'options_from_supertag'
    ? 'Select option'
    : 'Empty';
  const valueControl = (
    <FieldValueOutliner
      panelId={props.panelId}
      entryId={props.entryId}
      onRoot={props.onRoot}
      index={props.index}
      ui={props.ui}
      setUi={props.setUi}
      run={props.run}
      trigger={props.trigger}
      setTrigger={props.setTrigger}
      dragId={props.dragId}
      setDragId={props.setDragId}
      optionField={field}
      placeholder={valuePlaceholder}
    />
  );

  const description = (
    <NodeDescription
      node={entry}
      targetId={props.entryId}
      editing={props.ui.editingDescriptionId === props.entryId}
      run={props.run}
      onEditingChange={(editing) => {
        props.setUi((prev) => ({
          ...prev,
          editingDescriptionId: editing ? props.entryId : null,
        }));
      }}
      focusTarget={descriptionFocusTarget}
      focusRequest={props.ui.focusRequest}
      pendingInput={props.ui.pendingInputChar}
      onFocusTarget={(target) => {
        props.setUi((prev) => selectFocusState(prev, target));
      }}
      onFocusRequestConsumed={(request) => {
        props.setUi((prev) => clearFocusRequestState(prev, request));
      }}
      onPendingInputConsumed={(input) => {
        props.setUi((prev) => clearPendingInputState(prev, input));
      }}
    />
  );

  return (
    <OutlinerRowShell
      hasChildren={false}
      expanded={false}
      wrapProps={row.wrapProps}
      rowClassName={row.rowClassName([
        'field-row-inline',
        props.isFirstInFieldGroup ? 'field-group-start' : '',
        props.isLastInFieldGroup ? 'field-group-end' : '',
      ].filter(Boolean).join(' '))}
      onSelectFromPointer={row.selectFromPointer}
      onContextMenu={openContextMenu}
      rowContent={(
        <>
        <RowLeading
          hasChildren={false}
          expanded={false}
          variant="field"
          fieldType={fieldType}
          bulletColors={fieldOwnerColor ? [fieldOwnerColor] : undefined}
          onToggleExpand={row.toggleExpandOrSelect}
          onDrillDown={() => props.onRoot(drillDownId)}
          draggable={row.dragHandleProps.draggable}
          onDragStart={row.dragHandleProps.onDragStart}
          onDragEnd={row.dragHandleProps.onDragEnd}
        />
        <FieldEntryGrid name={nameControl} value={valueControl} description={description} />
        </>
      )}
    >
      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={entry}
          targetId={props.entryId}
          openId={drillDownId}
          selectedIds={props.ui.selectedIds}
          index={props.index}
          run={props.run}
          onRoot={props.onRoot}
          onEditDescription={() => {
            props.setUi((prev) => requestFocusState(
              { ...prev, editingDescriptionId: props.entryId },
              descriptionFocusTarget,
              cursorEnd(),
            ));
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </OutlinerRowShell>
  );
}
