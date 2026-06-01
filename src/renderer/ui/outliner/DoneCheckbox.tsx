import { CheckboxMark } from '../primitives/CheckboxMark';
import { ButtonControl } from '../primitives/ButtonControl';

interface DoneCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  /**
   * Render the state read-only and inert. Set when the owner is locked (e.g. a
   * daily-note date page that carries a Done field via a tag template): the box
   * still reflects `completedAt`, but `toggle_done` would reject a locked node,
   * so it must not be clickable. Mirrors the read-only Done in `SystemFieldValue`.
   */
  readOnly?: boolean;
}

export function DoneCheckbox(props: DoneCheckboxProps) {
  if (props.readOnly) {
    return (
      <span
        className="done-checkbox done-checkbox--readonly"
        role="checkbox"
        aria-checked={props.checked}
        aria-readonly="true"
        aria-disabled="true"
      >
        <CheckboxMark checked={props.checked} />
      </span>
    );
  }
  return (
    <ButtonControl
      className="done-checkbox"
      aria-pressed={props.checked}
      title={props.checked ? 'Mark not done' : 'Mark done'}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onToggle();
      }}
    >
      <CheckboxMark checked={props.checked} />
    </ButtonControl>
  );
}
