import type { CSSProperties } from 'react';
import type { FieldType } from '../../api/types';
import { conicColorStyle } from '../tags/tagColors';
import { ICON_SIZE, SupertagIcon, type AppIcon } from '../icons';
import { FieldTypeIcon } from './fieldTypePresentation';
import { NodeBulletDot } from './NodeBulletDot';

export type RowMarkerVariant = 'content' | 'reference' | 'tag' | 'field' | 'fieldDef';

interface RowMarkerProps {
  hasChildren: boolean;
  expanded: boolean;
  variant: RowMarkerVariant;
  fieldType?: FieldType;
  // An explicit marker icon for a field-variant row, overriding the field-type
  // glyph. System fields use it (e.g. the command Schedule / Agent rows) so they
  // carry a meaningful icon instead of the default plain-text one.
  icon?: AppIcon;
  bulletColors?: readonly string[];
  tagDefColor?: string;
  className?: string;
}

export function RowMarker({
  hasChildren,
  expanded,
  variant,
  fieldType,
  icon: Icon,
  bulletColors = [],
  tagDefColor,
  className,
}: RowMarkerProps) {
  const bulletClass = [
    'row-bullet-shape',
    variant,
    hasChildren ? 'has-children' : '',
    hasChildren && !expanded ? 'collapsed' : '',
    expanded ? 'expanded' : '',
    className,
  ].filter(Boolean).join(' ');

  const bulletDotStyle = conicColorStyle(bulletColors);
  let bulletShapeStyle: CSSProperties | undefined;
  if (variant === 'tag' && tagDefColor) {
    bulletShapeStyle = { background: tagDefColor };
  } else if ((variant === 'field' || variant === 'fieldDef') && bulletColors[0]) {
    bulletShapeStyle = { color: bulletColors[0] };
  }

  return (
    <span className={bulletClass} style={bulletShapeStyle}>
      {variant === 'field' || variant === 'fieldDef' ? (
        Icon ? <Icon size={ICON_SIZE.rowGlyph} /> : <FieldTypeIcon fieldType={fieldType} />
      ) : variant === 'tag' ? (
        <SupertagIcon className="row-bullet-tag-glyph" size={ICON_SIZE.rowGlyph} />
      ) : (
        <NodeBulletDot style={bulletDotStyle} />
      )}
    </span>
  );
}
