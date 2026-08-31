import type {
  JsonValue,
  ThreadInternalTextPayloadReference,
  ToolCallArgumentInternalTextBinding,
  ToolCallArgumentsContextPayload,
} from '../../../core/agent/protocol';
import {
  MAX_TOOL_ARGUMENT_DISPLAY_CHARS,
} from '../../../core/agent/modelCallHistory';
import {
  MAX_TOOL_ARGUMENT_TEXT_BINDINGS,
  MAX_TOOL_ARGUMENT_TEXT_BYTES,
} from '../../../core/agent/protocol';
import type { AgentToolLargeTextArguments, AgentToolLargeTextBinding } from './kernel/types';

export interface SelectedLargeTextArgument extends AgentToolLargeTextBinding {
  readonly value: string;
  readonly byteLength: number;
}

export interface FactoredLargeTextArguments {
  readonly payload: ToolCallArgumentsContextPayload;
  readonly internalTextRefs: readonly ThreadInternalTextPayloadReference[];
}

export interface InternalTextArgumentProjection {
  readonly textPrefix: string;
  readonly textChars: number;
  readonly jsonStringChars: number;
}

export type ReadInternalTextArgumentProjection = (
  ref: ThreadInternalTextPayloadReference,
  maxPrefixChars: number,
) => Promise<InternalTextArgumentProjection | null>;

export function selectLargeTextArguments(
  value: JsonValue,
  contract: AgentToolLargeTextArguments | undefined,
): readonly SelectedLargeTextArgument[] {
  if (!contract) return [];
  assertContractLimit(contract.maxBindings, 1, MAX_TOOL_ARGUMENT_TEXT_BINDINGS, 'binding count');
  assertContractLimit(contract.maxAggregateBytes, 0, MAX_TOOL_ARGUMENT_TEXT_BYTES, 'aggregate byte');
  const bindings = [...contract.select(structuredClone(value))];
  if (bindings.length > contract.maxBindings || bindings.length > MAX_TOOL_ARGUMENT_TEXT_BINDINGS) {
    throw new Error('Large-text argument binding count exceeds its declared limit.');
  }
  const selected = bindings.map((binding) => selectBinding(value, binding));
  const sorted = [...selected].sort((left, right) => left.path.localeCompare(right.path));
  if (sorted.some((binding, index) => binding.path !== selected[index]?.path)) {
    throw new Error('Large-text argument bindings must be in canonical path order.');
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const previous = sorted[index - 1];
    if (previous?.path === current.path) throw new Error('Large-text argument paths must be unique.');
    if (previous && isPointerAncestor(previous.path, current.path)) {
      throw new Error('Large-text argument paths must not overlap.');
    }
  }
  const aggregate = selected.reduce((total, binding) => total + binding.byteLength, 0);
  if (aggregate > contract.maxAggregateBytes || aggregate > MAX_TOOL_ARGUMENT_TEXT_BYTES) {
    throw new Error('Large-text argument bytes exceed the aggregate limit.');
  }
  return Object.freeze(selected.map((entry) => Object.freeze(entry)));
}

export function factorLargeTextArguments(
  value: JsonValue,
  selected: readonly SelectedLargeTextArgument[],
  refs: readonly ThreadInternalTextPayloadReference[],
): FactoredLargeTextArguments {
  if (selected.length !== refs.length) throw new Error('Every large-text binding requires one reference.');
  const skeleton = structuredClone(value);
  const bindings = selected.map((entry, index): ToolCallArgumentInternalTextBinding => {
    const ref = refs[index]!;
    if (ref.byteLength !== entry.byteLength) throw new Error('Internal-text byte length does not match its binding.');
    replaceJsonPointer(skeleton, entry.path, null, true);
    return { kind: 'internalText', path: entry.path, ref };
  });
  return {
    payload: { schemaVersion: 1, kind: 'toolCallArguments', value: skeleton, bindings },
    internalTextRefs: deduplicateRefs(refs),
  };
}

export async function rehydrateLargeTextArguments(
  payload: ToolCallArgumentsContextPayload,
  declaredRefs: readonly ThreadInternalTextPayloadReference[],
  read: (ref: ThreadInternalTextPayloadReference) => Promise<string | null>,
): Promise<JsonValue | null> {
  try {
    validateStoredBindings(payload.bindings, declaredRefs);
    const value = structuredClone(payload.value);
    for (const binding of payload.bindings) {
      if (resolveJsonPointer(value, binding.path) !== null) return null;
      const text = await read(binding.ref);
      if (text === null || !hasWellFormedUnicode(text) || Buffer.byteLength(text, 'utf8') !== binding.ref.byteLength) {
        return null;
      }
      replaceJsonPointer(value, binding.path, text, false);
    }
    return value;
  } catch {
    return null;
  }
}

