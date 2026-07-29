import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { AgentEvent, AgentOptions, AgentTool } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Message, Model, SimpleStreamOptions, UserMessage } from '@earendil-works/pi-ai';
import { decodeThread, decodeTurn } from '../../src/core/agent/codec';
import type {
  AgentCoreNotification,
  ContextEvidenceThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  Turn,
  TurnDiagnosticsPayload,
} from '../../src/core/agent/protocol';
import { ItemRecorder } from '../../src/main/agent/runtime/ItemRecorder';
import {
  MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
  MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES,
  MAX_PERSISTED_TOOL_OUTPUT_CHARS,
  MAX_PERSISTED_TOOL_OUTPUT_IMAGES,
  PiEventNormalizer,
  PiTurnExecutor,
  agentProviderPayload,
  normalizeThreadName,
} from '../../src/main/agent/runtime/PiTurnExecutor';
import {
  CanonicalContextProjector,
  serializeUserContent,
} from '../../src/main/agent/context/ContextProjector';
import { planContextCompaction } from '../../src/main/agent/context/ContextCompaction';
import { providerCacheAffinity } from '../../src/main/agent/context/ProviderCache';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';
import { uuidV7 } from '../../src/main/agent/uuid';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS,
  MAX_TOOL_PAYLOAD_IMAGE_BYTES,
} from '../../src/main/agent/persistence/ToolPayloadStore';

