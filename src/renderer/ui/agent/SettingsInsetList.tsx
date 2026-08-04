import { memo, type ReactNode } from 'react';
import { ChevronRightIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { cx } from '../primitives/cx';

// The macOS System Settings *interaction* idiom, rendered in our own design
// system (tokens + B-rules), not Apple's chrome: a section header above a rounded
// inset card whose rows are split by hairlines. Selection / hover / focus stay
// NEUTRAL (B3/B4) — never the system accent. Geometry derives from the radius /
// hairline ladders (B9); see settings-inset-list.css.
//
// This is the reusable A7 foundation shared by providers, security, skills,
// memory, and Configuration Profile panes.

interface InsetGroupProps {
  /** Sentence-case section header above the card (e.g. "Configured"). */
  label?: string;
  /**
   * Optional control aligned to the end of the header row — an icon-only chrome
   * control that acts on the whole group (e.g. the Skill library's `+`). Keep it
   * icon-only per B6: colour deepens on hover, no box.
   */
  headerAction?: ReactNode;
  /** Optional explanatory footnote under the card. */
  footnote?: ReactNode;
  /** Accessible name for the list region; falls back to `label`. */
  ariaLabel?: string;
  /**
   * Anchor name, so a deep link can land on this group rather than at the top of
   * a long pane. Deliberately a stable slug the link carries, not a generated id.
   */
  id?: string;
  className?: string;
  children: ReactNode;
}

export function InsetGroup({ label, headerAction, footnote, ariaLabel, id, className, children }: InsetGroupProps) {
  return (
    <div className={cx('inset-group', className)} data-settings-anchor={id}>
      {/* Without an action the header keeps its original single-element shape, so
          adding this slot cannot disturb the panes that do not use it. */}
      {headerAction ? (
        <div className="inset-group-header has-action">
          <span className="inset-group-header-label">{label}</span>
          <span className="inset-group-header-action">{headerAction}</span>
        </div>
      ) : label ? <div className="inset-group-header">{label}</div> : null}
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
  /**
   * The row states an absence ("No blocks", "No skills yet") rather than being a
   * row that is switched off. `disabled` was standing in for this, which gates
   * nothing on a non-interactive row and only greyed it — so an absence read as a
   * disabled entry named after itself, beside `dimmed` rows that mean something
   * else entirely.
   */
  empty?: boolean;
  /** When provided, the row's main area is a button; otherwise it is static
   *  (for rows whose only interactive control lives in `trailing`). */
  onSelect?: () => void;
  /**
   * Marks a row that opens another page, with the chevron the design system had
   * styled and nothing rendered. Without it a row that navigates and a row that
   * merely states something look identical, so nothing told the user which rows
   * are doors.
   */
  drillsDown?: boolean;
  /** A count worth surfacing one level up, e.g. Skills with updates waiting. */
  badge?: number;
  /** What the badge means, since a bare digit announces as a bare digit. */
  badgeLabel?: string;
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
  empty = false,
  onSelect,
  drillsDown = false,
  badge,
  badgeLabel,
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
      {badge !== undefined ? (
        // Labelled on a <span> role=status rather than via aria-label on a generic
        // element, where ARIA forbids naming and screen readers announce the digit
        // alone.
        <span className="inset-row-badge" role="status" aria-label={badgeLabel}>{badge}</span>
      ) : null}
      {drillsDown ? (
        <span className="settings-drilldown-chevron" aria-hidden="true">
          <ChevronRightIcon size={ICON_SIZE.menu} strokeWidth={1.75} />
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cx('inset-row', selected && 'is-selected', (disabled || dimmed) && 'is-disabled', empty && 'is-empty', className)}
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
