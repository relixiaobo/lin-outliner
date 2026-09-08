export const KEYBINDINGS_CHANGED_CHANNEL = 'lin:keybindings-changed';
export const KEYBINDINGS_GET_CHANNEL = 'lin:keybindings-get';
export const KEYBINDINGS_UPDATE_CHANNEL = 'lin:keybindings-update';
export const KEYBINDINGS_OPEN_FILE_CHANNEL = 'lin:keybindings-open-file';
export const KEYBINDINGS_GET_SYNC_CHANNEL = 'lin:keybindings-get-sync';

export type ConfigurableShortcutId =
  | 'global.launcher'
  | 'global.open_page_in_pane'
  | 'global.new_thread'
  | 'global.go_to_today'
  | 'global.toggle_page_translation';

export type ShortcutContext = 'system' | 'application' | 'preview';
export type KeybindingOverride = string | readonly string[] | false;
export type EffectiveShortcutBindings = Readonly<Record<ConfigurableShortcutId, readonly string[]>>;

export interface ConfigurableShortcutDefinition {
  readonly id: ConfigurableShortcutId;
  readonly context: ShortcutContext;
  readonly title: string;
  readonly description: string;
  readonly defaultBindings: readonly string[];
}

export const CONFIGURABLE_SHORTCUTS: readonly ConfigurableShortcutDefinition[] = Object.freeze([
  {
    id: 'global.launcher',
    context: 'system',
    title: 'Global launcher',
    description: 'Summon the launcher from any application.',
    defaultBindings: Object.freeze(['CommandOrControl+Shift+Space', 'Control+Alt+Space']),
  },
  {
    id: 'global.open_page_in_pane',
    context: 'application',
    title: 'Open page in new pane',
    description: 'Open the current page in a new pane.',
    defaultBindings: Object.freeze(['CommandOrControl+M']),
  },
  {
    id: 'global.new_thread',
    context: 'application',
    title: 'New Thread',
    description: 'Create a new Agent Thread.',
    defaultBindings: Object.freeze(['CommandOrControl+Shift+O']),
  },
  {
    id: 'global.go_to_today',
    context: 'application',
    title: 'Go to Today',
    description: "Open today's Daily Note.",
    defaultBindings: Object.freeze(['CommandOrControl+Shift+D']),
  },
  {
    id: 'global.toggle_page_translation',
    context: 'preview',
    title: 'Toggle page translation',
    description: 'Translate or show the original in the active supported preview.',
    defaultBindings: Object.freeze(['Alt+A']),
  },
]);

export const CONFIGURABLE_SHORTCUT_IDS = Object.freeze(
  CONFIGURABLE_SHORTCUTS.map((definition) => definition.id),
);

const CONFIGURABLE_SHORTCUT_ID_SET = new Set<string>(CONFIGURABLE_SHORTCUT_IDS);
const MODIFIER_ORDER = ['CommandOrControl', 'Control', 'Command', 'Alt', 'Shift'] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const RESERVED_CHORDS = new Set([
  'CommandOrControl+Q',
  'CommandOrControl+W',
  'CommandOrControl+,',
  'CommandOrControl+A',
  'CommandOrControl+B',
  'CommandOrControl+C',
  'CommandOrControl+E',
  'CommandOrControl+I',
  'CommandOrControl+K',
  'CommandOrControl+V',
  'CommandOrControl+X',
  'CommandOrControl+Z',
  'CommandOrControl+Shift+H',
  'CommandOrControl+Shift+S',
  'CommandOrControl+Shift+Z',
  'CommandOrControl+Y',
  'Control+I',
].flatMap(portableChordCollisionKeys));

const CONTEXTUAL_FIXED_SHORTCUTS: readonly {
  id: string;
  chord: string;
  disjointCommands: readonly ConfigurableShortcutId[];
}[] = [
  {
    id: 'selection.duplicate',
    chord: 'CommandOrControl+Shift+D',
    // useWorkspaceKeyboard admits Today only without row selection or an
    // editable target. Other commands can intercept the selection handler.
    disjointCommands: ['global.go_to_today'],
  },
];

