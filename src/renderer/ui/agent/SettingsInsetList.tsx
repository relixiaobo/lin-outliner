import { memo, type ReactNode } from 'react';

// The macOS System Settings *interaction* idiom, rendered in our own design
// system (tokens + B-rules), not Apple's chrome: a section header above a rounded
// inset card whose rows are split by hairlines. Selection / hover / focus stay
// NEUTRAL (B3/B4) — never the system accent. Geometry derives from the radius /
// hairline ladders (B9); see settings-inset-list.css.
//
// This is the reusable A7 foundation: Providers is the first consumer, and
// Permissions / Skills can adopt it later for free consistency.

interface InsetGroupProps {
  /** Sentence-case section header above the card (e.g. "Connected"). */
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
    <div className={['inset-group', className].filter(Boolean).join(' ')}>
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
  /** When provided, the row's main area is a button; otherwise it is static
   *  (for rows whose only interactive control lives in `trailing`). */
  onSelect?: () => void;
  ariaLabel?: string;
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
  onSelect,
  ariaLabel,
}: InsetRowProps) {
  const body = (
    <>
      {leading ? <span className="inset-row-leading">{leading}</span> : null}
      <span className={['inset-row-text', wrap ? 'is-wrap' : ''].filter(Boolean).join(' ')}>
        <span className="inset-row-label">{label}</span>
        {sublabel ? <span className="inset-row-sublabel">{sublabel}</span> : null}
      </span>
    </>
  );

  return (
    <div
      className={['inset-row', selected ? 'is-selected' : '', disabled ? 'is-disabled' : '']
        .filter(Boolean)
        .join(' ')}
      role="listitem"
    >
      {onSelect ? (
        <button
          aria-current={selected ? 'true' : undefined}
          aria-label={ariaLabel}
          className="inset-row-main"
          disabled={disabled}
          onClick={onSelect}
          type="button"
        >
          {body}
        </button>
      ) : (
        <div className="inset-row-main is-static">{body}</div>
      )}
      {trailing ? <div className="inset-row-trailing">{trailing}</div> : null}
    </div>
  );
});
