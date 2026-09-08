import { describe, expect, test } from 'bun:test';
import { CONFIGURATION_DESTINATIONS, sanitizeSettingsOpenTarget, settingsOpenTargetFromSearch, settingsWindowQuery, windowSurfaceFromSearch } from '../../src/core/settingsWindow';
import { configurationCommandAllowed } from '../../src/main/configuration/windowAccess';

describe('single-window configuration destinations', () => {
  test('routes every Settings pane to one surface and keeps About separate', () => {
    for (const destination of CONFIGURATION_DESTINATIONS) {
      const query = new URLSearchParams(settingsWindowQuery({ destination }));
      expect(settingsOpenTargetFromSearch(`?${query}`)).toEqual({ destination });
      expect(windowSurfaceFromSearch(`?${query}`)).toBe(destination === 'about' ? 'about' : 'settings');
    }
  });
  test('accepts bounded preference IDs and rejects unknown destinations', () => {
    expect(sanitizeSettingsOpenTarget({ destination: 'settings', settingId: 'agent.provider.timeoutMs' })).toEqual({ destination: 'settings', settingId: 'agent.provider.timeoutMs' });
    for (const settingId of ['x"] .other', '../private', 'a'.repeat(129)]) expect(sanitizeSettingsOpenTarget({ settingId })).toEqual({});
    expect(settingsOpenTargetFromSearch('?category=agent/skills&anchor=memory')).toEqual({});
    expect(sanitizeSettingsOpenTarget({ destination: 'private', page: 'services' })).toEqual({});
  });
  test('admits only configuration operations in Settings and credentials only in its child', () => {
    for (const command of ['agent_get_provider_settings', 'agent_upsert_provider_config', 'memory_manage', 'agent_skill_manage']) {
      expect(configurationCommandAllowed('settings', command)).toBe(true);
      expect(configurationCommandAllowed('about', command)).toBe(false);
    }
    expect(configurationCommandAllowed('provider-config', 'agent_set_provider_api_key')).toBe(true);
    for (const sender of ['main', 'settings', 'about'] as const) expect(configurationCommandAllowed(sender, 'agent_set_provider_api_key')).toBe(false);
    for (const sender of ['settings', 'about', 'provider-config'] as const) {
      expect(configurationCommandAllowed(sender, 'delete_node')).toBe(false);
      expect(configurationCommandAllowed(sender, 'agent_future_command')).toBe(false);
    }
    expect(configurationCommandAllowed('provider-config', 'memory_manage')).toBe(false);
    expect(configurationCommandAllowed('provider-config', 'agent_skill_manage')).toBe(false);
    expect(configurationCommandAllowed(null, 'agent_get_provider_settings')).toBe(false);
  });
});
