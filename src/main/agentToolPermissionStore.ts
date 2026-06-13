import { app } from 'electron';
import { join } from 'node:path';
import {
  globalToolPermissionConfigToSettings,
  parseGlobalToolPermissionSettings,
  type GlobalToolPermissionConfig,
  type GlobalToolPermissionSettings,
} from './agentToolPermissionRules';
import { PRIVATE_JSON_FILE_OPTIONS, readJsonOrDefault, updateJsonFile, writeJsonFile } from './jsonFileStore';

const AGENT_TOOL_PERMISSIONS_FILE = 'agent-tool-permissions.json';

export async function readAgentToolPermissionConfig(): Promise<GlobalToolPermissionConfig> {
  return parseGlobalToolPermissionSettings(await readAgentToolPermissionSettings());
}

export async function readAgentToolPermissionSettings(): Promise<GlobalToolPermissionSettings> {
  return readJsonOrDefault(permissionPath(), { permissions: { allow: [], ask: [], deny: [] } });
}

export async function readAgentToolPermissionSettingsView() {
  return agentToolPermissionSettingsView(await readAgentToolPermissionSettings());
}

export async function writeAgentToolPermissionSettings(settings: GlobalToolPermissionSettings): Promise<GlobalToolPermissionConfig> {
  const config = parseGlobalToolPermissionSettings(settings);
  await writeJsonFile(permissionPath(), globalToolPermissionConfigToSettings(config), PRIVATE_JSON_FILE_OPTIONS);
  return config;
}

export async function writeAgentToolPermissionSettingsView(settings: GlobalToolPermissionSettings) {
  const config = await writeAgentToolPermissionSettings(settings);
  return {
    ...globalToolPermissionConfigToSettings(config),
    diagnostics: config.diagnostics,
  };
}

export async function appendAgentToolPermissionAllowRule(ruleValue: string): Promise<GlobalToolPermissionConfig> {
  const nextSettings = await updateJsonFile(
    permissionPath(),
    { permissions: { allow: [], ask: [], deny: [] } },
    parsePermissionSettings,
    (settings) => {
      const permissions = {
        allow: normalizedRuleList(settings.permissions?.allow),
        ask: normalizedRuleList(settings.permissions?.ask),
        deny: normalizedRuleList(settings.permissions?.deny),
      };
      if (!permissions.allow.includes(ruleValue)) permissions.allow.push(ruleValue);
      return globalToolPermissionConfigToSettings(parseGlobalToolPermissionSettings({ permissions }));
    },
    PRIVATE_JSON_FILE_OPTIONS,
  );
  return parseGlobalToolPermissionSettings(nextSettings);
}

function agentToolPermissionSettingsView(settings: GlobalToolPermissionSettings) {
  const config = parseGlobalToolPermissionSettings(settings);
  return {
    ...globalToolPermissionConfigToSettings(config),
    diagnostics: config.diagnostics,
  };
}

function normalizedRuleList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parsePermissionSettings(value: unknown): Required<GlobalToolPermissionSettings> {
  return globalToolPermissionConfigToSettings(parseGlobalToolPermissionSettings(value));
}

function permissionPath() {
  return join(app.getPath('userData'), AGENT_TOOL_PERMISSIONS_FILE);
}
