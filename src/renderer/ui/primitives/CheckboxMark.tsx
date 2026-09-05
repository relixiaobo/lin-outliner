import { CheckboxCheckIcon, ICON_SIZE } from '../icons';

interface CheckboxMarkProps {
  checked: boolean;
}

export function CheckboxMark(props: CheckboxMarkProps) {
  return (
    <span className={props.checked ? 'checkbox-mark checked' : 'checkbox-mark'} aria-hidden="true">
      {props.checked ? (
        <CheckboxCheckIcon className="checkbox-mark-check" size={ICON_SIZE.tiny} />
      ) : null}
    </span>
  );
}
