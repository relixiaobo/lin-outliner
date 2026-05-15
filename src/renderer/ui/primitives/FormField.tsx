import type { ReactNode } from 'react';

type FormFieldElement = 'div' | 'label';

interface FormFieldProps {
  children: ReactNode;
  label: ReactNode;
  as?: FormFieldElement;
  className?: string;
  labelClassName?: string;
}

export function FormField({
  as = 'label',
  children,
  className,
  label,
  labelClassName,
}: FormFieldProps) {
  const labelNode = <span className={labelClassName}>{label}</span>;

  if (as === 'div') {
    return (
      <div className={className}>
        {labelNode}
        {children}
      </div>
    );
  }

  return (
    <label className={className}>
      {labelNode}
      {children}
    </label>
  );
}
