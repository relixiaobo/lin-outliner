import type {
  Change,
  ChangeSet,
  EventFilter,
  Projection,
  Selector,
  TargetRef,
  TargetSpec,
  WatchRequest,
} from '../contract/schemas';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import { readTargetSpec, reconcileReadSelector } from '../contract/readTargets';
import { OUTLINE_PROTOCOL_VERSION } from '../contract/version';

export type StructuredReader = (source: string) => Promise<string>;

export interface ParsedReadCommand {
  readonly input: unknown;
  readonly output?: string;
}

export interface SplitOptionArguments {
  readonly options: readonly string[];
  readonly literals: readonly string[];
}

export function splitOptionTerminator(args: readonly string[]): SplitOptionArguments {
  const index = args.indexOf('--');
  return index < 0
    ? { options: args, literals: [] }
    : { options: args.slice(0, index), literals: args.slice(index + 1) };
}

export async function parseReadCommand(
  command: 'find' | 'get' | 'export',
  args: readonly string[],
  read: StructuredReader,
): Promise<ParsedReadCommand> {
  const split = splitOptionTerminator(args);
  const inputIndex = split.options.indexOf('--input');
  if (inputIndex >= 0) {
    if (command !== 'find') throw usageError('--input is only available for find.');
    if (inputIndex !== 0 || split.options.length !== 2 || split.literals.length > 0) {
      throw usageError('find --input must be used alone.');
    }
    return {
      input: parseJson(await read(requiredValue(split.options[1], '--input')), '--input'),
    };
  }
  let selector: Selector | undefined;
  let query: unknown;
  let searchId: string | undefined;
  let count = false;
  let within: Selector | undefined;
  let includeTrash = false;
  let order: 'document' | 'created' | 'updated' | 'text' | undefined;
  let limit = 100;
  let limitSpecified = false;
  let cursor: string | undefined;
  let kind: Projection['kind'] | undefined;
  let depth: number | undefined;
  let include: Projection['include'];
  let format: Projection['format'];
  let projection: Projection | undefined;
  let output: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index];
    if (arg === '--selector') selector = parseSelector(await read(requiredValue(split.options[++index], '--selector')));
    else if (arg === '--query') query = parseJson(await read(requiredValue(split.options[++index], '--query')), '--query');
    else if (arg === '--search') searchId = requiredValue(split.options[++index], '--search');
    else if (arg === '--count') count = true;
    else if (arg === '--within') within = parseSelector(await read(requiredValue(split.options[++index], '--within')));
    else if (arg === '--include-trash') includeTrash = true;
    else if (arg === '--order') order = oneOf(requiredValue(split.options[++index], '--order'), ['document', 'created', 'updated', 'text'], '--order');
    else if (arg === '--limit') {
      limit = boundedInteger(split.options[++index], '--limit', 1, 10_000);
      limitSpecified = true;
    }
    else if (arg === '--cursor') cursor = requiredValue(split.options[++index], '--cursor');
    else if (arg === '--kind') kind = oneOf(requiredValue(split.options[++index], '--kind'), ['summary', 'node', 'outline', 'backlinks', 'view', 'export'], '--kind');
    else if (arg === '--depth') depth = boundedInteger(split.options[++index], '--depth', 0, 1_024);
    else if (arg === '--include') include = parseInclude(requiredValue(split.options[++index], '--include'));
    else if (arg === '--format') format = oneOf(requiredValue(split.options[++index], '--format'), ['json', 'jsonl', 'markdown', 'opml'], '--format');
    else if (arg === '--projection') projection = parseJson(await read(requiredValue(split.options[++index], '--projection')), '--projection') as Projection;
    else if (arg === '--output') output = requiredValue(split.options[++index], '--output');
    else if (arg?.startsWith('-')) throw usageError(`Unknown ${command} option: ${arg}`);
    else positional.push(arg ?? '');
  }
  positional.push(...split.literals);
  if (selector && positional.length > 0) throw usageError(`${command} cannot combine a positional target with --selector.`);
  if (command === 'find') {
    if (selector && (query !== undefined || searchId)) throw usageError('find cannot combine --selector with --query or --search.');
    if (searchId && (query !== undefined || positional.length > 0)) {
      throw usageError('find --search cannot be combined with TEXT or --query.');
    }
    if (count) {
      if (selector || projection || kind || depth !== undefined || include || cursor || format || order || limitSpecified) {
        throw usageError('find --count cannot use Selector, Projection, order, cursor, or limit options.');
      }
      if (searchId) {
        if (within || includeTrash) throw usageError('find --search --count uses the Saved Search scope as configured.');
        return { input: { mode: 'count', searchId } };
      }
      const expression = query ?? { kind: 'rule', op: 'STRING_MATCH', text: positional.join(' ') };
      return {
        input: {
          mode: 'count',
          query: expression,
          ...(within ? { within } : {}),
          ...(includeTrash ? { includeTrash: true } : {}),
        },
      };
    }
    if (!selector) {
      selector = searchId
        ? { by: 'search', id: searchId, limit }
        : {
            by: 'query',
            query: (query ?? { kind: 'rule', op: 'STRING_MATCH', text: positional.join(' ') }) as Selector & never,
            ...(within ? { within } : {}),
            ...(includeTrash ? { includeTrash: true } : {}),
            ...(order ? { order } : {}),
            limit,
          };
    } else if (positional.length > 0) {
      throw usageError('find accepts at most one text query.');
    }
  } else {
    if (query !== undefined || within || includeTrash || order) {
      throw usageError(`${command} does not accept find query options.`);
    }
    if (!selector && positional.length > 0) {
      if (positional.length === 1) selector = parseSelectorToken(positional[0]!);
      else {
        const selectors = positional.map(parseSelectorToken);
        if (selectors.some((entry) => entry.by !== 'id')) {
          throw usageError(`${command} accepts multiple positional selectors only when every value is an exact Node ID.`);
        }
        selector = { by: 'ids', ids: selectors.map((entry) => (entry as Extract<Selector, { by: 'id' }>).id) };
        if (!limitSpecified) limit = selector.ids.length;
      }
    }
  }
  if (projection && (kind || depth !== undefined || include || cursor || format || limitSpecified)) {
    throw usageError('--projection cannot be combined with individual Projection options.');
  }
  const resolvedSelector = command === 'find'
    ? selector!
    : reconcileReadSelector(command, selector, projection);
  const target = command === 'find'
    ? targetRef(resolvedSelector, 'many', selectorBound(resolvedSelector) ?? limit)
    : { target: readTargetSpec(resolvedSelector) };
  const requestedProjection: Projection = projection ?? {
    kind: kind ?? (command === 'find' ? 'summary' : command === 'get' ? 'node' : 'export'),
    targets: target,
    ...(depth !== undefined ? { depth } : command === 'export' ? { depth: 1_024 } : {}),
    ...(include ? { include } : command === 'get'
      ? { include: ['description', 'fields'] }
      : command === 'export'
      ? { include: ['description', 'children', 'tags', 'fields', 'references', 'media', 'view', 'trash'] }
      : {}),
    page: { limit, ...(cursor ? { cursor } : {}) },
    ...(format ? { format } : command === 'export' ? { format: 'json' } : {}),
  };
  if (command !== 'export' && output) throw usageError('--output is only valid for export.');
  return {
    input: command === 'find'
      ? { target: target.target, projection: requestedProjection }
      : { projection: requestedProjection },
    ...(output ? { output } : {}),
  };
}

