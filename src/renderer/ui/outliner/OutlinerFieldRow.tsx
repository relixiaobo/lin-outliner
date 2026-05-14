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
import type { FocusHint, NodeId, NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import { savePrimaryFieldEntryChildText } from '../../state/fieldEntryChildren';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { indentTargetParentId } from '../interactions/outlinerStructure';
import type { CommandRunner, TriggerState } from '../shared';
import { outlinerChildren } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { fieldTypeLabel } from './fieldTypePresentation';
import { FieldValueRenderer } from './FieldValueRenderer';
import { IndentGuide } from './IndentGuide';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { RowLeading } from './RowLeading';
import { useOutlinerRowInteraction } from './useOutlinerRowInteraction';

interface FieldRowChildrenControls {
  childIds: NodeId[];
  focusLastVisibleChild: () => void;
  collapseToSelf: () => void;
}

interface OutlinerFieldRowProps {
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
  pendingFocus: FocusHint | null;
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

  useEffect(() => {
    setNameDraft(field?.content.text || 'Field');
  }, [field?.id, field?.content.text]);

  useEffect(() => {
    setValueDraft(value);
  }, [value]);

  useEffect(() => {
    if (props.pendingFocus?.nodeId === props.entryId) {
      window.requestAnimationFrame(() => {
        const target = nameInputRef.current;
        if (!target) return;
        target.focus();
        const offset = props.ui.focusOffset?.nodeId === props.entryId
          ? props.ui.focusOffset.offset
          : null;
        if (props.pendingFocus?.selectAll) target.select();
        else {
          const cursor = offset === null
            ? target.value.length
            : Math.max(0, Math.min(target.value.length, offset));
          target.setSelectionRange(cursor, cursor);
        }
        if (offset !== null) {
          props.setUi((prev) => (
            prev.focusOffset?.nodeId === props.entryId
              ? { ...prev, focusOffset: null }
              : prev
          ));
        }
      });
    }
  }, [props.pendingFocus, props.entryId, props.setUi, props.ui.focusOffset]);

  if (!entry) return null;

  const fieldType = field?.fieldType ?? entry.fieldType ?? 'plain';
  const drillDownId = field?.id ?? props.entryId;
  const fieldOwnerColor = resolveFieldOwnerColor(entry, field, props.index.byId);

  const commitName = async (nextName = nameDraft) => {
    const normalized = nextName.trim() || 'Field';
    if (field && normalized !== field.content.text) {
      await props.run(async () => {
        await api.updateNodeText(field.id, plainText(normalized));
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
      ...prev,
      focusedId: null,
      selectedId: props.entryId,
      selectedIds: new Set([props.entryId]),
      selectionAnchorId: props.entryId,
    }));
  };

  const shiftDepth = async (shiftKey: boolean, cursorOffset: number) => {
    await commitDrafts();
    if (!shiftKey) {
      const targetParentId = indentTargetParentId(props.entryId, props.index.byId);
      if (!targetParentId) return;
      const expandTargetAndRememberCursor = () => props.setUi((prev) => {
        const expanded = new Set(prev.expanded);
        expanded.add(targetParentId);
        return {
          ...prev,
          expanded,
          focusOffset: { nodeId: props.entryId, offset: cursorOffset },
        };
      });
      expandTargetAndRememberCursor();
      const result = await props.run(() => api.indentNode(props.entryId));
      if (result) {
        expandTargetAndRememberCursor();
      }
      return;
    }
    props.setUi((prev) => ({
      ...prev,
      focusOffset: { nodeId: props.entryId, offset: cursorOffset },
    }));
    const result = await props.run(() => api.outdentNode(props.entryId));
    if (result) {
      props.setUi((prev) => ({
        ...prev,
        focusOffset: { nodeId: props.entryId, offset: cursorOffset },
      }));
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
      void commitDrafts().then(() => props.run(() => api.toggleDone(props.entryId)));
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
        void commitName().then(() => valueFocusRef.current?.focus());
      } else {
        void commitDrafts().then(() => createSiblingAfterField());
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
      ...prev,
      focusedId: null,
      selectedId: props.entryId,
      selectedIds: prev.selectedIds.has(props.entryId) ? new Set(prev.selectedIds) : new Set([props.entryId]),
      selectionAnchorId: prev.selectedIds.has(props.entryId) ? prev.selectionAnchorId ?? props.entryId : props.entryId,
    }));
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <div
      className={`row-wrap ${row.hasChildren ? 'has-children' : ''} ${row.expanded ? 'expanded' : ''}`}
      {...row.wrapProps}
    >
      <div
        className={row.rowClassName('field-row-inline')}
        onMouseDownCapture={row.selectFromPointer}
        onContextMenu={openContextMenu}
      >
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
        <div className="outliner-field-grid">
          <input
            ref={nameInputRef}
            className={`field-name-input ${entry.completedAt ? 'done' : ''}`}
            data-focus-node-id={props.entryId}
            value={nameDraft}
            title={`${nameDraft || 'Field'} (${fieldTypeLabel(fieldType)})`}
            onFocus={row.updateSelection}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(event) => onKeyDown(event, 'name')}
          />
          {row.expanded && rowChildIds.length > 0 ? (
            <button
              ref={(element) => {
                valueFocusRef.current = element;
              }}
              className={`field-value-preview ${entry.completedAt ? 'done' : ''}`}
              onClick={row.focusLastVisibleChild}
              onFocus={row.updateSelection}
              onKeyDown={(event) => onKeyDown(event, 'value')}
              title="Focus field children"
            >
              {rowChildIds.length === 1 ? (value || '1 child') : `${rowChildIds.length} children`}
            </button>
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
              onFocus={row.updateSelection}
              onKeyDown={(event) => onKeyDown(event, 'value')}
              completed={Boolean(entry.completedAt)}
              setFocusElement={(element) => {
                valueFocusRef.current = element;
              }}
            />
          )}
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
          />
        </div>
      </div>
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
            props.setUi((prev) => ({ ...prev, editingDescriptionId: props.entryId }));
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
    </div>
  );
}
