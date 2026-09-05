import type { FieldType } from '../../api/types';
import {
  CalendarIcon,
  CheckboxIcon,
  EmailIcon,
  NumberFieldIcon,
  ICON_SIZE,
  OptionsIcon,
  PlainTextIcon,
  UrlIcon,
  type AppIcon,
  type IconSize,
} from '../icons';
import { fieldTypeLabel as registryFieldTypeLabel } from '../fields/fieldTypeRegistry';

interface FieldTypeIconProps {
  fieldType?: FieldType;
  size?: IconSize;
}

const FIELD_TYPE_ICONS = {
  plain: PlainTextIcon,
  options: OptionsIcon,
  options_from_supertag: OptionsIcon,
  date: CalendarIcon,
  number: NumberFieldIcon,
  uri: UrlIcon,
  email: EmailIcon,
  checkbox: CheckboxIcon,
} satisfies Record<FieldType, AppIcon>;

export function FieldTypeIcon({ fieldType, size = ICON_SIZE.rowGlyph }: FieldTypeIconProps) {
  const Icon = FIELD_TYPE_ICONS[fieldType ?? 'plain'];
  return <Icon size={size} />;
}

export function fieldTypeLabel(fieldType?: FieldType): string {
  return registryFieldTypeLabel(fieldType);
}
