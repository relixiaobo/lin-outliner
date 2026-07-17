import { DEFAULT_DREAM_CHANNEL_ID } from '../core/agentChannel';
import type {
  AgentRunAnchor,
  AgentRunContextMode,
  AgentRunContextPolicy,
  AgentRunObjectiveRole,
  AgentRunProfileId,
  AgentRunPurpose,
} from '../core/agentEventLog';

export interface RunProfile {
  id: AgentRunProfileId;
  label: string;
  defaultContext: AgentRunContextPolicy;
  defaultObjectiveRole?: AgentRunObjectiveRole;
  defaultDisposition?: 'attended' | 'detached';
  allowedActionKinds?: string[];
  disallowedActionKinds?: string[];
  defaultSkills?: string[];
  modelOverride?: string;
  effortOverride?: string;
  modelSelectable?: boolean;
  internalOnly?: boolean;
  hiddenFromWorkRuns?: boolean;
  active: boolean;
}

export const BUILT_IN_RUN_PROFILES = {
  default: {
    id: 'default',
    label: 'Default',
    defaultContext: 'full',
    defaultObjectiveRole: 'worker',
    modelSelectable: true,
    active: true,
  },
  research: {
    id: 'research',
    label: 'Research',
    defaultContext: 'none',
    defaultObjectiveRole: 'worker',
    modelSelectable: true,
    active: true,
  },
  verify: {
    id: 'verify',
    label: 'Verify',
    defaultContext: 'none',
    defaultObjectiveRole: 'verifier',
    defaultDisposition: 'attended',
    internalOnly: true,
    active: true,
  },
  browser: {
    id: 'browser',
    label: 'Browser',
    defaultContext: 'brief',
    defaultObjectiveRole: 'worker',
    modelSelectable: false,
    active: false,
  },
  coding: {
    id: 'coding',
    label: 'Coding',
    defaultContext: 'brief',
    defaultObjectiveRole: 'worker',
    modelSelectable: false,
    active: false,
  },
  writing: {
    id: 'writing',
    label: 'Writing',
    defaultContext: 'brief',
    defaultObjectiveRole: 'worker',
    modelSelectable: false,
    active: false,
  },
  dream: {
    id: 'dream',
    label: 'Dream',
    defaultContext: 'none',
    defaultDisposition: 'detached',
    internalOnly: true,
    hiddenFromWorkRuns: true,
    active: true,
  },
} as const satisfies Record<AgentRunProfileId, RunProfile>;

export function isRunProfileId(value: unknown): value is AgentRunProfileId {
  return typeof value === 'string' && Object.hasOwn(BUILT_IN_RUN_PROFILES, value);
}

export function getRunProfile(profileId: AgentRunProfileId): RunProfile {
  return BUILT_IN_RUN_PROFILES[profileId];
}

export function listRunProfiles(): RunProfile[] {
  return Object.values(BUILT_IN_RUN_PROFILES);
}

export function resolveRunProfile(profileId: AgentRunProfileId | undefined): RunProfile {
  const profile = getRunProfile(profileId ?? 'default');
  if (!profile.active) throw new Error(`Run profile is not active: ${profile.id}`);
  return profile;
}

export function modelSelectableRunProfiles(): RunProfile[] {
  return listRunProfiles().filter((profile) => profile.active && profile.modelSelectable === true);
}

export function runProfileForPurpose(purpose: AgentRunPurpose): AgentRunProfileId {
  return purpose === 'verify' ? 'verify' : 'default';
}

export function runProfileForIsolatedSkill(readOnlyIsolated: boolean | undefined): AgentRunProfileId {
  return readOnlyIsolated ? 'research' : 'default';
}

export function runProfileForAnchor(anchor: AgentRunAnchor): AgentRunProfileId {
  return anchor.type === 'conversation' && anchor.conversationId === DEFAULT_DREAM_CHANNEL_ID
    ? 'dream'
    : 'default';
}

export function runProfileFromStartedRun(
  input: { purpose?: AgentRunPurpose; runProfile?: AgentRunProfileId } | undefined,
  anchor: AgentRunAnchor,
): AgentRunProfileId {
  if (input?.runProfile) return input.runProfile;
  if (input?.purpose === 'verify') return 'verify';
  return runProfileForAnchor(anchor);
}

export function objectiveRoleForRun(
  input: { purpose?: AgentRunPurpose; objectiveRole?: AgentRunObjectiveRole } | undefined,
  parentRunId: string | undefined,
): AgentRunObjectiveRole {
  if (input?.objectiveRole) return input.objectiveRole;
  if (input?.purpose === 'verify') return 'verifier';
  return parentRunId ? 'worker' : 'controller';
}

export function runContextPolicyFromContextMode(contextMode: AgentRunContextMode | undefined): AgentRunContextPolicy {
  if (contextMode === 'brief' || contextMode === 'none') return contextMode;
  return 'full';
}
