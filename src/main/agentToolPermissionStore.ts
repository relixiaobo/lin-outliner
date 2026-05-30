import { app } from 'electron';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  globalToolPermissionConfigToSettings,
  parseGlobalToolPermissionSettings,
  type GlobalToolPermissionConfig,
  type GlobalToolPermissionSettings,
} from './agentToolPermissionRules';

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
  await writeJsonFile(permissionPath(), globalToolPermissionConfigToSettings(config));
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
  const settings = await readAgentToolPermissionSettings();
  const permissions = {
    allow: normalizedRuleList(settings.permissions?.allow),
    ask: normalizedRuleList(settings.permissions?.ask),
    deny: normalizedRuleList(settings.permissions?.deny),
  };
  if (!permissions.allow.includes(ruleValue)) permissions.allow.push(ruleValue);
  return writeAgentToolPermissionSettings({ permissions });
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

async function readJsonOrDefault<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });
  if (process.platform !== 'win32') await chmod(parent, 0o700);
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
  if (process.platform !== 'win32') await chmod(filePath, 0o600);
}

async function atomicWrite(filePath: string, data: string) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}

function permissionPath() {
  return join(app.getPath('userData'), AGENT_TOOL_PERMISSIONS_FILE);
}
