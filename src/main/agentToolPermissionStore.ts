import { app } from 'electron';
import { join } from 'node:path';
import { FolderCapabilityService } from './agentFolderCapabilities';
import {
  globalToolPermissionConfigToSettings,
  parseGlobalToolPermissionSettings,
  type GlobalToolPermissionConfig,
  type GlobalToolPermissionSettings,
} from './agentToolPermissionRules';

const AGENT_TOOL_PERMISSIONS_FILE = 'agent-tool-permissions.json';

let service: FolderCapabilityService | null = null;

export function getFolderCapabilityService(): FolderCapabilityService {
  service ??= new FolderCapabilityService(join(app.getPath('userData'), AGENT_TOOL_PERMISSIONS_FILE));
  return service;
}

export async function readAgentToolPermissionConfig(): Promise<GlobalToolPermissionConfig> {
  return parseGlobalToolPermissionSettings(await getFolderCapabilityService().read());
}

export async function readAgentToolPermissionSettings(): Promise<Required<GlobalToolPermissionSettings>> {
  return getFolderCapabilityService().read();
}

export async function readAgentToolPermissionSettingsView() {
  return agentToolPermissionSettingsViewFromConfig(await readAgentToolPermissionConfig());
}

export async function writeAgentToolPermissionSettings(settings: GlobalToolPermissionSettings): Promise<GlobalToolPermissionConfig> {
  const document = await getFolderCapabilityService().write(settings);
  return parseGlobalToolPermissionSettings(document);
}

export async function writeAgentToolPermissionSettingsView(settings: GlobalToolPermissionSettings) {
  return agentToolPermissionSettingsViewFromConfig(await writeAgentToolPermissionSettings(settings));
}

export async function grantAgentFolderCapability(folder: string): Promise<GlobalToolPermissionConfig> {
  return parseGlobalToolPermissionSettings(await getFolderCapabilityService().grant(folder));
}

export async function grantAgentFolderCapabilities(folders: readonly string[]): Promise<GlobalToolPermissionConfig> {
  return parseGlobalToolPermissionSettings(await getFolderCapabilityService().grantMany(folders));
}

export async function grantAgentFolderCapabilityView(folder: string) {
  return agentToolPermissionSettingsViewFromConfig(await grantAgentFolderCapability(folder));
}

export async function revokeAgentFolderCapability(folder: string): Promise<GlobalToolPermissionConfig> {
  return parseGlobalToolPermissionSettings(await getFolderCapabilityService().revoke(folder));
}

export async function appendAgentToolPermissionBlock(ruleValue: string): Promise<GlobalToolPermissionConfig> {
  return parseGlobalToolPermissionSettings(await getFolderCapabilityService().appendBlock(ruleValue));
}

export async function appendAgentToolPermissionBlockView(ruleValue: string) {
  return agentToolPermissionSettingsViewFromConfig(await appendAgentToolPermissionBlock(ruleValue));
}

export async function removeAgentToolPermissionBlock(ruleValue: string): Promise<GlobalToolPermissionConfig> {
  return parseGlobalToolPermissionSettings(await getFolderCapabilityService().removeBlock(ruleValue));
}

export function normalizedRuleList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function agentToolPermissionSettingsViewFromConfig(config: GlobalToolPermissionConfig) {
  return {
    ...globalToolPermissionConfigToSettings(config),
    diagnostics: config.diagnostics,
  };
}

export function resetFolderCapabilityServiceForTests(): void {
  service = null;
}
