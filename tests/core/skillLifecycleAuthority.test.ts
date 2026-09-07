import { expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { skillLifecycleFixture } from '../fixtures/skillLifecycle';
import { createSkillLifecycleTools } from '../../src/main/agent/capabilities/skillLifecycleTools';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import { evaluateAgentToolCapability } from '../../src/main/agent/capabilities/agentCapabilities';
import { createSkillTool } from '../../src/main/agent/capabilities/agentSkills';

const target = { skillId: 'demo', expectedRevision: 'revision', expectedActiveHash: 'a'.repeat(64) };
const operations = [
  ['skill_inspect', { operation: 'list' }],
  ['skill_inspect', { operation: 'inspect', identity: 'managed:demo' }],
  ['skill_inspect', { operation: 'catalog' }],
  ['skill_inspect', { operation: 'discover', sourceUrl: 'https://github.com/public/skills' }],
  ['skill_inspect', { operation: 'check_updates' }],
  ['skill_inspect', { operation: 'preview_update', ...target }],
  ['skill_inspect', { operation: 'curation' }],
  ['skill_manage', { operation: 'install', discoveryId: 'discovery', candidateId: 'candidate', expectedCommit: 'a'.repeat(40) }],
  ['skill_manage', { operation: 'apply_update', ...target, previewId: 'preview', expectedCandidateHash: 'b'.repeat(64) }],
  ['skill_manage', { operation: 'rollback', ...target, expectedPreviousHash: 'b'.repeat(64) }],
  ['skill_manage', { operation: 'uninstall', ...target }],
  ['skill_manage', { operation: 'undo_edit', identity: 'local', currentHash: 'a'.repeat(64), previousHash: 'b'.repeat(64) }],
] as const;

test.each(['absent', 'disabled', 'blocked', 'delegated'] as const)(
  'every lifecycle operation rejects %s authority, including direct dynamic-factory access', async (restriction) => {
    let reviews = 0;
    const f = await skillLifecycleFixture(async () => { reviews++; return true; });
    try {
      for (const [name, request] of operations) {
        const context = turnContext(restriction === 'absent' ? [] : [name], restriction === 'delegated');
        let raw: readonly AgentTool[] = [];
        const runtime = new ToolRuntime(service(), {
          capabilityTools: () => [],
          disabledTools: () => restriction === 'disabled' ? [name] : [],
          capabilityConfig: { blocks: restriction === 'blocked'
            ? [`Action(agent.skill.${name === 'skill_inspect' ? 'inspect' : 'manage'})`] : [] },
          delegationPolicy: () => ({ profile: 'general', access: 'workspace-write' }),
          dynamicTools: (_context, authorize) => {
            raw = createSkillLifecycleTools(f.lifecycle, () => ({ ...f.caller, authorize }));
            return raw;
          },
        });
        const tools = await runtime.createTools(context);
        if (restriction === 'blocked') {
          await expect(tools.find((tool) => tool.name === name)!.execute('item', { request }))
            .rejects.toMatchObject({ denial: { code: 'operation_unavailable' } });
        } else expect(tools.some((tool) => tool.name === name)).toBe(false);
        expect(await raw.find((tool) => tool.name === name)!.execute('item', { request }))
          .toMatchObject({ outcome: { ok: false, error: { code: 'operation_unavailable' } } });
      }
      expect(reviews).toBe(0);
      expect(await f.service.list()).toEqual([]);
      expect(await readFile(f.config, 'utf8')).toBe(f.originalConfig);
    } finally { await f.close(); }
  },
);

test('network blocking follows the selected operation, leaving local inspection and mutations usable', () => {
  for (const [toolName, request] of operations) {
    const result = evaluateAgentToolCapability({ toolName, args: { request },
      policy: { capabilityConfig: { blocks: ['Action(web.fetch)'] } } });
    const network = ['catalog', 'discover', 'check_updates', 'preview_update', 'install'].includes(request.operation);
    expect(result.behavior).toBe(network ? 'unavailable' : 'allow');
  }
});

test('disabling invocation during a Turn prevents instruction loading without hiding lifecycle inspection', async () => {
  const f = await skillLifecycleFixture();
  let disabled = false;
  const invoke = spyOn(f.runtime, 'invokeSkill');
  try {
    const runtime = new ToolRuntime(service(), {
      capabilityConfig: { blocks: [] },
      capabilityTools: () => [createSkillTool(f.runtime)], disabledTools: () => disabled ? ['skill'] : [],
      dynamicTools: (_context, authorize) => createSkillLifecycleTools(f.lifecycle, () => ({ ...f.caller, authorize })),
    });
    const tools = await runtime.createTools(turnContext(['skill', 'skill_inspect']));
    disabled = true;
    await expect(tools.find((tool) => tool.name === 'skill')!.execute('invoke', { skill: 'demo' }))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(invoke).not.toHaveBeenCalled();
    expect(await tools.find((tool) => tool.name === 'skill_inspect')!.execute('inspect', { request: { operation: 'list' } }))
      .toMatchObject({ outcome: { ok: true } });
  } finally { invoke.mockRestore(); await f.close(); }
});

test.each(['disabled', 'blocked', 'turn_ended', 'aborted'] as const)(
  'a real ToolRuntime rechecks %s authority after two independent pending reviews', async (restriction) => {
    const decisions: Array<(approved: boolean) => void> = [];
    let bothOpened!: () => void;
    const opened = new Promise<void>((resolve) => { bothOpened = resolve; });
    const f = await skillLifecycleFixture(() => new Promise<boolean>((resolve) => {
      decisions.push(resolve);
      if (decisions.length === 2) bothOpened();
    }));
    let revoked = false;
    const controller = new AbortController();
    const runtime = new ToolRuntime(service(() => !revoked || restriction !== 'turn_ended'), {
      capabilityTools: () => [],
      disabledTools: () => revoked && restriction === 'disabled' ? ['skill_manage'] : [],
      capabilityConfig: () => ({ blocks: revoked && restriction === 'blocked' ? ['Action(agent.skill.manage)'] : [] }),
      dynamicTools: (context, authorize) => createSkillLifecycleTools(f.lifecycle, (itemId, signal) => ({
        ...f.caller, key: context.turn.id, authorize, signal,
        origin: { kind: 'agent', threadId: context.thread.id, turnId: context.turn.id, itemId },
      })),
    });
    try {
      const found = await f.inspect({ operation: 'discover', sourceUrl: 'https://github.com/public/skills' });
      const request = { operation: 'install', discoveryId: found.discoveryId,
        candidateId: found.candidates[0].id, expectedCommit: found.commit };
      const first = await runtime.createTools(turnContext(['skill_manage']));
      const second = await runtime.createTools(turnContext(['skill_manage'], false, 'second'));
      const pending = [first, second].map((tools) => tools.find((tool) => tool.name === 'skill_manage')!
        .execute('item', { request }, controller.signal).catch((error: unknown) => error));
      await opened;
      const unrelated = await runtime.createTools(turnContext(['skill_inspect'], false, 'unrelated'));
      expect(await unrelated.find((tool) => tool.name === 'skill_inspect')!.execute('list', { request: { operation: 'list' } }))
        .toMatchObject({ outcome: { ok: true } });
      revoked = true;
      if (restriction === 'aborted') controller.abort();
      decisions.forEach((decide) => decide(true));
      for (const result of await Promise.all(pending)) {
        if (restriction === 'aborted') expect(result).toMatchObject({ name: 'AbortError' });
        else expect(result).toMatchObject({ outcome: { ok: false, error: { code: 'operation_unavailable' } } });
      }
      expect(await f.service.list()).toEqual([]);
      expect(await readFile(f.config, 'utf8')).toBe(f.originalConfig);
    } finally { decisions.forEach((decide) => decide(false)); await f.close(); }
  },
);

function turnContext(tools: string[], delegated = false, turnId = 'turn'): TurnExecutionContext {
  return {
    thread: { id: 'thread', cwd: process.cwd(), parentThreadId: delegated ? 'parent' : null,
      threadSource: delegated ? 'delegation' : 'user' },
    turn: { id: turnId }, configuration: { tools, plugins: [], mcpServers: [] },
  } as unknown as TurnExecutionContext;
}
function service(active = () => true): ThreadService {
  return {
    extensionToolContributions: async () => [], notifyToolStarted: async () => {}, notifyToolCompleted: async () => {},
    readTurnForHost: () => ({ status: active() ? 'inProgress' : 'completed' }),
  } as unknown as ThreadService;
}
