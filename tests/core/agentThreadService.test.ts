import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentCoreExtension,
  ThreadHistoryRollbackContext,
  TurnAdmissionContext,
} from '../../src/core/agent/extensions';
import type { AgentRole, EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../../src/core/agent/tools';
import type { AgentCoreNotification, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { ExtensionRegistry } from '../../src/main/agent/ExtensionRegistry';
import { ThreadService, type ThreadServiceStores } from '../../src/main/agent/ThreadService';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import type {
  ThreadNameGenerationContext,
  ThreadNameGenerator,
  TurnExecutionContext,
  TurnExecutionResult,
  TurnExecutor,
} from '../../src/main/agent/runtime/types';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import { Core } from '../../src/core/core';
import { createNodeTools, type OutlinerToolHost } from '../../src/main/agent/capabilities/agentNodeTools';
import { uuidV7 } from '../../src/main/agent/uuid';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ControlledExecutor implements TurnExecutor {
  readonly contexts: TurnExecutionContext[] = [];
  readonly steered: string[] = [];
  private readonly completions: Array<(result: TurnExecutionResult) => void> = [];

  async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    this.contexts.push(context);
    const itemId = context.recorder.createItemId();
    const started: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      provenance: context.recorder.localProvenance(itemId),
      text: '',
      phase: 'final_answer',
      memoryCitation: null,
    };
    await context.recorder.started(started);
    context.onSteer((input) => {
      this.steered.push(input.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'));
    });
    const result = await new Promise<TurnExecutionResult>((resolve) => {
      this.completions.push(resolve);
      if (context.signal.aborted) resolve({ status: 'interrupted' });
      else context.signal.addEventListener('abort', () => resolve({ status: 'interrupted' }), { once: true });
    });
    await context.recorder.completed({
      ...started,
      text: result.status === 'interrupted' ? 'Interrupted' : 'Done',
    });
    return result;
  }

  finish(index = 0, result: TurnExecutionResult = completedExecutionResult()): void {
    const complete = this.completions[index];
    if (!complete) throw new Error(`Executor call ${index} is not waiting`);
    complete(result);
  }

  async waitUntilWaiting(index = 0): Promise<void> {
    while (!this.completions[index]) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class ForkPayloadExecutor extends ControlledExecutor {
  override async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    const itemId = context.recorder.createItemId();
    const started: ThreadItem = {
      type: 'dynamicToolCall',
      id: itemId,
      provenance: context.recorder.localProvenance(itemId),
      status: 'inProgress',
      outputRef: null,
      namespace: 'test',
      tool: 'payload',
      arguments: {},
      contentItems: null,
      success: null,
      durationMs: null,
    };
    await context.recorder.started(started);
    const outputRef = await context.persistOutputText(
      itemId,
      'complete inherited output',
      'text/plain',
      'Complete inherited output',
    );
    const imageRef = await context.persistOutputImage(
      Buffer.from('inherited image').toString('base64'),
      'image/png',
    );
    await context.recorder.completed({
      ...started,
      status: 'completed',
      outputRef,
      contentItems: [{ type: 'image', source: { kind: 'threadPayload', ref: imageRef } }],
      success: true,
      durationMs: 1,
    });
    return completedExecutionResult();
  }
}

class FailingImageExecutor extends ControlledExecutor {
  imageRef: Awaited<ReturnType<TurnExecutionContext['persistOutputImage']>> | null = null;

  override async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    this.imageRef = await context.persistOutputImage(
      Buffer.from('orphaned image').toString('base64'),
      'image/png',
    );
    throw new Error('Tool failed after persisting an image');
  }
}

class ContextPayloadExecutor extends ControlledExecutor {
  constructor(private readonly payloads: ToolPayloadStore) {
    super();
  }

  override async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    const userItem = context.turn.items.find((item) => item.type === 'userMessage');
    if (!userItem) throw new Error('Context payload test requires a user Item');
    const resourceRef = await this.payloads.writeResource(
      context.thread.id,
      Buffer.from('context resource'),
      'text/plain',
      'context.txt',
    );
    const outputRef = await context.persistOutputText(
      'context-output',
      'context-owned complete output',
      'text/plain',
      'Context output',
    );
    const payload = {
      schemaVersion: 1,
      kind: 'turnEnvironment',
      acceptedAt: userItem.acceptedAt,
      utcInstant: '2024-07-03T09:46:40.000Z',
      localDate: '2024-07-03',
      localTime: '09:46:40',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
      locale: 'en-US',
      workingDirectory: context.thread.cwd,
      conversationMode: 'interactive',
      executionMode: 'root',
      replyIdentity: null,
      todayNodeId: null,
    } as const;
    const payloadRef = await this.payloads.writeContext(context.thread.id, payload);
    const nestedPayloadRef = await this.payloads.writeContext(context.thread.id, {
      schemaVersion: 1,
      kind: 'compactionSummary',
      source: 'fallback',
      text: 'Nested context dependency',
    });
    const summaryRef = await this.payloads.writeContext(context.thread.id, {
      schemaVersion: 1,
      kind: 'compactionSummary',
      source: 'model',
      text: 'Compacted context summary',
    });
    const restoredStateRef = await this.payloads.writeContext(context.thread.id, {
      schemaVersion: 1,
      kind: 'compactionRestoredState',
      skillCatalogHash: null,
      announcedSkills: [],
      activeSkills: [],
      roleCatalogHash: null,
      announcedRoles: [],
      userViewBaselineRef: null,
      activeObservations: [],
    });
    const instructionsRef = await this.payloads.writeContext(context.thread.id, {
      schemaVersion: 1,
      kind: 'compactionInstructions',
      entries: [],
    });
    const evidenceId = context.recorder.createItemId();
    await context.recorder.completedImmediately({
      type: 'contextEvidence',
      id: evidenceId,
      provenance: context.recorder.localProvenance(evidenceId),
      kind: 'turnEnvironment',
      payloadRef,
      summary: 'UTC turn environment',
      contextRefs: [nestedPayloadRef],
      resourceRefs: [resourceRef],
      outputRefs: [outputRef],
    });
    const inheritedImageRef = await context.persistOutputImage(
      Buffer.from('nested inherited image').toString('base64'),
      'image/png',
    );
    const inheritedTurnId = uuidV7();
    const inheritedItemId = uuidV7();
    const inheritedTurn: Turn = {
      id: inheritedTurnId,
      items: [{
        type: 'dynamicToolCall',
        id: inheritedItemId,
        provenance: {
          originThreadId: context.thread.id,
          originTurnId: inheritedTurnId,
          originItemId: inheritedItemId,
        },
        namespace: 'test',
        tool: 'nested_image',
        arguments: {},
        status: 'completed',
        outputRef: null,
        contentItems: [{
          type: 'image',
          source: { kind: 'threadPayload', ref: inheritedImageRef },
        }],
        success: true,
        durationMs: 1,
      }],
      itemsView: 'full',
      provenance: {
        originThreadId: context.thread.id,
        originTurnId: inheritedTurnId,
        trigger: { kind: 'user' },
      },
      status: 'completed',
      error: null,
      execution: context.turn.execution,
      startedAt: context.turn.startedAt,
      completedAt: context.turn.startedAt + 1,
      durationMs: 1,
    };
    const inheritedPayloadRef = await this.payloads.writeContext(context.thread.id, {
      schemaVersion: 1,
      kind: 'inheritedContext',
      sourceThreadId: context.thread.id,
      coveredThrough: { turnId: inheritedTurnId, itemId: inheritedItemId },
      requestedTurns: 'all',
      turns: [inheritedTurn],
    });
    const inheritedEvidenceId = context.recorder.createItemId();
    await context.recorder.completedImmediately({
      type: 'contextEvidence',
      id: inheritedEvidenceId,
      provenance: context.recorder.localProvenance(inheritedEvidenceId),
      kind: 'inheritedContext',
      payloadRef: inheritedPayloadRef,
      summary: 'Inherited context with a managed image',
      contextRefs: [],
      resourceRefs: [inheritedImageRef],
      outputRefs: [],
    });
    const resetId = context.recorder.createItemId();
    await context.recorder.completedImmediately({
      type: 'contextReset',
      id: resetId,
      provenance: context.recorder.localProvenance(resetId),
      clearedThrough: { turnId: context.turn.id, itemId: userItem.id },
    });
    const compactionId = context.recorder.createItemId();
    await context.recorder.completedImmediately({
      type: 'contextCompaction',
      id: compactionId,
      provenance: context.recorder.localProvenance(compactionId),
      trigger: 'manual',
      coveredFrom: { turnId: context.turn.id, itemId: userItem.id },
      coveredThrough: { turnId: context.turn.id, itemId: evidenceId },
      preservedFrom: null,
      summaryRef,
      restoredStateRef,
      instructionsRef,
      contextRefs: [nestedPayloadRef],
      resourceRefs: [resourceRef],
      outputRefs: [outputRef],
    });
    return completedExecutionResult();
  }
}

class ControlledNameGenerator implements ThreadNameGenerator {
  readonly contexts: ThreadNameGenerationContext[] = [];
  private readonly completions: Array<(name: string | null) => void> = [];

  constructor(private readonly ignoreAbort = false) {}

