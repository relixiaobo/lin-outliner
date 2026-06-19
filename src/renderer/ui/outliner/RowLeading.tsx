import type { ComponentType, DragEvent } from 'react';
import type { FieldType } from '../../api/types';
import {
  ChevronRightIcon,
  ICON_SIZE,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import {
  captureDisclosureScrollAnchor,
  nearestScrollContainer,
  restoreDisclosureScrollAnchor,
} from '../interactions/disclosureScrollAnchor';
import { RowMarker, type RowMarkerVariant } from './RowMarker';
import { useT } from '../../i18n/I18nProvider';

export type RowLeadingVariant = RowMarkerVariant;

interface RowLeadingProps {
  hasChildren: boolean;
  expanded: boolean;
  variant: RowLeadingVariant;
  fieldType?: FieldType;
  markerIcon?: ComponentType<{ size?: number }>;
  markerClassName?: string;
  processing?: boolean;
  bulletColors?: string[];
  tagDefColor?: string;
  fileIconKind?: string;
  onToggleExpand: (anchorElement?: HTMLElement | null) => void;
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
  markerIcon,
  markerClassName,
  processing,
  bulletColors = [],
  tagDefColor,
  fileIconKind,
  onToggleExpand,
  onDrillDown,
  draggable,
  onDragStart,
  onDragEnd,
}: RowLeadingProps) {
  const t = useT();
  return (
    <div className="row-leading">
      <ButtonControl
        className="row-chevron-button"
        title={expanded ? t.outliner.field.collapse : t.outliner.field.expand}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          const scroller = nearestScrollContainer(event.currentTarget);
          const rowId = event.currentTarget.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null;
          const anchor = captureDisclosureScrollAnchor(
            event.currentTarget,
            scroller,
            () => (rowId && scroller
              ? scroller.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(rowId)}"] .row-chevron-button`)
              : null),
          );
          onToggleExpand(event.currentTarget);
          if (anchor) {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                restoreDisclosureScrollAnchor(anchor);
              });
            });
          }
        }}
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
        title={variant === 'field' ? t.outliner.field.openField : t.outliner.field.open}
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
          icon={markerIcon}
          processing={processing}
          className={markerClassName}
          bulletColors={bulletColors}
          tagDefColor={tagDefColor}
          fileIconKind={fileIconKind}
        />
      </ButtonControl>
    </div>
  );
}
