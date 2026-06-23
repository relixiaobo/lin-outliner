import { describe, expect, test } from 'bun:test';
import type { AgentRuntimeSettings } from '../../src/core/types';
import {
  createSelfMaintenanceTools,
  normalizeRuntimeSettingPatch,
  readRuntimeSetting,
  type AgentSelfMaintenanceRuntime,
} from '../../src/main/agentSelfMaintenanceTools';

const RUNTIME_SETTINGS: AgentRuntimeSettings = {
  permissionMode: 'trusted',
  automaticSkillsEnabled: true,
  slashSkillsEnabled: true,
  compactEnabled: true,
  dreamSchedule: '2026-01-01T03:00 RRULE:FREQ=DAILY',
  additionalSkillDirectories: ['/tmp/skills'],
  providerTimeoutMs: null,
  providerMaxRetries: null,
  providerMaxRetryDelayMs: 60_000,
  providerCacheRetention: 'short',
  disabledSkills: [],
  disabledAgents: [],
};

describe('agent self-maintenance tools', () => {
  test('runtime_status and doctor return structured redacted data', async () => {
    const tools = createSelfMaintenanceTools(fakeRuntime());
    const runtimeStatus = tools.find((tool) => tool.name === 'runtime_status')!;
    const doctor = tools.find((tool) => tool.name === 'doctor')!;

    const statusResult = await runtimeStatus.execute('call-status', {});
    const doctorResult = await doctor.execute('call-doctor', {});

    expect(JSON.parse(statusResult.content[0]!.text)).toEqual({
      ok: true,
      data: {
        agentId: 'lin-agent',
        conversationId: 'lin-agent-dm-local',
        provider: {
          configured: true,
          providerId: 'openai',
          modelId: 'gpt-5',
          reasoningLevel: 'medium',
        },
        runtime: RUNTIME_SETTINGS,
      },
    });
    expect(statusResult.details).toMatchObject({
      ok: true,
      tool: 'runtime_status',
      data: { provider: { configured: true, providerId: 'openai' } },
    });

    expect(JSON.parse(doctorResult.content[0]!.text)).toEqual({
      ok: true,
      data: {
        ok: true,
        diagnostics: [{
          id: 'skill-dirs',
          severity: 'info',
          message: '1 additional skill directory configured.',
        }],
      },
    });
  });

  test('config reads and writes only whitelisted runtime settings', async () => {
    const writes: Array<{ setting: string; value: unknown }> = [];
    const tools = createSelfMaintenanceTools(fakeRuntime({
      writeConfig: async (setting, value) => {
        writes.push({ setting, value });
        return { operation: 'write', setting, value };
      },
    }));
    const config = tools.find((tool) => tool.name === 'config')!;

    const readResult = await config.execute('call-read', {
      setting: 'agent.runtime.providerCacheRetention',
    });
    const writeResult = await config.execute('call-write', {
      setting: 'agent.runtime.compactEnabled',
      value: false,
    });

    expect(JSON.parse(readResult.content[0]!.text)).toEqual({
      ok: true,
      data: {
        operation: 'read',
        setting: 'agent.runtime.providerCacheRetention',
        value: 'short',
      },
    });
    expect(JSON.parse(writeResult.content[0]!.text)).toEqual({
      ok: true,
      data: {
        operation: 'write',
        setting: 'agent.runtime.compactEnabled',
        value: false,
      },
    });
    expect(writes).toEqual([{ setting: 'agent.runtime.compactEnabled', value: false }]);
  });

  test('config reports validation errors through the shared tool envelope', async () => {
    const config = createSelfMaintenanceTools(fakeRuntime()).find((tool) => tool.name === 'config')!;

    const missingSetting = await config.execute('call-missing', {});
    const unsupportedSetting = await config.execute('call-unsupported', {
      setting: 'agent.runtime.additionalSkillDirectories',
      value: ['/tmp/other'],
    });

    expect(JSON.parse(missingSetting.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'MISSING_SETTING' },
    });
    expect(JSON.parse(unsupportedSetting.content[0]!.text)).toMatchObject({
      ok: false,
      error: {
        code: 'CONFIG_FAILED',
        message: 'Unsupported config setting: agent.runtime.additionalSkillDirectories',
      },
    });
    expect(unsupportedSetting.details).toMatchObject({
      ok: false,
      tool: 'config',
      error: { code: 'CONFIG_FAILED' },
    });
  });

  test('runtime setting normalization rejects unsupported or invalid writes', () => {
    expect(normalizeRuntimeSettingPatch('agent.runtime.compactEnabled', false)).toEqual({ compactEnabled: false });
    expect(normalizeRuntimeSettingPatch('agent.runtime.disabledSkills', ['a', ' a ', '', 'b'])).toEqual({
      disabledSkills: ['a', 'b'],
    });
    expect(normalizeRuntimeSettingPatch('agent.runtime.providerMaxRetries', 3.7)).toEqual({
      providerMaxRetries: 3,
    });
    expect(normalizeRuntimeSettingPatch('agent.runtime.providerTimeoutMs', null)).toEqual({
      providerTimeoutMs: null,
    });
    // memoryIsolation was removed: memory is one undivided believer pool, always writable.
    expect(() => normalizeRuntimeSettingPatch('agent.runtime.memoryIsolation', 'global')).toThrow(
      'Unsupported config setting: agent.runtime.memoryIsolation',
    );
    expect(() => normalizeRuntimeSettingPatch('agent.runtime.providerCacheRetention', 'forever')).toThrow(
      'agent.runtime.providerCacheRetention must be "none", "short", or "long".',
    );
    expect(() => normalizeRuntimeSettingPatch('agent.runtime.providerTimeoutMs', 999)).toThrow(
      'agent.runtime.providerTimeoutMs must be between 1000 and 300000, or null.',
    );
    expect(() => normalizeRuntimeSettingPatch('agent.runtime.additionalSkillDirectories', [])).toThrow(
      'Unsupported config setting: agent.runtime.additionalSkillDirectories',
    );
    expect(() => normalizeRuntimeSettingPatch('agent.runtime.dreamSchedule', '2026-01-01T04:00 RRULE:FREQ=DAILY')).toThrow(
      'agent.runtime.dreamSchedule is user-managed and cannot be changed by the agent.',
    );
  });

  test('runtime setting reads use the same whitelist as writes', () => {
    expect(readRuntimeSetting(RUNTIME_SETTINGS, 'agent.runtime.compactEnabled')).toBe(true);
    expect(readRuntimeSetting(RUNTIME_SETTINGS, 'agent.runtime.dreamSchedule')).toBe('2026-01-01T03:00 RRULE:FREQ=DAILY');
    expect(() => readRuntimeSetting(RUNTIME_SETTINGS, 'agent.runtime.memoryIsolation')).toThrow(
      'Unsupported config setting: agent.runtime.memoryIsolation',
    );
    expect(readRuntimeSetting(RUNTIME_SETTINGS, 'agent.runtime.disabledAgents')).toEqual([]);
    expect(() => readRuntimeSetting(RUNTIME_SETTINGS, 'agent.runtime.additionalSkillDirectories')).toThrow(
      'Unsupported config setting: agent.runtime.additionalSkillDirectories',
    );
  });
});

function fakeRuntime(overrides: Partial<AgentSelfMaintenanceRuntime> = {}): AgentSelfMaintenanceRuntime {
  return {
    runtimeStatus: async () => ({
      agentId: 'lin-agent',
      conversationId: 'lin-agent-dm-local',
      provider: {
        configured: true,
        providerId: 'openai',
        modelId: 'gpt-5',
        reasoningLevel: 'medium',
      },
      runtime: RUNTIME_SETTINGS,
    }),
    readConfig: async (setting) => ({
      operation: 'read',
      setting,
      value: readRuntimeSetting(RUNTIME_SETTINGS, setting),
    }),
    writeConfig: async (setting, value) => {
      normalizeRuntimeSettingPatch(setting, value);
      return {
        operation: 'write',
        setting,
        value,
      };
    },
    doctor: async () => ({
      ok: true,
      diagnostics: [{
        id: 'skill-dirs',
        severity: 'info',
        message: '1 additional skill directory configured.',
      }],
    }),
    ...overrides,
  };
}
