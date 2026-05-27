// Config-as-nodes: the closed schema (Stage 0 — definitions only, no behavior
// change; nothing imports this yet). It is the authoritative description that
// keeps the open node tree from drifting. See docs/plans/config-as-nodes.md.

import {
  SCHEMA_AUTO_INIT_ID,
  SCHEMA_CARDINALITIES_ID,
  SCHEMA_FIELD_TYPES_ID,
  SCHEMA_HIDE_MODES_ID,
  systemOptionNodeId,
  type AutoInitStrategy,
  type ConfigValueDomain,
  type DefConfigKey,
  type FieldType,
  type NodeId,
  type NodeType,
  type RefRole,
  type TagConfigPatch,
  type FieldConfigPatch,
} from './types';

// ─── Reference roles / backlink allowlist (transitional rule 4) ───
// Only these roles are real reference edges (backlinks, reference counts,
// search reference matching). Config/enum/system/searchResult refs are
// internal pointers and must be excluded. Absent role ⇒ 'link' (legacy).
export const BACKLINK_REF_ROLES: ReadonlySet<RefRole> = new Set<RefRole>([
  'link',
  'fieldValue',
]);

export function refRoleOf(node: { type?: NodeType; refRole?: RefRole }): RefRole | null {
  if (node.type !== 'reference') return null;
  return node.refRole ?? 'link';
}

export function refRoleCountsAsBacklink(node: { type?: NodeType; refRole?: RefRole }): boolean {
  const role = refRoleOf(node);
  return role != null && BACKLINK_REF_ROLES.has(role);
}

// ─── Internal config nodes (transitional rule 1: kept IN projection, excluded
// at every consumer — outliner render, search candidates, agent projection,
// sidebar). This is the single shared predicate those consumers apply. ───
export const INTERNAL_CONFIG_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'defConfig',
  'systemOption',
]);

export function isInternalConfigNode(node: { type?: NodeType }): boolean {
  return node.type != null && INTERNAL_CONFIG_NODE_TYPES.has(node.type);
}

// ─── Scalar codecs (transitional rule 5) ───
// Scalars are stored as the value child's content text. The codec defines the
// canonical text, parsing, and write-time validation, so number/bool/color
// cannot hold "abc"/"maybe"/an invalid hex.
export interface ScalarCodec<T> {
  /** Parse stored text → value, or undefined when unset/invalid. */
  decode(text: string): T | undefined;
  /** Value → canonical storage text. */
  encode(value: T): string;
  /** null when valid, else a human error message. */
  validate(value: T): string | null;
}

export const numberCodec: ScalarCodec<number> = {
  decode: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  },
  encode: (value) => String(value),
  validate: (value) => (Number.isFinite(value) ? null : 'value must be a finite number'),
};

export const boolCodec: ScalarCodec<boolean> = {
  decode: (text) => {
    const t = text.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
    return undefined;
  },
  encode: (value) => (value ? 'true' : 'false'),
  validate: () => null,
};

// Color is a free token: either a named palette key (`green`, `blue`, …) as
// produced by auto-assignment, or a custom `#RRGGBB` hex from the swatch picker.
// Resolution to concrete RGB happens at render time (renderer `resolveTagColor`),
// so storage keeps the raw token and only normalizes whitespace.
export const colorCodec: ScalarCodec<string> = {
  decode: (text) => {
    const t = text.trim();
    return t === '' ? undefined : t;
  },
  encode: (value) => value,
  validate: () => null,
};

// ─── Enum domains (system option subtrees, stable derived IDs) ───
export interface EnumDomain {
  subtreeId: NodeId;
  /** Canonical option values, in display order. Option node id = systemOptionNodeId(subtreeId, value). */
  values: readonly string[];
}

const EXPOSED_FIELD_TYPES: readonly FieldType[] = [
  'plain',
  'options',
  'options_from_supertag',
  'date',
  'number',
  'password',
  'url',
  'email',
  'checkbox',
  'boolean',
  'color',
];

const AUTO_INIT_STRATEGIES: readonly AutoInitStrategy[] = [
  'current_date',
  'ancestor_day_node',
  'ancestor_field_value',
  'ancestor_supertag_ref',
];

