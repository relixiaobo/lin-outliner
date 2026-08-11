import type { HTMLAttributes } from 'react';
import { cx } from './cx';

interface WorkingTextProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly text: string;
  readonly truncate?: boolean;
}

/** Readable text stays in normal flow; the hidden duplicate supplies motion. */
export function WorkingText({
  className,
  text,
  truncate = false,
  ...spanProps
}: WorkingTextProps) {
  return (
    <span
      {...spanProps}
      className={cx('working-text', truncate && 'working-text-truncate', className)}
    >
      <span className="working-text-base">{text}</span>
      <span aria-hidden="true" className="working-text-sweep">
        <span className="working-text-sweep-copy">{text}</span>
      </span>
    </span>
  );
}
