import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  effectiveShortcutBindings,
  assertNoKeybindingConflicts,
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
  readLastAppliedKeybindings,
  reconcileKeybindingsWithLauncher,
  retainLastAcceptedKeybindings,
  updateKeybindings,
  writeLastAppliedKeybindings,
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
    expect(loaded.effective['global.open_page_in_pane']).toEqual(['CommandOrControl+M']);
  });

  test('accepts comments, trailing commas, alternates, and explicit disable', () => {
    const userData = tempUserData();
    writeSource(userData, `{
      // Keep both physical choices.
      "global.open_page_in_pane": ["mod + shift + m", "Control+M"],
      "global.toggle_page_translation": false,
    }\n`);
    const loaded = loadKeybindings(userData);
    expect(loaded.sourceStatus).toBe('accepted');
    expect(loaded.effective['global.open_page_in_pane']).toEqual(['CommandOrControl+Shift+M', 'Control+M']);
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

  test.each(['CommandOrControl', 'Command', 'Control'])(
    'reserves selection duplication against overlapping commands using %s', (modifier) => {
      const userData = tempUserData();
      const chord = `${modifier}+Shift+D`;
      for (const id of ['global.launcher', 'global.open_page_in_pane', 'global.new_thread', 'global.toggle_page_translation']) {
        const source = JSON.stringify({ 'global.go_to_today': false, [id]: chord });
        writeSource(userData, source);
        expect(loadKeybindings(userData)).toMatchObject({
          sourceStatus: 'rejected', error: expect.stringContaining('selection.duplicate'),
        });
        expect(readFileSync(keybindingsPath(userData), 'utf8')).toBe(source);
      }
      writeSource(userData, JSON.stringify({ 'global.go_to_today': chord }));
      expect(loadKeybindings(userData).sourceStatus).toBe('accepted');
    },
  );

  test('rejects a structured selection conflict after Today is disabled without changing the source', () => {
    const userData = tempUserData();
    const source = '{ "global.go_to_today": false }';
    writeSource(userData, source);
    expect(() => updateKeybindings(userData, {
      id: 'global.open_page_in_pane', value: 'CommandOrControl+Shift+D',
      observedDigest: loadKeybindings(userData).sourceDigest,
    })).toThrow('selection.duplicate');
    expect(readFileSync(keybindingsPath(userData), 'utf8')).toBe(source);
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
      "global.open_page_in_pane": "Control+M",
      "global.new_thread": "Control+M"
    }\n`);
    expect(loadKeybindings(userData)).toMatchObject({ sourceStatus: 'rejected', error: expect.stringContaining('conflicts') });
  });

  test('rejects platform-equivalent CommandOrControl conflicts', () => {
    const userData = tempUserData();
    writeSource(userData, '{ "global.launcher": "Command+M" }\n');
    expect(loadKeybindings(userData)).toMatchObject({
      sourceStatus: 'rejected',
      error: expect.stringContaining('global.open_page_in_pane conflicts with global.launcher'),
    });

    writeSource(userData, '{ "global.launcher": "Control+M" }\n');
    expect(loadKeybindings(userData)).toMatchObject({
      sourceStatus: 'rejected',
      error: expect.stringContaining('global.open_page_in_pane conflicts with global.launcher'),
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

  test('missing-source defaults remain the accepted state after invalid recreation and restart', () => {
    const userData = tempUserData();
    writeSource(userData, '{ "global.new_thread": "Control+N" }');
    const custom = loadKeybindings(userData);
    rmSync(keybindingsPath(userData));
    const reset = retainLastAcceptedKeybindings(custom, loadKeybindings(userData));
    expect(reset.sourceStatus).toBe('missing');
    expect(reset.acceptedDigest).toBeNull();
    expect(reset.effective).toEqual(effectiveShortcutBindings({}));
    writeSource(userData, '{ invalid');
    const restarted = loadKeybindings(userData);
    const live = retainLastAcceptedKeybindings(reset, restarted);
    expect(restarted).toEqual(live);
    expect(restarted).toMatchObject({
      sourceStatus: 'rejected', acceptedDigest: null, overrides: {},
      effective: effectiveShortcutBindings({}),
    });
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

  test('persists the complete bounded last-applied set separately from desired input', () => {
    const userData = tempUserData();
    const bindings = effectiveShortcutBindings({ 'global.launcher': 'Control+L', 'global.new_thread': false });
    expect(readLastAppliedKeybindings(userData)).toBeNull();
    writeLastAppliedKeybindings(userData, bindings);
    expect(readLastAppliedKeybindings(userData)).toEqual(bindings);
    expect(loadKeybindings(userData).effective['global.launcher'])
      .toEqual(['CommandOrControl+Shift+Space', 'Control+Alt+Space']);

    writeFileSync(join(userData, 'config', 'keybindings.last-applied.json'), JSON.stringify({
      bindings: { ...bindings, 'global.launcher': ['Control+L', 'ctrl+l'] },
    }));
    expect(readLastAppliedKeybindings(userData)).toBeNull();
    writeFileSync(join(userData, 'config', 'keybindings.last-applied.json'), JSON.stringify({
      bindings: { ...bindings, 'global.launcher': ['Command+M'] },
    }));
    expect(readLastAppliedKeybindings(userData)).toBeNull();
    expect(() => writeLastAppliedKeybindings(userData, {
      ...bindings, 'global.launcher': ['Command+M'],
    })).toThrow('conflicts');
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

describe('effective keybinding reconciliation', () => {
  test('resolves retained-command dependencies that run opposite to registry order', () => {
    const previous = effectiveShortcutBindings({ 'global.launcher': 'Control+Alt+F18' });
    const desired = effectiveShortcutBindings({
      'global.launcher': 'Control+Alt+F19',
      'global.open_page_in_pane': 'CommandOrControl+Shift+O',
      'global.new_thread': 'Control+Alt+F18',
    });
    assertNoKeybindingConflicts(desired);
    const reconciled = reconcileKeybindingsWithLauncher(desired, previous, previous['global.launcher']);
    expect(reconciled.effective).toEqual(previous);
    expect(reconciled.errors).toEqual({
      'global.open_page_in_pane': expect.stringContaining('retained global.new_thread'),
      'global.new_thread': expect.stringContaining('retained global.launcher'),
    });
  });

  test('retains affected commands transitively after native rollback and persists the conflict-free set', () => {
    const previous = effectiveShortcutBindings({ 'global.launcher': 'Control+Alt+F18' });
    const desired = effectiveShortcutBindings({
      'global.launcher': 'Control+Alt+F19',
      'global.open_page_in_pane': 'Control+Alt+F18',
      'global.new_thread': 'CommandOrControl+M',
      'global.go_to_today': 'CommandOrControl+Shift+O',
      'global.toggle_page_translation': 'Control+Alt+J',
    });
    assertNoKeybindingConflicts(desired);
    const reconciled = reconcileKeybindingsWithLauncher(desired, previous, previous['global.launcher']);
    expect(reconciled.effective).toEqual({ ...previous, 'global.toggle_page_translation': ['Control+Alt+J'] });
    expect(reconciled.errors).toEqual({
      'global.open_page_in_pane': expect.stringContaining('retained global.launcher'),
      'global.new_thread': expect.stringContaining('retained global.open_page_in_pane'),
      'global.go_to_today': expect.stringContaining('retained global.new_thread'),
    });
    expect(() => assertNoKeybindingConflicts(reconciled.effective)).not.toThrow();
    const userData = tempUserData();
    writeLastAppliedKeybindings(userData, reconciled.effective);
    const restarted = reconcileKeybindingsWithLauncher(desired, readLastAppliedKeybindings(userData)!, previous['global.launcher']);
    expect(restarted).toEqual(reconciled);
    const retried = reconcileKeybindingsWithLauncher(desired, reconciled.effective, desired['global.launcher']);
    expect(retried).toEqual({ effective: desired, errors: {} });
  });

  test('omits unsafe startup fallbacks when no earlier application bindings are available', () => {
    const desired = effectiveShortcutBindings({
      'global.launcher': 'Control+Alt+F19', 'global.open_page_in_pane': 'CommandOrControl+Alt+F18',
    });
    const reconciled = reconcileKeybindingsWithLauncher(desired, desired, ['Command+Alt+F18']);
    expect(reconciled.effective['global.open_page_in_pane']).toEqual([]);
    expect(reconciled.errors['global.open_page_in_pane']).toContain('global.launcher');
    expect(() => assertNoKeybindingConflicts(reconciled.effective)).not.toThrow();
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
