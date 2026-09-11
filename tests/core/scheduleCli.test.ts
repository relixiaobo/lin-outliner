import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseScheduleCommand, scheduleArgv } from '../../src/schedule/contract';
import { canonicalDelegateCommand, parsePrivilegedDelegateCommand, decodeDelegateStateCommand } from '../../src/delegate/contract';
import { runDelegateCli } from '../../src/delegate/cli/runner';
import { ScheduleCliService } from '../../src/main/agent/automations/ScheduleCliService';
import type { DelegateCapabilityExecution } from '../../src/main/agent/delegation/DelegateCapabilityBroker';
import type { AutomationService } from '../../src/main/agent/automations/AutomationService';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import { evaluateAgentToolCapability } from '../../src/main/agent/capabilities/agentCapabilities';
import { modelToolContract } from '../../src/core/agent/tools';

const taskId = '01930000-0000-7000-8000-000000000001';
const command = parseScheduleCommand(['create', '--input', '-', '--output', 'json']);
function invocation(stdin: string, operation = command): DelegateCapabilityExecution {
  return { admission: { command: operation, stdin, toolTaskId: 'task-owner', toolTaskNonce: 'nonce', cwd: '/tmp',
    source: { rootThreadId: 'root', sourceTurnId: 'turn', sourceItemId: 'item' } }, signal: new AbortController().signal } as unknown as DelegateCapabilityExecution;
}