export async function parseWatchCommand(
  args: readonly string[],
  read: StructuredReader,
): Promise<WatchRequest> {
  const split = splitOptionTerminator(args);
  if (split.literals.length > 0) throw usageError(`Unexpected watch argument: ${split.literals[0]}`);
  let cursor: string | undefined;
  let filter: EventFilter | undefined;
  let projection: Projection | undefined;
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index];
    if (arg === '--cursor') cursor = requiredValue(split.options[++index], '--cursor');
    else if (arg === '--filter') filter = parseJson(await read(requiredValue(split.options[++index], '--filter')), '--filter') as EventFilter;
    else if (arg === '--projection') projection = parseJson(await read(requiredValue(split.options[++index], '--projection')), '--projection') as Projection;
    else throw usageError(`Unknown watch option: ${arg}`);
  }
  return {
    ...(cursor ? { cursor } : {}),
    ...(filter ? { filter } : {}),
    ...(projection ? { projection } : {}),
  };
}

export function parseSelectorToken(value: string): Selector {
  if (value.startsWith('@date:')) return { by: 'date', date: value.slice('@date:'.length) };
  if (value.startsWith('@')) {
    const alias = value.slice(1);
    if (isAlias(alias)) return { by: 'alias', alias };
    throw usageError(`Unknown outline alias: ${value}`);
  }
  if (value.length > 0) return { by: 'id', id: value };
  throw usageError('Selector must be an exact Node ID or semantic @alias.');
}

