import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, modify as jsoncModify, parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import {
  CONFIGURABLE_SHORTCUT_IDS,
  CONFIGURABLE_SHORTCUTS,
  assertNoKeybindingConflicts,
  effectiveShortcutBindings,
  isConfigurableShortcutId,
  normalizeKeybindingOverride,
  normalizePortableChord,
  portableChordsConflict,
  type ConfigurableShortcutId,
  type EffectiveShortcutBindings,
  type KeybindingOverride,
  type KeybindingsUpdateInput,
  type KeybindingsView,
} from '../../core/keybindings';
import { atomicWriteFileSync, writeJsonFileSync } from '../jsonFileStore';

export const KEYBINDINGS_RELATIVE_PATH = join('config', 'keybindings.jsonc');
export const KEYBINDINGS_SCHEMA_RELATIVE_PATH = join('config', 'keybindings.schema.json');
export const MAX_KEYBINDINGS_BYTES = 256 * 1024;
const RECOVERY_RELATIVE_PATH = join('config', 'keybindings.last-known-good.json');
const LAST_APPLIED_RELATIVE_PATH = join('config', 'keybindings.last-applied.json');

export type KeybindingOverrides = Readonly<Partial<Record<ConfigurableShortcutId, KeybindingOverride>>>;

export interface KeybindingsLoadResult {
  readonly path: string;
  readonly schemaPath: string;
  readonly sourceStatus: 'missing' | 'accepted' | 'rejected';
  readonly sourceBytes: string | null;
  readonly sourceDigest: string | null;
  readonly acceptedDigest: string | null;
  readonly overrides: KeybindingOverrides;
  readonly effective: Readonly<Record<ConfigurableShortcutId, readonly string[]>>;
  readonly error: string | null;
}

export function keybindingsPath(userDataDir: string): string {
  return join(userDataDir, KEYBINDINGS_RELATIVE_PATH);
}

export function loadKeybindings(userDataDir: string, options: { readonly readOnly?: boolean } = {}): KeybindingsLoadResult {
  const path = keybindingsPath(userDataDir);
  let sourceBytes: string;
  try {
    sourceBytes = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      try {
        if (!options.readOnly) rmSync(join(userDataDir, RECOVERY_RELATIVE_PATH), { force: true });
      } catch (cacheError) {
        console.warn('[keybindings] failed to clear obsolete recovery cache', cacheError);
      }
      return result(userDataDir, 'missing', null, {}, null);
    }
    const recovery = readRecovery(userDataDir);
    return result(userDataDir, 'rejected', null, recovery.overrides, errorText(error), recovery.digest);
  }
  if (Buffer.byteLength(sourceBytes, 'utf8') > MAX_KEYBINDINGS_BYTES) {
    const recovery = readRecovery(userDataDir);
    return result(
      userDataDir,
      'rejected',
      sourceBytes,
      recovery.overrides,
      `Source exceeds ${MAX_KEYBINDINGS_BYTES} bytes`,
      recovery.digest,
    );
  }
  try {
    const overrides = decodeKeybindings(parseJsonc(sourceBytes));
    try {
      if (!options.readOnly) writeRecovery(userDataDir, sourceBytes);
    } catch {
      // Recovery is a cache. A cache-write failure cannot reject valid desired
      // state or stop the current Host from applying it.
    }
    return result(userDataDir, 'accepted', sourceBytes, overrides, null, digest(sourceBytes));
  } catch (error) {
    const recovery = readRecovery(userDataDir);
    return result(userDataDir, 'rejected', sourceBytes, recovery.overrides, errorText(error), recovery.digest);
  }
}

export function updateKeybindings(userDataDir: string, input: KeybindingsUpdateInput): KeybindingsLoadResult {
  const loaded = loadKeybindings(userDataDir);
  if (loaded.sourceStatus === 'rejected') throw new Error(`Cannot edit rejected keybindings source: ${loaded.error}`);
  if (loaded.sourceDigest !== input.observedDigest) {
    throw new Error('Keybindings source changed; reload and try again');
  }
  let source = loaded.sourceBytes ?? '{}';
  if (input.resetAll) {
    for (const id of CONFIGURABLE_SHORTCUT_IDS) source = modify(source, [id], undefined);
  } else {
    if (!isConfigurableShortcutId(input.id)) throw new Error('Unknown configurable shortcut');
    const value = input.value === undefined
      ? undefined
      : normalizeKeybindingOverride(input.value, input.id);
    source = modify(source, [input.id], value);
  }
  decodeKeybindings(parseJsonc(source));
  const observed = readSource(pathFor(userDataDir));
  if (observed !== loaded.sourceBytes) throw new Error('Keybindings source changed; reload and try again');
  atomicWriteFileSync(pathFor(userDataDir), source, { mode: 0o600, directoryMode: 0o700 });
  return loadKeybindings(userDataDir);
}

