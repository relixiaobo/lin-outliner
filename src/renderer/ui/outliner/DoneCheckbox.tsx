import { CheckboxMark } from '../primitives/CheckboxMark';

interface DoneCheckboxProps {
  checked: boolean;
  onToggle: () => void;
}

export function DoneCheckbox(props: DoneCheckboxProps) {
  return (
    <button
      type="button"
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
    </button>
  );
}
