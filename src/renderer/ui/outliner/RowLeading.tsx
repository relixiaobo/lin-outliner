import type { CSSProperties, DragEvent } from 'react';
import type { FieldType } from '../../api/types';
import {
  ChevronRightIcon,
  ICON_SIZE,
} from '../icons';
import { conicColorStyle } from '../tags/tagColors';
import { FieldTypeIcon } from './fieldTypePresentation';
import { NodeBulletDot } from './NodeBulletDot';

type RowLeadingVariant = 'content' | 'reference' | 'tag' | 'field' | 'fieldDef';

interface RowLeadingProps {
  hasChildren: boolean;
  expanded: boolean;
  variant: RowLeadingVariant;
  fieldType?: FieldType;
  bulletColors?: string[];
  tagDefColor?: string;
  onToggleExpand: () => void;
  onDrillDown: () => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}

export function RowLeading({
  hasChildren,
  expanded,
  variant,
  fieldType,
  bulletColors = [],
  tagDefColor,
  onToggleExpand,
  onDrillDown,
  draggable,
  onDragStart,
  onDragEnd,
}: RowLeadingProps) {
  const bulletClass = [
    'row-bullet-shape',
    variant,
    hasChildren ? 'has-children' : '',
    hasChildren && !expanded ? 'collapsed' : '',
    expanded ? 'expanded' : '',
  ].filter(Boolean).join(' ');

  const bulletDotStyle = conicColorStyle(bulletColors);
  let bulletShapeStyle: CSSProperties | undefined;
  if (variant === 'tag' && tagDefColor) {
    bulletShapeStyle = { background: tagDefColor };
  } else if ((variant === 'field' || variant === 'fieldDef') && bulletColors[0]) {
    bulletShapeStyle = { color: bulletColors[0] };
  }

  return (
    <div className="row-leading">
      <button
        className="row-chevron-button"
        title={expanded ? 'Collapse' : 'Expand'}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={onToggleExpand}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDrillDown();
        }}
        tabIndex={-1}
        type="button"
      >
        <span className={`row-chevron-shell ${expanded ? 'expanded' : ''}`}>
          <ChevronRightIcon size={ICON_SIZE.tiny} />
        </span>
      </button>
      <button
        className="row-bullet-button"
        title={variant === 'field' ? 'Open field' : 'Open'}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDrillDown();
        }}
        tabIndex={-1}
        type="button"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <span className={bulletClass} style={bulletShapeStyle}>
          {variant === 'field' || variant === 'fieldDef' ? (
            <FieldTypeIcon fieldType={fieldType} />
          ) : variant === 'tag' ? (
            <span aria-hidden="true" className="row-bullet-tag-glyph">#</span>
          ) : (
            <NodeBulletDot style={bulletDotStyle} />
          )}
        </span>
      </button>
    </div>
  );
}