export const ENUM_DOMAINS = {
  fieldType: { subtreeId: SCHEMA_FIELD_TYPES_ID, values: EXPOSED_FIELD_TYPES },
  hideField: {
    subtreeId: SCHEMA_HIDE_MODES_ID,
    values: ['never', 'empty', 'not_empty', 'value_is_default', 'always'],
  },
  cardinality: { subtreeId: SCHEMA_CARDINALITIES_ID, values: ['single', 'list'] },
  autoInitialize: { subtreeId: SCHEMA_AUTO_INIT_ID, values: AUTO_INIT_STRATEGIES },
} satisfies Record<string, EnumDomain>;

/** Every system option node id, for idempotent seeding. */
export function allSystemOptionNodeIds(): NodeId[] {
  return Object.values(ENUM_DOMAINS).flatMap((domain) =>
    domain.values.map((value) => systemOptionNodeId(domain.subtreeId, value)),
  );
}

// ─── The registry ───
export type DefConfigKind = 'tag' | 'field';

/** Resolved (read) config shape a visibleWhen predicate sees. */
export type ProjectedConfig = TagConfigPatch & FieldConfigPatch & { fieldType?: FieldType };

export interface ConfigSchemaDef {
  key: DefConfigKey;
  kind: DefConfigKind;
  domain: ConfigValueDomain;
  cardinality: 'single' | 'list';
  /** '*' = all field types; otherwise only these (field knobs gated by fieldType). */
  appliesTo: '*' | readonly FieldType[];
  /** Shown only when this predicate holds over the current projected config. */
  visibleWhen?: (config: ProjectedConfig) => boolean;
  /** For ref/enum knobs: the enum domain key (undefined for free tag refs). */
  enumDomain?: keyof typeof ENUM_DOMAINS;
  label: string;
  description?: string;
}

export const CONFIG_SCHEMA: Record<DefConfigKey, ConfigSchemaDef> = {
  // ── tag ──
  color: { key: 'color', kind: 'tag', domain: 'color', cardinality: 'single', appliesTo: '*', label: 'Color' },
  extends: { key: 'extends', kind: 'tag', domain: 'ref', cardinality: 'single', appliesTo: '*', label: 'Extend from', description: 'Inherit fields and content from another tag' },
  childSupertag: { key: 'childSupertag', kind: 'tag', domain: 'ref', cardinality: 'single', appliesTo: '*', label: 'Default child supertag', description: 'Auto-apply this tag to new children' },
  showCheckbox: { key: 'showCheckbox', kind: 'tag', domain: 'bool', cardinality: 'single', appliesTo: '*', label: 'Show as checkbox' },
  doneStateEnabled: { key: 'doneStateEnabled', kind: 'tag', domain: 'bool', cardinality: 'single', appliesTo: '*', label: 'Done state mapping', visibleWhen: (c) => Boolean(c.showCheckbox) },

  // ── field ──
  fieldType: { key: 'fieldType', kind: 'field', domain: 'enum', cardinality: 'single', appliesTo: '*', enumDomain: 'fieldType', label: 'Field type' },
  cardinality: { key: 'cardinality', kind: 'field', domain: 'enum', cardinality: 'single', appliesTo: '*', enumDomain: 'cardinality', label: 'Cardinality' },
  sourceSupertag: { key: 'sourceSupertag', kind: 'field', domain: 'ref', cardinality: 'single', appliesTo: ['options_from_supertag'], label: 'Supertag', visibleWhen: (c) => c.fieldType === 'options_from_supertag' },
  autocollectOptions: { key: 'autocollectOptions', kind: 'field', domain: 'bool', cardinality: 'single', appliesTo: ['options'], label: 'Auto-collect values', visibleWhen: (c) => c.fieldType === 'options' },
  autoInitialize: { key: 'autoInitialize', kind: 'field', domain: 'enumList', cardinality: 'list', appliesTo: '*', enumDomain: 'autoInitialize', label: 'Auto-initialize' },
  nullable: { key: 'nullable', kind: 'field', domain: 'bool', cardinality: 'single', appliesTo: '*', label: 'Required' },
  hideField: { key: 'hideField', kind: 'field', domain: 'enum', cardinality: 'single', appliesTo: '*', enumDomain: 'hideField', label: 'Hide field' },
  minValue: { key: 'minValue', kind: 'field', domain: 'number', cardinality: 'single', appliesTo: ['number'], label: 'Minimum value', visibleWhen: (c) => c.fieldType === 'number' },
  maxValue: { key: 'maxValue', kind: 'field', domain: 'number', cardinality: 'single', appliesTo: ['number'], label: 'Maximum value', visibleWhen: (c) => c.fieldType === 'number' },
};

