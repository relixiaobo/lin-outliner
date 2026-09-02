import Type, { type Static, type TSchema } from 'typebox';
import {
  AssetLeaseSchema,
  AssetRecordSchema,
  ChangeSetSchema,
  DiffSchema,
  EventSchema,
  ImportPlanResultSchema,
  ImportSourceProfileSchema,
  ImportVerifyResultSchema,
  WatchRequestSchema,
  OperationSchema,
  OperationUndoGroupSchema,
  NoChangeResultSchema,
  OutlineBatchCountResultSchema,
  OutlineCountResultSchema,
  OperationLogPageSchema,
  ProjectionResultSchema,
  ProjectionSchema,
  QueryExpressionSchema,
  RuntimeStatusSchema,
  SelectorSchema,
  TargetRefSchema,
  TargetSpecSchema,
  OneTargetRefSchema,
  ViewSummarySchema,
} from './schemas';
import {
  porcelainContract,
  porcelainHelpOptions,
  type CommandHelpContract,
  type CommandOptionHelp,
  type PorcelainContract,
} from './porcelain';
import { canonicalSha256 } from './canonical';
import { OUTLINE_RECIPES, OutlineRecipeSchema } from './recipes';
import { checkOutlineSchema } from './validation';
import { OUTLINE_QUERY_OPERATORS } from './queryOperators';
import { OUTLINE_PRIVATE_RUNTIME_CONTRACT_VERSION } from './version';

export type OutlineCapabilityKind = 'local' | 'read' | 'mutate' | 'observe' | 'asset';
export type OutlineReceiptFamily =
  | 'status'
  | 'capabilities'
  | 'schema'
  | 'recipe'
  | 'query'
  | 'projection'
  | 'view'
  | 'diff'
  | 'mutation'
  | 'mutation-or-diff'
  | 'history'
  | 'asset'
  | 'artifact'
  | 'import'
  | 'event';

export interface OutlineCapability<TRequest extends TSchema = TSchema, TResult extends TSchema = TSchema> {
  readonly name: string;
  readonly kind: OutlineCapabilityKind;
  readonly runtimeRequired: boolean;
  readonly streaming: boolean;
  readonly destructive: boolean;
  readonly auditCategory: string;
  readonly summary: string;
  readonly receipt: OutlineReceiptFamily;
  readonly requestSchema: TRequest;
  readonly resultSchema: TResult;
  readonly coverage: readonly string[];
  readonly help: CommandHelpContract;
  readonly porcelain?: PorcelainContract;
}

const closed = { additionalProperties: false } as const;
const EmptyInput = Type.Object({}, closed);
const EmptyResult = Type.Object({}, closed);
const ReadInput = Type.Union([
  Type.Object({ selector: SelectorSchema, projection: Type.Optional(ProjectionSchema) }, closed),
  Type.Object({ projection: ProjectionSchema }, closed),
]);
const FindProjectionInput = Type.Object({
  target: TargetSpecSchema,
  projection: Type.Optional(ProjectionSchema),
}, closed);
const FindCountInput = Type.Union([
  Type.Object({
    mode: Type.Literal('count'),
    query: QueryExpressionSchema,
    within: Type.Optional(SelectorSchema),
    includeTrash: Type.Optional(Type.Boolean()),
  }, closed),
  Type.Object({
    mode: Type.Literal('count'),
    searchId: Type.String({ minLength: 1, maxLength: 256 }),
  }, closed),
  Type.Object({
    mode: Type.Literal('count'),
    queries: Type.Array(Type.Object({
      name: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
      query: QueryExpressionSchema,
    }, closed), { minItems: 1, maxItems: 256 }),
    sharedQuery: Type.Optional(QueryExpressionSchema),
    within: Type.Optional(SelectorSchema),
    includeTrash: Type.Optional(Type.Boolean()),
  }, closed),
]);
const FindInput = Type.Union([FindProjectionInput, FindCountInput]);
const MutationInput = Type.Object({
  changeSet: ChangeSetSchema,
  preview: Type.Optional(Type.Boolean()),
  expectDiff: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  acknowledgeDestructive: Type.Optional(Type.Boolean()),
}, closed);
const MutationResult = Type.Union([DiffSchema, OperationSchema, NoChangeResultSchema]);
export const CreateResultSchema = Type.Object({
  kind: Type.Literal('outline.create-result'),
  status: Type.Literal('applied'),
  committed: Type.Literal(true),
  settlement: Type.Object({
    kind: Type.Literal('outline.operation-settlement'),
    operationId: Type.String({ minLength: 1, maxLength: 256 }),
    revisionBefore: Type.Integer({ minimum: 0 }),
    revisionAfter: Type.Integer({ minimum: 0 }),
    diffHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    affectedNodeCount: Type.Integer({ minimum: 0 }),
    affectedNodeIdsHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    recovery: OperationSchema.properties.recovery,
  }, closed),
  rootId: Type.String({ minLength: 1, maxLength: 256 }),
  nodeCount: Type.Integer({ minimum: 1 }),
  itemCount: Type.Integer({ minimum: 0 }),
  fieldCount: Type.Integer({ minimum: 0 }),
  definitions: Type.Object({
    created: Type.Integer({ minimum: 0 }),
    reused: Type.Integer({ minimum: 0 }),
  }, closed),
  view: Type.Object({
    mode: Type.Union([
      Type.Literal('outline'), Type.Literal('table'), Type.Literal('cards'), Type.Literal('calendar'),
    ]),
  }, closed),
  verification: Type.Object({
    passed: Type.Literal(true),
    revision: Type.Integer({ minimum: 0 }),
  }, closed),
  recoveryCommand: Type.String({ minLength: 1, maxLength: 1_024 }),
}, closed);
const CommitInput = Type.Object({
  changeSet: ChangeSetSchema,
  undoGroup: Type.Optional(OperationUndoGroupSchema),
}, closed);

function option(
  name: string,
  value: string | undefined,
  description: string,
  metadata: Partial<Pick<CommandOptionHelp, 'default' | 'repeatable'>> = {},
): CommandOptionHelp {
  return Object.freeze({ name, ...(value ? { value } : {}), description, ...metadata });
}

function fixedHelp(value: CommandHelpContract): CommandHelpContract {
  return Object.freeze({
    ...value,
    positionals: Object.freeze(value.positionals),
    options: Object.freeze(value.options),
    defaults: Object.freeze(value.defaults),
    examples: Object.freeze(value.examples),
  });
}