export function decodeKeybindingsUpdateInput(value: unknown): KeybindingsUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Keybindings update must be an object');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !['id', 'value', 'resetAll', 'observedDigest'].includes(key))) {
    throw new Error('Keybindings update contains an unknown field');
  }
  const observedDigest = input.observedDigest;
  if (observedDigest !== null && (typeof observedDigest !== 'string' || !/^[a-f0-9]{8}$/u.test(observedDigest))) {
    throw new Error('Keybindings update requires the observed source digest');
  }
  if (input.resetAll === true) {
    if (input.id !== undefined || input.value !== undefined) throw new Error('Reset All cannot include a shortcut entry');
    return { resetAll: true, observedDigest };
  }
  if (!isConfigurableShortcutId(input.id)) throw new Error('Unknown configurable shortcut');
  if (input.resetAll !== undefined) throw new Error('resetAll must be true when present');
  return {
    id: input.id,
    ...(Object.prototype.hasOwnProperty.call(input, 'value')
      ? { value: input.value === undefined ? undefined : normalizeKeybindingOverride(input.value, input.id) }
      : {}),
    observedDigest,
  };
}

export function ensureKeybindingsFile(userDataDir: string): string {
  const loaded = loadKeybindings(userDataDir);
  if (loaded.sourceStatus === 'missing') {
    atomicWriteFileSync(loaded.path, '{\n}\n', { mode: 0o600, directoryMode: 0o700 });
  }
  return loaded.path;
}

export function keybindingsView(
  loaded: KeybindingsLoadResult,
  applied: Readonly<Record<ConfigurableShortcutId, readonly string[]>> = loaded.effective,
  errors: Readonly<Partial<Record<ConfigurableShortcutId, string>>> = {},
): KeybindingsView {
  return Object.freeze({
    source: {
      path: loaded.path,
      schemaPath: loaded.schemaPath,
      status: loaded.sourceStatus,
      observedDigest: loaded.sourceDigest,
      acceptedDigest: loaded.acceptedDigest,
      error: loaded.error,
    },
    entries: Object.freeze(CONFIGURABLE_SHORTCUTS.map((definition) => {
      const desired = loaded.overrides[definition.id] ?? null;
      const error = errors[definition.id] ?? null;
      return Object.freeze({
        id: definition.id,
        context: definition.context,
        desired,
        effective: applied[definition.id],
        defaults: definition.defaultBindings,
        status: error
          ? 'failed' as const
          : desired === false
            ? 'disabled' as const
            : desired === null
              ? 'default' as const
              : 'applied' as const,
        error,
      });
    })),
  });
}

export function retainLastAcceptedKeybindings(
  previous: KeybindingsLoadResult,
  candidate: KeybindingsLoadResult,
): KeybindingsLoadResult {
  if (candidate.sourceStatus !== 'rejected') return candidate;
  return Object.freeze({
    ...candidate,
    acceptedDigest: previous.acceptedDigest,
    overrides: previous.overrides,
    effective: previous.effective,
  });
}

/** Reconcile native rollback before publishing handlers, hints, or status. */
export function reconcileKeybindingsWithLauncher(
  desired: EffectiveShortcutBindings,
  previous: EffectiveShortcutBindings,
  launcher: readonly string[],
): {
  effective: EffectiveShortcutBindings;
  errors: Readonly<Partial<Record<ConfigurableShortcutId, string>>>;
} {
  const effective = { ...desired, 'global.launcher': Object.freeze([...launcher]) };
  const errors: Partial<Record<ConfigurableShortcutId, string>> = {};
  const retained = new Set<ConfigurableShortcutId>(['global.launcher']);
  // Restoring an application chord can block another proposed move. Resolve
  // that dependency transitively; each pass retains at least one more command.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of CONFIGURABLE_SHORTCUT_IDS) {
      if (retained.has(id)) continue;
      const conflictsWithRetained = (chord: string) => [...retained].find((owner) => (
        effective[owner].some((other) => portableChordsConflict(chord, other))
      ));
      const chord = effective[id].find(conflictsWithRetained);
      if (!chord) continue;
      errors[id] = `${id} conflicts with retained ${conflictsWithRetained(chord)} on ${chord}`;
      // At startup a recovery snapshot may be absent or native registration
      // may differ. Never publish an unsafe fallback in that case.
      effective[id] = Object.freeze(previous[id].filter((binding) => !conflictsWithRetained(binding)));
      retained.add(id);
      changed = true;
    }
  }
  return { effective: Object.freeze(effective), errors: Object.freeze(errors) };
}

