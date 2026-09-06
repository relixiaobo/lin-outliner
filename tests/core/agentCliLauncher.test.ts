import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      expect(launcher.version).toBeNull();
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

  test('passes only the selected provider credentials to a launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-agent-cli-env-'));
    const executable = join(root, 'agent');
    await writeFile(executable, '#!/bin/sh\nprintf "%s|%s|%s" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$CODEX_HOME"\n', 'utf8');
    await chmod(executable, 0o700);
    try {
      const codex = EXTERNAL_AGENT_CLI_DEFINITIONS.find((definition) => definition.id === 'codex');
      if (!codex) throw new Error('Missing codex definition');
      const launcher = createExternalAgentCliLauncher(
        { ...codex, executable: 'agent', args: [] },
        {
          PATH: root,
          OPENAI_API_KEY: 'openai-secret',
          ANTHROPIC_API_KEY: 'anthropic-secret',
          CODEX_HOME: '/tmp/codex-home',
        },
      );
      const result = await launcher.run?.({
        session: { ...session, policy: { ...session.policy, runnerId: 'codex' } },
        turnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd',
        prompt: 'hello',
        messages: [],
        signal: new AbortController().signal,
      });
      expect(result?.outcome).toBe('succeeded');
      expect(result?.text).toBe('openai-secret||/tmp/codex-home');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects directories and non-executable PATH entries before spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-agent-cli-path-'));
    await mkdir(join(root, 'agent'));
    const file = join(root, 'not-executable');
    await writeFile(file, '#!/bin/sh\n', 'utf8');
    await chmod(file, 0o600);
    try {
      expect(createExternalAgentCliLauncher({ id: 'directory', executable: 'agent', args: [] }, { PATH: root }).ready).toBe(false);
      expect(createExternalAgentCliLauncher({ id: 'file', executable: 'not-executable', args: [] }, { PATH: root }).ready).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('marks output beyond the process capture limit as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-agent-cli-output-'));
    const executable = join(root, 'agent');
    await writeFile(executable, '#!/bin/sh\nhead -c 9000000 /dev/zero\n', 'utf8');
    await chmod(executable, 0o700);
    try {
      const launcher = createExternalAgentCliLauncher({ id: 'large', executable: 'agent', args: [] }, { PATH: `${root}:/bin:/usr/bin` });
      const result = await launcher.run?.({
        session: { ...session, policy: { ...session.policy, runnerId: 'large' } },
        turnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd',
        prompt: 'hello',
        messages: [],
        signal: new AbortController().signal,
      });
      expect(result?.outcome).toBe('failed');
      expect(result?.partialEvidence).toBe(true);
      expect(result?.error).toContain('output exceeded');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps a large OpenClaw prompt on stdin instead of argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-openclaw-stdin-'));
    const executable = join(root, 'agent');
    await writeFile(executable, '#!/bin/sh\nwc -c < /dev/stdin\n', 'utf8');
    await chmod(executable, 0o700);
    try {
      const openclaw = EXTERNAL_AGENT_CLI_DEFINITIONS.find((definition) => definition.id === 'openclaw');
      if (!openclaw) throw new Error('Missing OpenClaw definition');
      const launcher = createExternalAgentCliLauncher(
        { ...openclaw, executable: 'agent' },
        { PATH: `${root}:/bin:/usr/bin` },
      );
      const prompt = 'x'.repeat(300_000);
      const result = await launcher.run?.({
        session: { ...session, policy: { ...session.policy, runnerId: 'openclaw' } },
        turnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd',
        prompt,
        messages: [],
        signal: new AbortController().signal,
      });
      expect(result?.outcome).toBe('succeeded');
      expect(result?.text?.trim()).toBe(String(prompt.length));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ships the known launcher set without making any one vendor a protocol dependency', () => {
    expect(EXTERNAL_AGENT_CLI_DEFINITIONS.map((definition) => definition.id)).toEqual(['codex', 'claude', 'openclaw']);
    expect(EXTERNAL_AGENT_CLI_DEFINITIONS.every((definition) => definition.args.length > 0)).toBe(true);
    expect(EXTERNAL_AGENT_CLI_DEFINITIONS.find((definition) => definition.id === 'openclaw')).toMatchObject({
      args: ['agent', '--local', '--json', '--message-file', '/dev/stdin'],
    });
  });
});
