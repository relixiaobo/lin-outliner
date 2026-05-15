import type { CSSProperties } from 'react';
import type { FieldType } from '../../api/types';
import { conicColorStyle } from '../tags/tagColors';
import { FieldTypeIcon } from './fieldTypePresentation';
import { NodeBulletDot } from './NodeBulletDot';

export type RowMarkerVariant = 'content' | 'reference' | 'tag' | 'field' | 'fieldDef';

interface RowMarkerProps {
  hasChildren: boolean;
  expanded: boolean;
  variant: RowMarkerVariant;
  fieldType?: FieldType;
  bulletColors?: readonly string[];
  tagDefColor?: string;
  className?: string;
}

export function RowMarker({
  hasChildren,
  expanded,
  variant,
  fieldType,
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
        <FieldTypeIcon fieldType={fieldType} />
      ) : variant === 'tag' ? (
        <span aria-hidden="true" className="row-bullet-tag-glyph">#</span>
      ) : (
        <NodeBulletDot style={bulletDotStyle} />
      )}
    </span>
  );
}
