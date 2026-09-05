import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createExternalAgentCliLauncher,
  EXTERNAL_AGENT_CLI_DEFINITIONS,
} from '../../src/main/agent/delegation/ExternalAgentCliLauncher';

const session = {
  sessionId: '01bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
  ownerThreadId: '01cccccc-cccc-7ccc-8ccc-cccccccccccc',
  state: 'open' as const,
  revision: 1,
  adapterSessionId: null,
  currentTaskId: null,
  previousTaskId: null,
  messageSequence: 0,
  stopFence: null,
  lastResume: null,
  createdAt: 0,
  updatedAt: 0,
  closedAt: null,
  worktree: { kind: 'none' as const },
  policy: {
    runnerId: 'codex',
    runnerVersion: null,
    modelProvider: 'custom',
    modelId: 'model',
    effort: 'medium' as const,
    profile: 'explore' as const,
    access: 'read-only' as const,
    capabilityCeilingDigest: 'x',
    schedulingPolicyDigest: 'x',
    configurationRevision: 'x',
    cwd: process.cwd(),
    worktreePolicy: 'none' as const,
  },
};

describe('external Agent CLI launchers', () => {
  test('discovers a CLI without pinning its reported version and returns bounded task output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-agent-cli-launcher-'));
    const executable = join(root, 'agent');
    await writeFile(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "future-agent 99.0"; exit 0; fi',
      'cat',
    ].join('\n'), 'utf8');
    await chmod(executable, 0o700);
    try {
      const launcher = createExternalAgentCliLauncher(
        { id: 'future', executable: 'agent', args: [] },
        { PATH: `${root}:/bin:/usr/bin` },
      );
      expect(launcher.detected).toBe(true);
      expect(launcher.ready).toBe(true);
      expect(launcher.version).toBe('future-agent 99.0');
      const result = await launcher.run?.({
        session: { ...session, policy: { ...session.policy, runnerId: 'future' } },
        turnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd',
        prompt: 'hello launcher',
        messages: [],
        signal: new AbortController().signal,
      });
      expect(result?.outcome).toBe('succeeded');
      expect(result?.text).toBe('hello launcher');
      expect(result?.runner.id).toBe('future');
      expect(result?.usage).toEqual({ state: 'unknown' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not claim readiness for an unavailable executable', () => {
    const launcher = createExternalAgentCliLauncher(
      { id: 'missing', executable: 'missing-agent', args: [] },
      { PATH: '/definitely/missing' },
    );
    expect(launcher.detected).toBe(false);
    expect(launcher.ready).toBe(false);
    expect(launcher.run).toBeUndefined();
  });

  test('ships the known launcher set without making any one vendor a protocol dependency', () => {
    expect(EXTERNAL_AGENT_CLI_DEFINITIONS.map((definition) => definition.id)).toEqual(['codex', 'claude', 'openclaw']);
    expect(EXTERNAL_AGENT_CLI_DEFINITIONS.every((definition) => definition.args.length > 0)).toBe(true);
  });
});