const selectorSyntax = 'Selectors accept exact IDs, ordered ID lists, typed IDs, @aliases, @date:YYYY-MM-DD, live Saved Searches, or structured Selector JSON where the command permits it.';
const projectionOutput = 'Returns a bounded Projection with revision and pagination metadata.';
const noDefaults = Object.freeze([]) as readonly string[];

export const OUTLINE_GLOBAL_OPTIONS = Object.freeze([
  option('json', undefined, 'Write stable machine-readable response envelopes; ignored by --help.'),
  option('protocol', 'MAJOR', 'Require one supported protocol major.', { default: '1' }),
  option('no-start', undefined, 'Fail if Runtime is not already running.'),
  option('startup-timeout', 'MS', 'Limit Runtime startup wait time.', { default: '10000' }),
  option('timeout', 'MS', 'Limit one Runtime request, transfer, or stream.', { default: '60000' }),
]);

export interface OutlineCommandFamily {
  readonly name: string;
  readonly summary: string;
}

export const OUTLINE_COMMAND_FAMILIES = Object.freeze([
  { name: 'asset', summary: 'Stage, inspect, and export retained assets.' },
  { name: 'capture', summary: 'Create provenanced capture trees.' },
  { name: 'daily', summary: 'Address and ensure local-date Daily Notes.' },
  { name: 'define', summary: 'Create, ensure, or edit reusable Field and Tag definitions.' },
  { name: 'import', summary: 'Inspect external sources and plan reviewed imports through normalized data.' },
  { name: 'replace', summary: 'Apply bounded, reviewed content transformations.' },
  { name: 'search', summary: 'Create, edit, and run Saved Searches.' },
  { name: 'template', summary: 'Preview and apply tag-template backfill.' },
  { name: 'view', summary: 'Read or set a projection over the same Nodes.' },
] satisfies readonly OutlineCommandFamily[]);

const READ_OPTIONS = Object.freeze([
  option('selector', 'FILE|-', 'Read a structured Selector instead of positional shorthand.'),
  option('limit', 'N', 'Bound returned Nodes.', { default: '100' }),
  option('cursor', 'CURSOR', 'Continue a bounded Projection page.'),
  option('kind', 'KIND', 'Select summary, node, outline, backlinks, view, or export Projection.'),
  option('depth', 'N', 'Bound descendant depth.'),
  option('include', 'LIST', 'Comma-separated description, children, tags, fields, references, media, view, trash, or backlinks.'),
  option('format', 'FORMAT', 'Select json, jsonl, markdown, or opml Projection format.'),
  option('projection', 'FILE|-', 'Read one complete structured Projection; cannot be mixed with leaf Projection options.'),
]);

const ImportInspectInput = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 32_768 }),
}, closed);
const ImportPlanInput = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 32_768 }),
  sourceFormat: Type.Optional(Type.Union([
    Type.Literal('auto'), Type.Literal('normalized'), Type.Literal('tana'),
  ])),
  fidelity: Type.Optional(Type.Union([
    Type.Literal('content'), Type.Literal('clean'), Type.Literal('full'),
  ])),
  mode: Type.Optional(Type.Union([Type.Literal('native_daily'), Type.Literal('stage')])),
  parent: Type.Optional(TargetRefSchema),
  output: Type.String({ minLength: 1, maxLength: 32_768 }),
  evidenceOutput: Type.String({ minLength: 1, maxLength: 32_768 }),
  changeSetOutput: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
  coverageOutput: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
  includeTrash: Type.Optional(Type.Boolean()),
}, closed);
const ImportVerifyInput = Type.Object({
  operationId: Type.String({ minLength: 1, maxLength: 256 }),
  evidence: Type.String({ minLength: 1, maxLength: 32_768 }),
  diff: Type.String({ minLength: 1, maxLength: 32_768 }),
}, closed);

