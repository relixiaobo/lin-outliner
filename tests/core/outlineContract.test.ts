import { describe, expect, test } from 'bun:test';
import { ASSET_COMMANDS, DOCUMENT_COMMANDS } from '../../src/core/commands';
import { SEARCH_EXECUTABLE_QUERY_OPS } from '../../src/core/searchEngine';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import {
  ChangeSetSchema,
  DiffSchema,
  OUTLINE_CAPABILITIES,
  OUTLINE_ERROR_CODES,
  OUTLINE_EXIT_CODES,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_PUBLIC_SCHEMAS,
  OUTLINE_QUERY_OPERATORS,
  compactOutlineSchema,
  OutlineResponseSchema,
  OutlineStreamRecordSchema,
  QueryExpressionSchema,
  SelectorSchema,
  canonicalChangeSetHash,
  canonicalDiffHash,
  canonicalJson,
  canonicalJsonChunks,
  canonicalSha256,
  checkOutlineSchema,
  outlineError,
  outlineCapability,
  outlineCapabilityContractDigest,
  outlineCapabilityManifest,
  outlineExitCodeForError,
  outlineSchemaValidator,
  OUTLINE_PRIVATE_RUNTIME_CONTRACT_VERSION,
  porcelainHelpOptions,
} from '../../src/outline/contract';

const digest = 'a'.repeat(64);

