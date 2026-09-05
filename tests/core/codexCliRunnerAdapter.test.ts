import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  buildCodexArgs,
  CODEX_SUPPORTED_VERSION,
  createCodexCliRunnerAdapter,
  type CodexConfigSnapshot,
  resolveCodexExecutionCwd,
} from '../../src/main/agent/delegation/CodexCliRunnerAdapter';

const config: CodexConfigSnapshot = {
  providerId: 'custom',
  provider: {
    name: 'Custom',
    base_url: 'https://provider.invalid/v1',
    wire_api: 'responses',
    requires_openai_auth: true,
  },
  mcpIds: ['docs'],
  pluginIds: ['visualize@openai-bundled'],
  skillFiles: ['/tmp/skill/SKILL.md'],
  diagnostic: null,
};

describe('Codex CLI Runner adapter', () => {
  test('builds a closed first-run argv and reasserts access on resume', () => {
    const first = buildCodexArgs({
      executable: '/usr/local/bin/codex', config, model: 'gpt-5-codex', effort: 'high',
      access: 'read-only', cwd: '/tmp/workspace', resumeId: null,
    });
    expect(first).toContain('--sandbox');
    expect(first).toContain('read-only');
    expect(first).toContain('--ignore-rules');
    expect(first).toContain('--config');
    expect(first).toContain('features.multi_agent=false');
    expect(first).toContain('mcp_servers.docs.enabled=false');
    expect(first).toContain('plugins."visualize@openai-bundled".enabled=false');
    expect(first.join('\n')).toContain('skills.config=[{path="/tmp/skill/SKILL.md",enabled=false}]');

    const resume = buildCodexArgs({
      executable: '/usr/local/bin/codex', config, model: 'gpt-5-codex', effort: 'high',
      access: 'read-only', cwd: '/tmp/workspace', resumeId: '01aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(resume).toContain('01aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa');
    expect(resume).not.toContain('--sandbox');
    expect(resume.join('\n')).toContain('sandbox_mode');
    expect(resume.join('\n')).toContain('"read-only"');
  });

  test('keeps an absent or unsupported executable detected but not ready', () => {
    const adapter = createCodexCliRunnerAdapter({ executable: '/definitely/missing/codex' });
    expect(adapter.id).toBe('codex');
    expect(adapter.detected).toBe(false);
    expect(adapter.ready).toBe(false);
    expect(adapter.resolveExplicitModel('custom/gpt-5-codex', 'high')).resolves.toBeNull();
  });

  test('keeps a supported executable not ready when capability proof fails', () => {
    const adapter = createCodexCliRunnerAdapter({
      executable: '/definitely/missing/codex',
      capabilityProbe: () => ({ ok: false, diagnostic: 'fixture failed' }),
    });
    expect(adapter.ready).toBe(false);
  });

  test('fails closed when an asynchronous capability probe rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-codex-adapter-probe-rejection-'));
    const executable = join(root, 'codex');
    await writeFile(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.153.4"; exit 0; fi',
      'if [ "$1" = "features" ]; then printf "skip_host_skill_discovery\\n multi_agent\\n hooks\\n apps\\n browser_use\\n computer_use\\n"; exit 0; fi',
      'exit 0',
    ].join('\n'), 'utf8');
    await chmod(executable, 0o700);
    await writeFile(join(root, 'config.toml'), [
      'model_provider="custom"', '[model_providers.custom]',
      'base_url="https://provider.invalid/v1"', 'wire_api="responses"', 'requires_openai_auth=true',
    ].join('\n'));
    try {
      const adapter = createCodexCliRunnerAdapter({
        executable,
        cwd: root,
        env: { HOME: root, CODEX_HOME: root, PATH: root },
        capabilityProbe: async () => { throw new Error('fixture probe rejected'); },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(adapter.ready).toBe(false);
      expect(adapter.diagnostic).toContain('fixture probe rejected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('normalizes a successful JSONL fixture and stores the continuation identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-codex-adapter-test-'));
    const executable = join(root, 'codex');
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.153.4"; exit 0; fi',
      'if [ "$1" = "features" ]; then printf "skip_host_skill_discovery\\n multi_agent\\n hooks\\n apps\\n browser_use\\n computer_use\\n"; exit 0; fi',
      'echo \'{"type":"thread.started","thread_id":"01aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\'',
      'echo \'{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":2}}\'',
    ].join('\n');
    await writeFile(executable, script, 'utf8');
    await chmod(executable, 0o700);
    const home = join(root, 'home');
    await writeFile(join(root, 'config.toml'), [
      'model_provider="custom"',
      '[model_providers.custom]',
      'base_url="https://provider.invalid/v1"',
      'wire_api="responses"',
      'requires_openai_auth=true',
    ].join('\n'));
    try {
      const adapter = createCodexCliRunnerAdapter({
        executable,
        cwd: root,
        env: { HOME: home, CODEX_HOME: root, PATH: root },
        capabilityProbe: () => ({ ok: true, diagnostic: '' }),
      });
      expect(adapter.version).toBe(CODEX_SUPPORTED_VERSION);
      expect(adapter.ready).toBe(true);
      const result = await adapter.run?.({
        session: {
          sessionId: '01bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', ownerThreadId: '01cccccc-cccc-7ccc-8ccc-cccccccccccc',
          state: 'open', revision: 1, adapterSessionId: null, currentTaskId: null, previousTaskId: null,
          messageSequence: 0, stopFence: null, lastResume: null, createdAt: 0, updatedAt: 0, closedAt: null,
          worktree: { kind: 'none' },
          policy: {
            runnerId: 'codex', runnerVersion: CODEX_SUPPORTED_VERSION, modelProvider: 'custom', modelId: 'gpt-5-codex',
            effort: 'high', profile: 'explore', access: 'read-only', capabilityCeilingDigest: 'x',
            schedulingPolicyDigest: 'x', configurationRevision: 'x', cwd: root, worktreePolicy: 'none',
          },
        },
        turnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd', prompt: 'hello', messages: [], signal: new AbortController().signal,
      });
      expect(result?.outcome).toBe('succeeded');
      expect(result?.text).toBe('OK');
      expect(result?.adapterSessionId).toBe('01aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa');
      expect(result?.usage).toEqual({ state: 'known', inputTokens: 4, outputTokens: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('normalizes malformed output and cancellation as terminal failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-codex-adapter-failure-'));
    const executable = join(root, 'codex');
    await writeFile(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.153.4"; exit 0; fi',
      'if [ "$1" = "features" ]; then printf "skip_host_skill_discovery\\n multi_agent\\n hooks\\n apps\\n browser_use\\n computer_use\\n"; exit 0; fi',
      'if [ "$CODEX_FAILURE" = "malformed" ]; then echo not-json; exit 0; fi',
      'sleep 5',
    ].join('\n'));
    await chmod(executable, 0o700);
    await writeFile(join(root, 'config.toml'), [
      'model_provider="custom"', '[model_providers.custom]',
      'base_url="https://provider.invalid/v1"', 'wire_api="responses"', 'requires_openai_auth=true', 'env_key="CODEX_FAILURE"',
    ].join('\n'));
    const session = {
      sessionId: '01bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', ownerThreadId: '01cccccc-cccc-7ccc-8ccc-cccccccccccc',
      state: 'open' as const, revision: 1, adapterSessionId: null, currentTaskId: null, previousTaskId: null,
      messageSequence: 0, stopFence: null, lastResume: null, createdAt: 0, updatedAt: 0, closedAt: null,
      worktree: { kind: 'none' as const },
      policy: {
        runnerId: 'codex', runnerVersion: CODEX_SUPPORTED_VERSION, modelProvider: 'custom', modelId: 'gpt-5-codex',
        effort: 'high' as const, profile: 'explore' as const, access: 'read-only' as const,
        capabilityCeilingDigest: 'x', schedulingPolicyDigest: 'x', configurationRevision: 'x', cwd: root, worktreePolicy: 'none' as const,
      },
    };
    try {
      const malformed = createCodexCliRunnerAdapter({
        executable, cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: '/usr/bin:/bin', CODEX_FAILURE: 'malformed' },
        capabilityProbe: () => ({ ok: true, diagnostic: '' }),
      });
      expect(malformed.ready).toBe(true);
      const malformedResult = await malformed.run?.({
        session, turnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd', prompt: 'hello', messages: [], signal: new AbortController().signal,
      });
      expect(malformedResult?.outcome).toBe('failed');
      expect(malformedResult?.error).toContain('malformed JSONL');

      const cancelled = createCodexCliRunnerAdapter({
        executable, cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: '/usr/bin:/bin' },
        capabilityProbe: () => ({ ok: true, diagnostic: '' }),
      });
      const controller = new AbortController();
      const running = cancelled.run?.({
        session, turnId: '01eeeeee-eeee-7eee-8eee-eeeeeeeeeeee', prompt: 'hello', messages: [], signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      const cancelledResult = await running;
      expect(cancelledResult?.outcome).toBe('cancelled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses the managed worktree for workspace-write Sessions', () => {
    expect(resolveCodexExecutionCwd({
      sessionId: '01bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', ownerThreadId: '01cccccc-cccc-7ccc-8ccc-cccccccccccc',
      state: 'open', revision: 1, adapterSessionId: null, currentTaskId: null, previousTaskId: null,
      messageSequence: 0, stopFence: null, lastResume: null, createdAt: 0, updatedAt: 0, closedAt: null,
      worktree: { kind: 'active', metadata: {
        sourceCwd: '/tmp/source', path: '/tmp/managed-worktree', branch: 'tenon/test',
        baseCommit: 'a'.repeat(40), gitCommonDir: '/tmp/source/.git', gitWorktreeDir: '/tmp/managed-worktree/.git',
        managed: true, removedAt: null,
      } },
      policy: {
        runnerId: 'codex', runnerVersion: CODEX_SUPPORTED_VERSION, modelProvider: 'custom', modelId: 'gpt-5-codex',
        effort: 'high', profile: 'general', access: 'workspace-write', capabilityCeilingDigest: 'x',
        schedulingPolicyDigest: 'x', configurationRevision: 'x', cwd: '/tmp/source', worktreePolicy: 'dedicated',
      },
    } as never)).toBe('/tmp/managed-worktree');
  });

  test('does not spawn when already cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-codex-adapter-abort-'));
    const executable = join(root, 'codex');
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.153.4"; exit 0; fi\nif [ "$1" = "features" ]; then printf "skip_host_skill_discovery\\n multi_agent\\n hooks\\n apps\\n browser_use\\n computer_use\\n"; exit 0; fi\nexit 99\n', 'utf8');
    await chmod(executable, 0o700);
    await writeFile(join(root, 'config.toml'), 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://provider.invalid/v1"\nwire_api="responses"\nrequires_openai_auth=true\n');
    try {
      const adapter = createCodexCliRunnerAdapter({ executable, cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: root }, capabilityProbe: () => ({ ok: true, diagnostic: '' }) });
      const controller = new AbortController();
      controller.abort();
      const result = await adapter.run?.({ session: {
        sessionId: '01bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', ownerThreadId: '01cccccc-cccc-7ccc-8ccc-cccccccccccc',
        state: 'open', revision: 1, adapterSessionId: null, currentTaskId: null, previousTaskId: null,
        messageSequence: 0, stopFence: null, lastResume: null, createdAt: 0, updatedAt: 0, closedAt: null,
        worktree: { kind: 'none' }, policy: { runnerId: 'codex', runnerVersion: CODEX_SUPPORTED_VERSION,
          modelProvider: 'custom', modelId: 'gpt-5-codex', effort: 'high', profile: 'explore', access: 'read-only',
          capabilityCeilingDigest: 'x', schedulingPolicyDigest: 'x', configurationRevision: 'x', cwd: root, worktreePolicy: 'none' },
      } as never, turnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd', prompt: 'hello', messages: [], signal: controller.signal });
      expect(result?.outcome).toBe('cancelled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
