import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { projectFieldConfig } from '../../../core/configProjection';
import { mediaKindForMimeType } from '../../../core/mediaKind';
import {
  fieldSlotsForIndex,
  type DocumentIndex,
  type PendingStructuralChange,
  type UiState,
} from '../../state/document';
import { fieldValueEditor, type FieldValueContext } from '../fields/fieldValueEditors';
import { attachmentNodeInput } from '../interactions/attachmentIngest';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { OutlinerFlatView } from './OutlinerFlatView';
import { buildOutlinerRows, viewFieldValuesFor } from './row-model';
import { useT } from '../../i18n/I18nProvider';
import { fieldSlotHasInheritedDefault, fieldSlotId, type NodeFieldSlot } from '../../../core/fieldSlots';
import { EMPTY_RICH_TEXT } from '../../api/types';
import { CheckIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';

interface FieldValueOutlinerProps {
  panelId: string;
  slot: NodeFieldSlot;
  ownerId: NodeId;
  selectionRootId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
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
  optionField?: NodeProjection;
  placeholder: string;
  embeddedInGridCell?: boolean;
  optimisticChange?: PendingStructuralChange;
}

export function FieldValueOutliner(props: FieldValueOutlinerProps) {
  const tf = useT().outliner.field;
  const entry = props.slot.entryId ? props.index.byId.get(props.slot.entryId) : undefined;
  const valueParentId = entry?.type === 'fieldEntry' ? entry.id : props.slot.id;
  const valueParent: NodeProjection = entry?.type === 'fieldEntry' ? entry : {
    id: props.slot.id,
    type: 'fieldEntry',
    fieldDefId: props.slot.fieldDefId,
    parentId: props.ownerId,
    children: [],
    content: EMPTY_RICH_TEXT,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
  };
  const rows = buildOutlinerRows(valueParent, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
    fieldSlots: (nodeId) => fieldSlotsForIndex(props.index, nodeId),
  });
  const empty = rows.length === 0;
  const inheritedDefault = fieldSlotHasInheritedDefault(props.index.byId, props.slot);
  const owner = props.index.byId.get(props.ownerId);
  const inheritedDefaultText = inheritedDefault && owner
    ? viewFieldValuesFor(owner, props.slot.fieldDefId, props.index.byId).join(', ')
    : '';
  const optionFieldConfig = props.optionField
    ? projectFieldConfig(props.index.byId, props.optionField)
    : undefined;
  const optionFieldType = optionFieldConfig?.fieldType;
  const descriptor = fieldValueEditor(optionFieldType);
  const autocollect = optionFieldConfig?.autocollectOptions === true;
  const pendingField = props.optimisticChange?.presentation === 'field'
    ? props.optimisticChange
    : undefined;
  const constraints = {
    min: optionFieldConfig?.minValue,
    max: optionFieldConfig?.maxValue,
  };
  // A date value reads as a plain text row, but its picker is summoned with
  // Space, so surface that affordance through the placeholder.
  const valuePlaceholder = descriptor.interaction === 'datePicker'
    ? tf.datePlaceholder
    : props.placeholder;

  // Materialize the trailing draft as a field value, carrying the renderer's
  // draft row id so the row keeps its React identity (and IME) through the
  // draft->value transition — the same contract as api.materializeDraftNode, so
  // OutlinerItem's materializeDraft drives both through one unified path.
  //
  // These are raw command operations. OutlinerItem runs each exactly once with
  // the focus policy appropriate to the interaction; trigger popovers already
  // provide their own outer runner.
  //
  // updateFieldSlot owns both virtual-slot materialization and existing-entry
  // routing. Auto-collect joins the reusable pool; plain text stays local. Both
  // append — everything is a node, there is no cardinality gate.
  const resolveFieldTarget = async () => {
    if (!pendingField) {
      return {
        entryId: entry?.type === 'fieldEntry' ? entry.id : undefined,
        fieldDefId: props.slot.fieldDefId,
      };
    }
    if (!await pendingField.settlement.current) {
      throw new Error('The pending field could not be created.');
    }
    const fieldDefId = pendingField.resolvedFieldDefId?.current;
    if (!fieldDefId) throw new Error('The pending field definition was not resolved.');
    return { entryId: pendingField.id, fieldDefId };
  };
  const updateFieldValue = async (
    mutation: Record<string, unknown>,
  ) => {
    const target = await resolveFieldTarget();
    return api.updateFieldSlot(props.ownerId, target.fieldDefId, {
      ...mutation,
      ...(target.entryId ? { entryId: target.entryId } : {}),
    } as Parameters<typeof api.updateFieldSlot>[2]);
  };

  const materializeValue = (id: NodeId, text: string) => (
    updateFieldValue({
      kind: 'appendText',
      text,
      id,
      ...(autocollect ? { collect: true } : {}),
    })
  );

  const acceptInheritedDefault = () => {
    if (!inheritedDefault || owner?.locked) return;
    void props.run(() => api.updateFieldSlot(
      props.ownerId,
      props.slot.fieldDefId,
      { kind: 'acceptDefault' },
    ));
  };

  // Everything is a node: the value area always offers a trailing draft as the
  // uniform entry point for the next value (shown when empty or when nav focuses
  // the trailing surface). Values always append — there is no cardinality gate.
  // Keep the draft mounted while it materializes. The pending structural row
  // replaces that draft in place under the same Node ID and React key; once the
  // stored value reaches the projection, `auto` naturally suppresses the next
  // trailing draft unless navigation explicitly asks for it.
  const trailingMode = 'auto' as const;

  const ctx: FieldValueContext | undefined = props.optionField || pendingField
    ? {
      ownerId: props.ownerId,
      fieldDefId: props.slot.fieldDefId,
      entryId: entry?.type === 'fieldEntry' ? entry.id : undefined,
      optionField: props.optionField,
      descriptor,
      fieldType: optionFieldType,
      constraints,
      autocollect,
      placeholder: valuePlaceholder,
      displayValue: inheritedDefaultText || undefined,
      inheritedDisplayValue: Boolean(inheritedDefaultText),
      materializeValue,
      materializeReference: (id, targetId) => (
        updateFieldValue({
          kind: 'appendReference',
          targetId,
          id,
        })
      ),
      materializeNodes: (id, nodes, firstTagIds) => (
        updateFieldValue({
          kind: 'appendNodes',
          nodes,
          id,
          ...(firstTagIds && firstTagIds.length > 0 ? { firstTagIds } : {}),
        })
      ),
      materializeField: (id) => (
        updateFieldValue({
          kind: 'appendField',
          name: '',
          fieldType: 'plain',
          id,
        })
      ),
      materializeAsset: (id, asset) => (
        mediaKindForMimeType(asset.mimeType) === 'image'
          ? updateFieldValue({
              kind: 'appendImage',
              assetId: asset.id,
              width: asset.imageWidth,
              height: asset.imageHeight,
              name: asset.originalFilename,
              id,
            })
          : updateFieldValue({
              kind: 'appendAttachment',
              ...attachmentNodeInput(asset),
              id,
            })
      ),
      materializeImageUrl: (id, mediaUrl) => (
        updateFieldValue({
          kind: 'appendImage',
          mediaUrl,
          id,
        })
      ),
      onSelectOption: (optionId, id) => (
        updateFieldValue({
          kind: 'selectOption',
          optionNodeId: optionId,
          ...(id ? { id } : {}),
        })
      ),
      commitSlot: () => updateFieldValue({ kind: 'commit' }),
    }
    : undefined;

  return (
    <div
      className={`field-value-outliner field-value-node-preview ${empty ? 'empty' : ''} ${inheritedDefault ? 'has-inherited-default' : ''}`}
      data-field-value
      aria-label={inheritedDefaultText
        ? tf.inheritedDefaultAriaLabel({ value: inheritedDefaultText })
        : empty ? props.placeholder : tf.fieldValueAriaLabel}
    >
      <OutlinerFlatView
        panelId={props.panelId}
        parentId={valueParentId}
        rootId={valueParentId}
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
        fieldValue={ctx}
        rootParent={valueParent}
        trailingDraft={trailingMode}
        draftOwnerKey={fieldSlotId(props.ownerId, props.slot.fieldDefId)}
        pendingDraftPolicy={descriptor.isWholeFieldControl ? 'retain' : 'advance'}
        showViewToolbar={false}
        rowSemanticRole={props.embeddedInGridCell ? 'presentation' : undefined}
        embeddedFlow
      />
      {inheritedDefaultText && !descriptor.isWholeFieldControl ? (
        <span
          aria-hidden="true"
          className="field-value-inherited-default"
        >
          {inheritedDefaultText}
        </span>
      ) : null}
      {inheritedDefaultText && !owner?.locked ? (
        <ButtonControl
          aria-label={tf.acceptInheritedDefault({ value: inheritedDefaultText })}
          className="field-value-inherited-default-accept"
          data-preserve-selection
          onClick={acceptInheritedDefault}
          title={tf.acceptInheritedDefault({ value: inheritedDefaultText })}
        >
          <CheckIcon size={ICON_SIZE.rowGlyph} strokeWidth={2} />
        </ButtonControl>
      ) : null}
    </div>
  );
}
