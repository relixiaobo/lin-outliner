import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { projectFieldConfig } from '../../../core/configProjection';
import { freshNodeId } from '../../../core/nodeId';
import { mediaKindForMimeType } from '../../../core/mediaKind';
import { fieldSlotsForIndex, type DocumentIndex, type UiState } from '../../state/document';
import { fieldValueEditor, type FieldValueContext } from '../fields/fieldValueEditors';
import { requestFocusState, rowFocusTarget } from '../focus/focusModel';
import { attachmentNodeInput } from '../interactions/attachmentIngest';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { OutlinerView } from './OutlinerView';
import { buildOutlinerRows, viewFieldValuesFor } from './row-model';
import { CheckboxFieldControl } from './CheckboxFieldControl';
import { useT } from '../../i18n/I18nProvider';
import { fieldSlotHasInheritedDefault, type NodeFieldSlot } from '../../../core/fieldSlots';
import { EMPTY_RICH_TEXT } from '../../api/types';

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
  const materializeValue = (id: NodeId, text: string) => (
    api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
      kind: 'appendText',
      text,
      id,
      ...(entry ? { entryId: entry.id } : {}),
      ...(autocollect ? { collect: true } : {}),
    })
  );

  // An empty checkbox field needs a toggle even though there is no stored value
  // row yet. Once toggled, its value is rendered by OutlinerView like every other
  // stored value so it gains disclosure, ordinary children, and structural keys.
  const showEmptyWholeFieldControl = Boolean(
    props.optionField
    && descriptor.isWholeFieldControl
    && empty
    && !inheritedDefault
  );

  const acceptInheritedDefault = () => {
    if (!inheritedDefault || owner?.locked) return;
    void props.run(() => api.updateFieldSlot(
      props.ownerId,
      props.slot.fieldDefId,
      { kind: 'acceptDefault' },
    ));
  };

  const createWholeFieldValue = async (value: string) => {
    const valueId = freshNodeId();
    const result = await props.run(() => api.updateFieldSlot(
      props.ownerId,
      props.slot.fieldDefId,
      {
        kind: 'appendText',
        text: value,
        id: valueId,
        ...(entry ? { entryId: entry.id } : {}),
      },
    ), { applyFocus: false });
    if (result && 'update' in result && result.focus?.nodeId) {
      props.setUi((previous) => requestFocusState(
        previous,
        rowFocusTarget(valueId, result.focus!.nodeId, props.panelId),
      ));
    }
    return result;
  };

  // Everything is a node: the value area always offers a trailing draft as the
  // uniform entry point for the next value (shown when empty or when nav focuses
  // the trailing surface). Values always append — there is no cardinality gate.
  const trailingMode = 'auto' as const;

  const ctx: FieldValueContext | undefined = props.optionField
    ? {
      ownerId: props.ownerId,
      entryId: entry?.type === 'fieldEntry' ? entry.id : undefined,
      optionField: props.optionField,
      descriptor,
      fieldType: optionFieldType,
      constraints,
      autocollect,
      placeholder: valuePlaceholder,
      materializeValue,
      materializeReference: (id, targetId) => (
        api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
          kind: 'appendReference',
          targetId,
          id,
          ...(entry ? { entryId: entry.id } : {}),
        })
      ),
      materializeNodes: (id, nodes, firstTagIds) => (
        api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
          kind: 'appendNodes',
          nodes,
          id,
          ...(firstTagIds && firstTagIds.length > 0 ? { firstTagIds } : {}),
          ...(entry ? { entryId: entry.id } : {}),
        })
      ),
      materializeField: (id) => (
        api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
          kind: 'appendField',
          name: '',
          fieldType: 'plain',
          id,
          ...(entry ? { entryId: entry.id } : {}),
        })
      ),
      materializeAsset: (id, asset) => (
        mediaKindForMimeType(asset.mimeType) === 'image'
          ? api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
              kind: 'appendImage',
              assetId: asset.id,
              width: asset.imageWidth,
              height: asset.imageHeight,
              name: asset.originalFilename,
              id,
              ...(entry ? { entryId: entry.id } : {}),
            })
          : api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
              kind: 'appendAttachment',
              ...attachmentNodeInput(asset),
              id,
              ...(entry ? { entryId: entry.id } : {}),
            })
      ),
      materializeImageUrl: (id, mediaUrl) => (
        api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
          kind: 'appendImage',
          mediaUrl,
          id,
          ...(entry ? { entryId: entry.id } : {}),
        })
      ),
      onSelectOption: (optionId) => (
        api.updateFieldSlot(props.ownerId, props.slot.fieldDefId, {
          kind: 'selectOption',
          optionNodeId: optionId,
          ...(entry ? { entryId: entry.id } : {}),
        })
      ),
      commitSlot: () => api.updateFieldSlot(
        props.ownerId,
        props.slot.fieldDefId,
        { kind: 'commit', ...(entry ? { entryId: entry.id } : {}) },
      ),
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
      {showEmptyWholeFieldControl ? (
        <CheckboxFieldControl
          entryId={entry?.type === 'fieldEntry' ? entry.id : undefined}
          onCreateValue={createWholeFieldValue}
          run={props.run}
        />
      ) : (
        <OutlinerView
          panelId={props.panelId}
          parentId={valueParentId}
          parentOverride={entry ? undefined : valueParent}
          rootId={valueParentId}
          selectionRootId={props.selectionRootId}
          onRoot={props.onRoot}
          depth={0}
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
          referencePath={[valueParentId]}
          fieldValue={ctx}
          trailingDraft={trailingMode}
          showViewToolbar={false}
          rowSemanticRole={props.embeddedInGridCell ? 'presentation' : undefined}
        />
      )}
      {inheritedDefaultText ? (
        <button
          aria-label={tf.acceptInheritedDefault({ value: inheritedDefaultText })}
          className="field-value-inherited-default"
          disabled={owner?.locked}
          onClick={acceptInheritedDefault}
          title={tf.acceptInheritedDefault({ value: inheritedDefaultText })}
          type="button"
        >
          {inheritedDefaultText}
        </button>
      ) : null}
    </div>
  );
}
