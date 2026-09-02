import Type, { type Static } from 'typebox';
import { canonicalSha256 } from './canonical';

const closed = { additionalProperties: false } as const;

export const OutlineRecipeSchema = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 128 }),
  variant: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
  intent: Type.String({ minLength: 1, maxLength: 512 }),
  invocation: Type.String({ minLength: 1, maxLength: 1_024 }),
  stdin: Type.Optional(Type.String({ maxLength: 16_384 })),
  receipt: Type.String({ minLength: 1, maxLength: 64 }),
  verify: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
  review: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
}, { ...closed, $id: 'OutlineRecipe' });

export type OutlineRecipe = Static<typeof OutlineRecipeSchema>;

const recipes = [
  {
    command: 'create',
    variant: 'collection',
    intent: 'Create one Node tree with reusable typed fields and an optional View.',
    invocation: 'outline create --input -',
    stdin: JSON.stringify({
      at: { parent: '@today', position: 'first' },
      fields: [
        { key: 'weather', name: 'Weather', type: 'text' },
        { key: 'low', name: 'Night low (C)', type: 'number' },
      ],
      node: {
        text: 'Chengdu district weather',
        description: 'Sunny throughout.',
        children: [
          { text: 'Central districts', fields: { weather: 'Sunny', low: 21 } },
        ],
      },
      view: { mode: 'table', display: ['weather', 'low'] },
    }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'edit',
    variant: 'complete',
    intent: 'Converge content, completion, tags, fields, and references in one request.',
    invocation: 'outline edit --input -',
    stdin: JSON.stringify({
      target: 'node:replace-me',
      node: { description: 'Ready for review', done: true },
      tags: { add: ['tag:priority'] },
      fields: [{ field: 'field:status', value: 'Active' }],
    }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'define ensure',
    variant: 'field',
    intent: 'Reuse or create one compatible typed Field definition.',
    invocation: 'outline define ensure --input -',
    stdin: JSON.stringify({ kind: 'field', name: 'Priority', type: 'select' }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'view set',
    variant: 'complete',
    intent: 'Replace one effective View configuration without changing scoped Nodes.',
    invocation: 'outline view set --input -',
    stdin: JSON.stringify({
      target: 'node:replace-me',
      view: { mode: 'table', replace: { display: [{ field: 'sys:name' }] } },
    }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'find',
    variant: 'named-counts',
    intent: 'Count several named canonical queries at one revision.',
    invocation: 'outline find --input -',
    stdin: JSON.stringify({
      mode: 'count',
      queries: [
        { name: 'open', query: { kind: 'rule', op: 'STRING_MATCH', text: 'Open' } },
        { name: 'closed', query: { kind: 'rule', op: 'STRING_MATCH', text: 'Closed' } },
      ],
    }, null, 2),
    receipt: 'count',
  },
  {
    command: 'edit',
    variant: 'bounded-query',
    intent: 'Converge a bounded query-selected Node set in one Operation.',
    invocation: 'outline edit --input -',
    stdin: JSON.stringify({
      target: {
        selector: {
          by: 'query',
          query: { kind: 'rule', op: 'STRING_MATCH', text: 'Project task' },
          order: 'document',
          limit: 25,
        },
        cardinality: 'many',
        max: 25,
      },
      node: { done: true },
    }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'transact',
    variant: 'dependent-change',
    intent: 'Apply one non-destructive multi-resource change with bindings.',
    invocation: 'outline transact --input -',
    stdin: JSON.stringify({
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'cli:replace-with-stable-key',
      source: { kind: 'cli' },
      operations: [
        {
          op: 'create',
          placement: { kind: 'last', parent: { target: { selector: { by: 'alias', alias: 'inbox' }, cardinality: 'one' } } },
          nodes: [{ content: { text: 'Project', marks: [], inlineRefs: [] }, children: [] }],
          bind: 'project',
        },
        {
          op: 'update',
          targets: { binding: 'project' },
          changes: [{ kind: 'description', value: 'Created atomically.' }],
        },
      ],
    }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'preview',
    variant: 'reviewed-change',
    intent: 'Preview a ChangeSet and persist the immutable Diff for exact application.',
    invocation: 'outline preview --input - --output reviewed-diff.json',
    stdin: JSON.stringify({
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'cli:replace-with-stable-key',
      source: { kind: 'cli' },
      operations: [
        {
          op: 'update',
          targets: { target: { selector: { by: 'alias', alias: 'inbox' }, cardinality: 'one' } },
          changes: [{ kind: 'description', value: 'Reviewed change.' }],
        },
      ],
    }, null, 2),
    receipt: 'diff',
    review: 'Apply only the exact returned Diff hash with outline apply reviewed-diff.json.',
  },
  {
    command: 'search create',
    variant: 'complete',
    intent: 'Create one Saved Search with a canonical query and initial view.',
    invocation: 'outline search create --input -',
    stdin: JSON.stringify({
      title: 'Modules',
      match: 'module',
      view: { mode: 'table' },
    }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'capture create',
    variant: 'complete',
    intent: 'Create one provenanced capture tree below an exact destination.',
    invocation: 'outline capture create --input -',
    stdin: JSON.stringify({
      parent: '@inbox',
      title: 'Captured item',
      provenance: {
        schemaVersion: 1,
        captureId: 'capture:replace-me',
        createdBy: 'agent',
        capturedAt: '2026-01-01T00:00:00.000Z',
        origin: 'test',
        providerId: 'unknown-app',
        app: { name: 'Unknown' },
        source: { kind: 'app', title: 'Captured item', original: { kind: 'app-resource', preview: 'unsupported' }, providerId: 'unknown-app' },
        status: 'saved',
        intent: 'capture',
        warnings: [],
      },
    }, null, 2),
    receipt: 'mutation',
  },
  {
    command: 'import plan',
    variant: 'normalized',
    intent: 'Create one immutable reviewed import Diff and evidence from a normalized source.',
    invocation: 'outline import plan SOURCE --format normalized --output import.diff.json --evidence-output import.evidence.json',
    receipt: 'import',
    review: 'Review the returned hashes, coverage, warnings, and exact Diff before applying import.diff.json once.',
  },
  {
    command: 'import verify',
    variant: 'applied',
    intent: 'Verify one applied import against its exact Diff and evidence artifacts.',
    invocation: 'outline import verify OPERATION_ID --diff import.diff.json --evidence import.evidence.json',
    receipt: 'import',
  },
] as const satisfies readonly OutlineRecipe[];

export const OUTLINE_RECIPES: readonly OutlineRecipe[] = Object.freeze(recipes);

const recipeByKey = new Map(OUTLINE_RECIPES.map((recipe) => [`${recipe.command}\0${recipe.variant}`, recipe]));

export function outlineRecipe(command: string, variant: string): OutlineRecipe | undefined {
  return recipeByKey.get(`${command}\0${variant}`);
}

export function outlineRecipeVariants(command?: string): readonly OutlineRecipe[] {
  return command ? OUTLINE_RECIPES.filter((recipe) => recipe.command === command) : OUTLINE_RECIPES;
}

export function outlineRecipeDigest(): string {
  return canonicalSha256(OUTLINE_RECIPES);
}
