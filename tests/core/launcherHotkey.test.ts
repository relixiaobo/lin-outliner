import { describe, expect, mock, test } from 'bun:test';
import type { GlobalShortcutRegistrar } from '../../src/main/launcher/launcherHotkey';

mock.module('electron', () => ({ globalShortcut: {} }));

const {
  registerLauncherHotkeys,
  replaceLauncherHotkeys,
  unregisterLauncherHotkeys,
} = await import('../../src/main/launcher/launcherHotkey');

function registrar(blocked: readonly string[] = []) {
  const callbacks = new Map<string, () => void>();
  const unavailable = new Set(blocked);
  const api: GlobalShortcutRegistrar = {
    isRegistered: (accelerator) => callbacks.has(accelerator) || unavailable.has(accelerator),
    register: (accelerator, callback) => {
      if (unavailable.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => { callbacks.delete(accelerator); },
  };
  return { api, callbacks };
}

describe('launcher hotkey ownership', () => {
  test('startup registers every free alternate and reports unavailable candidates', () => {
    const host = registrar(['Control+Alt+Space']);
    const result = registerLauncherHotkeys(
      () => undefined,
      ['CommandOrControl+Shift+Space', 'Control+Alt+Space'],
      host.api,
    );
    expect(result.accelerators).toEqual(['CommandOrControl+Shift+Space']);
    expect(result.error).toContain('Control+Alt+Space');
  });

  test('registers replacements before releasing old accelerators', () => {
    const events: string[] = [];
    const callbacks = new Set(['Control+M']);
    const api: GlobalShortcutRegistrar = {
      isRegistered: (accelerator) => callbacks.has(accelerator),
      register: (accelerator) => { events.push(`register:${accelerator}`); callbacks.add(accelerator); return true; },
      unregister: (accelerator) => { events.push(`unregister:${accelerator}`); callbacks.delete(accelerator); },
    };
    const result = replaceLauncherHotkeys(['Control+M'], ['Control+N'], () => undefined, api);
    expect(result).toMatchObject({ accelerators: ['Control+N'], error: null });
    expect(events).toEqual(['register:Control+N', 'unregister:Control+M']);
  });

  test('rolls back additions and retains the previous set when registration fails', () => {
    const host = registrar(['Control+T']);
    host.callbacks.set('Control+M', () => undefined);
    const result = replaceLauncherHotkeys(
      ['Control+M'],
      ['Control+N', 'Control+T'],
      () => undefined,
      host.api,
    );
    expect(result.accelerators).toEqual(['Control+M']);
    expect(result.error).toContain('Control+T');
    expect([...host.callbacks.keys()]).toEqual(['Control+M']);
  });

  test('explicit disable unregisters only owned launcher chords', () => {
    const host = registrar();
    host.callbacks.set('Control+M', () => undefined);
    host.callbacks.set('Control+N', () => undefined);
    const result = replaceLauncherHotkeys(['Control+M'], [], () => undefined, host.api);
    expect(result.accelerators).toEqual([]);
    expect([...host.callbacks.keys()]).toEqual(['Control+N']);
    unregisterLauncherHotkeys(['Control+N'], host.api);
    expect(host.callbacks.size).toBe(0);
  });
});
