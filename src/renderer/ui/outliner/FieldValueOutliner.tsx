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
import { useT } from '../../i18n/I18nProvider';

interface FieldValueOutlinerProps {
  panelId: string;
  entryId: NodeId;
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
  const entry = props.index.byId.get(props.entryId);
  const rows = buildOutlinerRows(entry, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  });
  const empty = rows.length === 0;
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

  // An empty checkbox field needs a toggle even though there is no stored value
  // row yet. Once toggled, its value is rendered by OutlinerView like every other
  // stored value so it gains disclosure, ordinary children, and structural keys.
  const showEmptyWholeFieldControl = Boolean(
    props.optionField
    && descriptor.isWholeFieldControl
    && empty,
  );

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
      aria-label={empty ? props.placeholder : tf.fieldValueAriaLabel}
    >
      {showEmptyWholeFieldControl ? (
        <CheckboxFieldControl
          entryId={props.entryId}
          run={props.run}
        />
      ) : (
        <OutlinerView
          panelId={props.panelId}
          parentId={props.entryId}
          rootId={props.entryId}
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
          referencePath={[props.entryId]}
          fieldValue={ctx}
          trailingDraft={trailingMode}
          showViewToolbar={false}
          rowSemanticRole={props.embeddedInGridCell ? 'presentation' : undefined}
        />
      )}
    </div>
  );
}