export async function projectLargeTextArgumentsForDisplay(
  payload: ToolCallArgumentsContextPayload,
  declaredRefs: readonly ThreadInternalTextPayloadReference[],
  read: ReadInternalTextArgumentProjection,
  maxChars = MAX_TOOL_ARGUMENT_DISPLAY_CHARS,
): Promise<JsonValue | null> {
  try {
    if (!Number.isSafeInteger(maxChars) || maxChars < 0) return null;
    validateStoredBindings(payload.bindings, declaredRefs);
    const projections = new Map<string, InternalTextArgumentProjection>();
    for (const binding of payload.bindings) {
      if (resolveJsonPointer(payload.value, binding.path) !== null) return null;
      const projection = await read(binding.ref, maxChars + 1);
      if (!projection || !validTextProjection(projection, maxChars + 1)) return null;
      projections.set(binding.path, projection);
    }
    const formatted = projectedPrettyJson(payload.value, projections, maxChars);
    if (formatted.totalChars <= maxChars) {
      const exact = structuredClone(payload.value);
      for (const binding of payload.bindings) {
        const projection = projections.get(binding.path)!;
        if (projection.textPrefix.length !== projection.textChars) return null;
        replaceJsonPointer(exact, binding.path, projection.textPrefix, false);
      }
      return exact;
    }
    return boundedProjectedSummary(formatted.preview, formatted.totalChars, maxChars);
  } catch {
    return null;
  }
}

export function replaceSelectedLargeTextArguments(
  value: JsonValue,
  selected: readonly Pick<SelectedLargeTextArgument, 'path'>[],
  replacements: readonly JsonValue[],
  expectedSource: 'string' | 'null' = 'string',
): JsonValue {
  if (selected.length !== replacements.length) throw new Error('Every selected argument requires one replacement.');
  const result = structuredClone(value);
  for (const [index, binding] of selected.entries()) {
    if (expectedSource === 'null' && resolveJsonPointer(result, binding.path) !== null) {
      throw new Error('Large-text argument skeleton path must resolve to null.');
    }
    replaceJsonPointer(result, binding.path, replacements[index]!, expectedSource === 'string');
  }
  return result;
}

export function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isCanonicalJsonPointer(path: string): boolean {
  if (path === '') return false;
  if (!path.startsWith('/')) return false;
  return path.split('/').slice(1).every((token) => !/~(?:[^01]|$)/.test(token));
}

function selectBinding(value: JsonValue, binding: AgentToolLargeTextBinding): SelectedLargeTextArgument {
  if (binding.kind !== 'internalText' || binding.historyPolicy !== 'secretScanText') {
    throw new Error('Unsupported large-text argument binding.');
  }
  if (!isCanonicalJsonPointer(binding.path)) throw new Error('Large-text argument path is not canonical RFC 6901.');
  assertContractLimit(binding.maxBytes, 0, MAX_TOOL_ARGUMENT_TEXT_BYTES, 'binding byte');
  const selected = resolveJsonPointer(value, binding.path);
  if (typeof selected !== 'string') throw new Error('Large-text argument path must resolve to a string.');
  if (!hasWellFormedUnicode(selected)) throw new Error('Large-text arguments require well-formed Unicode.');
  const byteLength = Buffer.byteLength(selected, 'utf8');
  if (byteLength > binding.maxBytes) throw new Error('Large-text argument exceeds its byte limit.');
  return { ...binding, value: selected, byteLength };
}

function validateStoredBindings(
  bindings: readonly ToolCallArgumentInternalTextBinding[],
  refs: readonly ThreadInternalTextPayloadReference[],
): void {
  if (bindings.length > MAX_TOOL_ARGUMENT_TEXT_BINDINGS) throw new Error('Too many stored argument bindings.');
  const paths = bindings.map((binding) => binding.path);
  if (paths.some((path) => !isCanonicalJsonPointer(path))) throw new Error('Invalid stored argument path.');
  const sorted = [...paths].sort();
  if (paths.some((path, index) => path !== sorted[index])) throw new Error('Stored argument bindings are reordered.');
  if (paths.some((path, index) => index > 0 && (path === paths[index - 1] || isPointerAncestor(paths[index - 1]!, path)))) {
    throw new Error('Stored argument bindings overlap.');
  }
  const actual = deduplicateRefs(bindings.map((binding) => binding.ref)).map(referenceKey).sort();
  const declared = deduplicateRefs(refs).map(referenceKey).sort();
  if (actual.length !== refs.length || actual.length !== declared.length || actual.some((key, index) => key !== declared[index])) {
    throw new Error('Stored argument dependency set does not match its bindings.');
  }
}

