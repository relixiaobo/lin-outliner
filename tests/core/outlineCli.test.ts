import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Value } from 'typebox/value';
import { runOutlineCli } from '../../src/outline/cli';
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

  test('selects output mode from TTY state and explicit json or human overrides', async () => {
    const root = await makeRoot();
    const nonTty = captureIo();
    const forcedHuman = captureIo();
    const tty = captureIo();
    const forcedJson = captureIo();
    const conflict = captureIo();

    expect(await runOutlineCli(['version'], { runtimeRoot: root, io: nonTty.io })).toBe(0);
    expect(JSON.parse(nonTty.stdout)).toMatchObject({ ok: true, command: 'version' });
    expect(await runOutlineCli(['--human', 'version'], { runtimeRoot: root, io: forcedHuman.io })).toBe(0);
    expect(forcedHuman.stdout).toStartWith('outline 1.0.0');
    expect(await runOutlineCli(['version'], {
      runtimeRoot: root,
      io: { ...tty.io, interactive: true },
    })).toBe(0);
    expect(tty.stdout).toStartWith('outline 1.0.0');
    expect(await runOutlineCli(['--json', 'version'], {
      runtimeRoot: root,
      io: { ...forcedJson.io, interactive: true },
    })).toBe(0);
    expect(JSON.parse(forcedJson.stdout)).toMatchObject({ ok: true, command: 'version' });
    expect(await runOutlineCli(['--json', '--human', 'version'], {
      runtimeRoot: root,
      io: conflict.io,
    })).toBe(2);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
      expect(await runOutlineCli(['--json', '--no-start', 'add', '@today', 'Status health row'], {
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

    expect(await runOutlineCli(['--json', 'schema', 'Selector'], { runtimeRoot: root, io: selector.io })).toBe(0);
    expect(JSON.parse(selector.stdout).data.$defs.Selector.$id).toBe('Selector');
    expect(await runOutlineCli(['--json', 'schema', 'done', 'set'], { runtimeRoot: root, io: porcelain.io })).toBe(0);
    expect(JSON.parse(porcelain.stdout).data).toHaveProperty('request');
    expect(JSON.parse(porcelain.stdout).data).toHaveProperty('result');
    expect(await runOutlineCli(['--json', 'schema', 'search', 'create'], { runtimeRoot: root, io: search.io })).toBe(0);
    const searchSchema = JSON.stringify(JSON.parse(search.stdout).data.request);
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

  test('renders root help as discoverable command families without starting Runtime', async () => {
    const root = await makeRoot();
    const output = captureIo();
    const jsonOutput = captureIo();

    expect(await runOutlineCli(['--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(await runOutlineCli(['--json', '--help'], { runtimeRoot: root, io: jsonOutput.io })).toBe(0);
    expect(jsonOutput.stdout).toBe(output.stdout);
    expect(output.stdout).toContain('Command families:');
    expect(output.stdout).toContain('search         Create, configure, ensure, and refresh Saved Searches.');
    expect(output.stdout).toContain('text           Apply bounded, reviewed literal text transformations.');
    expect(output.stdout).toContain('view           Configure complete views');
    expect(output.stdout).toContain('Direct commands:');
    expect(output.stdout).toContain('schema         Print exact public JSON Schemas.');
    expect(output.stdout).not.toContain('COMMAND [ARGS]\n\nCommands:');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders search family help with its real subcommands', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['search', '--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stdout).toContain('Usage: outline [GLOBAL OPTIONS] search SUBCOMMAND [ARGS]');
    expect(output.stdout).toContain('create             Create a complete Saved Search');
    expect(output.stdout).toContain('ensure-tag         Ensure the canonical Saved Search');
    expect(output.stdout).toContain('refresh            Refresh materialized results');
    expect(output.stdout).toContain('set                Atomically patch a Search');
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
    expect(output.stdout).toContain('outline search create --input complete-search.json');
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
    const requestSchema = JSON.stringify(JSON.parse(schema.stdout).data.request);
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
    const requestSchema = JSON.stringify(JSON.parse(schema.stdout).data.request);
    expect(requestSchema).toContain('searchId');
    expect(requestSchema).toContain('sharedQuery');
    expect(requestSchema).toContain('queries');
    expect(requestSchema).not.toContain('changeSet');
    expect(await readdir(root)).toEqual([]);
  });

  test('renders exact view sort add help with default and structured forms', async () => {
    const root = await makeRoot();
    const output = captureIo();

    expect(await runOutlineCli(['view', 'sort', 'add', '--help'], { runtimeRoot: root, io: output.io })).toBe(0);
    expect(output.stdout).toContain('Usage: outline [GLOBAL OPTIONS] view sort add TARGET --field FIELD');
    expect(output.stdout).toContain('--target TARGET');
    expect(output.stdout).toContain('--field FIELD');
    expect(output.stdout).toContain('--direction asc|desc');
    expect(output.stdout).toContain('(default: asc)');
    expect(output.stdout).toContain('--input FILE|-');
    expect(output.stdout).toContain('outline view sort add node:projects --field sys:updatedAt --direction desc');
    expect(output.stdout).toContain('outline view sort add --input sort-rule.json');
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

  test('renders exact text replace help and schema from the same command contract', async () => {
    const root = await makeRoot();
    const help = captureIo();
    const schema = captureIo();

    expect(await runOutlineCli(['text', 'replace', '--help'], { runtimeRoot: root, io: help.io })).toBe(0);
    expect(help.stdout).toContain('Behavior: destructive; idempotent');
    expect(help.stdout).toContain('--matching TEXT');
    expect(help.stdout).toContain('--query JSON|FILE');
    expect(help.stdout).toContain('--max N');
    expect(help.stdout).toContain('--max-replacements N');
    expect(help.stdout).toContain('--field content|description|both');
    expect(help.stdout).toContain('--preview');
    expect(help.stdout).toContain('--expect-diff SHA256');
    expect(help.stdout).toContain('--yes alone is rejected');
    expect(help.stdout).toContain('outline text replace --matching "keyword 1" --max 500');
    expect(await runOutlineCli(['--json', 'schema', 'text', 'replace'], { runtimeRoot: root, io: schema.io })).toBe(0);
    const requestSchema = JSON.stringify(JSON.parse(schema.stdout).data.request);
    expect(requestSchema).toContain('maxReplacements');
    expect(requestSchema).toContain('caseSensitive');
    expect(requestSchema).not.toContain('changeSet');
    expect(await readdir(root)).toEqual([]);
  });

  test('derives placement and reference replacement help and schemas from their exact command contracts', async () => {
    const root = await makeRoot();
    const addHelp = captureIo();
    const moveHelp = captureIo();
    const referenceHelp = captureIo();
    const replaceHelp = captureIo();
    const addSchema = captureIo();
    const replaceSchema = captureIo();

    expect(await runOutlineCli(['add', '--help'], { runtimeRoot: root, io: addHelp.io })).toBe(0);
    expect(addHelp.stdout).toContain('--first');
    expect(addHelp.stdout).toContain('--last');
    expect(addHelp.stdout).toContain('--index INDEX');
    expect(addHelp.stdout).toContain('--before SIBLING');
    expect(addHelp.stdout).toContain('--after SIBLING');
    expect(addHelp.stdout).toContain('outline add --input complete-tree.json');

    expect(await runOutlineCli(['move', '--help'], { runtimeRoot: root, io: moveHelp.io })).toBe(0);
    expect(moveHelp.stdout).toContain('--previous');
    expect(moveHelp.stdout).toContain('--next');
    expect(moveHelp.stdout).toContain('zero-based index');

    expect(await runOutlineCli(['reference', '--help'], { runtimeRoot: root, io: referenceHelp.io })).toBe(0);
    expect(referenceHelp.stdout).toContain('replace');
    expect(referenceHelp.stdout).toContain('Replace one content Node with a tree reference');
    expect(await runOutlineCli(['reference', 'replace', '--help'], { runtimeRoot: root, io: replaceHelp.io })).toBe(0);
    expect(replaceHelp.stdout).toContain('Behavior: replace; not idempotent');
    expect(replaceHelp.stdout).toContain('outline reference replace node:draft node:canonical');

    expect(await runOutlineCli(['--json', 'schema', 'add'], { runtimeRoot: root, io: addSchema.io })).toBe(0);
    const addRequest = JSON.stringify(JSON.parse(addSchema.stdout).data.request);
    for (const placement of ['first', 'last', 'index', 'before', 'after']) {
      expect(addRequest).toContain(`\"const\":\"${placement}\"`);
    }
    expect(addRequest).not.toContain('\"const\":\"previous\"');
    expect(addRequest).not.toContain('\"const\":\"next\"');

    expect(await runOutlineCli(['--json', 'schema', 'reference', 'replace'], {
      runtimeRoot: root,
      io: replaceSchema.io,
    })).toBe(0);
    const replaceRequest = JSON.stringify(JSON.parse(replaceSchema.stdout).data.request);
    expect(replaceRequest).toContain('target');
    expect(replaceRequest).toContain('reference');
    expect(replaceRequest).not.toContain('changeSet');
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
    expect(manifest.find((entry) => entry.name === 'show')?.completion.queryOperators).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  test('suggests the nearest command, option, or exact help for invalid argv', async () => {
    const root = await makeRoot();
    const family = captureIo();
    const command = captureIo();
    const option = captureIo();
    const missing = captureIo();

    expect(await runOutlineCli(['--human', 'searh'], { runtimeRoot: root, io: family.io })).toBe(2);
    expect(family.stderr).toContain('Did you mean "search"?');
    expect(await runOutlineCli(['--human', 'search', 'creat'], { runtimeRoot: root, io: command.io })).toBe(2);
    expect(command.stderr).toContain('Did you mean "search create"?');
    expect(await runOutlineCli(['--human', 'search', 'create', '--mach', 'module'], { runtimeRoot: root, io: option.io })).toBe(2);
    expect(option.stderr).toContain('Did you mean --match?');
    expect(option.stderr).toContain('outline search create --help');
    expect(await runOutlineCli(['--human', 'view', 'sort', 'add'], { runtimeRoot: root, io: missing.io })).toBe(2);
    expect(missing.stderr).toContain('outline view sort add --help');
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
    const runtime = await OutlineRuntimeServer.start({ root: runningRoot, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const created = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'add', '--parent', '@today', '--idempotency-key', 'cli:history', 'History item',
      ], { runtimeRoot: runningRoot, io: created.io })).toBe(0);
      const createdOperation = JSON.parse(created.stdout).data;

      const log = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'log', '--idempotency-key', 'cli:history'], {
        runtimeRoot: runningRoot,
        io: log.io,
      })).toBe(0);
      expect(JSON.parse(log.stdout)).toMatchObject({
        ok: true,
        command: 'log',
        data: { operations: [{ operationId: createdOperation.operationId }] },
      });
      const missingLog = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'log', '--idempotency-key', 'cli:missing'], {
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
      expect(await runOutlineCli(['--json', '--no-start', 'add', '--parent', '@today', 'Undo item'], {
        runtimeRoot: runningRoot,
        io: second.io,
      })).toBe(0);
      const secondOperation = JSON.parse(second.stdout).data;
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
    expect(await runOutlineCli(['--json', '--no-start', 'log'], {
      runtimeRoot: absentRoot,
      io: absent.io,
    })).toBe(5);
    expect(JSON.parse(absent.stdout)).toMatchObject({
      ok: false,
      command: 'log',
      error: { code: 'runtime_unavailable', category: 'unavailable' },
    });
  });

  test('recovers an auto-keyed mutation when the committed response is lost', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
        && (result.data as { kind?: unknown }).kind === 'outline.operation') {
        dropCommittedResponse = false;
        for (const connection of (runtime as unknown as {
          connections: Set<{ destroy: () => void }>;
        }).connections) connection.destroy();
      }
      return result;
    };
    try {
      const lost = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'add', '@today', 'Lost acknowledgement'], {
        runtimeRoot: root,
        io: lost.io,
      })).toBe(7);
      const failure = JSON.parse(lost.stdout);
      const idempotencyKey = failure.error.details.idempotencyKey as string;
      expect(failure).toMatchObject({
        ok: false,
        command: 'add',
        error: {
          code: 'operation_settlement_unknown',
          retryable: false,
          details: { idempotencyKey: expect.stringMatching(/^cli:/) },
          next: [`outline log --idempotency-key '${idempotencyKey}'`],
        },
      });
      expect(runtime.workspace.projection().nodes).toContainEqual(
        expect.objectContaining({ content: expect.objectContaining({ text: 'Lost acknowledgement' }) }),
      );

      const recovered = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'log', '--idempotency-key', idempotencyKey], {
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const nodeId = `node:${crypto.randomUUID()}`;
      const created = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'add', '--parent', '@today', '--tree', JSON.stringify({
          id: nodeId,
          content: { text: 'Conflict target', marks: [], inlineRefs: [] },
          children: [],
        }),
      ], { runtimeRoot: root, io: created.io })).toBe(0);
      const operationId = JSON.parse(created.stdout).data.operationId as string;

      const changed = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'set', nodeId, '--description', 'Changed later',
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
      expect(await runOutlineCli(['--json', '--no-start', 'show', nodeId, '--include', 'description'], {
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const explicit = captureIo('{not json');
    const missing = captureIo('{not json');

    try {
      expect(await runOutlineCli(['--json', '--no-start', 'diff', '--input', '-'], {
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

  test('runs read, Diff, apply, and streaming export through the public CLI grammar', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const changeSet = createTodayChangeSet('CLI searchable result');
      const preview = captureIo(JSON.stringify(changeSet));
      expect(await runOutlineCli(['--json', '--no-start', 'diff', '--input', '-'], {
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

      const jsonFind = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'find', 'CLI searchable result'], {
        runtimeRoot: root,
        io: jsonFind.io,
      })).toBe(0);
      const foundNodes = JSON.parse(jsonFind.stdout).data.nodes;
      expect(foundNodes).toContainEqual(expect.objectContaining({ text: 'CLI searchable result' }));

      const humanFind = captureIo();
      expect(await runOutlineCli(['--human', '--no-start', 'find', 'CLI searchable result'], {
        runtimeRoot: root,
        io: humanFind.io,
      })).toBe(0);
      expect(JSON.parse(humanFind.stdout).nodes).toEqual(foundNodes);

      const nodeId = diff.bindings.created?.[0];
      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'show', nodeId!], {
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const add = async (text: string) => {
      const output = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'add', '@today', text], {
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

      const shown = captureIo();
      expect(await runOutlineCli(['--json', '--no-start', 'show', betaId, alphaId], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data.nodes.map((node: { id: string }) => node.id)).toEqual([betaId, alphaId]);

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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
      expect(await runOutlineCli(['--json', '--no-start', 'show', '@date:2040-02-29'], {
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
        '--json', '--no-start', 'diff', '--input', '-', '--input-format', 'jsonl', '--output', outputPath,
      ], { runtimeRoot: root, io: output.io })).toBe(0);
      expect(JSON.parse(output.stdout).data).toMatchObject({ path: outputPath, sha256: expect.any(String) });
      expect((JSON.parse(await readFile(outputPath, 'utf8')) as Diff).kind).toBe('outline.diff');

      const corrupted = captureIo(input.replace(canonicalSha256(changeSet), '0'.repeat(64)));
      expect(await runOutlineCli([
        '--json', '--no-start', 'diff', '--input', '-', '--input-format', 'jsonl',
      ], { runtimeRoot: root, io: corrupted.io })).toBe(2);
      expect(JSON.parse(corrupted.stdout).error.message).toContain('SHA-256');
    } finally {
      await runtime.stop();
    }
  });

  test('requires an output artifact and streams a canonical Diff larger than 8 MiB', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
      expect(await runOutlineCli(['--json', '--no-start', 'diff', '--input', '-'], {
        runtimeRoot: root,
        io: inline.io,
      })).toBe(2);
      expect(JSON.parse(inline.stdout).error.message).toContain('exceeds 8 MiB');

      const outputPath = path.join(root, 'large.diff.json');
      const output = captureIo(raw);
      expect(await runOutlineCli([
        '--json', '--no-start', 'diff', '--input', '-', '--output', outputPath,
      ], { runtimeRoot: root, io: output.io })).toBe(0);
      const result = JSON.parse(output.stdout).data;
      const byteCount = result.byteCount as number;
      const sha256 = result.sha256 as string;
      expect(result.path).toBe(outputPath);
      expect(typeof byteCount).toBe('number');
      expect(typeof sha256).toBe('string');
      expect(byteCount).toBeGreaterThan(8 * 1024 * 1024);
      expect((await stat(outputPath)).size).toBe(byteCount + 1);
      const diff = JSON.parse(await readFile(outputPath, 'utf8')) as Diff;
      expect(canonicalSha256(diff)).toBe(sha256);
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  test('streams asset ingest, show, and verified export through the Runtime', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
      expect(await runOutlineCli(['--json', '--no-start', 'asset', 'show', lease.assetId], {
        runtimeRoot: root,
        io: shown.io,
      })).toBe(0);
      expect(JSON.parse(shown.stdout).data).toMatchObject({
        kind: 'outline.asset',
        assetId: lease.assetId,
        metadata: { sha256: lease.metadata.sha256 },
      });

      const outputPath = path.join(root, 'exported.txt');
      const exported = captureIo();
      expect(await runOutlineCli([
        '--json', '--no-start', 'asset', 'export', lease.assetId, '--output', outputPath,
      ], { runtimeRoot: root, io: exported.io })).toBe(0);
      expect(JSON.parse(exported.stdout).data).toMatchObject({
        path: outputPath,
        byteCount: sourceBytes.byteLength,
        sha256: lease.metadata.sha256,
      });
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
    } finally {
      await runtime.stop();
    }
  });

  test('forwards shell Item attestation outside public input and records Agent causation', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
      expect(await runOutlineCli(['--json', '--no-start', 'diff', '--input', '-'], {
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    let startRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startRead = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    runtime.router.register('show', async () => {
      startRead?.();
      await blocked;
      return { invalidAfterCancellation: true };
    });
    const child = Bun.spawn([
      process.execPath, cliEntry, '--json', '--no-start', '--timeout', '300000', 'show', '@today',
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
        && (result.data as { kind?: unknown }).kind === 'outline.operation') {
        startWrite?.();
        await blocked;
      }
      return result;
    };
    const child = Bun.spawn([
      process.execPath, cliEntry, '--json', '--no-start', '--timeout', '300000',
      'add', '@today', 'Interrupted after commit',
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
        command: 'add',
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
