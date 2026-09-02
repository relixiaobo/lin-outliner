import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { runOutlineCli } from '../../src/outline/cli';
import { renderEventSummary, renderFailureSummary, renderSummaryResult } from '../../src/outline/cli/presentation';
import {
  issueOutlineAgentAttestation,
  OUTLINE_AGENT_ATTESTATION_ENV,
} from '../../src/outline/contract/agentAttestation';
import {
  OUTLINE_APP_VERSION,
  OUTLINE_CAPABILITIES,
  OUTLINE_CLI_VERSION,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_STORAGE_VERSION,
  OutlineResponseSchema,
  OutlineStreamRecordSchema,
  canonicalSha256,
  outlineCapabilityContractDigest,
  type ChangeSet,
  type Diff,
} from '../../src/outline/contract';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';

const roots: string[] = [];
const cliEntry = fileURLToPath(new URL('../../src/outline/cli/entry.ts', import.meta.url));

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('outline CLI', () => {
  test('bounds summary view receipts with explicit omitted state and no ANSI', () => {
    const displayFields = Array.from({ length: 100 }, (_, index) => ({
      fieldId: `field:${index}`,
      label: `Field ${index} ${'x'.repeat(200)}`,
      visible: true,
      order: index,
    }));
    const output = renderSummaryResult('view inspect', {
      kind: 'outline.view-summary', revision: 7, ownerId: 'node:owner', title: 'Large view',
      mode: 'table', toolbarVisible: true, itemCount: 10_000,
      displayFieldCount: displayFields.length, displayDigest: canonicalSha256(displayFields),
      displayFields, group: null, sortCount: 1, filterCount: 0,
    });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4 * 1024);
    expect(output).toContain('Display fields: 100');
    expect(output).toContain('Omitted display fields: 96');
    expect(output).not.toContain('Omitted lines:');
    expect(output).not.toMatch(/\u001b\[/u);

    const hostile = renderSummaryResult('view inspect', {
      kind: 'outline.view-summary', revision: 8, ownerId: 'node:owner',
      title: 'safe\u001b[2J\nStatus: forged', mode: 'table', toolbarVisible: true,
      itemCount: 1, displayFieldCount: 1, displayDigest: 'a'.repeat(64),
      displayFields: [{ fieldId: 'field:1', label: 'Name\tforged', visible: true, order: 0 }],
      group: null, sortCount: 0, filterCount: 0,
    });
    expect(hostile).not.toContain('\u001b');
    expect(hostile).not.toContain('\nStatus: forged');
    expect(hostile).toContain('safe\\u001b[2J\\nStatus: forged');
    expect(hostile).toContain('Name\\tforged');
  });

  test('renders bounded typed projection summaries instead of partial JSON', () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      id: `node:${index}`,
      type: 'plain',
      parentId: 'node:parent',
      content: { text: index === 0 ? 'Decision context' : `Node ${index} ${'x'.repeat(500)}` },
    }));
    const output = renderSummaryResult('get', {
      projection: { kind: 'outline' },
      revision: 42,
      anchors: {},
      nodes,
      truncated: true,
      cursor: 'cursor:next',
    });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4 * 1024);
    expect(output).toContain('Command: get');
    expect(output).toContain('Nodes: 100; shown=4; omitted=96; digest=');
    expect(output).toContain('text=Decision context');
    expect(output).toContain('Continuation: cursor:next; truncated=true');
    expect(output).not.toContain('Omitted lines:');
    expect(output.trimStart().startsWith('{')).toBe(false);
  });

  test('keeps history pages closed-loop with affected IDs and exact cursors', () => {
    const output = renderSummaryResult('history', {
      operations: [{
        operationId: 'operation:1', revisionBefore: 1, revisionAfter: 2, summary: 'Bulk update',
      }],
      affectedNodeIds: {
        operationId: 'operation:1',
        nodeIds: ['node:first', 'node:second'],
        offset: 0,
        totalCount: 4,
        fullSetHash: 'a'.repeat(64),
      },
      cursor: 'cursor:affected-next',
    });
    expect(output).toContain('Continuation: cursor:affected-next');
    expect(output).toContain('page=2; shown=2; omitted=0; total=4');
    expect(output).toContain('node:first, node:second');
  });

  test('bounds watch event receipts without losing resumable identity', () => {
    const changedNodes = Array.from({ length: 500 }, (_, index) => ({
      id: `node:${index}`,
      content: { text: `${'x'.repeat(200)}\u001b[31m` },
    }));
    const output = renderEventSummary({
      kind: 'outline.event',
      type: 'operation.committed',
      instanceId: 'runtime:1',
      sequence: 17,
      revision: 9,
      cursor: 'cursor:resume-event',
      operation: {
        operationId: 'operation:1',
        revisionBefore: 8,
        revisionAfter: 9,
        affectedNodeCount: changedNodes.length,
        affectedNodeIdsHash: 'b'.repeat(64),
      },
      changes: { changedNodes, removedIds: ['node:removed'] },
    });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4 * 1024);
    expect(output).toContain('Event: operation.committed');
    expect(output).toContain('Cursor: cursor:resume-event');
    expect(output).toContain('Operation: operation:1');
    expect(output).toContain('Changed Nodes: 500; shown=8; omitted=492; digest=');
    expect(output).toContain('Removed Nodes: 1; shown=1; omitted=0; digest=');
    expect(output).not.toContain('\u001b');
    expect(output.trimStart().startsWith('{')).toBe(false);
  });

  test('escapes controls in failure headers and recovery commands', () => {
    const output = renderFailureSummary({
      code: 'invalid_input',
      category: 'usage',
      message: 'bad\tinput\u0000\u0085\nStatus: forged',
      retryable: false,
      next: ['outline get node:1\u001b[2J'],
    });
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0000');
    expect(output).not.toContain('\u0085');
    expect(output).not.toContain('\nStatus: forged');
    expect(output).toContain('bad\\tinput\\u0000\\u0085\\nStatus: forged');
    expect(output).toContain('outline get node:1\\u001b[2J');
  });

  test('reports omitted returned roots with complete-set evidence', () => {
    const returnedRoots = Array.from({ length: 12 }, (_, index) => `node:${index}`);
    const output = renderSummaryResult('create', {
      kind: 'outline.operation',
      operationId: 'operation:1',
      revisionBefore: 1,
      revisionAfter: 2,
      affectedNodeCount: 12,
      affectedNodeIdsHash: 'a'.repeat(64),
      recovery: { state: 'retained' },
      result: [{ nodes: returnedRoots.map((id) => ({ id })) }],
    });
    expect(output).toContain('Returned roots: 12; shown=8; omitted=4; digest=');
    expect(output).toContain('node:0, node:1');
    expect(output).not.toContain('node:8');
  });

  test('emits exactly one versioned JSON envelope for a local command without starting Runtime', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['--json', 'version'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout.endsWith('\n')).toBe(true);
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    const response = JSON.parse(output.stdout) as unknown;
    expect(Value.Check(OutlineResponseSchema, response)).toBe(true);
    expect(response).toMatchObject({
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      ok: true,
      command: 'version',
      data: { appVersion: OUTLINE_APP_VERSION, protocolMajors: [OUTLINE_PROTOCOL_VERSION] },
    });
    expect(await readdir(root)).toEqual([]);
  });

  test('defaults to the same summary for TTY and non-TTY output and requires explicit json', async () => {
    const root = await makeRoot();
    const nonTty = captureIo();
    const tty = captureIo();
    const forcedJson = captureIo();
    const retiredHuman = captureIo();
    const literalJson = captureIo();
    const jsonAfterUnknown = captureIo();

    expect(await runOutlineCli(['version'], { runtimeRoot: root, io: nonTty.io })).toBe(0);
    expect(nonTty.stdout).toStartWith('outline 1.0.0');
    expect(await runOutlineCli(['version'], {
      runtimeRoot: root,
      io: { ...tty.io, interactive: true },
    })).toBe(0);
    expect(tty.stdout).toBe(nonTty.stdout);
    expect(await runOutlineCli(['--json', 'version'], {
      runtimeRoot: root,
      io: { ...forcedJson.io, interactive: true },
    })).toBe(0);
    expect(JSON.parse(forcedJson.stdout)).toMatchObject({ ok: true, command: 'version' });
    expect(await runOutlineCli(['--human', 'version'], {
      runtimeRoot: root,
      io: retiredHuman.io,
    })).toBe(2);
    expect(retiredHuman.stdout).toBe('');
    expect(retiredHuman.stderr).toContain('Unknown global option: --human');
    expect(await runOutlineCli(['--', '--json'], {
      runtimeRoot: root,
      io: literalJson.io,
    })).toBe(2);
    expect(literalJson.stdout).toBe('');
    expect(literalJson.stderr).toContain('Unknown outline command or family');
    expect(await runOutlineCli(['--bogus', '--json', 'version'], {
      runtimeRoot: root,
      io: jsonAfterUnknown.io,
    })).toBe(2);
    expect(JSON.parse(jsonAfterUnknown.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(jsonAfterUnknown.stderr).toBe('');
    expect(await readdir(root)).toEqual([]);
  });

  test('awaits output sinks and treats a closed downstream pipe as successful termination', async () => {
    const root = await makeRoot();
    let flushed = false;
    expect(await runOutlineCli(['version'], {
      runtimeRoot: root,
      io: {
        stdout: async () => {
          await Promise.resolve();
          flushed = true;
        },
      },
    })).toBe(0);
    expect(flushed).toBe(true);

    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    expect(await runOutlineCli(['version'], {
      runtimeRoot: root,
      io: { stdout: () => { throw brokenPipe; } },
    })).toBe(0);
    expect(await runOutlineCli(['--json', 'not-a-command'], {
      runtimeRoot: root,
      io: { stdout: () => { throw brokenPipe; } },
    })).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  test('reports actionable filesystem errors in summary mode', async () => {
    const root = await makeRoot();
    const missingPath = path.join(root, 'missing-selector.json');
    const output = captureIo();
    const streamedInput = captureIo();
    expect(await runOutlineCli(['get', '--selector', missingPath], {
      runtimeRoot: root,
      io: output.io,
    })).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain(`File not found: ${missingPath}.`);
    expect(output.stderr).not.toContain('could not be completed');

    expect(await runOutlineCli(['preview', '--input', missingPath], {
      runtimeRoot: root,
      io: streamedInput.io,
    })).toBe(2);
    expect(streamedInput.stderr).toContain(`File not found: ${missingPath}.`);
    expect(await readdir(root)).toEqual([]);
  });

  test('reports absent status without starting Runtime', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['--json', 'status'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, command: 'status', data: { running: false } });
    expect(await readdir(root)).toEqual([]);
  });

  test('reports exact Runtime, transaction-log, and recovery health without starting another Runtime', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const output = captureIo();
      expect(await runOutlineCli(['--json', 'status'], { runtimeRoot: root, io: output.io })).toBe(0);
      expect(JSON.parse(output.stdout).data).toEqual({
        running: true,
        runtime: {
          instanceId: runtime.workspace.instanceId,
          contractDigest: outlineCapabilityContractDigest(),
          runtimeVersion: OUTLINE_CLI_VERSION,
          storageVersion: OUTLINE_STORAGE_VERSION,
          revision: 0,
          transactionLog: {
            health: 'healthy',
            sequence: 0,
            eventSequence: 0,
            snapshotSequence: 0,
            validBytes: expect.any(Number),
            totalBytes: expect.any(Number),
            tornTail: false,
            stale: false,
            inconsistent: false,
            maintenancePending: false,
          },
          recovery: {
            available: 0,
            conflicted: 0,
            reverted: 0,
            expired: 0,
            retainedBytes: 0,
            budgetBytes: 2 * 1024 * 1024 * 1024,
            orphanBlobCount: 0,
          },
        },
      });

      const mutation = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'create', '@today', 'Status health row'], {
        runtimeRoot: root,
        io: mutation.io,
      })).toBe(0);
      const updated = captureIo();
      expect(await runOutlineCli(['--json', 'status'], { runtimeRoot: root, io: updated.io })).toBe(0);
      const updatedRuntime = JSON.parse(updated.stdout).data.runtime;
      expect(updatedRuntime).toMatchObject({
        revision: 1,
        transactionLog: {
          health: 'healthy',
          sequence: 1,
          eventSequence: 1,
          snapshotSequence: 0,
          maintenancePending: false,
        },
        recovery: { available: 1, retainedBytes: expect.any(Number) },
      });
      expect(updatedRuntime.transactionLog.validBytes).toBe(updatedRuntime.transactionLog.totalBytes);
    } finally {
      await runtime.stop();
    }
  });

  test('serves exact named public and command schemas locally', async () => {
    const root = await makeRoot();
    const selector = captureIo();
    const porcelain = captureIo();
    const search = captureIo();
    const help = captureIo();
    const unknown = captureIo();
    const defaultSchema = captureIo();
    const defaultQuerySchema = captureIo();

    expect(await runOutlineCli(['--json', 'schema', 'Selector'], { runtimeRoot: root, io: selector.io })).toBe(0);
    expect(JSON.parse(selector.stdout).data.$defs.Selector.$id).toBe('Selector');
    expect(await runOutlineCli(['schema', 'create', '--path', '/properties/fields'], { runtimeRoot: root, io: defaultSchema.io })).toBe(0);
    const completeDefaultSchema = JSON.parse(defaultSchema.stdout) as Record<string, unknown>;
    expect(completeDefaultSchema).toHaveProperty('items');
    expect(Buffer.byteLength(defaultSchema.stdout)).toBeLessThan(4 * 1024);
    expect(await runOutlineCli(['schema', 'QueryExpression'], {
      runtimeRoot: root,
      io: defaultQuerySchema.io,
    })).toBe(0);
    expect(JSON.parse(defaultQuerySchema.stdout)).toHaveProperty('$defs.QueryExpression');
    expect(await runOutlineCli(['--json', 'schema', 'edit'], { runtimeRoot: root, io: porcelain.io })).toBe(0);
    expect(JSON.parse(porcelain.stdout).data).toHaveProperty('properties');
    expect(JSON.parse(porcelain.stdout).data).not.toHaveProperty('request');
    expect(JSON.parse(porcelain.stdout).data).not.toHaveProperty('result');
    expect(await runOutlineCli(['--json', 'schema', 'search', 'create'], { runtimeRoot: root, io: search.io })).toBe(0);
    const searchSchema = JSON.stringify(JSON.parse(search.stdout).data);
    expect(searchSchema).toContain('match');
    expect(searchSchema).toContain('query');
    expect(searchSchema).not.toContain('changeSet');
    expect(await runOutlineCli(['search', 'create', '--help'], { runtimeRoot: root, io: help.io })).toBe(0);
    expect(help.stdout).toContain('--match TEXT');
    expect(help.stdout).toContain('--input FILE|-');
    expect(help.stdout).toContain('outline search create --title "Modules" --match "module"');
    expect(help.stdout).not.toContain('--input-format');
    expect(await runOutlineCli(['--json', 'search', 'create', '--unknown'], { runtimeRoot: root, io: unknown.io })).toBe(2);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await readdir(root)).toEqual([]);
  });

  test('bounds command schema discovery and returns result or both only when requested', async () => {
    const root = await makeRoot();
    const request = captureIo();
    const result = captureIo();
    const both = captureIo();
    const publicSchema = captureIo();
    const invalid = captureIo();
    const publicPart = captureIo();
    const catalog = captureIo();
    const fragment = captureIo();
    const missingPath = captureIo();

    expect(await runOutlineCli(['--json', 'schema'], { runtimeRoot: root, io: catalog.io })).toBe(0);
    expect(JSON.parse(catalog.stdout).data).toMatchObject({
      schemas: expect.arrayContaining(['ChangeSet', 'Selector']),
      commands: expect.arrayContaining(['create', 'view set']),
    });
    expect(Buffer.byteLength(catalog.stdout)).toBeLessThan(8 * 1024);

    expect(await runOutlineCli(['--json', 'schema', 'create'], { runtimeRoot: root, io: request.io })).toBe(0);
    const requestSchema = JSON.parse(request.stdout).data as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(requestSchema))).toBeLessThanOrEqual(512 * 1024);
    expect(countObjectKey(requestSchema, 'Selector')).toBe(0);

    expect(await runOutlineCli(['--json', 'schema', 'create', '--path', '/properties/fields'], {
      runtimeRoot: root,
      io: fragment.io,
    })).toBe(0);
    const fieldFragment = JSON.parse(fragment.stdout).data as Record<string, unknown>;
    expect(fieldFragment).toHaveProperty('items');
    expect(Buffer.byteLength(JSON.stringify(fieldFragment))).toBeLessThan(4 * 1024);

    expect(await runOutlineCli(['--json', 'schema', 'create', '--path', '/properties/missing'], {
      runtimeRoot: root,
      io: missingPath.io,
    })).toBe(2);
    expect(JSON.parse(missingPath.stdout)).toMatchObject({
      error: { code: 'invalid_input', message: 'Schema path does not exist: /properties/missing' },
    });

    expect(await runOutlineCli(['--json', 'schema', 'ChangeSet'], {
      runtimeRoot: root,
      io: publicSchema.io,
    })).toBe(0);
    const changeSetSchema = JSON.parse(publicSchema.stdout).data as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(changeSetSchema))).toBeLessThanOrEqual(512 * 1024);
    expect(countObjectKey(changeSetSchema, '$defs')).toBeLessThanOrEqual(1);

    expect(await runOutlineCli(['--json', 'schema', 'create', '--part', 'result'], {
      runtimeRoot: root,
      io: result.io,
    })).toBe(0);
    expect(JSON.parse(result.stdout).data).not.toEqual(requestSchema);

    expect(await runOutlineCli(['--json', 'schema', '--part', 'both', 'create'], {
      runtimeRoot: root,
      io: both.io,
    })).toBe(0);
    expect(JSON.parse(both.stdout).data).toEqual({
      request: requestSchema,
      result: JSON.parse(result.stdout).data,
    });

    expect(await runOutlineCli(['--json', 'schema', 'create', '--part', 'unknown'], {
      runtimeRoot: root,
      io: invalid.io,
    })).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: { code: 'invalid_input', message: '--part requires request, result, or both.' },
    });
    expect(await runOutlineCli(['--json', 'schema', 'Selector', '--part', 'request'], {
      runtimeRoot: root,
      io: publicPart.io,
    })).toBe(2);
    expect(JSON.parse(publicPart.stdout)).toMatchObject({
      error: { code: 'invalid_input', message: '--part applies only to command schemas.' },
    });
    expect(await readdir(root)).toEqual([]);
  });

  test('renders root help as discoverable command families without starting Runtime', async () => {
    const root = await makeRoot();
    const output = captureIo();
    const jsonOutput = captureIo();

    expect(await runOutlineCli(['--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(await runOutlineCli(['--json', '--help'], { runtimeRoot: root, io: jsonOutput.io })).toBe(0);
    expect(jsonOutput.stdout).toBe(output.stdout);
    expect(output.stdout).toContain('Command families:');
    expect(output.stdout).toContain('search         Create, edit, and run Saved Searches.');
    expect(output.stdout).toContain('replace        Apply bounded, reviewed content transformations.');
    expect(output.stdout).toContain('view           Read or set a projection over the same Nodes.');
    expect(output.stdout).toContain('Direct commands:');
    expect(output.stdout).toContain('schema         List available schemas or print one exact bounded schema fragment.');
    expect(output.stdout).not.toContain('COMMAND [ARGS]\n\nCommands:');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders search family help with its real subcommands', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['search', '--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stdout).toContain('Usage: outline [GLOBAL OPTIONS] search SUBCOMMAND [ARGS]');
    expect(output.stdout).toContain('create             Create a complete Saved Search');
    expect(output.stdout).toContain('edit               Converge a Saved Search');
    expect(output.stdout).toContain('run                Run one Saved Search live');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders exact import plan help with public adapter and artifact boundaries', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['import', 'plan', '--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stdout).toContain('Behavior: preview; idempotent');
    expect(output.stdout).toContain('--format auto|normalized|tana');
    expect(output.stdout).toContain('--fidelity content|clean|full');
    expect(output.stdout).toContain('--output FILE');
    expect(output.stdout).toContain('--evidence-output FILE');
    expect(output.stdout).toContain('SOURCE and every output artifact must use distinct paths.');
    expect(output.stdout).toContain('outline import plan cleaned.json --format normalized');
    expect(output.stdout).not.toContain('[ARGS]');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders exact search create help and treats -h like --help', async () => {
    const root = await makeRoot();
    const output = captureIo();
    const short = captureIo();

    expect(await runOutlineCli(['search', 'create', '--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(await runOutlineCli(['search', 'create', '-h'], { runtimeRoot: root, io: short.io })).toBe(0);
    expect(short.stdout).toBe(output.stdout);
    expect(output.stdout).toContain('Behavior: create; not idempotent');
    expect(output.stdout).toContain('--match TEXT');
    expect(output.stdout).toContain('--query JSON|FILE');
    expect(output.stdout).toContain('--view MODE');
    expect(output.stdout).toContain('--sort FIELD:DIRECTION');
    expect(output.stdout).toContain('--input FILE|-');
    expect(output.stdout).toContain('Parent defaults to @saved-searches.');
    expect(output.stdout).toContain('outline schema search create');
    expect(output.stdout).toContain('outline search create --title "Modules" --match "module"');
    expect(output.stdout).toContain('outline example search create complete');
    expect(output.stdout).not.toContain('[ARGS]');
    expect(await readdir(root)).toEqual([]);
  });

  test('keeps undo help, schema, and argv origin guards in sync', async () => {
    const root = await makeRoot();
    const help = captureIo();
    const schema = captureIo();
    const invalid = captureIo();

    expect(await runOutlineCli(['undo', '--help'], { runtimeRoot: root, io: help.io })).toBe(0);
    expect(help.stdout).toContain('--origin ORIGIN');
    expect(help.stdout).toContain('own, all, desktop, local-user, built-in-agent, or external-client');
    expect(help.stdout).toContain('--expect-operation ID');
    expect(help.stdout).toContain('(default: own)');
    expect(help.stdout).toContain('outline undo --origin built-in-agent --expect-operation operation:example');

    expect(await runOutlineCli(['--json', 'schema', 'undo'], { runtimeRoot: root, io: schema.io })).toBe(0);
    const requestSchema = JSON.stringify(JSON.parse(schema.stdout).data);
    expect(requestSchema).toContain('expectOperationId');
    expect(requestSchema).toContain('built-in-agent');
    expect(requestSchema).toContain('external-client');

    expect(await runOutlineCli(['--json', 'undo', '--origin', 'agent'], {
      runtimeRoot: root,
      io: invalid.io,
    })).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', category: 'usage' },
    });
    expect(await readdir(root)).toEqual([]);
  });

  test('renders exact find help and schema for live search and count forms', async () => {
    const root = await makeRoot();
    const help = captureIo();
    const schema = captureIo();

    expect(await runOutlineCli(['find', '--help'], { runtimeRoot: root, io: help.io })).toBe(0);
    expect(help.stdout).toContain('--search SEARCH_ID');
    expect(help.stdout).toContain('--count');
    expect(help.stdout).toContain('--input FILE|-');
    expect(help.stdout).toContain('named batch counts');
    expect(help.stdout).toContain('outline find --search search:modules --count');

    expect(await runOutlineCli(['--json', 'schema', 'find'], { runtimeRoot: root, io: schema.io })).toBe(0);
    const requestSchema = JSON.stringify(JSON.parse(schema.stdout).data);
    expect(requestSchema).toContain('searchId');
    expect(requestSchema).toContain('sharedQuery');
    expect(requestSchema).toContain('queries');
    expect(requestSchema).not.toContain('changeSet');
    expect(await readdir(root)).toEqual([]);
  });

  test('keeps global and command option terminators distinct for help parsing', async () => {
    const root = await makeRoot();
    const commandHelp = captureIo();
    const literalHelp = captureIo();
    expect(await runOutlineCli(['--', 'version', '--help'], {
      runtimeRoot: root,
      io: commandHelp.io,
    })).toBe(0);
    expect(commandHelp.stdout).toContain('Usage: outline [GLOBAL OPTIONS] version');
    expect(await runOutlineCli(['version', '--', '--help'], {
      runtimeRoot: root,
      io: literalHelp.io,
    })).toBe(2);
    expect(literalHelp.stdout).toBe('');
    expect(literalHelp.stderr).toContain('Unexpected version argument: --help');
    expect(await readdir(root)).toEqual([]);
  });

  test('documents standalone Projections for get and export from their exact schemas', async () => {
    const root = await makeRoot();
    const showHelp = captureIo();
    const exportHelp = captureIo();
    const showSchema = captureIo();

    expect(await runOutlineCli(['get', '--help'], { runtimeRoot: root, io: showHelp.io })).toBe(0);
    expect(showHelp.stdout).toContain('Usage: outline [GLOBAL OPTIONS] get [SELECTOR...]');
    expect(showHelp.stdout).toContain('Omit SELECTOR when --projection declares targets.');
    expect(showHelp.stdout).toContain('A separate Selector must match the Projection target exactly.');
    expect(showHelp.stdout).toContain('outline get --projection node-with-backlinks.json');

    expect(await runOutlineCli(['export', '--help'], { runtimeRoot: root, io: exportHelp.io })).toBe(0);
    expect(exportHelp.stdout).toContain('Usage: outline [GLOBAL OPTIONS] export [SELECTOR]');
    expect(exportHelp.stdout).toContain('outline export --projection complete-export.json');

    expect(await runOutlineCli(['--json', 'schema', 'get'], { runtimeRoot: root, io: showSchema.io })).toBe(0);
    const requestSchema = JSON.stringify(JSON.parse(showSchema.stdout).data);
    expect(requestSchema).toContain('projection');
    expect(requestSchema).toContain('selector');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders complete view set help with structured replacement', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['view', 'set', '--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stdout).toContain('Usage: outline [GLOBAL OPTIONS] view set TARGET MODE');
    expect(output.stdout).toContain('--target TARGET');
    expect(output.stdout).toContain('--mode MODE');
    expect(output.stdout).toContain('--replace JSON|FILE');
    expect(output.stdout).toContain('--input FILE|-');
    expect(output.stdout).toContain('outline view set');
    expect(await readdir(root)).toEqual([]);
  });

  test('publishes exact view get help and compact result schema', async () => {
    const root = await makeRoot();
    const help = captureIo();
    const schema = captureIo();
    expect(await runOutlineCli(['view', 'get', '--help'], { runtimeRoot: root, io: help.io })).toBe(0);
    expect(help.stdout).toContain('view get TARGET');
    expect(help.stdout).toContain('outline.view-summary');
    expect(await runOutlineCli(['--json', 'schema', 'view', 'get', '--part', 'result'], { runtimeRoot: root, io: schema.io })).toBe(0);
    const resultSchema = JSON.stringify(JSON.parse(schema.stdout).data);
    expect(resultSchema).toContain('displayDigest');
    expect(resultSchema).toContain('itemCount');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders purge help with exact destructive review requirements', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['purge', '--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stdout).toContain('Behavior: destructive; not idempotent');
    expect(output.stdout).toContain('--preview');
    expect(output.stdout).toContain('--expect-diff SHA256');
    expect(output.stdout).toContain('--yes');
    expect(output.stdout).toContain('--yes alone is rejected');
    expect(output.stdout).toContain('same --idempotency-key KEY');
    expect(output.stdout).toContain('outline purge @trash --contents --preview --idempotency-key cli:review-purge');
    expect(output.stdout).toContain('outline purge @trash --contents --idempotency-key cli:review-purge --expect-diff SHA256 --yes');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders exact replace text help and schema from the same command contract', async () => {
    const root = await makeRoot();
    const help = captureIo();
    const schema = captureIo();

    expect(await runOutlineCli(['replace', 'text', '--help'], { runtimeRoot: root, io: help.io })).toBe(0);
    expect(help.stdout).toContain('Behavior: destructive; idempotent');
    expect(help.stdout).toContain('--matching TEXT');
    expect(help.stdout).toContain('--query JSON|FILE');
    expect(help.stdout).toContain('--max N');
    expect(help.stdout).toContain('--max-replacements N');
    expect(help.stdout).toContain('--field content|description|both');
    expect(help.stdout).toContain('--preview');
    expect(help.stdout).toContain('--expect-diff SHA256');
    expect(help.stdout).toContain('--yes alone is rejected');
    expect(help.stdout).toContain('outline replace text');
    expect(await runOutlineCli(['--json', 'schema', 'replace', 'text'], { runtimeRoot: root, io: schema.io })).toBe(0);
    const requestSchema = JSON.stringify(JSON.parse(schema.stdout).data);
    expect(requestSchema).toContain('maxReplacements');
    expect(requestSchema).toContain('caseSensitive');
    expect(requestSchema).not.toContain('changeSet');
    expect(await readdir(root)).toEqual([]);
  });

  test('derives placement and complete edit schemas from their exact command contracts', async () => {
    const root = await makeRoot();
    const addHelp = captureIo();
    const moveHelp = captureIo();
    const addSchema = captureIo();
    const editSchema = captureIo();

    expect(await runOutlineCli(['create', '--help'], { runtimeRoot: root, io: addHelp.io })).toBe(0);
    expect(addHelp.stdout).toContain('--first');
    expect(addHelp.stdout).toContain('--last');
    expect(addHelp.stdout).toContain('--index INDEX');
    expect(addHelp.stdout).toContain('--before SIBLING');
    expect(addHelp.stdout).toContain('--after SIBLING');
    expect(addHelp.stdout).toContain('outline example create collection');

    expect(await runOutlineCli(['move', '--help'], { runtimeRoot: root, io: moveHelp.io })).toBe(0);
    expect(moveHelp.stdout).toContain('--previous');
    expect(moveHelp.stdout).toContain('--next');
    expect(moveHelp.stdout).toContain('zero-based index');

    expect(await runOutlineCli(['--json', 'schema', 'create'], { runtimeRoot: root, io: addSchema.io })).toBe(0);
    const addRequest = JSON.stringify(JSON.parse(addSchema.stdout).data);
    for (const placement of ['first', 'last', 'index', 'before', 'after']) {
      expect(addRequest).toContain(`\"const\":\"${placement}\"`);
    }
    expect(addRequest).not.toContain('\"const\":\"previous\"');
    expect(addRequest).not.toContain('\"const\":\"next\"');

    expect(await runOutlineCli(['--json', 'schema', 'edit'], {
      runtimeRoot: root,
      io: editSchema.io,
    })).toBe(0);
    const editRequest = JSON.stringify(JSON.parse(editSchema.stdout).data);
    expect(editRequest).toContain('references');
    expect(editRequest).toContain('sources');
    expect(editRequest).not.toContain('changeSet');
    expect(await readdir(root)).toEqual([]);
  });

  test('publishes only executable query operators through schema and completion metadata', async () => {
    const root = await makeRoot();
    const schema = captureIo();
    const capabilities = captureIo();

    expect(await runOutlineCli(['--json', 'schema', 'QueryExpression'], {
      runtimeRoot: root,
      io: schema.io,
    })).toBe(0);
    const querySchema = JSON.stringify(JSON.parse(schema.stdout).data);
    expect(querySchema).toContain('STRING_MATCH');
    expect(querySchema).toContain('FIELD_IS');
    expect(querySchema).not.toContain('EDITED_BY');

    expect(await runOutlineCli(['--json', 'capabilities'], {
      runtimeRoot: root,
      io: capabilities.io,
    })).toBe(0);
    const manifest = JSON.parse(capabilities.stdout).data as Array<{
      name: string;
      completion: { queryOperators?: Array<{ name: string; summary: string }> };
    }>;
    const findOperators = manifest.find((entry) => entry.name === 'find')?.completion.queryOperators ?? [];
    expect(findOperators).toContainEqual({
      name: 'STRING_MATCH',
      summary: expect.stringContaining('indexed Node text'),
    });
    expect(findOperators.some((entry) => entry.name === 'EDITED_BY')).toBe(false);
    expect(manifest.find((entry) => entry.name === 'get')?.completion.queryOperators).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  test('bounds summary capability discovery with explicit omission evidence', async () => {
    const root = await makeRoot();
    const output = captureIo();
    expect(await runOutlineCli(['capabilities'], {
      runtimeRoot: root,
      io: output.io,
    })).toBe(0);
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(4 * 1024);
    expect(output.stdout).toContain('version\tPrint CLI');
    expect(output.stdout).toContain('create\tCreate one complete Node tree');
    expect(output.stdout).not.toContain('Omitted lines:');
    expect(await readdir(root)).toEqual([]);
  });

  test('suggests the nearest command, option, or exact help for invalid argv', async () => {
    const root = await makeRoot();
    const family = captureIo();
    const command = captureIo();
    const option = captureIo();
    const missing = captureIo();

    expect(await runOutlineCli(['searh'], { runtimeRoot: root, io: family.io })).toBe(2);
    expect(family.stderr).toContain('Did you mean "search"?');
    expect(await runOutlineCli(['search', 'creat'], { runtimeRoot: root, io: command.io })).toBe(2);
    expect(command.stderr).toContain('Did you mean "search create"?');
    expect(await runOutlineCli(['search', 'create', '--mach', 'module'], { runtimeRoot: root, io: option.io })).toBe(2);
    expect(option.stderr).toContain('Did you mean --match?');
    expect(option.stderr).toContain('outline search create --help');
    expect(await runOutlineCli(['view', 'sort', 'add'], { runtimeRoot: root, io: missing.io })).toBe(2);
    expect(missing.stderr).toContain('Did you mean "view set"?');
    expect(await readdir(root)).toEqual([]);
  });

  test('maps argv and protocol failures to stable JSON error envelopes and exit codes', async () => {
    const root = await makeRoot();
    const protocol = captureIo();
    const usage = captureIo();

    expect(await runOutlineCli(['--json', '--protocol', '2', 'version'], {
      runtimeRoot: root,
      io: protocol.io,
    })).toBe(6);
    expect(JSON.parse(protocol.stdout)).toMatchObject({
      ok: false,
      error: { code: 'protocol_incompatible', category: 'protocol' },
    });
    expect(protocol.stderr).toBe('');

    expect(await runOutlineCli(['--json', 'version', 'extra'], { runtimeRoot: root, io: usage.io })).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      ok: false,
      command: 'version',
      error: { code: 'invalid_input', category: 'usage' },
    });
  });

  test('compares bundled and live capability registries through one Runtime client', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const output = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'capabilities', '--runtime'], {
        runtimeRoot: root,
        io: output.io,
      })).toBe(0);
      expect(JSON.parse(output.stdout).data).toHaveLength(OUTLINE_CAPABILITIES.length);
    } finally {
      await runtime.stop();
    }
  });

  test('queries history by idempotency key and runs guarded revert, undo, and redo', async () => {
    const runningRoot = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root: runningRoot, contentRoot: `${runningRoot}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const created = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'create', '--parent', '@today', '--idempotency-key', 'cli:history', 'History item',
      ], { runtimeRoot: runningRoot, io: created.io })).toBe(0);
      const createdOperation = JSON.parse(created.stdout).data.settlement;

      const log = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'history', '--idempotency-key', 'cli:history'], {
        runtimeRoot: runningRoot,
        io: log.io,
      })).toBe(0);
      expect(JSON.parse(log.stdout)).toMatchObject({
        ok: true,
        command: 'history',
        data: { operations: [{ operationId: createdOperation.operationId }] },
      });
      const missingLog = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'history', '--idempotency-key', 'cli:missing'], {
        runtimeRoot: runningRoot,
        io: missingLog.io,
      })).toBe(0);
      expect(JSON.parse(missingLog.stdout).data).toEqual({ operations: [] });

      const reverted = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'revert', createdOperation.operationId, '--idempotency-key', 'cli:revert-history',
      ], {
        runtimeRoot: runningRoot,
        io: reverted.io,
      })).toBe(0);
      const revertOperation = JSON.parse(reverted.stdout).data;
      expect(revertOperation.revertsOperationId).toBe(createdOperation.operationId);
      const repeatedRevert = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'revert', createdOperation.operationId, '--idempotency-key', 'cli:revert-history',
      ], { runtimeRoot: runningRoot, io: repeatedRevert.io })).toBe(0);
      expect(JSON.parse(repeatedRevert.stdout).data.operationId).toBe(revertOperation.operationId);

      const second = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'create', '--parent', '@today', 'Undo item'], {
        runtimeRoot: runningRoot,
        io: second.io,
      })).toBe(0);
      const secondOperation = JSON.parse(second.stdout).data.settlement;
      const undone = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'undo', '--origin', 'own',
        '--expect-operation', secondOperation.operationId,
        '--idempotency-key', 'cli:undo-history',
      ], {
        runtimeRoot: runningRoot,
        io: undone.io,
      })).toBe(0);
      const undoOperation = JSON.parse(undone.stdout).data;
      expect(undoOperation.revertsOperationId).toBe(secondOperation.operationId);
      const repeatedUndo = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'undo', '--origin', 'own',
        '--expect-operation', secondOperation.operationId,
        '--idempotency-key', 'cli:undo-history',
      ], {
        runtimeRoot: runningRoot,
        io: repeatedUndo.io,
      })).toBe(0);
      expect(JSON.parse(repeatedUndo.stdout).data.operationId).toBe(undoOperation.operationId);

      const redone = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'redo', '--origin', 'own',
        '--expect-operation', undoOperation.operationId,
        '--idempotency-key', 'cli:redo-history',
      ], {
        runtimeRoot: runningRoot,
        io: redone.io,
      })).toBe(0);
      const redoOperation = JSON.parse(redone.stdout).data;
      expect(redoOperation.revertsOperationId).toBe(undoOperation.operationId);
      const repeatedRedo = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'redo', '--origin', 'own',
        '--expect-operation', undoOperation.operationId,
        '--idempotency-key', 'cli:redo-history',
      ], {
        runtimeRoot: runningRoot,
        io: repeatedRedo.io,
      })).toBe(0);
      expect(JSON.parse(repeatedRedo.stdout).data.operationId).toBe(redoOperation.operationId);
    } finally {
      await runtime.stop();
    }

    const absentRoot = await makeRoot();
    const absent = captureIo();
    expect(await runOutlineCli(['--json', '--no-start', 'history'], {
      runtimeRoot: absentRoot,
      io: absent.io,
    })).toBe(5);
    expect(JSON.parse(absent.stdout)).toMatchObject({
      ok: false,
      command: 'history',
      error: { code: 'runtime_unavailable', category: 'unavailable' },
    });
  });

  test('recovers an auto-keyed mutation when the committed response is lost', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const originalHandle = runtime.router.handle.bind(runtime.router);
    let dropCommittedResponse = true;
    runtime.router.handle = async (value, context) => {
      const result = await originalHandle(value, context);
      if (dropCommittedResponse
        && result.ok
        && result.data
        && typeof result.data === 'object'
        && ['outline.operation', 'outline.create-result'].includes(String((result.data as { kind?: unknown }).kind))) {
        dropCommittedResponse = false;
        for (const connection of (runtime as unknown as {
          connections: Set<{ destroy: () => void }>;
        }).connections) connection.destroy();
      }
      return result;
    };
    try {
      const lost = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'create', '@today', 'Lost acknowledgement'], {
        runtimeRoot: root,
        io: lost.io,
      })).toBe(7);
      const failure = JSON.parse(lost.stdout);
      const idempotencyKey = failure.error.details.idempotencyKey as string;
      expect(failure).toMatchObject({
        ok: false,
        command: 'create',
        error: {
          code: 'operation_settlement_unknown',
          retryable: false,
          details: { idempotencyKey: expect.stringMatching(/^cli:/) },
          next: [`outline history --idempotency-key '${idempotencyKey}'`],
        },
      });
      expect(runtime.workspace.projection().nodes).toContainEqual(
        expect.objectContaining({ content: expect.objectContaining({ text: 'Lost acknowledgement' }) }),
      );

      const recovered = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'history', '--idempotency-key', idempotencyKey], {
        runtimeRoot: root,
        io: recovered.io,
      })).toBe(0);
      expect(JSON.parse(recovered.stdout).data.operations).toHaveLength(1);
    } finally {
      runtime.router.handle = originalHandle;
      await runtime.stop();
    }
  });

  test('returns a typed non-writing conflict Diff when guarded revert preconditions changed', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const created = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'create', '@today', 'Conflict target',
      ], { runtimeRoot: root, io: created.io })).toBe(0);
      const createResult = JSON.parse(created.stdout).data;
      const nodeId = createResult.rootId as string;
      const operationId = createResult.settlement.operationId as string;

      const changed = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'edit', nodeId, '--description', 'Changed later',
      ], { runtimeRoot: root, io: changed.io })).toBe(0);
      const reverted = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'revert', operationId,
      ], { runtimeRoot: root, io: reverted.io })).toBe(3);
      expect(JSON.parse(reverted.stdout)).toMatchObject({
        ok: false,
        command: 'revert',
        error: {
          code: 'revert_conflict',
          details: {
            conflictDiff: {
              kind: 'outline.revert-conflict-diff',
              operationId,
              changedPreconditions: [{
                id: nodeId,
                expectedAfterDigest: expect.any(String),
                actualDigest: expect.any(String),
              }],
            },
          },
        },
      });
      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'get', nodeId, '--include', 'description'], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data.nodes[0].description).toBe('Changed later');
    } finally {
      await runtime.stop();
    }
  });

  test('reads structured input from stdin only when explicitly requested', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const explicit = captureIo('{not json');
    const missing = captureIo('{not json');

    try {
      expect(await runOutlineCli(['--json', '--no-start', 'preview', '--input', '-'], {
        runtimeRoot: root,
        io: explicit.io,
      })).toBe(2);
      expect(explicit.stdinReads).toBe(1);
      expect(JSON.parse(explicit.stdout).error.code).toBe('invalid_input');

      expect(await runOutlineCli(['--json', '--no-start', 'diff'], {
        runtimeRoot: root,
        io: missing.io,
      })).toBe(2);
      expect(missing.stdinReads).toBe(0);
    } finally {
      await runtime.stop();
    }
  });

  test('runs read, direct commit, Diff, apply, and streaming export through the public CLI grammar', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const changeSet = createTodayChangeSet('CLI searchable result');
      const preview = captureIo(JSON.stringify(changeSet));
      expect(await runOutlineCli(['--json', '--no-start', 'preview', '--input', '-'], {
        runtimeRoot: root,
        io: preview.io,
      })).toBe(0);
      const diff = JSON.parse(preview.stdout).data as Diff;
      expect(diff.kind).toBe('outline.diff');

      const applied = captureIo(JSON.stringify(diff));
      expect(await runOutlineCli(['--json', '--no-start', 'apply', '--input', '-'], {
        runtimeRoot: root,
        io: applied.io,
      })).toBe(0);
      const operation = JSON.parse(applied.stdout).data;
      expect(operation).toMatchObject({ kind: 'outline.operation', origin: 'local-user' });

      const committed = captureIo(JSON.stringify(createTodayChangeSet('CLI committed result')));
      expect(await runOutlineCli(['--json', '--no-start', 'transact', '--input', '-'], {
        runtimeRoot: root,
        io: committed.io,
      })).toBe(0);
      expect(JSON.parse(committed.stdout).data).toMatchObject({
        kind: 'outline.operation',
        origin: 'local-user',
      });

      const jsonFind = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'find', 'CLI searchable result'], {
        runtimeRoot: root,
        io: jsonFind.io,
      })).toBe(0);
      const foundNodes = JSON.parse(jsonFind.stdout).data.nodes;
      expect(foundNodes).toContainEqual(expect.objectContaining({ text: 'CLI searchable result' }));

      const committedFind = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'find', 'CLI committed result'], {
        runtimeRoot: root,
        io: committedFind.io,
      })).toBe(0);
      expect(JSON.parse(committedFind.stdout).data.nodes)
        .toContainEqual(expect.objectContaining({ text: 'CLI committed result' }));

      const summaryFind = captureIo();
      expect(await runOutlineCli(['--no-start', 'find', 'CLI searchable result'], {
        runtimeRoot: root,
        io: summaryFind.io,
      })).toBe(0);
      expect(summaryFind.stdout).toContain('Command: find');
      expect(summaryFind.stdout).toContain(`Nodes: ${foundNodes.length};`);
      expect(summaryFind.stdout).toContain('text=CLI searchable result');

      const literalHelp = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'create', '@today', '--', '--help'], {
        runtimeRoot: root,
        io: literalHelp.io,
      })).toBe(0);
      expect(JSON.parse(literalHelp.stdout).data).toMatchObject({
        kind: 'outline.create-result', committed: true, verification: { passed: true },
      });
      expect(Object.values(runtime.workspace.documentState().nodes))
        .toContainEqual(expect.objectContaining({ content: expect.objectContaining({ text: '--help' }) }));

      const missingRawExport = captureIo();
      expect(await runOutlineCli(['--no-start', 'export', 'node:missing', '--output', '-'], {
        runtimeRoot: root,
        io: missingRawExport.io,
      })).toBe(3);
      expect(missingRawExport.stdout).toBe('');
      expect(missingRawExport.binaryStdout).toHaveLength(0);
      expect(missingRawExport.stderr).toContain('[not_found]');

      const nodeId = diff.bindings.created?.[0];
      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'get', nodeId!], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data.nodes[0]).toMatchObject({ id: nodeId });

      const streamed = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'export', '@today', '--format', 'jsonl', '--depth', '1', '--limit', '100',
      ], { runtimeRoot: root, io: streamed.io })).toBe(0);
      const records = streamed.stdout.trim().split('\n').map((line) => JSON.parse(line) as unknown);
      expect(records.every((record) => Value.Check(OutlineStreamRecordSchema, record))).toBe(true);
      expect(records).toContainEqual(expect.objectContaining({ type: 'data', data: expect.objectContaining({ id: nodeId }) }));

      const markdownPath = path.join(root, 'today.md');
      const exported = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'export', '@today', '--format', 'markdown', '--depth', '1', '--output', markdownPath,
      ], { runtimeRoot: root, io: exported.io })).toBe(0);
      expect(JSON.parse(exported.stdout).data.path).toBe(markdownPath);
      expect(await readFile(markdownPath, 'utf8')).toContain('CLI searchable result');
    } finally {
      await runtime.stop();
    }
  });

  test('runs exact and batch counts, live Saved Searches, and multi-ID reads through the CLI', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const add = async (text: string) => {
      const output = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'create', '@today', text], {
        runtimeRoot: root,
        io: output.io,
      })).toBe(0);
      return Object.values(runtime.workspace.documentState().nodes)
        .find((node) => node.content.text === text)!.id;
    };
    try {
      const alphaId = await add('Batch scope alpha');
      const betaId = await add('Batch scope beta');
      await add('Outside scope alpha');

      const count = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'find', 'Batch scope', '--count'], {
        runtimeRoot: root,
        io: count.io,
      })).toBe(0);
      expect(JSON.parse(count.stdout).data).toEqual(expect.objectContaining({
        kind: 'outline.count',
        exact: true,
        count: 2,
      }));

      const batchRequest = {
        mode: 'count',
        sharedQuery: { kind: 'rule', op: 'STRING_MATCH', text: 'Batch scope' },
        queries: [
          { name: 'alpha', query: { kind: 'rule', op: 'STRING_MATCH', text: 'alpha' } },
          { name: 'beta', query: { kind: 'rule', op: 'STRING_MATCH', text: 'beta' } },
        ],
      };
      const batch = captureIo(JSON.stringify(batchRequest));
      expect(await runOutlineCli(['--json', '--no-start', 'find', '--input', '-'], {
        runtimeRoot: root,
        io: batch.io,
      })).toBe(0);
      expect(JSON.parse(batch.stdout).data).toMatchObject({
        kind: 'outline.batch-count',
        exact: true,
        counts: [{ name: 'alpha', count: 1 }, { name: 'beta', count: 1 }],
      });

      const duplicateNames = captureIo(JSON.stringify({
        ...batchRequest,
        queries: [
          { name: 'same', query: { kind: 'rule', op: 'STRING_MATCH', text: 'alpha' } },
          { name: 'same', query: { kind: 'rule', op: 'STRING_MATCH', text: 'beta' } },
        ],
      }));
      expect(await runOutlineCli(['--json', '--no-start', 'find', '--input', '-'], {
        runtimeRoot: root,
        io: duplicateNames.io,
      })).toBe(2);
      expect(JSON.parse(duplicateNames.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', message: expect.stringContaining('names must be unique') },
      });

      const missingMode = captureIo(JSON.stringify({
        queries: batchRequest.queries,
      }));
      expect(await runOutlineCli(['--json', '--no-start', 'find', '--input', '-'], {
        runtimeRoot: root,
        io: missingMode.io,
      })).toBe(2);
      expect(JSON.parse(missingMode.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });

      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'get', betaId, alphaId], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data.nodes.map((node: { id: string }) => node.id)).toEqual([betaId, alphaId]);

      const projection = {
        kind: 'summary',
        targets: {
          target: {
            selector: { by: 'ids', ids: [betaId, alphaId] },
            cardinality: 'many',
            max: 2,
          },
        },
        page: { limit: 2 },
      };
      const projectionOnlyShow = captureIo(JSON.stringify(projection));
      expect(await runOutlineCli(['--json', '--no-start', 'get', '--projection', '-'], {
        runtimeRoot: root,
        io: projectionOnlyShow.io,
      })).toBe(0);
      expect(JSON.parse(projectionOnlyShow.stdout).data.nodes.map((node: { id: string }) => node.id))
        .toEqual([betaId, alphaId]);

      const projectionOnlyExport = captureIo(JSON.stringify({ ...projection, kind: 'export', format: 'json' }));
      expect(await runOutlineCli(['--json', '--no-start', 'export', '--projection', '-'], {
        runtimeRoot: root,
        io: projectionOnlyExport.io,
      })).toBe(0);
      const exportRecords = projectionOnlyExport.stdout.trim().split('\n').map((line) => JSON.parse(line));
      expect(exportRecords.find((record) => record.type === 'data')?.data.nodes
        .map((node: { id: string }) => node.id)).toEqual([betaId, alphaId]);

      const conflicting = captureIo(JSON.stringify({
        ...projection,
        targets: {
          target: {
            selector: { by: 'id', id: alphaId },
            cardinality: 'one',
          },
        },
      }));
      expect(await runOutlineCli([
        '--json', '--no-start', 'get', betaId, '--projection', '-',
      ], { runtimeRoot: root, io: conflicting.io })).toBe(2);
      expect(JSON.parse(conflicting.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'get Selector conflicts with the Selector declared by --projection.',
        },
      });

      await add('live-module first');
      const createdSearch = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'search', 'create', '--title', 'Live module query', '--match', 'live-module',
      ], { runtimeRoot: root, io: createdSearch.io })).toBe(0);
      const searchId = Object.values(runtime.workspace.documentState().nodes)
        .find((node) => node.type === 'search' && node.content.text === 'Live module query')!.id;
      const laterId = await add('live-module added later');
      const state = runtime.workspace.documentState();
      expect(state.nodes[searchId]!.children
        .map((childId) => state.nodes[childId])
        .filter((node) => node?.type === 'reference')
        .map((node) => node.targetId)).not.toContain(laterId);

      const liveCount = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'find', '--search', searchId, '--count'], {
        runtimeRoot: root,
        io: liveCount.io,
      })).toBe(0);
      expect(JSON.parse(liveCount.stdout).data.count).toBe(2);

      const liveNodes = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'find', '--search', searchId, '--limit', '10'], {
        runtimeRoot: root,
        io: liveNodes.io,
      })).toBe(0);
      expect(JSON.parse(liveNodes.stdout).data.nodes.map((node: { id: string }) => node.id)).toContain(laterId);
    } finally {
      await runtime.stop();
    }
  });

  test('ensures and reads a Daily Note through the real CLI path', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const ensured = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'daily', 'ensure', '--date', '2040-02-29',
      ], { runtimeRoot: root, io: ensured.io })).toBe(0);
      expect(JSON.parse(ensured.stdout).data).toMatchObject({
        kind: 'outline.operation',
        affectedNodeCount: expect.any(Number),
      });

      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'get', '@date:2040-02-29'], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data.nodes[0]).toMatchObject({ content: { text: '2040-02-29' } });
    } finally {
      await runtime.stop();
    }
  });

  test('validates JSONL ChangeSet framing and writes a reviewed Diff atomically', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const changeSet = createTodayChangeSet('JSONL framed input');
      const { operations, ...header } = changeSet;
      const input = [
        JSON.stringify(header),
        ...operations.map((operation) => JSON.stringify({ operation })),
        JSON.stringify({ operationCount: operations.length, sha256: canonicalSha256(changeSet) }),
        '',
      ].join('\n');
      const outputPath = path.join(root, 'reviewed.diff.json');
      const output = captureIo(input);
      expect(await runOutlineCli([
        '--json', '--no-start', 'preview', '--input', '-', '--input-format', 'jsonl', '--output', outputPath,
      ], { runtimeRoot: root, io: output.io })).toBe(0);
      expect(JSON.parse(output.stdout).data).toMatchObject({ path: outputPath, sha256: expect.any(String) });
      expect((JSON.parse(await readFile(outputPath, 'utf8')) as Diff).kind).toBe('outline.diff');

      const summaryPath = path.join(root, 'reviewed-summary.diff.json');
      const summary = captureIo(JSON.stringify(changeSet));
      expect(await runOutlineCli([
        '--no-start', 'preview', '--input', '-', '--output', summaryPath,
      ], { runtimeRoot: root, io: summary.io })).toBe(0);
      expect(Buffer.byteLength(summary.stdout)).toBeLessThanOrEqual(4 * 1024);
      expect(summary.stdout).toContain(`Artifact: ${summaryPath}`);
      expect(summary.stdout).toContain('Diff: ');
      expect(summary.stdout).toContain('create=1');
      const summaryBytes = await readFile(summaryPath);
      const summaryArtifact = /Artifact: .*; bytes=(\d+); sha256=([a-f0-9]{64})/u.exec(summary.stdout);
      expect(summaryArtifact).not.toBeNull();
      expect(summaryBytes.byteLength).toBe(Number(summaryArtifact![1]));
      expect(createHash('sha256').update(summaryBytes).digest('hex')).toBe(summaryArtifact![2]);
      expect((JSON.parse(summaryBytes.toString('utf8')) as Diff).kind).toBe('outline.diff');

      const corrupted = captureIo(input.replace(canonicalSha256(changeSet), '0'.repeat(64)));
      expect(await runOutlineCli([
        '--json', '--no-start', 'preview', '--input', '-', '--input-format', 'jsonl',
      ], { runtimeRoot: root, io: corrupted.io })).toBe(2);
      expect(JSON.parse(corrupted.stdout).error.message).toContain('SHA-256');
    } finally {
      await runtime.stop();
    }
  });

  test('requires an output artifact and streams a canonical Diff larger than 8 MiB', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const largeText = 'x'.repeat(4_194_304);
      const changeSet: ChangeSet = {
        protocolVersion: 1,
        kind: 'outline.changeset',
        operations: [{
          op: 'create',
          placement: { kind: 'last', parent: { target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' } } },
          nodes: [
            { content: { text: largeText, marks: [], inlineRefs: [] }, children: [] },
            { content: { text: largeText, marks: [], inlineRefs: [] }, children: [] },
          ],
        }],
      };
      const raw = JSON.stringify(changeSet);
      const inline = captureIo(raw);
      expect(await runOutlineCli(['--json', '--no-start', 'preview', '--input', '-'], {
        runtimeRoot: root,
        io: inline.io,
      })).toBe(2);
      expect(JSON.parse(inline.stdout).error.message).toContain('exceeds 8 MiB');

      const outputPath = path.join(root, 'large.diff.json');
      const output = captureIo(raw);
      expect(await runOutlineCli([
        '--json', '--no-start', 'preview', '--input', '-', '--output', outputPath,
      ], { runtimeRoot: root, io: output.io })).toBe(0);
      const result = JSON.parse(output.stdout).data;
      const byteCount = result.byteCount as number;
      const sha256 = result.sha256 as string;
      expect(result.path).toBe(outputPath);
      expect(typeof byteCount).toBe('number');
      expect(typeof sha256).toBe('string');
      expect(byteCount).toBeGreaterThan(8 * 1024 * 1024);
      expect((await stat(outputPath)).size).toBe(byteCount);
      const artifactBytes = await readFile(outputPath);
      expect(createHash('sha256').update(artifactBytes).digest('hex')).toBe(sha256);
      const diff = JSON.parse(await readFile(outputPath, 'utf8')) as Diff;
      expect(canonicalSha256(diff)).toBe(sha256);
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  test('streams asset ingest, get, and verified export through the Runtime', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const sourcePath = path.join(root, 'source.txt');
      const sourceBytes = Buffer.from('asset path bytes');
      await writeFile(sourcePath, sourceBytes);
      const ingested = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'asset', 'ingest', sourcePath], {
        runtimeRoot: root,
        io: ingested.io,
      })).toBe(0);
      const lease = JSON.parse(ingested.stdout).data;
      expect(lease.leaseId).toMatch(/^lease:/);
      expect(lease.assetId).toMatch(/^asset:/);
      expect(lease.metadata).toMatchObject({ byteSize: sourceBytes.byteLength, mimeType: 'text/plain' });

      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'asset', 'get', lease.assetId], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data).toMatchObject({
        kind: 'outline.asset',
        assetId: lease.assetId,
        metadata: { byteSize: sourceBytes.byteLength },
      });

      const outputPath = path.join(root, 'exported.txt');
      const exported = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'asset', 'export', lease.assetId, '--output', outputPath,
      ], { runtimeRoot: root, io: exported.io })).toBe(0);
      const exportResult = JSON.parse(exported.stdout).data;
      expect(exportResult).toMatchObject({
        path: outputPath,
        byteCount: sourceBytes.byteLength,
      });
      expect(exportResult).not.toHaveProperty('sha256');
      expect(exportResult).not.toHaveProperty('digest');
      expect(exportResult).not.toHaveProperty('anchorId');
      expect(await readFile(outputPath)).toEqual(sourceBytes);

      const stdinBytes = Buffer.from([0, 1, 2, 3, 255]);
      const stdinIngest = captureIo(stdinBytes);
      expect(await runOutlineCli(['--json', '--no-start', 'asset', 'ingest', '-'], {
        runtimeRoot: root,
        io: stdinIngest.io,
      })).toBe(0);
      const stdinLease = JSON.parse(stdinIngest.stdout).data;
      expect(stdinLease.metadata.byteSize).toBe(stdinBytes.byteLength);
      expect(stdinIngest.stdinReads).toBe(1);

      const stdoutExport = captureIo();
      expect(await runOutlineCli([
        '--no-start', 'asset', 'export', stdinLease.assetId, '--output', '-',
      ], { runtimeRoot: root, io: stdoutExport.io })).toBe(0);
      expect(stdoutExport.binaryStdout).toEqual(stdinBytes);
      expect(stdoutExport.stdout).toBe('');

      const missingRawExport = captureIo();
      expect(await runOutlineCli([
        '--no-start', 'asset', 'export', 'asset:missing', '--output', '-',
      ], { runtimeRoot: root, io: missingRawExport.io })).toBe(3);
      expect(missingRawExport.stdout).toBe('');
      expect(missingRawExport.binaryStdout).toHaveLength(0);
      expect(missingRawExport.stderr).toContain('[not_found]');
    } finally {
      await runtime.stop();
    }
  });

  test('forwards shell Item attestation outside public input and records Agent causation', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const causation = { threadId: 'thread:cli', turnId: 'turn:cli', itemId: 'item:cli' };
      const token = issueOutlineAgentAttestation({
        descriptor: runtime.descriptor,
        runtimeRoot: root,
        causation,
      });
      const environment = { [OUTLINE_AGENT_ATTESTATION_ENV]: token };
      const preview = captureIo(JSON.stringify(createTodayChangeSet('CLI Agent write')));
      expect(await runOutlineCli(['--json', '--no-start', 'preview', '--input', '-'], {
        runtimeRoot: root,
        env: environment,
        io: preview.io,
      })).toBe(0);
      const applied = captureIo(JSON.stringify(JSON.parse(preview.stdout).data));
      expect(await runOutlineCli(['--json', '--no-start', 'apply', '--input', '-'], {
        runtimeRoot: root,
        env: environment,
        io: applied.io,
      })).toBe(0);
      expect(JSON.parse(applied.stdout).data).toMatchObject({
        origin: 'built-in-agent',
        causation,
      });
      expect(preview.stdout).not.toContain(token);
      expect(applied.stdout).not.toContain(token);
    } finally {
      await runtime.stop();
    }
  });

  test('runs the real entry as a thin local process with clean stdout', async () => {
    const root = await makeRoot();
    const child = Bun.spawn([process.execPath, cliEntry, '--json', 'version'], {
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: 'version' });
    expect(await readdir(root)).toEqual([]);
  });

  test('aborts an ordinary read with code 143 on SIGTERM', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    let startRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startRead = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    runtime.router.register('get', async () => {
      startRead?.();
      await blocked;
      return { invalidAfterCancellation: true };
    });
    const child = Bun.spawn([
      process.execPath, cliEntry, '--json', '--no-start', '--timeout', '300000', 'get', '@today',
    ], {
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    try {
      await withTimeout(started, 2_000, 'Ordinary read did not reach Runtime');
      child.kill('SIGTERM');
      expect(await child.exited).toBe(143);
      expect(await stdoutPromise).toBe('');
      expect(await stderrPromise).toBe('');
    } finally {
      releaseRead?.();
      child.kill();
      await runtime.stop();
    }
  });

  test('aborts a blocked stdin read with code 143 on SIGTERM', async () => {
    const root = await makeRoot();
    const child = Bun.spawn([
      process.execPath, cliEntry, '--json', '--no-start', 'apply', '--input', '-',
    ], {
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: root },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      child.kill('SIGTERM');
      expect(await child.exited).toBe(143);
      expect(await stdoutPromise).toBe('');
      expect(await stderrPromise).toBe('');
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

  test('aborts a dispatched ordinary write with recovery guidance on SIGINT', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const originalHandle = runtime.router.handle.bind(runtime.router);
    let startWrite: (() => void) | undefined;
    let releaseWrite: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startWrite = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    runtime.router.handle = async (value, context) => {
      const result = await originalHandle(value, context);
      if (result.ok
        && result.data
        && typeof result.data === 'object'
        && ['outline.operation', 'outline.create-result'].includes(String((result.data as { kind?: unknown }).kind))) {
        startWrite?.();
        await blocked;
      }
      return result;
    };
    const child = Bun.spawn([
      process.execPath, cliEntry, '--json', '--no-start', '--timeout', '300000',
      'create', '@today', 'Interrupted after commit',
    ], {
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    try {
      await withTimeout(started, 2_000, 'Ordinary write did not commit in Runtime');
      child.kill('SIGINT');
      expect(await child.exited).toBe(130);
      const failure = JSON.parse(await stdoutPromise);
      expect(failure).toMatchObject({
        ok: false,
        command: 'create',
        error: {
          code: 'operation_settlement_unknown',
          details: { idempotencyKey: expect.stringMatching(/^cli:/) },
        },
      });
      expect(await stderrPromise).toBe('');
    } finally {
      releaseWrite?.();
      runtime.router.handle = originalHandle;
      child.kill();
      await runtime.stop();
    }
  });

  test('exits a real watch process with code 130 on SIGINT', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const child = Bun.spawn([process.execPath, cliEntry, '--json', '--no-start', 'watch'], {
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    const stderrPromise = new Response(child.stderr).text();
    try {
      const firstOutput = await readUntil(reader, '"type":"hello"');
      expect(firstOutput).toContain('"type":"hello"');
      child.kill('SIGINT');
      expect(await child.exited).toBe(130);
      expect(await stderrPromise).toBe('');
    } finally {
      child.kill();
      reader.releaseLock();
      await runtime.stop();
    }
  });

  test('exits a real watch process with code 143 on SIGTERM', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const child = Bun.spawn([process.execPath, cliEntry, '--json', '--no-start', 'watch'], {
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    const stderrPromise = new Response(child.stderr).text();
    try {
      const firstOutput = await readUntil(reader, '"type":"hello"');
      expect(firstOutput).toContain('"type":"hello"');
      child.kill('SIGTERM');
      expect(await child.exited).toBe(143);
      expect(await stderrPromise).toBe('');
    } finally {
      child.kill();
      reader.releaseLock();
      await runtime.stop();
    }
  });

  test('keeps the app version constant aligned with package metadata', async () => {
    const packageJson = JSON.parse(await readFile(
      fileURLToPath(new URL('../../package.json', import.meta.url)),
      'utf8',
    )) as { version: string };
    expect(OUTLINE_APP_VERSION).toBe(packageJson.version);
  });
});

function captureIo(stdin: string | Uint8Array = '') {
  let stdout = '';
  const binaryStdout: Buffer[] = [];
  let stderr = '';
  let stdinReads = 0;
  const stdinBuffer = typeof stdin === 'string' ? Buffer.from(stdin) : Buffer.from(stdin);
  return {
    io: {
      stdout: (value: string) => { stdout += value; },
      stdoutBytes: (value: Uint8Array) => { binaryStdout.push(Buffer.from(value)); },
      stderr: (value: string) => { stderr += value; },
      readStdin: async () => {
        stdinReads += 1;
        return stdinBuffer.toString('utf8');
      },
      stdinBytes: () => (async function* () {
        stdinReads += 1;
        yield stdinBuffer;
      })(),
    },
    get stdout() { return stdout; },
    get binaryStdout() { return Buffer.concat(binaryStdout); },
    get stderr() { return stderr; },
    get stdinReads() { return stdinReads; },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  let output = '';
  while (!output.includes(expected)) {
    const next = await reader.read();
    if (next.done) break;
    output += Buffer.from(next.value).toString('utf8');
  }
  return output;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-cli-'));
  roots.push(root);
  return root;
}

function createTodayChangeSet(text: string): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [{
      op: 'create',
      placement: { kind: 'last', parent: {
        target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' },
      } },
      nodes: [{ content: { text, marks: [], inlineRefs: [] }, children: [] }],
      bind: 'created',
    }],
  };
}

function countObjectKey(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countObjectKey(entry, key), 0);
  return Object.entries(value).reduce((total, [entryKey, entry]) => (
    total + (entryKey === key ? 1 : 0) + countObjectKey(entry, key)
  ), 0);
}
