import { describe, expect, test } from 'bun:test';
import { CONFIGURATION_DESTINATIONS, sanitizeSettingsOpenTarget, settingsOpenTargetFromSearch, settingsWindowQuery, windowSurfaceFromSearch } from '../../src/core/settingsWindow';
import { configurationCommandAllowed } from '../../src/main/configuration/windowAccess';

describe('direct configuration destinations', () => {
  test('round trips each native destination without category navigation', () => {
    for (const destination of CONFIGURATION_DESTINATIONS) {
      const query = new URLSearchParams(settingsWindowQuery({ destination }));
      expect(settingsOpenTargetFromSearch(`?${query}`)).toEqual({ destination });
      expect(windowSurfaceFromSearch(`?${query}`)).toBe(destination === 'settings' ? 'settings' : 'manager');
    }
  });
  test('accepts bounded preference IDs and rejects unknown destinations', () => {
    expect(sanitizeSettingsOpenTarget({ destination: 'settings', settingId: 'agent.provider.timeoutMs' })).toEqual({ destination: 'settings', settingId: 'agent.provider.timeoutMs' });
    for (const settingId of ['x"] .other', '../private', 'a'.repeat(129)]) expect(sanitizeSettingsOpenTarget({ settingId })).toEqual({});
    expect(settingsOpenTargetFromSearch('?category=agent/skills&anchor=memory')).toEqual({});
    expect(sanitizeSettingsOpenTarget({ destination: 'private', page: 'services' })).toEqual({});
  });
  test('admits domain operations by owner and credentials only in their child', () => {
    expect(configurationCommandAllowed('models', 'agent_get_provider_settings')).toBe(true);
    expect(configurationCommandAllowed('models', 'agent_upsert_provider_config')).toBe(true);
    expect(configurationCommandAllowed('provider-config', 'agent_set_provider_api_key')).toBe(true);
    for (const sender of ['main', ...CONFIGURATION_DESTINATIONS] as const) expect(configurationCommandAllowed(sender, 'agent_set_provider_api_key')).toBe(false);
    for (const sender of CONFIGURATION_DESTINATIONS) {
      expect(configurationCommandAllowed(sender, 'delete_node')).toBe(false);
      expect(configurationCommandAllowed(sender, 'agent_future_command')).toBe(false);
      expect(configurationCommandAllowed(sender, 'memory_manage')).toBe(sender === 'memory');
      expect(configurationCommandAllowed(sender, 'agent_skill_manage')).toBe(sender === 'skills');
    }
    expect(configurationCommandAllowed(null, 'agent_get_provider_settings')).toBe(false);
  });
});