describe('PiTurnExecutor event normalization', () => {
  test('serializes stream events and records authoritative message and command Items', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const assistant = assistantMessage([{ type: 'text', text: 'Done' }]);

    normalizer.handle({ type: 'message_start', message: assistant });
    normalizer.handle({
      type: 'message_update',
      message: assistant,
      assistantMessageEvent: { type: 'text_delta', delta: 'Done' },
    } as AgentEvent);
    normalizer.handle({ type: 'message_end', message: assistant });
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: '/workspace' }],
        details: { data: { exitCode: 0 } },
      },
      isError: false,
    });
    normalizer.handle({ type: 'agent_end', messages: [assistant] });
    await normalizer.flush();

    expect(fixture.notifications.map((notification) => notification.type)).toEqual([
      'item/started',
      'item/delta',
      'item/completed',
      'item/started',
      'item/completed',
    ]);
    expect(fixture.recorder.orderedItems()).toMatchObject([
      { type: 'agentMessage', text: 'Done', phase: 'final_answer' },
      {
        type: 'commandExecution',
        id: 'call-bash-1',
        command: 'pwd',
        status: 'completed',
        aggregatedOutput: '/workspace',
        exitCode: 0,
      },
    ]);
    expect(normalizer.usage).toEqual({
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, currency: 'USD' },
    });
    expect(normalizer.stopReason).toBe('stop');
  });

  test('uses the provider call id for collaboration control-plane identity', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-collab-1',
      toolName: 'collaboration__spawn_agent',
      args: { task_name: 'worker', message: 'Inspect it' },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-collab-1',
      toolName: 'collaboration__spawn_agent',
      result: {
        content: [{ type: 'text', text: 'spawned' }],
        details: { task_name: '/root/worker', thread_id: uuidV7(1_720_000_001_000), nickname: null },
      },
      isError: false,
    });
    await normalizer.flush();
    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'collabAgentToolCall',
      id: 'call-collab-1',
      tool: 'spawn_agent',
      status: 'completed',
      prompt: 'Inspect it',
    });
  });

  test('keeps update_plan out of the recorded tool Item stream', async () => {
    const fixture = createContext();
    const observed: unknown[] = [];
    const normalizer = new PiEventNormalizer(fixture.context, {
      started: (execution) => observed.push({ phase: 'started', ...execution }),
      completed: (execution) => observed.push({ phase: 'completed', ...execution }),
    });
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-plan-1',
      toolName: 'update_plan',
      args: { plan: [{ step: 'Implement', status: 'in_progress' }] },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-plan-1',
      toolName: 'update_plan',
      result: { content: [{ type: 'text', text: 'Plan updated' }] },
      isError: false,
    });
    await normalizer.flush();

    expect(fixture.notifications).toEqual([]);
    expect(fixture.recorder.orderedItems()).toEqual([]);
    expect(observed).toEqual([
      expect.objectContaining({
        phase: 'started',
        callId: 'call-plan-1',
        toolName: 'update_plan',
        itemId: null,
      }),
      expect.objectContaining({ phase: 'completed', callId: 'call-plan-1', failed: false }),
    ]);
  });

  test('keeps completed Items immutable in the authoritative recorder', async () => {
    const fixture = createContext();
    const itemId = fixture.recorder.createItemId();
    const started = {
      type: 'agentMessage' as const,
      id: itemId,
      provenance: fixture.recorder.localProvenance(itemId),
      text: '',
      phase: 'final_answer' as const,
      memoryCitation: null,
    };
    const completed = { ...started, text: 'Done' };
    await fixture.recorder.started(started);
    await fixture.recorder.completed(completed);

    await expect(fixture.recorder.delta(itemId, {
      type: 'agentMessageText',
      delta: ' late mutation',
    })).rejects.toThrow('Completed Thread Item is immutable');
    await expect(fixture.recorder.completed(completed)).rejects.toThrow('already completed');
    expect(fixture.notifications.map((notification) => notification.type)).toEqual([
      'item/started',
      'item/completed',
    ]);
  });

  test('preserves partial stream content when an open Item is failed', async () => {
    const fixture = createContext();
    const itemId = fixture.recorder.createItemId();
    await fixture.recorder.started({
      type: 'agentMessage',
      id: itemId,
      provenance: fixture.recorder.localProvenance(itemId),
      text: '',
      phase: null,
      memoryCitation: null,
    });
    await fixture.recorder.delta(itemId, { type: 'agentMessageText', delta: 'Partial output' });

    await fixture.recorder.finishOpenItems('failed');

    expect(fixture.recorder.item(itemId)).toMatchObject({
      type: 'agentMessage',
      text: 'Partial output',
    });
    expect(fixture.notifications.at(-1)).toMatchObject({
      type: 'item/completed',
      item: { type: 'agentMessage', text: 'Partial output' },
    });
  });

  test('gives the model a readable path for non-image attachments', async () => {
    const content = await serializeUserContent([{
      type: 'attachment',
      id: 'attachment-1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      source: { kind: 'localFile', path: '/workspace/agent-attachments/report.pdf' },
    }], fixtureResources());

    expect(content).toEqual([
      { type: 'text', text: 'Please review the attached files.' },
      {
        type: 'text',
        text: '[[file:report.pdf^%2Fworkspace%2Fagent-attachments%2Freport.pdf]]',
      },
      {
        type: 'text',
        text: '[Attachment: report.pdf, application/pdf, 512 bytes]\nReadable path: /workspace/agent-attachments/report.pdf\nUse file_read with this path to inspect the attachment.',
      },
    ]);
  });

  test('uses a scratch observation path for managed non-image attachments', async () => {
    const ref = {
      id: 'b'.repeat(64),
      mimeType: 'application/pdf',
      byteLength: 512,
      fileName: 'report.pdf',
    };
    const input = [{
      type: 'attachment',
      id: 'managed-attachment',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      source: { kind: 'threadPayload', ref },
    }] as const;
    const resources = {
      readResource: async () => null,
      resolveResourceObservationPath: async () => '/scratch/agent-attachments/turn/report.pdf',
    };
    const content = await serializeUserContent(input, resources);

    expect(content).toEqual([
      { type: 'text', text: 'Please review the attached files.' },
      {
        type: 'text',
        text: '[[file:report.pdf^%2Fscratch%2Fagent-attachments%2Fturn%2Freport.pdf]]',
      },
      {
        type: 'text',
        text: '[Attachment: report.pdf, application/pdf, 512 bytes]\nReadable path: /scratch/agent-attachments/turn/report.pdf\nUse file_read with this path to inspect the attachment.',
      },
    ]);
    expect(await serializeUserContent(input, resources)).toEqual(content);
  });

  test('encodes only the persisted prompt image at the provider boundary', async () => {
    const promptImage = {
      id: 'c'.repeat(64),
      mimeType: 'image/png',
      byteLength: 8,
      fileName: 'prompt.png',
    };
    const content = await serializeUserContent([{
      type: 'attachment',
      id: 'attachment-image',
      name: 'source.png',
      mimeType: 'image/png',
      sizeBytes: 4096,
      source: { kind: 'localFile', path: '/outside/source.png' },
      promptImage,
    }], {
      readResource: async (ref) => ref.id === promptImage.id ? Buffer.from('snapshot') : null,
      resolveResourceObservationPath: async () => null,
    });

    expect(content).toEqual([
      { type: 'text', text: 'Please review the attached images.' },
      {
        type: 'text',
        text: '[[file:source.png^%2Foutside%2Fsource.png]]',
      },
      {
        type: 'text',
        text: '[Attachment image: source.png, image/png, 4096 bytes]\nReadable path: /outside/source.png\nThe following image is the immutable prompt snapshot for this attachment.',
      },
      {
        type: 'image',
        data: Buffer.from('snapshot').toString('base64'),
        mimeType: 'image/png',
      },
    ]);
  });

  test('rejects non-canonical image attachment shapes instead of projecting a file fallback', async () => {
    await expect(serializeUserContent([{
      type: 'attachment',
      id: 'missing-prompt-image',
      name: 'source.png',
      mimeType: 'image/png',
      sizeBytes: 4096,
      source: { kind: 'localFile', path: '/outside/source.png' },
    }], fixtureResources())).rejects.toThrow('missing its prompt snapshot');

    await expect(serializeUserContent([{
      type: 'attachment',
      id: 'unexpected-prompt-image',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      source: { kind: 'localFile', path: '/workspace/report.pdf' },
      promptImage: {
        id: 'e'.repeat(64),
        mimeType: 'image/png',
        byteLength: 8,
        fileName: 'prompt.png',
      },
    }], fixtureResources())).rejects.toThrow('Non-image attachment cannot carry a prompt image');
  });

  test('adds one deterministic intent for attachment and Node-only input', async () => {
    const content = await serializeUserContent([
      {
        type: 'attachment',
        id: 'document',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        source: { kind: 'localFile', path: '/workspace/report.pdf' },
      },
      {
        type: 'attachment',
        id: 'image',
        name: 'diagram.png',
        mimeType: 'image/png',
        sizeBytes: 8,
        source: { kind: 'localFile', path: '/workspace/diagram.png' },
        promptImage: {
          id: 'd'.repeat(64),
          mimeType: 'image/png',
          byteLength: 8,
          fileName: 'diagram.png',
        },
      },
      { type: 'nodeReference', nodeId: 'node-1' },
    ], {
      readResource: async () => Buffer.from('snapshot'),
      resolveResourceObservationPath: async () => null,
    });

    expect(content[0]).toEqual({
      type: 'text',
      text: 'Please review the attached files, attached images and referenced Outliner Nodes.',
    });
    expect(content.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'Please review the attached files, attached images and referenced Outliner Nodes.',
      '[[file:report.pdf^%2Fworkspace%2Freport.pdf]][[file:diagram.png^%2Fworkspace%2Fdiagram.png]][[node:node-1^node-1]]',
      '[Attachment: report.pdf, application/pdf, 10 bytes]\nReadable path: /workspace/report.pdf\nUse file_read with this path to inspect the attachment.',
      '[Attachment image: diagram.png, image/png, 8 bytes]\nReadable path: /workspace/diagram.png\nThe following image is the immutable prompt snapshot for this attachment.',
    ]);
    expect(content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  test('preserves file and Node marker positions in mixed user content', async () => {
    const content = await serializeUserContent([
      { type: 'text', text: 'Compare ' },
      { type: 'nodeReference', nodeId: 'node-1', note: 'Plan' },
      { type: 'text', text: ' with ' },
      {
        type: 'attachment',
        id: 'document',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        source: { kind: 'localFile', path: '/workspace/report.pdf' },
      },
      { type: 'text', text: ' before deciding.' },
    ], fixtureResources());

    expect(content).toEqual([
      {
        type: 'text',
        text: 'Compare [[node:Plan^node-1]] with [[file:report.pdf^%2Fworkspace%2Freport.pdf]] before deciding.',
      },
      {
        type: 'text',
        text: '[Attachment: report.pdf, application/pdf, 10 bytes]\nReadable path: /workspace/report.pdf\nUse file_read with this path to inspect the attachment.',
      },
    ]);
  });

  test('does not create an Agent when Stop arrives during any async initialization stage', async () => {
    for (const stage of ['runtime', 'tools'] as const) {
      const fixture = createContext();
      const controller = new AbortController();
      const entered = deferred<void>();
      const release = deferred<void>();
      let agentCreations = 0;
      const waitAt = async (candidate: typeof stage) => {
        if (candidate !== stage) return;
        entered.resolve();
        await release.promise;
      };
      const executor = new PiTurnExecutor({
        resolveRuntimeSettings: async () => runtimeSettings(),
        resolveRuntime: async () => {
          await waitAt('runtime');
          return runtimeSelection();
        },
        createTools: async () => {
          await waitAt('tools');
          return [];
        },
        createAgent: () => {
          agentCreations += 1;
          throw new Error('Agent must not be created after Stop');
        },
      });
      const execution = executor.execute({ ...fixture.context, signal: controller.signal });
      await entered.promise;
      controller.abort();
      release.resolve();

      await expect(execution).resolves.toEqual({ status: 'interrupted' });
      expect(agentCreations).toBe(0);
    }
  });

  test('passes canonical tool order and reset-epoch affinity into Agent creation', async () => {
    const fixture = createContext();
    const captures: Array<{ sessionId: string | undefined; tools: string }> = [];
    const execute = async (
      context: TurnExecutionContext,
      tools: readonly AgentTool[],
    ) => {
      const executor = new PiTurnExecutor({
        resolveRuntimeSettings: async () => runtimeSettings(),
        resolveRuntime: async () => runtimeSelection(),
        createTools: async () => tools,
        createAgent: (options) => {
          captures.push({
            sessionId: options.sessionId,
            tools: JSON.stringify(options.initialState?.tools?.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }))),
          });
          return {
            state: { errorMessage: undefined },
            subscribe: () => () => undefined,
            abort: () => undefined,
            steer: () => undefined,
            prompt: async () => undefined,
          };
        },
      });
      await expect(executor.execute(context)).resolves.toMatchObject({ status: 'completed' });
    };
    const alpha = testTool('alpha', 'First tool');
    const zeta = testTool('zeta', 'Last tool');
    await execute(fixture.context, [zeta, alpha]);
    await execute({
      ...fixture.context,
      thread: decodeThread({
        ...fixture.context.thread,
        sessionId: uuidV7(1_720_000_000_009),
      }),
    }, [alpha, zeta]);

    const resetTurnId = uuidV7(1_720_000_000_080);
    const resetId = uuidV7(1_720_000_000_081);
    const resetTurn = decodeTurn({
      ...fixture.context.turn,
      id: resetTurnId,
      items: [{
        type: 'contextReset',
        id: resetId,
        provenance: {
          originThreadId: fixture.context.thread.id,
          originTurnId: resetTurnId,
          originItemId: resetId,
        },
        clearedThrough: {
          turnId: fixture.context.turn.id,
          itemId: fixture.context.turn.items[0]!.id,
        },
      }],
      status: 'completed',
      completedAt: 1_720_000_000_090,
      durationMs: 10,
    });
    await execute({ ...fixture.context, historyBeforeTurn: [resetTurn] }, [zeta, alpha]);

    expect(captures[0]?.tools).toBe(captures[1]?.tools);
    expect(captures[1]?.tools).toBe(captures[2]?.tools);
    expect(JSON.parse(captures[0]!.tools).map((tool: { name: string }) => tool.name))
      .toEqual(['alpha', 'zeta']);
    expect(captures[0]?.sessionId).toBe(captures[1]?.sessionId);
    expect(captures[2]?.sessionId).not.toBe(captures[0]?.sessionId);
    expect(captures.every((capture) => capture.sessionId?.length === 64)).toBe(true);
  });

  test('keeps a successful Turn and usage when diagnostics persistence fails', async () => {
    const fixture = createContext();
    const failure = new Error('managed diagnostics quota exceeded');
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createTools: async () => [],
      createAgent: () => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => undefined,
      }),
    });

    const result = await executor.execute({
      ...fixture.context,
      persistTurnDiagnostics: async () => { throw failure; },
    });

    expect(result).toMatchObject({
      status: 'completed',
      execution: {
        diagnosticsRef: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    });
    expect(fixture.diagnosticsErrors).toEqual([failure]);
  });

  test('runs the pre-provider hook without changing canonical user input', async () => {
    const fixture = createContext();
    const userItemId = uuidV7(1_720_000_000_110);
    const context: TurnExecutionContext = {
      ...fixture.context,
      turn: {
        ...fixture.context.turn,
        items: [{
          type: 'userMessage',
          id: userItemId,
          provenance: fixture.recorder.localProvenance(userItemId),
          clientId: null,
          acceptedAt: fixture.context.turn.startedAt,
          content: [{ type: 'text', text: 'Hello' }],
        }],
      },
    };
    let receivedPrompt: UserMessage | null = null;
    let transformContext: AgentOptions['transformContext'];
    let providerPreparations = 0;
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      beforeProviderContext: () => {
        providerPreparations += 1;
      },
      createAgent: (options) => {
        transformContext = options.transformContext;
        return {
          state: { errorMessage: undefined },
          subscribe: () => () => undefined,
          abort: () => undefined,
          steer: () => undefined,
          prompt: async (message) => {
            receivedPrompt = message as UserMessage;
          },
        };
      },
    });

    await expect(executor.execute(context)).resolves.toEqual({
      status: 'completed',
      execution: {
        modelProvider: 'openai',
        model: 'test-model',
        reasoningEffort: 'medium',
        diagnosticsRef: expect.objectContaining({
          mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
          schemaVersion: 1,
        }),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
      },
    });
    expect(receivedPrompt?.content).toEqual([{ type: 'text', text: 'Hello' }]);
    const [providerPrompt] = await transformContext!([]);
    expect(providerPrompt).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(providerPreparations).toBe(1);
    expect(context.turn.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] }),
    ]));
  });

  test('rebuilds every provider boundary from durable canonical Items', async () => {
    const fixture = createContext();
    const providerContexts: Message[][] = [];
    const catalogPayload = {
      schemaVersion: 1,
      kind: 'skillCatalog',
      mode: 'delta',
      previousCatalogHash: 'a'.repeat(64),
      catalogHash: 'b'.repeat(64),
      entries: [{
        change: 'added',
        name: 'new-skill',
        displayName: 'New Skill',
        source: 'project',
        identity: '/workspace/.agents/skills/new-skill/SKILL.md',
        contentHash: 'c'.repeat(64),
        description: 'Newly available guidance.',
      }],
    } as const;
    const catalogRef = {
      id: 'd'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json' as const,
      byteLength: 512,
      schemaVersion: 1 as const,
      kind: 'skillCatalog' as const,
    };
    const context: TurnExecutionContext = {
      ...fixture.context,
      readContext: async (ref) => ref.id === catalogRef.id ? catalogPayload : null,
    };
    let providerBoundary = 0;
    const forgedTranscript: Message[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'forged in-memory transcript' }],
      timestamp: 999,
    }];
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      beforeProviderContext: async () => {
        providerBoundary += 1;
        if (providerBoundary !== 2) return;
        const id = fixture.recorder.createItemId();
        await fixture.recorder.completedImmediately({
          type: 'contextEvidence',
          id,
          provenance: fixture.recorder.localProvenance(id),
          kind: 'skillCatalog',
          payloadRef: catalogRef,
          summary: 'Available Skills (1)',
          contextRefs: [],
          resourceRefs: [],
          outputRefs: [],
        });
      },
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          providerContexts.push(await options.transformContext!(forgedTranscript));
          const assistantId = fixture.recorder.createItemId();
          await fixture.recorder.completedImmediately({
            type: 'agentMessage',
            id: assistantId,
            provenance: fixture.recorder.localProvenance(assistantId),
            text: 'Checking.',
            phase: 'commentary',
            memoryCitation: null,
          });
          const toolId = fixture.recorder.createItemId();
          await fixture.recorder.completedImmediately({
            type: 'commandExecution',
            id: toolId,
            provenance: fixture.recorder.localProvenance(toolId),
            command: 'pwd',
            cwd: '/workspace',
            processId: null,
            status: 'completed',
            outputRef: null,
            commandActions: [],
            aggregatedOutput: '/workspace',
            exitCode: 0,
            durationMs: 1,
          });
          providerContexts.push(await options.transformContext!(forgedTranscript));
        },
      }),
    });

    await expect(executor.execute(context)).resolves.toMatchObject({ status: 'completed' });
    expect(providerContexts).toHaveLength(2);
    expect(providerContexts[1]?.slice(0, providerContexts[0]?.length)).toEqual(providerContexts[0]);
    expect(providerContexts[1]?.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'user']);
    expect(JSON.stringify(providerContexts)).not.toContain('forged in-memory transcript');
    expect(JSON.stringify(providerContexts[1])).toContain('/workspace');
    expect(JSON.stringify(providerContexts[0])).not.toContain('new-skill');
    expect(JSON.stringify(providerContexts[1])).toContain('new-skill');
  });

  test('rebuilds complete dynamic context after compaction without replaying Turn-local events', async () => {
    const fixture = createContext();
    const payloads = new Map<string, ThreadContextPayload>();
    const outputRef = {
      id: 'e'.repeat(64),
      mimeType: 'text/plain' as const,
      byteLength: 20,
      summary: 'File snapshot',
    };
    const put = (payload: ThreadContextPayload): ThreadContextPayloadReference => {
      const serialized = JSON.stringify(payload);
      const ref = {
        id: createHash('sha256').update(serialized).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-context+json' as const,
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1 as const,
        kind: payload.kind,
      };
      payloads.set(ref.id, payload);
      return ref;
    };
    const priorTurnId = uuidV7(1_719_990_000_000);
    const evidence = (
      payload: ThreadContextPayload,
      id: string,
      dependencies: {
        readonly contextRefs?: readonly ThreadContextPayloadReference[];
        readonly outputRefs?: readonly typeof outputRef[];
      } = {},
    ): ContextEvidenceThreadItem => {
      const payloadRef = put(payload);
      return {
        type: 'contextEvidence',
        id,
        provenance: {
          originThreadId: fixture.context.thread.id,
          originTurnId: priorTurnId,
          originItemId: id,
        },
        kind: payload.kind as ContextEvidenceThreadItem['kind'],
        payloadRef,
        summary: payload.kind,
        contextRefs: dependencies.contextRefs ?? [],
        resourceRefs: [],
        outputRefs: dependencies.outputRefs ?? [],
      };
    };
    const skillCatalog = {
      schemaVersion: 1 as const,
      kind: 'skillCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: '1'.repeat(64),
      entries: [{
        change: 'available' as const,
        name: 'alpha',
        displayName: 'Alpha',
        source: 'project' as const,
        identity: 'project:alpha',
        contentHash: '2'.repeat(64),
        description: 'ALPHA CATALOG BASELINE',
      }],
    };
    const roleCatalog = {
      schemaVersion: 1 as const,
      kind: 'roleCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: '3'.repeat(64),
      entries: [{
        change: 'available' as const,
        name: 'worker',
        displayName: 'Worker',
        source: 'built-in' as const,
        identity: 'built-in:worker',
        contentHash: '4'.repeat(64),
        description: 'WORKER ROLE BASELINE',
      }],
    };
    const activeSkill = {
      schemaVersion: 1 as const,
      kind: 'skillInvocation' as const,
      name: 'alpha',
      displayName: 'Alpha',
      source: 'project' as const,
      identity: 'project:alpha',
      resourceRoot: '/workspace/.agents/skills/alpha',
      contentHash: '2'.repeat(64),
      instructions: 'ACTIVE ALPHA INSTRUCTIONS',
      arguments: '',
      execution: 'inline' as const,
      invocationSource: 'model' as const,
      constraints: { allowedTools: [], model: null, effort: null },
      invokedAt: 1_719_990_000_010,
    };
    const baselineView = {
      schemaVersion: 1 as const,
      kind: 'userView' as const,
      mode: 'interactive' as const,
      activePanelId: 'panel-1',
      focusedPanelId: 'panel-1',
      focusSurface: 'row' as const,
      focusedNode: { nodeId: 'node-1', title: 'BASELINE VIEW NODE', panelId: 'panel-1', surface: 'row' },
      selectedNodes: [],
      referencedNodes: [],
      panels: [],
      truncated: false,
    };
    const baselineAdditional = {
      schemaVersion: 1 as const,
      kind: 'additionalContext' as const,
      turnEntries: [{
        key: 'old_event',
        source: 'main',
        authority: 'application' as const,
        purpose: 'instruction' as const,
        text: 'OLD TURN EVENT',
      }],
      threadState: [{
        key: 'memory:policy',
        source: 'extension:memory',
        authority: 'application' as const,
        purpose: 'instruction' as const,
        text: 'MEMORY THREAD STATE',
      }],
    };
    const projection = {
      schemaVersion: 1 as const,
      kind: 'toolOutputProjection' as const,
      outputRef,
      projection: { type: 'full' as const },
    };
    const skillCatalogItem = evidence(skillCatalog, 'skill-catalog-before-compact');
    const roleCatalogItem = evidence(roleCatalog, 'role-catalog-before-compact');
    const activeSkillItem = evidence(activeSkill, 'active-skill-before-compact');
    const viewItem = evidence(baselineView, 'view-before-compact');
    const additionalItem = evidence(baselineAdditional, 'additional-before-compact');
    const projectionItem = evidence(projection, 'projection-before-compact', { outputRefs: [outputRef] });
    const priorUserId = uuidV7(1_719_990_000_020);
    const priorToolId = uuidV7(1_719_990_000_021);
    const priorItems: ThreadItem[] = [
      skillCatalogItem,
      roleCatalogItem,
      activeSkillItem,
      viewItem,
      additionalItem,
      {
        type: 'userMessage',
        id: priorUserId,
        provenance: {
          originThreadId: fixture.context.thread.id,
          originTurnId: priorTurnId,
          originItemId: priorUserId,
        },
        clientId: null,
        acceptedAt: 1_719_990_000_020,
        content: [{ type: 'text', text: 'OLD USER REQUEST' }],
      },
      {
        type: 'dynamicToolCall',
        id: priorToolId,
        provenance: {
          originThreadId: fixture.context.thread.id,
          originTurnId: priorTurnId,
          originItemId: priorToolId,
        },
        status: 'completed',
        outputRef,
        namespace: null,
        tool: 'file_read',
        arguments: { file_path: '/workspace/active.md' },
        contentItems: [{ type: 'text', text: 'bounded file snapshot' }],
        success: true,
        durationMs: 1,
      },
      projectionItem,
    ];
    const priorTurn = completedTurn(fixture.context.turn, priorTurnId, priorItems, 1_719_990_000_000);
    const summaryRef = put({
      schemaVersion: 1,
      kind: 'compactionSummary',
      source: 'deterministic',
      text: 'COMPACTED HISTORY SUMMARY',
    });
    const restoredStateRef = put({
      schemaVersion: 1,
      kind: 'compactionRestoredState',
      skillCatalogHash: skillCatalog.catalogHash,
      announcedSkills: [{ name: 'alpha', identity: 'project:alpha', contentHash: activeSkill.contentHash }],
      activeSkills: [{
        name: 'alpha',
        identity: activeSkill.identity,
        contentHash: activeSkill.contentHash,
        payloadRef: activeSkillItem.payloadRef,
      }],
      roleCatalogHash: roleCatalog.catalogHash,
      announcedRoles: [{ name: 'worker', identity: 'built-in:worker', contentHash: '4'.repeat(64) }],
      userViewBaselineRef: viewItem.payloadRef,
      additionalContextBaselineRef: additionalItem.payloadRef,
      activeObservations: [{
        key: 'file:/workspace/active.md',
        tool: 'file_read',
        subject: '/workspace/active.md',
        outputRef,
        projectionRef: projectionItem.payloadRef,
      }],
    });
    const compactTurnId = uuidV7(1_719_990_100_000);
    const compactItemId = uuidV7(1_719_990_100_001);
    const compactTurn = completedTurn(fixture.context.turn, compactTurnId, [{
      type: 'contextCompaction',
      id: compactItemId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: compactTurnId,
        originItemId: compactItemId,
      },
      trigger: 'manual',
      coveredFrom: { turnId: priorTurnId, itemId: skillCatalogItem.id },
      coveredThrough: { turnId: priorTurnId, itemId: projectionItem.id },
      preservedFrom: null,
      summaryRef,
      restoredStateRef,
      instructionsRef: null,
      contextRefs: [activeSkillItem.payloadRef, viewItem.payloadRef, additionalItem.payloadRef, projectionItem.payloadRef],
      resourceRefs: [],
      outputRefs: [outputRef],
    }], 1_719_990_100_000);
    const environmentAfter = evidence({
      schemaVersion: 1,
      kind: 'turnEnvironment',
      utcInstant: '2026-07-28T02:00:00.000Z',
      localDate: '2026-07-28',
      localTime: '10:00:00',
      timeZone: 'Asia/Shanghai',
      utcOffsetMinutes: 480,
      locale: 'zh-CN',
      workingDirectory: '/workspace',
      conversationMode: 'interactive',
      executionMode: 'root',
      replyIdentity: null,
      todayNodeId: null,
      todayNodeTitle: null,
    }, 'environment-after-compact');
    const viewAfter = evidence({
      ...baselineView,
      focusedNode: { ...baselineView.focusedNode, title: 'CHANGED VIEW NODE' },
    }, 'view-after-compact');
    const skillDelta = evidence({
      schemaVersion: 1,
      kind: 'skillCatalog',
      mode: 'delta',
      previousCatalogHash: skillCatalog.catalogHash,
      catalogHash: '5'.repeat(64),
      entries: [{
        change: 'added',
        name: 'beta',
        displayName: 'Beta',
        source: 'project',
        identity: 'project:beta',
        contentHash: '6'.repeat(64),
        description: 'NEW BETA SKILL DELTA',
      }],
    }, 'skill-delta-after-compact');
    const currentAdditional = evidence({
      schemaVersion: 1,
      kind: 'additionalContext',
      turnEntries: [{
        key: 'current_event',
        source: 'main',
        authority: 'application',
        purpose: 'instruction',
        text: 'CURRENT TURN EVENT',
      }],
      threadState: baselineAdditional.threadState,
    }, 'additional-after-compact');
    const currentUser = fixture.context.turn.items[0]!;
    const currentTurn: Turn = {
      ...fixture.context.turn,
      items: [environmentAfter, viewAfter, skillDelta, currentAdditional, currentUser],
    };
    const context: TurnExecutionContext = {
      ...fixture.context,
      historyBeforeTurn: [priorTurn, compactTurn],
      turn: currentTurn,
      readContext: async (ref) => payloads.get(ref.id) ?? null,
      readOutput: async (ref) => ref.id === outputRef.id ? 'ACTIVE FILE OBSERVATION' : null,
    };
    let cacheAffinity: string | undefined;
    let providerMessages: Message[] = [];
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createAgent: (options) => {
        cacheAffinity = options.sessionId;
        return {
          state: { errorMessage: undefined },
          subscribe: () => () => undefined,
          abort: () => undefined,
          steer: () => undefined,
          prompt: async () => {
            providerMessages = await options.transformContext!([]);
          },
        };
      },
    });

    await expect(executor.execute(context)).resolves.toMatchObject({ status: 'completed' });
    const providerText = JSON.stringify(providerMessages);
    expect(providerText).toContain('ALPHA CATALOG BASELINE');
    expect(providerText).toContain('WORKER ROLE BASELINE');
    expect(providerText).toContain('ACTIVE ALPHA INSTRUCTIONS');
    expect(providerText).toContain('BASELINE VIEW NODE');
    expect(providerText).toContain('CHANGED VIEW NODE');
    expect(providerText).toContain('MEMORY THREAD STATE');
    expect(providerText.match(/MEMORY THREAD STATE/g)).toHaveLength(1);
    expect(providerText).toContain('ACTIVE FILE OBSERVATION');
    expect(providerText).toContain('NEW BETA SKILL DELTA');
    expect(providerText).toContain('CURRENT TURN EVENT');
    expect(providerText).toContain('projection_mode=snapshot');
    expect(providerText).toContain('timezone=Asia/Shanghai');
    expect(providerText).not.toContain('OLD TURN EVENT');
    expect(providerText).not.toContain('OLD USER REQUEST');
    expect(cacheAffinity).toBe(providerCacheAffinity(fixture.context.thread.id, []));
  });

  test('records one automatic compaction and replans before an oversized provider request', async () => {
    const fixture = createContext();
    const priorTurnId = uuidV7(1_719_999_000_000);
    const priorUserId = uuidV7(1_719_999_000_001);
    const priorAgentId = uuidV7(1_719_999_000_002);
    const priorTurn = decodeTurn({
      ...fixture.context.turn,
      id: priorTurnId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: priorTurnId,
        trigger: { kind: 'user' },
      },
      status: 'completed',
      startedAt: 1_719_999_000_000,
      completedAt: 1_719_999_000_100,
      durationMs: 100,
      items: [
        {
          type: 'userMessage',
          id: priorUserId,
          provenance: {
            originThreadId: fixture.context.thread.id,
            originTurnId: priorTurnId,
            originItemId: priorUserId,
          },
          clientId: null,
          acceptedAt: 1_719_999_000_000,
          content: [{ type: 'text', text: `OLD HISTORY ${'x'.repeat(8_000)}` }],
        },
        {
          type: 'agentMessage',
          id: priorAgentId,
          provenance: {
            originThreadId: fixture.context.thread.id,
            originTurnId: priorTurnId,
            originItemId: priorAgentId,
          },
          text: 'OLD ANSWER',
          phase: 'final_answer',
          memoryCitation: null,
        },
      ],
    });
    const recentTurnId = uuidV7(1_719_999_500_000);
    const recentUserId = uuidV7(1_719_999_500_001);
    const recentAgentId = uuidV7(1_719_999_500_002);
    const recentTurn = decodeTurn({
      ...fixture.context.turn,
      id: recentTurnId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: recentTurnId,
        trigger: { kind: 'user' },
      },
      status: 'completed',
      startedAt: 1_719_999_500_000,
      completedAt: 1_719_999_500_100,
      durationMs: 100,
      items: [
        {
          type: 'userMessage',
          id: recentUserId,
          provenance: {
            originThreadId: fixture.context.thread.id,
            originTurnId: recentTurnId,
            originItemId: recentUserId,
          },
          clientId: null,
          acceptedAt: 1_719_999_500_000,
          content: [{ type: 'text', text: 'RECENT COMPLETE TURN' }],
        },
        {
          type: 'agentMessage',
          id: recentAgentId,
          provenance: {
            originThreadId: fixture.context.thread.id,
            originTurnId: recentTurnId,
            originItemId: recentAgentId,
          },
          text: 'RECENT ANSWER',
          phase: 'final_answer',
          memoryCitation: null,
        },
      ],
    });
    const payloads = new Map<string, import('../../src/core/agent/protocol').ThreadContextPayload>();
    const writePayload = (payload: import('../../src/core/agent/protocol').ThreadContextPayload) => {
      const serialized = JSON.stringify(payload);
      const ref = {
        id: createHash('sha256').update(serialized).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-context+json' as const,
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1 as const,
        kind: payload.kind,
      };
      payloads.set(ref.id, payload);
      return ref;
    };
    let compactions = 0;
    let preservedFrom: import('../../src/core/agent/protocol').ContextCursor | null = null;
    const providerContexts: Message[][] = [];
    const context: TurnExecutionContext = {
      ...fixture.context,
      historyBeforeTurn: [priorTurn, recentTurn],
      readContext: async (ref) => payloads.get(ref.id) ?? null,
      stageContextCompaction: async (trigger, requestedPreserveFrom) => {
        compactions += 1;
        preservedFrom = requestedPreserveFrom ?? null;
        const summaryRef = writePayload({
          schemaVersion: 1,
          kind: 'compactionSummary',
          source: 'deterministic',
          text: 'COMPACTED OLD HISTORY',
        });
        const restoredStateRef = writePayload({
          schemaVersion: 1,
          kind: 'compactionRestoredState',
          skillCatalogHash: null,
          announcedSkills: [],
          activeSkills: [],
          roleCatalogHash: null,
          announcedRoles: [],
          userViewBaselineRef: null,
          additionalContextBaselineRef: null,
          activeObservations: [],
        });
        const id = fixture.recorder.createItemId();
        const item = {
          type: 'contextCompaction',
          id,
          provenance: fixture.recorder.localProvenance(id),
          trigger,
          coveredFrom: { turnId: priorTurn.id, itemId: priorUserId },
          coveredThrough: { turnId: priorTurn.id, itemId: priorAgentId },
          preservedFrom: { turnId: recentTurn.id, itemId: recentUserId },
          summaryRef,
          restoredStateRef,
          instructionsRef: null,
          contextRefs: [],
          resourceRefs: [],
          outputRefs: [],
        } as import('../../src/core/agent/protocol').ContextCompactionThreadItem;
        return stagedTestCompaction(fixture.recorder, item);
      },
    };
    const smallModel = { ...testModel, contextWindow: 2_020, maxTokens: 200 };
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => ({
        model: smallModel,
        thinkingLevel: 'medium',
        getApiKey: async () => undefined,
      }),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          providerContexts.push(await options.transformContext!([]));
        },
      }),
    });

    await expect(executor.execute(context)).resolves.toMatchObject({ status: 'completed' });
    expect(compactions).toBe(1);
    expect(preservedFrom).toEqual({ turnId: recentTurn.id, itemId: recentUserId });
    expect(JSON.stringify(providerContexts)).toContain('COMPACTED OLD HISTORY');
    expect(JSON.stringify(providerContexts)).toContain('RECENT COMPLETE TURN');
    expect(JSON.stringify(providerContexts)).toContain('RECENT ANSWER');
    expect(JSON.stringify(providerContexts)).toContain('Test request');
    expect(JSON.stringify(providerContexts)).not.toContain('x'.repeat(500));
    expect(JSON.stringify(providerContexts)).not.toContain('OLD ANSWER');
    expect(fixture.recorder.orderedItems().at(-1)).toMatchObject({
      type: 'contextCompaction',
      trigger: 'automaticPreflight',
    });
  });

  test('advances automatic compaction boundaries until the bounded summary and active input fit', async () => {
    const fixture = createContext();
    const history = Array.from({ length: 8 }, (_, index) => {
      const startedAt = 1_719_990_000_000 + index * 1_000;
      const turnId = uuidV7(startedAt);
      const userId = uuidV7(startedAt + 1);
      const agentId = uuidV7(startedAt + 2);
      return completedTurn(fixture.context.turn, turnId, [
        {
          type: 'userMessage',
          id: userId,
          provenance: {
            originThreadId: fixture.context.thread.id,
            originTurnId: turnId,
            originItemId: userId,
          },
          clientId: null,
          acceptedAt: startedAt,
          content: [{ type: 'text', text: `HISTORY-${index}:${'x'.repeat(6_000)}` }],
        },
        {
          type: 'agentMessage',
          id: agentId,
          provenance: {
            originThreadId: fixture.context.thread.id,
            originTurnId: turnId,
            originItemId: agentId,
          },
          text: `ANSWER-${index}`,
          phase: 'final_answer',
          memoryCitation: null,
        },
      ], startedAt);
    });
    const payloads = new Map<string, ThreadContextPayload>();
    const put = (payload: ThreadContextPayload): ThreadContextPayloadReference => {
      const serialized = JSON.stringify(payload);
      const ref: ThreadContextPayloadReference = {
        id: createHash('sha256').update(serialized).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-context+json',
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1,
        kind: payload.kind,
      };
      payloads.set(ref.id, payload);
      return ref;
    };
    const preservePositions: number[] = [];
    const context: TurnExecutionContext = {
      ...fixture.context,
      historyBeforeTurn: history,
      readContext: async (ref) => payloads.get(ref.id) ?? null,
      stageContextCompaction: async (trigger, preserveFrom) => {
        const historyIndex = history.findIndex((turn) => turn.id === preserveFrom?.turnId);
        const position = historyIndex >= 0
          ? historyIndex
          : preserveFrom?.turnId === fixture.context.turn.id
            ? history.length
            : -1;
        if (position < 0) throw new Error('Automatic compaction selected an unknown preserve boundary.');
        preservePositions.push(position);
        const plan = await planContextCompaction({
          turns: [
            ...history,
            {
              ...fixture.context.turn,
              items: [...fixture.context.turn.items, ...fixture.recorder.orderedItems()],
            },
          ],
          preserveFrom,
          readContext: async (ref) => payloads.get(ref.id) ?? null,
        });
        if (!plan) return null;
        const summaryRef = put(plan.summary);
        const restoredStateRef = put(plan.restoredState);
        const id = fixture.recorder.createItemId();
        const item = {
          type: 'contextCompaction',
          id,
          provenance: fixture.recorder.localProvenance(id),
          trigger,
          coveredFrom: plan.coveredFrom,
          coveredThrough: plan.coveredThrough,
          preservedFrom: plan.preservedFrom,
          summaryRef,
          restoredStateRef,
          instructionsRef: null,
          contextRefs: plan.contextRefs,
          resourceRefs: [],
          outputRefs: plan.outputRefs,
        } as import('../../src/core/agent/protocol').ContextCompactionThreadItem;
        let staged = true;
        return {
          item,
          commit: async () => {
            if (!staged) throw new Error('Test compaction is no longer staged.');
            staged = false;
            return await fixture.recorder.completedImmediately(
              item,
            ) as import('../../src/core/agent/protocol').ContextCompactionThreadItem;
          },
          discard: async () => {
            staged = false;
          },
        };
      },
    };
    const providerContexts: Message[][] = [];
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => ({
        model: { ...testModel, contextWindow: 12_000, maxTokens: 3_000 },
        thinkingLevel: 'medium',
        getApiKey: async () => undefined,
      }),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          providerContexts.push(await options.transformContext!([]));
        },
      }),
    });

    const result = await executor.execute(context);
    expect(result).toMatchObject({ status: 'completed' });
    expect(preservePositions.length).toBeGreaterThan(1);
    expect(new Set(preservePositions).size).toBe(preservePositions.length);
    for (let index = 1; index < preservePositions.length; index += 1) {
      expect(preservePositions[index]).toBeGreaterThan(preservePositions[index - 1]!);
    }
    expect(JSON.stringify(providerContexts)).toContain('Test request');
    expect(JSON.stringify(providerContexts)).not.toContain('HISTORY-0');
    const compactionActivities = fixture.diagnosticsPayloads[0]?.activities.filter((activity) => (
      activity.type === 'contextCompaction' && activity.trigger === 'automaticPreflight'
    ));
    expect(compactionActivities).toHaveLength(1);
    expect(fixture.recorder.orderedItems().filter((item) => item.type === 'contextCompaction')).toHaveLength(1);
  });

  test('compacts an oversized inherited prefix without dropping current admission evidence', async () => {
    const fixture = createContext();
    const payloads = new Map<string, import('../../src/core/agent/protocol').ThreadContextPayload>();
    const put = (payload: import('../../src/core/agent/protocol').ThreadContextPayload) => {
      const serialized = JSON.stringify(payload);
      const ref = {
        id: createHash('sha256').update(serialized).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-context+json' as const,
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1 as const,
        kind: payload.kind,
      };
      payloads.set(ref.id, payload);
      return ref;
    };
    const sourceThreadId = uuidV7(1_719_000_000_000);
    const sourceTurnId = uuidV7(1_719_000_000_100);
    const sourceContextId = uuidV7(1_719_000_000_101);
    const sourceUserId = uuidV7(1_719_000_000_102);
    const oversizedRef = put({
      schemaVersion: 1,
      kind: 'additionalContext',
      turnEntries: [{
        key: 'oversized_parent_context',
        source: 'parent',
        authority: 'untrusted',
        purpose: 'observation',
        text: `OVERSIZED INHERITED ${'x'.repeat(16_000)}`,
      }],
      threadState: null,
    });
    const sourceTurn = decodeTurn({
      ...fixture.context.turn,
      id: sourceTurnId,
      provenance: { originThreadId: sourceThreadId, originTurnId: sourceTurnId, trigger: { kind: 'user' } },
      status: 'completed',
      completedAt: 1_719_000_000_200,
      durationMs: 100,
      items: [
        {
          type: 'contextEvidence',
          id: sourceContextId,
          provenance: { originThreadId: sourceThreadId, originTurnId: sourceTurnId, originItemId: sourceContextId },
          kind: 'additionalContext',
          payloadRef: oversizedRef,
          summary: 'Oversized inherited observation',
          contextRefs: [],
          resourceRefs: [],
          outputRefs: [],
        },
        {
          type: 'userMessage',
          id: sourceUserId,
          provenance: { originThreadId: sourceThreadId, originTurnId: sourceTurnId, originItemId: sourceUserId },
          clientId: null,
          acceptedAt: fixture.context.turn.startedAt,
          content: [{ type: 'text', text: 'Parent request' }],
        },
      ],
    });
    const inheritedRef = put({
      schemaVersion: 1,
      kind: 'inheritedContext',
      sourceThreadId,
      coveredThrough: { turnId: sourceTurnId, itemId: sourceUserId },
      requestedTurns: 'all',
      turns: [sourceTurn],
    });
    const currentEvidenceRef = put({
      schemaVersion: 1,
      kind: 'additionalContext',
      turnEntries: [{
        key: 'current_admission',
        source: 'main',
        authority: 'application',
        purpose: 'instruction',
        text: 'CURRENT ADMISSION MUST SURVIVE',
      }],
      threadState: null,
    });
    const inheritedId = uuidV7(1_720_000_000_102);
    const currentEvidenceId = uuidV7(1_720_000_000_103);
    const currentUserId = uuidV7(1_720_000_000_104);
    const currentTurn = decodeTurn({
      ...fixture.context.turn,
      items: [
        {
          type: 'contextEvidence',
          id: inheritedId,
          provenance: fixture.recorder.localProvenance(inheritedId),
          kind: 'inheritedContext',
          payloadRef: inheritedRef,
          summary: 'Inherited parent context (1 Turn)',
          contextRefs: [oversizedRef],
          resourceRefs: [],
          outputRefs: [],
        },
        {
          type: 'contextEvidence',
          id: currentEvidenceId,
          provenance: fixture.recorder.localProvenance(currentEvidenceId),
          kind: 'additionalContext',
          payloadRef: currentEvidenceRef,
          summary: 'Current admission instruction',
          contextRefs: [],
          resourceRefs: [],
          outputRefs: [],
        },
        {
          type: 'userMessage',
          id: currentUserId,
          provenance: fixture.recorder.localProvenance(currentUserId),
          clientId: null,
          acceptedAt: fixture.context.turn.startedAt,
          content: [{ type: 'text', text: 'CURRENT CHILD TASK' }],
        },
      ],
    });
    let preserveFrom: import('../../src/core/agent/protocol').ContextCursor | null = null;
    let compactions = 0;
    const context: TurnExecutionContext = {
      ...fixture.context,
      turn: currentTurn,
      readContext: async (ref) => payloads.get(ref.id) ?? null,
      stageContextCompaction: async (trigger, requestedPreserveFrom) => {
        compactions += 1;
        preserveFrom = requestedPreserveFrom ?? null;
        const plan = await planContextCompaction({
          turns: [{ ...currentTurn, items: [
            ...currentTurn.items,
            ...fixture.recorder.orderedItems(),
          ] }],
          preserveFrom: requestedPreserveFrom,
          readContext: async (ref) => payloads.get(ref.id) ?? null,
        });
        if (!plan) throw new Error('Expected inherited-prefix compaction plan.');
        const summaryRef = put(plan.summary);
        const restoredStateRef = put(plan.restoredState);
        const id = fixture.recorder.createItemId();
        const item = {
          type: 'contextCompaction',
          id,
          provenance: fixture.recorder.localProvenance(id),
          trigger,
          coveredFrom: plan.coveredFrom,
          coveredThrough: plan.coveredThrough,
          preservedFrom: plan.preservedFrom,
          summaryRef,
          restoredStateRef,
          instructionsRef: null,
          contextRefs: plan.contextRefs,
          resourceRefs: [],
          outputRefs: plan.outputRefs,
        } as import('../../src/core/agent/protocol').ContextCompactionThreadItem;
        return stagedTestCompaction(fixture.recorder, item);
      },
    };
    const providerContexts: Message[][] = [];
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => ({
        model: { ...testModel, contextWindow: 3_000, maxTokens: 200 },
        thinkingLevel: 'medium',
        getApiKey: async () => undefined,
      }),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          providerContexts.push(await options.transformContext!([]));
        },
      }),
    });

    await expect(executor.execute(context)).resolves.toMatchObject({ status: 'completed' });
    expect(compactions).toBe(1);
    expect(preserveFrom).toEqual({ turnId: currentTurn.id, itemId: currentEvidenceId });
    expect(fixture.recorder.orderedItems()).toContainEqual(expect.objectContaining({
      type: 'contextCompaction',
      coveredFrom: { turnId: currentTurn.id, itemId: inheritedId },
      coveredThrough: { turnId: currentTurn.id, itemId: inheritedId },
      preservedFrom: { turnId: currentTurn.id, itemId: currentEvidenceId },
    }));
    expect(JSON.stringify(providerContexts)).toContain('Inherited parent context (1 Turn)');
    expect(JSON.stringify(providerContexts)).toContain('CURRENT ADMISSION MUST SURVIVE');
    expect(JSON.stringify(providerContexts)).toContain('CURRENT CHILD TASK');
    expect(JSON.stringify(providerContexts)).not.toContain('x'.repeat(1_000));
    expect(fixture.diagnosticsPayloads[0]?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'contextCompaction',
        trigger: 'automaticPreflight',
        sourceCallIndex: null,
        nextCallIndex: null,
      }),
    ]));
  });

  test('replays tool images from Thread-owned snapshots at the next provider boundary', async () => {
    const fixture = createContext();
    const imageBytes = Buffer.from('provider-visible-image');
    const imageBase64 = imageBytes.toString('base64');
    const imageRef = {
      id: 'c'.repeat(64),
      mimeType: 'image/png',
      byteLength: imageBytes.byteLength,
      fileName: 'tool-output.png',
    };
    let persistedImage: Buffer | null = null;
    let listener: ((event: AgentEvent) => void | Promise<void>) | null = null;
    const providerContexts: Message[][] = [];
    const context: TurnExecutionContext = {
      ...fixture.context,
      persistOutputImage: async (dataBase64) => {
        persistedImage = Buffer.from(dataBase64, 'base64');
        return imageRef;
      },
      readResource: async (ref) => ref.id === imageRef.id ? persistedImage : null,
    };
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          providerContexts.push(await options.transformContext!([]));
          await listener!({
            type: 'tool_execution_start',
            toolCallId: 'call-image',
            toolName: 'file_read',
            args: { file_path: '/workspace/diagram.png' },
          });
          await listener!({
            type: 'tool_execution_end',
            toolCallId: 'call-image',
            toolName: 'file_read',
            result: {
              content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
              details: {
                data: {
                  type: 'image',
                  file: { filePath: '/workspace/diagram.png' },
                },
              },
            },
            isError: false,
          });
          providerContexts.push(await options.transformContext!([]));
        },
      }),
    });

    await expect(executor.execute(context)).resolves.toMatchObject({ status: 'completed' });
    expect(persistedImage).toEqual(imageBytes);
    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'dynamicToolCall',
      contentItems: [{
        type: 'image',
        source: { kind: 'localFile', path: '/workspace/diagram.png' },
        promptImage: imageRef,
      }],
    });
    expect(fixture.recorder.orderedItems()[1]).toMatchObject({
      type: 'contextEvidence',
      kind: 'toolOutputProjection',
      outputRefs: [expect.objectContaining({ id: expect.any(String) })],
    });
    const replayedResult = providerContexts[1]?.find((message) => message.role === 'toolResult');
    expect(replayedResult?.content).toEqual(expect.arrayContaining([{
      type: 'image',
      data: imageBase64,
      mimeType: 'image/png',
    }]));
  });

  test('runs internal Memory Turns with only their exact prompt and model runtime', async () => {
    const fixture = createContext();
    const userItemId = uuidV7(1_720_000_000_111);
    const context: TurnExecutionContext = {
      ...fixture.context,
      thread: decodeThread({
        ...fixture.context.thread,
        source: 'agent.memory',
        threadSource: 'memory_consolidation',
      }),
      turn: decodeTurn({
        ...fixture.context.turn,
        items: [{
          type: 'userMessage',
          id: userItemId,
          provenance: fixture.recorder.localProvenance(userItemId),
          clientId: null,
          acceptedAt: fixture.context.turn.startedAt,
          content: [{ type: 'text', text: '{"task":"extract"}' }],
        }],
      }),
      configuration: {
        ...fixture.context.configuration,
        developerInstructions: ['Return exact Memory JSON.'],
        tools: ['bash'],
        skills: ['repo-skill'],
        plugins: ['app-plugin'],
        mcpServers: ['docs'],
      },
    };
    const capabilityCallbacks: string[] = [];
    let initialState: { systemPrompt: string; tools: readonly unknown[] } | null = null;
    let receivedPrompt: UserMessage | null = null;
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createTools: async () => {
        capabilityCallbacks.push('tools');
        return [];
      },
      beforeProviderContext: async () => {
        capabilityCallbacks.push('prepare');
      },
      streamSimple: (model, _providerContext, options = {}) => {
        const stream = createAssistantMessageEventStream();
        const response = assistantMessage([]);
        queueMicrotask(async () => {
          await options.onPayload?.({
            model: 'test-model',
            input: _providerContext.messages,
            response_format: { type: 'json_object' },
          }, model);
          await options.onResponse?.({
            status: 200,
            headers: { 'request-id': 'memory-request-1', 'set-cookie': 'private-cookie' },
          }, model);
          stream.push({ type: 'done', reason: 'stop', message: response });
          stream.end(response);
        });
        return stream;
      },
      createAgent: (options) => {
        initialState = options.initialState;
        return {
          state: { errorMessage: undefined },
          subscribe: () => () => undefined,
          abort: () => undefined,
          steer: () => undefined,
          prompt: async (message) => {
            receivedPrompt = message as UserMessage;
            const stream = options.streamFn!(testModel, {
              systemPrompt: 'Return exact Memory JSON.',
              tools: [],
              messages: [message as UserMessage],
            }, {
              onPayload: options.onPayload,
              onResponse: options.onResponse,
            });
            for await (const _event of stream) { /* drain */ }
          },
        };
      },
    });

    await expect(executor.execute(context)).resolves.toMatchObject({ status: 'completed' });
    expect(capabilityCallbacks).toEqual([]);
    expect(initialState?.systemPrompt).toBe('Return exact Memory JSON.');
    expect(initialState?.tools).toEqual([]);
    expect(receivedPrompt?.content).toEqual([{ type: 'text', text: '{"task":"extract"}' }]);
    expect(fixture.diagnosticsPayloads).toHaveLength(1);
    expect(fixture.diagnosticsPayloads[0]).toMatchObject({
      stablePrompt: null,
      providerCalls: [{
        index: 0,
          request: {
            kind: 'object',
            fields: [
              { name: 'model', representation: 'inline', value: 'test-model' },
              {
                name: 'input',
                representation: 'fragments',
                container: 'array',
                fragmentIds: [expect.any(String)],
                fragmentPartProvenance: [[{ source: 'unknown' }]],
              },
              { name: 'response_format', representation: 'inline', value: { type: 'json_object' } },
              { name: 'text', representation: 'inline', value: { verbosity: 'low' } },
            ],
          },
          transportResponse: {
            httpStatus: 200,
            requestId: 'memory-request-1',
          },
        }],
    });
  });

  test('reconstructs canonical tool calls, results, and reasoning for later Turns', async () => {
    const fixture = createContext();
    const threadId = fixture.context.thread.id;
    const turnId = fixture.context.turn.id;
    const provenance = (id: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: id });
    const context: TurnExecutionContext = {
      ...fixture.context,
      historyBeforeTurn: [{
        ...fixture.context.turn,
        status: 'completed',
        completedAt: 1_720_000_000_200,
        durationMs: 100,
        items: [
          { type: 'userMessage', id: 'user-1', provenance: provenance('user-1'), clientId: null, acceptedAt: 1_720_000_000_000, content: [{ type: 'text', text: 'Inspect it' }] },
          { type: 'agentMessage', id: 'agent-1', provenance: provenance('agent-1'), text: 'Checking.', phase: 'commentary', memoryCitation: null },
          { type: 'reasoning', id: 'reason-1', provenance: provenance('reason-1'), summary: ['Need evidence'], content: ['Inspect the workspace'] },
          {
            type: 'commandExecution',
            id: 'call-1',
            provenance: provenance('call-1'),
            command: 'pwd',
            cwd: '/workspace',
            processId: null,
            status: 'completed',
            outputRef: null,
            commandActions: [],
            aggregatedOutput: '/workspace',
            exitCode: 0,
            durationMs: 5,
          },
          {
            type: 'mcpToolCall',
            id: 'call-2',
            provenance: provenance('call-2'),
            server: 'docs',
            tool: 'search',
            status: 'completed',
            outputRef: null,
            arguments: { query: 'Thread' },
            pluginId: null,
            result: { matches: 2 },
            error: null,
            durationMs: 7,
          },
        ],
      }],
    };

    const messages = await new CanonicalContextProjector(testModel, context)
      .projectTurns(context.historyBeforeTurn);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'toolResult']);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'text', text: '[Reasoning]\nNeed evidence\nInspect the workspace' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd', cwd: '/workspace' } },
        { type: 'toolCall', id: 'call-2', name: 'docs__search', arguments: { query: 'Thread' } },
      ],
    });
    expect(messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', content: [{ text: '/workspace' }] });
    expect(messages[3]).toMatchObject({ role: 'toolResult', toolCallId: 'call-2', content: [{ text: '{"matches":2}' }] });
  });

  test('bounds persisted tool projections and stores typed image sources instead of base64', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS * 3);
    const fileImageBase64 = Buffer.from('file-image-secret').toString('base64');
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-file-1',
      toolName: 'file_read',
      args: { file_path: '/workspace/large.png', echoed: oversized },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-file-1',
      toolName: 'file_read',
      result: {
        content: [
          { type: 'text', text: oversized },
          { type: 'image', data: fileImageBase64, mimeType: 'image/png' },
        ],
        details: {
          ok: true,
          tool: 'file_read',
          version: 1,
          status: 'success',
          data: { type: 'image', file: { filePath: '/workspace/large.png', base64: fileImageBase64 } },
        },
      },
      isError: false,
    });
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-bash-2',
      toolName: 'bash',
      args: { command: 'produce output' },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-2',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: oversized }], details: { data: { exitCode: 0 } } },
      isError: false,
    });
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-images-3',
      toolName: 'inspect_images',
      args: {},
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-images-3',
      toolName: 'inspect_images',
      result: {
        content: Array.from({ length: MAX_PERSISTED_TOOL_OUTPUT_IMAGES + 5 }, (_, index) => ({
          type: 'image' as const,
          data: Buffer.from(`image-${index}`).toString('base64'),
          mimeType: 'image/png',
        })),
      },
      isError: false,
    });
    const nearLimitImage = 'A'.repeat(Math.floor(MAX_TOOL_PAYLOAD_IMAGE_BYTES / 3) * 4);
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-image-budget-4',
      toolName: 'inspect_large_images',
      args: {},
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-image-budget-4',
      toolName: 'inspect_large_images',
      result: {
        content: [
          {
            type: 'image',
            data: Buffer.from('not-an-image-mime').toString('base64'),
            mimeType: 'text/plain',
          },
          { type: 'image', data: 'A'.repeat(MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS + 4), mimeType: 'image/png' },
          { type: 'image', data: nearLimitImage, mimeType: 'image/png' },
          { type: 'image', data: nearLimitImage, mimeType: 'image/png' },
          { type: 'image', data: nearLimitImage, mimeType: 'image/png' },
        ],
      },
      isError: false,
    });
    await normalizer.flush();

    const [fileRead, command, images, budgetedImages] = fixture.recorder.orderedItems();
    expect(fileRead).toMatchObject({
      type: 'dynamicToolCall',
      contentItems: [
        { type: 'text' },
        {
          type: 'image',
          source: { kind: 'localFile', path: '/workspace/large.png' },
          promptImage: { id: 'b'.repeat(64) },
        },
      ],
    });
    expect(JSON.stringify(fileRead)).not.toContain(fileImageBase64);
    expect(JSON.stringify((fileRead as Extract<typeof fileRead, { type: 'dynamicToolCall' }>).arguments).length)
      .toBeLessThanOrEqual(MAX_PERSISTED_TOOL_ARGUMENT_CHARS);
    expect(command).toMatchObject({ type: 'commandExecution', status: 'completed' });
    const output = (command as Extract<typeof command, { type: 'commandExecution' }>).aggregatedOutput!;
    expect(output.length).toBeLessThanOrEqual(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
    expect(output).toContain('chars omitted');
    expect(images).toMatchObject({ type: 'dynamicToolCall', status: 'completed' });
    const imageContent = (images as Extract<typeof images, { type: 'dynamicToolCall' }>).contentItems!;
    const persistedImages = imageContent.filter((content) => content.type === 'image');
    expect(persistedImages).toHaveLength(MAX_PERSISTED_TOOL_OUTPUT_IMAGES);
    expect(persistedImages.every((content) => content.source.kind === 'threadPayload')).toBe(true);
    expect(imageContent.at(-1)).toMatchObject({
      type: 'json',
      value: { imagesOmitted: 5, reasons: { countLimit: 5 } },
    });
    const budgetedContent = (budgetedImages as Extract<typeof budgetedImages, { type: 'dynamicToolCall' }>).contentItems!;
    expect(budgetedContent.filter((content) => content.type === 'image')).toHaveLength(2);
    expect(budgetedContent.at(-1)).toMatchObject({
      type: 'json',
      value: {
        imagesOmitted: 3,
        reasons: { invalidMimeType: 1, imageByteLimit: 1, callByteLimit: 1 },
        limits: {
          maxImageBytes: MAX_TOOL_PAYLOAD_IMAGE_BYTES,
          maxCallBytes: MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES,
        },
      },
    });
    expect(JSON.stringify([images, budgetedImages])).not.toContain(nearLimitImage.slice(0, 100));
  });

  test('never persists inline image bytes as text and reports snapshot quota omission', async () => {
    const fixture = createContext();
    const imageBase64 = Buffer.from('small-image-bytes').toString('base64');
    let completeOutput = '';
    const context: TurnExecutionContext = {
      ...fixture.context,
      persistOutputImage: async () => {
        throw new Error('Managed attachment exceeds the Thread storage quota.');
      },
      persistOutputText: async (_itemId, text, mimeType, summary) => {
        completeOutput = text;
        return {
          id: 'e'.repeat(64),
          mimeType,
          byteLength: Buffer.byteLength(text),
          summary,
        };
      },
    };
    const normalizer = new PiEventNormalizer(context);
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-quota-image',
      toolName: 'inspect_image',
      args: {},
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-quota-image',
      toolName: 'inspect_image',
      result: { content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }] },
      isError: false,
    });
    await normalizer.flush();

    expect(completeOutput).not.toContain(imageBase64);
    expect(completeOutput).toContain(`[binary image omitted: ${imageBase64.length} base64 chars]`);
    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'dynamicToolCall',
      status: 'completed',
      contentItems: [{
        type: 'json',
        value: { imagesOmitted: 1, reasons: { quotaExceeded: 1 } },
      }],
    });
  });
});

