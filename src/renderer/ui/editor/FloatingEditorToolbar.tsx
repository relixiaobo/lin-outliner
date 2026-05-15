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
  left: number;
  top: number;
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
  if (!props.visible) return null;

  return (
    <div
      className="floating-editor-toolbar"
      style={{ left: props.left, top: props.top }}
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