  async generateName(context: ThreadNameGenerationContext): Promise<string | null> {
    this.contexts.push(context);
    return new Promise<string | null>((resolve) => {
      this.completions.push(resolve);
      if (context.signal.aborted) resolve(null);
      else if (!this.ignoreAbort) context.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  finish(name: string | null, index = 0): void {
    const complete = this.completions[index];
    if (!complete) throw new Error(`Name generator call ${index} is not waiting`);
    complete(name);
  }

  async waitUntilWaiting(index = 0): Promise<void> {
    while (!this.completions[index]) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('ThreadService', () => {
  test('resolves renderer-owned Thread defaults at the host boundary', async () => {
    const fixture = await createFixture(undefined, {
      resolveRendererStartDefaults: () => ({ modelProvider: 'openai', cwd: '/tmp/agent-workdir' }),
    });

    const thread = (await fixture.service.startThread({ name: 'Host defaults' })).thread;

    expect(thread.modelProvider).toBe('openai');
    expect(thread.cwd).toBe('/tmp/agent-workdir');
    expect(fixture.service.readThread({ threadId: thread.id }).thread).toEqual(thread);
    await fixture.service.close();
  });

  test('derives the initial Thread preview for persistent and ephemeral Threads', async () => {
    const fixture = await createFixture();
    const persistent = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: persistent.id,
      input: [{ type: 'text', text: '  Summarize\n\nthis outline.  ' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    expect(fixture.service.readThread({ threadId: persistent.id }).thread.preview)
      .toBe('Summarize this outline.');
    fixture.executor.finish(0);
    await fixture.service.waitForIdle(persistent.id);

    const ephemeral = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
      ephemeral: true,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: ephemeral.id,
      input: [{
        type: 'attachment',
        id: 'preview-attachment',
        name: 'research-notes.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12,
        source: { kind: 'localFile', path: '/tmp/research-notes.pdf' },
      }],
    });
    await fixture.executor.waitUntilWaiting(1);
    expect(fixture.service.readThread({ threadId: ephemeral.id }).thread.preview)
      .toBe('research-notes.pdf');
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(ephemeral.id);
    await fixture.service.close();

    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock);
    await reopened.service.initialize();
    expect(reopened.service.readThread({ threadId: persistent.id }).thread.preview)
      .toBe('Summarize this outline.');
    await reopened.service.close();
  });

  test('generates the first root user Thread name asynchronously after its first completed Turn', async () => {
    const nameGenerator = new ControlledNameGenerator();
    const fixture = await createFixture(undefined, { nameGenerator });
    const notifications: AgentCoreNotification[] = [];
    fixture.service.subscribe((notification) => notifications.push(notification));
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;

    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Refactor the Agent runtime' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await nameGenerator.waitUntilWaiting();

    expect(fixture.service.readThread({ threadId: thread.id }).thread).toMatchObject({
      name: null,
      preview: 'Refactor the Agent runtime',
      status: { type: 'idle' },
    });
    nameGenerator.finish('Canonical Agent runtime');
    await waitUntil(() => fixture.service.readThread({ threadId: thread.id }).thread.name !== null);

    expect(fixture.service.readThread({ threadId: thread.id }).thread.name).toBe('Canonical Agent runtime');
    expect(fixture.stores.metadata.require(thread.id).nameOrigin).toBe('automatic');
    expect(notifications).toContainEqual({
      type: 'thread/name/updated',
      threadId: thread.id,
      threadName: 'Canonical Agent runtime',
    });
    await fixture.service.close();
  });

  test('falls back to the preview when terminal Turn name generation returns no name', async () => {
    const nameGenerator = new ControlledNameGenerator();
    const fixture = await createFixture(undefined, { nameGenerator });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Keep this preview' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish(0, { status: 'failed', error: { message: 'Provider failed' } });
    await nameGenerator.waitUntilWaiting();
    nameGenerator.finish(null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.service.readThread({ threadId: thread.id }).thread).toMatchObject({
      name: null,
      preview: 'Keep this preview',
    });
    expect(nameGenerator.contexts[0]?.turn.status).toBe('failed');
    await fixture.service.close();
  });

  test('does not start automatic naming when close interrupts the first Turn', async () => {
    const nameGenerator = new ControlledNameGenerator();
    const fixture = await createFixture(undefined, { nameGenerator });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Host is closing' }],
    });
    await fixture.executor.waitUntilWaiting();

    await fixture.service.close();
    expect(nameGenerator.contexts).toHaveLength(0);
  });

  test('never lets an in-flight automatic name replace a manual rename or clear', async () => {
    const nameGenerator = new ControlledNameGenerator(true);
    const fixture = await createFixture(undefined, { nameGenerator });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Keep my title choice' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await nameGenerator.waitUntilWaiting();

    await fixture.service.setThreadName(thread.id, 'My title');
    nameGenerator.finish('Stale generated title');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.service.readThread({ threadId: thread.id }).thread.name).toBe('My title');
    expect(fixture.stores.metadata.require(thread.id).nameOrigin).toBe('manual');

    await fixture.service.setThreadName(thread.id, null);
    expect(fixture.service.readThread({ threadId: thread.id }).thread.name).toBeNull();
    expect(fixture.stores.metadata.require(thread.id).nameOrigin).toBe('manual');
    await fixture.service.close();
  });

  test('keeps a manual clear authoritative across restart when the first Turn completes later', async () => {
    const nameGenerator = new ControlledNameGenerator();
    const fixture = await createFixture(undefined, { nameGenerator });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.setThreadName(thread.id, null);
    await fixture.service.close();
    const reopened = await openFixture(fixture.root, fixture.executor, fixture.clock, undefined, { nameGenerator });
    await reopened.service.initialize();
    await reopened.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Do not generate a title' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await reopened.service.waitForIdle(thread.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(nameGenerator.contexts).toHaveLength(0);
    expect(reopened.stores.metadata.require(thread.id).nameOrigin).toBe('manual');
    await reopened.service.close();
  });

  test('clears an automatic name when rolling back the first Turn and names its replacement', async () => {
    const nameGenerator = new ControlledNameGenerator();
    const fixture = await createFixture(undefined, { nameGenerator });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Old request' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    fixture.executor.finish(0);
    await nameGenerator.waitUntilWaiting(0);
    nameGenerator.finish('Old automatic name', 0);
    await waitUntil(() => fixture.service.readThread({ threadId: thread.id }).thread.name !== null);

    const rolledBack = await fixture.service.rollbackThread({ threadId: thread.id, numTurns: 1 });
    expect(rolledBack.thread.name).toBeNull();
    expect(fixture.stores.metadata.require(thread.id).nameOrigin).toBe('none');

    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Replacement request' }],
    });
    await fixture.executor.waitUntilWaiting(1);
    fixture.executor.finish(1);
    await nameGenerator.waitUntilWaiting(1);
    nameGenerator.finish('Replacement automatic name', 1);
    await waitUntil(() => fixture.service.readThread({ threadId: thread.id }).thread.name === 'Replacement automatic name');
    await fixture.service.close();
  });