describe('PiTurnExecutor provider payload', () => {
  test('requests detailed reasoning summaries from Responses APIs', () => {
    expect(agentProviderPayload({
      model: 'test-model',
      reasoning: { effort: 'high', summary: 'auto' },
    }, testModel)).toEqual({
      model: 'test-model',
      reasoning: { effort: 'high', summary: 'detailed' },
    });
    expect(agentProviderPayload({ model: 'test-model' }, testModel)).toBeUndefined();
  });

  test('applies one runtime policy to provider requests and retries overflow after canonical compaction', async () => {
    const fixture = createContext();
    const seenOptions: SimpleStreamOptions[] = [];
    const compactionTriggers: string[] = [];
    let providerCalls = 0;
    fixture.context.compactContext = async (trigger) => {
      compactionTriggers.push(trigger);
      return {} as import('../../src/core/agent/protocol').ContextCompactionThreadItem;
    };
    const state: { errorMessage?: string } = {};
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => ({
        ...runtimeSettings(),
        providerTimeoutMs: 4_321,
        providerMaxRetries: 2,
        providerMaxRetryDelayMs: 75,
        providerCacheRetention: 'short',
      }),
      streamSimple: (model, _providerContext, options = {}) => {
        providerCalls += 1;
        seenOptions.push(options);
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          ...assistantMessage(providerCalls === 1 ? [] : [{ type: 'text', text: 'Recovered' }]),
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: providerCalls === 1 ? 'error' : 'stop',
          ...(providerCalls === 1
            ? { errorMessage: 'context_length_exceeded: maximum context length reached' }
            : {}),
        };
        queueMicrotask(() => {
          if (message.stopReason === 'error') {
            stream.push({ type: 'error', reason: 'error', error: message });
          } else {
            stream.push({ type: 'done', reason: 'stop', message });
          }
          stream.end(message);
        });
        return stream;
      },
      createAgent: (options) => ({
        state,
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          const messages = await options.transformContext!([]) as Message[];
          const stream = options.streamFn!(testModel, { messages, tools: [] });
          for await (const _event of stream) { /* drain */ }
          const result = await stream.result();
          state.errorMessage = result.errorMessage;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });
    expect(providerCalls).toBe(2);
    expect(compactionTriggers).toEqual(['providerOverflow']);
    expect(seenOptions).toHaveLength(2);
    expect(seenOptions.map((options) => ({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      maxRetryDelayMs: options.maxRetryDelayMs,
      cacheRetention: options.cacheRetention,
    }))).toEqual([
      { timeoutMs: 4_321, maxRetries: 2, maxRetryDelayMs: 75, cacheRetention: 'none' },
      { timeoutMs: 4_321, maxRetries: 2, maxRetryDelayMs: 75, cacheRetention: 'none' },
    ]);
  });
});

