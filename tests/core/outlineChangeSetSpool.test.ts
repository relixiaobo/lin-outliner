import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalSha256, type ChangeSet } from '../../src/outline/contract';
import {
  OUTLINE_CHANGESET_RECORD_LIMIT_BYTES,
  OUTLINE_CHANGESET_UPLOAD_LIMIT_BYTES,
  readChangeSetUpload,
} from '../../src/outline/runtime/server/changeSetSpool';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('ChangeSet upload spool', () => {
  test('spools privately, validates JSONL incrementally, injects the header key after digest verification, and cleans up', async () => {
    const root = await makeRoot();
    const changeSet = createChangeSet();
    const input = encodeJsonl(changeSet);
    let inspected = false;
    const source = (async function* () {
      const midpoint = Math.floor(input.byteLength / 2);
      yield input.subarray(0, midpoint);
      const spoolDirectory = path.join(root, 'spool');
      const [spoolName] = await readdir(spoolDirectory);
      expect((await stat(spoolDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(spoolDirectory, spoolName!))).mode & 0o777).toBe(0o600);
      inspected = true;
      yield input.subarray(midpoint);
    })();

    const admitted = await readChangeSetUpload(root, source, 'jsonl', 'upload:injected');

    expect(inspected).toBe(true);
    expect(admitted).toEqual({ ...changeSet, idempotencyKey: 'upload:injected' });
    expect(await readdir(path.join(root, 'spool'))).toEqual([]);
  });

  test('removes malformed uploads and enforces per-record and total byte limits', async () => {
    const malformedRoot = await makeRoot();
    await expect(readChangeSetUpload(
      malformedRoot,
      [Buffer.from('{not json')],
      'json',
    )).rejects.toMatchObject({ outlineError: { code: 'invalid_input' } });
    expect(await readdir(path.join(malformedRoot, 'spool'))).toEqual([]);

    const recordRoot = await makeRoot();
    const oversizedRecord = (async function* () {
      yield Buffer.from('{}\n');
      yield Buffer.alloc(OUTLINE_CHANGESET_RECORD_LIMIT_BYTES + 1, 0x61);
    })();
    await expect(readChangeSetUpload(recordRoot, oversizedRecord, 'jsonl')).rejects.toMatchObject({
      outlineError: { code: 'invalid_input', message: expect.stringContaining('record exceeds') },
    });
    expect(await readdir(path.join(recordRoot, 'spool'))).toEqual([]);

    const totalRoot = await makeRoot();
    const oversizedUpload = (async function* () {
      const chunk = Buffer.alloc(8 * 1024 * 1024, 0x20);
      for (let offset = 0; offset < OUTLINE_CHANGESET_UPLOAD_LIMIT_BYTES; offset += chunk.byteLength) yield chunk;
      yield Buffer.from(' ');
    })();
    await expect(readChangeSetUpload(totalRoot, oversizedUpload, 'json')).rejects.toMatchObject({
      outlineError: { code: 'invalid_input', message: expect.stringContaining('upload exceeds') },
    });
    expect(await readdir(path.join(totalRoot, 'spool'))).toEqual([]);
  });
});

function createChangeSet(): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [{
      op: 'create',
      parents: { target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' } },
      nodes: [{ content: { text: 'Spool input', marks: [], inlineRefs: [] }, children: [] }],
    }],
  };
}

function encodeJsonl(changeSet: ChangeSet): Buffer {
  const { operations, ...header } = changeSet;
  return Buffer.from([
    JSON.stringify(header),
    ...operations.map((operation) => JSON.stringify({ operation })),
    JSON.stringify({ operationCount: operations.length, sha256: canonicalSha256(changeSet) }),
    '',
  ].join('\n'));
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-spool-'));
  roots.push(root);
  return root;
}
