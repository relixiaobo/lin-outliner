import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';

export interface AutomationDependencyCatalog {
  readonly tools: ReadonlySet<string>;
  readonly skills: ReadonlySet<string>;
  readonly plugins: ReadonlySet<string>;
  readonly mcpServers: ReadonlySet<string>;
}

export function validateAutomationDependencies(
  configuration: EffectiveThreadConfiguration,
  available: AutomationDependencyCatalog,
): void {
  const missing = [
    missingMessage('Tools', configuration.tools, available.tools),
    missingMessage('Skills', configuration.skills, available.skills),
    missingMessage('Plugins', configuration.plugins, available.plugins),
    missingMessage('MCP servers', configuration.mcpServers, available.mcpServers),
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) throw new Error(`Automation dependencies are unavailable: ${missing.join('; ')}`);
}

function missingMessage(
  label: string,
  selected: readonly string[],
  available: ReadonlySet<string>,
): string | null {
  const missing = selected.filter((value) => !available.has(value));
  return missing.length > 0 ? `${label}: ${missing.join(', ')}` : null;
}
