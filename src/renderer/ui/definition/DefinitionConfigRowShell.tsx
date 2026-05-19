import type { ReactNode } from 'react';
import { FieldEntryGrid } from '../outliner/FieldEntryGrid';

interface DefinitionConfigRowShellProps {
  configKey: string;
  control: ReactNode;
  icon: ReactNode;
  isLast?: boolean;
  label: ReactNode;
}

export function DefinitionConfigRowShell({
  configKey,
  control,
  icon,
  isLast = false,
  label,
}: DefinitionConfigRowShellProps) {
  return (
    <div className={`definition-config-row ${isLast ? 'is-last' : ''}`} data-config-key={configKey}>
      <span className="definition-config-leading" aria-hidden="true">
        <span className="definition-config-icon">
          {icon}
        </span>
      </span>
      <FieldEntryGrid
        name={<span className="definition-config-label">{label}</span>}
        value={<span className="definition-config-control">{control}</span>}
      />
    </div>
  );
}
