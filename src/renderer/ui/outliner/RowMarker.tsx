import type { ComponentType, CSSProperties } from 'react';
import type { FieldType } from '../../api/types';
import { conicColorStyle } from '../tags/tagColors';
import { ICON_SIZE } from '../icons';
import { INLINE_FILE_ICON_CLASS } from '../editor/inlineFileIcon';
import { FieldTypeIcon } from './fieldTypePresentation';
import { NodeBulletDot } from './NodeBulletDot';

export type RowMarkerVariant = 'content' | 'reference' | 'tag' | 'field' | 'fieldDef' | 'file';

interface RowMarkerProps {
  hasChildren: boolean;
  expanded: boolean;
  variant: RowMarkerVariant;
  fieldType?: FieldType;
  // An explicit marker icon for a field-variant row, overriding the field-type
  // glyph. System fields use it (e.g. the command Schedule / Agent rows) so they
  // carry a meaningful icon instead of the default plain-text one.
  icon?: ComponentType<{ size?: number }>;
  bulletColors?: readonly string[];
  tagDefColor?: string;
  // The file-type glyph kind for a `file`-variant bullet (a file node shows its
  // type icon as the bullet instead of the neutral dot).
  fileIconKind?: string;
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
  fileIconKind,
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
        <span aria-hidden="true" className="row-bullet-tag-glyph">#</span>
      ) : variant === 'file' ? (
        <span aria-hidden="true" className={INLINE_FILE_ICON_CLASS} data-file-icon-kind={fileIconKind} />
      ) : (
        <NodeBulletDot style={bulletDotStyle} />
      )}
    </span>
  );
}
