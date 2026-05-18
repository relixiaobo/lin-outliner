import type { ReactNode } from 'react';

interface FieldValueRowProps {
  children: ReactNode;
  dimmed?: boolean;
  completed?: boolean;
}

export function FieldValueRow({ children, dimmed, completed }: FieldValueRowProps) {
  return (
    <div className={`field-value-row ${dimmed ? 'dimmed' : ''} ${completed ? 'done' : ''}`}>
      <div className="field-value-row-content">
        {children}
      </div>
    </div>
  );
}