  test('numbers Continue-in-new-chat names across the complete fork lineage', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      name: 'Agent structure',
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const sourceTurn = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Compare Thread models' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    fixture.executor.finish(0);
    await fixture.service.waitForIdle(source.id);

    const first = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: sourceTurn.turn.id },
    })).thread;
    const firstTurn = fixture.service.readThread({ threadId: first.id, includeTurns: true }).thread.turns![0]!;
    const second = (await fixture.service.forkThread({
      threadId: first.id,
      boundary: { kind: 'afterTurn', turnId: firstTurn.id },
    })).thread;
    const third = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: sourceTurn.turn.id },
    })).thread;

    expect([first.name, second.name, third.name]).toEqual([
      'Agent structure (1)',
      'Agent structure (2)',
      'Agent structure (3)',
    ]);
    expect(fixture.stores.metadata.require(second.id).nameOrigin).toBe('derived');

    await fixture.service.setThreadName(source.id, 'Annual plan (2024)');
    const renamedFork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: sourceTurn.turn.id },
    })).thread;
    expect(renamedFork.name).toBe('Annual plan (2024) (1)');
    await fixture.service.close();
  });

  test('uses the deterministic preview as the fork name base while no generated name exists', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const sourceTurn = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Preview title base' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(source.id);
    const fork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: sourceTurn.turn.id },
    })).thread;

    expect(fork.name).toBe('Preview title base (1)');
    await fixture.service.close();
  });

  test('updates root Thread model configuration atomically and preserves it through forks', async () => {
    const validated: string[] = [];
    const fixture = await createFixture(undefined, {
      resolveConfiguration: () => ({
        profileName: 'default',
        developerInstructions: [],
        model: 'inherit',
        reasoningEffort: 'medium',
        tools: ['node_read'],
        skills: [],
        plugins: [],
        mcpServers: [],
      }),
      validateRendererConfiguration: (configuration) => {
        validated.push(`${configuration.modelProvider}:${configuration.model}:${configuration.reasoningEffort}`);
      },
    });
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;

    const updated = await fixture.service.request('thread/configuration/set', {
      threadId: root.id,
      modelProvider: 'anthropic',
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'high',
    });
    expect(updated.thread.modelProvider).toBe('anthropic');
    expect(updated.configuration).toEqual({
      modelProvider: 'anthropic',
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'high',
    });
    expect(fixture.stores.metadata.require(root.id)).toMatchObject({
      thread: { modelProvider: 'anthropic' },
      configuration: { model: 'anthropic/claude-sonnet-4', reasoningEffort: 'high', tools: ['node_read'] },
    });
    expect(validated).toEqual(['anthropic:anthropic/claude-sonnet-4:high']);

    const turn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Use the selected model' }],
    });
    await fixture.executor.waitUntilWaiting();
    expect(fixture.executor.contexts[0]?.configuration).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'high',
    });
    await expect(fixture.service.request('thread/configuration/set', {
      threadId: root.id,
      modelProvider: 'anthropic',
      model: 'anthropic/claude-opus-4',
      reasoningEffort: 'high',
    })).rejects.toThrow('active Turn');
    fixture.executor.finish();
    await fixture.service.waitForIdle(root.id);

    const fork = await fixture.service.forkThread({
      threadId: root.id,
      boundary: { kind: 'afterTurn', turnId: turn.turn.id },
    });
    expect(fixture.service.getThreadConfiguration(fork.thread.id)).toMatchObject({
      thread: { modelProvider: 'anthropic' },
      configuration: {
        modelProvider: 'anthropic',
        model: 'anthropic/claude-sonnet-4',
        reasoningEffort: 'high',
      },
    });
    await fixture.service.close();
  });

  test('keeps feature and child Thread configuration host-owned', async () => {
    const fixture = await createFixture();
    const featureThread = (await fixture.service.startThread({
      source: 'memory-host',
      threadSource: 'memory_consolidation',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;

    expect(() => fixture.service.getThreadConfiguration(featureThread.id)).toThrow('root user Threads');
    await expect(fixture.service.setThreadConfiguration({
      threadId: featureThread.id,
      modelProvider: 'openai',
      model: 'inherit',
      reasoningEffort: 'medium',
    })).rejects.toThrow('root user Threads');
    await fixture.service.close();
  });

  test('isolates hidden internal Memory Turns from renderer and extension lifecycles', async () => {
    const extensionEvents: string[] = [];
    const registry = new ExtensionRegistry();
    registry.register({
      id: 'internal-isolation-probe',
      onThreadStarted: () => { extensionEvents.push('thread-started'); },
      onThreadIdle: () => { extensionEvents.push('thread-idle'); },
      onThreadStopped: () => { extensionEvents.push('thread-stopped'); },
      contributeTurnAdmission: () => {
        extensionEvents.push('turn-admission');
        return { extensionId: 'internal-isolation-probe', snapshotId: 'probe' };
      },
      onTurnStarted: () => { extensionEvents.push('turn-started'); },
      contributeThreadContext: () => {
        extensionEvents.push('thread-context');
        return { extensionId: 'internal-isolation-probe', additionalContext: {} };
      },
      contributeTurnItems: () => {
        extensionEvents.push('turn-items');
        return [];
      },
      onTurnStopped: () => { extensionEvents.push('turn-stopped'); },
      onNotification: () => { extensionEvents.push('notification'); },
    });
    const fixture = await createFixture(registry);
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    extensionEvents.length = 0;
    const notifications: AgentCoreNotification[] = [];
    const unsubscribe = fixture.service.subscribe((notification) => notifications.push(notification));
    const controller = new AbortController();
    const execution = fixture.service.runInternalMemoryTurn({
      sourceThreadId: source.id,
      name: 'Memory extraction',
      systemPrompt: 'Return exact JSON.',
      prompt: '{"task":"extract"}',
      signal: controller.signal,
    });

    await fixture.executor.waitUntilWaiting();
    expect(fixture.executor.contexts[0]).toMatchObject({
      thread: { threadSource: 'memory_consolidation', ephemeral: true },
      configuration: {
        developerInstructions: ['Return exact JSON.'],
        tools: [],
        skills: [],
        plugins: [],
        mcpServers: [],
      },
      historyBeforeTurn: [],
      systemContext: [],
    });
    expect(await fixture.service.extensionToolContributions(fixture.executor.contexts[0]!.thread.id)).toEqual([]);
    expect(extensionEvents).toEqual([]);
    expect(notifications).toEqual([]);

    fixture.executor.finish();
    await expect(execution).resolves.toBe('Done');
    expect(fixture.service.listThreads().data.map((thread) => thread.id)).toEqual([source.id]);
    expect(extensionEvents).toEqual([]);
    expect(notifications).toEqual([]);
    unsubscribe();
    await fixture.service.close();
  });

  test('normalizes attachment content before start and steer Items become authoritative', async () => {
    const resolvedPaths: string[] = [];
    const fixture = await createFixture(undefined, {
      resolveUserContent: (content, context) => content.map((part) => {
        if (part.type !== 'attachment') return part;
        const path = join(context.cwd, 'resolved', part.name);
        resolvedPaths.push(path);
        return { ...part, source: { kind: 'localFile' as const, path } };
      }),
    });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{
        type: 'attachment',
        id: 'start-attachment',
        name: 'start.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        source: { kind: 'localFile', path: '/outside/start.pdf' },
      }],
    });
    await fixture.executor.waitUntilWaiting();
    await fixture.service.steerTurn({
      threadId: thread.id,
      expectedTurnId: accepted.turn.id,
      input: [{
        type: 'attachment',
        id: 'steer-attachment',
        name: 'steer.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        source: { kind: 'localFile', path: '/outside/steer.txt' },
      }],
    });
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);

    const userItems = fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0]?.items
      .filter((item) => item.type === 'userMessage') ?? [];
    expect(userItems.map((item) => item.content[0])).toMatchObject([
      { source: { kind: 'localFile', path: join(fixture.root, 'resolved', 'start.pdf') } },
      { source: { kind: 'localFile', path: join(fixture.root, 'resolved', 'steer.txt') } },
    ]);
    expect(resolvedPaths).toHaveLength(2);
    await fixture.service.close();
  });

  test('enforces one active Turn, deduplicates client input, steers, and persists canonical history', async () => {
    const fixture = await createFixture();
    const notifications: AgentCoreNotification[] = [];
    fixture.service.subscribe((notification) => notifications.push(notification));
    const thread = (await fixture.service.startThread({
      name: 'Canonical runtime',
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;

    const request = {
      threadId: thread.id,
      input: [{ type: 'text' as const, text: 'Implement it' }],
      clientUserMessageId: 'submit-1',
    };
    const accepted = await fixture.service.startRendererTurn(request);
    const retry = await fixture.service.startRendererTurn(request);
    expect(retry).toEqual({ ...accepted, deduplicated: true });
    await expect(fixture.service.startRendererTurn({
      ...request,
      clientUserMessageId: 'submit-2',
    })).rejects.toThrow('active Turn');

    const steered = await fixture.service.steerTurn({
      threadId: thread.id,
      expectedTurnId: accepted.turn.id,
      input: [{ type: 'text', text: 'Also update the tests' }],
      clientUserMessageId: 'steer-1',
    });
    expect(steered.deduplicated).toBe(false);
    expect(fixture.executor.steered).toEqual(['Also update the tests']);

    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    const stored = fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread;
    expect(stored.status).toEqual({ type: 'idle' });
    expect(stored.turns).toHaveLength(1);
    expect(stored.turns?.[0]).toMatchObject({ status: 'completed', id: accepted.turn.id });
    expect(stored.turns?.[0]?.items.map((item) => item.type)).toEqual([
      'userMessage',
      'agentMessage',
      'userMessage',
    ]);
    expect(notifications.map((notification) => notification.type)).toContain('turn/completed');
    await fixture.service.close();

    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock);
    await reopened.service.initialize();
    expect(reopened.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns).toEqual(stored.turns);
    await reopened.service.close();
  });

  test('creates only the declared Agent Core storage tree from fresh userData', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Persist canonical storage' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();

    const files = await storageFiles(join(fixture.root, 'agent'));
    expect(files.filter((file) => !file.endsWith('-shm') && !file.endsWith('-wal'))).toEqual([
      'goals.sqlite',
      `rollouts/${thread.id}.jsonl`,
      'state.sqlite',
      'thread_history.sqlite',
    ]);
    expect(files.filter((file) => file.endsWith('-shm') || file.endsWith('-wal')).every((file) =>
      /^(?:goals|state|thread_history)\.sqlite-(?:shm|wal)$/.test(file))).toBe(true);
  });

  test('interrupts the exact active Turn and records a terminal history fact', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Long work' }],
    });
    await expect(fixture.service.interruptTurn(thread.id, '018f0f24-7b2e-7a3f-8a4b-123456789abc'))
      .rejects.toThrow('Expected Turn');
    await fixture.service.interruptTurn(thread.id, accepted.turn.id);
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0]?.status)
      .toBe('interrupted');
    await fixture.service.close();
  });

  test('closes and replays a partially streamed Item after host restart', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.close();

    const turnId = uuidV7(fixture.clock());
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: 'restart-user',
      provenance: { originThreadId: thread.id, originTurnId: turnId, originItemId: 'restart-user' },
      clientId: null,
      acceptedAt: fixture.clock(),
      content: [{ type: 'text', text: 'Stream a response' }],
    };
    const agentItem: ThreadItem = {
      type: 'agentMessage',
      id: 'restart-agent',
      provenance: { originThreadId: thread.id, originTurnId: turnId, originItemId: 'restart-agent' },
      text: '',
      phase: 'final_answer',
      memoryCitation: null,
    };
    const startedTurn: Turn = {
      id: turnId,
      items: [userItem],
      itemsView: 'full',
      provenance: {
        originThreadId: thread.id,
        originTurnId: turnId,
        trigger: { kind: 'user' },
      },
      status: 'inProgress',
      error: null,
      execution: completedExecutionResult(0).execution!,
      startedAt: fixture.clock(),
      completedAt: null,
      durationMs: null,
    };
    const rollout = new RolloutStore(join(fixture.root, 'agent', 'rollouts'));
    for (const notification of [
      { type: 'turn/started', threadId: thread.id, turnId, turn: startedTurn },
      {
        type: 'item/completed',
        threadId: thread.id,
        turnId,
        itemId: userItem.id,
        item: userItem,
        completedAt: fixture.clock(),
      },
      {
        type: 'item/started',
        threadId: thread.id,
        turnId,
        itemId: agentItem.id,
        item: agentItem,
        startedAt: fixture.clock(),
      },
      {
        type: 'item/delta',
        threadId: thread.id,
        turnId,
        itemId: agentItem.id,
        delta: { type: 'agentMessageText', delta: 'Partial output' },
      },
    ] satisfies AgentCoreNotification[]) {
      await rollout.append(thread.id, notification);
    }

    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock);
    await reopened.service.initialize();
    const recovered = reopened.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0];
    expect(recovered).toMatchObject({
      id: turnId,
      status: 'interrupted',
      error: { code: 'host_restart' },
    });
    expect(recovered?.items.at(-1)).toMatchObject({ type: 'agentMessage', text: 'Partial output' });
    expect(reopened.stores.history.unfinishedItems(thread.id, turnId)).toEqual([]);
    await reopened.service.close();
  });

  test('forks immutable history with local ids and ultimate provenance without reusing client ids', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Original input' }],
      clientUserMessageId: 'original-submit',
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(source.id);
    const sourceTurn = fixture.service.readThread({ threadId: source.id, includeTurns: true }).thread.turns![0]!;

    const fork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: accepted.turn.id },
      name: 'Alternative',
    })).thread;
    const copied = fixture.service.readThread({ threadId: fork.id, includeTurns: true }).thread.turns![0]!;
    expect(fork.forkedFromId).toBe(source.id);
    expect(fork.parentThreadId).toBeNull();
    expect(copied.id).not.toBe(sourceTurn.id);
    expect(copied.provenance).toEqual(sourceTurn.provenance);
    expect(copied.items[0]?.id).not.toBe(sourceTurn.items[0]?.id);
    expect(copied.items[0]?.provenance).toEqual(sourceTurn.items[0]?.provenance);
    expect(copied.items[0]).toMatchObject({ type: 'userMessage', clientId: null });
    await fixture.service.close();
  });

  test('rewrites context cursors and owns every inherited context dependency after source deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-thread-service-'));
    roots.push(root);
    let now = 1_720_000_000_000;
    const clock = () => ++now;
    const stores = createStores(root);
    const executor = new ContextPayloadExecutor(stores.payloads);
    const service = new ThreadService({
      stores,
      executor,
      attachmentScratchRoot: join(root, 'agent-scratch'),
      now: clock,
    });
    await service.initialize();
    const source = (await service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: root,
    })).thread;
    const accepted = await service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Persist context evidence' }],
    });
    await service.waitForIdle(source.id);
    const sourceTurn = service.readThread({ threadId: source.id, includeTurns: true }).thread.turns![0]!;
    const sourceUser = sourceTurn.items.find((item) => item.type === 'userMessage')!;
    const sourceEvidence = sourceTurn.items.find((item) => item.type === 'contextEvidence' && item.kind === 'turnEnvironment')!;
    const sourceInherited = sourceTurn.items.find((item) => item.type === 'contextEvidence' && item.kind === 'inheritedContext')!;

    const fork = (await service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: accepted.turn.id },
    })).thread;
    const forkTurn = service.readThread({ threadId: fork.id, includeTurns: true }).thread.turns![0]!;
    const forkUser = forkTurn.items.find((item) => item.type === 'userMessage')!;
    const forkEvidence = forkTurn.items.find((item) => item.type === 'contextEvidence' && item.kind === 'turnEnvironment')!;
    const forkInherited = forkTurn.items.find((item) => item.type === 'contextEvidence' && item.kind === 'inheritedContext')!;
    const forkReset = forkTurn.items.find((item) => item.type === 'contextReset')!;
    const forkCompaction = forkTurn.items.find((item) => item.type === 'contextCompaction')!;

    expect(forkUser.acceptedAt).toBe(sourceUser.acceptedAt);
    expect(forkReset.clearedThrough).toEqual({ turnId: forkTurn.id, itemId: forkUser.id });
    expect(forkCompaction.coveredFrom).toEqual({ turnId: forkTurn.id, itemId: forkUser.id });
    expect(forkCompaction.coveredThrough).toEqual({ turnId: forkTurn.id, itemId: forkEvidence.id });
    expect(forkEvidence.payloadRef).toEqual(sourceEvidence.payloadRef);
    expect(forkEvidence.contextRefs).toEqual(sourceEvidence.contextRefs);
    expect(forkInherited.payloadRef).toEqual(sourceInherited.payloadRef);

    await service.deleteThread(source.id);
    expect(await stores.payloads.readContext(fork.id, forkEvidence.payloadRef))
      .toMatchObject({ kind: 'turnEnvironment', timeZone: 'UTC' });
    expect(await stores.payloads.readContext(fork.id, forkEvidence.contextRefs[0]!))
      .toEqual({
        schemaVersion: 1,
        kind: 'compactionSummary',
        source: 'fallback',
        text: 'Nested context dependency',
      });
    expect(await stores.payloads.readResource(fork.id, forkEvidence.resourceRefs[0]!))
      .toEqual(Buffer.from('context resource'));
    expect(await stores.payloads.readTextReference(fork.id, forkEvidence.outputRefs[0]!))
      .toBe('context-owned complete output');
    const inheritedPayload = await stores.payloads.readContext(fork.id, forkInherited.payloadRef);
    if (inheritedPayload?.kind !== 'inheritedContext') throw new Error('Fork inherited context payload missing');
    const nestedImage = inheritedPayload.turns[0]?.items
      .find((item) => item.type === 'dynamicToolCall')
      ?.contentItems?.find((content) => content.type === 'image');
    if (!nestedImage || nestedImage.source.kind !== 'threadPayload') {
      throw new Error('Fork inherited context image reference missing');
    }
    expect(nestedImage.source.ref).toEqual(forkInherited.resourceRefs[0]);
    expect(await stores.payloads.readResource(fork.id, nestedImage.source.ref))
      .toEqual(Buffer.from('nested inherited image'));
    const previewFile = await service.resolveThreadResourceFile(fork.id, nestedImage.source.ref);
    if (!previewFile) throw new Error('Fork inherited context image preview missing');
    expect(previewFile.path).not.toContain(join('payloads', fork.id));
    expect(await readFile(previewFile.path, 'utf8')).toBe('nested inherited image');
    await service.close();
  });

  test('keeps inherited text and image payloads after deleting the source Thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-thread-service-'));
    roots.push(root);
    let now = 1_720_000_000_000;
    const clock = () => ++now;
    const opened = await openFixture(root, new ForkPayloadExecutor(), clock);
    await opened.service.initialize();
    const source = (await opened.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: root,
    })).thread;
    const accepted = await opened.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Create payloads' }],
    });
    await opened.service.waitForIdle(source.id);
    const sourceTurn = opened.service.readThread({ threadId: source.id, includeTurns: true }).thread.turns![0]!;
    const sourceItem = sourceTurn.items.find((item) => item.type === 'dynamicToolCall');
    if (!sourceItem?.outputRef) throw new Error('Source payload Item missing');

    const fork = (await opened.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: accepted.turn.id },
    })).thread;
    const forkTurn = opened.service.readThread({ threadId: fork.id, includeTurns: true }).thread.turns![0]!;
    const forkItem = forkTurn.items.find((item) => item.type === 'dynamicToolCall');
    if (!forkItem?.outputRef) throw new Error('Fork payload Item missing');
    const forkImage = forkItem.contentItems?.find((content) => content.type === 'image');
    if (!forkImage || forkImage.type !== 'image') throw new Error('Fork image payload missing');

    expect(forkItem.provenance).toEqual(sourceItem.provenance);
    expect(forkImage.source).toEqual(sourceItem.contentItems?.find((content) => content.type === 'image')?.source);
    expect(await opened.service.readItemOutput({
      threadId: fork.id,
      turnId: forkTurn.id,
      itemId: forkItem.id,
      outputId: forkItem.outputRef.id,
    })).toMatchObject({ output: { text: 'complete inherited output' } });
    if (forkImage.source.kind !== 'threadPayload') throw new Error('Fork image is not Thread-owned');
    expect(await opened.stores.payloads.readResource(fork.id, forkImage.source.ref))
      .toEqual(Buffer.from('inherited image'));

    await opened.service.deleteThread(source.id);

    expect(opened.service.readThread({ threadId: fork.id }).thread.id).toBe(fork.id);
    expect(await opened.service.readItemOutput({
      threadId: fork.id,
      turnId: forkTurn.id,
      itemId: forkItem.id,
      outputId: forkItem.outputRef.id,
    })).toMatchObject({ output: { text: 'complete inherited output' } });
    expect(await opened.stores.payloads.readResource(fork.id, forkImage.source.ref))
      .toEqual(Buffer.from('inherited image'));
    const crashLeftover = await opened.stores.payloads.writeText(
      fork.id,
      'uncommitted-output',
      'uncommitted output',
      'text/plain',
      'Uncommitted output',
    );
    await opened.service.close();

    const reopened = await openFixture(root, new ControlledExecutor(), clock);
    await reopened.service.initialize();
    expect(await reopened.service.readItemOutput({
      threadId: fork.id,
      turnId: forkTurn.id,
      itemId: forkItem.id,
      outputId: forkItem.outputRef.id,
    })).toMatchObject({ output: { text: 'complete inherited output' } });
    expect(await reopened.stores.payloads.readResource(fork.id, forkImage.source.ref))
      .toEqual(Buffer.from('inherited image'));
    expect(await reopened.stores.payloads.readTextReference(fork.id, crashLeftover)).toBeNull();
    await reopened.service.close();
  });

  test('removes a newly written tool image when no canonical Item references it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-thread-service-'));
    roots.push(root);
    const executor = new FailingImageExecutor();
    const opened = await openFixture(root, executor, () => 1_720_000_000_000);
    await opened.service.initialize();
    const thread = (await opened.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: root,
    })).thread;

    await opened.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Fail after writing an image' }],
    });
    await opened.service.waitForIdle(thread.id);

    if (!executor.imageRef) throw new Error('Failing executor did not write its image');
    expect(await opened.stores.payloads.readResource(thread.id, executor.imageRef)).toBeNull();
    await opened.service.close();
  });

  test('copies inherited managed attachments and prompt snapshots into a fork', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const sourceRef = await fixture.service.writeThreadResource(
      source.id,
      Buffer.from('original image'),
      'image/png',
      'source.png',
    );
    const promptRef = await fixture.service.writeThreadResource(
      source.id,
      Buffer.from('prompt image'),
      'image/png',
      'prompt.png',
    );
    const accepted = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{
        type: 'attachment',
        id: 'managed-image',
        name: 'source.png',
        mimeType: 'image/png',
        sizeBytes: sourceRef.byteLength,
        source: { kind: 'threadPayload', ref: sourceRef },
        promptImage: promptRef,
      }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(source.id);

    const fork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: accepted.turn.id },
    })).thread;
    await fixture.service.deleteThread(source.id);

    expect(await fixture.service.readThreadResource(fork.id, sourceRef)).toEqual(Buffer.from('original image'));
    expect(await fixture.service.readThreadResource(fork.id, promptRef)).toEqual(Buffer.from('prompt image'));
    await fixture.service.close();
  });

  test('exposes managed attachments only through disposable scratch observations', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const ref = await fixture.service.writeThreadResource(
      thread.id,
      Buffer.from('canonical attachment'),
      'text/plain',
      'attachment.txt',
    );
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{
        type: 'attachment',
        id: 'managed-attachment',
        name: ref.fileName,
        mimeType: ref.mimeType,
        sizeBytes: ref.byteLength,
        source: { kind: 'threadPayload', ref },
      }],
    });
    await fixture.executor.waitUntilWaiting();

    const modelPath = await fixture.executor.contexts[0]!.resolveResourceObservationPath(ref);
    expect(modelPath).toContain(join(fixture.root, 'agent-scratch'));
    await writeFile(modelPath!, 'modified by model');
    expect(await fixture.service.readThreadResource(thread.id, ref)).toEqual(Buffer.from('canonical attachment'));

    const external = await fixture.service.resolveAttachmentFile(thread.id, 'managed-attachment');
    expect(external?.path).toContain(join(fixture.root, 'agent-scratch'));
    expect(external?.path).not.toBe(modelPath);
    await writeFile(external!.path, 'modified by external app');
    expect(await fixture.service.readThreadResource(thread.id, ref)).toEqual(Buffer.from('canonical attachment'));
    expect((await fixture.service.resolveAttachmentFile(thread.id, 'managed-attachment'))?.path)
      .toBe(external!.path);

    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await expect(readFile(modelPath!)).rejects.toThrow();
    expect(await readFile(external!.path, 'utf8')).toBe('modified by external app');
    const substituted = join(fixture.root, 'substituted.txt');
    await writeFile(substituted, 'must not be exposed');
    await rm(external!.path);
    await symlink(substituted, external!.path);
    expect(await fixture.service.resolveAttachmentFile(thread.id, 'managed-attachment')).toBeNull();
    expect(await readFile(substituted, 'utf8')).toBe('must not be exposed');
    await fixture.service.close();
  });

  test('keeps exact attachment authorization stable across repeated canonical IDs', async () => {
    const fixture = await createFixture();
    const filePath = join(fixture.root, 'repeated.txt');
    await writeFile(filePath, 'repeated attachment');
    const canonicalPath = await realpath(filePath);
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const attachment = {
      type: 'attachment' as const,
      id: 'stable-attachment-id',
      name: 'repeated.txt',
      mimeType: 'text/plain',
      sizeBytes: 19,
      source: { kind: 'localFile' as const, path: canonicalPath },
    };

    await fixture.service.startRendererTurn({ threadId: thread.id, input: [attachment] });
    await fixture.executor.waitUntilWaiting(0);
    fixture.executor.finish(0);
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.startRendererTurn({ threadId: thread.id, input: [attachment] });
    await fixture.executor.waitUntilWaiting(1);
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(thread.id);

    expect(await fixture.service.resolveAttachmentFile(thread.id, attachment.id))
      .toMatchObject({ path: canonicalPath, attachment: { id: attachment.id } });
    await fixture.service.close();
  });

  test('discards draft resources but retains referenced resources and prunes crash leftovers', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const discarded = await fixture.service.writeThreadResource(
      thread.id,
      Buffer.from('discarded'),
      'text/plain',
      'discarded.txt',
    );
    expect(await fixture.service.discardUnreferencedThreadResource(thread.id, discarded)).toBe(true);
    expect(await fixture.service.readThreadResource(thread.id, discarded)).toBeNull();

    const retained = await fixture.service.writeThreadResource(
      thread.id,
      Buffer.from('retained'),
      'text/plain',
      'retained.txt',
    );
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{
        type: 'attachment',
        id: 'retained-attachment',
        name: retained.fileName,
        mimeType: retained.mimeType,
        sizeBytes: retained.byteLength,
        source: { kind: 'threadPayload', ref: retained },
      }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    expect(await fixture.service.discardUnreferencedThreadResource(thread.id, retained)).toBe(false);
    expect(await fixture.service.discardUnreferencedThreadResource(thread.id, {
      ...retained,
      mimeType: 'application/octet-stream',
    })).toBe(false);
    expect(await fixture.service.readThreadResource(thread.id, retained)).toEqual(Buffer.from('retained'));

    const crashLeftover = await fixture.service.writeThreadResource(
      thread.id,
      Buffer.from('leftover'),
      'text/plain',
      'leftover.txt',
    );
    await fixture.service.close();
    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock);
    await reopened.service.initialize();
    expect(await reopened.service.readThreadResource(thread.id, retained)).toEqual(Buffer.from('retained'));
    expect(await reopened.service.readThreadResource(thread.id, crashLeftover)).toBeNull();
    await reopened.service.close();
  });

  test('rolls back only newly created resources when content admission fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-thread-service-'));
    roots.push(root);
    const stores = createStores(root);
    const executor = new ControlledExecutor();
    const extensions = new ExtensionRegistry();
    extensions.register({
      id: 'failing-admission',
      contributeTurnAdmission: () => {
        throw new Error('later admission failed');
      },
    });
    let payload = Buffer.from('new prompt');
    let lastRef: Awaited<ReturnType<ToolPayloadStore['writeResource']>> | null = null;
    const service = new ThreadService({
      stores,
      executor,
      attachmentScratchRoot: join(root, 'agent-scratch'),
      extensions,
      resolveUserContent: async (_content, context) => {
        const written = await stores.payloads.writeResourceWithStatus(
          context.threadId,
          payload,
          'image/png',
          'prompt.png',
        );
        lastRef = written.ref;
        if (written.created) context.recordCreatedResource(written.ref);
        return _content;
      },
    });
    await service.initialize();
    const thread = (await service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: root,
    })).thread;

    await expect(service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'first attempt' }],
    })).rejects.toThrow('later admission failed');
    expect(lastRef).not.toBeNull();
    expect(await service.readThreadResource(thread.id, lastRef!)).toBeNull();

    const existing = await service.writeThreadResource(
      thread.id,
      Buffer.from('existing prompt'),
      'image/png',
      'prompt.png',
    );
    payload = Buffer.from('existing prompt');
    await expect(service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'second attempt' }],
    })).rejects.toThrow('later admission failed');
    expect(await service.readThreadResource(thread.id, existing)).toEqual(payload);
    await service.close();
  });

  test('rolls back the terminal Turn in place and retries failed commit hooks without restart', async () => {
    const extension = new HistoryRollbackProbe('memory-probe', { commitFailures: 1 });
    const registry = new ExtensionRegistry();
    registry.register(extension);
    const fixture = await createFixture(registry);
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Replace this input' }],
    });
    await fixture.executor.waitUntilWaiting();
    await expect(fixture.service.request('thread/rollback', { threadId: thread.id, numTurns: 1 }))
      .rejects.toThrow('active Turn');
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);

    const pruneContexts = fixture.stores.payloads.pruneUnreferencedContexts.bind(fixture.stores.payloads);
    fixture.stores.payloads.pruneUnreferencedContexts = async () => {
      throw new Error('cleanup failed after durable rollback');
    };
    const response = await fixture.service.request('thread/rollback', { threadId: thread.id, numTurns: 1 });
    fixture.stores.payloads.pruneUnreferencedContexts = pruneContexts;
    expect(response.thread.id).toBe(thread.id);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns).toEqual([]);
    const marker = fixture.stores.history.rollbackMarkers(thread.id)[0];
    expect(marker?.omittedTurnIds).toEqual([accepted.turn.id]);
    expect(fixture.service.hasHistoryRollbackMarker(marker!.rollbackId)).toBe(true);
    const audit = await fixture.stores.rollout.read(thread.id);
    expect(audit.some((entry) => entry.event.type === 'turn/completed' && entry.event.turnId === accepted.turn.id))
      .toBe(true);
    await waitUntil(() => extension.events.filter((event) => event === 'commit').length >= 2);
    expect(extension.events).toEqual(['prepare', 'commit', 'commit']);

    const replacement = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Replacement input' }],
    });
    expect(replacement.turn.id).not.toBe(accepted.turn.id);
    await fixture.executor.waitUntilWaiting(1);
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns)
      .toHaveLength(1);
    await fixture.service.close();

    const startupExtension = new HistoryRollbackProbe('memory-probe');
    const startupRegistry = new ExtensionRegistry();
    startupRegistry.register(startupExtension);
    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock, startupRegistry);
    await reopened.service.initialize();
    expect(startupExtension.events).toEqual(['commit']);
    await reopened.service.close();
  });

  test('runs startup recovery before initial idle extensions can admit Turns', async () => {
    const fixture = await createFixture();
    await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    });
    await fixture.service.close();

    const events: string[] = [];
    const registry = new ExtensionRegistry();
    registry.register({
      id: 'startup-order-probe',
      onThreadIdle: () => {
        events.push('thread-idle');
      },
    });
    const reopened = await openFixture(
      fixture.root,
      new ControlledExecutor(),
      fixture.clock,
      registry,
      { beforeInitialTurnAdmission: () => { events.push('startup-recovery'); } },
    );
    await reopened.service.initialize();

    expect(events).toEqual(['startup-recovery', 'thread-idle']);
    await reopened.service.close();
  });

  test('rejects rollback outside a persistent root user Thread or beyond current history', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await expect(fixture.service.request('thread/rollback', { threadId: root.id, numTurns: 1 }))
      .rejects.toThrow('exceeds');

    const ephemeral = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
      ephemeral: true,
    })).thread;
    await expect(fixture.service.request('thread/rollback', { threadId: ephemeral.id, numTurns: 1 }))
      .rejects.toThrow('persistent root user Threads');

    const feature = (await fixture.service.startThread({
      source: 'memory-host',
      threadSource: 'memory_consolidation',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await expect(fixture.service.request('thread/rollback', { threadId: feature.id, numTurns: 1 }))
      .rejects.toThrow('persistent root user Threads');
    await fixture.service.close();
  });

  test('aborts prepared extensions and leaves history unchanged when rollback preparation fails', async () => {
    const prepared = new HistoryRollbackProbe('prepared-probe');
    const failing = new HistoryRollbackProbe('failing-probe', { failPrepare: true });
    const registry = new ExtensionRegistry();
    registry.register(prepared);
    registry.register(failing);
    const fixture = await createFixture(registry);
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Keep this input' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);

    await expect(fixture.service.request('thread/rollback', { threadId: thread.id, numTurns: 1 }))
      .rejects.toThrow('prepare failed');
    expect(prepared.events).toEqual(['prepare', 'abort']);
    expect(failing.events).toEqual(['prepare']);
    expect(fixture.stores.history.rollbackMarkers(thread.id)).toEqual([]);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns)
      .toHaveLength(1);
    await fixture.service.close();
  });

  test('omits forked history without reverting document, file, shell, MCP, process, or external effects', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Produce observable effects' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(source.id);

    const document = Core.new();
    const nodeId = document.createNode(document.projection().todayId, null, 'Effect remains').focus!.nodeId;
    const filePath = join(fixture.root, 'effect.txt');
    await writeFile(filePath, 'file effect remains', 'utf8');
    const nonDocumentEffects = {
      shell: ['command completed'],
      mcp: ['remote mutation accepted'],
      processes: ['process-1'],
      external: ['message delivered'],
    };

    const fork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'beforeTurn', turnId: accepted.turn.id },
    })).thread;

    expect(fixture.service.readThread({ threadId: fork.id, includeTurns: true }).thread.turns).toEqual([]);
    expect(document.projection().nodes.find((node) => node.id === nodeId)?.content.text).toBe('Effect remains');
    expect(await readFile(filePath, 'utf8')).toBe('file effect remains');
    expect(nonDocumentEffects).toEqual({
      shell: ['command completed'],
      mcp: ['remote mutation accepted'],
      processes: ['process-1'],
      external: ['message delivered'],
    });
    await fixture.service.close();
  });

  test('captures host and per-Thread admission generations under their barriers', async () => {
    const extension = new AdmissionProbe();
    const registry = new ExtensionRegistry();
    registry.register(extension);
    const fixture = await createFixture(registry);
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.withHostRootTurnAdmissionBarrier(async () => undefined);
    await fixture.service.withThreadAdmissionBarrier(thread.id, async () => undefined);
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Snapshot barriers' }],
    });
    expect(extension.contexts).toHaveLength(1);
    expect(extension.contexts[0]?.hostBarrier.generation).toBe(1);
    expect(extension.contexts[0]?.threadBarrier.generation).toBe(1);
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });

  test('round-trips request_user_input through the control plane and active Thread flag', async () => {
    const fixture = await createFixture();
    const notifications: AgentCoreNotification[] = [];
    fixture.service.subscribe((notification) => notifications.push(notification));
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const turn = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Ask before choosing' }],
    });
    await fixture.executor.waitUntilWaiting();
    const responsePromise = fixture.service.requestUserInput(thread.id, turn.turn.id, 'question-item', {
      questions: [{
        id: 'storage_mode',
        header: 'Storage',
        question: 'Which storage mode should be used?',
        options: [
          { label: 'Local (Recommended)', description: 'Keep data on this device.' },
          { label: 'Cloud', description: 'Synchronize data remotely.' },
        ],
      }],
    });
    await waitUntil(() => fixture.service.readThread({ threadId: thread.id }).thread.status.type === 'active'
      && fixture.service.readThread({ threadId: thread.id }).thread.status.activeFlags.includes('waitingOnUserInput'));
    await fixture.service.request('userInput/respond', {
      threadId: thread.id,
      turnId: turn.turn.id,
      itemId: 'question-item',
      answers: [{ questionId: 'storage_mode', optionLabel: 'Local (Recommended)' }],
      autoResolved: false,
    });
    expect(await responsePromise).toMatchObject({ answers: [{ optionLabel: 'Local (Recommended)' }], autoResolved: false });
    expect(notifications.map((notification) => notification.type)).toContain('userInput/requested');
    expect(notifications.map((notification) => notification.type)).toContain('userInput/resolved');
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });

  test('paginates ephemeral history without creating persistence records', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      ephemeral: true,
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    for (const [index, prompt] of ['One', 'Two'].entries()) {
      await fixture.service.startRendererTurn({ threadId: thread.id, input: [{ type: 'text', text: prompt }] });
      await fixture.executor.waitUntilWaiting(index);
      fixture.executor.finish(index);
      await fixture.service.waitForIdle(thread.id);
    }
    const first = await fixture.service.request('thread/turns/list', { threadId: thread.id, limit: 1 });
    const second = await fixture.service.request('thread/turns/list', {
      threadId: thread.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
    expect(fixture.stores.metadata.read(thread.id)).toBeNull();
    await fixture.service.close();
  });

  test('paginates persistent and ephemeral Threads through one cursor without omissions', async () => {
    const fixture = await createFixture();
    const persistent: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      persistent.push((await fixture.service.startThread({
        source: 'app',
        threadSource: 'user',
        modelProvider: 'openai',
        cwd: fixture.root,
        name: `Persistent ${index + 1}`,
      })).thread.id);
    }
    const ephemeral = (await fixture.service.startThread({
      ephemeral: true,
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
      name: 'Ephemeral',
    })).thread.id;

    const listed: string[] = [];
    let cursor: string | null = null;
    do {
      const page = fixture.service.listThreads({ cursor, limit: 2 });
      listed.push(...page.data.map((thread) => thread.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(listed).toEqual([ephemeral, ...persistent.toReversed()]);
    expect(new Set(listed).size).toBe(4);
    await fixture.service.close();
  });

  test('terminalizes a Turn when an extension start hook throws and releases the active lock', async () => {
    const registry = new ExtensionRegistry();
    let shouldThrow = true;
    registry.register({
      id: 'throwing-start',
      onTurnStarted: () => {
        if (!shouldThrow) return;
        shouldThrow = false;
        throw new Error('Extension start failed');
      },
    });
    const fixture = await createFixture(registry);
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;

    const accepted = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'First attempt' }],
    });
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0]).toMatchObject({
      id: accepted.turn.id,
      status: 'failed',
      error: { code: 'runtime_failure', message: 'Extension start failed' },
    });

    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Second attempt' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.at(-1)?.status)
      .toBe('completed');
    await fixture.service.close();
  });

  test('scopes identical Subagent task paths to their root Thread session', async () => {
    const fixture = await createFixture();
    const roots = await Promise.all([0, 1].map(async (index) => (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
      name: `Root ${index + 1}`,
    })).thread));
    const parentTurns = await Promise.all(roots.map((root, index) => fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: `Delegate ${index + 1}` }],
    })));
    await fixture.executor.waitUntilWaiting(1);

    const first = await fixture.service.spawnCollaborationAgent({
      senderThreadId: roots[0]!.id,
      senderTurnId: parentTurns[0]!.turn.id,
      parentItemId: 'spawn-first',
      taskName: 'research',
      message: 'Research first tree',
    });
    const second = await fixture.service.spawnCollaborationAgent({
      senderThreadId: roots[1]!.id,
      senderTurnId: parentTurns[1]!.turn.id,
      parentItemId: 'spawn-second',
      taskName: 'research',
      message: 'Research second tree',
    });

    expect(first.taskPath).toBe('/root/research');
    expect(second.taskPath).toBe('/root/research');
    expect(first.thread.id).not.toBe(second.thread.id);
    expect(fixture.service.listCollaborationAgents(roots[0]!.id).map((view) => view.threadId)).toEqual([first.thread.id]);
    expect(fixture.service.listCollaborationAgents(roots[1]!.id).map((view) => view.threadId)).toEqual([second.thread.id]);
    await fixture.service.close();
  });

  test('archives a persistent Thread subtree after interrupting every active Turn', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Delegate before archive' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'archive-spawn',
      prompt: 'Keep working until archived',
      taskPath: '/root/archive_child',
    });
    await fixture.executor.waitUntilWaiting(1);

    await fixture.service.setThreadArchived(root.id, true);

    expect(fixture.service.readThread({ threadId: root.id, includeTurns: true }).thread.turns?.at(-1)?.status)
      .toBe('interrupted');
    expect(fixture.service.readThread({ threadId: child.thread.id, includeTurns: true }).thread.turns?.at(-1)?.status)
      .toBe('interrupted');
    expect(fixture.service.listThreads({ archived: false }).data.map((thread) => thread.id))
      .not.toContain(root.id);
    expect(fixture.service.listThreads({ archived: true }).data.map((thread) => thread.id))
      .toEqual(expect.arrayContaining([root.id, child.thread.id]));
    await expect(fixture.service.startRendererTurn({
      threadId: child.thread.id,
      input: [{ type: 'text', text: 'Archived work must not restart' }],
    })).rejects.toThrow('archived');

    await fixture.service.setThreadArchived(root.id, false);
    expect(fixture.service.listThreads({ archived: false }).data.map((thread) => thread.id)).toContain(root.id);
    expect(fixture.service.listThreads({ archived: true }).data.map((thread) => thread.id)).toContain(child.thread.id);
    await fixture.service.close();
  });

  test('rejects overlapping subtree teardown while the first operation is stopping active Turns', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Remain active during teardown' }],
    });
    await fixture.executor.waitUntilWaiting();

    const archive = fixture.service.setThreadArchived(thread.id, true);
    await expect(fixture.service.deleteThread(thread.id)).rejects.toThrow('already stopping');
    await archive;

    expect(fixture.service.listThreads({ archived: true }).data.map((candidate) => candidate.id))
      .toContain(thread.id);
    await fixture.service.close();
  });

  test('deletes a persistent Thread subtree only after active descendants stop', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Build a child tree' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'delete-child',
      prompt: 'Spawn a grandchild',
      taskPath: '/root/delete_child',
    });
    await fixture.executor.waitUntilWaiting(1);
    const grandchild = await fixture.service.spawnChild({
      parentThreadId: child.thread.id,
      parentTurnId: child.turn.id,
      parentItemId: 'delete-grandchild',
      prompt: 'Remain active',
      taskPath: '/root/delete_child/grandchild',
    });
    await fixture.executor.waitUntilWaiting(2);

    await fixture.service.deleteThread(root.id);

    for (const threadId of [root.id, child.thread.id, grandchild.thread.id]) {
      expect(fixture.stores.metadata.read(threadId)).toBeNull();
      expect(() => fixture.service.readThread({ threadId })).toThrow('Thread not found');
      await expect(readFile(fixture.stores.rollout.pathFor(threadId))).rejects.toThrow();
    }
    expect(fixture.service.listThreads().data).toEqual([]);
    await fixture.service.close();
  });

  test('deletes every ephemeral descendant without leaving orphan Threads', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      ephemeral: true,
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Create ephemeral child' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'ephemeral-child',
      prompt: 'Remain active',
      taskPath: '/root/ephemeral_child',
    });
    await fixture.executor.waitUntilWaiting(1);

    await fixture.service.deleteThread(root.id);

    expect(() => fixture.service.readThread({ threadId: root.id })).toThrow('Thread not found');
    expect(() => fixture.service.readThread({ threadId: child.thread.id })).toThrow('Thread not found');
    expect(fixture.service.listThreads().data).toEqual([]);
    await fixture.service.close();
  });

  test('applies the parent ceiling to every child capability source', async () => {
    const parentConfiguration: EffectiveThreadConfiguration = {
      profileName: 'restricted',
      developerInstructions: ['Parent instructions'],
      model: 'parent-model',
      reasoningEffort: 'medium',
      tools: ['node_read', 'collaboration.spawn_agent'],
      skills: ['allowed-skill'],
      plugins: ['allowed-plugin'],
      mcpServers: ['allowed-mcp'],
    };
    const expansiveRole: AgentRole = {
      name: 'expansive',
      source: 'user',
      description: 'Attempts to expand capabilities.',
      developerInstructions: 'Child instructions',
      overrides: {
        tools: ['node_read', 'bash'],
        skills: ['allowed-skill', 'extra-skill'],
        plugins: ['extra-plugin'],
        mcpServers: ['allowed-mcp', 'extra-mcp'],
      },
    };
    const fixture = await createFixture(undefined, {
      resolveConfiguration: () => parentConfiguration,
      resolveRole: () => expansiveRole,
    });
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Delegate' }],
    });
    await fixture.executor.waitUntilWaiting();
    const child = await fixture.service.spawnCollaborationAgent({
      senderThreadId: root.id,
      senderTurnId: rootTurn.turn.id,
      parentItemId: 'spawn-item',
      taskName: 'worker',
      message: 'Inspect the child configuration',
      role: 'expansive',
    });
    await fixture.executor.waitUntilWaiting(1);
    expect(fixture.executor.contexts[1]?.configuration).toMatchObject({
      tools: ['node_read'],
      skills: ['allowed-skill'],
      plugins: [],
      mcpServers: ['allowed-mcp'],
    });
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(child.thread.id);

    const isolated = await fixture.service.spawnIsolatedSkillThread({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'skill-item',
      skillName: 'research',
      prompt: 'Inspect without tools',
      allowedTools: [],
      readOnly: true,
    });
    await fixture.executor.waitUntilWaiting(2);
    expect(isolated.thread.parentThreadId).toBe(root.id);
    expect(isolated.thread.threadSource).toBe('subagent');
    expect(fixture.executor.contexts[2]?.configuration.tools).toEqual([]);
    fixture.executor.finish(2);
    await fixture.service.waitForIdle(isolated.thread.id);

    fixture.executor.finish(0);
    await fixture.service.waitForIdle(root.id);
    await fixture.service.close();
  });

  test('re-resolves a child Role and current parent ceiling on resume', async () => {
    const parentConfiguration: EffectiveThreadConfiguration = {
      profileName: 'root',
      developerInstructions: ['Initial parent instructions'],
      model: 'parent-model',
      reasoningEffort: 'medium',
      tools: ['node_read', 'bash'],
      skills: ['initial-skill', 'shared-skill'],
      plugins: ['initial-plugin'],
      mcpServers: ['initial-mcp'],
    };
    let role: AgentRole = {
      name: 'mutable',
      source: 'user',
      description: 'Initial child role.',
      developerInstructions: 'Initial role instructions',
      overrides: {
        model: 'initial-role-model',
        reasoningEffort: 'low',
        tools: ['node_read', 'bash'],
        skills: ['initial-skill'],
        plugins: ['initial-plugin'],
        mcpServers: ['initial-mcp'],
      },
    };
    const fixture = await createFixture(undefined, {
      resolveConfiguration: () => parentConfiguration,
      resolveRole: () => role,
    });
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Delegate mutable role work' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'spawn-item',
      prompt: 'Initial child work',
      taskPath: '/root/mutable',
      role: 'mutable',
      allowedTools: ['node_read'],
    });
    await fixture.executor.waitUntilWaiting(1);
    expect(fixture.executor.contexts[1]?.configuration.model).toBe('initial-role-model');
    expect(fixture.executor.contexts[1]?.configuration.reasoningEffort).toBe('low');
    expect(fixture.executor.contexts[1]?.configuration.tools).toEqual(['node_read']);
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(child.thread.id);

    const currentParent: EffectiveThreadConfiguration = {
      ...parentConfiguration,
      developerInstructions: ['Current parent instructions'],
      tools: ['node_read', 'file_read'],
      skills: ['current-skill'],
      plugins: ['current-plugin'],
      mcpServers: ['current-mcp'],
    };
    fixture.stores.metadata.setConfiguration(root.id, currentParent);
    role = {
      ...role,
      developerInstructions: 'Current role instructions',
      overrides: {
        model: 'current-role-model',
        reasoningEffort: 'high',
        tools: ['node_read', 'file_read'],
        skills: ['current-skill'],
        plugins: ['current-plugin'],
        mcpServers: ['current-mcp'],
      },
    };

    await fixture.service.resumeThread(child.thread.id);
    await fixture.service.startPrivilegedTurn({
      threadId: child.thread.id,
      input: [{ type: 'text', text: 'Resume with current configuration' }],
      trigger: { kind: 'subagent', parentThreadId: root.id, parentItemId: 'followup-item' },
    });
    await fixture.executor.waitUntilWaiting(2);
    expect(fixture.executor.contexts[2]?.configuration).toMatchObject({
      developerInstructions: ['Current parent instructions', 'Current role instructions'],
      model: 'current-role-model',
      reasoningEffort: 'high',
      tools: ['node_read'],
      skills: ['current-skill'],
      plugins: ['current-plugin'],
      mcpServers: ['current-mcp'],
    });
    fixture.executor.finish(2);
    await fixture.service.waitForIdle(child.thread.id);
    fixture.executor.finish(0);
    await fixture.service.waitForIdle(root.id);
    await fixture.service.close();
  });

  test('exposes canonical control tools and executes plan, Goal, and collaboration paths', async () => {
    const fixture = await createFixture();
    const notifications: AgentCoreNotification[] = [];
    fixture.service.subscribe((notification) => notifications.push(notification));
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Use the canonical tools' }],
    });
    await fixture.executor.waitUntilWaiting();
    const context = fixture.executor.contexts[0]!;
    const runtime = new ToolRuntime(fixture.service, {
      capabilityTools: () => [],
      capabilityConfig: { blocks: [] },
    });
    const tools = await runtime.createTools(context);
    expect(tools.map((tool) => tool.name)).toEqual([
      'request_user_input',
      'update_plan',
      'get_goal',
      'create_goal',
      'update_goal',
      'collaboration__spawn_agent',
      'collaboration__send_message',
      'collaboration__followup_task',
      'collaboration__wait_agent',
      'collaboration__list_agents',
      'collaboration__interrupt_agent',
    ]);

    const planUpdate = await executeTool(tools, 'update_plan', 'plan-item', {
      explanation: 'Canonical execution plan',
      plan: [{ step: 'Implement', status: 'in_progress' }],
    });
    expect(planUpdate.details).toMatchObject({
      explanation: 'Canonical execution plan',
      plan: [{ step: 'Implement', status: 'in_progress' }],
    });
    expect(notifications).toContainEqual({
      type: 'turn/plan/updated',
      threadId: root.id,
      turnId: context.turn.id,
      explanation: 'Canonical execution plan',
      plan: [{ step: 'Implement', status: 'in_progress' }],
    });
    const createdGoal = await executeTool(tools, 'create_goal', 'goal-create', {
      objective: 'Finish the canonical runtime',
      token_budget: 100,
    });
    expect(createdGoal.details).toMatchObject({ goal: { status: 'active', tokenBudget: 100 } });
    const spawned = await executeTool(tools, 'collaboration__spawn_agent', 'spawn-item', {
      task_name: 'helper',
      message: 'Inspect the runtime',
      fork_turns: 'none',
    });
    await fixture.executor.waitUntilWaiting(1);
    expect(spawned.details).toMatchObject({ task_name: '/root/helper' });
    const listed = await executeTool(tools, 'collaboration__list_agents', 'list-item', {});
    expect(listed.details).toMatchObject({
      result: [{ taskPath: '/root/helper', status: 'running' }],
      capabilityAudit: { behavior: 'allow' },
    });
    await executeTool(tools, 'update_goal', 'goal-update', { status: 'complete' });

    fixture.executor.finish(1);
    const childId = (spawned.details as { thread_id: string }).thread_id;
    await fixture.service.waitForIdle(childId);
    fixture.executor.finish(0);
    await fixture.service.waitForIdle(root.id);
    const stored = fixture.service.readThread({ threadId: root.id, includeTurns: true }).thread;
    expect(stored.turns?.[0]?.items.map((item) => item.type)).not.toContain('plan');
    expect((await fixture.stores.rollout.read(root.id)).map((entry) => entry.event.type))
      .not.toContain('turn/plan/updated');
    expect(stored.turns?.[0]?.items.filter((item) => item.type === 'subAgentActivity')).toMatchObject([
      { kind: 'started', agentThreadId: childId, agentPath: '/root/helper' },
      { kind: 'completed', agentThreadId: childId, agentPath: '/root/helper' },
    ]);
    await fixture.service.close();
  });

  test('scopes collaboration waits and preserves child activity that arrived before waiting', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Coordinate child work' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const interrupted = new AbortController();
    interrupted.abort();
    await expect(fixture.service.waitForCollaborationActivity(
      root.id,
      rootTurn.turn.id,
      1_000,
      interrupted.signal,
    )).rejects.toThrow('interrupted');
    const child = await fixture.service.spawnCollaborationAgent({
      senderThreadId: root.id,
      senderTurnId: rootTurn.turn.id,
      parentItemId: 'wait-spawn',
      taskName: 'wait_child',
      message: 'Complete once',
    });
    await fixture.executor.waitUntilWaiting(1);
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(child.thread.id);

    const alreadyPending = await fixture.service.waitForCollaborationActivity(
      root.id,
      rootTurn.turn.id,
      1_000,
    );
    expect(alreadyPending).toMatchObject([{ threadId: child.thread.id, status: 'completed' }]);

    await fixture.service.followupCollaborationTask(
      root.id,
      rootTurn.turn.id,
      'wait-followup',
      '/root/wait_child',
      'Complete again',
    );
    await fixture.executor.waitUntilWaiting(2);
    let resolved = false;
    const waiting = fixture.service.waitForCollaborationActivity(
      root.id,
      rootTurn.turn.id,
      1_000,
    ).then((result) => {
      resolved = true;
      return result;
    });

    const unrelated = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const unrelatedTurn = await fixture.service.startRendererTurn({
      threadId: unrelated.id,
      input: [{ type: 'text', text: 'Unrelated activity' }],
    });
    await fixture.executor.waitUntilWaiting(3);
    await fixture.service.steerTurn({
      threadId: unrelated.id,
      expectedTurnId: unrelatedTurn.turn.id,
      input: [{ type: 'text', text: 'Still unrelated' }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);

    fixture.executor.finish(2);
    await fixture.service.waitForIdle(child.thread.id);
    expect(await waiting).toMatchObject([{ threadId: child.thread.id, status: 'completed' }]);
    fixture.executor.finish(0);
    fixture.executor.finish(3);
    await fixture.service.waitForIdle(root.id);
    await fixture.service.waitForIdle(unrelated.id);
    await fixture.service.close();
  });

  test('stops Goal continuation before admission when the token budget is exhausted', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.request('goal/create', {
      threadId: thread.id,
      objective: 'Finish within one Turn',
      tokenBudget: 7,
    });

    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Complete the Goal' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish(0, completedExecutionResult());
    await fixture.service.waitForIdle(thread.id);

    expect(fixture.executor.contexts).toHaveLength(1);
    expect((await fixture.service.request('goal/get', { threadId: thread.id })).goal?.status)
      .toBe('budgetLimited');
    await fixture.service.close();
  });

  test('retries a deferred Goal continuation at the next real idle boundary', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.request('goal/create', {
      threadId: thread.id,
      objective: 'Recover the deferred continuation',
    });
    const record = fixture.stores.goals.read(thread.id)!;
    fixture.stores.goals.deferContinuation(thread.id, record.generation, 'User Turn won admission');

    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Finish the competing Turn' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.executor.waitUntilWaiting(1);

    expect(fixture.executor.contexts[1]?.turn.provenance.trigger).toEqual({
      kind: 'feature',
      feature: 'goal_continuation',
      ref: String(record.generation),
    });
    expect(fixture.stores.goals.readDeferral(thread.id)).toBeNull();
    await fixture.service.request('goal/update', { threadId: thread.id, status: 'complete' });
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.executor.contexts).toHaveLength(2);
    await fixture.service.close();
  });

  test('resumes an active Goal continuation after host restart', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.request('goal/create', {
      threadId: thread.id,
      objective: 'Continue after restart',
    });
    await fixture.service.close();

    const executor = new ControlledExecutor();
    const reopened = await openFixture(fixture.root, executor, fixture.clock);
    await reopened.service.initialize();
    await executor.waitUntilWaiting();
    expect(executor.contexts[0]?.turn.provenance.trigger).toMatchObject({
      kind: 'feature',
      feature: 'goal_continuation',
    });

    await reopened.service.request('goal/update', { threadId: thread.id, status: 'complete' });
    executor.finish();
    await reopened.service.waitForIdle(thread.id);
    await reopened.service.close();
  });

  test('assembles extension and capability tools through one executable registry', async () => {
    const registry = new ExtensionRegistry();
    registry.register(new ToolContributionProbe());
    const configuration: EffectiveThreadConfiguration = {
      profileName: 'extension-test',
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: MODEL_TOOL_CATALOG.map((contract) => canonicalModelToolKey(contract.identity)),
      skills: [],
      plugins: ['automation-probe'],
      mcpServers: [],
    };
    const fixture = await createFixture(registry, { resolveConfiguration: () => configuration });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'test',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Use extension tools' }],
    });
    await fixture.executor.waitUntilWaiting();
    const context = fixture.executor.contexts[0]!;
    const runtime = new ToolRuntime(fixture.service, {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
      dynamicTools: () => [{
        name: 'automation_probe__run',
        label: 'Run Automation Probe',
        description: EXTENSION_PROBE_CONTRACT.description,
        parameters: EXTENSION_PROBE_CONTRACT.inputSchema!,
        executionMode: 'sequential',
        execute: async () => ({ content: [{ type: 'text', text: 'updated' }], details: { updated: true } }),
      }],
    });
    const tools = await runtime.createTools(context);
    expect(tools.map((tool) => tool.name)).toContain('generate_image');
    expect(tools.map((tool) => tool.name)).toContain('automation_probe__run');

    const missingImplementation = new ToolRuntime(fixture.service, {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });
    await expect(missingImplementation.createTools(context)).rejects.toThrow(
      'Enabled extension model tool has no runtime implementation',
    );
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });

  test('binds document tool mutations to the executing Thread, Turn, and Item', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      modelProvider: 'test',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Read the outline' }],
    });
    await fixture.executor.waitUntilWaiting();
    const context = fixture.executor.contexts[0]!;
    const core = Core.new();
    const metadata: Array<Parameters<NonNullable<OutlinerToolHost['transaction']>>[0]> = [];
    const outliner: OutlinerToolHost = {
      getProjection: () => core.projection(),
      handle: async () => {
        throw new Error('node_read must not mutate the document');
      },
      transaction: async (meta, operation) => {
        metadata.push(meta);
        return operation();
      },
    };
    const runtime = new ToolRuntime(fixture.service, {
      outliner,
      capabilityConfig: { blocks: [] },
      capabilityTools: (_runtimeContext, wrappedOutliner) => createNodeTools(wrappedOutliner!),
    });
    const tools = await runtime.createTools({
      ...context,
      configuration: { ...context.configuration, tools: ['node_read'] },
    });
    const itemId = context.recorder.createItemId();

    await executeTool(tools, 'node_read', itemId, {
      node_id: core.projection().todayId,
      depth: 0,
    });

    expect(metadata).toEqual([expect.objectContaining({
      causation: { threadId: thread.id, turnId: context.turn.id, itemId },
    })]);
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });
});

