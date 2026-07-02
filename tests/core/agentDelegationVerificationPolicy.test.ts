import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentToolResult, successEnvelope } from '../../src/main/agentToolEnvelope';
import {
  buildControllerReplanPrompt,
  buildReplacementWorkerObjective,
  buildVerifierObjective,
  captureWorkingSetSnapshot,
  compactFileChanges,
  compactNodeChanges,
  parseVerifierVerdict,
  recordFileToolChanges,
  recordNodeToolChanges,
  recordToolTrace,
  recordWorkingSetDiff,
  sameTailCount,
  verifierGapSignature,
  type AgentRunToolTraceEntry,
} from '../../src/main/agentDelegationVerificationPolicy';

describe('agent delegation verification policy', () => {
  test('builds verifier and replan prompts from compact run evidence', () => {
    const objective = buildVerifierObjective({
      id: 'run-1',
      prompt: 'ship the feature',
      criteria: ['tests pass'],
      status: 'completed',
      objectiveStatus: 'active',
      result: 'fallback result',
      latestSubmission: { summary: ' submitted result ' } as never,
      nodeChanges: { createdNodeIds: ['node-1'] },
      fileChanges: { updatedPaths: ['src/a.ts'] },
      toolTrace: [{ toolName: 'file_read', isError: false, status: 'success' }],
    });

    expect(objective).toContain('Worker result:\nsubmitted result');
    expect(objective).not.toContain('fallback result');
    expect(objective).toContain('"createdNodeIds"');
    expect(objective).toContain('"updatedPaths"');

    expect(buildControllerReplanPrompt({
      prompt: 'ship the feature',
      criteria: ['tests pass'],
    }, 'missing tests')).toContain('Verifier gap: missing tests');
    expect(buildReplacementWorkerObjective('ship the feature', 'missing tests'))
      .toContain('Produce a fresh result that directly closes this gap.');
  });

  test('records node and file tool evidence from tool envelopes', () => {
    const nodeChanges = {};
    recordNodeToolChanges(nodeChanges, 'node_create', agentToolResult(successEnvelope('node_create', {
      createdNodeIds: ['node-1'],
    })), false);
    recordNodeToolChanges(nodeChanges, 'node_edit', agentToolResult(successEnvelope('node_edit', {
      status: 'updated',
      createdNodeIds: ['node-2'],
      affectedNodeIds: ['node-2', 'node-3'],
      trashedNodeIds: ['node-4'],
    })), false);
    recordNodeToolChanges(nodeChanges, 'node_delete', agentToolResult(successEnvelope('node_delete', {
      deletedNodeIds: ['node-5'],
      restoredNodeIds: ['node-6'],
    })), false);

    expect(compactNodeChanges(nodeChanges)).toEqual({
      createdNodeIds: ['node-1', 'node-2'],
      updatedNodeIds: ['node-3', 'node-6'],
      trashedNodeIds: ['node-4', 'node-5'],
    });

    const fileChanges = {};
    recordFileToolChanges(fileChanges, 'file_write', agentToolResult(successEnvelope('file_write', {
      filePath: '/tmp/new.ts',
      type: 'create',
      structuredPatch: [{ op: 'add' }],
    })), false);
    recordFileToolChanges(fileChanges, 'file_delete', agentToolResult(successEnvelope('file_delete', {
      filePath: '/tmp/old.ts',
      trashPath: '/tmp/.trash/old.ts',
      kind: 'file',
    })), false);

    expect(compactFileChanges(fileChanges)).toEqual({
      createdPaths: ['/tmp/new.ts'],
      deletedPaths: ['/tmp/old.ts'],
      patches: [
        { filePath: '/tmp/new.ts', operation: 'create', structuredPatch: [{ op: 'add' }] },
        { filePath: '/tmp/old.ts', operation: 'delete', trashPath: '/tmp/.trash/old.ts', kind: 'file' },
      ],
    });
  });

  test('records bounded verifier tool traces', () => {
    const trace: AgentRunToolTraceEntry[] = [];
    recordToolTrace(trace, 'file_write', agentToolResult(successEnvelope('file_write', {
      filePath: '/tmp/a.ts',
      type: 'update',
      structuredPatch: Array.from({ length: 12 }, (_, index) => ({ index })),
    })), false);
    recordToolTrace(trace, 'raw_tool', {
      content: [{ type: 'text', text: 'x'.repeat(600) }],
    }, true);

    expect(trace[0]).toMatchObject({ toolName: 'file_write', isError: false, status: 'success' });
    expect(trace[0]?.summary).toContain('/tmp/a.ts');
    expect(trace[1]).toMatchObject({ toolName: 'raw_tool', isError: true });
    expect(trace[1]?.summary?.length).toBe(500);
  });

  test('tracks working set diffs inside scoped paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-verifier-policy-'));
    try {
      const watched = path.join(root, 'watched');
      const ignored = path.join(root, 'ignored');
      await mkdir(watched);
      await mkdir(ignored);
      const existing = path.join(watched, 'existing.txt');
      await writeFile(existing, 'before');
      await writeFile(path.join(ignored, 'outside.txt'), 'before');

      const before = await captureWorkingSetSnapshot(root, { resources: { paths: ['watched'] } });
      await writeFile(existing, 'after');
      await writeFile(path.join(watched, 'created.txt'), 'new');
      await writeFile(path.join(ignored, 'outside.txt'), 'after');

      const changes = {};
      await recordWorkingSetDiff(changes, root, before, { resources: { paths: ['watched'] } });

      expect(compactFileChanges(changes)?.updatedPaths).toEqual([existing]);
      expect(compactFileChanges(changes)?.createdPaths).toEqual([path.join(watched, 'created.txt')]);
      expect(JSON.stringify(compactFileChanges(changes))).not.toContain('outside.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('parses verifier verdicts and detects repeated gaps', () => {
    expect(parseVerifierVerdict('{"verdict":"pass","gap":""}')).toEqual({ verdict: 'pass', gap: '' });
    expect(parseVerifierVerdict('result: {"verdict":"fail","gap":"missing evidence"}')).toEqual({
      verdict: 'fail',
      gap: 'missing evidence',
    });
    expect(parseVerifierVerdict('verdict: pass')).toEqual({ verdict: 'pass', gap: '' });
    expect(parseVerifierVerdict('').gap).toBe('Verifier did not return a parseable pass verdict.');

    const signature = verifierGapSignature(' Missing, Evidence! ');
    expect(signature).toBe('missing evidence');
    expect(sameTailCount(['a', signature, signature], signature)).toBe(2);
  });
});
