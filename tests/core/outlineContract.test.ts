import { describe, expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import {
  ChangeSetSchema,
  DiffSchema,
  OUTLINE_CAPABILITIES,
  OUTLINE_ERROR_CODES,
  OUTLINE_EXIT_CODES,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_PUBLIC_SCHEMAS,
  OutlineResponseSchema,
  OutlineStreamRecordSchema,
  SelectorSchema,
  canonicalChangeSetHash,
  canonicalDiffHash,
  canonicalJson,
  outlineError,
  outlineExitCodeForError,
} from '../../src/outline/contract';

const digest = 'a'.repeat(64);

describe('outline public contract', () => {
  test('exports every named versioned schema as valid JSON Schema', () => {
    expect(Object.keys(OUTLINE_PUBLIC_SCHEMAS).sort()).toEqual([
      'AssetLease', 'AssetMetadata', 'Change', 'ChangeSet', 'Diff', 'Event', 'EventFilter',
      'NodeDraft', 'Operation', 'OutlineError', 'OutlineRequest',
      'OutlineResponse', 'OutlineStreamRecord', 'Projection', 'ProjectionResult',
      'RuntimeDescriptor', 'Selector', 'TargetRef', 'TargetSpec',
    ]);
    for (const schema of Object.values(OUTLINE_PUBLIC_SCHEMAS)) {
      expect(() => Compile(schema)).not.toThrow();
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
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
      command: 'show',
      revision: 2,
      data: [],
    })).toBe(true);
    expect(response.Check({
      protocolVersion: 1,
      requestId: 'r1',
      ok: true,
      command: 'show',
      data: [],
      diagnostic: 'stdout leak',
    })).toBe(false);

    const stream = Compile(OutlineStreamRecordSchema);
    expect(stream.Check({ protocolVersion: 1, requestId: 'r1', sequence: 0, type: 'hello' })).toBe(true);
    expect(stream.Check({ protocolVersion: 1, requestId: 'r1', sequence: 1, type: 'end', cursor: 'cursor-1' })).toBe(true);
    expect(stream.Check({ protocolVersion: 1, requestId: 'r1', type: 'end' })).toBe(false);
  });

  test('registers every fixed command with request and result schemas', () => {
    const names = OUTLINE_CAPABILITIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('diff');
    expect(names).toContain('apply');
    expect(names).toContain('asset ingest');
    expect(names).toContain('purge');
    expect(names).not.toContain('asset delete');
    for (const entry of OUTLINE_CAPABILITIES) {
      expect(() => Compile(entry.requestSchema)).not.toThrow();
      expect(() => Compile(entry.resultSchema)).not.toThrow();
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
