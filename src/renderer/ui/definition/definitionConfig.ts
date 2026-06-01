import type { FieldType, HideFieldMode, NodeProjection } from '../../api/types';
import { FIELD_TYPE_CONFIG_OPTIONS } from '../fields/fieldTypeRegistry';

/** The projected config fields the panel's visibility predicates depend on. */
export interface DefinitionConfigVisibility {
  fieldType?: FieldType;
  showCheckbox?: boolean;
  doneStateEnabled?: boolean;
}

export type DefinitionKind = 'tag' | 'field';

export type TagConfigKey =
  | 'color'
  | 'extends'
  | 'showCheckbox'
  | 'doneStateEnabled'
  | 'doneMapChecked'
  | 'doneMapUnchecked'
  | 'childSupertag';

export type FieldConfigKey =
  | 'fieldType'
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
  | 'hideField'
  | 'autoInitialize'
  | 'doneMapping'
  | 'number';

export interface DefinitionConfigItem {
  key: DefinitionConfigKey;
  label: string;
  kind: DefinitionKind;
  control: DefinitionConfigControl;
  visibleWhen?: (config: DefinitionConfigVisibility) => boolean;
}

export const HIDE_FIELD_OPTIONS: Array<{ value: HideFieldMode; label: string }> = [
  { value: 'never', label: 'Never' },
  { value: 'empty', label: 'When empty' },
  { value: 'not_empty', label: 'When not empty' },
  { value: 'value_is_default', label: 'When default' },
  { value: 'always', label: 'Always' },
];

export { FIELD_TYPE_CONFIG_OPTIONS };

export const TAG_CONFIG_ITEMS: DefinitionConfigItem[] = [
  { key: 'color', label: 'Color', kind: 'tag', control: 'color' },
  { key: 'extends', label: 'Extend from', kind: 'tag', control: 'tag' },
  { key: 'showCheckbox', label: 'Show as checkbox', kind: 'tag', control: 'switch' },
  {
    key: 'doneStateEnabled',
    label: 'Done state mapping',
    kind: 'tag',
    control: 'switch',
    visibleWhen: (config) => config.showCheckbox ?? false,
  },
  {
    key: 'doneMapChecked',
    label: 'When done, set',
    kind: 'tag',
    control: 'doneMapping',
    visibleWhen: (config) => Boolean(config.showCheckbox && config.doneStateEnabled),
  },
  {
    key: 'doneMapUnchecked',
    label: 'When not done, set',
    kind: 'tag',
    control: 'doneMapping',
    visibleWhen: (config) => Boolean(config.showCheckbox && config.doneStateEnabled),
  },
  { key: 'childSupertag', label: 'Default child supertag', kind: 'tag', control: 'tag' },
];

export const FIELD_CONFIG_ITEMS: DefinitionConfigItem[] = [
  { key: 'fieldType', label: 'Field type', kind: 'field', control: 'fieldType' },
  {
    key: 'sourceSupertag',
    label: 'Supertag',
    kind: 'field',
    control: 'tag',
    visibleWhen: (config) => config.fieldType === 'options_from_supertag',
  },
  {
    key: 'autocollectOptions',
    label: 'Auto-collect values',
    kind: 'field',
    control: 'switch',
    visibleWhen: (config) => config.fieldType === 'options',
  },
  { key: 'autoInitialize', label: 'Auto-initialize', kind: 'field', control: 'autoInitialize' },
  { key: 'required', label: 'Required', kind: 'field', control: 'switch' },
  { key: 'hideField', label: 'Hide field', kind: 'field', control: 'hideField' },
  {
    key: 'minValue',
    label: 'Minimum value',
    kind: 'field',
    control: 'number',
    visibleWhen: (config) => config.fieldType === 'number',
  },
  {
    key: 'maxValue',
    label: 'Maximum value',
    kind: 'field',
    control: 'number',
    visibleWhen: (config) => config.fieldType === 'number',
  },
];

export function definitionKind(node: NodeProjection | undefined): DefinitionKind | null {
  if (node?.type === 'tagDef') return 'tag';
  if (node?.type === 'fieldDef') return 'field';
  return null;
}

export function definitionConfigItems(node: NodeProjection, config: DefinitionConfigVisibility): DefinitionConfigItem[] {
  const items = node.type === 'tagDef' ? TAG_CONFIG_ITEMS : FIELD_CONFIG_ITEMS;
  return items.filter((item) => item.visibleWhen?.(config) ?? true);
}

export function definitionOutlinerLabel(node: NodeProjection, config: DefinitionConfigVisibility): string | null {
  if (node.type === 'tagDef') return 'Default content';
  if (node.type === 'fieldDef' && config.fieldType === 'options') return 'Pre-determined options';
  return null;
}
