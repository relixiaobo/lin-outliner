import { app } from 'electron';
import { join } from 'node:path';
import {
  agentCapabilityConfigToSettings,
  parseAgentCapabilitySettings,
  type AgentCapabilityConfig,
  type NormalizedAgentCapabilitySettings,
} from './agentCapabilityRules';
import {
  PRIVATE_JSON_FILE_OPTIONS,
  readJsonOrDefault,
  updateJsonFile,
} from '../../jsonFileStore';

const AGENT_CAPABILITIES_FILE = 'agent-capabilities.json';
const EMPTY_DOCUMENT = { blocks: [] as string[] };

export async function readAgentCapabilityConfig(): Promise<AgentCapabilityConfig> {
  return parseAgentCapabilitySettings(await readDocument());
}

export async function readAgentCapabilitySettings(): Promise<NormalizedAgentCapabilitySettings> {
  return agentCapabilityConfigToSettings(await readAgentCapabilityConfig());
}

export async function readAgentCapabilitySettingsView() {
  return agentCapabilitySettingsViewFromConfig(await readAgentCapabilityConfig());
}

export async function appendAgentCapabilityBlock(ruleValue: string): Promise<AgentCapabilityConfig> {
  const normalized = ruleValue.trim();
  if (!normalized) return readAgentCapabilityConfig();
  const document = await updateJsonFile(
    capabilityFilePath(),
    EMPTY_DOCUMENT,
    normalizeDocument,
    (current) => ({
      blocks: current.blocks.includes(normalized) ? current.blocks : [...current.blocks, normalized],
    }),
    PRIVATE_JSON_FILE_OPTIONS,
  );
  return parseAgentCapabilitySettings(document);
}

export async function appendAgentCapabilityBlockView(ruleValue: string) {
  return agentCapabilitySettingsViewFromConfig(await appendAgentCapabilityBlock(ruleValue));
}

export async function applyAgentCapabilitySettingsPatch(input: {
  removeBlocks?: unknown;
}): Promise<AgentCapabilityConfig> {
  const removed = normalizedRuleList(input.removeBlocks);
  const document = await updateJsonFile(
    capabilityFilePath(),
    EMPTY_DOCUMENT,
    normalizeDocument,
    (current) => ({
      blocks: current.blocks.filter((block) => !removed.includes(block)),
    }),
    PRIVATE_JSON_FILE_OPTIONS,
  );
  return parseAgentCapabilitySettings(document);
}

export async function applyAgentCapabilitySettingsPatchView(input: {
  removeBlocks?: unknown;
}) {
  return agentCapabilitySettingsViewFromConfig(await applyAgentCapabilitySettingsPatch(input));
}

export function normalizedRuleList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function capabilityFilePath(): string {
  return join(app.getPath('userData'), AGENT_CAPABILITIES_FILE);
}

async function readDocument(): Promise<{ blocks: string[] }> {
  return normalizeDocument(await readJsonOrDefault(capabilityFilePath(), EMPTY_DOCUMENT));
}

function normalizeDocument(input: unknown): { blocks: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...EMPTY_DOCUMENT };
  return { blocks: normalizedRuleList((input as Record<string, unknown>).blocks) };
}

function agentCapabilitySettingsViewFromConfig(config: AgentCapabilityConfig) {
  return {
    ...agentCapabilityConfigToSettings(config),
    diagnostics: config.diagnostics,
  };
}