export const TAG_CONFIG_KEYS: DefConfigKey[] = Object.values(CONFIG_SCHEMA).filter((d) => d.kind === 'tag').map((d) => d.key);
export const FIELD_CONFIG_KEYS: DefConfigKey[] = Object.values(CONFIG_SCHEMA).filter((d) => d.kind === 'field').map((d) => d.key);

// ─── Accessor / index / write API surface (signatures only; implemented in
// later stages). The rest of the app reads config through these, never by
// scanning children or reading flat fields directly. ───
export interface ProjectedTagConfig {
  color?: string;
  extends?: NodeId;
  childSupertag?: NodeId;
  showCheckbox: boolean;
  doneStateEnabled: boolean;
}

export interface ProjectedFieldConfig {
  fieldType: FieldType;
  cardinality: 'single' | 'list';
  sourceSupertag?: NodeId;
  nullable: boolean;
  hideField: string;
  autoInitialize: AutoInitStrategy[];
  autocollectOptions: boolean;
  minValue?: number;
  maxValue?: number;
}

/** Precomputed config view over a document, built once per projection/state. */
export interface ConfigIndex {
  tag(tagDefId: NodeId): ProjectedTagConfig | undefined;
  field(fieldDefId: NodeId): ProjectedFieldConfig | undefined;
}

/**
 * A single config-value mutation routed through the registry-governed chokepoint.
 * The caller passes the value semantically; `setConfigValue` maps it to storage
 * per the key's domain (scalar value node / `config` ref / `enum` option ref(s)).
 *   scalar   → number/bool/color (free text, codec-validated)
 *   ref      → a tagDef target (extends / childSupertag / sourceSupertag)
 *   enum     → a single option value (fieldType / cardinality / hideField)
 *   enumList → a set of option values (autoInitialize)
 * A null/empty payload clears the value.
 */
export type SetConfigValueInput =
  | { kind: 'scalar'; configKey: DefConfigKey; text: string | null }
  | { kind: 'ref'; configKey: DefConfigKey; targetId: NodeId | null }
  | { kind: 'enum'; configKey: DefConfigKey; value: string | null }
  | { kind: 'enumList'; configKey: DefConfigKey; values: string[] };

/** Map a config knob's domain → the codec used for scalar storage (number/bool/color). */
export function scalarCodecFor(domain: ConfigValueDomain): ScalarCodec<number> | ScalarCodec<boolean> | ScalarCodec<string> | null {
  switch (domain) {
    case 'number': return numberCodec;
    case 'bool': return boolCodec;
    case 'color': return colorCodec;
    default: return null;
  }
}

/** Decode → validate → re-encode a scalar to canonical storage text, or report why not. */
export function canonicalizeScalar(domain: ConfigValueDomain, text: string): { text: string } | { error: string } {
  const codec = scalarCodecFor(domain) as ScalarCodec<number | boolean | string> | null;
  if (!codec) return { error: `domain ${domain} is not scalar` };
  const decoded = codec.decode(text);
  if (decoded === undefined) return { error: `invalid ${domain} value` };
  const message = codec.validate(decoded);
  if (message) return { error: message };
  return { text: codec.encode(decoded) };
}

/** Which `SetConfigValueInput.kind` a knob expects, derived from its domain. */
export function configValueKind(key: DefConfigKey): SetConfigValueInput['kind'] {
  switch (CONFIG_SCHEMA[key].domain) {
    case 'ref': return 'ref';
    case 'enum': return 'enum';
    case 'enumList': return 'enumList';
    default: return 'scalar';
  }
}

/** The fixed config-key set a definition node type carries (null = not a definition). */
export function configKeysForDefType(type: NodeType | undefined): DefConfigKey[] | null {
  if (type === 'tagDef') return TAG_CONFIG_KEYS;
  if (type === 'fieldDef') return FIELD_CONFIG_KEYS;
  return null;
}
