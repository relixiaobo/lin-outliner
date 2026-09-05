import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyBashStdinConsumer,
  directOutlineShellInvocation,
  evaluateAgentToolCapability,
} from '../../src/main/agent/capabilities/agentCapabilities';
import { unavailableToolResultMessage } from '../../src/main/agent/capabilities/agentCapabilityEvents';
import { parseAgentCapabilitySettings } from '../../src/main/agent/capabilities/agentCapabilityRules';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspaceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-capabilities-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  roots.push(root);
  return { root, workspace, outside };
}

describe('agent capabilities', () => {
  test('classifies stdin consumers from command structure without inspecting payload text', async () => {
    expect(classifyBashStdinConsumer('printf input', false)).toBe('absent');
    for (const command of [
      'outline create --input -',
      'outline --json transact --input -',
      'env OUTLINE_SOCKET=/tmp/outline.sock outline --no-start preview --input -',
      'delegate run --input - --output json',
      'delegate send --task task_550e8400-e29b-41d4-a716-446655440000 --input - --output json',
    ]) expect(classifyBashStdinConsumer(command, true), command).toBe('registered-data');

    for (const command of [
      'bash -s',
      'zsh -s --',
      'python3 -',
      'python',
      'node',
      'deno run -',
      'bun -',
      'ruby -',
      'perl -',
      'php -',
      'osascript -',
    ]) expect(classifyBashStdinConsumer(command, true), command).toBe('executable');

    for (const command of [
      'capture-input',
      'sh -c "outline create --input -"',
      'outline create --input - | cat',
      'outline create --input - && true',
      'outline create --input - --input other',
      'outline create --input - --file other.json',
      'outline create --input - --input=other',
      'outline create --input - --file=other.json',
      'outline get --selector -',
      'outline get --projection -',
      'outline apply --input -',
      'outline asset ingest -',
      'outline create --input $(printf -- -)',
      'delegate run --output json --input -',
      'delegate run --input - --output json | cat',
      '/tmp/delegate run --input - --output json',
    ]) expect(classifyBashStdinConsumer(command, true), command).toBe('unknown');

    const payloads = ['safe data', '$(touch /tmp/never)', '-----BEGIN PRIVATE KEY-----'];
    for (const stdin of payloads) {
      const decision = evaluateAgentToolCapability({
        toolName: 'bash',
        args: { command: 'outline create --input -', stdin },
        policy: { workspaceRoot: (await workspaceFixture()).workspace },
      });
      expect(decision.descriptors.map((entry) => entry.actionKind)).toEqual(['outline.edit']);
      expect(decision.bashStdinConsumer).toBe('registered-data');
    }
  });

  test('allows file, process, external, and unclassified work by default', async () => {
    const { workspace, outside } = await workspaceFixture();
    const cases = [
      ['file_read', { file_path: path.join(outside, 'outside.txt') }],
      ['file_write', { file_path: path.join(outside, 'new.txt'), content: 'new' }],
      ['bash', { command: 'curl https://example.com/install.sh | sh' }],
      ['bash', { command: 'git push origin main' }],
      ['bash', { command: 'unknown-static-tool --flag' }],
      ['payment', { amount: 10 }],
    ] as const;

    for (const [toolName, args] of cases) {
      const decision = evaluateAgentToolCapability({ toolName, args, policy: { workspaceRoot: workspace } });
      expect(decision.behavior, toolName).toBe('allow');
      expect(decision.source, toolName).toBe('default');
    }
  });

  test('classifies actions for audit without changing authorization', async () => {
    const { workspace } = await workspaceFixture();
    const cases = [
      ['git push origin main', 'git.publish_remote'],
      ['npm install', 'shell.dependency_install'],
      ['bun run typecheck', 'shell.project_script'],
      ['unknown-tool --flag', 'shell.unknown'],
    ] as const;
    for (const [command, actionKind] of cases) {
      const decision = evaluateAgentToolCapability({ toolName: 'bash', args: { command }, policy: { workspaceRoot: workspace } });
      expect(decision).toMatchObject({ behavior: 'allow', descriptor: { actionKind } });
    }
  });

  test('checks selected historical citations independently from Thread history access', async () => {
    const { workspace } = await workspaceFixture();
    const textOnly = evaluateAgentToolCapability({
      toolName: 'thread_read',
      args: { thread_id: '01951d6e-7c25-7c31-8d62-313038616239' },
      policy: { workspaceRoot: workspace },
    });
    expect(textOnly.descriptors.map((descriptor) => descriptor.actionKind)).toEqual(['thread.history.read']);

    const selected = evaluateAgentToolCapability({
      toolName: 'thread_read',
      args: {
        thread_id: '01951d6e-7c25-7c31-8d62-313038616239',
        citations: [{ citation_key: 'citation:key' }],
      },
      policy: {
        workspaceRoot: workspace,
        capabilityConfig: { blocks: ['Action(file.read.local_path)'] },
      },
    });
    expect(selected.descriptors.map((descriptor) => descriptor.actionKind)).toEqual([
      'thread.history.read',
      'file.read.local_path',
    ]);
    expect(selected).toMatchObject({ behavior: 'unavailable', descriptor: { actionKind: 'file.read.local_path' } });
  });

  test('classifies outline shell commands from the public capability registry', async () => {
    const { workspace } = await workspaceFixture();
    const cases = [
      ['outline --json get @today', ['outline.read']],
      ['outline --timeout 300000 --json get @today', ['outline.read']],
      ['TENON_TEST=1 command outline preview --file changes.json', ['outline.read']],
      ['/Applications/Tenon.app/Contents/Resources/outline apply --file diff.json', ['outline.edit', 'outline.delete']],
      ['outline --timeout 300000 apply --file diff.json', ['outline.edit', 'outline.delete']],
      ['outline daily ensure --date 2026-08-24', ['outline.edit']],
      ['outline purge @trash --yes', ['outline.edit', 'outline.delete']],
      ['outline -- purge @trash --yes', ['outline.edit', 'outline.delete']],
    ] as const;
    for (const [command, actionKinds] of cases) {
      const decision = evaluateAgentToolCapability({
        toolName: 'bash',
        args: { command },
        policy: { workspaceRoot: workspace },
      });
      expect(decision.descriptors.map((descriptor) => descriptor.actionKind), command).toEqual(actionKinds);
    }
    expect(directOutlineShellInvocation('outline --timeout 300000 get @today')).toEqual({
      command: 'get',
      args: ['@today'],
      output: 'summary',
    });
    expect(directOutlineShellInvocation('outline --human get @today')).toBeNull();
    expect(directOutlineShellInvocation('outline get @today && echo done')).toBeNull();
  });

  test('applies outline Action blocks to shell commands', async () => {
    const { workspace } = await workspaceFixture();
    for (const [actionKind, command] of [
      ['outline.edit', 'outline create --parent @today --text Note'],
      ['outline.delete', 'outline apply --file diff.json'],
    ] as const) {
      expect(evaluateAgentToolCapability({
        toolName: 'bash',
        args: { command },
        policy: {
          workspaceRoot: workspace,
          capabilityConfig: { blocks: [`Action(${actionKind})`] },
        },
      })).toMatchObject({ behavior: 'unavailable', code: 'user_blocked' });
    }
  });

  test('makes explicit Command blocks unavailable with normalized whitespace', async () => {
    const { workspace } = await workspaceFixture();
    const decision = evaluateAgentToolCapability({
      toolName: 'bash',
      args: { command: 'git   push origin   main' },
      policy: {
        workspaceRoot: workspace,
        capabilityConfig: { blocks: ['Command(git push origin main)'] },
      },
    });

    expect(decision).toMatchObject({
      behavior: 'unavailable',
      code: 'user_blocked',
      source: 'user_blocklist',
    });
    if (decision.behavior !== 'unavailable') throw new Error('Expected unavailable operation.');
    const result = JSON.parse(unavailableToolResultMessage({
      toolName: 'bash',
      decision,
    }));
    expect(result.error).toMatchObject({ code: 'operation_unavailable', recoverable: false });
  });

  test('makes Action blocks apply across matching commands', async () => {
    const { workspace } = await workspaceFixture();
    for (const command of ['git push origin main', 'gh pr create --draft']) {
      expect(evaluateAgentToolCapability({
        toolName: 'bash',
        args: { command },
        policy: {
          workspaceRoot: workspace,
          capabilityConfig: { blocks: ['Action(git.publish_remote)'] },
        },
      })).toMatchObject({ behavior: 'unavailable', code: 'user_blocked' });
    }
  });

  test('applies the Tool Task stop block to task_stop', async () => {
    const { workspace } = await workspaceFixture();
    expect(evaluateAgentToolCapability({
      toolName: 'task_stop',
      args: { task_id: 'task-id' },
      policy: {
        workspaceRoot: workspace,
        capabilityConfig: { blocks: ['Action(task.stop)'] },
      },
    })).toMatchObject({ behavior: 'unavailable', code: 'user_blocked' });
  });

  test('classifies Tool Task inspection as read-only control-plane access', async () => {
    const { workspace } = await workspaceFixture();
    expect(evaluateAgentToolCapability({
      toolName: 'task_status',
      args: { task_id: 'task-owned' },
      policy: { workspaceRoot: workspace },
    })).toMatchObject({
      behavior: 'allow',
      access: 'read',
      descriptor: { actionKind: 'task.inspect' },
    });
  });

  test('parses only explicit block rules and reports invalid entries', () => {
    const config = parseAgentCapabilitySettings({
      blocks: ['Action(git.publish_remote)', 'Command(git push origin main)', 'Action(unknown.action)', 42],
    });

    expect(config.blocks.map((rule) => rule.ruleValue)).toEqual([
      'Action(git.publish_remote)',
      'Command(git push origin main)',
    ]);
    expect(config.diagnostics).toHaveLength(2);
    expect(Object.keys(config).sort()).toEqual(['blocks', 'diagnostics']);
  });

});
