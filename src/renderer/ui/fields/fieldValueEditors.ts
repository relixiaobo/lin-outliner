import type {
  AssetMetadata,
  CommandResult,
  CreateNodeTree,
  FieldType,
  NodeId,
  NodeProjection,
} from '../../api/types';
import { fieldTypeInteraction, type FieldValueInteraction } from './fieldTypeRegistry';
import type { FieldValueConstraints } from './fieldValueValidation';

// A field-value editor descriptor is the clean spine that maps a field type's
// interaction (read from `fieldTypeRegistry`, never re-derived here) to the few
// behavioural flags the outliner tree needs. Everything is a node: a field value
// is always an editable row that materializes through the injected field create
// command (IME-safe). Field types only add ADDITIVE layers on top of that row —
// an overlay trigger (date picker / options popover), a non-blocking validation
// hint, a link affordance — never a separate editing mode. Checkbox keeps the
// same boolean control inside the shared draft/value row for its entire lifecycle.
export interface FieldValueEditorDescriptor {
  interaction: FieldValueInteraction;
  // Replaces the row's text surface with a dedicated whole-value control.
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
// context) so OutlinerFlatView / OutlinerItem can make a field value editable like
// body content while routing creates/selects to the field-aware command set.
//
// The editing path is NOT forked: a field value's trailing draft materializes
// exactly like a body node, the only difference being WHICH create command runs.
// `materializeValue` is that injected create — it accepts the renderer's draft
// row id (so React identity / IME survive the draft->value transition, just like
// materializeDraftNode) and routes through updateFieldSlot. Auto-collected text
// that matches an existing option is deduped into a reference in core.
export interface FieldValueContext {
  ownerId: NodeId;
  fieldDefId: NodeId;
  entryId?: NodeId;
  optionField?: NodeProjection;
  descriptor: FieldValueEditorDescriptor;
  // The concrete field type + numeric constraints, threaded so a value row can
  // drive its additive validation hint / link affordance without re-projecting
  // the field config per row.
  fieldType: FieldType | undefined;
  constraints: FieldValueConstraints;
  autocollect: boolean;
  placeholder: string;
  displayValue?: string;
  inheritedDisplayValue?: boolean;
  // Source previews belong either to the drilled root page, the ordinary
  // Outline field value, or no rich surface (dense table/calendar cells).
  sourcePreviewPlacement?: 'page' | 'outline' | 'none';
  // Materialize the trailing draft as a field value under `id` carrying `text`.
  // Mirrors api.materializeDraftNode so OutlinerItem's materializeDraft can call
  // it through the same code path with no field-value branch.
  materializeValue: (id: NodeId, text: string) => Promise<CommandResult>;
  materializeReference: (id: NodeId, targetId: NodeId) => Promise<CommandResult>;
  materializeNodes: (
    id: NodeId,
    nodes: CreateNodeTree[],
    firstTagIds?: NodeId[],
  ) => Promise<CommandResult>;
  materializeField: (id: NodeId) => Promise<CommandResult>;
  materializeAsset: (id: NodeId, asset: AssetMetadata) => Promise<CommandResult>;
  materializeImageUrl: (id: NodeId, mediaUrl: string) => Promise<CommandResult>;
  // Append a reference to an existing pool option (the additive options overlay).
  onSelectOption: (optionId: NodeId, id?: NodeId) => Promise<CommandResult>;
  commitSlot: () => Promise<CommandResult>;
}
