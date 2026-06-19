import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentRuntimeSettings, AgentRuntimeSettingsInput } from '../core/types';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

export interface RuntimeStatusData {
  agentId: string;
  conversationId: string;
  provider: {
    configured: boolean;
    providerId?: string;
    modelId?: string;
    reasoningLevel?: string;
  };
  runtime: AgentRuntimeSettings;
}

export interface ConfigToolData {
  operation: 'read' | 'write';
  setting: string;
  value: unknown;
}

export interface DoctorDiagnostic {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  recommendation?: string;
}

export interface DoctorData {
  ok: boolean;
  diagnostics: DoctorDiagnostic[];
}

export interface AgentSelfMaintenanceRuntime {
  runtimeStatus(): Promise<RuntimeStatusData>;
  readConfig(setting: string): Promise<ConfigToolData>;
  writeConfig(setting: string, value: unknown): Promise<ConfigToolData>;
  doctor(): Promise<DoctorData>;
}

const RUNTIME_STATUS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

const CONFIG_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['setting'],
  properties: {
    setting: { type: 'string', minLength: 1, maxLength: 120 },
    value: {},
  },
} as const;

const DOCTOR_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

export function createSelfMaintenanceTools(runtime: AgentSelfMaintenanceRuntime): AgentTool<any>[] {
  return [
    {
      name: 'runtime_status',
      label: 'Runtime Status',
      description: 'Read the current local agent runtime status, with secrets redacted.',
      parameters: RUNTIME_STATUS_PARAMETERS,
      executionMode: 'parallel',
      execute: async () => selfMaintenanceResult('runtime_status', await runtime.runtimeStatus()),
    },
    {
      name: 'config',
      label: 'Config',
      description: 'Read or update whitelisted local agent runtime settings. Omit value to read; pass value to request a write.',
      parameters: CONFIG_PARAMETERS,
      executionMode: 'sequential',
      execute: async (_toolCallId, rawParams: unknown) => {
        const params = isRecord(rawParams) ? rawParams : {};
        const setting = typeof params.setting === 'string' ? params.setting.trim() : '';
        if (!setting) return selfMaintenanceError<ConfigToolData>('config', 'MISSING_SETTING', 'Pass setting.');
        try {
          if (!Object.hasOwn(params, 'value')) return selfMaintenanceResult('config', await runtime.readConfig(setting));
          return selfMaintenanceResult('config', await runtime.writeConfig(setting, params.value));
        } catch (error) {
          return selfMaintenanceError<ConfigToolData>('config', 'CONFIG_FAILED', errorMessage(error));
        }
      },
    },
    {
      name: 'doctor',
      label: 'Doctor',
      description: 'Run read-only diagnostics for local agent configuration and runtime health. Secrets are redacted.',
      parameters: DOCTOR_PARAMETERS,
      executionMode: 'parallel',
      execute: async () => selfMaintenanceResult('doctor', await runtime.doctor()),
    },
  ];
}

export function normalizeRuntimeSettingPatch(setting: string, value: unknown): AgentRuntimeSettingsInput {
  switch (setting) {
    case 'agent.runtime.compactEnabled':
      return { compactEnabled: requireBoolean(setting, value) };
    case 'agent.runtime.automaticSkillsEnabled':
      return { automaticSkillsEnabled: requireBoolean(setting, value) };
    case 'agent.runtime.slashSkillsEnabled':
      return { slashSkillsEnabled: requireBoolean(setting, value) };
    case 'agent.runtime.disabledSkills':
      return { disabledSkills: requireStringArray(setting, value) };
    case 'agent.runtime.disabledAgents':
      return { disabledAgents: requireStringArray(setting, value) };
    case 'agent.runtime.providerTimeoutMs':
      return { providerTimeoutMs: nullableInteger(setting, value, 1_000, 300_000) };
    case 'agent.runtime.providerMaxRetries':
      return { providerMaxRetries: nullableInteger(setting, value, 0, 10) };
    case 'agent.runtime.providerMaxRetryDelayMs':
      return { providerMaxRetryDelayMs: nullableInteger(setting, value, 1_000, 300_000) };
    case 'agent.runtime.providerCacheRetention':
      if (value === 'none' || value === 'short' || value === 'long') return { providerCacheRetention: value };
      throw new Error(`${setting} must be "none", "short", or "long".`);
    default:
      throw new Error(`Unsupported config setting: ${setting}`);
  }
}

export function readRuntimeSetting(settings: AgentRuntimeSettings, setting: string): unknown {
  switch (setting) {
    case 'agent.runtime.compactEnabled':
      return settings.compactEnabled;
    case 'agent.runtime.automaticSkillsEnabled':
      return settings.automaticSkillsEnabled;
    case 'agent.runtime.slashSkillsEnabled':
      return settings.slashSkillsEnabled;
    case 'agent.runtime.disabledSkills':
      return settings.disabledSkills ?? [];
    case 'agent.runtime.disabledAgents':
      return settings.disabledAgents ?? [];
    case 'agent.runtime.providerTimeoutMs':
      return settings.providerTimeoutMs;
    case 'agent.runtime.providerMaxRetries':
      return settings.providerMaxRetries;
    case 'agent.runtime.providerMaxRetryDelayMs':
      return settings.providerMaxRetryDelayMs;
    case 'agent.runtime.providerCacheRetention':
      return settings.providerCacheRetention;
    default:
      throw new Error(`Unsupported config setting: ${setting}`);
  }
}

function selfMaintenanceResult<TData>(
  tool: string,
  data: TData,
  started?: number,
  instructions?: string,
) {
  return agentToolResult(successEnvelope(tool, data, {
    ...(started !== undefined ? { metrics: { durationMs: Date.now() - started } } : {}),
    ...(instructions ? { instructions } : {}),
  }), visibleSelfMaintenanceData(tool, data));
}

function selfMaintenanceError<TData>(
  tool: string,
  code: string,
  message: string,
  started?: number,
  data?: TData,
) {
  return agentToolResult(errorEnvelope<TData>(tool, code, message, {
    ...(data !== undefined ? { data } : {}),
    ...(started !== undefined ? { metrics: { durationMs: Date.now() - started } } : {}),
    instructions: 'Inspect the error and retry only if the requested runtime maintenance action is still relevant.',
  }), data === undefined ? undefined : visibleSelfMaintenanceData(tool, data));
}

function visibleSelfMaintenanceData(tool: string, data: unknown): unknown {
  return data;
}

function requireBoolean(setting: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(`${setting} must be a boolean.`);
  return value;
}

function requireStringArray(setting: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${setting} must be an array of strings.`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function nullableInteger(setting: string, value: unknown, min: number, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${setting} must be a number or null.`);
  const integer = Math.trunc(value);
  if (integer < min || integer > max) throw new Error(`${setting} must be between ${min} and ${max}, or null.`);
  return integer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