describe('Packaged scheduling CLI admission', () => {
  test('one command parser defines the public spelling and broker command', () => {
    expect(canonicalDelegateCommand(command)).toBe('schedule create --input - --output json');
    expect(decodeDelegateStateCommand(command)).toEqual(command);
    expect(parsePrivilegedDelegateCommand(canonicalDelegateCommand(command))).toEqual(command);
    for (const source of ['schedule create --input - --output json; echo done', 'env schedule create --input - --output json',
      'schedule __proto__ --output json', 'schedule create --input /tmp/brief --output json']) {
      expect(parsePrivilegedDelegateCommand(source)).toBeNull();
    }
    const page = parseScheduleCommand(['runs', taskId, '--before', taskId, '--output', 'json']);
    expect(parseScheduleCommand(scheduleArgv(page))).toEqual(page);
  });

  test('literal stdin reaches the shared Host service without shell interpolation', async () => {
    const calls: unknown[] = [];
    const input = { requestId: 'create-one', name: 'Review', prompt: 'Literal $(do-not-run) `text`\nand a newline',
      schedule: { rrule: 'DTSTART:20270104T090000\nRRULE:FREQ=DAILY', timezone: 'UTC' } };
    const service = new ScheduleCliService(() => ({ request: async (method: string, value: unknown) => {
      calls.push({ method, value }); return { saved: true };
    } }) as AutomationService, async () => undefined);
    expect(await service.execute(invocation(JSON.stringify(input)))).toEqual({ saved: true });
    expect(calls).toEqual([{ method: 'create', value: { ...input, destination: { kind: 'standalone' } } }]);
    await expect(service.execute(invocation(JSON.stringify({ ...input, destination: { kind: 'existingThread', threadId: taskId } })))).rejects.toThrow('Invalid schedule create input');
    await expect(service.execute(invocation(JSON.stringify({ ...input, requestId: undefined })))).rejects.toThrow('requestId');
  });

  test('denied authority reaches no read or write service', async () => {
    let reached = false;
    const service = new ScheduleCliService(() => { reached = true; throw new Error('Must not resolve'); }, async () => { throw new Error('Denied caller'); });
    await expect(service.execute(invocation('{}'))).rejects.toThrow('Denied caller');
    expect(reached).toBe(false);
  });

  test('a revision conflict is a nonzero receipt with its current revision, never a successful save', async () => {
    const output: string[] = [];
    const status = await runDelegateCli(['__schedule', 'update', taskId, '--input', '-', '--output', 'json'], {
      stateExecutor: { execute: async () => ({ kind: 'revisionConflict', currentRevision: 4, message: 'Current revision is 4' }) },
      io: { readStdin: async () => JSON.stringify({ requestId: 'conflicted-edit', expectedRevision: 3, name: 'Intended name' }),
        stdout: async (value) => { output.push(value); }, stderr: async () => undefined },
    });
    expect(status).not.toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ ok: false, error: { code: 'revision_conflict', currentRevision: 4 } });
  });

  test('result inspection returns a canonical reference without bypassing file access for source text', async () => {
    const service = new ScheduleCliService(() => ({ request: async () => ({ state: 'completed', recordPath: '/records/one.md',
      answer: 'Private source text', parts: [{ text: 'Private source text' }], futureTextField: 'Also private' }) }) as AutomationService, async () => undefined);
    const result = await service.execute(invocation('', parseScheduleCommand(['result', taskId, '--output', 'json'])));
    expect(result).toEqual({ state: 'completed', recordPath: '/records/one.md', contentAvailability: 'available' });
  });

  test('direct CLI invocation has no authority and does not even consume mutation stdin', async () => {
    let reads = 0;
    const output: string[] = [];
    const status = await runDelegateCli(['__schedule', ...scheduleArgv(command)], {
      readCapability: () => null,
      io: { readStdin: async () => { reads++; return '{}'; }, stdout: async (value) => { output.push(value); }, stderr: async (value) => { output.push(value); } },
    });
    expect(status).not.toBe(0);
    expect(reads).toBe(0);
    expect(output.join('')).toContain('unauthorized');
    const launcher = await readFile('src/delegate/bin/schedule', 'utf8');
    expect(launcher).toContain('exec 3</dev/null');
  });

  test('the existing scheduling action remains enforceable after removing its model tool', () => {
    expect(modelToolContract('automation_update')).toBeNull();
    expect(modelToolContract('schedule')).toBeNull();
    const decision = evaluateAgentToolCapability({ toolName: 'bash', args: { command: canonicalDelegateCommand(command), stdin: '{}' },
      policy: { workspaceRoot: '/tmp', capabilityConfig: { blocks: ['Action(agent.automation.manage)'] } } });
    expect(decision.behavior).toBe('unavailable');
    expect(decision.descriptors.some((entry) => entry.actionKind === 'agent.automation.manage')).toBe(true);
  });

  test('Host rechecks the source Task nonce, active source, and real isolation at broker consumption', async () => {
    const execution = invocation('{}');
    const task = { ownerThreadId: 'root', sourceTurnId: 'turn', sourceItemId: 'item', producer: 'bash', nonce: 'nonce', cwd: '/tmp',
      commandDigest: createHash('sha256').update(canonicalDelegateCommand(command)).digest('hex'),
      stopRequestedAt: null, state: 'running', outcomeReason: null as string | null, continuation: { stop: null as object | null }, executionContext: { policy: { capability: 'full-access', isolation: 'unsandboxed' } } };
    const service = { projectInvocationContext: () => ({ thread: { id: 'root' }, configuration: { tools: ['bash'] } }),
      toolTaskService: () => ({ store: { read: () => task } }) } as unknown as ThreadService;
    const runtime = new ToolRuntime(service, { capabilityTools: () => [], capabilityConfig: { blocks: [] } });
    await runtime.authorizeHostCliInvocation(execution);
    task.state = 'settling'; task.outcomeReason = 'ownership_unverified';
    await runtime.authorizeHostCliInvocation(execution);
    task.continuation.stop = { source: 'user' };
    await expect(runtime.authorizeHostCliInvocation(execution)).rejects.toThrow('stop binding');
    task.continuation.stop = null; task.state = 'running'; task.outcomeReason = null;
    task.nonce = 'different';
    await expect(runtime.authorizeHostCliInvocation(execution)).rejects.toThrow('authority');
    task.nonce = 'nonce'; task.executionContext.policy.capability = 'read-only';
    await expect(runtime.authorizeHostCliInvocation(execution)).rejects.toThrow('scoped execution');
  });
});
