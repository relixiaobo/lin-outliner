// Config-as-nodes (Stage 4): the read side. Turns a definition's `defConfig`
// subtree into a typed, projected config. The rest of the app reads config
// through `buildConfigIndex(state).tag(id)` / `.field(id)` — never by scanning
// children or reading the flat fields. See docs/plans/config-as-nodes.md.

import {
  boolCodec,
  colorCodec,
  numberCodec,
  CONFIG_SCHEMA,
  FIELD_CONFIG_KEYS,
  TAG_CONFIG_KEYS,
  type ConfigIndex,
  type DefConfigKind,
  type ProjectedConfig,
  type ProjectedFieldConfig,
  type ProjectedTagConfig,
} from './configSchema';
import type {
  AutoInitStrategy,
  DefConfigKey,
  DocumentState,
  FieldType,
  Node,
  NodeId,
  NodeType,
  RichText,
} from './types';
import { nodeHasDoneField } from './systemFields';

/**
 * The node fields the config projection reads, structurally. Both `Node` and
 * `NodeProjection` (and their variants) satisfy it: `configKey` lives on the
 * defConfig variant and `targetId` on the reference variant, so both are
 * optional here.
 */
export type ConfigNodeLike = {
  id: NodeId;
  type?: NodeType;
  configKey?: DefConfigKey;
  children: NodeId[];
  content: RichText;
  targetId?: NodeId;
  fieldDefId?: NodeId;
};
export type ConfigNodeMap = ReadonlyMap<NodeId, ConfigNodeLike>;

// ─── Low-level reads over a single defConfig node's value child(ren) ───

function configRowsByKey(byId: ConfigNodeMap, defNode: ConfigNodeLike): Map<DefConfigKey, ConfigNodeLike> {
  const rows = new Map<DefConfigKey, ConfigNodeLike>();
  for (const childId of defNode.children) {
    const child = byId.get(childId);
    if (child?.type === 'defConfig' && child.configKey) rows.set(child.configKey, child);
  }
  return rows;
}

function valueChildren(byId: ConfigNodeMap, row: ConfigNodeLike | undefined): ConfigNodeLike[] {
  if (!row) return [];
  return row.children.map((id) => byId.get(id)).filter((n): n is ConfigNodeLike => Boolean(n));
}

/** Scalar value (number/bool/color): the single non-reference value child's text. */
function scalarText(byId: ConfigNodeMap, row: ConfigNodeLike | undefined): string | undefined {
  return valueChildren(byId, row).find((n) => n.type !== 'reference')?.content.text;
}

/** Ref value (`extends`/`childSupertag`/`sourceSupertag`): the value reference's target. */
function refTarget(byId: ConfigNodeMap, row: ConfigNodeLike | undefined): NodeId | undefined {
  return valueChildren(byId, row).find((n) => n.type === 'reference')?.targetId;
}

/** Ref-list value (`doneMapChecked`/`doneMapUnchecked`): every reference's target, in order. */
function refTargets(byId: ConfigNodeMap, row: ConfigNodeLike | undefined): NodeId[] {
  return valueChildren(byId, row)
    .filter((n) => n.type === 'reference' && n.targetId)
    .map((n) => n.targetId as NodeId);
}

/** Enum value: resolve the value reference to its system option; its text is the canonical value. */
function enumValue(byId: ConfigNodeMap, row: ConfigNodeLike | undefined): string | undefined {
  const target = refTarget(byId, row);
  return target ? byId.get(target)?.content.text : undefined;
}

/** Enum-list values: every value reference's resolved option text, in child order. */
function enumListValues(byId: ConfigNodeMap, row: ConfigNodeLike | undefined): string[] {
  return valueChildren(byId, row)
    .filter((n) => n.type === 'reference' && n.targetId)
    .map((n) => byId.get(n.targetId as NodeId)?.content.text)
    .filter((text): text is string => Boolean(text));
}

// ─── Projected config (one per definition) ───

export function projectTagConfig(byId: ConfigNodeMap, tagDef: ConfigNodeLike): ProjectedTagConfig {
  const rows = configRowsByKey(byId, tagDef);
  const colorText = scalarText(byId, rows.get('color'));
  return {
    color: colorText != null ? colorCodec.decode(colorText) : undefined,
    extends: refTarget(byId, rows.get('extends')),
    childSupertag: refTarget(byId, rows.get('childSupertag')),
    showCheckbox: boolCodec.decode(scalarText(byId, rows.get('showCheckbox')) ?? '') ?? false,
    doneStateEnabled: boolCodec.decode(scalarText(byId, rows.get('doneStateEnabled')) ?? '') ?? false,
    doneMapChecked: refTargets(byId, rows.get('doneMapChecked')),
    doneMapUnchecked: refTargets(byId, rows.get('doneMapUnchecked')),
  };
}

