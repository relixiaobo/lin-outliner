import { memo, type ReactNode } from 'react';
import { ButtonControl } from '../primitives/ButtonControl';
import { cx } from '../primitives/cx';

// The macOS System Settings *interaction* idiom, rendered in our own design
// system (tokens + B-rules), not Apple's chrome: a section header above a rounded
// inset card whose rows are split by hairlines. Selection / hover / focus stay
// NEUTRAL (B3/B4) — never the system accent. Geometry derives from the radius /
// hairline ladders (B9); see settings-inset-list.css.
//
// This is the reusable A7 foundation: Providers is the first consumer, and
// Permissions / Skills can adopt it later for free consistency.

interface InsetGroupProps {
  /** Sentence-case section header above the card (e.g. "Configured"). */
  label?: string;
  /** Optional explanatory footnote under the card. */
  footnote?: ReactNode;
  /** Accessible name for the list region; falls back to `label`. */
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

export function InsetGroup({ label, footnote, ariaLabel, className, children }: InsetGroupProps) {
  return (
    <div className={cx('inset-group', className)}>
      {label ? <div className="inset-group-header">{label}</div> : null}
      <div aria-label={ariaLabel ?? label} className="inset-card" role="list">
        {children}
      </div>
      {footnote ? <p className="inset-group-footnote">{footnote}</p> : null}
    </div>
  );
}

interface InsetRowProps {
  /** Leading icon / avatar slot. Non-interactive only — it renders INSIDE the
   *  selectable button, so an interactive control (a switch) belongs in `trailing`
   *  (a sibling), never here. */
  leading?: ReactNode;
  label: ReactNode;
  sublabel?: ReactNode;
  /** Trailing slot — a `⋯` menu trigger, a switch, a select, a quiet button, etc.
   *  Rendered as a sibling of the selectable area so it never nests buttons. */
  trailing?: ReactNode;
  /** Let the label / sublabel wrap to multiple lines instead of single-line
   *  ellipsis (settings rows that carry an explanatory description). The sublabel
   *  becomes a stack, so it can hold a description plus e.g. a rule-value line. */
  wrap?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /** Visually de-emphasize the row (same `is-disabled` styling) while keeping it
   *  interactive — for a navigable row whose target is "off" but must stay reachable
   *  to turn it back on (e.g. a disabled agent, whose enable toggle lives in the
   *  detail view it links to). Distinct from `disabled`, which blocks the click. */
  dimmed?: boolean;
  /** When provided, the row's main area is a button; otherwise it is static
   *  (for rows whose only interactive control lives in `trailing`). */
  onSelect?: () => void;
  ariaLabel?: string;
  className?: string;
}

// Memoized so a selection change in a long provider/skill list only re-renders
// the rows whose props actually changed (the render-isolation perf goal).
export const InsetRow = memo(function InsetRow({
  leading,
  label,
  sublabel,
  trailing,
  wrap = false,
  selected = false,
  disabled = false,
  dimmed = false,
  onSelect,
  ariaLabel,
  className,
}: InsetRowProps) {
  const body = (
    <>
      {leading ? <span className="inset-row-leading">{leading}</span> : null}
      <span className={cx('inset-row-text', wrap && 'is-wrap')}>
        <span className="inset-row-label">{label}</span>
        {sublabel ? <span className="inset-row-sublabel">{sublabel}</span> : null}
      </span>
    </>
  );

  return (
    <div
      className={cx('inset-row', selected && 'is-selected', (disabled || dimmed) && 'is-disabled', className)}
      role="listitem"
    >
      {onSelect ? (
        <ButtonControl
          aria-current={selected ? 'true' : undefined}
          aria-label={ariaLabel}
          className="inset-row-main"
          disabled={disabled}
          onClick={onSelect}
        >
          {body}
        </ButtonControl>
      ) : (
        <div className="inset-row-main is-static">{body}</div>
      )}
      {trailing ? <div className="inset-row-trailing">{trailing}</div> : null}
    </div>
  );
});
