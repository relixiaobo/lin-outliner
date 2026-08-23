import Type, { type Static, type TSchema } from 'typebox';
import {
  AssetLeaseSchema,
  ChangeSetSchema,
  DiffSchema,
  EventSchema,
  WatchRequestSchema,
  OperationSchema,
  ProjectionResultSchema,
  ProjectionSchema,
  SelectorSchema,
  TargetSpecSchema,
} from './schemas';

export type OutlineCapabilityKind = 'local' | 'read' | 'mutate' | 'observe' | 'asset';

export interface OutlineCapability<TRequest extends TSchema = TSchema, TResult extends TSchema = TSchema> {
  readonly name: string;
  readonly kind: OutlineCapabilityKind;
  readonly runtimeRequired: boolean;
  readonly streaming: boolean;
  readonly destructive: boolean;
  readonly auditCategory: string;
  readonly summary: string;
  readonly requestSchema: TRequest;
  readonly resultSchema: TResult;
  readonly coverage: readonly string[];
}

const closed = { additionalProperties: false } as const;
const EmptyInput = Type.Object({}, closed);
const EmptyResult = Type.Object({}, closed);
const SelectorInput = Type.Object({ selector: SelectorSchema, projection: Type.Optional(ProjectionSchema) }, closed);
const MutationInput = Type.Object({
  changeSet: ChangeSetSchema,
  preview: Type.Optional(Type.Boolean()),
  expectDiff: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  acknowledgeDestructive: Type.Optional(Type.Boolean()),
}, closed);
const MutationResult = Type.Union([DiffSchema, OperationSchema]);

function capability<TRequest extends TSchema, TResult extends TSchema>(
  value: OutlineCapability<TRequest, TResult>,
): OutlineCapability<TRequest, TResult> {
  return Object.freeze(value);
}

