import { CheckboxMark } from '../primitives/CheckboxMark';
import { ButtonControl } from '../primitives/ButtonControl';

interface DoneCheckboxProps {
  checked: boolean;
  onToggle: () => void;
}

export function DoneCheckbox(props: DoneCheckboxProps) {
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
