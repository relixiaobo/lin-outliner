import { CheckboxIcon, ICON_SIZE } from '../icons';

interface DoneCheckboxProps {
  checked: boolean;
  onToggle: () => void;
}

export function DoneCheckbox(props: DoneCheckboxProps) {
  return (
    <button
      type="button"
      className={`done-checkbox ${props.checked ? 'checked' : ''}`}
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
      {props.checked ? (
        <CheckboxIcon size={ICON_SIZE.menu} strokeWidth={2} />
      ) : (
        <span className="done-checkbox-empty" />
      )}
    </button>
  );
}
