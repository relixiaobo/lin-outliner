interface SwitchMarkProps {
  checked: boolean;
}

export function SwitchMark(props: SwitchMarkProps) {
  return (
    <span className={props.checked ? 'switch-mark checked' : 'switch-mark'} aria-hidden="true">
      <span className="switch-mark-thumb" />
    </span>
  );
}