export function isConfigurableShortcutId(value: unknown): value is ConfigurableShortcutId {
  return typeof value === 'string' && CONFIGURABLE_SHORTCUT_ID_SET.has(value);
}

export function normalizePortableChord(value: unknown, path = 'keybinding'): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  const tokens = value.split('+').map((token) => token.trim()).filter(Boolean);
  if (tokens.length < 2) throw new Error(`${path} must include a modifier and a key`);
  const key = normalizeKey(tokens.at(-1)!, path);
  const modifiers = new Set<string>();
  for (const token of tokens.slice(0, -1)) {
    const modifier = canonicalModifier(token);
    if (!modifier || modifiers.has(modifier)) throw new Error(`${path} has an invalid or repeated modifier`);
    modifiers.add(modifier);
  }
  if (modifiers.has('CommandOrControl') && (modifiers.has('Command') || modifiers.has('Control'))) {
    throw new Error(`${path} cannot combine CommandOrControl with Command or Control`);
  }
  if (![...modifiers].some((modifier) => modifier !== 'Shift')) {
    throw new Error(`${path} must include CommandOrControl, Command, Control, or Alt`);
  }
  const chord = [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
  if (portableChordCollisionKeys(chord).some((candidate) => RESERVED_CHORDS.has(candidate))) {
    throw new Error(`${path} is reserved by the application or operating system`);
  }
  return chord;
}

