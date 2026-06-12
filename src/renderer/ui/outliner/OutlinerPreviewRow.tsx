import type { CSSProperties, HTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { OutlinerRowShell } from './OutlinerRowShell';
import { RowLeading, type RowLeadingVariant } from './RowLeading';

interface OutlinerPreviewRowProps {
  nodeId: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  markerVariant: RowLeadingVariant;
  openLabel: string;
  title: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  referenceFrame?: boolean;
  onOpen: MouseEventHandler<HTMLButtonElement>;
  onToggleExpand: () => void;
  onDrillDown: () => void;
  children?: ReactNode;
}

export function OutlinerPreviewRow({
  nodeId,
  depth,
  hasChildren,
  expanded,
  markerVariant,
  openLabel,
  title,
  meta,
  description,
  action,
  referenceFrame = false,
  onOpen,
  onToggleExpand,
  onDrillDown,
  children,
}: OutlinerPreviewRowProps) {
  const wrapStyle = {
    '--outliner-preview-indent': `${depth * 28}px`,
  } as CSSProperties;
  const wrapProps = {
    'data-node-id': nodeId,
    style: wrapStyle,
  } as HTMLAttributes<HTMLDivElement>;

  return (
    <OutlinerRowShell
      hasChildren={hasChildren}
      expanded={expanded}
      wrapClassName="outliner-preview-wrap"
      wrapProps={wrapProps}
      rowClassName={[
        'row',
        'outliner-preview-row',
        action ? 'has-preview-action' : '',
        referenceFrame ? 'is-reference-frame' : '',
      ].filter(Boolean).join(' ')}
      onSelectFromPointer={() => undefined}
      onContextMenu={() => undefined}
      rowContent={(
        <>
          <RowLeading
            hasChildren={hasChildren}
            expanded={expanded}
            variant={markerVariant}
            onToggleExpand={() => {
              if (hasChildren) onToggleExpand();
            }}
            onDrillDown={onDrillDown}
          />
          <button
            type="button"
            className="outliner-preview-content"
            aria-label={openLabel}
            onClick={onOpen}
          >
            <span className="outliner-preview-title-line">
              <span className="outliner-preview-title">{title}</span>
              {meta && <span className="outliner-preview-meta">{meta}</span>}
            </span>
            {description && <span className="outliner-preview-description">{description}</span>}
          </button>
          {action && <span className="outliner-preview-action">{action}</span>}
        </>
      )}
    >
      {expanded && children ? <div className="outliner-preview-children">{children}</div> : null}
    </OutlinerRowShell>
  );
}
