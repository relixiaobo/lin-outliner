import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { projectFieldConfig } from '../../../core/configProjection';
import type { DocumentIndex, UiState } from '../../state/document';
import { fieldValueEditor, type FieldValueContext } from '../fields/fieldValueEditors';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { OutlinerView } from './OutlinerView';
import { buildOutlinerRows } from './row-model';
import { CheckboxFieldControl } from './CheckboxFieldControl';

interface FieldValueOutlinerProps {
  panelId: string;
  entryId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  index: DocumentIndex;
  ui: UiState;
  uiRef: MutableRefObject<UiState>;
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
  const empty = rows.length === 0;
  const singleValueNode = rows.length === 1 ? props.index.byId.get(rows[0].id) : undefined;
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
  // Space — surface that affordance through the placeholder, mirroring the
  // reference date interaction the design follows.
  const valuePlaceholder = descriptor.interaction === 'datePicker'
    ? 'Press Space to pick a date…'
    : props.placeholder;

  // Materialize the trailing draft as a field value, carrying the renderer's
  // draft row id so the row keeps its React identity (and IME) through the
  // draft->value transition — the same contract as api.materializeDraftNode, so
  // OutlinerItem's materializeDraft drives both through one unified path.
  //
  // applyFocus:false is essential: these field commands return focus(fieldEntryId),
  // which (via the async pendingFocus effect) would otherwise override the
  // renderer's own post-materialize focus on the next trailing draft, making the
  // cursor vanish. The renderer owns focus after a field value commit, not core.
  //
  // Auto-collect decides routing: on -> createCollectedFieldOption (joins the
  // reusable pool; a typed name matching an existing option is deduped into a
  // reference in core); off -> setFieldFreeTextValue (a plain value on this entry
  // alone). Both append — everything is a node, there is no cardinality gate.
  const materializeValue = (id: NodeId, text: string) => (
    props.run(() => (
      autocollect
        ? api.createCollectedFieldOption(props.entryId, text, id)
        : api.setFieldFreeTextValue(props.entryId, text, id)
    ), { applyFocus: false })
  );

  // Only checkbox renders as a dedicated whole-field control; everything else
  // (plain / options / date / number / url / email) is an editable row through
  // OutlinerView, with field types layering additive overlays (date picker,
  // options popover) / validation hints / link affordances on top (see
  // FieldValueEditorDescriptor).
  const canUseWholeFieldControl = Boolean(props.optionField && descriptor.isWholeFieldControl);

  // Everything is a node: the value area always offers a trailing draft as the
  // uniform entry point for the next value (shown when empty or when nav focuses
  // the trailing surface). Values always append — there is no cardinality gate.
  const trailingMode = 'auto' as const;

  const ctx: FieldValueContext | undefined = props.optionField
    ? {
      entryId: props.entryId,
      optionField: props.optionField,
      descriptor,
      fieldType: optionFieldType,
      constraints,
      autocollect,
      placeholder: valuePlaceholder,
      materializeValue,
      onSelectOption: (optionId) => (
        props.run(() => api.selectFieldOption(props.entryId, optionId), { applyFocus: false })
      ),
    }
    : undefined;

  return (
    <div
      className={`field-value-outliner field-value-node-preview ${empty ? 'empty' : ''}`}
      data-field-value
      aria-label={empty ? props.placeholder : 'Field value'}
    >
      {canUseWholeFieldControl && props.optionField ? (
        <CheckboxFieldControl
          entryId={props.entryId}
          run={props.run}
          valueNode={singleValueNode}
        />
      ) : (
        <OutlinerView
          panelId={props.panelId}
          parentId={props.entryId}
          rootId={props.entryId}
          onRoot={props.onRoot}
          depth={0}
          index={props.index}
          ui={props.ui}
          uiRef={props.uiRef}
          setUi={props.setUi}
          run={props.run}
          trigger={props.trigger}
          setTrigger={props.setTrigger}
          dragId={props.dragId}
          setDragId={props.setDragId}
          referencePath={[props.entryId]}
          fieldValue={ctx}
          trailingDraft={trailingMode}
          showViewToolbar={false}
        />
      )}
    </div>
  );
}
