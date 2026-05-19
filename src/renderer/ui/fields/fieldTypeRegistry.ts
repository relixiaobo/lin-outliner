import type { FieldType } from '../../api/types';

export type FieldValueInteraction =
  | 'outliner'
  | 'optionPicker'
  | 'datePicker'
  | 'numberInput'
  | 'passwordInput'
  | 'urlLink'
  | 'emailLink'
  | 'checkbox'
  | 'boolean'
  | 'colorPicker'
  | 'reserved';

export interface FieldTypeMetadata {
  id: FieldType;
  label: string;
  interaction: FieldValueInteraction;
  exposedInConfig: boolean;
}

export const FIELD_TYPE_REGISTRY = {
  plain: {
    id: 'plain',
    label: 'plain',
    interaction: 'outliner',
    exposedInConfig: true,
  },
  options: {
    id: 'options',
    label: 'options',
    interaction: 'optionPicker',
    exposedInConfig: true,
  },
  options_from_supertag: {
    id: 'options_from_supertag',
    label: 'options from tag',
    interaction: 'optionPicker',
    exposedInConfig: true,
  },
  date: {
    id: 'date',
    label: 'date',
    interaction: 'datePicker',
    exposedInConfig: true,
  },
  number: {
    id: 'number',
    label: 'number',
    interaction: 'numberInput',
    exposedInConfig: true,
  },
  password: {
    id: 'password',
    label: 'password',
    interaction: 'passwordInput',
    exposedInConfig: true,
  },
  formula: {
    id: 'formula',
    label: 'formula',
    interaction: 'reserved',
    exposedInConfig: false,
  },
  user: {
    id: 'user',
    label: 'user',
    interaction: 'reserved',
    exposedInConfig: false,
  },
  url: {
    id: 'url',
    label: 'url',
    interaction: 'urlLink',
    exposedInConfig: true,
  },
  email: {
    id: 'email',
    label: 'email',
    interaction: 'emailLink',
    exposedInConfig: true,
  },
  checkbox: {
    id: 'checkbox',
    label: 'checkbox',
    interaction: 'checkbox',
    exposedInConfig: true,
  },
  boolean: {
    id: 'boolean',
    label: 'boolean',
    interaction: 'boolean',
    exposedInConfig: true,
  },
  color: {
    id: 'color',
    label: 'color',
    interaction: 'colorPicker',
    exposedInConfig: true,
  },
} satisfies Record<FieldType, FieldTypeMetadata>;

export const FIELD_TYPE_CONFIG_OPTIONS = (Object.keys(FIELD_TYPE_REGISTRY) as FieldType[])
  .filter((fieldType) => FIELD_TYPE_REGISTRY[fieldType].exposedInConfig);

export function fieldTypeMetadata(fieldType: FieldType | undefined): FieldTypeMetadata {
  return FIELD_TYPE_REGISTRY[fieldType ?? 'plain'];
}

export function fieldTypeLabel(fieldType: FieldType | undefined): string {
  return fieldTypeMetadata(fieldType).label;
}

export function fieldTypeInteraction(fieldType: FieldType | undefined): FieldValueInteraction {
  return fieldTypeMetadata(fieldType).interaction;
}

export function isOptionsFieldType(fieldType: FieldType | undefined): boolean {
  return fieldTypeInteraction(fieldType) === 'optionPicker';
}
