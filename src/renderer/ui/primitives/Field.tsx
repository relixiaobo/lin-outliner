import type { ReactNode } from 'react';
import { cx } from './cx';

type FieldElement = 'div' | 'label';

interface FieldProps {
  as?: FieldElement;
  children: ReactNode;
  className?: string;
  error?: ReactNode;
  label: ReactNode;
  labelClassName?: string;
  meta?: ReactNode;
}

export function Field({
  as = 'label',
  children,
  className,
  error,
  label,
  labelClassName,
  meta,
}: FieldProps) {
  const Element = as;
  const classes = cx(
    className ?? 'field-control',
    Boolean(error) && 'is-error',
  );
  const resolvedLabelClassName = labelClassName ?? (className ? undefined : 'field-control-label');

  return (
    <Element className={classes}>
      <span className={resolvedLabelClassName}>{label}</span>
      {children}
      {error ? <span className="field-control-error">{error}</span> : meta ? <span className="field-control-meta">{meta}</span> : null}
    </Element>
  );
}
