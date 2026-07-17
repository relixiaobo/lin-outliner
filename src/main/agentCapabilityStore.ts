import { app } from 'electron';
import { join } from 'node:path';
import { FolderCapabilityService } from './agentFolderCapabilities';
import {
  agentCapabilityConfigToSettings,
  parseAgentCapabilitySettings,
  type AgentCapabilityConfig,
  type NormalizedAgentCapabilitySettings,
} from './agentCapabilityRules';

const AGENT_CAPABILITIES_FILE = 'agent-capabilities.json';

let service: FolderCapabilityService | null = null;

export function getFolderCapabilityService(): FolderCapabilityService {
  service ??= new FolderCapabilityService(join(app.getPath('userData'), AGENT_CAPABILITIES_FILE));
  return service;
}

export async function readAgentCapabilityConfig(): Promise<AgentCapabilityConfig> {
  const state = await getFolderCapabilityService().readState();
  return {
    ...parseAgentCapabilitySettings(state.document),
    revocationGeneration: state.revocationGeneration,
  };
}

export async function readAgentCapabilitySettings(): Promise<NormalizedAgentCapabilitySettings> {
  return getFolderCapabilityService().read();
}

export async function readAgentCapabilitySettingsView() {
  return agentCapabilitySettingsViewFromConfig(await readAgentCapabilityConfig());
}

export async function grantAgentFolderCapability(folder: string): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await getFolderCapabilityService().grant(folder));
}

export async function grantAgentFolderCapabilities(folders: readonly string[]): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await getFolderCapabilityService().grantMany(folders));
}

export async function grantAgentFolderCapabilityView(folder: string) {
  return agentCapabilitySettingsViewFromConfig(await grantAgentFolderCapability(folder));
}

export async function appendAgentCapabilityBlock(ruleValue: string): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await getFolderCapabilityService().appendBlock(ruleValue));
}

export async function appendAgentCapabilityBlockView(ruleValue: string) {
  return agentCapabilitySettingsViewFromConfig(await appendAgentCapabilityBlock(ruleValue));
}

export async function applyAgentCapabilitySettingsPatch(input: {
  filesystemMode?: unknown;
  revokeFolders?: unknown;
  removeBlocks?: unknown;
}): Promise<AgentCapabilityConfig> {
  const document = await getFolderCapabilityService().applyRemovalPatch({
    filesystemMode: input.filesystemMode,
    folders: normalizedRuleList(input.revokeFolders),
    blocks: normalizedRuleList(input.removeBlocks),
  });
  return parseAgentCapabilitySettings(document);
}

export async function applyAgentCapabilitySettingsPatchView(input: {
  filesystemMode?: unknown;
  revokeFolders?: unknown;
  removeBlocks?: unknown;
}) {
  return agentCapabilitySettingsViewFromConfig(await applyAgentCapabilitySettingsPatch(input));
}

export function normalizedRuleList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function agentCapabilitySettingsViewFromConfig(config: AgentCapabilityConfig) {
  return {
    ...agentCapabilityConfigToSettings(config),
    diagnostics: config.diagnostics,
  };
}

export function resetFolderCapabilityServiceForTests(): void {
  service = null;
}
