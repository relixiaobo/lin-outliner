import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
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
  requestFocusState,
  selectFocusState,
} from '../focus/focusModel';
import {
  insertTextIntoControlValue,
  isTextControlElement,
  setTextControlCursor,
} from '../focus/textControlFocus';
import { savePrimaryFieldEntryChildText } from '../../state/fieldEntryChildren';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { indentTargetParentId } from '../interactions/outlinerStructure';
import { ButtonControl } from '../primitives/ButtonControl';
import { TextInputControl } from '../primitives/TextInputControl';
import type { CommandRunner, TriggerState } from '../shared';
import { outlinerChildren } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { fieldTypeLabel } from './fieldTypePresentation';
import { FieldEntryGrid } from './FieldEntryGrid';
import { FieldValueRenderer } from './FieldValueRenderer';
import { IndentGuide } from './IndentGuide';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { OutlinerRowShell } from './OutlinerRowShell';
import { RowLeading } from './RowLeading';
import { useOutlinerRowInteraction } from './useOutlinerRowInteraction';

interface FieldRowChildrenControls {
  childIds: NodeId[];
  focusLastVisibleChild: () => void;
  collapseToSelf: () => void;
}

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
  renderChildren?: (controls: FieldRowChildrenControls) => ReactNode;
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
  const value = primaryValueId ? props.index.byId.get(primaryValueId)?.content.text ?? '' : '';
  const [nameDraft, setNameDraft] = useState(field?.content.text || 'Field');
  const [valueDraft, setValueDraft] = useState(value);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const valueFocusRef = useRef<HTMLElement | null>(null);
  const fieldNameFocusTarget = focusTarget(props.entryId, props.parentId, props.panelId, 'field-name');
  const fieldValueFocusTarget = focusTarget(props.entryId, props.parentId, props.panelId, 'field-value');
  const descriptionFocusTarget = focusTarget(props.entryId, props.parentId, props.panelId, 'description');

  useEffect(() => {
    setNameDraft(field?.content.text || 'Field');
  }, [field?.id, field?.content.text]);

  useEffect(() => {
    setValueDraft(value);
  }, [value]);

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

  useEffect(() => {
    const request = props.ui.focusRequest;
    if (!request || !focusTargetMatches(request.target, fieldValueFocusTarget)) return;
    window.requestAnimationFrame(() => {
      const target = valueFocusRef.current;
      if (!target) return;
      target.focus();
      if (isTextControlElement(target)) {
        setTextControlCursor(target, request.placement);
      }
      props.setUi((prev) => clearFocusRequestState(prev, request));
    });
  }, [fieldValueFocusTarget, props.setUi, props.ui.focusRequest]);

  useEffect(() => {
    const input = props.ui.pendingInputChar;
    if (!input || !focusTargetMatches(input.target, fieldValueFocusTarget)) return;
    window.requestAnimationFrame(() => {
      const target = valueFocusRef.current;
      if (!target) return;
      target.focus();
      if (!isTextControlElement(target)) {
        props.setUi((prev) => clearPendingInputState(prev, input));
        return;
      }
      const next = insertTextIntoControlValue({
        value: target.value,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        text: input.char,
      });
      setValueDraft(next.value);
      window.requestAnimationFrame(() => {
        const current = valueFocusRef.current;
        if (!isTextControlElement(current)) return;
        current.setSelectionRange(next.cursor, next.cursor);
      });
      props.setUi((prev) => clearPendingInputState(prev, input));
    });
  }, [fieldValueFocusTarget, props.setUi, props.ui.pendingInputChar]);

  if (!entry) return null;

  const fieldType = field?.fieldType ?? entry.fieldType ?? 'plain';
  const drillDownId = field?.id ?? props.entryId;
  const fieldOwnerColor = resolveFieldOwnerColor(entry, field, props.index.byId);

  const commitName = async (nextName = nameDraft) => {
    const normalized = nextName.trim() || 'Field';
    if (field && normalized !== field.content.text) {
      await props.run(async () => {
        await api.replaceNodeText(field.id, plainText(normalized));
        return api.getProjection();
      });
    }
  };

  const commitValue = async (nextValue = valueDraft) => {
    if (nextValue === value) return;
    await props.run(() => savePrimaryFieldEntryChildText({
      entryId: props.entryId,
      childId: primaryValueId,
      currentText: value,
      nextText: nextValue,
    }));
  };

  const commitDrafts = async () => {
    await commitName();
    await commitValue();
  };

  const createSiblingAfterField = async () => {
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.entryId);
    await props.run(() => api.createNode(props.parentId, rowIndex >= 0 ? rowIndex + 1 : null, ''));
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
        void commitName().then(() => {
          props.setUi((prev) => requestFocusState(prev, fieldValueFocusTarget, cursorEnd()));
        });
      } else {
        void commitDrafts().then(() => createSiblingAfterField());
      }
    }
  };

  const focusFieldValue = () => {
    props.setUi((prev) => selectFocusState(prev, fieldValueFocusTarget));
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
      title={`${nameDraft || 'Field'} (${fieldTypeLabel(fieldType)})`}
      onFocus={() => {
        props.setUi((prev) => selectFocusState(prev, fieldNameFocusTarget));
      }}
      onChange={(event) => setNameDraft(event.target.value)}
      onBlur={() => void commitName()}
      onKeyDown={(event) => onKeyDown(event, 'name')}
    />
  );

  const valueControl = row.expanded && rowChildIds.length > 0 ? (
    <ButtonControl
      ref={(element) => {
        valueFocusRef.current = element;
      }}
      className={`field-value-preview ${entry.completedAt ? 'done' : ''}`}
      onClick={row.focusLastVisibleChild}
      onFocus={focusFieldValue}
      onKeyDown={(event) => onKeyDown(event, 'value')}
      title="Focus field children"
    >
      {rowChildIds.length === 1 ? (value || '1 child') : `${rowChildIds.length} children`}
    </ButtonControl>
  ) : (
    <FieldValueRenderer
      entryId={props.entryId}
      index={props.index}
      run={props.run}
      fieldType={fieldType}
      field={field}
      value={value}
      valueDraft={valueDraft}
      setValueDraft={setValueDraft}
      onCommitValue={commitValue}
      onFocus={focusFieldValue}
      onKeyDown={(event) => onKeyDown(event, 'value')}
      completed={Boolean(entry.completedAt)}
      setFocusElement={(element) => {
        valueFocusRef.current = element;
      }}
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
      hasChildren={row.hasChildren}
      expanded={row.expanded}
      wrapProps={row.wrapProps}
      rowClassName={row.rowClassName('field-row-inline')}
      onSelectFromPointer={row.selectFromPointer}
      onContextMenu={openContextMenu}
      rowContent={(
        <>
        <RowLeading
          hasChildren={row.hasChildren}
          expanded={row.expanded}
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
      {row.expanded && (
        <IndentGuide onToggleChildren={row.toggleDirectChildrenExpansion} />
      )}
      {row.expanded && props.renderChildren?.({
        childIds: rowChildIds,
        focusLastVisibleChild: row.focusLastVisibleChild,
        collapseToSelf: row.collapseToSelf,
      })}
    </OutlinerRowShell>
  );
}
