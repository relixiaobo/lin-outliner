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
  const parentTools = new Set(parent.tools);
  const requestedTools = overrides?.tools ?? parent.tools;
  const tools = requestedTools.filter((tool) => parentTools.has(tool));

  return Object.freeze({
    profileName: parent.profileName,
    developerInstructions: Object.freeze([
      ...parent.developerInstructions,
      request.role.developerInstructions,
    ]),
    model: request.model ?? overrides?.model ?? parent.model,
    reasoningEffort: request.reasoningEffort ?? overrides?.reasoningEffort ?? parent.reasoningEffort,
    tools: Object.freeze([...new Set(tools)]),
    skills: Object.freeze([...new Set(overrides?.skills ?? parent.skills)]),
    plugins: Object.freeze([...new Set(overrides?.plugins ?? parent.plugins)]),
    mcpServers: Object.freeze([...new Set(overrides?.mcpServers ?? parent.mcpServers)]),
  });
}
