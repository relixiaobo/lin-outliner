import { ButtonControl } from '../primitives/ButtonControl';
import { ChevronDownIcon, ChevronRightIcon, ICON_SIZE } from '../icons';
import { useT } from '../../i18n/I18nProvider';

interface ViewGroupHeadingProps {
  label: string;
}

interface HiddenFieldRevealProps {
  label: string;
  onReveal: () => void;
}

interface FilteredOutHeadingProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

export function ViewGroupHeading({ label }: ViewGroupHeadingProps) {
  return <div className="view-group-heading">{label}</div>;
}

export function FilteredOutHeading({ count, expanded, onToggle }: FilteredOutHeadingProps) {
  const t = useT();
  return (
    <ButtonControl
      aria-expanded={expanded}
      className="filtered-out-heading"
      onClick={onToggle}
    >
      <span>{t.outliner.filteredOut.count({ count })}</span>
      {expanded ? (
        <ChevronDownIcon className="filtered-out-heading-chevron" size={ICON_SIZE.tiny} />
      ) : (
        <ChevronRightIcon className="filtered-out-heading-chevron" size={ICON_SIZE.tiny} />
      )}
    </ButtonControl>
  );
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
