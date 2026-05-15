import type { ReactNode } from 'react';

interface FieldEntryGridProps {
  name: ReactNode;
  value: ReactNode;
  description?: ReactNode;
}

export function FieldEntryGrid({ name, value, description }: FieldEntryGridProps) {
  return (
    <div className="outliner-field-grid">
      {name}
      {value}
      {description}
    </div>
  );
}