const FIXED_COMMAND_HELP = Object.freeze({
  version: fixedHelp({ usage: 'version', summary: 'Print CLI, app, protocol, and storage versions.', behavior: 'metadata', idempotent: true, positionals: [], options: [], selectors: 'No selectors.', cardinality: 'Not applicable.', input: 'No input.', output: 'Writes version fields; summary output is one concise line.', defaults: noDefaults, destructive: false, examples: ['outline version', 'outline --json version'] }),
  status: fixedHelp({ usage: 'status', summary: 'Inspect Runtime presence and storage health without starting it.', behavior: 'read-only', idempotent: true, positionals: [], options: [], selectors: 'No selectors.', cardinality: 'Not applicable.', input: 'No input.', output: 'Returns Runtime, transaction-log, and recovery state.', defaults: noDefaults, destructive: false, examples: ['outline status', 'outline --json status'] }),
  capabilities: fixedHelp({ usage: 'capabilities [--runtime]', summary: 'Print the executable CLI registry and optionally verify Runtime parity.', behavior: 'metadata', idempotent: true, positionals: [], options: [option('runtime', undefined, 'Compare the bundled registry with the running Runtime without accepting drift.')], selectors: 'No selectors.', cardinality: 'Not applicable.', input: 'No structured input.', output: 'Returns command schemas plus help and completion metadata.', defaults: ['Without --runtime, reads only the bundled registry.'], destructive: false, examples: ['outline capabilities', 'outline --json capabilities --runtime'] }),
  example: fixedHelp({ usage: 'example COMMAND VARIANT', summary: 'Print one validated executable recipe for a structured CLI workflow.', behavior: 'metadata', idempotent: true, positionals: ['COMMAND and VARIANT select one registry-owned recipe.'], options: [], selectors: 'No selectors.', cardinality: 'Not applicable.', input: 'No input. The recipe contains literal stdin when required.', output: 'Returns bounded Command, Stdin, Result, and Review sections.', defaults: noDefaults, destructive: false, examples: ['outline example create collection', 'outline example find named-counts', 'outline --json example transact dependent-change'] }),
  schema: fixedHelp({ usage: 'schema [SCHEMA|COMMAND...] [--part request|result|both] [--path JSON_POINTER]', summary: 'List available schemas or print one exact bounded schema fragment.', behavior: 'metadata', idempotent: true, positionals: ['SCHEMA names a public schema; COMMAND may contain multiple command-path words.'], options: [option('part', 'PART', 'For a command, select its request, result, or both schemas.', { default: 'request' }), option('path', 'JSON_POINTER', 'Return only the selected JSON Schema fragment and its reachable definitions.')], selectors: 'No selectors.', cardinality: 'Not applicable.', input: 'Omit the name to list discoverable schema and command names. Name one schema or command to read it.', output: 'Returns a compact schema or one independently usable fragment. Command schema discovery returns the request contract by default.', defaults: ['Omitting the name returns names only, never every schema body.', 'Command schema part defaults to request.'], destructive: false, examples: ['outline schema create --path /properties/fields', 'outline schema QueryExpression', 'outline --json schema view set --part result'] }),
  find: fixedHelp({ usage: 'find [TEXT] [OPTIONS]', summary: 'Find or exactly count Nodes with text shorthand, live Saved Searches, or canonical queries.', behavior: 'read-only', idempotent: true, positionals: ['TEXT is ergonomic STRING_MATCH shorthand; use --query for one canonical query.'], options: [option('query', 'FILE|-', 'Read one canonical structured query.'), option('search', 'SEARCH_ID', 'Execute a Saved Search live without refreshing materialized children.'), option('count', undefined, 'Return an exact count without Node payloads.'), option('input', 'FILE|-', 'Read one complete find request, including named batch counts and an optional sharedQuery.'), option('within', 'FILE|-', 'Bound the query below one structured Selector.'), option('include-trash', undefined, 'Include trashed Nodes in transient query execution.'), option('order', 'ORDER', 'Use document, created, updated, or text order.', { default: 'document' }), ...READ_OPTIONS], selectors: selectorSyntax, cardinality: 'Node results use cardinality many with explicit --limit; count forms are exact and return no Nodes.', input: 'Use TEXT for common search, --query for one canonical query, --search for a live Saved Search, or --input alone for the exact command schema. Run outline schema QueryExpression for every executable structured operator.', output: 'Returns a bounded Projection, one exact count, or named exact batch counts. Batch sharedQuery is combined with every query using canonical AND.', defaults: ['Limit defaults to 100 for Node results.', 'Projection kind defaults to summary.'], destructive: false, examples: ['outline find "quarterly plan" --limit 20', 'outline find --search search:modules --count', 'outline find --input named-counts.json'] }),
  'search run': fixedHelp({ usage: 'search run SEARCH_ID [--limit N]', summary: 'Run one Saved Search live without mutating its Node children.', behavior: 'read-only', idempotent: true, positionals: ['SEARCH_ID identifies exactly one Saved Search Node.'], options: [option('limit', 'N', 'Bound returned matching Nodes.', { default: '100' })], selectors: 'The Saved Search owns the canonical query; matching Nodes remain ordinary Nodes.', cardinality: 'Returns at most --limit matching Nodes.', input: 'Accepts one exact Saved Search ID and an optional limit.', output: projectionOutput, defaults: ['Limit defaults to 100.', 'Projection kind is summary.'], destructive: false, examples: ['outline search run node:modules', 'outline search run node:modules --limit 20'] }),
  get: fixedHelp({ usage: 'get [SELECTOR...] [PROJECTION OPTIONS]', summary: 'Read one or more exact targets with a bounded Projection.', behavior: 'read-only', idempotent: true, positionals: ['Each optional SELECTOR is an exact ID, typed ID, @alias, or @date:YYYY-MM-DD; multiple positional values form one ordered ID selector. Omit SELECTOR when --projection declares targets.'], options: READ_OPTIONS, selectors: selectorSyntax, cardinality: 'One positional selector uses cardinality one; multiple exact IDs and structured query/search selectors use bounded many.', input: 'Use positional shorthand, --selector FILE|-, or one complete standalone --projection FILE|-. A separate Selector must match the Projection target exactly.', output: projectionOutput, defaults: ['Limit defaults to 100.', 'Projection kind defaults to node.'], destructive: false, examples: ['outline get node:project', 'outline get node:first node:second --include backlinks', 'outline get --projection node-with-backlinks.json'] }),
  'view get': fixedHelp({ usage: 'view get TARGET', summary: 'Read the effective View without returning item payloads.', behavior: 'read-only', idempotent: true, positionals: ['TARGET is one exact owner ID, typed ID, or semantic alias.'], options: [], selectors: selectorSyntax, cardinality: 'The owner target resolves exactly one live Node.', input: 'Accepts one positional exact target.', output: 'Returns one compact outline.view-summary with public mode, exact direct-item count, and ordered display metadata.', defaults: noDefaults, destructive: false, examples: ['outline view get node:project', 'outline --json view get @today'] }),
  export: fixedHelp({ usage: 'export [SELECTOR] [PROJECTION OPTIONS] [--output FILE|-]', summary: 'Export bounded targets as JSON, JSONL, Markdown, or OPML.', behavior: 'read-only stream', idempotent: true, positionals: ['Optional SELECTOR values are exact IDs, typed IDs, @aliases, or @date:YYYY-MM-DD. Omit SELECTOR when --projection declares targets.'], options: [...READ_OPTIONS, option('output', 'FILE|-', 'Write atomically to a file or stream raw records to stdout.')], selectors: selectorSyntax, cardinality: 'The Projection must remain bounded by target cardinality, page limit, and depth.', input: 'Use positional shorthand, --selector FILE|-, or one complete standalone --projection FILE|-. A separate Selector must match the Projection target exactly.', output: 'Streams the selected export format; file output is atomic and reports byte count plus SHA-256.', defaults: ['Format defaults to json.', 'Depth defaults to 1024 and includes all document resource fields.'], destructive: false, examples: ['outline export node:project --format markdown --output project.md', 'outline export @today --format jsonl --output -', 'outline export --projection complete-export.json --output export.json'] }),
  watch: fixedHelp({ usage: 'watch [--cursor CURSOR] [--filter FILE|-] [--projection FILE|-]', summary: 'Stream ordered, resumable Runtime events.', behavior: 'read-only stream', idempotent: true, positionals: [], options: [option('cursor', 'CURSOR', 'Resume after an emitted event cursor.'), option('filter', 'FILE|-', 'Read a structured EventFilter.'), option('projection', 'FILE|-', 'Attach one bounded Projection to matching events.')], selectors: 'Selectors appear only inside structured filter or Projection input.', cardinality: 'Any attached Projection must declare bounded target cardinality.', input: 'Filter and Projection use canonical JSON from a file or stdin.', output: 'Streams ordered event records and resumable cursors until interrupted.', defaults: ['Without a cursor, starts at the current live boundary.'], destructive: false, examples: ['outline watch', 'outline --json watch --cursor CURSOR --filter events.json'] }),
  preview: fixedHelp({ usage: 'preview --input FILE|- [--input-format json|jsonl] [--output FILE|-] [--idempotency-key KEY]', summary: 'Normalize and preview one complete transaction without writing.', behavior: 'preview', idempotent: true, positionals: [], options: [option('input', 'FILE|-', 'Read one transaction artifact.'), option('input-format', 'json|jsonl', 'Select canonical transaction encoding.', { default: 'json' }), option('output', 'FILE|-', 'Write the reviewed Diff atomically or stream it.'), option('idempotency-key', 'KEY', 'Bind retries to one settled result.')], selectors: 'Selectors and bindings are declared inside the transaction.', cardinality: 'Every mutating selector declares one, zero-or-one, or many; many requires max.', input: 'Accepts one canonical transaction, including dependent resources and bindings.', output: 'Returns one immutable normalized Diff with diffHash, affected count, warnings, and recovery estimate.', defaults: ['Input format defaults to json.', 'Diffs above 8 MiB require --output.'], destructive: false, examples: ['outline preview --input transaction.json', 'outline preview --input transaction.jsonl --input-format jsonl --output reviewed-diff.json'] }),
  transact: fixedHelp({ usage: 'transact --input FILE|- [--idempotency-key KEY]', summary: 'Apply one non-destructive multi-resource transaction atomically.', behavior: 'direct apply', idempotent: true, positionals: [], options: [option('input', 'FILE|-', 'Read one transaction artifact.'), option('input-format', 'json', 'Transaction artifacts use JSON.', { default: 'json' }), option('idempotency-key', 'KEY', 'Bind retries to one settled result.')], selectors: 'Selectors and bindings are declared inside the transaction.', cardinality: 'Every mutating selector declares one, zero-or-one, or many; many requires max.', input: 'Accepts one canonical non-destructive transaction. Destructive changes must use outline preview followed by outline apply.', output: 'Returns one Operation or semantic no-change result with affected count and recovery state.', defaults: ['Input format is json.', 'The CLI generates an idempotency key when omitted.'], destructive: false, examples: ['outline transact --input transaction.json', 'outline --json transact --input transaction.json --idempotency-key cli:transact-example'] }),
  apply: fixedHelp({ usage: 'apply --input DIFF_FILE|- [--yes]', summary: 'Apply one exact reviewed Diff atomically.', behavior: 'exact apply', idempotent: true, positionals: [], options: [option('input', 'FILE|-', 'Read the exact Diff returned by outline preview.'), option('input-format', 'json', 'Diff artifacts use JSON.', { default: 'json' }), option('yes', undefined, 'Acknowledge a destructive reviewed Diff; never substitutes for preview/review.')], selectors: 'Target resolution is frozen in the reviewed Diff.', cardinality: 'Affected targets are exactly those recorded in the Diff.', input: 'Accepts one exact Diff artifact; create it with outline preview and do not reconstruct it.', output: 'Returns one Operation or semantic no-change result with affected count and recovery state.', defaults: ['Input format is json.'], destructive: false, examples: ['outline apply --input reviewed-diff.json', 'outline apply --input destructive-diff.json --yes'] }),
  history: fixedHelp({ usage: 'history [FILTER OPTIONS]', summary: 'Read paginated durable Operation history.', behavior: 'read-only', idempotent: true, positionals: [], options: [option('limit', 'N', 'Bound returned Operations.', { default: '100' }), option('cursor', 'CURSOR', 'Continue one history page.'), option('operation', 'ID', 'Select one Operation ID.'), option('idempotency-key', 'KEY', 'Select by idempotency key.'), option('node', 'ID', 'Select Operations affecting one Node.'), option('origin', 'ORIGIN', 'Filter by operation origin.'), option('thread', 'ID', 'Filter by Agent Thread.'), option('turn', 'ID', 'Filter by Agent Turn.'), option('item', 'ID', 'Filter by Agent Item.')], selectors: 'History filters use stable IDs, not display-text selection.', cardinality: 'Returns at most --limit Operations and an optional cursor.', input: 'All filters are argv options.', output: 'Returns Operation summaries, recovery state, and an optional cursor.', defaults: ['Limit defaults to the Runtime page default.'], destructive: false, examples: ['outline history --operation operation:example', 'outline history --node node:project --limit 20', 'outline history --idempotency-key import:2026-08-24'] }),
  revert: fixedHelp({ usage: 'revert OPERATION_ID [--idempotency-key KEY]', summary: 'Guard and exactly revert one retained Operation.', behavior: 'recovery mutation', idempotent: true, positionals: ['OPERATION_ID is the visible ID returned by the original mutation.'], options: [option('idempotency-key', 'KEY', 'Bind recovery and retries to one settled revert.')], selectors: 'The Operation fixes the affected target set.', cardinality: 'Reverts exactly one retained Operation as one new Operation.', input: 'Accepts one Operation ID.', output: 'Returns the revert Operation with affected count and recovery state; conflicts do not write.', defaults: ['The CLI generates a recovery key when omitted.'], destructive: false, examples: ['outline revert operation:example', 'outline --json revert operation:example --idempotency-key cli:revert-example'] }),
  undo: fixedHelp({ usage: 'undo [--origin ORIGIN] [--expect-operation ID] [--idempotency-key KEY]', summary: 'Revert the latest applicable Operation in one origin scope.', behavior: 'recovery mutation', idempotent: true, positionals: [], options: [option('origin', 'ORIGIN', 'Select own, all, desktop, local-user, built-in-agent, or external-client.', { default: 'own' }), option('expect-operation', 'ID', 'Require this Operation to remain at the selected stack top.'), option('idempotency-key', 'KEY', 'Bind recovery and retries to one settled undo.')], selectors: 'The selected origin stack and optional Operation guard fix the target set.', cardinality: 'Reverts at most one Operation.', input: 'No positional input.', output: 'Returns one revert Operation.', defaults: ['Origin defaults to the authenticated caller origin.', 'The CLI generates a recovery key when omitted.'], destructive: false, examples: ['outline undo', 'outline undo --origin built-in-agent --expect-operation operation:example', 'outline --json undo --idempotency-key cli:undo-example'] }),
  redo: fixedHelp({ usage: 'redo [--origin ORIGIN] [--expect-operation ID] [--idempotency-key KEY]', summary: 'Revert the latest applicable revert Operation in one origin scope.', behavior: 'recovery mutation', idempotent: true, positionals: [], options: [option('origin', 'ORIGIN', 'Select own, all, desktop, local-user, built-in-agent, or external-client.', { default: 'own' }), option('expect-operation', 'ID', 'Require this revert Operation to remain at the selected stack top.'), option('idempotency-key', 'KEY', 'Bind recovery and retries to one settled redo.')], selectors: 'The selected origin stack and optional Operation guard fix the target set.', cardinality: 'Reapplies at most one Operation.', input: 'No positional input.', output: 'Returns one redo Operation.', defaults: ['Origin defaults to the authenticated caller origin.', 'The CLI generates a recovery key when omitted.'], destructive: false, examples: ['outline redo', 'outline redo --origin built-in-agent --expect-operation operation:example', 'outline --json redo --idempotency-key cli:redo-example'] }),
  'asset ingest': fixedHelp({ usage: 'asset ingest PATH|-', summary: 'Stage verified asset bytes under a recovery-aware lease.', behavior: 'asset staging', idempotent: false, positionals: ['PATH reads one local file; - streams bytes from stdin.'], options: [], selectors: 'No Node selector; staging does not create an Outline Node.', cardinality: 'Stages exactly one asset lease.', input: 'Reads bytes from PATH or stdin.', output: 'Returns one AssetLease for later reviewed automation.', defaults: noDefaults, destructive: false, examples: ['outline asset ingest ./diagram.png', 'outline asset ingest - < attachment.pdf'] }),
  'asset get': fixedHelp({ usage: 'asset get ASSET_ID', summary: 'Read logical asset metadata.', behavior: 'read-only', idempotent: true, positionals: ['ASSET_ID is one retained AssetRecord ID.'], options: [], selectors: 'Uses one exact AssetRecord ID.', cardinality: 'Returns exactly one AssetRecord.', input: 'Accepts one AssetRecord ID.', output: 'Returns logical metadata and retention state, never asset bytes.', defaults: noDefaults, destructive: false, examples: ['outline asset get asset:example', 'outline --json asset get asset:example'] }),
  'asset export': fixedHelp({ usage: 'asset export ASSET_ID --output FILE|-', summary: 'Stream verified asset bytes.', behavior: 'read-only stream', idempotent: true, positionals: ['ASSET_ID is one retained AssetRecord ID.'], options: [option('output', 'FILE|-', 'Write atomically to a file or stream raw bytes to stdout.')], selectors: 'Uses one exact AssetRecord ID.', cardinality: 'Exports exactly one retained asset.', input: 'Accepts one AssetRecord ID and required output destination.', output: 'Writes verified bytes; file output reports only its destination and byte count.', defaults: noDefaults, destructive: false, examples: ['outline asset export asset:example --output ./diagram.png', 'outline asset export asset:example --output - > diagram.png'] }),
  'import inspect': fixedHelp({ usage: 'import inspect SOURCE', summary: 'Return a bounded profile of one external source without writing.', behavior: 'read-only local inspection', idempotent: true, positionals: ['SOURCE is one readable local file or directory.'], options: [], selectors: 'No document selector is used.', cardinality: 'Inspects exactly one source and returns bounded samples.', input: 'Reads source metadata and bounded structural samples; it never loads records into Runtime.', output: 'Returns an exact ImportSourceProfile. Known profiles include normalized, Tana, Roam EDN, directory, and unknown.', defaults: noDefaults, destructive: false, examples: ['outline import inspect ./export.json', 'outline --json import inspect ./notes-directory'] }),
  'import plan': fixedHelp({ usage: 'import plan SOURCE --output DIFF --evidence-output EVIDENCE [OPTIONS]', summary: 'Normalize one external source and produce one reviewed import Diff.', behavior: 'preview', idempotent: true, positionals: ['SOURCE is normalized import v1 or a source supported by a bundled adapter.'], options: [option('format', 'auto|normalized|tana', 'Select normalized input or one bundled cleanup adapter.', { default: 'auto' }), option('fidelity', 'content|clean|full', 'Select adapter fidelity.', { default: 'clean' }), option('mode', 'native_daily|stage', 'Import valid dates natively or place everything below one staging root.'), option('parent', 'PARENT', 'Exact destination ID, semantic alias, or structured target.', { default: '@library' }), option('output', 'FILE', 'Write the immutable reviewed Diff.'), option('evidence-output', 'FILE', 'Write source, coverage, warning, and ChangeSet evidence.'), option('changeset-output', 'FILE', 'Optionally retain the generated generic ChangeSet.'), option('coverage-output', 'FILE', 'Optionally retain source-record coverage from a bundled adapter.'), option('include-trash', undefined, 'Allow a bundled adapter to include source Trash records.')], selectors: 'PARENT accepts one exact Node ID, typed ID, semantic @alias, or structured TargetRef JSON.', cardinality: 'One source produces one ChangeSet and one Diff regardless of record or date count.', input: 'Use --format normalized for output from a bundled or Agent-authored cleanup script. Inspect NormalizedImport with outline schema NormalizedImport. SOURCE and every output artifact must use distinct paths.', output: 'Writes one exact Diff and evidence, then returns hashes, affected count, coverage, dates, and artifact paths. It does not mutate the document.', defaults: ['Format defaults to auto.', 'Fidelity defaults to clean.', 'Mode follows normalized date grouping; destination defaults to @library.'], destructive: false, examples: ['outline import plan cleaned.json --format normalized --output import.diff.json --evidence-output import.evidence.json', 'outline import plan tana-export.json --format tana --fidelity full --output import.diff.json --evidence-output import.evidence.json', 'outline apply --input import.diff.json'] }),
  'import verify': fixedHelp({ usage: 'import verify OPERATION_ID --diff DIFF --evidence EVIDENCE', summary: 'Verify one import Operation against its reviewed Diff and evidence.', behavior: 'read-only verification', idempotent: true, positionals: ['OPERATION_ID is the visible ID returned by outline apply.'], options: [option('diff', 'FILE', 'Read the exact applied Diff.'), option('evidence', 'FILE', 'Read the evidence emitted by import plan.')], selectors: 'Verification reads only the exact bindings and representative targets recorded in evidence.', cardinality: 'Verifies one Operation and at most eight representative roots.', input: 'Accepts one Operation ID plus its exact Diff and evidence artifacts.', output: 'Returns settlement checks and independent bounded read results; mismatch never writes or retries.', defaults: noDefaults, destructive: false, examples: ['outline import verify operation:example --diff import.diff.json --evidence import.evidence.json', 'outline revert operation:example'] }),
} satisfies Record<string, CommandHelpContract>);

