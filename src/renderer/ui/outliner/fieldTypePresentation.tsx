import type { ComponentType } from 'react';
import type { FieldType } from '../../api/types';
import {
  BooleanIcon,
  CalendarIcon,
  CheckboxIcon,
  ColorIcon,
  EmailIcon,
  FormulaIcon,
  HashIcon,
  ICON_SIZE,
  OptionsIcon,
  PasswordIcon,
  PlainTextIcon,
  UrlIcon,
  UserIcon,
} from '../icons';
import { fieldTypeLabel as registryFieldTypeLabel } from '../fields/fieldTypeRegistry';

interface FieldTypeIconProps {
  fieldType?: FieldType;
  size?: number;
}

type FieldIconComponent = ComponentType<{ size?: number }>;

const FIELD_TYPE_ICONS = {
  plain: PlainTextIcon,
  options: OptionsIcon,
  options_from_supertag: OptionsIcon,
  date: CalendarIcon,
  number: HashIcon,
  password: PasswordIcon,
  formula: FormulaIcon,
  user: UserIcon,
  url: UrlIcon,
  email: EmailIcon,
  checkbox: CheckboxIcon,
  boolean: BooleanIcon,
  color: ColorIcon,
} satisfies Record<FieldType, FieldIconComponent>;

export function FieldTypeIcon({ fieldType, size = ICON_SIZE.rowGlyph }: FieldTypeIconProps) {
  const Icon = FIELD_TYPE_ICONS[fieldType ?? 'plain'];
  return <Icon size={size} />;
}

export function fieldTypeLabel(fieldType?: FieldType): string {
  return registryFieldTypeLabel(fieldType);
}