export function writeKeybindingsSchema(userDataDir: string): void {
  const chord = {
    type: 'string',
    minLength: 3,
    maxLength: 96,
    pattern: '^(?=.*\\+).+$',
    description: 'A portable Electron accelerator with CommandOrControl, Command, Control, or Alt plus a supported key.',
    examples: ['CommandOrControl+Shift+P', 'Control+Alt+Space'],
  };
  const value = { anyOf: [chord, { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: chord }, { const: false }] };
  writeJsonFileSync(join(userDataDir, KEYBINDINGS_SCHEMA_RELATIVE_PATH), {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Tenon Keybindings',
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(CONFIGURABLE_SHORTCUTS.map((definition) => [definition.id, {
      ...value,
      title: definition.title,
      description: `${definition.description} Use false to disable it.`,
      default: definition.defaultBindings.length === 1
        ? definition.defaultBindings[0]
        : definition.defaultBindings,
    }])),
  }, { directoryMode: 0o700 });
}

export function readLastAppliedKeybindings(userDataDir: string): EffectiveShortcutBindings | null {
  try {
    const value = JSON.parse(readFileSync(join(userDataDir, LAST_APPLIED_RELATIVE_PATH), 'utf8')) as {
      bindings?: unknown;
    };
    if (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) return null;
    const entries = Object.entries(value.bindings);
    if (entries.length !== CONFIGURABLE_SHORTCUT_IDS.length) return null;
    const bindings = Object.fromEntries(entries.map(([id, chords]) => {
      if (!isConfigurableShortcutId(id) || !Array.isArray(chords) || chords.length > 4) {
        throw new Error('Invalid last-applied keybindings');
      }
      return [id, Object.freeze(chords.map((chord, index) => normalizePortableChord(chord, `${id}[${index}]`)))];
    })) as EffectiveShortcutBindings;
    assertNoKeybindingConflicts(bindings);
    return Object.freeze(bindings);
  } catch {
    return null;
  }
}

export function writeLastAppliedKeybindings(userDataDir: string, bindings: EffectiveShortcutBindings): void {
  assertNoKeybindingConflicts(bindings);
  writeJsonFileSync(join(userDataDir, LAST_APPLIED_RELATIVE_PATH), { bindings }, {
    mode: 0o600,
    directoryMode: 0o700,
  });
}

function decodeKeybindings(value: unknown): KeybindingOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('keybindings must be an object');
  const overrides: Partial<Record<ConfigurableShortcutId, KeybindingOverride>> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isConfigurableShortcutId(id)) throw new Error(`${id} is not a configurable shortcut`);
    overrides[id] = normalizeKeybindingOverride(entry, id);
  }
  assertNoKeybindingConflicts(effectiveShortcutBindings(overrides));
  return Object.freeze(overrides);
}

function parseJsonc(source: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new Error(`Invalid JSONC: ${errors[0]!.error}`);
  const tree = parseTree(source, [], { allowTrailingComma: true, disallowComments: false });
  if (tree) assertUniqueKeys(tree);
  return parsed;
}

function assertUniqueKeys(node: Node): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== 'string') continue;
      if (keys.has(key)) throw new Error(`${key} is duplicated`);
      keys.add(key);
      const value = property.children?.[1];
      if (value) assertUniqueKeys(value);
    }
  } else {
    for (const child of node.children ?? []) assertUniqueKeys(child);
  }
}

function modify(source: string, path: readonly string[], value: unknown): string {
  return applyEdits(source, jsoncModify(source, [...path], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  }));
}

function result(
  userDataDir: string,
  sourceStatus: KeybindingsLoadResult['sourceStatus'],
  sourceBytes: string | null,
  overrides: KeybindingOverrides,
  error: string | null,
  acceptedDigest: string | null = null,
): KeybindingsLoadResult {
  return Object.freeze({
    path: pathFor(userDataDir),
    schemaPath: join(userDataDir, KEYBINDINGS_SCHEMA_RELATIVE_PATH),
    sourceStatus,
    sourceBytes,
    sourceDigest: sourceBytes === null ? null : digest(sourceBytes),
    acceptedDigest,
    overrides,
    effective: effectiveShortcutBindings(overrides),
    error,
  });
}

function readRecovery(userDataDir: string): { overrides: KeybindingOverrides; digest: string | null } {
  try {
    const value = JSON.parse(readFileSync(join(userDataDir, RECOVERY_RELATIVE_PATH), 'utf8')) as { sourceBytes?: unknown };
    if (typeof value.sourceBytes !== 'string' || Buffer.byteLength(value.sourceBytes, 'utf8') > MAX_KEYBINDINGS_BYTES) {
      return { overrides: {}, digest: null };
    }
    return { overrides: decodeKeybindings(parseJsonc(value.sourceBytes)), digest: digest(value.sourceBytes) };
  } catch {
    return { overrides: {}, digest: null };
  }
}

function writeRecovery(userDataDir: string, sourceBytes: string): void {
  writeJsonFileSync(join(userDataDir, RECOVERY_RELATIVE_PATH), { sourceBytes }, {
    mode: 0o600,
    directoryMode: 0o700,
  });
}

function pathFor(userDataDir: string): string {
  return keybindingsPath(userDataDir);
}

function readSource(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function digest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