export async function parseChangeSetInput(raw: string, format: 'json' | 'jsonl'): Promise<ChangeSet> {
  if (format === 'json') return parseJson(raw, 'ChangeSet input') as ChangeSet;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 3) throw usageError('JSONL ChangeSet requires a header, operations, and trailer.');
  const header = parseJson(lines[0]!, 'JSONL ChangeSet header');
  const trailer = parseJson(lines.at(-1)!, 'JSONL ChangeSet trailer');
  if (!isRecord(header) || !isRecord(trailer) || Object.hasOwn(header, 'operations')) {
    throw usageError('JSONL ChangeSet header or trailer is invalid.');
  }
  const operations: Change[] = lines.slice(1, -1).map((line, index) => {
    const value = parseJson(line, `JSONL ChangeSet operation ${index}`);
    return (isRecord(value) && Object.hasOwn(value, 'operation') ? value.operation : value) as Change;
  });
  if (trailer.operationCount !== operations.length || typeof trailer.sha256 !== 'string') {
    throw usageError('JSONL ChangeSet trailer count or SHA-256 is invalid.');
  }
  const changeSet = { ...header, operations } as unknown as ChangeSet;
  if (canonicalSha256(changeSet) !== trailer.sha256) {
    throw usageError('JSONL ChangeSet SHA-256 does not match its records.');
  }
  return changeSet;
}

export function createChangeSet(operations: readonly Change[], idempotencyKey?: string): ChangeSet {
  return {
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    kind: 'outline.changeset',
    ...(idempotencyKey ? { idempotencyKey } : {}),
    source: { kind: 'cli' },
    operations: [...operations],
  };
}

function parseSelector(raw: string): Selector {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return parseSelectorToken(trimmed);
  const value = parseJson(trimmed, 'Selector');
  if (isRecord(value) && isRecord(value.selector)) return value.selector as Selector;
  return value as Selector;
}

function targetRef(selector: Selector, cardinality: TargetSpec['cardinality'], max?: number): TargetRef & { target: TargetSpec } {
  return {
    target: {
      selector,
      cardinality,
      ...(max !== undefined ? { max } : {}),
    },
  };
}

function selectorBound(selector: Selector): number | undefined {
  if (selector.by === 'ids') return selector.ids.length;
  if (selector.by === 'query' || selector.by === 'search') return selector.limit;
  return undefined;
}

function parseInclude(value: string): Projection['include'] {
  const allowed = ['description', 'children', 'tags', 'fields', 'references', 'media', 'view', 'trash', 'backlinks'] as const;
  const result = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of result) {
    if (!(allowed as readonly string[]).includes(entry)) throw usageError(`Unknown Projection include: ${entry}`);
  }
  return result as Projection['include'];
}

function isAlias(value: string): value is Extract<Selector, { by: 'alias' }>['alias'] {
  return ['home', 'inbox', 'library', 'schema', 'trash', 'daily-notes', 'saved-searches', 'today'].includes(value);
}

function oneOf<const T extends readonly string[]>(value: string, allowed: T, option: string): T[number] {
  if (!(allowed as readonly string[]).includes(value)) throw usageError(`${option} must be one of: ${allowed.join(', ')}.`);
  return value as T[number];
}

function boundedInteger(value: string | undefined, option: string, minimum: number, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) throw usageError(`${option} requires an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw usageError(`${option} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith('--')) throw usageError(`${option} requires a value.`);
  return value;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw usageError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usageError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'usage', message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