export function projectFieldConfig(byId: ConfigNodeMap, fieldDef: ConfigNodeLike): ProjectedFieldConfig {
  const rows = configRowsByKey(byId, fieldDef);
  const minText = scalarText(byId, rows.get('minValue'));
  const maxText = scalarText(byId, rows.get('maxValue'));
  return {
    fieldType: (enumValue(byId, rows.get('fieldType')) as FieldType | undefined) ?? 'plain',
    sourceSupertag: refTarget(byId, rows.get('sourceSupertag')),
    // Fields are optional by default; absent nullable config means nullable.
    nullable: boolCodec.decode(scalarText(byId, rows.get('nullable')) ?? '') ?? true,
    hideField: enumValue(byId, rows.get('hideField')) ?? 'never',
    autoInitialize: enumListValues(byId, rows.get('autoInitialize')) as AutoInitStrategy[],
    autocollectOptions: boolCodec.decode(scalarText(byId, rows.get('autocollectOptions')) ?? '') ?? false,
    minValue: minText != null ? numberCodec.decode(minText) : undefined,
    maxValue: maxText != null ? numberCodec.decode(maxText) : undefined,
  };
}

/** Convenience: a field definition's type by id, or undefined if not a fieldDef. */
export function projectFieldTypeById(byId: ConfigNodeMap, fieldDefId: NodeId | undefined): FieldType | undefined {
  if (!fieldDefId) return undefined;
  const node = byId.get(fieldDefId);
  return node?.type === 'fieldDef' ? projectFieldConfig(byId, node).fieldType : undefined;
}

// ─── Checkbox / done state (tag-driven + completedAt sentinel; nodex parity) ───
//
// A node's checkbox is tag-driven: it appears when any applied tag (walking the
// extends chain) enables `showCheckbox`, or manually when `completedAt` is set.
// `completedAt` is a three-state sentinel: undefined = no checkbox, 0 = checkbox
// present but undone, > 0 = done (the completion timestamp).

/** Whether the node carries a checkbox marked done (completion timestamp set). */
export function nodeIsDone(node: Pick<Node, 'completedAt'>): boolean {
  return node.completedAt !== undefined && node.completedAt > 0;
}

function tagShowsCheckbox(byId: ConfigNodeMap, tagDefId: NodeId, visited: Set<NodeId>): boolean {
  if (visited.has(tagDefId)) return false;
  visited.add(tagDefId);
  const node = byId.get(tagDefId);
  if (node?.type !== 'tagDef') return false;
  const config = projectTagConfig(byId, node);
  if (config.showCheckbox) return true;
  return config.extends ? tagShowsCheckbox(byId, config.extends, visited) : false;
}

/** True when any of the node's applied tags (via extends chains) shows a checkbox. */
export function tagDrivenShowCheckbox(byId: ConfigNodeMap, node: Pick<Node, 'tags'>): boolean {
  const visited = new Set<NodeId>();
  return node.tags.some((tagId) => tagShowsCheckbox(byId, tagId, visited));
}

/**
 * Whether the node should render a checkbox at all. Three independent triggers:
 * a manual `completedAt` sentinel, a tag whose config enables `showCheckbox`, or
 * a built-in Done (`sys:done`) field attached to the node — the last keeps the
 * row checkbox and the field's value reading the same `completedAt`, so they
 * stay in sync without any extra wiring.
 */
export function nodeShowsCheckbox(
  byId: ConfigNodeMap,
  node: Pick<Node, 'tags' | 'completedAt' | 'children'>,
): boolean {
  return (
    node.completedAt !== undefined ||
    tagDrivenShowCheckbox(byId, node) ||
    nodeHasDoneField(node, byId)
  );
}

// ─── The index (built once per state/projection; reads are O(1) memoized) ───

export function buildConfigIndex(state: Pick<DocumentState, 'nodes'>): ConfigIndex {
  const byId: ConfigNodeMap = new Map(Object.values(state.nodes).map((node) => [node.id, node]));
  return buildConfigIndexFromMap(byId);
}

export function buildConfigIndexFromMap(byId: ConfigNodeMap): ConfigIndex {
  const tagCache = new Map<NodeId, ProjectedTagConfig | undefined>();
  const fieldCache = new Map<NodeId, ProjectedFieldConfig | undefined>();
  return {
    tag(id) {
      if (!tagCache.has(id)) {
        const node = byId.get(id);
        tagCache.set(id, node?.type === 'tagDef' ? projectTagConfig(byId, node) : undefined);
      }
      return tagCache.get(id);
    },
    field(id) {
      if (!fieldCache.has(id)) {
        const node = byId.get(id);
        fieldCache.set(id, node?.type === 'fieldDef' ? projectFieldConfig(byId, node) : undefined);
      }
      return fieldCache.get(id);
    },
  };
}

// ─── Applicability (UI row visibility; reconcile materializes the full set) ───

/**
 * Config keys whose row should be *shown* for the current projected config —
 * `appliesTo` (structural: which field types ever carry the knob) gated further
 * by `visibleWhen` (dynamic: e.g. doneStateEnabled only when showCheckbox is on).
 * Reconcile materializes the full key set; this governs which rows render.
 */
export function applicableConfigKeys(kind: DefConfigKind, config: ProjectedConfig): DefConfigKey[] {
  const keys = kind === 'tag' ? TAG_CONFIG_KEYS : FIELD_CONFIG_KEYS;
  return keys.filter((key) => {
    const def = CONFIG_SCHEMA[key];
    if (def.appliesTo !== '*' && !(config.fieldType && def.appliesTo.includes(config.fieldType))) return false;
    if (def.visibleWhen && !def.visibleWhen(config)) return false;
    return true;
  });
}
