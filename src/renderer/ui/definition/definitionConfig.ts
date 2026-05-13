import type { FieldType, HideFieldMode, NodeProjection } from '../../api/types';

export type DefinitionKind = 'tag' | 'field';

export type TagConfigKey =
  | 'color'
  | 'extends'
  | 'showCheckbox'
  | 'doneStateEnabled'
  | 'childSupertag';

export type FieldConfigKey =
  | 'fieldType'
  | 'sourceSupertag'
  | 'autocollectOptions'
  | 'required'
  | 'hideField'
  | 'minValue'
  | 'maxValue';

export type DefinitionConfigKey = TagConfigKey | FieldConfigKey;

export interface DefinitionConfigItem {
  key: DefinitionConfigKey;
  label: string;
  kind: DefinitionKind;
  visibleWhen?: (node: NodeProjection) => boolean;
}

export const HIDE_FIELD_OPTIONS: Array<{ value: HideFieldMode; label: string }> = [
  { value: 'never', label: 'Never' },
  { value: 'empty', label: 'When empty' },
  { value: 'not_empty', label: 'When not empty' },
  { value: 'value_is_default', label: 'When default' },
  { value: 'always', label: 'Always' },
];

export const FIELD_TYPE_CONFIG_OPTIONS: FieldType[] = [
  'plain',
  'date',
  'number',
  'url',
  'email',
  'checkbox',
  'boolean',
  'options',
  'options_from_supertag',
  'color',
];

export const TAG_CONFIG_ITEMS: DefinitionConfigItem[] = [
  { key: 'color', label: 'Color', kind: 'tag' },
  { key: 'extends', label: 'Extend from', kind: 'tag' },
  { key: 'showCheckbox', label: 'Show as checkbox', kind: 'tag' },
  {
    key: 'doneStateEnabled',
    label: 'Done state mapping',
    kind: 'tag',
    visibleWhen: (node) => node.showCheckbox,
  },
  { key: 'childSupertag', label: 'Default child supertag', kind: 'tag' },
];

export const FIELD_CONFIG_ITEMS: DefinitionConfigItem[] = [
  { key: 'fieldType', label: 'Field type', kind: 'field' },
  {
    key: 'sourceSupertag',
    label: 'Supertag',
    kind: 'field',
    visibleWhen: (node) => node.fieldType === 'options_from_supertag',
  },
  {
    key: 'autocollectOptions',
    label: 'Auto-collect values',
    kind: 'field',
    visibleWhen: (node) => node.fieldType === 'options',
  },
  { key: 'required', label: 'Required', kind: 'field' },
  { key: 'hideField', label: 'Hide field', kind: 'field' },
  {
    key: 'minValue',
    label: 'Minimum value',
    kind: 'field',
    visibleWhen: (node) => node.fieldType === 'number',
  },
  {
    key: 'maxValue',
    label: 'Maximum value',
    kind: 'field',
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