export function normalizeKeybindingOverride(value: unknown, path: string): KeybindingOverride {
  if (value === false) return false;
  const raw = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) {
    throw new Error(`${path} must be a chord, one to four alternate chords, or false`);
  }
  const normalized = raw.map((chord, index) => normalizePortableChord(chord, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${path} contains a duplicate chord`);
  return typeof value === 'string' ? normalized[0]! : Object.freeze(normalized);
}

export function effectiveShortcutBindings(
  overrides: Readonly<Partial<Record<ConfigurableShortcutId, KeybindingOverride>>>,
): EffectiveShortcutBindings {
  return Object.freeze(Object.fromEntries(CONFIGURABLE_SHORTCUTS.map((definition) => {
    const override = overrides[definition.id];
    const bindings = override === false
      ? []
      : typeof override === 'string'
        ? [override]
        : override ?? definition.defaultBindings;
    return [definition.id, Object.freeze([...bindings])];
  })) as Readonly<Record<ConfigurableShortcutId, readonly string[]>>);
}

export function assertNoKeybindingConflicts(
  effective: Readonly<Record<ConfigurableShortcutId, readonly string[]>>,
): void {
  const owners = new Map<string, ConfigurableShortcutId>();
  for (const definition of CONFIGURABLE_SHORTCUTS) {
    for (const chord of effective[definition.id]) {
      const fixed = CONTEXTUAL_FIXED_SHORTCUTS.find((shortcut) => (
        !shortcut.disjointCommands.includes(definition.id)
        && portableChordsConflict(chord, shortcut.chord)
      ));
      if (fixed) throw new Error(`${definition.id} conflicts with ${fixed.id} on ${chord}`);
      const collisionKeys = portableChordCollisionKeys(chord);
      const owner = collisionKeys.map((candidate) => owners.get(candidate)).find(Boolean);
      if (owner) throw new Error(`${definition.id} conflicts with ${owner} on ${chord}`);
      for (const candidate of collisionKeys) owners.set(candidate, definition.id);
    }
  }
}

export function portableChordsConflict(left: string, right: string): boolean {
  const rightKeys = portableChordCollisionKeys(right);
  return portableChordCollisionKeys(left).some((key) => rightKeys.includes(key));
}

export interface KeybindingsViewEntry {
  readonly id: ConfigurableShortcutId;
  readonly context: ShortcutContext;
  readonly desired: KeybindingOverride | null;
  readonly effective: readonly string[];
  readonly defaults: readonly string[];
  readonly status: 'default' | 'applied' | 'disabled' | 'failed';
  readonly error: string | null;
}

export interface KeybindingsView {
  readonly source: {
    readonly path: string;
    readonly schemaPath: string;
    readonly status: 'missing' | 'accepted' | 'rejected';
    readonly observedDigest: string | null;
    readonly acceptedDigest: string | null;
    readonly error: string | null;
  };
  readonly entries: readonly KeybindingsViewEntry[];
}

export interface KeybindingsUpdateInput {
  readonly id?: ConfigurableShortcutId;
  readonly value?: KeybindingOverride;
  readonly resetAll?: boolean;
  readonly observedDigest: string | null;
}

export interface ShortcutEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function portableChordMatchesEvent(chord: string, event: ShortcutEventLike): boolean {
  let normalized: string;
  try {
    normalized = normalizePortableChord(chord);
  } catch {
    return false;
  }
  const tokens = normalized.split('+');
  const key = tokens.pop()!;
  const modifiers = new Set(tokens);
  const mod = event.metaKey || event.ctrlKey;
  if (modifiers.has('CommandOrControl')) {
    if (!mod || (event.metaKey && event.ctrlKey)) return false;
  } else {
    if (modifiers.has('Control') !== event.ctrlKey) return false;
    if (modifiers.has('Command') !== event.metaKey) return false;
  }
  if (modifiers.has('Alt') !== event.altKey) return false;
  if (modifiers.has('Shift') !== event.shiftKey) return false;
  if (key === 'Space') return event.key === ' ' || event.code === 'Space';
  if (/^F(?:[1-9]|1[0-9]|20)$/.test(key)) return event.key === key;
  if (/^[A-Z]$/u.test(key) && event.code === `Key${key}`) return true;
  if (/^[0-9]$/u.test(key) && event.code === `Digit${key}`) return true;
  if (key === ',' && event.code === 'Comma') return true;
  return event.key.toUpperCase() === key.toUpperCase();
}

export function portableChordFromEvent(event: ShortcutEventLike): string | null {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const modifiers: string[] = [];
  if (event.metaKey && event.ctrlKey) modifiers.push('Command', 'Control');
  else if (event.metaKey) modifiers.push('CommandOrControl');
  else if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  const key = keyFromEvent(event);
  if (!key) return null;
  return normalizePortableChord([...modifiers, key].join('+'));
}

export function portableChordToElectronAccelerator(chord: string): string {
  return normalizePortableChord(chord);
}

function canonicalModifier(value: string): (typeof MODIFIER_ORDER)[number] | null {
  const candidate = value.toLowerCase();
  if (candidate === 'commandorcontrol' || candidate === 'cmdorctrl' || candidate === 'mod') return 'CommandOrControl';
  if (candidate === 'control' || candidate === 'ctrl') return 'Control';
  if (candidate === 'command' || candidate === 'cmd' || candidate === 'meta') return 'Command';
  if (candidate === 'option' || candidate === 'alt') return 'Alt';
  if (candidate === 'shift') return 'Shift';
  return null;
}

function normalizeKey(value: string, path: string): string {
  if (value === ' ') return 'Space';
  const named = value.toLowerCase();
  if (named === 'space' || named === 'spacebar') return 'Space';
  if (/^f(?:[1-9]|1[0-9]|20)$/i.test(value)) return value.toUpperCase();
  if (/^[a-z0-9,]$/i.test(value)) return value.toUpperCase();
  throw new Error(`${path} has an unsupported key`);
}

function keyFromEvent(event: ShortcutEventLike): string | null {
  if (event.code === 'Space' || event.key === ' ') return 'Space';
  if (event.code?.startsWith('Key') && /^Key[A-Z]$/u.test(event.code)) return event.code.slice(3);
  if (event.code?.startsWith('Digit') && /^Digit[0-9]$/u.test(event.code)) return event.code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|20)$/iu.test(event.key)) return event.key.toUpperCase();
  if (/^[a-z0-9,]$/iu.test(event.key)) return event.key.toUpperCase();
  return null;
}

function portableChordCollisionKeys(chord: string): readonly string[] {
  if (!chord.includes('CommandOrControl')) return [chord];
  return [chord.replace('CommandOrControl', 'Command'), chord.replace('CommandOrControl', 'Control')];
}
