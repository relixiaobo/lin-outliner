import type { ReactNode } from 'react';

interface DefinitionConfigRowShellProps {
  configKey: string;
  control: ReactNode;
  icon: ReactNode;
  label: ReactNode;
}

export function DefinitionConfigRowShell({
  configKey,
  control,
  icon,
  label,
}: DefinitionConfigRowShellProps) {
  return (
    <div className="definition-config-row" data-config-key={configKey}>
      <span className="definition-config-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="definition-config-label">{label}</span>
      <span className="definition-config-control">{control}</span>
    </div>
  );
}
