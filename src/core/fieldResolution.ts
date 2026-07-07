import { parseDateFieldValue } from './dateFieldValue';
import { projectFieldConfig } from './configProjection';
import {
  COMMAND_SCHEDULE_FIELD_ID,
  CREATED_FIELD,
  DAY_FIELD,
  DONE_AT_FIELD,
  DONE_FIELD,
  OWNER_FIELD,
  REF_COUNT_FIELD,
  SYSTEM_FIELD_CHOICES,
  TAGS_FIELD,
  UPDATED_FIELD,
  systemFieldLabel,
} from './systemFields';
import { SCHEMA_ID, TRASH_ID, type DefConfigKey, type FieldType, type NodeId, type NodeType, type RichText } from './types';
import { nodeIsInSubtree } from './treeUtils';

export interface FieldResolutionNode {
  id: NodeId;
  type?: NodeType;
  parentId?: NodeId | null;
  children: NodeId[];
  content: RichText;
  fieldDefId?: NodeId;
  targetId?: NodeId;
  configKey?: DefConfigKey;
}

export interface FieldResolutionValue {
  text: string;
  targetId?: NodeId;
}

export type FieldWriteTarget =
  | {
    kind: 'existingEntry';
    fieldEntryId: NodeId;
    fieldDefId?: NodeId;
    fieldType: FieldType;
  }
  | {
    kind: 'existingFieldDef';
    fieldDefId: NodeId;
    fieldType: FieldType;
  }
  | {
    kind: 'newFieldDef';
    fieldType: FieldType;
  }
  | {
    kind: 'systemDone';
    fieldDefId: typeof DONE_FIELD;
  };

export type FieldResolutionResult =
  | { ok: true; target: FieldWriteTarget }
  | { ok: false; code: string; error: string; instructions: string; nodeIds?: NodeId[] };

