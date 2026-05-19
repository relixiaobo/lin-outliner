import type { FieldCardinality, HideFieldMode, NodeProjection } from '../../api/types';
import { FIELD_TYPE_CONFIG_OPTIONS } from '../fields/fieldTypeRegistry';

export type DefinitionKind = 'tag' | 'field';

export type TagConfigKey =
  | 'color'
  | 'extends'
  | 'showCheckbox'
  | 'doneStateEnabled'
  | 'childSupertag';

export type FieldConfigKey =
  | 'fieldType'
  | 'cardinality'
  | 'sourceSupertag'
  | 'autocollectOptions'
  | 'autoInitialize'
  | 'required'
  | 'hideField'
  | 'minValue'
  | 'maxValue';

export type DefinitionConfigKey = TagConfigKey | FieldConfigKey;
export type DefinitionConfigControl =
  | 'color'
  | 'tag'
  | 'switch'
  | 'fieldType'
  | 'cardinality'
  | 'hideField'
  | 'autoInitialize'
  | 'number';

export interface DefinitionConfigItem {
  key: DefinitionConfigKey;
  label: string;
  kind: DefinitionKind;
  control: DefinitionConfigControl;
  visibleWhen?: (node: NodeProjection) => boolean;
}

export const HIDE_FIELD_OPTIONS: Array<{ value: HideFieldMode; label: string }> = [
  { value: 'never', label: 'Never' },
  { value: 'empty', label: 'When empty' },
  { value: 'not_empty', label: 'When not empty' },
  { value: 'value_is_default', label: 'When default' },
  { value: 'always', label: 'Always' },
];

export { FIELD_TYPE_CONFIG_OPTIONS };

export const FIELD_CARDINALITY_OPTIONS: Array<{ value: FieldCardinality; label: string }> = [
  { value: 'single', label: 'Single value' },
  { value: 'list', label: 'List of values' },
];

export const TAG_CONFIG_ITEMS: DefinitionConfigItem[] = [
  { key: 'color', label: 'Color', kind: 'tag', control: 'color' },
  { key: 'extends', label: 'Extend from', kind: 'tag', control: 'tag' },
  { key: 'showCheckbox', label: 'Show as checkbox', kind: 'tag', control: 'switch' },
  {
    key: 'doneStateEnabled',
    label: 'Done state mapping',
    kind: 'tag',
    control: 'switch',
    visibleWhen: (node) => node.showCheckbox,
  },
  { key: 'childSupertag', label: 'Default child supertag', kind: 'tag', control: 'tag' },
];

export const FIELD_CONFIG_ITEMS: DefinitionConfigItem[] = [
  { key: 'fieldType', label: 'Field type', kind: 'field', control: 'fieldType' },
  { key: 'cardinality', label: 'Cardinality', kind: 'field', control: 'cardinality' },
  {
    key: 'sourceSupertag',
    label: 'Supertag',
    kind: 'field',
    control: 'tag',
    visibleWhen: (node) => node.fieldType === 'options_from_supertag',
  },
  {
    key: 'autocollectOptions',
    label: 'Auto-collect values',
    kind: 'field',
    control: 'switch',
    visibleWhen: (node) => node.fieldType === 'options',
  },
  { key: 'autoInitialize', label: 'Auto-initialize', kind: 'field', control: 'autoInitialize' },
  { key: 'required', label: 'Required', kind: 'field', control: 'switch' },
  { key: 'hideField', label: 'Hide field', kind: 'field', control: 'hideField' },
  {
    key: 'minValue',
    label: 'Minimum value',
    kind: 'field',
    control: 'number',
    visibleWhen: (node) => node.fieldType === 'number',
  },
  {
    key: 'maxValue',
    label: 'Maximum value',
    kind: 'field',
    control: 'number',
    visibleWhen: (node) => node.fieldType === 'number',
  },
];

export function definitionKind(node: NodeProjection | undefined): DefinitionKind | null {
  if (node?.type === 'tagDef') return 'tag';
  if (node?.type === 'fieldDef') return 'field';
  return null;
}

export function definitionConfigItems(node: NodeProjection): DefinitionConfigItem[] {
  const items = node.type === 'tagDef' ? TAG_CONFIG_ITEMS : FIELD_CONFIG_ITEMS;
  return items.filter((item) => item.visibleWhen?.(node) ?? true);
}

export function definitionOutlinerLabel(node: NodeProjection): string | null {
  if (node.type === 'tagDef') return 'Default content';
  if (node.type === 'fieldDef' && node.fieldType === 'options') return 'Pre-determined options';
  return null;
}
