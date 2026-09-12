import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Core } from '../../src/core/core';
import { plainText } from '../../src/core/types';
import { EMPTY_AUTOMATION_CONFIGURATION } from '../../src/core/agent/automation';
import type { ThreadResourceReference } from '../../src/core/agent/protocol';
import { OutlineRuntimeWorkspace } from '../../src/outline/runtime';
import { ThreadService, agentCorePaths } from '../../src/main/agent/ThreadService';
import { ExtensionRegistry } from '../../src/main/agent/ExtensionRegistry';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import { AgentResourceStore } from '../../src/main/agent/persistence/AgentResourceStore';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import { ProfileFileStore } from '../../src/main/agent/profile/ProfileFileStore';
import { MemoryControlStore } from '../../src/main/agent/extensions/memory/MemoryControlStore';
import { AutomationStore } from '../../src/main/agent/automations/AutomationStore';
import { DelegationSessionStore } from '../../src/main/agent/delegation/DelegationSessionStore';
import { pendingExecutionContext, resolveExecutionAddress } from '../../src/main/agent/tasks/ExecutionContext';
import { openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { uuidV7 } from '../../src/main/agent/uuid';

export interface PopulatedDataFixture {
  readonly threadId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly automationId: string;
  readonly occurrenceId: string;
  readonly delegationId: string;
  readonly resource: ThreadResourceReference;
  readonly workspaceId: string;
  readonly documentId: string;
}

/** Production Store owners seed the durable fixture; no provider or network is used. */
export async function seedPopulatedDataFixture(root: string, options: { readonly versioned?: boolean } = {}): Promise<PopulatedDataFixture> {
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'agent'), { recursive: true });
  const registry = new DataStoreRegistry();
  if (options.versioned !== false) await registry.establishVersions(root, await registry.inspect(root));
  const core = Core.new();
  core.createNodesFromTree(core.projection().libraryId, [
    { content: plainText('Compatibility fixture note'), children: [] },
    { content: plainText('Retained memory fixture'), children: [] },
  ]);
  const shared = core.exportSharedState();
  const workspace = await OutlineRuntimeWorkspace.open(join(root, 'outline-runtime/workspace'), { contentRoot: join(root, 'content'), initialCore: core });
  workspace.close();
  const paths = agentCorePaths(root);
  const database = (path: string) => openLifecycleDatabase(path, false);
  const goalsDatabase = database(paths.goals);
  const stores = {
    metadata: new ThreadMetadataStore(paths.state, database(paths.state)),
    history: new ThreadHistoryProjectionStore(paths.history, database(paths.history)),
    rollout: new RolloutStore(paths.rollouts),
    goals: new GoalStore(paths.goals, goalsDatabase), toolTasks: new ToolTaskStore(goalsDatabase),
    payloads: new ToolPayloadStore(paths.payloads),
    resources: new AgentResourceStore(paths.resourceReferences, join(root, 'content'), join(root, 'agent/scratch'), Date.now, database(paths.resourceReferences)),
  };
  const service = new ThreadService({ stores, recordRoot: paths.records, attachmentScratchRoot: join(root, 'agent/scratch'),
    extensions: new ExtensionRegistry(), executor: { execute: async (context) => {
      const id = context.recorder.createItemId();
      const item = { type: 'agentMessage' as const, id, provenance: context.recorder.localProvenance(id),
        text: 'Recorded fixture answer', phase: 'final_answer' as const, memoryCitation: null };
      await context.recorder.started(item); await context.recorder.completed(item);
      return { status: 'completed' };
    } } });
  await service.initialize();
  const { thread } = await service.startThread({ source: 'app', threadSource: 'user', name: 'Compatibility fixture conversation',
    modelProvider: 'openai', configurationSource: { kind: 'user' } });
  const resource = (await stores.resources.writeBytes(thread.id, Buffer.from('Exact attachment fixture\n'), 'text/plain', 'fixture.txt')).ref;
  const started = await service.startRendererTurn({ threadId: thread.id, clientUserMessageId: uuidV7(), input: [
    { type: 'text', text: 'Preserve this conversation and its attachment.' },
    { type: 'attachment', id: resource.id, name: resource.fileName, mimeType: resource.mimeType, sizeBytes: resource.byteLength,
      source: { kind: 'resource', ref: resource } },
  ] });
  await service.waitForIdle(thread.id);
  const sourceItemId = service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns![0]!.items[0]!.id;
  const project = stores.metadata.projects.create('Fixture project', [root], root, Date.now());
  stores.metadata.projects.bind(thread.id, project.id, project.revision, stores.metadata.projects.membership(thread.id).revision);
  await service.close();

  const profiles = new ProfileFileStore(root, database(join(root, 'agent/profile-control.sqlite')));
  profiles.edit({ kind: 'user', expectedDigest: null, content: '# User\n\n## writing\nScope: General\nPrefer concrete explanations.\n', author: 'manual' });
  profiles.close();
  const memory = new MemoryControlStore(join(root, 'agent/memories.sqlite'), database(join(root, 'agent/memories.sqlite')));
  memory.setThreadMode(thread.id, 'enabled');
  memory.enqueueJob(`phase1:${thread.id}`, 'phase1', { threadId: thread.id }, 1000);
  memory.close();

  const durableGoals = database(paths.goals);
  const goals = new GoalStore(paths.goals, durableGoals);
  const tasks = new ToolTaskStore(durableGoals);
  goals.create(thread.id, 'Preserve the pending goal', 1000);
  const taskId = `task_${randomUUID()}`;
  const executionContext = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root }), {
    capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
  });
  const detailPath = join(paths.toolTasks, taskId);
  await mkdir(detailPath, { recursive: true });
  await writeFile(join(detailPath, 'stdout.log'), 'Retained task output\n');
  tasks.create({ taskId, ownerThreadId: thread.id, sourceTurnId: started.turn.id, sourceItemId, producer: 'fixture',
    description: 'A persisted request with no launched process', commandDigest: 'a'.repeat(64), cwd: executionContext.address.cwd, executionContext,
    operationKind: 'host', parentTaskId: null, nonce: randomUUID(), detailPath, backgroundEnabled: false, timeoutMs: null, startedAt: Date.now() });
  durableGoals.close();

  const schedules = new AutomationStore(join(root, 'agent/scheduled-tasks.sqlite'), database(join(root, 'agent/scheduled-tasks.sqlite')));
  const automation = schedules.create({ name: 'Fixture scheduled work', prompt: 'Record a deterministic result.',
    schedule: { rrule: 'DTSTART:20300101T100000\nRRULE:FREQ=DAILY', timezone: 'UTC' }, destination: { kind: 'standalone' },
    contextHints: [], configuration: EMPTY_AUTOMATION_CONFIGURATION });
  const occurrence = schedules.claimNow(automation, null);
  schedules.close();
  const delegatedDatabase = database(join(root, 'agent/delegation.sqlite'));
  const delegation = new DelegationSessionStore(delegatedDatabase);
  const delegationId = uuidV7();
  delegation.createSession({ sessionId: delegationId, ownerThreadId: thread.id, now: Date.now(), policy: {
    runnerId: 'internal', runnerVersion: '1', modelProvider: 'openai', modelId: 'fixture', effort: 'medium', profile: 'general', access: 'read-only',
    capabilityCeilingDigest: 'b'.repeat(64), schedulingPolicyDigest: 'c'.repeat(64), configurationRevision: 'fixture', cwd: root, worktreePolicy: 'none',
  } });
  // This Store borrows its database in production too; the fixture owns the close.
  delegatedDatabase.close();
  return { threadId: thread.id, turnId: started.turn.id, projectId: project.id, taskId, automationId: automation.id,
    occurrenceId: occurrence.id, delegationId, resource, workspaceId: shared.workspaceId, documentId: shared.documentId };
}
