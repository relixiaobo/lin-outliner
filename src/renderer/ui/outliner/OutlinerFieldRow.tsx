import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import { projectFieldConfig } from '../../../core/configProjection';
import type { DocumentIndex, UiState } from '../../state/document';
import { buildSelectableRows } from '../../state/selectableRows';
import {
  clearFocusState,
  clearFocusRequestState,
  clearPendingInputState,
  cursorEnd,
  cursorStart,
  cursorOffset as cursorAtOffset,
  focusTarget,
  focusTargetMatches,
  outlinerNavigationFocusTarget,
  rowFocusTarget,
  requestFocusState,
  selectFocusState,
} from '../focus/focusModel';
import { isCompositionLive } from '../editor/compositionRelay';
import {
  insertTextIntoControlValue,
  setTextControlCursor,
} from '../focus/textControlFocus';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { indentTargetParentId } from '../interactions/outlinerStructure';
import { runSelectionDelete, selectableRowMap } from '../interactions/selectionBatchActions';
import { selectVisibleRowsState } from '../interactions/selectionActions';
import { TextInputControl } from '../primitives/TextInputControl';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { collapseExpandedParentIds, outlinerChildren, parentIdsEmptiedByOutdent } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { fieldTypeLabel } from './fieldTypePresentation';
import { FieldEntryGrid } from './FieldEntryGrid';
import { FieldNameReusePopover } from './FieldNameReusePopover';
import { animateOutlinerRowMovementAfterNextCommit } from './rowMoveAnimation';
import type { FieldReuseCandidate } from '../interactions/fieldReuseCandidates';
import {
  isSystemFieldId,
  systemFieldDisplay,
  systemFieldLabel as getSystemFieldLabel,
  type SystemFieldDisplay,
} from '../../../core/systemFields';
import { SystemFieldValue } from './SystemFieldValue';
import { SystemReferenceValues, isNodeReferenceSystemField } from './SystemReferenceValues';
import { useFieldNameReuse } from './useFieldNameReuse';
import { FieldValueOutliner } from './FieldValueOutliner';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { OutlinerRowShell } from './OutlinerRowShell';
import { RowLeading } from './RowLeading';
import { useOutlinerRowInteraction } from './useOutlinerRowInteraction';
import { useT } from '../../i18n/I18nProvider';
import type { NodeFieldSlot } from '../../../core/fieldSlots';

interface OutlinerFieldRowProps {
  panelId: string;
  slot: NodeFieldSlot;
  parentId: NodeId;
  rootId: NodeId;
  selectionRootId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  depth: number;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  ui: UiState;
  uiRef: MutableRefObject<UiState>;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  onTogglePin: (nodeId: NodeId) => void;
  isFirstInFieldGroup: boolean;
  isLastInFieldGroup: boolean;
}

function resolveFieldOwnerColor(
  slot: NodeFieldSlot,
  field: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): string | undefined {
  const fieldSource = field ? projectFieldConfig(byId, field).sourceSupertag : undefined;
  const lookupIds = [slot.templateEntryId, slot.sourceTagId, field?.id ?? slot.fieldDefId, fieldSource]
    .filter((id): id is NodeId => Boolean(id));

  for (const lookupId of lookupIds) {
    const lookup = byId.get(lookupId);
    const ownerId = lookup?.type === 'tagDef'
      ? lookup.id
      : lookup?.type === 'fieldEntry'
        ? lookup.parentId
        : lookup?.type === 'fieldDef'
          ? projectFieldConfig(byId, lookup).sourceSupertag ?? lookup.parentId
          : undefined;
    const owner = ownerId ? byId.get(ownerId) : undefined;
    if (owner?.type === 'tagDef') return resolveTagColor(owner, byId).text;
  }

  return undefined;
}

