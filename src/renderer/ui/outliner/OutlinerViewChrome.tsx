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
    <button
      className="hidden-field-reveal"
      type="button"
      onClick={onReveal}
    >
      {label}
    </button>
  );
}
