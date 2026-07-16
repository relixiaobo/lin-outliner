import { app } from 'electron';
import { join } from 'node:path';
import { FolderCapabilityService } from './agentFolderCapabilities';
import {
  agentCapabilityConfigToSettings,
  parseAgentCapabilitySettings,
  type AgentCapabilityConfig,
  type AgentCapabilitySettings,
} from './agentCapabilityRules';

const AGENT_CAPABILITIES_FILE = 'agent-capabilities.json';

let service: FolderCapabilityService | null = null;

export function getFolderCapabilityService(): FolderCapabilityService {
  service ??= new FolderCapabilityService(join(app.getPath('userData'), AGENT_CAPABILITIES_FILE));
  return service;
}

export async function readAgentCapabilityConfig(): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await getFolderCapabilityService().read());
}

export async function readAgentCapabilitySettings(): Promise<Required<AgentCapabilitySettings>> {
  return getFolderCapabilityService().read();
}

export async function readAgentCapabilitySettingsView() {
  return agentCapabilitySettingsViewFromConfig(await readAgentCapabilityConfig());
}

export async function writeAgentCapabilitySettings(settings: AgentCapabilitySettings): Promise<AgentCapabilityConfig> {
  const document = await getFolderCapabilityService().write(settings);
  return parseAgentCapabilitySettings(document);
}

export async function writeAgentCapabilitySettingsView(settings: AgentCapabilitySettings) {
  return agentCapabilitySettingsViewFromConfig(await writeAgentCapabilitySettings(settings));
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

export async function revokeAgentFolderCapability(folder: string): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await getFolderCapabilityService().revoke(folder));
}

export async function appendAgentCapabilityBlock(ruleValue: string): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await getFolderCapabilityService().appendBlock(ruleValue));
}

export async function appendAgentCapabilityBlockView(ruleValue: string) {
  return agentCapabilitySettingsViewFromConfig(await appendAgentCapabilityBlock(ruleValue));
}

export async function removeAgentCapabilityBlock(ruleValue: string): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await getFolderCapabilityService().removeBlock(ruleValue));
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