function capability<TRequest extends TSchema, TResult extends TSchema>(
  value: Omit<OutlineCapability<TRequest, TResult>, 'help' | 'receipt'> & { readonly receipt?: OutlineReceiptFamily },
): OutlineCapability<TRequest, TResult> {
  const help = value.porcelain ?? FIXED_COMMAND_HELP[value.name as keyof typeof FIXED_COMMAND_HELP];
  if (!help) throw new Error(`Missing CLI help contract for capability: ${value.name}`);
  return Object.freeze({ ...value, receipt: value.receipt ?? receiptForCapability(value.name), help });
}

function receiptForCapability(name: string): OutlineReceiptFamily {
  if (name === 'version' || name === 'status') return 'status';
  if (name === 'capabilities') return 'capabilities';
  if (name === 'schema') return 'schema';
  if (name === 'example') return 'recipe';
  if (name === 'find') return 'query';
  if (name === 'get' || name === 'search run') return 'projection';
  if (name === 'view get') return 'view';
  if (name === 'preview') return 'diff';
  if (name === 'history') return 'history';
  if (name.startsWith('asset ')) return name === 'asset export' ? 'artifact' : 'asset';
  if (name.startsWith('import ')) return 'import';
  if (name === 'export') return 'artifact';
  if (name === 'watch') return 'event';
  return name === 'transact' || name === 'apply' || ['revert', 'undo', 'redo'].includes(name)
    ? 'mutation'
    : 'mutation-or-diff';
}