class AdmissionProbe implements AgentCoreExtension {
  readonly id = 'admission-probe';
  readonly contexts: TurnAdmissionContext[] = [];

  contributeTurnAdmission(context: TurnAdmissionContext) {
    this.contexts.push(context);
    return { extensionId: this.id, snapshotId: `snapshot-${this.contexts.length}` };
  }
}

class HistoryRollbackProbe implements AgentCoreExtension {
  readonly events: string[] = [];
  readonly contexts: ThreadHistoryRollbackContext[] = [];
  private commitFailures: number;

  constructor(
    readonly id: string,
    private readonly options: { readonly commitFailures?: number; readonly failPrepare?: boolean } = {},
  ) {
    this.commitFailures = options.commitFailures ?? 0;
  }

  prepareHistoryRollback(context: ThreadHistoryRollbackContext): void {
    this.events.push('prepare');
    this.contexts.push(context);
    if (this.options.failPrepare) throw new Error('prepare failed');
  }

  abortHistoryRollback(): void {
    this.events.push('abort');
  }

  commitHistoryRollback(): void {
    this.events.push('commit');
    if (this.commitFailures > 0) {
      this.commitFailures -= 1;
      throw new Error('commit failed');
    }
  }
}

function completedExecutionResult(tokens = 7): TurnExecutionResult {
  return {
    status: 'completed',
    execution: {
      modelProvider: 'openai',
      model: 'test-model',
      reasoningEffort: 'medium',
      usage: {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: null,
      },
    },
  };
}

