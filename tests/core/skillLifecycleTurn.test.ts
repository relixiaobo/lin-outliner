import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { skillLifecycleFixture } from '../fixtures/skillLifecycle';
import { ThreadService, type ThreadServiceStores } from '../../src/main/agent/ThreadService';
import { defaultEffectiveThreadConfiguration } from '../../src/main/agent/AgentConfigurationLoader';
import { ExtensionRegistry } from '../../src/main/agent/ExtensionRegistry';
import { PiTurnExecutor } from '../../src/main/agent/runtime/PiTurnExecutor';
import { PiModelGateway } from '../../src/main/agent/runtime/kernel/ModelGateway';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import { createLocalTools } from '../../src/main/agent/capabilities/agentLocalTools';
import { createSkillLifecycleTools } from '../../src/main/agent/capabilities/skillLifecycleTools';
import { createSkillTool } from '../../src/main/agent/capabilities/agentSkills';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import { AgentResourceStore } from '../../src/main/agent/persistence/AgentResourceStore';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import { AgentStartupContextStore } from '../../src/main/agent/context/AgentStartupContext';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import type { Turn } from '../../src/core/agent/protocol';

const model: Model<'openai-responses'> = {
  id: 'fixture-model', name: 'Fixture', api: 'openai-responses', provider: 'openai',
  baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_192,
};

