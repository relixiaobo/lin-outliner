import type { Static, TSchema } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';

const validators = new WeakMap<object, Validator>();

export interface OutlineSchemaIssue {
  readonly path: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export interface OutlineSchemaValidationDetails {
  readonly issues: readonly OutlineSchemaIssue[];
  readonly truncated: boolean;
}

export function outlineSchemaValidator(schema: TSchema): Validator {
  const cached = validators.get(schema);
  if (cached) return cached;
  const validator = Compile(schema);
  validators.set(schema, validator);
  return validator;
}

export function checkOutlineSchema<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
): value is Static<TSchemaValue> {
  return outlineSchemaValidator(schema).Check(value);
}

export function outlineSchemaValidationDetails(
  schema: TSchema,
  value: unknown,
  limit = 16,
): OutlineSchemaValidationDetails {
  const collected: OutlineSchemaIssue[] = [];
  collectFocusedIssues(schema, value, '', '#', collectSchemaIds(schema), collected, limit + 1);
  return {
    issues: collected.slice(0, limit),
    truncated: collected.length > limit,
  };
}

function collectFocusedIssues(
  schema: TSchema,
  value: unknown,
  instancePath: string,
  schemaPath: string,
  schemasById: ReadonlyMap<string, TSchema>,
  issues: OutlineSchemaIssue[],
  limit: number,
): void {
  if (issues.length >= limit) return;
  const shape = schema as Record<string, unknown>;
  const reference = typeof shape.$ref === 'string' ? schemasById.get(shape.$ref) : undefined;
  if (reference) {
    collectFocusedIssues(reference, value, instancePath, `${schemaPath}/$ref`, schemasById, issues, limit);
    return;
  }

  const alternatives = schemaList(shape.anyOf);
  if (alternatives.length > 0) {
    const selected = alternatives
      .map((alternative, index) => ({ alternative, index, score: schemaMatchScore(alternative, value) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]!;
    collectFocusedIssues(
      selected.alternative,
      value,
      instancePath,
      `${schemaPath}/anyOf/${selected.index}`,
      schemasById,
      issues,
      limit,
    );
    return;
  }

  if (shape.type === 'object' && isRecord(value)) {
    const properties = isRecord(shape.properties) ? shape.properties : {};
    const required = Array.isArray(shape.required)
      ? shape.required.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const missing = required.filter((key) => !(key in value));
    if (missing.length > 0) {
      issues.push({
        path: instancePath || '/',
        schemaPath,
        keyword: 'required',
        message: `must have required properties ${missing.join(', ')}`,
      });
    }
    if (issues.length >= limit) return;

    if (shape.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) {
      issues.push({
        path: instancePath || '/',
        schemaPath,
        keyword: 'additionalProperties',
        message: 'must not have additional properties',
      });
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value) || !isSchema(propertySchema) || checkSchemaSafely(propertySchema, value[key])) continue;
      collectFocusedIssues(
        propertySchema,
        value[key],
        `${instancePath}/${escapeJsonPointer(key)}`,
        `${schemaPath}/properties/${escapeJsonPointer(key)}`,
        schemasById,
        issues,
        limit,
      );
      if (issues.length >= limit) return;
    }
    return;
  }

  if (shape.type === 'array' && Array.isArray(value) && isSchema(shape.items)) {
    for (const [index, entry] of value.entries()) {
      if (checkSchemaSafely(shape.items, entry)) continue;
      collectFocusedIssues(
        shape.items,
        entry,
        `${instancePath}/${index}`,
        `${schemaPath}/items`,
        schemasById,
        issues,
        limit,
      );
      if (issues.length >= limit) return;
    }
    return;
  }

  appendValidatorIssues(schema, value, instancePath, schemaPath, issues, limit);
}

function appendValidatorIssues(
  schema: TSchema,
  value: unknown,
  instancePath: string,
  schemaPath: string,
  issues: OutlineSchemaIssue[],
  limit: number,
): void {
  try {
    for (const error of outlineSchemaValidator(schema).Errors(value)) {
      if (issues.length >= limit) return;
      issues.push({
        path: `${instancePath}${error.instancePath}` || '/',
        schemaPath: `${schemaPath}${error.schemaPath === '#' ? '' : error.schemaPath.slice(1)}`,
        keyword: error.keyword,
        message: error.message,
      });
    }
  } catch {
    issues.push({
      path: instancePath || '/',
      schemaPath,
      keyword: 'schema',
      message: 'must match the public schema',
    });
  }
}

function schemaMatchScore(schema: TSchema, value: unknown): number {
  const shape = schema as Record<string, unknown>;
  const alternatives = schemaList(shape.anyOf);
  if (alternatives.length > 0) {
    return Math.max(...alternatives.map((alternative) => schemaMatchScore(alternative, value)));
  }
  if (!isRecord(value) || !isRecord(shape.properties)) {
    if ('const' in shape) return Object.is(value, shape.const) ? 1_000 : -1_000;
    return 0;
  }
  const properties = shape.properties;
  let score = 0;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!isSchema(propertySchema)) continue;
    const property = propertySchema as Record<string, unknown>;
    if ('const' in property && key in value) {
      score += Object.is(value[key], property.const) ? 1_000 : -1_000;
    } else if (key in value) {
      score += 4;
    }
  }
  const required = Array.isArray(shape.required)
    ? shape.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  score += required.filter((key) => key in value).length;
  score -= required.filter((key) => !(key in value)).length;
  if (shape.additionalProperties === false) {
    score -= Object.keys(value).filter((key) => !(key in properties)).length;
  }
  return score;
}

function collectSchemaIds(schema: TSchema): ReadonlyMap<string, TSchema> {
  const schemas = new Map<string, TSchema>();
  const visited = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!isRecord(candidate) || visited.has(candidate)) return;
    visited.add(candidate);
    if (typeof candidate.$id === 'string' && isSchema(candidate)) schemas.set(candidate.$id, candidate);
    for (const value of Object.values(candidate)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(schema);
  return schemas;
}

function checkSchemaSafely(schema: TSchema, value: unknown): boolean {
  try {
    return checkOutlineSchema(schema, value);
  } catch {
    return false;
  }
}

function schemaList(value: unknown): readonly TSchema[] {
  return Array.isArray(value) ? value.filter(isSchema) : [];
}

function isSchema(value: unknown): value is TSchema {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
