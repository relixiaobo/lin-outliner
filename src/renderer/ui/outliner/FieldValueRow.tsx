import type { ReactNode } from 'react';
import { NodeBulletDot } from './NodeBulletDot';

interface FieldValueRowProps {
  children: ReactNode;
  dimmed?: boolean;
  completed?: boolean;
}

export function FieldValueRow({ children, dimmed, completed }: FieldValueRowProps) {
  return (
    <div className={`field-value-row ${dimmed ? 'dimmed' : ''} ${completed ? 'done' : ''}`}>
      <span className="field-value-node-bullet">
        <NodeBulletDot />
      </span>
      <div className="field-value-row-content">
        {children}
      </div>
    </div>
  );
}
