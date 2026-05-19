import type { DragEvent } from 'react';
import type { FieldType } from '../../api/types';
import {
  ChevronRightIcon,
  ICON_SIZE,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { RowMarker, type RowMarkerVariant } from './RowMarker';

export type RowLeadingVariant = RowMarkerVariant;

interface RowLeadingProps {
  hasChildren: boolean;
  expanded: boolean;
  variant: RowLeadingVariant;
  fieldType?: FieldType;
  markerClassName?: string;
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
  markerClassName,
  bulletColors = [],
  tagDefColor,
  onToggleExpand,
  onDrillDown,
  draggable,
  onDragStart,
  onDragEnd,
}: RowLeadingProps) {
  return (
    <div className="row-leading">
      <ButtonControl
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
      >
        <span className={`row-chevron-shell ${expanded ? 'expanded' : ''}`}>
          <ChevronRightIcon size={ICON_SIZE.rowGlyph} />
        </span>
      </ButtonControl>
      <ButtonControl
        className="row-bullet-button"
        title={variant === 'field' ? 'Open field' : 'Open'}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDrillDown();
        }}
        tabIndex={-1}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <RowMarker
          hasChildren={hasChildren}
          expanded={expanded}
          variant={variant}
          fieldType={fieldType}
          className={markerClassName}
          bulletColors={bulletColors}
          tagDefColor={tagDefColor}
        />
      </ButtonControl>
    </div>
  );
}