const EXTENSION_PROBE_CONTRACT = {
  identity: { namespace: 'automation_probe', name: 'run' },
  description: 'Run the Automation extension probe.',
  scope: 'rootThread',
  schemaOwner: 'extension',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string' } },
    required: ['title'],
  },
  actionKinds: ['agent.plan.update'],
} as const;

class ToolContributionProbe implements AgentCoreExtension {
  readonly id = 'automation-probe';

  contributeTools() {
    return { extensionId: this.id, tools: [EXTENSION_PROBE_CONTRACT] };
  }
}

function runtimeSchemaTools(): import('@earendil-works/pi-agent-core').AgentTool[] {
  return MODEL_TOOL_CATALOG.flatMap((contract) => contract.inputSchema === null
    ? [{
        name: canonicalModelToolKey(contract.identity),
        label: contract.identity.name,
        description: contract.description,
        parameters: { type: 'object', additionalProperties: false },
        executionMode: 'sequential' as const,
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: { ok: true } }),
      }]
    : []);
}

interface Fixture {
  root: string;
  service: ThreadService;
  executor: ControlledExecutor;
  clock: () => number;
  stores: ThreadServiceStores;
}

async function createFixture(
  extensions?: ExtensionRegistry,
  options: Pick<
    ConstructorParameters<typeof ThreadService>[0],
    | 'resolveConfiguration'
    | 'resolveRendererStartDefaults'
    | 'resolveRole'
    | 'resolveUserContent'
    | 'validateRendererConfiguration'
    | 'nameGenerator'
    | 'beforeInitialTurnAdmission'
  > = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-thread-service-'));
  roots.push(root);
  let now = 1_720_000_000_000;
  const clock = () => ++now;
  const executor = new ControlledExecutor();
  const opened = await openFixture(root, executor, clock, extensions, options);
  await opened.service.initialize();
  return { root, executor, clock, service: opened.service, stores: opened.stores };
}