test('a provider-driven root Turn completes the real Skill lifecycle and canonical file undo', async () => {
  const reviews: string[] = [];
  const f = await skillLifecycleFixture(async ({ review, caller }) => {
    expect(caller.origin).toMatchObject({ kind: 'agent' });
    reviews.push(review.kind);
    return true;
  });
  const file = join(f.workspace, '.agents', 'skills', 'editable', 'SKILL.md');
  const original = '---\ndescription: Editable fixture\n---\nOriginal instructions.\n';
  await mkdir(join(f.workspace, '.agents', 'skills', 'editable'), { recursive: true });
  await writeFile(file, original);
  let toolRuntime!: ToolRuntime;
  let index = 0;
  const outcomes: any[] = [];
  const managedTarget = (version: any) => ({ skillId: version.skillId,
    expectedRevision: version.revision, expectedActiveHash: version.contentHash });
  const call = (name: string, args: Record<string, unknown>) => ({ name, args });
  const inspect = (request: Record<string, unknown>) => call('skill_inspect', { request });
  const manage = (request: Record<string, unknown>) => call('skill_manage', { request });
  const steps = [
    () => inspect({ operation: 'catalog' }),
    () => inspect({ operation: 'list' }),
    () => inspect({ operation: 'discover', sourceUrl: 'https://github.com/public/skills' }),
    () => manage({ operation: 'install', discoveryId: outcomes[2].discoveryId,
      candidateId: outcomes[2].candidates[0].id, expectedCommit: outcomes[2].commit }),
    () => inspect({ operation: 'inspect', identity: outcomes[3].identity }),
    () => { f.github.version = 2; return inspect({ operation: 'check_updates' }); },
    () => inspect({ operation: 'preview_update', ...managedTarget(outcomes[3].version) }),
    () => manage({ operation: 'apply_update', ...managedTarget(outcomes[3].version),
      previewId: outcomes[6].previewId, expectedCandidateHash: outcomes[6].candidateHash }),
    () => manage({ operation: 'rollback', ...managedTarget(outcomes[7].version),
      expectedPreviousHash: outcomes[3].version.contentHash }),
    () => manage({ operation: 'uninstall', ...managedTarget(outcomes[8].version) }),
    () => call('file_read', { file_path: file }),
    () => call('file_edit', { file_path: file, old_string: 'Original', new_string: 'Agent-edited' }),
    () => inspect({ operation: 'inspect', identity: outcomes[1].items.find((row: any) => row.name === 'editable').identity }),
    () => manage({ operation: 'undo_edit', ...outcomes[12].undo }),
    () => inspect({ operation: 'curation' }),
  ];
  const executor = new PiTurnExecutor({
    resolveRuntime: async () => ({ model, thinkingLevel: 'off', getApiKey: async () => undefined }),
    resolveRuntimeSettings: async () => ({ additionalSkillDirectories: [], disabledSkills: [],
      providerTimeoutMs: null, providerMaxRetries: 0, providerMaxRetryDelayMs: 1, providerCacheRetention: 'short' }),
    createTools: (context) => toolRuntime.createTools(context),
    beforeProviderContext: (context) => toolRuntime.prepareProviderContext(context),
    createGateway: (hooks) => new PiModelGateway({ ...hooks, streamSimple: (_model, context) => {
      if (index > 0) {
        const result = context.messages.findLast((message) => message.role === 'toolResult');
        expect(result?.role).toBe('toolResult');
        if (!result || result.role !== 'toolResult') throw new Error('Missing canonical tool result.');
        const headerText = (result.content[0] as { text: string }).text;
        const header = JSON.parse(headerText.split('\n', 1)[0]!);
        expect(header).not.toHaveProperty('error');
        expect(result.isError).toBe(false);
        outcomes.push(header.data);
      }
      const next = steps[index++]?.();
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: next ? [{ type: 'toolCall', id: `fixture-${index}`, name: next.name, arguments: next.args }]
          : [{ type: 'text', text: 'Skill lifecycle complete.' }],
        stopReason: next ? 'toolUse' : 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: next ? 'toolUse' : 'stop', message }); stream.end(message); });
      return stream;
    } }),
  });
  const service = new ThreadService({ stores: createStores(f.root), executor,
    attachmentScratchRoot: join(f.root, 'scratch'), transcriptRoot: join(f.root, 'transcripts'),
    extensions: new ExtensionRegistry(), resolveConfiguration: () => ({ ...defaultEffectiveThreadConfiguration(),
      tools: ['skill_inspect', 'skill_manage', 'skill', 'file_read', 'file_edit'], skills: ['*'],
    }),
  });
  toolRuntime = new ToolRuntime(service, {
    capabilityTools: () => [...createLocalTools({ localFileRoot: f.workspace, skillRuntime: f.runtime }), createSkillTool(f.runtime)],
    skillRuntime: f.runtime, capabilityConfig: { blocks: [] },
    dynamicTools: (context, authorize) => createSkillLifecycleTools(f.lifecycle, (itemId, signal) => ({
      ...f.caller, key: context.thread.id, runtime: f.runtime, signal, authorize,
      origin: { kind: 'agent', threadId: context.thread.id, turnId: context.turn.id, itemId },
    })),
  });
  try {
    await service.initialize();
    const { thread } = await service.startThread({ source: 'app', threadSource: 'user', modelProvider: 'openai', cwd: f.workspace });
    let resolve!: (turn: Turn) => void;
    const completed = new Promise<Turn>((settle) => { resolve = settle; });
    const unsubscribe = service.subscribe((notification) => {
      if (notification.type === 'turn/completed') resolve(notification.turn);
    });
    await service.startRendererTurn({ threadId: thread.id, input: [{ type: 'text', text: 'Exercise the Skill lifecycle.' }] });
    const turn = await completed;
    unsubscribe();
    expect(turn.error).toBeNull();
    expect(turn.status).toBe('completed');
    expect(outcomes).toHaveLength(steps.length);
    expect(outcomes[3]).toMatchObject({ committed: true, observed: { available: false }, runtimeRefresh: { state: 'applied' } });
    expect(outcomes[8].version.contentHash).toBe(outcomes[3].version.contentHash);
    expect(outcomes[13]).toMatchObject({ committed: true, restoredHash: outcomes[12].undo.previousHash });
    expect(reviews).toEqual(['install', 'update', 'rollback', 'uninstall']);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readFile(f.config, 'utf8')).toBe(f.originalConfig);
    expect(await f.service.list()).toEqual([]);
    const calls = turn.items.filter((item) => item.type === 'dynamicToolCall');
    expect(calls.filter((item) => item.tool.startsWith('skill_'))).toHaveLength(13);
    expect(calls.every((item) => item.status === 'completed' && item.modelCall?.disposition === 'replayable')).toBe(true);
  } finally {
    await service.close();
    await f.close();
  }
}, 20_000);

function createStores(root: string): ThreadServiceStores {
  const directory = join(root, 'agent');
  mkdirSync(directory, { recursive: true });
  const database = (name: string) => new Database(join(directory, name), { create: true }) as unknown as SqliteDatabase;
  const goals = database('goals.sqlite');
  return {
    metadata: new ThreadMetadataStore(join(directory, 'state.sqlite'), database('state.sqlite')),
    history: new ThreadHistoryProjectionStore(join(directory, 'history.sqlite'), database('history.sqlite')),
    rollout: new RolloutStore(join(directory, 'rollouts')),
    goals: new GoalStore(join(directory, 'goals.sqlite'), goals), toolTasks: new ToolTaskStore(goals),
    agentStartupContexts: new AgentStartupContextStore(goals), payloads: new ToolPayloadStore(join(directory, 'payloads')),
    resources: new AgentResourceStore(join(directory, 'resources.sqlite'), join(root, 'content'),
      join(root, 'scratch'), Date.now, database('resources.sqlite')),
  };
}