describe('outline public contract', () => {
  test('exports every named versioned schema as valid JSON Schema', () => {
    expect(Object.keys(OUTLINE_PUBLIC_SCHEMAS).sort()).toEqual([
      'AssetLease', 'AssetMetadata', 'AssetRecord', 'BoundedSelectionInput', 'Change', 'ChangeSet', 'DestinationPlacement', 'Diff', 'Event', 'EventFilter',
      'ExactLocatorInput',
      'ImportCoverage', 'ImportEvidence', 'ImportOptions', 'ImportPlanResult', 'ImportSourceProfile',
      'ImportStats', 'ImportVerifyResult', 'ImportWarning', 'NoChangeResult', 'NodeDraft', 'NormalizedImport',
      'NormalizedImportNode', 'Operation', 'OperationLogPage', 'OutlineBatchCountResult', 'OutlineCountResult',
      'OutlineError', 'OutlineResponse', 'OutlineStreamRecord', 'Placement', 'Projection', 'ProjectionResult',
      'QueryExpression', 'RevertConflictDiff', 'RichTextPatch', 'RuntimeStatus', 'Selector', 'TargetRef', 'TargetSpec',
    ]);
    for (const [name, schema] of Object.entries(OUTLINE_PUBLIC_SCHEMAS)) {
      expect(() => Compile(schema)).not.toThrow();
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
      const compacted = compactOutlineSchema(schema);
      expect(() => Compile(compacted), `${name} compacted`).not.toThrow();
      expect(Buffer.byteLength(JSON.stringify(compacted)), name).toBeLessThanOrEqual(512 * 1024);
      expect(countSchemaKey(compacted, '$defs'), name).toBeLessThanOrEqual(1);
    }
  });

  test('rejects non-deterministic selector and mutation shapes', () => {
    const selector = Compile(SelectorSchema);
    expect(selector.Check({ by: 'alias', alias: 'today' })).toBe(true);
    expect(selector.Check({ by: 'query', query: { kind: 'rule', op: 'STRING_MATCH', text: 'alpha' }, limit: 50 })).toBe(true);
    expect(selector.Check({ by: 'fuzzy', text: 'alpha' })).toBe(false);
    expect(selector.Check({ by: 'query', query: { kind: 'rule', op: 'STRING_MATCH' } })).toBe(false);

    const changes = Compile(ChangeSetSchema);
    expect(changes.Check({
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'resolve', target: { selector: { by: 'id', id: 'n1' }, cardinality: 'one' }, bind: 'node' }],
    })).toBe(true);
    expect(changes.Check({
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'resolve', target: { selector: { by: 'id', id: 'n1' }, cardinality: 'first' }, bind: 'node' }],
    })).toBe(false);
  });

  test('caches compiled validators for large recursive capability payloads', () => {
    const schema = outlineCapability('preview')!.requestSchema;
    const validator = outlineSchemaValidator(schema);
    expect(outlineSchemaValidator(schema)).toBe(validator);
    const input = {
      changeSet: {
        protocolVersion: 1,
        kind: 'outline.changeset',
        operations: [{
          op: 'create',
          placement: {
            kind: 'last',
            parent: { target: { selector: { by: 'alias', alias: 'library' }, cardinality: 'one' } },
          },
          nodes: [{
            content: { text: 'Imported root', marks: [], inlineRefs: [] },
            children: Array.from({ length: 2_000 }, (_value, index) => ({
              content: { text: `Imported child ${index + 1}`, marks: [], inlineRefs: [] },
              children: [],
            })),
          }],
        }],
      },
    };

    expect(checkOutlineSchema(schema, input)).toBe(true);
    expect(checkOutlineSchema(schema, {
      ...input,
      changeSet: { ...input.changeSet, unexpected: true },
    })).toBe(false);
  });

  test('derives exact executable query rules from one operator registry', () => {
    const schema = Compile(QueryExpressionSchema);
    const publicOperators = OUTLINE_QUERY_OPERATORS.map((entry) => entry.name).sort();
    expect(publicOperators).toEqual([...SEARCH_EXECUTABLE_QUERY_OPS].sort());
    expect(new Set(publicOperators).size).toBe(publicOperators.length);

    for (const operator of OUTLINE_QUERY_OPERATORS) {
      expect(operator.executable).toBe(true);
      expect(operator.summary.length).toBeGreaterThan(0);
      expect(schema.Check(operator.example)).toBe(true);
      if (operator.operands.value !== 'none') expect(operator.valueFormat?.length).toBeGreaterThan(0);
    }

    expect(schema.Check({ kind: 'rule', op: 'EDITED_BY', targetId: 'user:1' })).toBe(false);
    expect(JSON.stringify(QueryExpressionSchema)).not.toContain('EDITED_BY');
    expect(schema.Check({ kind: 'rule', op: 'STRING_MATCH' })).toBe(false);
    expect(schema.Check({ kind: 'rule', op: 'STRING_MATCH', text: 'module', fieldDefId: 'field:status' })).toBe(false);
    expect(schema.Check({ kind: 'rule', op: 'DONE', text: 'ignored' })).toBe(false);
    expect(schema.Check({ kind: 'rule', op: 'HAS_TAG' })).toBe(false);
    expect(schema.Check({ kind: 'rule', op: 'HAS_TAG', tagDefId: 'tag:task' })).toBe(true);
    expect(schema.Check({ kind: 'rule', op: 'HAS_FIELD' })).toBe(true);
    expect(schema.Check({ kind: 'rule', op: 'FIELD_IS', fieldDefId: 'field:status' })).toBe(false);
    expect(schema.Check({
      kind: 'rule', op: 'FIELD_IS', fieldDefId: 'field:status',
      operands: [{ targetId: 'option:open', text: 'Open' }],
    })).toBe(true);
  });

  test('produces stable canonical hashes independent of object key order', () => {
    const first = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      kind: 'outline.changeset',
      operations: [{ op: 'resolve', target: { cardinality: 'one', selector: { id: 'n1', by: 'id' } }, bind: 'node' }],
    };
    const second = {
      operations: [{ bind: 'node', target: { selector: { by: 'id', id: 'n1' }, cardinality: 'one' }, op: 'resolve' }],
      kind: 'outline.changeset',
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
    };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalChangeSetHash(first)).toBe(canonicalChangeSetHash(second));
    expect(canonicalChangeSetHash(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('numbers must be finite');
    expect(() => canonicalJson({ value: undefined })).toThrow('unsupported value type');
  });

  test('streams canonical JSON in bounded chunks without changing its bytes', () => {
    const value = { tail: true, text: '\u00e9'.repeat(128 * 1024) };
    const chunks = [...canonicalJsonChunks(value)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
    expect(chunks.join('')).toBe(canonicalJson(value));
  });

  test('hashes a Diff without trusting its supplied diffHash', () => {
    const base = { kind: 'outline.diff', protocolVersion: 1, value: 'same' } as const;
    expect(canonicalDiffHash({ ...base, diffHash: 'wrong' })).toBe(canonicalDiffHash({ ...base, diffHash: 'also-wrong' }));
  });

  test('pins JSON and JSONL envelope framing', () => {
    const response = Compile(OutlineResponseSchema);
    expect(response.Check({
      protocolVersion: 1,
      requestId: 'r1',
      ok: true,
      command: 'get',
      revision: 2,
      data: [],
    })).toBe(true);
    expect(response.Check({
      protocolVersion: 1,
      requestId: 'r1',
      ok: true,
      command: 'get',
      data: [],
      diagnostic: 'stdout leak',
    })).toBe(false);

    const stream = Compile(OutlineStreamRecordSchema);
    expect(stream.Check({ protocolVersion: 1, requestId: 'r1', sequence: 0, type: 'hello' })).toBe(true);
    expect(stream.Check({ protocolVersion: 1, requestId: 'r1', sequence: 1, type: 'end', cursor: 'cursor-1' })).toBe(true);
    expect(stream.Check({ protocolVersion: 1, requestId: 'r1', type: 'end' })).toBe(false);
  });

  test('publishes workspace anchors and exact event changes for stateful clients', () => {
    const projectionResult = Compile(OUTLINE_PUBLIC_SCHEMAS.ProjectionResult);
    expect(projectionResult.Check({
      projection: {
        kind: 'outline',
        targets: { target: { selector: { by: 'alias', alias: 'home' }, cardinality: 'one' } },
      },
      revision: 3,
      anchors: {
        workspaceId: 'workspace-id',
        rootId: 'workspace',
        libraryId: 'library',
        dailyNotesId: 'daily-notes',
        schemaId: 'schema',
        searchesId: 'searches',
        recentsId: 'recents',
        trashId: 'trash',
        todayId: 'today-id',
      },
      nodes: [],
    })).toBe(true);

    const event = Compile(OUTLINE_PUBLIC_SCHEMAS.Event);
    expect(event.Check({
      protocolVersion: 1,
      kind: 'outline.event',
      type: 'operation.committed',
      instanceId: 'runtime:1',
      sequence: 4,
      revision: 3,
      cursor: 'cursor',
      changes: {
        todayId: 'today-id',
        changedNodes: [{ id: 'node:1' }],
        removedIds: ['node:2'],
      },
    })).toBe(true);
  });

  test('registers every fixed command with request and result schemas', () => {
    const names = OUTLINE_CAPABILITIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'version', 'status', 'capabilities', 'example', 'schema',
      'find', 'get', 'view get', 'search run', 'export', 'watch',
      'preview', 'transact', 'apply', 'history', 'revert', 'undo', 'redo',
      'asset ingest', 'asset get', 'asset export',
      'import inspect', 'import plan', 'import verify',
      'create', 'edit', 'replace text', 'move', 'duplicate', 'merge',
      'define create', 'define ensure', 'define edit', 'view set',
      'search create', 'search edit', 'template apply', 'daily ensure',
      'capture create', 'trash', 'restore', 'purge',
    ]);
    for (const retired of [
      'add', 'set', 'show', 'diff', 'commit', 'log', 'view inspect', 'asset show',
      'text replace', 'done set', 'tag add', 'field set', 'reference set',
      'definition create', 'search set', 'search refresh', 'capture add', 'source add',
    ]) expect(names).not.toContain(retired);
    const compiled = new Set<object>();
    for (const entry of OUTLINE_CAPABILITIES) {
      for (const schema of [entry.requestSchema, entry.resultSchema, entry.porcelain?.inputSchema]) {
        if (!schema || compiled.has(schema)) continue;
        expect(() => Compile(schema)).not.toThrow();
        compiled.add(schema);
      }
    }
  }, 10_000);

  test('publishes exact porcelain schemas and one registry-owned help option set', () => {
    const porcelain = OUTLINE_CAPABILITIES.filter((entry) => entry.porcelain !== undefined);
    expect(porcelain.length).toBeGreaterThan(0);
    for (const capability of porcelain) {
      const options = porcelainHelpOptions(capability.porcelain!);
      expect(new Set(options.map((entry) => entry.name)).size).toBe(options.length);
      expect(options.map((entry) => entry.name)).toEqual(expect.arrayContaining([
        'input', 'preview', 'expect-diff', 'idempotency-key',
      ]));
      expect(options.some((entry) => entry.name === 'yes')).toBe(capability.destructive);
      expect(capability.help.examples.length).toBeGreaterThanOrEqual(1);
      expect(capability.help.examples.length).toBeLessThanOrEqual(3);
      expect(capability.help.positionals.join(' ')).not.toContain('[ARGS]');
      expect(capability.help.input).toContain('--input FILE|-');
      expect(capability.help.output).toContain('Operation');
      expect(capability.help.behavior.length).toBeGreaterThan(0);
    }

    const searchCreate = OUTLINE_CAPABILITIES.find((entry) => entry.name === 'search create')!.porcelain!;
    const base = { title: 'Modules' };
    expect(Value.Check(searchCreate.inputSchema, { ...base, match: 'module' })).toBe(true);
    expect(Value.Check(searchCreate.inputSchema, { ...base, query: { kind: 'rule', op: 'STRING_MATCH', text: 'module' } })).toBe(true);
    expect(Value.Check(searchCreate.inputSchema, base)).toBe(false);
    expect(Value.Check(searchCreate.inputSchema, { ...base, match: 'module', query: { kind: 'rule', op: 'STRING_MATCH', text: 'module' } })).toBe(false);
    expect(Value.Check(searchCreate.inputSchema, { changeSet: { operations: [] } })).toBe(false);

    const viewSet = OUTLINE_CAPABILITIES.find((entry) => entry.name === 'view set')!.porcelain!;
    const target = 'node:owner';
    expect(Value.Check(viewSet.inputSchema, {
      target,
      view: { mode: 'table', replace: { display: [{ field: 'field:priority', visible: true }] } },
    })).toBe(true);
    expect(Value.Check(viewSet.inputSchema, { target, displayFieldId: 'display:field' })).toBe(false);
  });

  test('derives help, completion metadata, and exact CLI schemas from every capability contract', () => {
    const manifest = outlineCapabilityManifest();
    expect(manifest).toHaveLength(OUTLINE_CAPABILITIES.length);
    for (const capability of OUTLINE_CAPABILITIES) {
      const published = manifest.find((entry) => entry.name === capability.name)!;
      const options = capability.porcelain
        ? porcelainHelpOptions(capability.porcelain)
        : capability.help.options;
      expect(published.help.options).toEqual(options);
      expect(published.completion).toEqual({
        command: capability.name,
        positionals: capability.help.positionals,
        options: options.map((entry) => ({
          name: entry.name,
          ...(entry.value ? { value: entry.value } : {}),
        })),
        ...(['find', 'replace text', 'search create', 'search edit'].includes(capability.name) ? {
          queryOperators: OUTLINE_QUERY_OPERATORS.map((operator) => ({
            name: operator.name,
            summary: operator.summary,
          })),
        } : {}),
      });
      expect(published.requestSchema).toEqual(
        compactOutlineSchema(capability.porcelain?.inputSchema ?? capability.requestSchema),
      );
      expect(Buffer.byteLength(JSON.stringify(published.requestSchema))).toBeLessThanOrEqual(512 * 1024);
      expect(countSchemaKey(published.requestSchema, '$defs')).toBeLessThanOrEqual(1);
      expect(capability.help.examples.length).toBeGreaterThanOrEqual(1);
      expect(capability.help.examples.length).toBeLessThanOrEqual(3);
    }
  });

  test('includes the private Runtime contract version in the compatibility digest', () => {
    expect(outlineCapabilityContractDigest()).toBe(canonicalSha256({
      capabilities: outlineCapabilityManifest(),
      privateRuntimeContractVersion: OUTLINE_PRIVATE_RUNTIME_CONTRACT_VERSION,
    }));
  });

  test('compacts repeated cyclic definitions without changing exact query validation', () => {
    const compacted = compactOutlineSchema(QueryExpressionSchema);
    const valid = {
      kind: 'rule',
      op: 'FIELD_IS',
      fieldDefId: 'field:status',
      text: 'Open',
    };
    const missingField = {
      kind: 'rule',
      op: 'FIELD_IS',
      text: 'Open',
    };
    const unrelatedOperand = {
      kind: 'rule',
      op: 'DONE',
      fieldDefId: 'field:status',
    };

    expect(Value.Check(compacted, valid)).toBe(Value.Check(QueryExpressionSchema, valid));
    expect(Value.Check(compacted, missingField)).toBe(Value.Check(QueryExpressionSchema, missingField));
    expect(Value.Check(compacted, unrelatedOperand)).toBe(Value.Check(QueryExpressionSchema, unrelatedOperand));
    expect(() => Compile(compacted)).not.toThrow();
  });

  test('classifies every persisted desktop capability under one public owner', () => {
    const coverageOwners = new Map<string, string[]>();
    for (const capability of OUTLINE_CAPABILITIES) {
      for (const covered of capability.coverage) {
        const owners = coverageOwners.get(covered) ?? [];
        owners.push(capability.name);
        coverageOwners.set(covered, owners);
      }
    }

    expect(coverageOwners.get('document_events')).toEqual(['watch']);
    expect(coverageOwners.get('operation_history')).toEqual(['history']);
    for (const command of DOCUMENT_COMMANDS) {
      if (command === 'init_workspace') {
        expect(coverageOwners.has(command)).toBe(false);
        continue;
      }
      expect(coverageOwners.get(command)).toEqual([expect.any(String)]);
    }

    const osEffects = new Set([
      'pick_image_files',
      'pick_attachment_files',
      'open_asset',
      'reveal_asset',
      'copy_asset_file',
      'open_external_url',
    ]);
    for (const command of ASSET_COMMANDS) {
      if (osEffects.has(command)) {
        expect(coverageOwners.has(command)).toBe(false);
        continue;
      }
      expect(coverageOwners.get(command)).toEqual([expect.any(String)]);
    }
  });

  test('maps every stable error category to its public exit code', () => {
    expect(OUTLINE_ERROR_CODES).toContain('runtime_unavailable');
    expect(outlineExitCodeForError(outlineError('invalid_input', 'usage', 'bad input'))).toBe(OUTLINE_EXIT_CODES.usage);
    expect(outlineExitCodeForError(outlineError('ambiguous_selector', 'selection', 'many'))).toBe(OUTLINE_EXIT_CODES.conflict);
    expect(outlineExitCodeForError(outlineError('recovery_capacity_exceeded', 'durability', 'full'))).toBe(OUTLINE_EXIT_CODES.durability);
  });

  test('validates a self-contained Diff artifact', () => {
    const changeSet = {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'resolve',
        target: { selector: { by: 'id', id: 'n1' }, cardinality: 'one' },
        bind: 'node',
      }],
    };
    const value = {
      protocolVersion: 1,
      kind: 'outline.diff',
      diffHash: digest,
      intentHash: digest,
      changeSetHash: digest,
      baseRevision: 1,
      normalizedChangeSet: changeSet,
      bindings: { node: ['n1'] },
      affected: [],
      destructive: [],
      warnings: [],
      resultEstimate: { nodeCount: 0, encodedBytes: 0 },
    };
    expect(Compile(DiffSchema).Check(value)).toBe(true);
  });
});

function countSchemaKey(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countSchemaKey(entry, key), 0);
  return Object.entries(value).reduce((total, [entryKey, entry]) => (
    total + (entryKey === key ? 1 : 0) + countSchemaKey(entry, key)
  ), 0);
}