describe('PiTurnExecutor Thread naming', () => {
  test('normalizes model output into one bounded plain-text name', () => {
    expect(normalizeThreadName('  **Title: "Refactor the Agent runtime"**\nExtra explanation  '))
      .toBe('Refactor the Agent runtime');
    expect(normalizeThreadName('标题：\u201c整理每日记忆\u201d')).toBe('整理每日记忆');
    expect(normalizeThreadName('   ')).toBeNull();
    expect(Array.from(normalizeThreadName('a'.repeat(100)) ?? '')).toHaveLength(80);
  });

  test('uses the current Thread runtime without mutating the terminal Turn', async () => {
    const fixture = createContext();
    const userItemId = uuidV7(1_720_000_000_110);
    const agentItemId = uuidV7(1_720_000_000_120);
    const turn = decodeTurn({
      ...fixture.context.turn,
      items: [
        {
          type: 'userMessage',
          id: userItemId,
          provenance: fixture.recorder.localProvenance(userItemId),
          clientId: null,
          acceptedAt: fixture.context.turn.startedAt,
          content: [{ type: 'text', text: 'Refactor the Thread runtime' }],
        },
        {
          type: 'agentMessage',
          id: agentItemId,
          provenance: fixture.recorder.localProvenance(agentItemId),
          text: 'Implemented the canonical runtime.',
          phase: 'final_answer',
          memoryCitation: null,
        },
      ],
      status: 'completed',
      completedAt: 1_720_000_000_200,
      durationMs: 100,
    });
    let receivedTurn = turn;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      completeName: async (context, runtime) => {
        receivedTurn = context.turn;
        expect(runtime.model.id).toBe('test-model');
        return '\n### Conversation title: `Canonical Thread model`\n';
      },
    });

    await expect(executor.generateName({
      thread: fixture.context.thread,
      turn,
      configuration: fixture.context.configuration,
      signal: new AbortController().signal,
    })).resolves.toBe('Canonical Thread model');
    expect(receivedTurn).toBe(turn);
  });
});

