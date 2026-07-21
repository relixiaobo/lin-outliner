export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface ConfigurationProfile {
  readonly name: string;
  readonly source: 'builtIn' | 'user' | 'project';
  readonly description?: string;
  readonly developerInstructions?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly plugins?: readonly string[];
  readonly mcpServers?: readonly string[];
}

export interface AgentRoleOverrides {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly plugins?: readonly string[];
  readonly mcpServers?: readonly string[];
}

export interface AgentRole {
  readonly name: string;
  readonly source: 'builtIn' | 'user' | 'project';
  readonly description: string;
  readonly developerInstructions: string;
  readonly nicknameCandidates?: readonly string[];
  readonly overrides?: AgentRoleOverrides;
}

export const BUILT_IN_AGENT_ROLES = ['default', 'worker', 'explorer'] as const;
export type BuiltInAgentRoleName = typeof BUILT_IN_AGENT_ROLES[number];

export interface EffectiveThreadConfiguration {
  readonly profileName: string | null;
  readonly developerInstructions: readonly string[];
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly plugins: readonly string[];
  readonly mcpServers: readonly string[];
}

export interface ChildConfigurationRequest {
  readonly role: AgentRole;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export function resolveChildConfiguration(
  parent: EffectiveThreadConfiguration,
  request: ChildConfigurationRequest,
): EffectiveThreadConfiguration {
  const overrides = request.role.overrides;

  return Object.freeze({
    profileName: parent.profileName,
    developerInstructions: Object.freeze([
      ...parent.developerInstructions,
      request.role.developerInstructions,
    ]),
    model: request.model ?? overrides?.model ?? parent.model,
    reasoningEffort: request.reasoningEffort ?? overrides?.reasoningEffort ?? parent.reasoningEffort,
    tools: constrainChildCapabilities(parent.tools, overrides?.tools),
    skills: constrainChildCapabilities(parent.skills, overrides?.skills),
    plugins: constrainChildCapabilities(parent.plugins, overrides?.plugins),
    mcpServers: constrainChildCapabilities(parent.mcpServers, overrides?.mcpServers),
  });
}

function constrainChildCapabilities(
  parent: readonly string[],
  requested: readonly string[] | undefined,
): readonly string[] {
  const parentCeiling = new Set(parent);
  return Object.freeze([...new Set(requested ?? parent)].filter((capability) => parentCeiling.has(capability)));
}