function historySelectionSchema() {
  return Type.Object({
    origin: Type.Optional(Type.Union([
      Type.Literal('own'), Type.Literal('all'), OperationSchema.properties.origin,
    ])),
    expectOperationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  }, closed);
}

const FIXED_CAPABILITIES = [
  capability({ name: 'version', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print CLI, app, and protocol versions.', requestSchema: EmptyInput, resultSchema: Type.Object({ cliVersion: Type.String(), appVersion: Type.String(), protocolMajors: Type.Array(Type.Integer()), storageVersion: Type.Integer() }, closed), coverage: [] }),
  capability({ name: 'status', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Inspect Runtime presence and storage health without starting it.', requestSchema: EmptyInput, resultSchema: RuntimeStatusSchema, coverage: [] }),
  capability({ name: 'capabilities', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print the executable public capability registry.', requestSchema: Type.Object({ runtime: Type.Optional(Type.Boolean()) }, closed), resultSchema: Type.Array(Type.Unknown()), coverage: [] }),
  capability({ name: 'example', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print one validated executable structured-workflow recipe.', requestSchema: Type.Object({ command: Type.String({ minLength: 1, maxLength: 128 }), variant: Type.String({ minLength: 1, maxLength: 64 }) }, closed), resultSchema: OutlineRecipeSchema, coverage: [] }),
  capability({ name: 'schema', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'List available schemas or print one exact bounded schema fragment.', requestSchema: Type.Object({ name: Type.Optional(Type.String()), part: Type.Optional(Type.Union([Type.Literal('request'), Type.Literal('result'), Type.Literal('both')])), path: Type.Optional(Type.String({ pattern: '^(/(?:[^/~]|~[01])*)*$' })) }, closed), resultSchema: Type.Unknown(), coverage: [] }),
  capability({ name: 'find', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.search', summary: 'Find or exactly count Nodes with canonical queries or live Saved Searches.', requestSchema: FindInput, resultSchema: Type.Union([ProjectionResultSchema, OutlineCountResultSchema, OutlineBatchCountResultSchema]), coverage: ['search_nodes'] }),
  capability({ name: 'get', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.node', summary: 'Read deterministic targets with a bounded Projection.', requestSchema: ReadInput, resultSchema: ProjectionResultSchema, coverage: ['get_projection', 'backlinks'] }),
  capability({ name: 'view get', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.view', summary: 'Read one effective View without returning item payloads.', requestSchema: Type.Object({ target: OneTargetRefSchema }, closed), resultSchema: ViewSummarySchema, coverage: [] }),
  capability({ name: 'search run', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.search', summary: 'Run one Saved Search live without mutating materialized children.', requestSchema: Type.Object({ searchId: Type.String({ minLength: 1, maxLength: 256 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })) }, closed), resultSchema: ProjectionResultSchema, coverage: ['refresh_search_node_results'] }),
  capability({ name: 'export', kind: 'read', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'read.export', summary: 'Export bounded targets as JSON, JSONL, Markdown, or OPML.', requestSchema: ReadInput, resultSchema: Type.Unknown(), coverage: [] }),
  capability({ name: 'watch', kind: 'observe', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'observe', summary: 'Stream ordered resumable Runtime events.', requestSchema: WatchRequestSchema, resultSchema: EventSchema, coverage: ['document_events'] }),
  capability({ name: 'preview', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'mutation.preview', summary: 'Normalize and preview a transaction without writing.', requestSchema: Type.Object({ changeSet: ChangeSetSchema }, closed), resultSchema: DiffSchema, coverage: [] }),
  capability({ name: 'transact', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'mutation.transact', summary: 'Apply one non-destructive multi-resource transaction atomically.', requestSchema: CommitInput, resultSchema: Type.Union([OperationSchema, NoChangeResultSchema]), coverage: [] }),
  capability({ name: 'apply', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'mutation.apply', summary: 'Apply one exact reviewed Diff atomically.', requestSchema: Type.Object({ diff: DiffSchema, acknowledgeDestructive: Type.Optional(Type.Boolean()) }, closed), resultSchema: Type.Union([OperationSchema, NoChangeResultSchema]), coverage: [] }),
  capability({ name: 'history', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.read', summary: 'Read paginated durable Operation history.', requestSchema: Type.Object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })), operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), nodeId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), origin: Type.Optional(OperationSchema.properties.origin), threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), itemId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, closed), resultSchema: OperationLogPageSchema, coverage: ['operation_history'] }),
  capability({ name: 'revert', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.revert', summary: 'Guard and exactly revert a retained Operation.', requestSchema: Type.Object({ operationId: Type.String({ minLength: 1 }), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, closed), resultSchema: OperationSchema, coverage: [] }),
  capability({ name: 'undo', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.undo', summary: 'Revert the latest applicable Operation in one origin scope.', requestSchema: historySelectionSchema(), resultSchema: OperationSchema, coverage: ['undo'] }),
  capability({ name: 'redo', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.redo', summary: 'Revert the latest applicable revert Operation in one origin scope.', requestSchema: historySelectionSchema(), resultSchema: OperationSchema, coverage: ['redo'] }),
  capability({ name: 'asset ingest', kind: 'asset', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'asset.ingest', summary: 'Stage verified asset bytes under a recovery-aware lease.', requestSchema: Type.Union([
    Type.Object({ source: Type.Literal('path'), path: Type.String({ minLength: 1, maxLength: 32_768 }) }, closed),
    Type.Object({ source: Type.Literal('stdin') }, closed),
    Type.Object({
      source: Type.Literal('bytes'),
      data: Type.String({ minLength: 1, maxLength: 139_810_136 }),
      mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      originalFilename: Type.Optional(Type.String({ maxLength: 4_096 })),
    }, closed),
  ]), resultSchema: AssetLeaseSchema, coverage: ['ingest_asset', 'ingest_local_file', 'ingest_thread_resource'] }),
  capability({ name: 'asset get', kind: 'asset', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'asset.read', summary: 'Read logical asset metadata.', requestSchema: Type.Object({ assetId: Type.String({ minLength: 1 }) }, closed), resultSchema: AssetRecordSchema, coverage: ['lookup_asset'] }),
  capability({ name: 'asset export', kind: 'asset', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'asset.export', summary: 'Stream verified asset bytes.', requestSchema: Type.Object({ assetId: Type.String({ minLength: 1 }) }, closed), resultSchema: Type.Unknown(), coverage: [] }),
  capability({ name: 'import inspect', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'import.inspect', summary: 'Return a bounded profile of one external source without writing.', requestSchema: ImportInspectInput, resultSchema: ImportSourceProfileSchema, coverage: [] }),
  capability({ name: 'import plan', kind: 'local', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'import.plan', summary: 'Normalize one external source and produce one reviewed import Diff.', requestSchema: ImportPlanInput, resultSchema: ImportPlanResultSchema, coverage: [] }),
  capability({ name: 'import verify', kind: 'local', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'import.verify', summary: 'Verify one import Operation against its reviewed Diff and evidence.', requestSchema: ImportVerifyInput, resultSchema: ImportVerifyResultSchema, coverage: [] }),
] as const;

const PORCELAIN_COMMANDS = [
  ['create', 'structure.create', [
    'create_node', 'create_rich_text_node', 'create_tagged_node', 'create_tag_and_tagged_node',
    'create_nodes_from_tree', 'paste_nodes_into_node', 'split_node',
  ]],
  ['edit', 'content.update', [
    'apply_node_text_patch', 'update_node_description', 'set_node_checkbox_visible',
    'toggle_done', 'batch_toggle_done', 'set_code_block', 'set_code_language',
    'set_node_icon', 'set_node_banner', 'apply_tag', 'batch_apply_tag', 'remove_tag',
    'update_field_slot', 'set_field_free_text_value', 'clear_field_value',
    'remove_field_value', 'register_collected_option', 'create_collected_field_option',
    'select_field_option', 'add_reference', 'add_reference_conversion', 'set_reference_target',
    'replace_node_with_reference', 'replace_node_with_reference_conversion',
    'replace_node_with_inline_reference', 'convert_reference_to_inline_node',
    'restore_inline_reference_node_to_reference', 'add_source', 'replace_source',
    'reorder_source', 'remove_source', 'clear_sources', 'cycle_done_state',
    'batch_cycle_done_state', 'reuse_field_definition',
  ]],
  ['replace text', 'content.replace', []],
  ['move', 'structure.move', [
    'move_node', 'batch_move_nodes', 'batch_move_nodes_up', 'batch_move_nodes_down',
    'indent_node', 'outdent_node', 'batch_indent_nodes', 'batch_outdent_nodes',
  ]],
  ['duplicate', 'structure.duplicate', ['batch_duplicate_nodes']],
  ['merge', 'structure.merge', ['merge_node_into', 'merge_definitions']],
  ['define create', 'definition.create', [
    'create_tag', 'create_field_definition', 'create_field_def',
    'create_inline_field_after_node', 'create_inline_field',
  ]],
  ['define ensure', 'definition.ensure', []],
  ['define edit', 'definition.edit', ['set_tag_config', 'set_field_config']],
  ['view set', 'view.set', [
    'set_view_toolbar_visible', 'set_view_mode', 'set_group_field',
    'add_sort_rule', 'update_sort_rule', 'remove_sort_rule', 'clear_sort_rules',
    'add_filter_rule', 'update_filter_rule', 'remove_filter_rule', 'clear_filter_rules',
    'add_display_field', 'update_display_field', 'remove_display_field',
  ]],
  ['search create', 'search.create', ['create_search_node', 'ensure_tag_search']],
  ['search edit', 'search.edit', ['set_search_node', 'set_search_query_outline']],
  ['template apply', 'template.apply', ['preview_tag_template_backfill', 'apply_template_to_tagged_nodes']],
  ['daily ensure', 'daily.ensure', ['ensure_date_node']],
  ['capture create', 'capture.create', ['create_capture']],
  ['trash', 'lifecycle.trash', ['trash_node', 'batch_trash_nodes']],
  ['restore', 'lifecycle.restore', ['restore_node']],
  ['purge', 'lifecycle.purge', ['delete_node']],
] as const;

const PORCELAIN_CAPABILITIES = PORCELAIN_COMMANDS.map(([name, auditCategory, coverage]) => capability({
  name,
  kind: 'mutate',
  runtimeRequired: true,
  streaming: false,
  destructive: porcelainContract(name)!.destructive,
  auditCategory,
  summary: porcelainContract(name)!.summary,
  requestSchema: MutationInput,
  resultSchema: name === 'create' ? Type.Union([DiffSchema, CreateResultSchema]) : MutationResult,
  coverage,
  porcelain: porcelainContract(name)!,
}));

export const OUTLINE_CAPABILITIES = Object.freeze([
  ...FIXED_CAPABILITIES,
  ...PORCELAIN_CAPABILITIES,
]);

const capabilityByName = new Map(OUTLINE_CAPABILITIES.map((entry) => [entry.name, entry]));

for (const recipe of OUTLINE_RECIPES) {
  if (!checkOutlineSchema(OutlineRecipeSchema, recipe as unknown)) {
    throw new Error(`Invalid Outline recipe contract: ${recipe.command} ${recipe.variant}`);
  }
  const capability = capabilityByName.get(recipe.command);
  if (!capability) throw new Error(`Outline recipe references unknown command: ${recipe.command}`);
  if (!recipe.invocation.startsWith(`outline ${recipe.command}`)) {
    throw new Error(`Outline recipe invocation does not match its command: ${recipe.command} ${recipe.variant}`);
  }
  if (recipe.stdin !== undefined) {
    let payload: unknown;
    try {
      payload = JSON.parse(recipe.stdin) as unknown;
    } catch {
      throw new Error(`Outline recipe stdin is not JSON: ${recipe.command} ${recipe.variant}`);
    }
    const schema = recipe.command === 'preview' || recipe.command === 'transact'
      ? ChangeSetSchema
      : capability.porcelain?.inputSchema ?? capability.requestSchema;
    if (!checkOutlineSchema(schema, payload)) {
      throw new Error(`Outline recipe stdin does not match its command: ${recipe.command} ${recipe.variant}`);
    }
  }
}

export function outlineCapability(name: string): OutlineCapability | undefined {
  return capabilityByName.get(name);
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const compactedSchemaCache = new WeakMap<object, TSchema>();

export function compactOutlineSchema(schema: TSchema): TSchema {
  const cachedSchema = compactedSchemaCache.get(schema);
  if (cachedSchema) return cachedSchema;
  const definitions = new Map<string, unknown>();
  const definitionSources = new Map<string, object>();
  const transformed = new WeakMap<object, unknown>();
  const sourceDigests = new WeakMap<object, string>();

  const sourceDigest = (value: object): string => {
    const existing = sourceDigests.get(value);
    if (existing) return existing;
    const digest = canonicalSha256(value);
    sourceDigests.set(value, digest);
    return digest;
  };

  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const cached = transformed.get(value);
    if (cached) return cached;
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      transformed.set(value, result);
      result.push(...value.map(visit));
      return result;
    }

    const record = value as Record<string, unknown>;
    const nestedDefinitions = record.$defs;
    const reference = record.$ref;
    if (isSchemaRecord(nestedDefinitions)
      && typeof reference === 'string'
      && Object.hasOwn(nestedDefinitions, reference)) {
      const result: Record<string, unknown> = {};
      transformed.set(value, result);
      for (const [key, entry] of Object.entries(record)) {
        if (key !== '$defs') result[key] = visit(entry);
      }
      for (const [name, definition] of Object.entries(nestedDefinitions)) {
        if (!definition || typeof definition !== 'object') {
          throw new Error(`Invalid cyclic schema definition: ${name}`);
        }
        const existingSource = definitionSources.get(name);
        if (existingSource && existingSource !== definition
          && sourceDigest(existingSource) !== sourceDigest(definition)) {
          throw new Error(`Conflicting cyclic schema definition: ${name}`);
        }
        if (!existingSource) {
          definitionSources.set(name, definition);
          definitions.set(name, visit(definition));
        }
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    transformed.set(value, result);
    for (const [key, entry] of Object.entries(record)) result[key] = visit(entry);
    return result;
  };

  const root = visit(schema) as Record<string, unknown>;
  const compacted = definitions.size === 0 ? root as TSchema : {
    ...root,
    $defs: Object.fromEntries(definitions),
  } as TSchema;
  compactedSchemaCache.set(schema, compacted);
  return compacted;
}

export function outlineCapabilityManifest() {
  return OUTLINE_CAPABILITIES.map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    runtimeRequired: entry.runtimeRequired,
    streaming: entry.streaming,
    destructive: entry.destructive,
    auditCategory: entry.auditCategory,
    summary: entry.summary,
    receipt: entry.receipt,
    coverage: [...entry.coverage],
    requestSchema: compactOutlineSchema(entry.porcelain?.inputSchema ?? entry.requestSchema),
    resultSchema: compactOutlineSchema(entry.resultSchema),
    help: {
      ...entry.help,
      options: entry.porcelain ? porcelainHelpOptions(entry.porcelain) : entry.help.options,
    },
    completion: {
      command: entry.name,
      positionals: entry.help.positionals,
      options: (entry.porcelain ? porcelainHelpOptions(entry.porcelain) : entry.help.options)
        .map((option) => ({ name: option.name, ...(option.value ? { value: option.value } : {}) })),
      ...(QUERY_INPUT_COMMANDS.has(entry.name) ? {
        queryOperators: OUTLINE_QUERY_OPERATORS.map((operator) => ({
          name: operator.name,
          summary: operator.summary,
        })),
      } : {}),
    },
    ...(entry.porcelain ? {
      inputSchema: compactOutlineSchema(entry.porcelain.inputSchema),
      runtimeRequestSchema: compactOutlineSchema(entry.requestSchema),
    } : {}),
  }));
}

const QUERY_INPUT_COMMANDS = new Set(['find', 'replace text', 'search create', 'search edit']);

let capabilityContractDigest: string | undefined;

export function outlineCapabilityContractDigest(): string {
  capabilityContractDigest ??= canonicalSha256({
    capabilities: outlineCapabilityManifest(),
    privateRuntimeContractVersion: OUTLINE_PRIVATE_RUNTIME_CONTRACT_VERSION,
  });
  return capabilityContractDigest;
}

export type OutlineCapabilityRequest<Name extends string> = Static<
  Extract<(typeof OUTLINE_CAPABILITIES)[number], { name: Name }>['requestSchema']
>;