export interface ResolveFieldWriteTargetOptions {
  isDeleted?: (nodeId: NodeId) => boolean;
  trashId?: NodeId;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SYSTEM_FIELD_IDS = [
  ...SYSTEM_FIELD_CHOICES.map((choice) => choice.id),
  CREATED_FIELD,
  UPDATED_FIELD,
  DONE_FIELD,
  DONE_AT_FIELD,
  TAGS_FIELD,
  REF_COUNT_FIELD,
  OWNER_FIELD,
  DAY_FIELD,
  COMMAND_SCHEDULE_FIELD_ID,
];

export function normalizeFieldNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function fieldEntryDisplayName(
  byId: ReadonlyMap<NodeId, FieldResolutionNode>,
  fieldEntry: FieldResolutionNode,
): string {
  const fieldDefId = fieldEntry.type === 'fieldEntry' ? fieldEntry.fieldDefId : undefined;
  if (fieldDefId) {
    const systemLabel = systemFieldLabel(fieldDefId);
    if (systemLabel) return systemLabel;
    const fieldDef = byId.get(fieldDefId);
    if (fieldDef?.content.text.trim()) return fieldDef.content.text;
  }
  return fieldEntry.content.text.trim();
}

export function fieldTypeForFieldDef(
  byId: ReadonlyMap<NodeId, FieldResolutionNode>,
  fieldDefId: NodeId | undefined,
): FieldType {
  if (!fieldDefId) return 'plain';
  const fieldDef = byId.get(fieldDefId);
  if (fieldDef?.type !== 'fieldDef') return 'plain';
  return projectFieldConfig(byId, fieldDef).fieldType;
}

export function fieldTypeForFieldEntry(
  byId: ReadonlyMap<NodeId, FieldResolutionNode>,
  fieldEntryId: NodeId,
): FieldType {
  const fieldEntry = byId.get(fieldEntryId);
  return fieldEntry?.type === 'fieldEntry'
    ? fieldTypeForFieldDef(byId, fieldEntry.fieldDefId)
    : 'plain';
}

export function inferFieldTypeFromValues(values: readonly FieldResolutionValue[]): FieldType {
  const nonEmpty = values.filter((value) => value.targetId || value.text.trim().length > 0);
  if (nonEmpty.length === 0) return 'plain';
  if (nonEmpty.every((value) => Boolean(value.targetId))) return 'reference';
  if (nonEmpty.some((value) => value.targetId)) return 'plain';

  const texts = nonEmpty.map((value) => value.text.trim());
  if (texts.every((text) => parseDateFieldValue(text))) return 'date';
  if (texts.every((text) => Number.isFinite(Number(text)))) return 'number';
  if (texts.every(looksLikeUrl)) return 'url';
  if (texts.every((text) => EMAIL_PATTERN.test(text))) return 'email';
  if (texts.every((text) => ['true', 'false'].includes(text.toLowerCase()))) return 'checkbox';
  return 'plain';
}

export function validateFieldValuesForType(
  fieldName: string,
  fieldType: FieldType,
  values: readonly FieldResolutionValue[],
): { ok: true } | { ok: false; error: string; instructions: string } {
  const nonEmpty = values.filter((value) => value.targetId || value.text.trim().length > 0);
  if (nonEmpty.length === 0) return { ok: true };
  const label = fieldName.trim() || 'Field';

  if (fieldType === 'reference') {
    if (nonEmpty.every((value) => Boolean(value.targetId))) return { ok: true };
    return {
      ok: false,
      error: `Field "${label}" is a reference field and requires node reference values.`,
      instructions: 'Use [[node:Display^id]] field values, or choose a plain field for free text.',
    };
  }
  if (fieldType === 'options_from_supertag') {
    if (nonEmpty.every((value) => Boolean(value.targetId))) return { ok: true };
    return {
      ok: false,
      error: `Field "${label}" is an options-from-supertag field and requires node reference values.`,
      instructions: 'Use [[node:Display^id]] values that point to nodes carrying the configured source supertag.',
    };
  }
  if (fieldType !== 'options' && nonEmpty.some((value) => value.targetId)) {
    return {
      ok: false,
      error: `Field "${label}" is a ${fieldType} field and cannot store node reference values.`,
      instructions: 'Use a reference field for node references, or use text values that match this field type.',
    };
  }

  const texts = nonEmpty.map((value) => value.text.trim());
  if (fieldType === 'date' && texts.some((text) => !parseDateFieldValue(text))) {
    return {
      ok: false,
      error: `Field "${label}" is a date field and received a non-date value.`,
      instructions: 'Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, or start/end with "/" such as 2026-05-20/2026-05-24.',
    };
  }
  if (fieldType === 'number' && texts.some((text) => !Number.isFinite(Number(text)))) {
    return {
      ok: false,
      error: `Field "${label}" is a number field and received a non-number value.`,
      instructions: 'Use a finite numeric value, or write to a plain field.',
    };
  }
  if (fieldType === 'url' && texts.some((text) => !looksLikeUrl(text))) {
    return {
      ok: false,
      error: `Field "${label}" is a URL field and received a non-URL value.`,
      instructions: 'Use an http(s) URL or a scheme-less host such as example.com/path.',
    };
  }
  if (fieldType === 'email' && texts.some((text) => !EMAIL_PATTERN.test(text))) {
    return {
      ok: false,
      error: `Field "${label}" is an email field and received a non-email value.`,
      instructions: 'Use a value like person@example.com, or write to a plain field.',
    };
  }
  if (fieldType === 'checkbox' && texts.some((text) => !['true', 'false'].includes(text.toLowerCase()))) {
    return {
      ok: false,
      error: `Field "${label}" is a checkbox field and received a non-boolean value.`,
      instructions: 'Use true or false.',
    };
  }
  return { ok: true };
}

export function resolveFieldWriteTarget(
  byId: ReadonlyMap<NodeId, FieldResolutionNode>,
  ownerId: NodeId,
  fieldName: string,
  values: readonly FieldResolutionValue[],
  options: ResolveFieldWriteTargetOptions = {},
): FieldResolutionResult {
  const key = normalizeFieldNameKey(fieldName);
  if (!key) {
    return {
      ok: false,
      code: 'empty_field_name',
      error: 'Field name cannot be empty.',
      instructions: 'Use a non-empty field name.',
    };
  }

  const owner = byId.get(ownerId);
  if (!owner) {
    return {
      ok: false,
      code: 'node_not_found',
      error: `Owner node not found: ${ownerId}`,
      instructions: 'Refresh the node id and retry.',
    };
  }
  const isDeleted = deletedPredicate(byId, options);
  const ownerMatches = owner.children
    .map((childId) => byId.get(childId))
    .filter((child): child is FieldResolutionNode => child !== undefined && child.type === 'fieldEntry' && !isDeleted(child.id))
    .filter((child) => normalizeFieldNameKey(fieldEntryDisplayName(byId, child)) === key);
  if (ownerMatches.length > 1) {
    return duplicateOwnerError(fieldName, ownerMatches.map((entry) => entry.id));
  }
  if (ownerMatches.length === 1) {
    const entry = ownerMatches[0]!;
    return resolveExistingEntry(byId, fieldName, values, entry);
  }

  const systemFieldId = resolveSystemFieldId(fieldName);
  if (systemFieldId) return resolveSystemWrite(fieldName, values, systemFieldId);

  const matchingDefs = [...byId.values()]
    .filter((node) =>
      node.type === 'fieldDef'
      && node.parentId === SCHEMA_ID
      && !isDeleted(node.id)
      && normalizeFieldNameKey(node.content.text) === key);
  if (matchingDefs.length > 1) {
    return {
      ok: false,
      code: 'duplicate_field_definitions',
      error: `Multiple field definitions match "${fieldName}": ${matchingDefs.map((node) => node.id).join(', ')}`,
      instructions: 'Use an existing field entry on the target node to disambiguate, or merge/delete duplicate field definitions first.',
      nodeIds: matchingDefs.map((node) => node.id),
    };
  }
  if (matchingDefs.length === 1) {
    const fieldDef = matchingDefs[0]!;
    const fieldType = fieldTypeForFieldDef(byId, fieldDef.id);
    const validation = validateFieldValuesForType(fieldName, fieldType, values);
    if (!validation.ok) {
      return { ok: false, code: 'invalid_field_value', error: validation.error, instructions: validation.instructions, nodeIds: [fieldDef.id] };
    }
    return { ok: true, target: { kind: 'existingFieldDef', fieldDefId: fieldDef.id, fieldType } };
  }

  const fieldType = inferFieldTypeFromValues(values);
  const validation = validateFieldValuesForType(fieldName, fieldType, values);
  if (!validation.ok) {
    return { ok: false, code: 'invalid_field_value', error: validation.error, instructions: validation.instructions };
  }
  return { ok: true, target: { kind: 'newFieldDef', fieldType } };
}

export function duplicateOwnerFieldEntries(
  byId: ReadonlyMap<NodeId, FieldResolutionNode>,
  ownerId: NodeId,
  options: ResolveFieldWriteTargetOptions = {},
): Array<{ key: string; label: string; entryIds: NodeId[] }> {
  const owner = byId.get(ownerId);
  if (!owner) return [];
  const isDeleted = deletedPredicate(byId, options);
  const groups = new Map<string, { label: string; entryIds: NodeId[] }>();
  for (const childId of owner.children) {
    const child = byId.get(childId);
    if (child?.type !== 'fieldEntry' || isDeleted(child.id)) continue;
    const label = fieldEntryDisplayName(byId, child);
    const key = normalizeFieldNameKey(label);
    if (!key) continue;
    const group = groups.get(key) ?? { label, entryIds: [] };
    group.entryIds.push(child.id);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.entryIds.length > 1)
    .map(([key, group]) => ({ key, ...group }));
}

export function duplicateOwnerError(fieldName: string, entryIds: NodeId[]): FieldResolutionResult & { ok: false } {
  return {
    ok: false,
    code: 'duplicate_field_entries',
    error: `Multiple field entries match "${fieldName}": ${entryIds.join(', ')}`,
    instructions: 'Merge or delete duplicate field entries first, then retry the field write.',
    nodeIds: entryIds,
  };
}

function resolveExistingEntry(
  byId: ReadonlyMap<NodeId, FieldResolutionNode>,
  fieldName: string,
  values: readonly FieldResolutionValue[],
  entry: FieldResolutionNode,
): FieldResolutionResult {
  const fieldDefId = entry.type === 'fieldEntry' ? entry.fieldDefId : undefined;
  if (fieldDefId) {
    const systemResult = resolveSystemWrite(fieldName, values, fieldDefId);
    if (systemResult.ok || systemResult.code === 'read_only_system_field') return systemResult;
  }
  const fieldType = fieldTypeForFieldDef(byId, fieldDefId);
  const validation = validateFieldValuesForType(fieldName, fieldType, values);
  if (!validation.ok) {
    return { ok: false, code: 'invalid_field_value', error: validation.error, instructions: validation.instructions, nodeIds: [entry.id] };
  }
  return { ok: true, target: { kind: 'existingEntry', fieldEntryId: entry.id, fieldDefId, fieldType } };
}

function resolveSystemWrite(
  fieldName: string,
  values: readonly FieldResolutionValue[],
  fieldDefId: NodeId,
): FieldResolutionResult {
  if (fieldDefId === DONE_FIELD) {
    const validation = validateFieldValuesForType(fieldName, 'checkbox', values);
    if (!validation.ok) {
      return { ok: false, code: 'invalid_field_value', error: validation.error, instructions: validation.instructions };
    }
    return { ok: true, target: { kind: 'systemDone', fieldDefId: DONE_FIELD } };
  }
  if (systemFieldLabel(fieldDefId)) {
    return {
      ok: false,
      code: 'read_only_system_field',
      error: `System field "${systemFieldLabel(fieldDefId)}" is read-only.`,
      instructions: 'Use normal node syntax for tags, references, and dates; only Done can be written through field syntax.',
      nodeIds: [fieldDefId],
    };
  }
  return {
    ok: false,
    code: 'not_system_field',
    error: `Not a system field: ${fieldDefId}`,
    instructions: 'Use a user field definition or a supported system field.',
  };
}

function resolveSystemFieldId(fieldName: string): NodeId | null {
  const key = normalizeFieldNameKey(fieldName);
  for (const id of SYSTEM_FIELD_IDS) {
    if (normalizeFieldNameKey(id) === key) return id;
    const label = systemFieldLabel(id);
    if (label && normalizeFieldNameKey(label) === key) return id;
  }
  return null;
}

function deletedPredicate(
  byId: ReadonlyMap<NodeId, FieldResolutionNode>,
  options: ResolveFieldWriteTargetOptions,
): (nodeId: NodeId) => boolean {
  if (options.isDeleted) return options.isDeleted;
  const trashId = options.trashId ?? TRASH_ID;
  return (nodeId) => nodeIsInSubtree(byId, nodeId, trashId);
}

function looksLikeUrl(value: string): boolean {
  if (/\s/.test(value) || value.includes('@')) return false;
  if (/^https?:\/\/\S+$/i.test(value)) return true;
  return /^[^\s/]+\.[^\s/]+/.test(value);
}
