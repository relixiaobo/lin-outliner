import type { ComponentType } from 'react';
import type { FieldType } from '../../api/types';
import {
  CalendarIcon,
  CheckboxIcon,
  EmailIcon,
  HashIcon,
  ICON_SIZE,
  OptionsIcon,
  PlainTextIcon,
  UrlIcon,
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
  url: UrlIcon,
  email: EmailIcon,
  checkbox: CheckboxIcon,
} satisfies Record<FieldType, FieldIconComponent>;

export function FieldTypeIcon({ fieldType, size = ICON_SIZE.rowGlyph }: FieldTypeIconProps) {
  const Icon = FIELD_TYPE_ICONS[fieldType ?? 'plain'] ?? PlainTextIcon;
  return <Icon size={size} />;
}

export function fieldTypeLabel(fieldType?: FieldType): string {
  return registryFieldTypeLabel(fieldType);
}
