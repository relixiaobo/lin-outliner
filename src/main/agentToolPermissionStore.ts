import { app } from 'electron';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  globalToolPermissionConfigToSettings,
  parseGlobalToolPermissionSettings,
  type GlobalToolPermissionConfig,
  type GlobalToolPermissionSettings,
} from './agentToolPermissionRules';
import { PRIVATE_JSON_FILE_OPTIONS, readJsonOrDefault, updateJsonFile, writeJsonFile } from './jsonFileStore';

const AGENT_TOOL_PERMISSIONS_FILE = 'agent-tool-permissions.json';

interface PermissionConfigCache {
  filePath: string;
  fingerprint: string;
  config: GlobalToolPermissionConfig;
}

let cachedPermissionConfig: PermissionConfigCache | null = null;

export async function readAgentToolPermissionConfig(): Promise<GlobalToolPermissionConfig> {
  const filePath = permissionPath();
  const fingerprint = await permissionFileFingerprint(filePath);
  if (
    cachedPermissionConfig
    && cachedPermissionConfig.filePath === filePath
    && cachedPermissionConfig.fingerprint === fingerprint
  ) {
    return cachedPermissionConfig.config;
  }
  const config = parseGlobalToolPermissionSettings(await readAgentToolPermissionSettings());
  cachedPermissionConfig = { filePath, fingerprint, config };
  return config;
}

export async function readAgentToolPermissionSettings(): Promise<GlobalToolPermissionSettings> {
  return readJsonOrDefault(permissionPath(), { grants: [], blocks: [], softBlockAllows: [] });
}

export async function readAgentToolPermissionSettingsView() {
  return agentToolPermissionSettingsView(await readAgentToolPermissionSettings());
}

export async function writeAgentToolPermissionSettings(settings: GlobalToolPermissionSettings): Promise<GlobalToolPermissionConfig> {
  const config = parseGlobalToolPermissionSettings(settings);
  const filePath = permissionPath();
  await writeJsonFile(filePath, globalToolPermissionConfigToSettings(config), PRIVATE_JSON_FILE_OPTIONS);
  cachedPermissionConfig = { filePath, fingerprint: await permissionFileFingerprint(filePath), config };
  return config;
}

export async function writeAgentToolPermissionSettingsView(settings: GlobalToolPermissionSettings) {
  const config = await writeAgentToolPermissionSettings(settings);
  return agentToolPermissionSettingsViewFromConfig(config);
}

export async function appendAgentToolPermissionGrant(ruleValue: string): Promise<GlobalToolPermissionConfig> {
  return updateAgentToolPermissionRuleList('grants', ruleValue, 'append');
}

export async function appendAgentToolPermissionBlock(ruleValue: string): Promise<GlobalToolPermissionConfig> {
  return updateAgentToolPermissionRuleList('blocks', ruleValue, 'append');
}

export async function appendAgentToolPermissionBlockView(ruleValue: string) {
  return agentToolPermissionSettingsViewFromConfig(await appendAgentToolPermissionBlock(ruleValue));
}

export async function removeAgentToolPermissionBlock(ruleValue: string): Promise<GlobalToolPermissionConfig> {
  return updateAgentToolPermissionRuleList('blocks', ruleValue, 'remove');
}

export async function appendAgentToolPermissionSoftBlockAllow(ruleValue: string): Promise<GlobalToolPermissionConfig> {
  return updateAgentToolPermissionRuleList('softBlockAllows', ruleValue, 'append');
}

async function updateAgentToolPermissionRuleList(
  key: 'grants' | 'blocks' | 'softBlockAllows',
  ruleValue: string,
  operation: 'append' | 'remove',
): Promise<GlobalToolPermissionConfig> {
  const normalizedRuleValue = ruleValue.trim();
  if (!normalizedRuleValue) return readAgentToolPermissionConfig();
  const filePath = permissionPath();
  const nextSettings = await updateJsonFile(
    filePath,
    { grants: [], blocks: [], softBlockAllows: [] },
    parsePermissionSettings,
    (settings) => {
      const next = {
        grants: normalizedRuleList(settings.grants),
        blocks: normalizedRuleList(settings.blocks),
        softBlockAllows: normalizedRuleList(settings.softBlockAllows),
      };
      const rules = next[key];
      if (operation === 'append' && !rules.includes(normalizedRuleValue)) rules.push(normalizedRuleValue);
      if (operation === 'remove') next[key] = rules.filter((candidate) => candidate !== normalizedRuleValue);
      return globalToolPermissionConfigToSettings(parseGlobalToolPermissionSettings(next));
    },
    PRIVATE_JSON_FILE_OPTIONS,
  );
  const config = parseGlobalToolPermissionSettings(nextSettings);
  cachedPermissionConfig = { filePath, fingerprint: await permissionFileFingerprint(filePath), config };
  return config;
}

function agentToolPermissionSettingsView(settings: GlobalToolPermissionSettings) {
  const config = parseGlobalToolPermissionSettings(settings);
  return agentToolPermissionSettingsViewFromConfig(config);
}

function agentToolPermissionSettingsViewFromConfig(config: GlobalToolPermissionConfig) {
  return {
    ...globalToolPermissionConfigToSettings(config),
    diagnostics: config.diagnostics,
  };
}

export function normalizedRuleList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parsePermissionSettings(
  value: unknown,
): Required<Pick<GlobalToolPermissionSettings, 'grants' | 'blocks' | 'softBlockAllows'>> {
  return globalToolPermissionConfigToSettings(parseGlobalToolPermissionSettings(value));
}

function permissionPath() {
  return join(app.getPath('userData'), AGENT_TOOL_PERMISSIONS_FILE);
}

async function permissionFileFingerprint(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'missing';
  }
}
