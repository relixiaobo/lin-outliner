import type { CSSProperties, MouseEventHandler } from 'react';
import { CloseIcon, ICON_SIZE, TrashIcon, WarningIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import type { TagColor } from './tagColors';

interface AppliedTagProps {
  label: string;
  color: TagColor;
  trashed?: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onContextMenu?: MouseEventHandler<HTMLSpanElement>;
}

export function AppliedTag({
  label,
  color,
  trashed = false,
  onOpen,
  onRemove,
  onContextMenu,
}: AppliedTagProps) {
  const t = useT();
  if (trashed) {
    return (
      <span className="tag-badge trashed" title={t.tags.deletedTitle({ label })}>
        <span className="tag-badge-hash">#</span>
        <span className="tag-badge-label">{label}</span>
        <WarningIcon size={ICON_SIZE.tiny + 1} />
        <TrashIcon size={ICON_SIZE.tiny + 1} />
      </span>
    );
  }

  return (
    <span
      className="tag-badge"
      style={{
        '--tag-bg': color.background,
        '--tag-text': color.text,
      } as CSSProperties}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      onContextMenu={onContextMenu}
    >
      <ButtonControl
        aria-label={t.tags.removeAriaLabel({ label })}
        className="tag-badge-remove"
        title={t.tags.removeTitle}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemove();
        }}
      >
        <span className="tag-badge-hash">#</span>
        <CloseIcon className="tag-badge-x" size={ICON_SIZE.tiny + 1} strokeWidth={2.5} />
      </ButtonControl>
      <ButtonControl
        aria-label={t.tags.openAriaLabel({ label })}
        className="tag-badge-label clickable"
        title={label}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
      >
        {label}
      </ButtonControl>
    </span>
  );
}
