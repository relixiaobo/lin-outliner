import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ThreadContextPayloadReference, ThreadContextPayload } from '../../src/core/agent/protocol';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import { createLocalTools, type BashData } from '../../src/main/agent/capabilities/agentLocalTools';
import type { ToolEnvelope } from '../../src/main/agent/capabilities/agentToolEnvelope';
import type { GitReviewRuntime } from '../../src/main/agent/gitReview/GitReviewRuntime';
import { evaluateAgentToolCapability, classifyBashStdinConsumer } from '../../src/main/agent/capabilities/agentCapabilities';

const roots: string[] = []; const services: ToolTaskService[] = []; const databases: Database[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(2000); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const owner = '00000000-0000-7000-8000-000000000001';
const turn = '00000000-0000-7000-8000-000000000002';
async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tenon-git-runtime-'))); roots.push(root);
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgSign', 'false');
  await writeFile(path.join(cwd, 'file.txt'), 'initial'); git('add', '.'); git('commit', '-m', 'Initial'); await writeFile(path.join(cwd, 'file.txt'), 'reviewed');
  const db = new Database(path.join(root, 'tasks.sqlite')); databases.push(db);
  const store = new ToolTaskStore(db as unknown as SqliteDatabase);
  const service = new ToolTaskService(store, path.join(root, 'tasks')); services.push(service);
  service.bindHost({ ownerExists: (id) => id === owner, readDeliveryAdmission: async () => null, startCompletionTurn: async () => false, taskChanged: () => {} });
  await service.initialize();
  const payloads = new ToolPayloadStore(path.join(root, 'payloads'));
  const refs: ThreadContextPayloadReference[] = [];
  const runtime: GitReviewRuntime = {
    read: async (ref) => { const payload = await payloads.readContext(owner, ref); if (payload?.kind !== 'gitReviewEvidence') throw new Error('Missing review'); return payload.evidence; },
    persist: async (evidence, task, prior) => {
      const payload: ThreadContextPayload = { schemaVersion: 1, kind: 'gitReviewEvidence', evidence, taskId: task.taskId, executionContext: task.executionContext, evidenceRefs: prior ? [prior] : [], facts: [] };
      const ref = await payloads.writeContext(owner, payload); refs.push(ref); return ref;
    },
  };
  const bash = createLocalTools({ workspace: { root: cwd, scratchRoot: path.join(root, 'scratch'), readFileState: new Map(), threadId: owner, gitReviewRuntime: runtime }, toolTaskService: service, turnId: turn }).find((tool) => tool.name === 'bash')!;
  let serial = 0;
  const run = async (operation: string, input: object) => {
    const result = await bash.execute(`git-call-${++serial}`, { command: `git-review ${operation} --input - --output json`, stdin: JSON.stringify(input), timeout: 30_000 });
    return result.details as ToolEnvelope<BashData>;
  };
  return { cwd, store, service, refs, payloads, git, run };
}
test('ordinary Bash supervises capture and commit, persists exact evidence and rejects a restarted stale reference', async () => {
  const f = await setup(); const captured = await f.run('capture', {});
  expect({ ok: captured.ok, error: captured.error }).toMatchObject({ ok: true });
  const review = JSON.parse(captured.data!.stdout).gitReview.review;
  expect(review).toEqual(f.refs[0]);
  expect((await f.payloads.readContext(owner, review))?.kind).toBe('gitReviewEvidence');
  const receipt = f.store.listAll(owner)[0]!;
  expect(receipt).toMatchObject({ producer: 'bash', operationKind: 'process', state: 'succeeded', cwd: f.cwd });
  const committed = await f.run('commit', { review, paths: ['file.txt'], message: 'Reviewed commit' });
  expect({ ok: committed.ok, error: committed.error, data: committed.data?.stdout }).toMatchObject({ ok: true });
  expect(f.git('show', 'HEAD:file.txt')).toBe('reviewed');
  // The same durable reference remains readable after service recovery, but cannot admit a second commit.
  await f.service.close(2000); await f.service.initialize();
  const stale = await f.run('commit', { review, paths: ['file.txt'], message: 'Again' });
  expect(stale.ok).toBe(false); expect(stale.data?.stdout).toContain('refresh the review');
}, 30_000);
test('strict Git commands classify stdin as data and preserve remote action blocks', () => {
  for (const operation of ['capture', 'commit', 'preview', 'push', 'create-pr']) {
    const command = `git-review ${operation} --input - --output json`;
    expect(classifyBashStdinConsumer(command, true)).toBe('registered-data');
    const decision = evaluateAgentToolCapability({ toolName: 'bash', args: { command, stdin: '{}' }, policy: { workspaceRoot: '/tmp', capabilityConfig: { blocks: ['Action(git.publish_remote)'] } } });
    expect(decision.behavior).toBe(['push', 'create-pr'].includes(operation) ? 'unavailable' : 'allow');
  }
  expect(classifyBashStdinConsumer('git-review capture --input - --output json; echo done', true)).toBe('unknown');
});
