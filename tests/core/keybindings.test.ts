import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  effectiveShortcutBindings,
  normalizeKeybindingOverride,
  normalizePortableChord,
  portableChordFromEvent,
  portableChordMatchesEvent,
  type EffectiveShortcutBindings,
} from '../../src/core/keybindings';
import {
  ensureKeybindingsFile,
  keybindingsView,
  keybindingsPath,
  loadKeybindings,
  readLastAppliedLauncherBindings,
  retainLastAcceptedKeybindings,
  updateKeybindings,
  writeLastAppliedLauncherBindings,
  writeKeybindingsSchema,
} from '../../src/main/configuration/keybindings';

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'tenon-keybindings-'));
  roots.push(root);
  return root;
}

function writeSource(userData: string, source: string): void {
  const target = keybindingsPath(userData);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

describe('keybindings configuration', () => {
  test('uses defaults when the public source is missing', () => {
    const loaded = loadKeybindings(tempUserData());
    expect(loaded.sourceStatus).toBe('missing');
    expect(loaded.sourceDigest).toBeNull();
    expect(loaded.effective['global.open_agent_panel']).toEqual(['CommandOrControl+M']);
  });

  test('accepts comments, trailing commas, alternates, and explicit disable', () => {
    const userData = tempUserData();
    writeSource(userData, `{
      // Keep both physical choices.
      "global.open_agent_panel": ["mod + shift + m", "Control+M"],
      "global.toggle_page_translation": false,
    }\n`);
    const loaded = loadKeybindings(userData);
    expect(loaded.sourceStatus).toBe('accepted');
    expect(loaded.effective['global.open_agent_panel']).toEqual(['CommandOrControl+Shift+M', 'Control+M']);
    expect(loaded.effective['global.toggle_page_translation']).toEqual([]);
  });

  test('accepts an explicitly written configurable default even when fixed contextual grammar shares it', () => {
    const userData = tempUserData();
    writeSource(userData, '{ "global.go_to_today": "CommandOrControl+Shift+D" }\n');
    expect(loadKeybindings(userData)).toMatchObject({
      sourceStatus: 'accepted',
      effective: { 'global.go_to_today': ['CommandOrControl+Shift+D'] },
    });
  });

  test('rejects duplicate and unknown command ids without rewriting the source', () => {
    const userData = tempUserData();
    const duplicate = '{ "global.new_thread": "Control+N", "global.new_thread": "Control+T" }\n';
    writeSource(userData, duplicate);
    expect(loadKeybindings(userData)).toMatchObject({ sourceStatus: 'rejected', error: expect.stringContaining('duplicated') });
    expect(readFileSync(keybindingsPath(userData), 'utf8')).toBe(duplicate);

    const unknown = '{ "global.unknown": "Control+N" }\n';
    writeSource(userData, unknown);
    expect(loadKeybindings(userData)).toMatchObject({ sourceStatus: 'rejected', error: expect.stringContaining('not a configurable shortcut') });
    expect(readFileSync(keybindingsPath(userData), 'utf8')).toBe(unknown);
  });

  test('rejects invalid, reserved, duplicate, and conflicting chords', () => {
    expect(() => normalizePortableChord('M')).toThrow('modifier');
    expect(() => normalizePortableChord('CommandOrControl+Q')).toThrow('reserved');
    expect(() => normalizePortableChord('CommandOrControl+C')).toThrow('reserved');
    expect(() => normalizePortableChord('Command+C')).toThrow('reserved');
    expect(() => normalizePortableChord('Control+C')).toThrow('reserved');
    expect(() => normalizePortableChord('Control+I')).toThrow('reserved');
    expect(() => normalizePortableChord('Shift+P')).toThrow('must include');
    expect(() => normalizeKeybindingOverride(['Control+M', 'ctrl+m'], 'test')).toThrow('duplicate');

    const userData = tempUserData();
    writeSource(userData, `{
      "global.open_agent_panel": "Control+M",
      "global.new_thread": "Control+M"
    }\n`);
    expect(loadKeybindings(userData)).toMatchObject({ sourceStatus: 'rejected', error: expect.stringContaining('conflicts') });
  });

  test('rejects platform-equivalent CommandOrControl conflicts', () => {
    const userData = tempUserData();
    writeSource(userData, '{ "global.launcher": "Command+M" }\n');
    expect(loadKeybindings(userData)).toMatchObject({
      sourceStatus: 'rejected',
      error: expect.stringContaining('global.open_agent_panel conflicts with global.launcher'),
    });

    writeSource(userData, '{ "global.launcher": "Control+M" }\n');
    expect(loadKeybindings(userData)).toMatchObject({
      sourceStatus: 'rejected',
      error: expect.stringContaining('global.open_agent_panel conflicts with global.launcher'),
    });
  });

  test('preserves unrelated JSONC text on edit and rejects stale writes', () => {
    const userData = tempUserData();
    const source = `{
  // This comment and ordering are user-owned.
  "global.go_to_today": "Control+D",
  "global.new_thread": "Control+N",
}\n`;
    writeSource(userData, source);
    const loaded = loadKeybindings(userData);
    updateKeybindings(userData, {
      id: 'global.new_thread',
      value: ['Control+N', 'Control+T'],
      observedDigest: loaded.sourceDigest,
    });
    const edited = readFileSync(keybindingsPath(userData), 'utf8');
    expect(edited).toContain('// This comment and ordering are user-owned.');
    expect(edited.indexOf('global.go_to_today')).toBeLessThan(edited.indexOf('global.new_thread'));
    expect(() => updateKeybindings(userData, {
      id: 'global.new_thread', value: 'Control+Y', observedDigest: loaded.sourceDigest,
    })).toThrow('changed');
  });

  test('rejects a structured conflict before writing the public source', () => {
    const userData = tempUserData();
    const source = '{ "global.new_thread": "Control+N" }\n';
    writeSource(userData, source);
    const loaded = loadKeybindings(userData);
    expect(() => updateKeybindings(userData, {
      id: 'global.go_to_today', value: 'Control+N', observedDigest: loaded.sourceDigest,
    })).toThrow('conflicts');
    expect(readFileSync(keybindingsPath(userData), 'utf8')).toBe(source);
  });

  test('reset and Reset All remove overrides instead of writing defaults', () => {
    const userData = tempUserData();
    writeSource(userData, '{ "global.new_thread": "Control+N", "global.go_to_today": false }\n');
    let loaded = loadKeybindings(userData);
    loaded = updateKeybindings(userData, {
      id: 'global.new_thread', value: undefined, observedDigest: loaded.sourceDigest,
    });
    expect(loaded.overrides['global.new_thread']).toBeUndefined();
    loaded = updateKeybindings(userData, { resetAll: true, observedDigest: loaded.sourceDigest });
    expect(loaded.overrides).toEqual({});
    expect(readFileSync(keybindingsPath(userData), 'utf8')).not.toContain('global.go_to_today');
  });

  test('retains the last accepted snapshot when a later source is rejected', () => {
    const userData = tempUserData();
    writeSource(userData, '{ "global.new_thread": "Control+N" }\n');
    expect(loadKeybindings(userData).sourceStatus).toBe('accepted');
    writeSource(userData, '{ invalid');
    const recovered = loadKeybindings(userData);
    expect(recovered.sourceStatus).toBe('rejected');
    expect(recovered.effective['global.new_thread']).toEqual(['Control+N']);
    expect(readFileSync(keybindingsPath(userData), 'utf8')).toBe('{ invalid');
  });

  test('retains the in-memory accepted snapshot even when disk recovery is stale', () => {
    const acceptedUserData = tempUserData();
    writeSource(acceptedUserData, '{ "global.new_thread": "Control+N" }\n');
    const accepted = loadKeybindings(acceptedUserData);

    const rejectedUserData = tempUserData();
    writeSource(rejectedUserData, '{ invalid');
    const rejected = retainLastAcceptedKeybindings(accepted, loadKeybindings(rejectedUserData));
    expect(rejected).toMatchObject({
      sourceStatus: 'rejected',
      sourceBytes: '{ invalid',
      acceptedDigest: accepted.acceptedDigest,
      overrides: { 'global.new_thread': 'Control+N' },
      effective: { 'global.new_thread': ['Control+N'] },
    });
  });

  test('creates only the public source and generated schema on demand', () => {
    const userData = tempUserData();
    expect(ensureKeybindingsFile(userData)).toBe(keybindingsPath(userData));
    writeKeybindingsSchema(userData);
    expect(readFileSync(keybindingsPath(userData), 'utf8')).toBe('{\n}\n');
    expect(JSON.parse(readFileSync(join(userData, 'config', 'keybindings.schema.json'), 'utf8')))
      .toMatchObject({ title: 'Tenon Keybindings', additionalProperties: false });
  });

  test('persists bounded last-applied launcher state separately from desired input', () => {
    const userData = tempUserData();
    expect(readLastAppliedLauncherBindings(userData)).toBeNull();
    writeLastAppliedLauncherBindings(userData, ['Control+L']);
    expect(readLastAppliedLauncherBindings(userData)).toEqual(['Control+L']);
    expect(loadKeybindings(userData).effective['global.launcher'])
      .toEqual(['CommandOrControl+Shift+Space', 'Control+Alt+Space']);

    writeFileSync(join(userData, 'config', 'keybindings.last-applied.json'), JSON.stringify({
      launcher: ['Control+L', 'ctrl+l'],
    }));
    expect(readLastAppliedLauncherBindings(userData)).toBeNull();
  });

  test('reports desired and actually applied launcher bindings separately after failure', () => {
    const userData = tempUserData();
    writeSource(userData, '{ "global.launcher": "Control+L" }\n');
    const loaded = loadKeybindings(userData);
    const applied = {
      ...loaded.effective,
      'global.launcher': ['Control+P'],
    } as EffectiveShortcutBindings;
    const view = keybindingsView(loaded, applied, {
      'global.launcher': 'Could not register shortcut: Control+L',
    });
    expect(view.entries.find((entry) => entry.id === 'global.launcher')).toMatchObject({
      desired: 'Control+L',
      effective: ['Control+P'],
      status: 'failed',
      error: expect.stringContaining('Control+L'),
    });
  });
});

describe('portable keybinding semantics', () => {
  test('matches modifiers exactly and supports physical Option-letter input', () => {
    expect(portableChordMatchesEvent('CommandOrControl+M', {
      key: 'm', code: 'KeyM', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
    })).toBe(true);
    expect(portableChordMatchesEvent('CommandOrControl+M', {
      key: 'm', code: 'KeyM', metaKey: true, ctrlKey: true, shiftKey: false, altKey: false,
    })).toBe(false);
    expect(portableChordMatchesEvent('Control+M', {
      key: 'm', code: 'KeyM', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false,
    })).toBe(true);
    expect(portableChordMatchesEvent('Alt+A', {
      key: 'å', code: 'KeyA', metaKey: false, ctrlKey: false, shiftKey: false, altKey: true,
    })).toBe(true);
    expect(portableChordFromEvent({
      key: 'å', code: 'KeyA', metaKey: false, ctrlKey: false, shiftKey: false, altKey: true,
    })).toBe('Alt+A');
  });

  test('builds immutable effective defaults and overrides', () => {
    const effective = effectiveShortcutBindings({ 'global.new_thread': false });
    expect(effective['global.new_thread']).toEqual([]);
    expect(effective['global.go_to_today']).toEqual(['CommandOrControl+Shift+D']);
  });
});
