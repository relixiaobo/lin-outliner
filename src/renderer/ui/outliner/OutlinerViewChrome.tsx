import { ButtonControl } from '../primitives/ButtonControl';

interface ViewGroupHeadingProps {
  label: string;
}

interface HiddenFieldRevealProps {
  label: string;
  onReveal: () => void;
}

export function ViewGroupHeading({ label }: ViewGroupHeadingProps) {
  return <div className="view-group-heading">{label}</div>;
}

export function HiddenFieldReveal({ label, onReveal }: HiddenFieldRevealProps) {
  return (
    <ButtonControl
      className="hidden-field-reveal"
      onClick={onReveal}
    >
      {label}
    </ButtonControl>
  );
}
