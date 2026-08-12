import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentStartupContextResolver,
  AgentStartupContextStore,
  collectAgentStartupContext,
  collectRepositoryInstructions,
  renderAgentStartupContext,
} from '../../src/main/agent/context/AgentStartupContext';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent startup context', () => {
  test('loads one instruction file per repository level from root to cwd and deduplicates symlinks', async () => {
    const root = await repository();
    const nested = path.join(root, 'packages', 'editor');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), 'Root policy.');
    await symlink(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md'));
    await writeFile(path.join(root, 'packages', 'CLAUDE.md'), 'Package policy.');
    await writeFile(path.join(nested, 'AGENT.md'), 'Editor policy.');

    const instructions = await collectRepositoryInstructions(nested);

    expect(instructions).toEqual([
      instructionBlock(root, 'Root policy.'),
      instructionBlock(path.join(root, 'packages'), 'Package policy.'),
      instructionBlock(nested, 'Editor policy.'),
    ]);
  });

  test('captures the bounded Claude-compatible git snapshot once', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'AGENTS.md'), 'Repository policy.');
    await writeFile(path.join(root, 'changed.txt'), 'changed');

    const snapshot = await collectAgentStartupContext(root);

    expect(snapshot.repositoryInstructions).toEqual([instructionBlock(root, 'Repository policy.')]);
    expect(snapshot.gitStatus).toContain('This is the git status at the start of the conversation.');
    expect(snapshot.gitStatus).toContain('Current branch: main');
    expect(snapshot.gitStatus).toContain('Main branch (you will usually use this for PRs): main');
    expect(snapshot.gitStatus).toContain('?? changed.txt');
    expect(snapshot.gitStatus).toContain('Initial commit');
  });

  test('persists the first session snapshot and rejects malformed rows', () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const store = new AgentStartupContextStore(database);
    const initial = { repositoryInstructions: ['first'], gitStatus: 'clean' };

    expect(store.writeOnce('session-1', initial, 1)).toEqual(initial);
    expect(store.writeOnce('session-1', { repositoryInstructions: ['later'], gitStatus: null }, 2))
      .toEqual(initial);
    database.prepare(`
      INSERT INTO agent_session_startup_context(session_id, snapshot_json, created_at)
      VALUES ('invalid', '{"repositoryInstructions":"bad","gitStatus":null}', 1)
    `).run();
    expect(() => store.read('invalid')).toThrow('Invalid persisted Agent startup context');
    database.close();
  });

  test('coalesces concurrent collection and reuses the persisted session snapshot', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const store = new AgentStartupContextStore(database);
    let collectionCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolver = new AgentStartupContextResolver(
      store,
      async (cwd) => {
        collectionCount += 1;
        await gate;
        return { repositoryInstructions: [`instructions:${cwd}`], gitStatus: 'status' };
      },
      () => 42,
    );

    const first = resolver.resolve({ sessionId: 'session-1', cwd: '/workspace' });
    const second = resolver.resolve({ sessionId: 'session-1', cwd: '/workspace/child' });
    release();

    await expect(first).resolves.toEqual({
      repositoryInstructions: ['instructions:/workspace'],
      gitStatus: 'status',
    });
    await expect(second).resolves.toEqual({
      repositoryInstructions: ['instructions:/workspace'],
      gitStatus: 'status',
    });
    expect(collectionCount).toBe(1);

    const restarted = new AgentStartupContextResolver(
      store,
      async () => {
        throw new Error('the persisted snapshot should win');
      },
    );
    await expect(restarted.resolve({ sessionId: 'session-1', cwd: '/changed' })).resolves.toEqual({
      repositoryInstructions: ['instructions:/workspace'],
      gitStatus: 'status',
    });
    database.close();
  });

  test('renders frozen startup inputs in repository then git-status order', () => {
    const rendered = renderAgentStartupContext({
      repositoryInstructions: ['ROOT', 'NESTED'],
      gitStatus: 'STATUS',
    });

    expect(rendered).toBe([
      'ROOT',
      'NESTED',
      '# Session-start repository state\n\n<git-status>\nSTATUS\n</git-status>',
    ].join('\n\n'));
    expect(renderAgentStartupContext({ repositoryInstructions: [], gitStatus: null })).toBeNull();
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-agent-startup-'));
  roots.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await writeFile(path.join(root, 'tracked.txt'), 'tracked');
  await git(root, ['add', 'tracked.txt']);
  await git(root, ['commit', '-m', 'Initial commit']);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

function instructionBlock(directory: string, content: string): string {
  return `# AGENTS.md instructions for ${directory}\n\n<INSTRUCTIONS>\n${content}\n</INSTRUCTIONS>`;
}