function validTextProjection(projection: InternalTextArgumentProjection, maxPrefixChars: number): boolean {
  return typeof projection.textPrefix === 'string'
    && hasWellFormedUnicode(projection.textPrefix)
    && Number.isSafeInteger(projection.textChars)
    && projection.textChars >= projection.textPrefix.length
    && Number.isSafeInteger(projection.jsonStringChars)
    && projection.jsonStringChars >= 2
    && projection.textPrefix.length <= maxPrefixChars;
}

function projectedPrettyJson(
  value: JsonValue,
  projections: ReadonlyMap<string, InternalTextArgumentProjection>,
  maxPreviewChars: number,
): { readonly preview: string; readonly totalChars: number } {
  let preview = '';
  let totalChars = 0;
  const append = (prefix: string, length = prefix.length): void => {
    if (preview.length < maxPreviewChars) {
      preview += prefix.slice(0, maxPreviewChars - preview.length);
    }
    totalChars += length;
  };
  const indent = (depth: number): string => '  '.repeat(Math.min(depth, 10));
  const visit = (entry: JsonValue, path: string, depth: number): void => {
    const projection = projections.get(path);
    if (projection) {
      const encodedPrefix = JSON.stringify(projection.textPrefix);
      append(
        projection.textPrefix.length === projection.textChars
          ? encodedPrefix
          : encodedPrefix.slice(0, -1),
        projection.jsonStringChars,
      );
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        append('[]');
        return;
      }
      append('[\n');
      for (const [index, child] of entry.entries()) {
        if (index > 0) append(',\n');
        append(indent(depth + 1));
        visit(child, `${path}/${index}`, depth + 1);
      }
      append(`\n${indent(depth)}]`);
      return;
    }
    if (entry !== null && typeof entry === 'object') {
      const fields = Object.entries(entry);
      if (fields.length === 0) {
        append('{}');
        return;
      }
      append('{\n');
      for (const [index, [key, child]] of fields.entries()) {
        if (index > 0) append(',\n');
        append(`${indent(depth + 1)}${JSON.stringify(key)}: `);
        visit(child, `${path}/${escapeJsonPointerToken(key)}`, depth + 1);
      }
      append(`\n${indent(depth)}}`);
      return;
    }
    append(JSON.stringify(entry));
  };
  visit(value, '', 0);
  return { preview, totalChars };
}

function boundedProjectedSummary(preview: string, originalChars: number, maxChars: number): JsonValue {
  const summary = (value: string): JsonValue => ({ truncated: true, originalChars, preview: value });
  let low = 0;
  let high = preview.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (JSON.stringify(summary(preview.slice(0, midpoint)), null, 2).length <= maxChars) low = midpoint;
    else high = midpoint - 1;
  }
  return summary(preview.slice(0, low));
}

function resolveJsonPointer(value: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const token of pointerTokens(path)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      current = (current as Readonly<Record<string, JsonValue>>)[token];
    } else return undefined;
  }
  return current;
}

function replaceJsonPointer(value: JsonValue, path: string, replacement: JsonValue, requireString: boolean): void {
  const tokens = pointerTokens(path);
  const key = tokens.pop();
  if (key === undefined) throw new Error('The root argument cannot be bound.');
  let parent: JsonValue = value;
  for (const token of tokens) {
    const next = Array.isArray(parent)
      ? parent[Number(token)]
      : parent !== null && typeof parent === 'object'
        ? (parent as Record<string, JsonValue>)[token]
        : undefined;
    if (next === undefined) throw new Error('Large-text argument path does not exist.');
    parent = next;
  }
  const current = Array.isArray(parent) ? parent[Number(key)] : (parent as Record<string, JsonValue>)[key];
  if (requireString && typeof current !== 'string') throw new Error('Large-text argument path must resolve to a string.');
  if (Array.isArray(parent)) parent[Number(key)] = replacement;
  else (parent as Record<string, JsonValue>)[key] = replacement;
}

function pointerTokens(path: string): string[] {
  return path.split('/').slice(1).map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isPointerAncestor(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

function deduplicateRefs(refs: readonly ThreadInternalTextPayloadReference[]): ThreadInternalTextPayloadReference[] {
  const unique = new Map(refs.map((ref) => [referenceKey(ref), ref]));
  return [...unique.values()].sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)));
}

function referenceKey(ref: ThreadInternalTextPayloadReference): string {
  return `${ref.id}:${ref.byteLength}:${ref.encoding}`;
}

function assertContractLimit(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid large-text argument ${name} limit.`);
  }
}
