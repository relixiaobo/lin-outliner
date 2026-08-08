// The field-type registry is pure data over `core/types`, and both the renderer
// and the core action registry read it — so it lives in core. This module stays
// as the renderer's import path.
export {
  FIELD_TYPE_CONFIG_OPTIONS,
  FIELD_TYPE_REGISTRY,
  fieldTypeInteraction,
  fieldTypeLabel,
  fieldTypeMetadata,
  isOptionsFieldType,
  type FieldTypeMetadata,
  type FieldValueInteraction,
} from '../../../core/fieldTypeRegistry';
