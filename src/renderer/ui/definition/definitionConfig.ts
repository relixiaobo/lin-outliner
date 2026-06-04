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

/**
 * User-facing labels resolved by the component (via `useT`) and passed into the
 * pure item/option builders below — these run outside React, so they can't call
 * `useT` themselves. Shape mirrors the `definition.*` i18n namespace.
 */
export interface DefinitionConfigLabels {
  tagConfig: Record<TagConfigKey, string>;
  fieldConfig: Record<FieldConfigKey, string>;
  hideFieldOptions: Record<HideFieldMode, string>;
  outliner: { defaultContent: string; predeterminedOptions: string };
}

export function hideFieldOptions(
  labels: DefinitionConfigLabels['hideFieldOptions'],
): Array<{ value: HideFieldMode; label: string }> {
  return [
    { value: 'never', label: labels.never },
    { value: 'empty', label: labels.empty },
    { value: 'not_empty', label: labels.not_empty },
    { value: 'value_is_default', label: labels.value_is_default },
    { value: 'always', label: labels.always },
  ];
}

export { FIELD_TYPE_CONFIG_OPTIONS };

export function tagConfigItems(labels: DefinitionConfigLabels['tagConfig']): DefinitionConfigItem[] {
  return [
    { key: 'color', label: labels.color, kind: 'tag', control: 'color' },
    { key: 'extends', label: labels.extends, kind: 'tag', control: 'tag' },
    { key: 'showCheckbox', label: labels.showCheckbox, kind: 'tag', control: 'switch' },
    {
      key: 'doneStateEnabled',
      label: labels.doneStateEnabled,
      kind: 'tag',
      control: 'switch',
      visibleWhen: (config) => config.showCheckbox ?? false,
    },
    {
      key: 'doneMapChecked',
      label: labels.doneMapChecked,
      kind: 'tag',
      control: 'doneMapping',
      visibleWhen: (config) => Boolean(config.showCheckbox && config.doneStateEnabled),
    },
    {
      key: 'doneMapUnchecked',
      label: labels.doneMapUnchecked,
      kind: 'tag',
      control: 'doneMapping',
      visibleWhen: (config) => Boolean(config.showCheckbox && config.doneStateEnabled),
    },
    { key: 'childSupertag', label: labels.childSupertag, kind: 'tag', control: 'tag' },
  ];
}

export function fieldConfigItems(labels: DefinitionConfigLabels['fieldConfig']): DefinitionConfigItem[] {
  return [
    { key: 'fieldType', label: labels.fieldType, kind: 'field', control: 'fieldType' },
    {
      key: 'sourceSupertag',
      label: labels.sourceSupertag,
      kind: 'field',
      control: 'tag',
      visibleWhen: (config) => config.fieldType === 'options_from_supertag',
    },
    {
      key: 'autocollectOptions',
      label: labels.autocollectOptions,
      kind: 'field',
      control: 'switch',
      visibleWhen: (config) => config.fieldType === 'options',
    },
    { key: 'autoInitialize', label: labels.autoInitialize, kind: 'field', control: 'autoInitialize' },
    { key: 'required', label: labels.required, kind: 'field', control: 'switch' },
    { key: 'hideField', label: labels.hideField, kind: 'field', control: 'hideField' },
    {
      key: 'minValue',
      label: labels.minValue,
      kind: 'field',
      control: 'number',
      visibleWhen: (config) => config.fieldType === 'number',
    },
    {
      key: 'maxValue',
      label: labels.maxValue,
      kind: 'field',
      control: 'number',
      visibleWhen: (config) => config.fieldType === 'number',
    },
  ];
}

export function definitionKind(node: NodeProjection | undefined): DefinitionKind | null {
  if (node?.type === 'tagDef') return 'tag';
  if (node?.type === 'fieldDef') return 'field';
  return null;
}

export function definitionConfigItems(
  node: NodeProjection,
  config: DefinitionConfigVisibility,
  labels: DefinitionConfigLabels,
): DefinitionConfigItem[] {
  const items = node.type === 'tagDef' ? tagConfigItems(labels.tagConfig) : fieldConfigItems(labels.fieldConfig);
  return items.filter((item) => item.visibleWhen?.(config) ?? true);
}

export function definitionOutlinerLabel(
  node: NodeProjection,
  config: DefinitionConfigVisibility,
  labels: DefinitionConfigLabels['outliner'],
): string | null {
  if (node.type === 'tagDef') return labels.defaultContent;
  if (node.type === 'fieldDef' && config.fieldType === 'options') return labels.predeterminedOptions;
  return null;
}