const testModel = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://example.test',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<Api>;

function runtimeSelection() {
  return {
    model: testModel,
    thinkingLevel: 'medium' as const,
    getApiKey: async () => undefined,
  };
}

function runtimeSettings() {
  return {
    additionalSkillDirectories: [],
    providerTimeoutMs: null,
    providerMaxRetries: null,
    providerMaxRetryDelayMs: 60_000,
    providerCacheRetention: 'short' as const,
    disabledSkills: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createContext(): {
  context: TurnExecutionContext;
  recorder: ItemRecorder;
  notifications: AgentCoreNotification[];
  diagnosticsPayloads: TurnDiagnosticsPayload[];
  diagnosticsErrors: unknown[];
} {
  const threadId = uuidV7(1_720_000_000_000);
  const turnId = uuidV7(1_720_000_000_100);
  const thread = decodeThread({
    id: threadId,
    sessionId: uuidV7(1_720_000_000_001),
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: null,
    preview: '',
    ephemeral: true,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/workspace',
    createdAt: 1_720_000_000_000,
    updatedAt: 1_720_000_000_000,
    status: { type: 'active', activeFlags: [] },
    historyMode: 'paginated',
  });
  const userItemId = uuidV7(1_720_000_000_101);
  const turn = decodeTurn({
    id: turnId,
    items: [{
      type: 'userMessage',
      id: userItemId,
      provenance: {
        originThreadId: threadId,
        originTurnId: turnId,
        originItemId: userItemId,
      },
      clientId: null,
      acceptedAt: 1_720_000_000_100,
      content: [{ type: 'text', text: 'Test request' }],
    }],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'test-model',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt: 1_720_000_000_100,
    completedAt: null,
    durationMs: null,
  });
  const notifications: AgentCoreNotification[] = [];
  const contextPayloads = new Map<string, import('../../src/core/agent/protocol').ThreadContextPayload>();
  const outputPayloads = new Map<string, string>();
  const diagnosticsPayloads: TurnDiagnosticsPayload[] = [];
  const diagnosticsErrors: unknown[] = [];
  const recorder = new ItemRecorder(threadId, turnId, [], async (notification) => {
    notifications.push(notification);
  });
  const context: TurnExecutionContext = {
    thread,
    turn,
    historyBeforeTurn: [],
    configuration: {
      profileName: 'default',
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: ['bash', 'collaboration.spawn_agent'],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    signal: new AbortController().signal,
    recorder,
    readContext: async () => null,
    readOutput: async (ref) => outputPayloads.get(ref.id) ?? null,
    resolveResourceObservationPath: async () => null,
    readResource: async () => null,
    persistOutputImage: async () => ({
      id: 'b'.repeat(64),
      mimeType: 'image/png',
      byteLength: 12,
      fileName: 'tool-output.png',
    }),
    persistOutputText: async (_itemId, text, mimeType, summary) => {
      const id = createHash('sha256').update(text).digest('hex');
      outputPayloads.set(id, text);
      return { id, mimeType, byteLength: Buffer.byteLength(text, 'utf8'), summary };
    },
    persistContextEvidence: async (payload, summary) => {
      const serialized = JSON.stringify(payload);
      const payloadId = createHash('sha256').update(serialized).digest('hex');
      contextPayloads.set(payloadId, payload);
      const id = recorder.createItemId();
      return await recorder.completedImmediately({
        type: 'contextEvidence',
        id,
        provenance: recorder.localProvenance(id),
        kind: payload.kind,
        payloadRef: {
          id: payloadId,
          mimeType: 'application/vnd.tenon.agent-context+json',
          byteLength: Buffer.byteLength(serialized),
          schemaVersion: 1,
          kind: payload.kind,
        },
        summary,
        contextRefs: [],
        resourceRefs: [],
        outputRefs: payload.kind === 'toolOutputProjection' ? [payload.outputRef] : [],
      }) as import('../../src/core/agent/protocol').ContextEvidenceThreadItem;
    },
    persistTurnDiagnostics: async (payload) => {
      const serialized = JSON.stringify(payload);
      diagnosticsPayloads.push(payload);
      return {
        id: createHash('sha256').update(serialized).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1,
      };
    },
    onTurnDiagnosticsError: (error) => diagnosticsErrors.push(error),
    persistSkillCatalog: async () => null,
    compactContext: async () => null,
    stageContextCompaction: async () => null,
    onProviderRetry: () => undefined,
    onSteer: () => undefined,
  };
  context.readContext = async (ref) => contextPayloads.get(ref.id) ?? null;
  return { context, recorder, notifications, diagnosticsPayloads, diagnosticsErrors };
}

function completedTurn(base: Turn, id: string, items: readonly ThreadItem[], startedAt: number): Turn {
  return {
    ...base,
    id,
    items,
    provenance: {
      originThreadId: base.provenance.originThreadId,
      originTurnId: id,
      trigger: { kind: 'user' },
    },
    status: 'completed',
    completedAt: startedAt + 100,
    durationMs: 100,
    startedAt,
  };
}

function stagedTestCompaction(
  recorder: ItemRecorder,
  item: import('../../src/core/agent/protocol').ContextCompactionThreadItem,
) {
  let staged = true;
  return {
    item,
    commit: async () => {
      if (!staged) throw new Error('Test compaction is no longer staged.');
      staged = false;
      return await recorder.completedImmediately(
        item,
      ) as import('../../src/core/agent/protocol').ContextCompactionThreadItem;
    },
    discard: async () => {
      staged = false;
    },
  };
}

function fixtureResources() {
  return {
    readResource: async () => null,
    resolveResourceObservationPath: async () => null,
  };
}

function testTool(name: string, description: string): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  } as AgentTool;
}

function assistantMessage(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    usage: {
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1_720_000_000_200,
  };
}
