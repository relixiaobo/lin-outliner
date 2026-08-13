import type { HTMLAttributes } from 'react';
import { cx } from './cx';

interface WorkingTextProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly text: string;
  readonly truncate?: boolean;
}

/** One readable text layer carries paint-only motion without glyph overdraw. */
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
    </span>
  );
}