const FIXED_CAPABILITIES = [
  capability({ name: 'version', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print CLI, app, and protocol versions.', requestSchema: EmptyInput, resultSchema: Type.Object({ cliVersion: Type.String(), appVersion: Type.String(), protocolMajors: Type.Array(Type.Integer()), storageVersion: Type.Integer() }, closed), coverage: [] }),
  capability({ name: 'status', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Inspect Runtime presence and storage health without starting it.', requestSchema: EmptyInput, resultSchema: Type.Object({ running: Type.Boolean(), runtime: Type.Optional(Type.Unknown()) }, closed), coverage: [] }),
  capability({ name: 'capabilities', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print the executable public capability registry.', requestSchema: Type.Object({ runtime: Type.Optional(Type.Boolean()) }, closed), resultSchema: Type.Array(Type.Unknown()), coverage: [] }),
  capability({ name: 'schema', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print exact public JSON Schemas.', requestSchema: Type.Object({ name: Type.Optional(Type.String()) }, closed), resultSchema: Type.Unknown(), coverage: [] }),
  capability({ name: 'find', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.search', summary: 'Find bounded Nodes with the structured query grammar.', requestSchema: Type.Object({ target: TargetSpecSchema, projection: Type.Optional(ProjectionSchema) }, closed), resultSchema: ProjectionResultSchema, coverage: ['search_nodes'] }),
  capability({ name: 'show', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.node', summary: 'Read one deterministic target with a bounded Projection.', requestSchema: SelectorInput, resultSchema: ProjectionResultSchema, coverage: ['get_projection', 'backlinks'] }),
  capability({ name: 'export', kind: 'read', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'read.export', summary: 'Export a bounded target as JSON, JSONL, Markdown, or OPML.', requestSchema: SelectorInput, resultSchema: Type.Unknown(), coverage: ['get_projection'] }),
  capability({ name: 'watch', kind: 'observe', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'observe', summary: 'Stream ordered resumable Runtime events.', requestSchema: WatchRequestSchema, resultSchema: EventSchema, coverage: ['document_events'] }),
  capability({ name: 'diff', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'mutation.preview', summary: 'Normalize and preview a ChangeSet without writing.', requestSchema: Type.Object({ changeSet: ChangeSetSchema }, closed), resultSchema: DiffSchema, coverage: [] }),
  capability({ name: 'apply', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'mutation.apply', summary: 'Apply one exact reviewed Diff atomically.', requestSchema: Type.Object({ diff: DiffSchema, acknowledgeDestructive: Type.Optional(Type.Boolean()) }, closed), resultSchema: OperationSchema, coverage: [] }),
  capability({ name: 'log', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.read', summary: 'Read paginated durable Operation history.', requestSchema: Type.Object({ cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })), operationId: Type.Optional(Type.String()), nodeId: Type.Optional(Type.String()), origin: Type.Optional(Type.String()) }, closed), resultSchema: Type.Array(OperationSchema), coverage: ['outline_undo_stack'] }),
  capability({ name: 'revert', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.revert', summary: 'Guard and exactly revert a retained Operation.', requestSchema: Type.Object({ operationId: Type.String({ minLength: 1 }), preview: Type.Optional(Type.Boolean()) }, closed), resultSchema: MutationResult, coverage: ['undo'] }),
  capability({ name: 'undo', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.undo', summary: 'Revert the latest applicable Operation.', requestSchema: Type.Object({ preview: Type.Optional(Type.Boolean()) }, closed), resultSchema: MutationResult, coverage: ['undo'] }),
  capability({ name: 'redo', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.redo', summary: 'Revert the latest applicable revert Operation.', requestSchema: Type.Object({ preview: Type.Optional(Type.Boolean()) }, closed), resultSchema: MutationResult, coverage: ['redo'] }),
  capability({ name: 'asset ingest', kind: 'asset', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'asset.ingest', summary: 'Stage verified asset bytes under a recovery-aware lease.', requestSchema: Type.Object({ source: Type.Union([Type.Literal('path'), Type.Literal('stdin')]), path: Type.Optional(Type.String()) }, closed), resultSchema: AssetLeaseSchema, coverage: ['ingest_asset', 'ingest_local_file', 'ingest_thread_resource'] }),
  capability({ name: 'asset show', kind: 'asset', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'asset.read', summary: 'Read logical asset metadata.', requestSchema: Type.Object({ assetId: Type.String({ minLength: 1 }) }, closed), resultSchema: Type.Unknown(), coverage: ['lookup_asset'] }),
  capability({ name: 'asset export', kind: 'asset', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'asset.export', summary: 'Stream verified asset bytes.', requestSchema: Type.Object({ assetId: Type.String({ minLength: 1 }) }, closed), resultSchema: Type.Unknown(), coverage: ['open_asset', 'copy_asset_file'] }),
] as const;

const PORCELAIN_COMMANDS = [
  ['add', 'structure.create'], ['set', 'content.update'], ['move', 'structure.move'],
  ['duplicate', 'structure.duplicate'], ['merge', 'structure.merge'], ['indent', 'structure.indent'],
  ['outdent', 'structure.outdent'], ['done set', 'done.set'], ['done cycle', 'done.cycle'],
  ['tag add', 'tag.add'], ['tag remove', 'tag.remove'], ['field define', 'field.define'],
  ['field set', 'field.set'], ['field clear', 'field.clear'], ['field remove', 'field.remove'],
  ['field reuse', 'field.reuse'], ['field select', 'field.select'],
  ['definition create', 'definition.create'], ['definition configure', 'definition.configure'],
  ['definition merge', 'definition.merge'], ['reference add', 'reference.add'],
  ['reference set', 'reference.retarget'], ['reference inline', 'reference.inline'],
  ['reference restore', 'reference.restore'], ['view set', 'view.set'],
  ['view group set', 'view.group'], ['view sort add', 'view.sort.add'],
  ['view sort set', 'view.sort.set'], ['view sort remove', 'view.sort.remove'],
  ['view sort clear', 'view.sort.clear'], ['view filter add', 'view.filter.add'],
  ['view filter set', 'view.filter.set'], ['view filter remove', 'view.filter.remove'],
  ['view filter clear', 'view.filter.clear'], ['view display add', 'view.display.add'],
  ['view display set', 'view.display.set'], ['view display remove', 'view.display.remove'],
  ['search create', 'search.create'], ['search ensure-tag', 'search.ensure-tag'],
  ['search set', 'search.set'], ['search refresh', 'search.refresh'],
  ['template apply', 'template.apply'], ['daily ensure', 'daily.ensure'],
  ['capture add', 'capture.create'], ['media add', 'media.create'], ['media set', 'media.update'],
  ['trash', 'lifecycle.trash'], ['restore', 'lifecycle.restore'], ['purge', 'lifecycle.purge'],
] as const;

const PORCELAIN_CAPABILITIES = PORCELAIN_COMMANDS.map(([name, auditCategory]) => capability({
  name,
  kind: 'mutate',
  runtimeRequired: true,
  streaming: false,
  destructive: name === 'purge',
  auditCategory,
  summary: `Lower ${name} intent into the public ChangeSet contract.`,
  requestSchema: MutationInput,
  resultSchema: MutationResult,
  coverage: [],
}));

export const OUTLINE_CAPABILITIES = Object.freeze([
  ...FIXED_CAPABILITIES,
  ...PORCELAIN_CAPABILITIES,
]);

const capabilityByName = new Map(OUTLINE_CAPABILITIES.map((entry) => [entry.name, entry]));

export function outlineCapability(name: string): OutlineCapability | undefined {
  return capabilityByName.get(name);
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
    coverage: [...entry.coverage],
    requestSchema: entry.requestSchema,
    resultSchema: entry.resultSchema,
  }));
}

export type OutlineCapabilityRequest<Name extends string> = Static<
  Extract<(typeof OUTLINE_CAPABILITIES)[number], { name: Name }>['requestSchema']
>;
