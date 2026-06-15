import type { AgentDefinition } from '../core/types';

export function agentDefinitionDisplayName(definition: AgentDefinition): string {
  return definition.displayName?.trim() || definition.name;
}
