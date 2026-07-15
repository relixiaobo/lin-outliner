import type { FieldType, NodeId, NodeProjection } from '../../api/types';
import { fieldTypeInteraction, type FieldValueInteraction } from './fieldTypeRegistry';
import type { FieldValueConstraints } from './fieldValueValidation';

// A field-value editor descriptor is the clean spine that maps a field type's
// interaction (read from `fieldTypeRegistry`, never re-derived here) to the few
// behavioural flags the outliner tree needs. Everything is a node: a field value
// is always an editable row that materializes through the injected field create
// command (IME-safe). Field types only add ADDITIVE layers on top of that row —
// an overlay trigger (date picker / options popover), a non-blocking validation
// hint, a link affordance — never a separate editing mode. Checkbox uses a
// whole-field control only while empty; its stored boolean uses a standard row.
export interface FieldValueEditorDescriptor {
  interaction: FieldValueInteraction;
  // Provides a dedicated control while the field has no stored value row.
  isWholeFieldControl: boolean;
  // The value text is validated non-blockingly (a hint, never a rejection).
  validates: boolean;
  // The value renders as an openable link when it is a well-formed url / email.
  isLink: boolean;
}

export function fieldValueEditor(fieldType: FieldType | undefined): FieldValueEditorDescriptor {
  const interaction = fieldTypeInteraction(fieldType);
  return {
    interaction,
    // Checkbox needs an empty-state toggle; once stored, OutlinerItem renders the
    // same toggle inside a normal expandable value row.
    isWholeFieldControl: interaction === 'checkbox',
    validates: interaction === 'numberInput'
      || interaction === 'urlLink'
      || interaction === 'emailLink'
      || interaction === 'datePicker',
    isLink: interaction === 'urlLink' || interaction === 'emailLink',
  };
}

// Runtime context threaded through the prop-drilled tree (there is no React
// context) so OutlinerView / OutlinerItem can make a field value editable like
// body content while routing creates/selects to the field-aware command set.
//
// The editing path is NOT forked: a field value's trailing draft materializes
// exactly like a body node, the only difference being WHICH create command runs.
// `materializeValue` is that injected create — it accepts the renderer's draft
// row id (so React identity / IME survive the draft->value transition, just like
// materializeDraftNode) and routes to the field command set internally
// (createCollectedFieldOption when auto-collecting, else setFieldFreeTextValue;
// a typed text matching an existing option references it, deduped, in core).
export interface FieldValueContext {
  entryId: NodeId;
  optionField: NodeProjection;
  descriptor: FieldValueEditorDescriptor;
  // The concrete field type + numeric constraints, threaded so a value row can
  // drive its additive validation hint / link affordance without re-projecting
  // the field config per row.
  fieldType: FieldType | undefined;
  constraints: FieldValueConstraints;
  autocollect: boolean;
  placeholder: string;
  // Materialize the trailing draft as a field value under `id` carrying `text`.
  // Mirrors api.materializeDraftNode so OutlinerItem's materializeDraft can call
  // it through the same code path with no field-value branch.
  materializeValue: (id: NodeId, text: string) => Promise<unknown>;
  // Append a reference to an existing pool option (the additive options overlay).
  onSelectOption: (optionId: NodeId) => Promise<unknown>;
}