export function OutlinerFieldRow(props: OutlinerFieldRowProps) {
  const t = useT();
  const tf = t.outliner.field;
  const slot = props.slot;
  const rowId = slot.id;
  const entry = slot.entryId ? props.index.byId.get(slot.entryId) : undefined;
  const entryId = entry?.type === 'fieldEntry' ? entry.id : undefined;
  const field = props.index.byId.get(slot.fieldDefId);
  const rowChildIds = outlinerChildren(entry, props.index.byId);
  const primaryValueId = rowChildIds[0];
  const row = useOutlinerRowInteraction({
    rowId,
    parentId: props.parentId,
    childParentId: entryId ?? rowId,
    dropTargetNodeId: entryId,
    panelId: props.panelId,
    rootId: props.rootId,
    selectionRootId: props.selectionRootId,
    depth: props.depth,
    childIds: rowChildIds,
    index: props.index,
    ui: props.ui,
    uiRef: props.uiRef,
    setUi: props.setUi,
    run: props.run,
    locked: slot.source === 'tag' || (entry?.locked ?? true),
    dragId: props.dragId,
    setDragId: props.setDragId,
  });
  const [nameDraft, setNameDraft] = useState(field?.content.text ?? '');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameSelectAllRowsReadyRef = useRef(false);
  const descriptionReturnPlacementRef = useRef(cursorEnd());
  const fieldNameFocusTarget = focusTarget(rowId, props.parentId, props.panelId, 'field-name');
  const descriptionFocusTarget = focusTarget(rowId, props.parentId, props.panelId, 'description');

  useEffect(() => {
    setNameDraft(field?.content.text ?? '');
  }, [field?.id, field?.content.text]);

  useEffect(() => {
    const request = props.ui.focusRequest;
    if (!request || !focusTargetMatches(request.target, fieldNameFocusTarget)) return;
    // A live IME composition parks the request (issue #176); the composing
    // editor relays it at compositionend.
    if (isCompositionLive()) return;
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

  // A built-in system field (`sys:*`) has no backing def node: its name is a fixed
  // label and its value is computed read-only from the owner (this entry's parent).
  const systemFieldId = isSystemFieldId(slot.fieldDefId) ? slot.fieldDefId : undefined;

  // The reuse popover's state + (memoized) candidate scan live in the hook; the row
  // just wires the name input's focus/change/blur and Space to its handlers.
  const reuse = useFieldNameReuse({
    byId: props.index.byId,
    entryId: entryId ?? rowId,
    parentId: props.parentId,
    draftDefId: field?.id,
    trashId: props.index.projection.trashId,
    nameDraft,
    disabled: Boolean(systemFieldId) || slot.source === 'tag',
  });

  // Each read-only system field renders by its real type, not as bare text — the
  // structured display centralizes that decision (date glyph, tag badges, node
  // links, the Done checkbox). Memoized so the row's focus/selection/popover
  // re-renders don't repeat the owner scan (References is an O(N) backlink walk).
  const systemDisplay = useMemo<SystemFieldDisplay | null>(() => {
    if (!systemFieldId) return null;
    const owner = props.index.byId.get(props.parentId);
    if (!owner) return null;
    return systemFieldDisplay(owner, systemFieldId, props.index.byId);
  }, [systemFieldId, entry, props.index.byId, props.parentId]);

  const fieldConfig = field ? projectFieldConfig(props.index.byId, field) : undefined;
  const fieldType = fieldConfig?.fieldType ?? 'plain';
  const drillDownId = field?.id ?? rowId;
  const fieldOwnerColor = resolveFieldOwnerColor(slot, field, props.index.byId);

  const systemFieldLabel = systemFieldId ? getSystemFieldLabel(systemFieldId) ?? '' : '';

  // Both kinds resolve to a real target id (a def node, or a `sys:*` id core
  // accepts as read-only), so reuse is a single relink either way.
  const onReuseSelect = (candidate: FieldReuseCandidate) => {
    reuse.dismiss();
    if (!entryId || slot.source === 'tag') return;
    void props.run(() => api.reuseFieldDefinition(entryId, candidate.id));
  };

  const commitName = async (nextName = nameDraft) => {
    const normalized = nextName.trim();
    if (!normalized) {
      setNameDraft(field?.content.text ?? '');
      return;
    }
    if (field && normalized !== field.content.text) {
      await props.run(async () => {
        return api.replaceNodeText(field.id, plainText(normalized));
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
      selectedId: rowId,
      selectedIds: new Set([rowId]),
      selectionAnchorId: rowId,
      selectionRootId: props.selectionRootId,
      selectionSource: 'global',
    }));
  };

  const selectAllVisibleRows = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    props.setUi((prev) => selectVisibleRowsState(prev, {
      byId: props.index.byId,
      selectionRootId: props.selectionRootId,
    }));
  };

  const deleteFieldRowFromNameStart = async () => {
    if (!entryId || slot.source === 'tag') return;
    await commitDrafts();
    const selectableRows = buildSelectableRows(props.selectionRootId, props.index.byId, {
      expanded: props.uiRef.current.expanded,
      expandedHiddenFields: props.uiRef.current.expandedHiddenFields,
    });
    const rows = selectableRows.map((selectableRow) => selectableRow.id);
    const rowsById = selectableRowMap(selectableRows);
    const currentIndex = rows.indexOf(rowId);
    const deletedWithEntry = (id: NodeId) => {
      if (id === rowId || id === entryId) return true;
      let parentId = props.index.byId.get(id)?.parentId ?? null;
      while (parentId) {
        if (parentId === entryId) return true;
        parentId = props.index.byId.get(parentId)?.parentId ?? null;
      }
      return false;
    };
    const previous = currentIndex > 0
      ? [...rows.slice(0, currentIndex)].reverse().find((id) => !deletedWithEntry(id)) ?? null
      : null;
    const next = currentIndex >= 0
      ? rows.slice(currentIndex + 1).find((id) => !deletedWithEntry(id)) ?? null
      : null;
    const rowTargetForId = (id: NodeId) => {
      const selectableRow = rowsById.get(id);
      const parentId = selectableRow?.parentId ?? props.index.byId.get(id)?.parentId ?? null;
      return outlinerNavigationFocusTarget(
        id,
        parentId,
        props.panelId,
        selectableRow?.kind ?? 'content',
      );
    };
    await props.run(() => runSelectionDelete({
      ids: [entryId],
      panelRootId: props.selectionRootId,
      byId: props.index.byId,
      rowMap: rowsById,
    }));
    props.setUi((prev) => {
      if (previous) {
        return requestFocusState(
          prev,
          rowTargetForId(previous),
          cursorEnd(),
        );
      }
      if (next) {
        return requestFocusState(
          prev,
          rowTargetForId(next),
          cursorStart(),
        );
      }
      return requestFocusState(
        prev,
        focusTarget(props.selectionRootId, props.selectionRootId, props.panelId, 'trailing'),
        cursorEnd(),
      );
    });
  };

  const shiftDepth = async (shiftKey: boolean, cursorOffset: number) => {
    if (!entryId || slot.source === 'tag') return;
    await commitDrafts();
    const fieldNameTargetAfterStructureChange = focusTarget(entryId, null, props.panelId, 'field-name');
    if (!shiftKey) {
      const targetParentId = indentTargetParentId(entryId, props.index.byId);
      if (!targetParentId) return;
      await props.run(() => api.indentNode(entryId), {
        applyFocus: false,
        beforeApply: () => {
          animateOutlinerRowMovementAfterNextCommit();
          props.setUi((prev) => {
            const expanded = new Set(prev.expanded);
            expanded.add(targetParentId);
            return requestFocusState(
              { ...prev, expanded },
              fieldNameTargetAfterStructureChange,
              cursorAtOffset(cursorOffset),
            );
          });
        },
      });
      return;
    }
    const emptiedParentIds = parentIdsEmptiedByOutdent([entryId], props.index.byId, props.rootId);
    if (props.parentId === props.rootId) return;
    await props.run(() => api.outdentNode(entryId), {
      applyFocus: false,
      beforeApply: () => {
        animateOutlinerRowMovementAfterNextCommit();
        props.setUi((prev) => {
          const next = emptiedParentIds.size > 0
            ? { ...prev, expanded: collapseExpandedParentIds(prev.expanded, emptiedParentIds) }
            : prev;
          return requestFocusState(
            next,
            fieldNameTargetAfterStructureChange,
            cursorAtOffset(cursorOffset),
          );
        });
      },
    });
  };

  const focusFieldValueNode = () => {
    props.setUi((prev) => {
      if (primaryValueId) {
        return requestFocusState(
          prev,
          rowFocusTarget(primaryValueId, entryId ?? rowId, props.panelId),
          cursorEnd(),
        );
      }
      return requestFocusState(
        prev,
        focusTarget(entryId ?? rowId, entryId ?? rowId, props.panelId, 'trailing'),
        cursorEnd(),
      );
    });
  };

  const createSiblingAfterField = async () => {
    await commitName();
    if (!entryId || slot.source === 'tag') {
      focusFieldValueNode();
      return;
    }
    const parent = props.index.byId.get(props.parentId);
    const currentIndex = parent?.children.indexOf(entryId) ?? -1;
    const insertIndex = currentIndex >= 0 ? currentIndex + 1 : null;
    await props.run(() => api.createNode(props.parentId, insertIndex, ''));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, column: 'name' | 'value') => {
    if (isImeComposingEvent(event)) return;
    const mod = event.metaKey || event.ctrlKey;
    const nameSelectAllShortcut = column === 'name' && mod && event.key.toLowerCase() === 'a';
    const modifierOnlyKey = event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift';
    if (!nameSelectAllShortcut && !modifierOnlyKey) nameSelectAllRowsReadyRef.current = false;
    // Space on an empty field name summons the reuse picker (showing every
    // candidate) instead of inserting a leading space — mirrors the field-value
    // pickers' "Space to open" affordance. Once the name has text, Space types.
    if (
      column === 'name'
      && event.key === ' '
      && !mod
      && !systemFieldId
      && nameDraft.trim() === ''
    ) {
      event.preventDefault();
      reuse.summon();
      return;
    }
    if (
      slot.source === 'own'
      && Boolean(entry)
      && event.ctrlKey
      && !event.metaKey
      && !event.altKey
      && !event.shiftKey
      && (event.key.toLowerCase() === 'i' || event.code === 'KeyI' || event.key === 'Tab')
    ) {
      event.preventDefault();
      const cursor = event.currentTarget instanceof HTMLInputElement
        ? event.currentTarget.selectionStart ?? event.currentTarget.value.length
        : 0;
      descriptionReturnPlacementRef.current = cursorAtOffset(cursor);
      props.setUi((prev) => requestFocusState(
        { ...prev, editingDescriptionId: rowId },
        descriptionFocusTarget,
        cursorEnd(),
      ));
      return;
    }
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
    if (mod && event.key.toLowerCase() === 'a') {
      const target = event.currentTarget;
      if (
        target instanceof HTMLInputElement
        && (target.selectionStart ?? 0) <= 0
        && (target.selectionEnd ?? 0) >= target.value.length
        && (nameSelectAllRowsReadyRef.current || target.value.length === 0)
      ) {
        event.preventDefault();
        nameSelectAllRowsReadyRef.current = false;
        selectAllVisibleRows();
        return;
      }
      nameSelectAllRowsReadyRef.current = true;
      return;
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      if (entryId && slot.source === 'own') {
        void commitDrafts().then(() => props.run(() => api.cycleDoneState(entryId)));
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      void exitToSelection();
      return;
    }
    if (
      column === 'name'
      && event.key === 'Backspace'
      && !mod
      && !event.altKey
      && !event.shiftKey
    ) {
      const target = event.currentTarget;
      if (
        target instanceof HTMLInputElement
        && (target.selectionStart ?? 0) === 0
        && (target.selectionEnd ?? 0) === 0
      ) {
        event.preventDefault();
        void deleteFieldRowFromNameStart();
        return;
      }
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
      selectedId: rowId,
      selectedIds: prev.selectedIds.has(rowId) ? new Set(prev.selectedIds) : new Set([rowId]),
      selectionAnchorId: prev.selectedIds.has(rowId) ? prev.selectionAnchorId ?? rowId : rowId,
      selectionRootId: props.selectionRootId,
      selectionSource: 'global',
    }));
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const nameControl = (
    <TextInputControl
      ref={nameInputRef}
      className={`field-name-input ${entry?.completedAt ? 'done' : ''} ${systemFieldId ? 'system' : ''}`}
      data-focus-node-id={rowId}
      label={tf.fieldNameLabel}
      value={systemFieldId ? systemFieldLabel : nameDraft}
      readOnly={Boolean(systemFieldId)}
      placeholder={tf.fieldNameLabel}
      title={systemFieldId
        ? tf.systemFieldTitle({ name: systemFieldLabel })
        : tf.fieldNameTitle({ name: nameDraft || tf.fieldNameLabel, type: fieldTypeLabel(fieldType) })}
      onFocus={() => {
        nameSelectAllRowsReadyRef.current = false;
        reuse.onFocus();
        props.setUi((prev) => selectFocusState(prev, fieldNameFocusTarget));
      }}
      onChange={(event) => {
        setNameDraft(event.target.value);
        reuse.onChange();
      }}
      onBlur={() => {
        nameSelectAllRowsReadyRef.current = false;
        reuse.onBlur();
        void commitName();
      }}
      onKeyDown={(event) => onKeyDown(event, 'name')}
    />
  );

  const reusePopover = (
    <FieldNameReusePopover
      anchorRef={nameInputRef}
      candidates={reuse.candidates}
      open={reuse.open}
      onOpenChange={(open) => { if (!open) reuse.dismiss(); }}
      onSelect={onReuseSelect}
    />
  );

  const valuePlaceholder = fieldType === 'options' || fieldType === 'options_from_supertag'
    ? tf.selectOption
    : tf.empty;

  // The Done checkbox writes the owner's done state, but a locked owner (e.g. a
  // daily-note date page) rejects `toggle_done` — render it read-only there.
  const ownerEditable = !(props.index.byId.get(props.parentId)?.locked ?? false);
  const valueControl = systemDisplay ? (
    systemFieldId && isNodeReferenceSystemField(systemFieldId) ? (
      // References / Owner / Day are read-only node references: render them as the
      // same reference rows used everywhere (double-click edits the target,
      // expandable), with the value set computed and immutable. See the system
      // field section in docs/spec/ui-behavior.md.
      <SystemReferenceValues
        panelId={props.panelId}
        entryId={entryId ?? rowId}
        ownerId={props.parentId}
        systemFieldId={systemFieldId}
        selectionRootId={props.selectionRootId}
        onRoot={props.onRoot}
        index={props.index}
        isNodePinned={props.isNodePinned}
        ui={props.ui}
        uiRef={props.uiRef}
        setUi={props.setUi}
        run={props.run}
        onTogglePin={props.onTogglePin}
        trigger={props.trigger}
        setTrigger={props.setTrigger}
        dragId={props.dragId}
        setDragId={props.setDragId}
      />
    ) : (
      <SystemFieldValue
        display={systemDisplay}
        byId={props.index.byId}
        onRoot={props.onRoot}
        onToggleDone={ownerEditable ? () => void props.run(() => api.toggleDone(props.parentId)) : undefined}
      />
    )
  ) : (
    <div className="field-value-cell">
      <FieldValueOutliner
        panelId={props.panelId}
        slot={slot}
        ownerId={props.parentId}
        selectionRootId={props.selectionRootId}
        onRoot={props.onRoot}
        index={props.index}
        isNodePinned={props.isNodePinned}
        ui={props.ui}
        uiRef={props.uiRef}
        setUi={props.setUi}
        run={props.run}
        onTogglePin={props.onTogglePin}
        trigger={props.trigger}
        setTrigger={props.setTrigger}
        dragId={props.dragId}
        setDragId={props.setDragId}
        optionField={field}
        placeholder={valuePlaceholder}
      />
    </div>
  );

  const description = entry && slot.source === 'own' ? (
    <NodeDescription
      node={entry}
      targetId={entry.id}
      editing={props.ui.editingDescriptionId === rowId}
      run={props.run}
      onEditingChange={(editing) => {
        props.setUi((prev) => ({
          ...prev,
          editingDescriptionId: editing ? rowId : null,
        }));
      }}
      focusTarget={descriptionFocusTarget}
      focusRequest={props.ui.focusRequest}
      pendingInput={props.ui.pendingInputChar}
      onFocusTarget={(target) => {
        props.setUi((prev) => selectFocusState(prev, target));
      }}
      onReturnToSource={() => {
        props.setUi((prev) => requestFocusState(
          { ...prev, editingDescriptionId: null },
          fieldNameFocusTarget,
          descriptionReturnPlacementRef.current,
        ));
      }}
      onFocusRequestConsumed={(request) => {
        props.setUi((prev) => clearFocusRequestState(prev, request));
      }}
      onPendingInputConsumed={(input) => {
        props.setUi((prev) => clearPendingInputState(prev, input));
      }}
    />
  ) : null;

  return (
    <OutlinerRowShell
      hasChildren={false}
      expanded={false}
      level={props.depth + 1}
      selected={row.rowSelected}
      wrapProps={row.wrapProps}
      rowClassName={row.rowClassName([
        'field-row-inline',
        props.isFirstInFieldGroup ? 'field-group-start' : '',
        props.isLastInFieldGroup ? 'field-group-end' : '',
      ].filter(Boolean).join(' '))}
      onSelectFromPointer={row.selectFromPointer}
      onContextMenu={slot.source === 'own' && entry ? openContextMenu : undefined}
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
        {reusePopover}
        </>
      )}
    >
      {contextMenu && entry && slot.source === 'own' && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={entry}
          targetId={entry.id}
          visualRowId={rowId}
          viewToolbarVisibleInRow={false}
          openId={drillDownId}
          panelId={props.panelId}
          selectionRootId={props.selectionRootId}
          selectedIds={props.ui.selectedIds}
          index={props.index}
          isPinned={props.isNodePinned(drillDownId)}
          isNodePinned={props.isNodePinned}
          onRoot={props.onRoot}
          onTogglePin={props.onTogglePin}
          onEditDescription={() => {
            descriptionReturnPlacementRef.current = cursorEnd();
            props.setUi((prev) => requestFocusState(
              { ...prev, editingDescriptionId: rowId },
              descriptionFocusTarget,
              cursorEnd(),
            ));
          }}
          onRevealViewToolbar={() => {}}
          onOpenViewSection={(nodeId, section) => {
            props.setUi((prev) => ({
              ...prev,
              toolbarDropdownRequest: { nodeId, section, nonce: Date.now() },
            }));
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </OutlinerRowShell>
  );
}