async function openFixture(
  root: string,
  executor: ControlledExecutor,
  clock: () => number,
  extensions?: ExtensionRegistry,
  options: Pick<
    ConstructorParameters<typeof ThreadService>[0],
    | 'resolveConfiguration'
    | 'resolveRendererStartDefaults'
    | 'resolveRole'
    | 'resolveUserContent'
    | 'validateRendererConfiguration'
    | 'nameGenerator'
    | 'beforeInitialTurnAdmission'
  > = {},
): Promise<{ service: ThreadService; stores: ThreadServiceStores }> {
  const stores = createStores(root);
  return {
    service: new ThreadService({
      stores,
      executor,
      attachmentScratchRoot: join(root, 'agent-scratch'),
      now: clock,
      extensions,
      ...options,
    }),
    stores,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise<void>((resolve) => setImmediate(resolve));
}

function createStores(root: string): ThreadServiceStores {
  mkdirSync(join(root, 'agent'), { recursive: true });
  const statePath = join(root, 'agent', 'state.sqlite');
  const historyPath = join(root, 'agent', 'thread_history.sqlite');
  const goalsPath = join(root, 'agent', 'goals.sqlite');
  return {
    metadata: new ThreadMetadataStore(statePath, database(statePath)),
    history: new ThreadHistoryProjectionStore(historyPath, database(historyPath)),
    rollout: new RolloutStore(join(root, 'agent', 'rollouts')),
    goals: new GoalStore(goalsPath, database(goalsPath)),
    payloads: new ToolPayloadStore(join(root, 'agent', 'payloads')),
  };
}

function database(path: string): SqliteDatabase {
  return new Database(path, { create: true }) as unknown as SqliteDatabase;
}

async function storageFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await storageFiles(root, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

async function executeTool(
  tools: readonly import('@earendil-works/pi-agent-core').AgentTool[],
  name: string,
  itemId: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(itemId, params);
}
