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

const viewedTreeInput = {
  kind: 'viewed-tree',
  placement: { kind: 'first', parent: '@today' },
  title: 'Prices',
  fields: [
    { key: 'price', name: 'Price', config: { fieldType: 'number' } },
  ],
  items: [
    { content: 'Item A', values: { price: 12 } },
  ],
  view: { mode: 'table' },
};

const recipes = [
  {
    command: 'add',
    variant: 'viewed-tree',
    intent: 'Create one native view-backed collection below one exact destination.',
    invocation: 'outline add --input -',
    stdin: JSON.stringify(viewedTreeInput, null, 2),
    receipt: 'mutation',
    verify: 'outline view inspect OWNER_ID',
  },
  {
    command: 'add',
    variant: 'typed-tree',
    intent: 'Create one complete typed Node tree below one exact destination.',
    invocation: 'outline add --input -',
    stdin: JSON.stringify({
      placement: { kind: 'last', parent: '@inbox' },
      nodes: [{ type: 'plain', content: { text: 'Project', marks: [], inlineRefs: [] }, children: [] }],
    }, null, 2),
    receipt: 'mutation',
    verify: 'outline show CREATED_NODE_ID',
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
    command: 'done set',
    variant: 'bounded-query',
    intent: 'Set done state on a query-selected Node set with an explicit maximum.',
    invocation: 'outline done set --input -',
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
      value: true,
    }, null, 2),
    receipt: 'mutation',
    verify: 'outline find "Project task" --limit 25',
  },
  {
    command: 'commit',
    variant: 'dependent-change',
    intent: 'Apply one non-destructive multi-resource change with bindings.',
    invocation: 'outline commit --input -',
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
    verify: 'outline show CREATED_NODE_ID',
  },
  {
    command: 'diff',
    variant: 'reviewed-change',
    intent: 'Preview a ChangeSet and persist the immutable Diff for exact application.',
    invocation: 'outline diff --input - --output reviewed-diff.json',
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
    verify: 'outline show CREATED_SEARCH_ID --include view',
  },
  {
    command: 'capture add',
    variant: 'complete',
    intent: 'Create one provenanced capture tree below an exact destination.',
    invocation: 'outline capture add --input -',
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
    verify: 'outline show CREATED_NODE_ID',
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
