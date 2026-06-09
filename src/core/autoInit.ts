import type { AutoInitStrategy, FieldType } from './types';

// The auto-init strategies offered per field type — the single source shared by
// core (which prunes stale strategies when a field's type changes) and the
// renderer's Auto-initialize picker. A date field can self-seed three ways; an
// options-from-supertag field inherits one; every other type falls back to
// inheriting an ancestor field value.
const AUTO_INIT_BY_FIELD_TYPE: Partial<Record<FieldType, AutoInitStrategy[]>> = {
  date: ['current_date', 'ancestor_day_node', 'ancestor_field_value'],
  options_from_supertag: ['ancestor_supertag_ref'],
};

export function autoInitStrategiesForFieldType(fieldType: FieldType | undefined): AutoInitStrategy[] {
  return AUTO_INIT_BY_FIELD_TYPE[fieldType ?? 'plain'] ?? ['ancestor_field_value'];
}
