import { useRef } from 'react';
import type { OverlayAnchorRect } from '../primitives/useAnchoredOverlay';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import {
  BoldIcon,
  CodeIcon,
  HighlightIcon,
  ItalicIcon,
  StrikeIcon,
  type AppIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';

export type ToolbarMark = 'bold' | 'italic' | 'strike' | 'code' | 'highlight';

interface FloatingEditorToolbarProps {
  visible: boolean;
  anchorRect: OverlayAnchorRect | null;
  activeMarks: Set<ToolbarMark>;
  onToggle: (mark: ToolbarMark) => void;
}

const BUTTONS: Array<{
  mark: ToolbarMark;
  label: string;
  icon: AppIcon;
}> = [
  { mark: 'bold', label: 'Bold', icon: BoldIcon },
  { mark: 'italic', label: 'Italic', icon: ItalicIcon },
  { mark: 'strike', label: 'Strike', icon: StrikeIcon },
  { mark: 'code', label: 'Code', icon: CodeIcon },
  { mark: 'highlight', label: 'Highlight', icon: HighlightIcon },
];

export function FloatingEditorToolbar(props: FloatingEditorToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarStyle = useAnchoredOverlay(toolbarRef, {
    anchorRect: props.anchorRect,
    disabled: !props.visible || !props.anchorRect,
    gap: 8,
    placement: 'top-center',
    width: 156,
  });

  if (!props.visible) return null;

  return (
    <div
      ref={toolbarRef}
      className="floating-editor-toolbar"
      style={toolbarStyle}
      onMouseDown={(event) => event.preventDefault()}
    >
      {BUTTONS.map(({ mark, label, icon: Icon }) => (
        <IconButton
          aria-pressed={props.activeMarks.has(mark)}
          key={mark}
          className={`toolbar-icon ${props.activeMarks.has(mark) ? 'active' : ''}`}
          icon={Icon}
          label={label}
          title={label}
          onClick={() => props.onToggle(mark)}
          variant="toolbar"
        />
      ))}
    </div>
  );
}
