import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, spyOn, test } from 'bun:test';
import type {
  AgentEvent,
  AgentTool,
  KernelAgentOptions,
} from '../../src/main/agent/runtime/kernel/types';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Message, Model, SimpleStreamOptions, UserMessage } from '@earendil-works/pi-ai';
import { stream as streamAnthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { decodeThread, decodeTurn } from '../../src/core/agent/codec';
import {
  AGENT_MESSAGE_INPUT_SCHEMA,
  AGENT_MESSAGE_TOOL_DESCRIPTION,
  AGENT_TOOL_DESCRIPTION,
  TASK_STOP_INPUT_SCHEMA,
  TASK_STOP_TOOL_DESCRIPTION,
  agentInputSchema,
} from '../../src/core/agent/tools';
import type {
  AgentCoreNotification,
  ContextEvidenceThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadFileSource,
  ThreadImageArtifactReference,
  ThreadItem,
  ThreadResourceReference,
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
  ThreadResourceQuotaError,
} from '../../src/main/agent/persistence/ToolPayloadStore';
import { NativeAgentRuntime } from '../../src/main/agent/runtime/kernel/NativeAgentRuntime';
import { PiModelGateway } from '../../src/main/agent/runtime/kernel/ModelGateway';
import { createImageArtifactReference } from '../../src/main/agent/imageArtifacts';
import {
  persistToolCallAdmission,
  transientToolCallAdmission,
} from '../../src/main/agent/runtime/toolCallHistory';
import {
  replayableModelCall,
  TEST_TOOL_SCHEMA_DIGEST,
  toolAdmissionEvent,
} from '../fixtures/agentToolCallHistory';

const NATIVE_KERNEL_GOLDEN = JSON.parse(readFileSync(
  new URL('./fixtures/nativeTurnKernel.golden.json', import.meta.url),
  'utf8',
)) as { itemDiagnostics: unknown };
const ONE_PIXEL_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP1j0wAAAABJRU5ErkJggg==',
  'base64',
);
const REFERENCE_NODE_ID = 'node:11111111-1111-4111-8111-111111111111';
const REFERENCE_NODE_MARKER = '[[node://11111111-1111-4111-8111-111111111111]]';

describe('PiTurnExecutor event normalization', () => {
  test('serializes stream events and records authoritative message and command Items', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const assistant = assistantMessage([{ type: 'text', text: 'Done' }]);
    const artifactRef: ThreadResourceReference = {
      id: 'd'.repeat(64),
      mimeType: 'text/plain',
      byteLength: 10,
      fileName: 'command.log',
    };

    normalizer.handle({ type: 'message_start', message: assistant });
    normalizer.handle({
      type: 'message_update',
      message: assistant,
      assistantMessageEvent: { type: 'text_delta', delta: 'Done' },
    } as AgentEvent);
    normalizer.handle({ type: 'message_end', message: assistant });
    normalizer.handle(toolAdmissionEvent('call-bash-1', 'bash', { command: 'pwd' }));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: '/workspace' }],
        details: { data: { exitCode: 0 } },
        resourceRefs: [artifactRef, artifactRef],
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
        resourceRefs: [artifactRef],
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

  test('message_restart completes the interrupted items and opens fresh ones', async () => {
    const fixture = createContext();
    const observedCompletions: string[] = [];
    const normalizer = new PiEventNormalizer(fixture.context, {
      assistantCompleted: ({ message }) => observedCompletions.push(message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')),
    });
    const interrupted = {
      ...assistantMessage([
        {
          type: 'thinking' as const,
          thinking: 'Interrupted reasoning',
          thinkingSignature: openAIReasoningSignature('interrupted'),
        },
        { type: 'text' as const, text: 'Interrupted answer' },
      ]),
      stopReason: 'pending' as const,
    };
    const fresh = assistantMessage([{ type: 'text', text: 'Fresh answer' }]);

    normalizer.handle({ type: 'message_start', message: interrupted });
    normalizer.handle({
      type: 'message_update',
      message: interrupted,
      assistantMessageEvent: { type: 'thinking_delta', delta: 'Interrupted reasoning' },
    } as AgentEvent);
    normalizer.handle({
      type: 'message_update',
      message: interrupted,
      assistantMessageEvent: { type: 'text_delta', delta: 'Interrupted answer' },
    } as AgentEvent);
    normalizer.handle({ type: 'message_restart', message: interrupted });
    normalizer.handle({ type: 'message_start', message: fresh });
    normalizer.handle({
      type: 'message_update',
      message: fresh,
      assistantMessageEvent: { type: 'text_delta', delta: 'Fresh answer' },
    } as AgentEvent);
    normalizer.handle({ type: 'message_end', message: fresh });
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()).toMatchObject([
      { type: 'agentMessage', text: 'Interrupted answer', phase: 'interrupted' },
      { type: 'reasoning', content: ['Interrupted reasoning'] },
      { type: 'agentMessage', text: 'Fresh answer', phase: 'final_answer' },
    ]);
    expect(fixture.notifications.map((notification) => notification.type)).toEqual([
      'item/started',
      'item/started',
      'item/delta',
      'item/delta',
      'item/completed',
      'item/completed',
      'item/started',
      'item/delta',
      'item/completed',
    ]);
    expect(observedCompletions).toEqual(['Fresh answer']);
    expect(normalizer.usage.totalTokens).toBe(7);

    const projected = await new CanonicalContextProjector(
      runtimeSelection().model,
      fixture.context,
    ).projectTurns([{
      ...fixture.context.turn,
      items: [...fixture.context.turn.items, ...fixture.recorder.orderedItems()],
    }]);
    expect(JSON.stringify(projected)).not.toContain('Interrupted answer');
    expect(JSON.stringify(projected)).toContain('Fresh answer');
  });

  test('a retried stream does not concatenate onto the interrupted message', async () => {
    const fixture = createContext();
    let attempts = 0;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => ({
        ...runtimeSettings(),
        providerMaxRetryDelayMs: 1,
      }),
      createTools: async () => [],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, providerContext, options = {}) => {
          attempts += 1;
          const attempt = attempts;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(async () => {
            await options.onPayload?.({ model: model.id, input: providerContext.messages }, model);
            await options.onResponse?.({ status: 200, headers: {} }, model);
            const text = attempt === 1 ? 'Partial segment' : 'Replacement segment';
            const partial = {
              ...assistantMessage([{ type: 'text' as const, text }]),
              stopReason: 'pending' as const,
            };
            stream.push({ type: 'start', partial });
            stream.push({ type: 'text_start', contentIndex: 0, partial });
            stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
            if (attempt === 1) {
              const error = {
                ...partial,
                stopReason: 'error' as const,
                errorMessage: 'stream_read_error',
              };
              stream.push({ type: 'error', reason: 'error', error });
              stream.end(error);
              return;
            }
            const completed = assistantMessage([{ type: 'text', text }]);
            stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: completed });
            stream.push({ type: 'done', reason: 'stop', message: completed });
            stream.end(completed);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });

    expect(attempts).toBe(2);
    expect(fixture.recorder.orderedItems()
      .filter((item): item is Extract<ThreadItem, { type: 'agentMessage' }> => item.type === 'agentMessage')
      .map((item) => item.text)).toEqual(['Partial segment', 'Replacement segment']);
  });

  test('never lands a non-zero exit code on a command Item with nothing beside it', async () => {
    // The transcript hangs the exit code on the output section's heading, so a
    // code that outlived its output would be unreachable in the UI. It cannot:
    // both fields come from the same completion literal, and the envelope the
    // output is read from is never empty. This pins that coupling from the
    // executor side, where breaking it would otherwise be silent.
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent('call-bash-fail', 'bash', { command: 'false' }));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-fail',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: '{\n  "ok": false,\n  "data": {}\n}' }],
        details: { data: { exitCode: 2 } },
      },
      isError: true,
    });
    await normalizer.flush();

    const [item] = fixture.recorder.orderedItems();
    expect(item).toMatchObject({ type: 'commandExecution', status: 'failed', exitCode: 2 });
    const command = item as Extract<ThreadItem, { type: 'commandExecution' }>;
    expect(command.aggregatedOutput ?? '').not.toBe('');
  });

  test('keeps admitted and rejected bash cwd host-owned while preserving canonical dispositions', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent(
      'call-bash-valid',
      'bash',
      { command: 'pwd', description: 'Print the working directory' },
    ));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-valid',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: fixture.context.thread.cwd }], details: { data: { exitCode: 0 } } },
      isError: false,
    });
    normalizer.handle({
      type: 'tool_call_admission',
      toolCallId: 'call-bash-invalid',
      providerToolCallId: 'call-bash-invalid',
      toolName: 'bash',
      decision: {
        execute: false,
        displayArguments: { command: 'pwd', cwd: '/model-supplied' },
        modelCall: {
          disposition: 'evidenceOnly',
          identity: { namespace: null, name: 'bash' },
          providerName: 'bash',
          redactedArgumentsSummary: { command: 'pwd', cwd: '/model-supplied' },
          reason: 'invalidArguments',
          correction: 'Use the active schema.',
        },
      },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-invalid',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Unexpected property: cwd' }], details: {} },
      isError: true,
    });
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()).toMatchObject([
      {
        type: 'commandExecution',
        id: 'call-bash-valid',
        command: 'pwd',
        description: 'Print the working directory',
        cwd: fixture.context.thread.cwd,
        status: 'completed',
        modelCall: {
          disposition: 'replayable',
          arguments: {
            storage: 'inline',
            value: { command: 'pwd', description: 'Print the working directory' },
          },
        },
      },
      {
        type: 'commandExecution',
        id: 'call-bash-invalid',
        command: 'pwd',
        cwd: fixture.context.thread.cwd,
        status: 'failed',
        modelCall: {
          disposition: 'evidenceOnly',
          reason: 'invalidArguments',
          redactedArgumentsSummary: { command: 'pwd', cwd: '/model-supplied' },
        },
      },
    ]);
    expect(fixture.recorder.orderedItems().every((item) => (
      item.type !== 'commandExecution' || item.cwd !== '/model-supplied'
    ))).toBe(true);
  });

  test('uses bounded redacted evidence identity for an unresolved provider tool', async () => {
    const fixture = createContext();
    const secret = 'abcdefghijklmnop';
    const rawProviderName = `missing_Authorization: Bearer ${secret}`;
    let observedToolName = '';
    const normalizer = new PiEventNormalizer(fixture.context, {
      started: (execution) => { observedToolName = execution.toolName; },
    });
    const decision = transientToolCallAdmission({
      toolCallId: 'unknown-call',
      providerName: rawProviderName,
      outcome: {
        type: 'rejected',
        identity: null,
        redactedArguments: { authorization: '[redacted]' },
        reason: 'unresolvedTool',
        correction: 'Choose an exposed tool.',
      },
    });
    normalizer.handle({
      type: 'tool_call_admission',
      toolCallId: 'unknown-call',
      providerToolCallId: 'unknown-call',
      toolName: rawProviderName,
      decision,
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'unknown-call',
      toolName: rawProviderName,
      result: { content: [{ type: 'text', text: 'Tool is not exposed by the active registry.' }], details: {} },
      isError: true,
    });
    await normalizer.flush();

    const serialized = JSON.stringify({ items: fixture.recorder.orderedItems(), observedToolName });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[redacted secret-like content]');
    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'dynamicToolCall',
      status: 'failed',
      modelCall: { disposition: 'evidenceOnly', identity: null },
    });
  });

  test('lets a refused Skill result reach the model instead of killing the Turn', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent('call-skill', 'skill', { skill: 'research', args: 'weather' }));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-skill',
      toolName: 'skill',
      result: {
        // The shape a refusal actually takes: an ordinary result whose envelope
        // reports its own failure and carries guidance written for the model.
        content: [{ type: 'text', text: 'Subagent token budget exhausted; the child refuses new work.' }],
        details: {
          ok: false,
          tool: 'skill',
          status: 'error',
          error: { code: 'subagent_budget_exhausted', message: 'exhausted' },
          data: { success: false, skill: 'research' },
          instructions: 'Interrupt, review its output, or spawn a fresh child.',
        },
      },
      isError: false,
    });

    // No invocation evidence, because no Skill ran — and no throw, because the
    // whole point of the envelope is that the model gets to read it.
    await normalizer.flush();
    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'dynamicToolCall',
      tool: 'skill',
      status: 'completed',
    });
  });

  test('reads Agent task arguments into the retained orchestration Item shape', async () => {
    // A provider that fills an omitted optional parameter with "" rather than
    // omitting the key: the empty string reached the Item, the Item failed to
    // decode, and the Turn died before anything was recorded.
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent(
      'call-collab-blank',
      'agent',
      { description: 'Check weather', prompt: 'Check the weather', model: '' },
    ));
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'collabAgentToolCall',
      prompt: 'Check the weather',
      model: null,
      reasoningEffort: null,
    });
  });

  test('names a blank file path unknown, the same as an absent one', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent('call-blank-path', 'file_write', { path: '   ', content: 'x' }));
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'fileChange',
      changes: [{ path: '(unknown path)' }],
    });
  });

  test('records agentId from an Agent launch result', async () => {
    const fixture = createContext();
    const childThreadId = uuidV7(1_720_000_001_000);
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent(
      'call-collab-1',
      'agent',
      { description: 'Inspect code', prompt: 'Inspect it' },
    ));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-collab-1',
      toolName: 'agent',
      result: {
        content: [{ type: 'text', text: 'spawned' }],
        details: { agentId: childThreadId },
      },
      isError: false,
    });
    await normalizer.flush();
    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'collabAgentToolCall',
      id: 'call-collab-1',
      tool: 'agent',
      status: 'completed',
      prompt: 'Inspect it',
      agentsStates: {
        [childThreadId]: {
          status: 'running',
          taskPath: null,
          nickname: null,
          role: null,
        },
      },
    });
  });

  test('records resumedAgentId from an Agent message result', async () => {
    const fixture = createContext();
    const childThreadId = uuidV7(1_720_000_001_100);
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent(
      'call-collab-wait',
      'agent_message',
      { to: childThreadId, summary: 'Continue inspection', message: 'Continue' },
    ));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-collab-wait',
      toolName: 'agent_message',
      result: {
        content: [{ type: 'text', text: 'completed child result' }],
        details: {
          resumedAgentId: childThreadId,
          pin: { id: childThreadId, name: childThreadId, ref: 'short-ref' },
        },
      },
      isError: false,
    });
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'collabAgentToolCall',
      id: 'call-collab-wait',
      tool: 'agent_message',
      status: 'completed',
      receiverThreadIds: [childThreadId],
      agentsStates: {
        [childThreadId]: {
          status: 'running',
          taskPath: null,
          nickname: null,
          role: null,
        },
      },
    });
  });

  test('writes the prepared Agent message summary without mutating canonical model history', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const rawArguments = {
      to: uuidV7(1_720_000_001_150),
      message: 'First line\nSecond line',
    };
    const modelCall = replayableModelCall('agent_message', rawArguments);
    normalizer.handle({
      type: 'tool_call_admission',
      toolCallId: 'call-collab-summary',
      providerToolCallId: 'call-collab-summary',
      toolName: 'agent_message',
      decision: {
        execute: true,
        modelCall,
        displayArguments: { ...rawArguments, summary: 'First line' },
      },
    });
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'collabAgentToolCall',
      prompt: rawArguments.message,
      summary: 'First line',
      modelCall,
    });
    expect(modelCall).toEqual(replayableModelCall('agent_message', rawArguments));
  });

  test('does not turn a collaboration tool failure into a child failure', async () => {
    const fixture = createContext();
    const childThreadId = uuidV7(1_720_000_001_200);
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent(
      'call-collab-send',
      'agent_message',
      { to: childThreadId, summary: 'Continue inspection', message: 'Continue' },
    ));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-collab-send',
      toolName: 'agent_message',
      result: {
        content: [{ type: 'text', text: 'message delivery failed' }],
        details: {
          taskPath: '/root/worker',
          threadId: childThreadId,
          nickname: null,
          role: 'worker',
          status: 'running',
        },
      },
      isError: true,
    });
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'collabAgentToolCall',
      status: 'failed',
      agentsStates: {
        [childThreadId]: {
          status: 'running',
          taskPath: '/root/worker',
          role: 'worker',
        },
      },
    });
  });

  test('records update_plan like any other tool call', async () => {
    const fixture = createContext();
    const observed: unknown[] = [];
    const normalizer = new PiEventNormalizer(fixture.context, {
      started: (execution) => observed.push({ phase: 'started', ...execution }),
      completed: (execution) => observed.push({ phase: 'completed', ...execution }),
    });
    normalizer.handle(toolAdmissionEvent(
      'call-plan-1',
      'update_plan',
      { plan: [{ step: 'Implement', status: 'in_progress' }] },
    ));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-plan-1',
      toolName: 'update_plan',
      result: { content: [{ type: 'text', text: 'Plan updated' }] },
      isError: false,
    });
    await normalizer.flush();

    // The session shows the real process: a Plan update is an execution the
    // agent performed, so it is recorded like every other one (PM ruling
    // 2026-07-31, reversing #438's transient exclusion).
    const items = fixture.recorder.orderedItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'dynamicToolCall', tool: 'update_plan', status: 'completed' });
    expect(observed).toEqual([
      expect.objectContaining({
        phase: 'started',
        callId: 'call-plan-1',
        toolName: 'update_plan',
        itemId: items[0]!.id,
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
        text: 'report.pdf: [[file:///workspace/agent-attachments/report.pdf]]',
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
        text: 'report.pdf: [[file:///scratch/agent-attachments/turn/report.pdf]]',
      },
      {
        type: 'text',
        text: '[Attachment: report.pdf, application/pdf, 512 bytes]\nReadable path: /scratch/agent-attachments/turn/report.pdf\nUse file_read with this path to inspect the attachment.',
      },
    ]);
    expect(await serializeUserContent(input, resources)).toEqual(content);
  });

  test('encodes only the persisted image observation at the provider boundary', async () => {
    const observation = {
      id: 'c'.repeat(64),
      mimeType: 'image/png',
      byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
      fileName: 'prompt.png',
    };
    const artifactRef = imageArtifact(
      { kind: 'localFile', path: '/outside/source.png' },
      observation,
      { width: 4_000, height: 2_000 },
      { width: 2_000, height: 1_000 },
    );
    const content = await serializeUserContent([{
      type: 'attachment',
      id: 'attachment-image',
      name: 'source.png',
      mimeType: 'image/png',
      sizeBytes: 4096,
      source: { kind: 'localFile', path: '/outside/source.png' },
      artifactRef,
    }], {
      readResource: async (ref) => ref.id === observation.id ? ONE_PIXEL_PNG_BYTES : null,
      resolveResourceObservationPath: async () => null,
      resolveImageArtifactPath: async () => '/outside/source.png',
    });

    expect(content).toEqual([
      { type: 'text', text: 'Please review the attached images.' },
      {
        type: 'text',
        text: 'source.png: [[file:///outside/source.png]]',
      },
      {
        type: 'text',
        text: [
          '[Attachment image: source.png, image/png, 4096 bytes]',
          `Artifact: ${artifactRef.id}`,
          'Readable path: /outside/source.png',
          'Image geometry: observation=2000x1000; source=4000x2000',
          'Source pixels per observation pixel: x=2, y=2',
          'Observation-to-source matrix: [2, 0, 0, 2, 0, 0]',
          'The following image is the immutable model observation for this attachment.',
        ].join('\n'),
      },
      {
        type: 'image',
        data: ONE_PIXEL_PNG_BYTES.toString('base64'),
        mimeType: 'image/png',
      },
    ]);
  });

  test('keeps an image observation when its readable path cannot be materialized', async () => {
    const observation = {
      id: 'f'.repeat(64),
      mimeType: 'image/png',
      byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
      fileName: 'prompt.png',
    };
    const artifactRef = imageArtifact(
      { kind: 'localFile', path: '/outside/source.png' },
      observation,
    );
    const warningLog = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const content = await serializeUserContent([{
        type: 'attachment',
        id: 'attachment-image',
        name: 'source.png',
        mimeType: 'image/png',
        sizeBytes: 4096,
        source: { kind: 'localFile', path: '/outside/source.png' },
        artifactRef,
      }], {
        readResource: async () => ONE_PIXEL_PNG_BYTES,
        resolveResourceObservationPath: async () => null,
        resolveImageArtifactPath: async () => {
          throw new Error('ENOSPC');
        },
      });

      expect(content).toEqual(expect.arrayContaining([
        { type: 'text', text: '[Image attachment: source.png; readable path unavailable]' },
        {
          type: 'image',
          data: ONE_PIXEL_PNG_BYTES.toString('base64'),
          mimeType: 'image/png',
        },
      ]));
      expect(JSON.stringify(content)).not.toContain('[Unavailable image attachment:');
      expect(warningLog).toHaveBeenCalledWith(
        '[agent][context-projection] image artifact path unavailable',
        expect.objectContaining({ artifactId: artifactRef.id, surface: 'user-attachment' }),
      );
    } finally {
      warningLog.mockRestore();
    }
  });

  test('degrades non-canonical attachment shapes without blocking provider projection', async () => {
    const missingSnapshot = await serializeUserContent([{
      type: 'attachment',
      id: 'missing-prompt-image',
      name: 'source.png',
      mimeType: 'image/png',
      sizeBytes: 4096,
      source: { kind: 'localFile', path: '/outside/source.png' },
    }], fixtureResources());
    expect(missingSnapshot).toContainEqual({
      type: 'text',
      text: '[Attachment image artifact unavailable or corrupt: source.png]',
    });

    const unexpectedSnapshot = await serializeUserContent([{
      type: 'attachment',
      id: 'unexpected-prompt-image',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      source: { kind: 'localFile', path: '/workspace/report.pdf' },
      artifactRef: imageArtifact(
        { kind: 'localFile', path: '/workspace/report.pdf' },
        {
          id: 'e'.repeat(64),
          mimeType: 'image/png',
          byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
          fileName: 'prompt.png',
        },
      ),
    }], {
      ...fixtureResources(),
      resolveImageArtifactPath: async () => '/workspace/report.pdf',
    });
    expect(unexpectedSnapshot).toContainEqual({
      type: 'text',
      text: [
        '[Attachment: report.pdf, application/pdf, 512 bytes]',
        'Readable path: /workspace/report.pdf',
        'Use file_read with this path to inspect the attachment.',
      ].join('\n'),
    });
    expect(JSON.stringify(unexpectedSnapshot)).not.toContain('prompt.png');
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
        artifactRef: imageArtifact(
          { kind: 'localFile', path: '/workspace/diagram.png' },
          {
            id: 'd'.repeat(64),
            mimeType: 'image/png',
            byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
            fileName: 'diagram.png',
          },
        ),
      },
      { type: 'nodeReference', nodeId: REFERENCE_NODE_ID },
    ], {
      readResource: async () => ONE_PIXEL_PNG_BYTES,
      resolveResourceObservationPath: async () => null,
      resolveImageArtifactPath: async (artifact) => artifact.original?.kind === 'localFile'
        ? artifact.original.path
        : null,
    });

    expect(content[0]).toEqual({
      type: 'text',
      text: 'Please review the attached files, attached images and referenced Outliner Nodes.',
    });
    expect(content.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'Please review the attached files, attached images and referenced Outliner Nodes.',
      `report.pdf: [[file:///workspace/report.pdf]]diagram.png: [[file:///workspace/diagram.png]]${REFERENCE_NODE_MARKER}`,
      '[Attachment: report.pdf, application/pdf, 10 bytes]\nReadable path: /workspace/report.pdf\nUse file_read with this path to inspect the attachment.',
      expect.stringContaining('[Attachment image: diagram.png, image/png, 8 bytes]\nArtifact: '),
    ]);
    expect(content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  test('preserves file and Node marker positions in mixed user content', async () => {
    const content = await serializeUserContent([
      { type: 'text', text: 'Compare ' },
      { type: 'nodeReference', nodeId: REFERENCE_NODE_ID, note: 'Plan' },
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
        text: `Compare Plan: ${REFERENCE_NODE_MARKER} with report.pdf: [[file:///workspace/report.pdf]] before deciding.`,
      },
      {
        type: 'text',
        text: '[Attachment: report.pdf, application/pdf, 10 bytes]\nReadable path: /workspace/report.pdf\nUse file_read with this path to inspect the attachment.',
      },
    ]);
  });

  test('projects a private structured Node reference as display text without exposing its id', async () => {
    const privateNodeId = 'date:550e8400-e29b-41d4-a716-446655440000';
    const content = await serializeUserContent([{
      type: 'nodeReference',
      nodeId: privateNodeId,
      note: '2026-08-26',
    }], fixtureResources());

    expect(content).toEqual([
      { type: 'text', text: 'Please review the referenced Outliner Nodes.' },
      { type: 'text', text: '2026-08-26' },
    ]);
    expect(JSON.stringify(content)).not.toContain(privateNodeId);
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

  test('builds capability instructions from provider-visible tools, not raw configuration', async () => {
    const fixture = createContext();
    const systemPrompts: string[] = [];
    expect(fixture.context.configuration.tools).toContain('agent');
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createTools: async () => [],
      createAgent: (options) => {
        systemPrompts.push(options.initialState?.systemPrompt ?? '');
        return {
          state: { errorMessage: undefined },
          subscribe: () => () => undefined,
          abort: () => undefined,
          steer: () => undefined,
          prompt: async () => undefined,
        };
      },
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });
    expect(systemPrompts).toHaveLength(1);
    expect(systemPrompts[0]).not.toContain('# Agents');
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

  test('keeps the provider request alive when diagnostics capture fails', async () => {
    const fixture = createContext();
    let payloadHookError: unknown = null;
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createTools: async () => [],
      createGateway: (hooks) => ({
        stream: ({ model }) => {
          const stream = createAssistantMessageEventStream();
          const message = assistantMessage([{ type: 'text', text: 'Completed without diagnostics.' }]);
          queueMicrotask(async () => {
            try {
              await hooks.onPayload?.({ model: model.id }, model);
            } catch (error) {
              payloadHookError = error;
            }
            emitAssistantMessage(stream, message);
          });
          return stream;
        },
      }),
    });

    const result = await executor.execute(fixture.context);

    expect(payloadHookError).toBeNull();
    expect(result).toMatchObject({ status: 'completed', execution: { diagnosticsRef: null } });
    expect(fixture.diagnosticsPayloads).toEqual([]);
    expect(fixture.diagnosticsErrors).toHaveLength(1);
    expect(String(fixture.diagnosticsErrors[0])).toContain('missing the provider context');
  });

  test('keeps late steering diagnostics undelivered when no provider call consumes it', async () => {
    const fixture = createContext();
    let steeringHandler: Parameters<TurnExecutionContext['onSteer']>[0] | null = null;
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
      onSteer: (handler) => {
        steeringHandler = handler;
      },
    });
    if (!steeringHandler || !result.refreshDiagnostics) {
      throw new Error('Expected steering and diagnostics finalization hooks.');
    }
    expect(fixture.diagnosticsPayloads).toHaveLength(1);
    const steeringItemId = uuidV7(1_720_000_000_150);
    await steeringHandler({
      acceptedAt: 1_720_000_000_150,
      items: [{
        type: 'userMessage',
        id: steeringItemId,
        provenance: fixture.recorder.localProvenance(steeringItemId),
        clientId: 'late-steering',
        acceptedAt: 1_720_000_000_150,
        content: [{ type: 'text', text: 'Include this in final diagnostics' }],
      }],
    });
    expect(fixture.diagnosticsPayloads).toHaveLength(1);

    await result.refreshDiagnostics();

    expect(fixture.diagnosticsPayloads).toHaveLength(2);
    expect(fixture.diagnosticsPayloads[1]?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'acceptedInput',
        source: 'steering',
        itemIds: [steeringItemId],
        consumedByCallIndex: null,
      }),
    ]));
  });

  test('marks steering diagnostics delivered when the native kernel consumes it', async () => {
    const fixture = createContext();
    const firstCallStarted = deferred<void>();
    const firstStream = createAssistantMessageEventStream();
    let providerCalls = 0;
    let steeringHandler: Parameters<TurnExecutionContext['onSteer']>[0] | null = null;
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createTools: async () => [],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, _providerContext, options = {}) => {
          providerCalls += 1;
          if (providerCalls === 1) {
            queueMicrotask(async () => {
              await options.onPayload?.({ model: model.id }, model);
              firstCallStarted.resolve();
            });
            return firstStream;
          }
          const stream = createAssistantMessageEventStream();
          const message = assistantMessage([{ type: 'text', text: 'after steering' }]);
          queueMicrotask(async () => {
            await options.onPayload?.({ model: model.id }, model);
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
          });
          return stream;
        },
      }),
    });
    const execution = executor.execute({
      ...fixture.context,
      onSteer: (handler) => { steeringHandler = handler; },
    });
    await firstCallStarted.promise;
    if (!steeringHandler) throw new Error('Expected steering handler registration.');
    const acceptedAt = 1_720_000_000_150;
    const steeringItemId = uuidV7(acceptedAt);
    const steeringItem: ThreadItem = {
      type: 'userMessage',
      id: steeringItemId,
      provenance: fixture.recorder.localProvenance(steeringItemId),
      clientId: 'in-flight-steering',
      acceptedAt,
      content: [{ type: 'text', text: 'Use this in the next call' }],
    };
    await fixture.recorder.completedImmediately(steeringItem, acceptedAt);
    await steeringHandler({ acceptedAt, items: [steeringItem] });
    const firstMessage = assistantMessage([{ type: 'text', text: 'first response' }]);
    firstStream.push({ type: 'done', reason: 'stop', message: firstMessage });
    firstStream.end(firstMessage);

    await expect(execution).resolves.toMatchObject({ status: 'completed' });

    expect(providerCalls).toBe(2);
    expect(fixture.diagnosticsPayloads[0]?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'acceptedInput',
        source: 'steering',
        itemIds: [steeringItemId],
        consumedByCallIndex: 1,
      }),
    ]));
  });

  test('includes every canonical retry input in the first provider request', async () => {
    const fixture = createContext();
    const steeringAcceptedAt = 1_720_000_000_150;
    const steeringItemId = uuidV7(steeringAcceptedAt);
    const retriedTurn = decodeTurn({
      ...fixture.context.turn,
      items: [...fixture.context.turn.items, {
        type: 'userMessage',
        id: steeringItemId,
        provenance: fixture.recorder.localProvenance(steeringItemId),
        clientId: 'retried-steering-input',
        acceptedAt: steeringAcceptedAt,
        content: [{ type: 'text', text: 'Also include costs' }],
      }],
    });
    const providerContexts: Message[][] = [];
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (_model, providerContext) => {
          providerContexts.push(structuredClone(providerContext.messages));
          const stream = createAssistantMessageEventStream();
          const message = assistantMessage([{ type: 'text', text: 'Done' }]);
          queueMicrotask(() => emitAssistantMessage(stream, message));
          return stream;
        },
      }),
    });

    await expect(executor.execute({
      ...fixture.context,
      turn: retriedTurn,
    })).resolves.toMatchObject({ status: 'completed' });

    expect(providerContexts).toHaveLength(1);
    expect(providerContexts[0]?.filter((message) => message.role === 'user').map((message) => (
      typeof message.content === 'string'
        ? message.content
        : message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
    ))).toEqual(['Test request', 'Also include costs']);
  });

  test('memoizes immutable context payload reads across provider boundaries in one Turn', async () => {
    const fixture = createContext();
    const payload = {
      schemaVersion: 1 as const,
      kind: 'skillCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: 'a'.repeat(64),
      entries: [{
        change: 'available' as const,
        name: 'cached-skill',
        displayName: 'Cached Skill',
        source: 'project' as const,
        identity: 'project:cached-skill',
        contentHash: 'b'.repeat(64),
        description: 'Read this immutable payload once.',
      }],
    };
    const serialized = JSON.stringify(payload);
    const payloadRef = {
      id: createHash('sha256').update(serialized).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-context+json' as const,
      byteLength: Buffer.byteLength(serialized),
      schemaVersion: 1 as const,
      kind: payload.kind,
    };
    const historyTurnId = uuidV7(1_719_999_999_000);
    const evidenceId = uuidV7(1_719_999_999_010);
    const historyUserId = uuidV7(1_719_999_999_020);
    const history = completedTurn(fixture.context.turn, historyTurnId, [{
      type: 'contextEvidence',
      id: evidenceId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: historyTurnId,
        originItemId: evidenceId,
      },
      kind: 'skillCatalog',
      payloadRef,
      summary: 'Available Skills (1)',
      contextRefs: [],
      resourceRefs: [],
      outputRefs: [],
    }, {
      type: 'userMessage',
      id: historyUserId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: historyTurnId,
        originItemId: historyUserId,
      },
      clientId: null,
      acceptedAt: 1_719_999_999_020,
      content: [{ type: 'text', text: 'Earlier request' }],
    }], 1_719_999_999_000);
    let payloadReads = 0;
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          await options.transformContext!([]);
          await options.transformContext!([]);
        },
      }),
    });

    await expect(executor.execute({
      ...fixture.context,
      historyBeforeTurn: [history],
      readContext: async (ref) => {
        payloadReads += 1;
        return ref.id === payloadRef.id ? payload : null;
      },
    })).resolves.toMatchObject({ status: 'completed' });

    expect(payloadReads).toBe(1);
  });

  test('evicts context reads that leave the effective context between provider boundaries', async () => {
    const fixture = createContext();
    const payloads = ['first', 'second'].map((name, index) => ({
      schemaVersion: 1 as const,
      kind: 'skillCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: String(index + 1).repeat(64),
      entries: [{
        change: 'available' as const,
        name: `${name}-skill`,
        displayName: `${name} skill`,
        source: 'project' as const,
        identity: `project:${name}-skill`,
        contentHash: String(index + 3).repeat(64),
        description: `${name} immutable payload`,
      }],
    }));
    const payloadRefs = payloads.map((payload) => {
      const serialized = JSON.stringify(payload);
      return {
        id: createHash('sha256').update(serialized).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-context+json' as const,
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1 as const,
        kind: payload.kind,
      };
    });
    const historyTurnId = uuidV7(1_719_999_998_500);
    const userId = uuidV7(1_719_999_998_510);
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: userId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: historyTurnId,
        originItemId: userId,
      },
      clientId: null,
      acceptedAt: 1_719_999_998_510,
      content: [{ type: 'text', text: 'Use the active Skill catalog.' }],
    };
    const itemSets = payloadRefs.map((payloadRef, index): readonly ThreadItem[] => {
      const evidenceId = uuidV7(1_719_999_998_520 + index);
      return [{
        type: 'contextEvidence',
        id: evidenceId,
        provenance: {
          originThreadId: fixture.context.thread.id,
          originTurnId: historyTurnId,
          originItemId: evidenceId,
        },
        kind: 'skillCatalog',
        payloadRef,
        summary: `Skill catalog ${index + 1}`,
        contextRefs: [],
        resourceRefs: [],
        outputRefs: [],
      }, userItem];
    });
    const history = completedTurn(
      fixture.context.turn,
      historyTurnId,
      itemSets[0]!,
      1_719_999_998_500,
    );
    const payloadReads = [0, 0];
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          await options.transformContext!([]);
          Object.assign(history, { items: itemSets[1]! });
          await options.transformContext!([]);
          Object.assign(history, { items: itemSets[0]! });
          await options.transformContext!([]);
        },
      }),
    });

    await expect(executor.execute({
      ...fixture.context,
      historyBeforeTurn: [history],
      readContext: async (ref) => {
        const index = payloadRefs.findIndex((candidate) => candidate.id === ref.id);
        if (index < 0) return null;
        payloadReads[index] += 1;
        return payloads[index]!;
      },
    })).resolves.toMatchObject({ status: 'completed' });

    expect(payloadReads).toEqual([2, 1]);
  });

  test('memoizes immutable output payload reads across provider boundaries in one Turn', async () => {
    const fixture = createContext();
    const output = 'Complete persisted tool output.';
    const outputRef = {
      id: createHash('sha256').update(output).digest('hex'),
      mimeType: 'text/plain' as const,
      byteLength: Buffer.byteLength(output),
      summary: 'Tool output',
    };
    const projection = {
      schemaVersion: 1 as const,
      kind: 'toolOutputProjection' as const,
      outputRef,
      projection: { type: 'full' as const },
    };
    const serializedProjection = JSON.stringify(projection);
    const projectionRef = {
      id: createHash('sha256').update(serializedProjection).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-context+json' as const,
      byteLength: Buffer.byteLength(serializedProjection),
      schemaVersion: 1 as const,
      kind: projection.kind,
    };
    const historyTurnId = uuidV7(1_719_999_998_000);
    const historyUserId = uuidV7(1_719_999_998_010);
    const toolId = uuidV7(1_719_999_998_020);
    const projectionItemId = uuidV7(1_719_999_998_030);
    const history = completedTurn(fixture.context.turn, historyTurnId, [{
      type: 'userMessage',
      id: historyUserId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: historyTurnId,
        originItemId: historyUserId,
      },
      clientId: null,
      acceptedAt: 1_719_999_998_010,
      content: [{ type: 'text', text: 'Read the persisted output.' }],
    }, {
      type: 'dynamicToolCall',
      id: toolId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: historyTurnId,
        originItemId: toolId,
      },
      status: 'completed',
      outputRef,
      namespace: null,
      tool: 'file_read',
      arguments: { file_path: '/workspace/result.txt' },
      modelCall: replayableModelCall('file_read', { file_path: '/workspace/result.txt' }),
      contentItems: [{ type: 'text', text: 'Bounded output summary.' }],
      success: true,
      durationMs: 1,
    }, {
      type: 'contextEvidence',
      id: projectionItemId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: historyTurnId,
        originItemId: projectionItemId,
      },
      kind: 'toolOutputProjection',
      payloadRef: projectionRef,
      summary: 'Full tool output projection',
      contextRefs: [],
      resourceRefs: [],
      outputRefs: [outputRef],
    }], 1_719_999_998_000);
    let outputReads = 0;
    const providerContexts: Message[][] = [];
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          providerContexts.push(await options.transformContext!([]));
          providerContexts.push(await options.transformContext!([]));
        },
      }),
    });

    const result = await executor.execute({
      ...fixture.context,
      historyBeforeTurn: [history],
      readContext: async (ref) => ref.id === projectionRef.id ? projection : null,
      readOutput: async (ref) => {
        outputReads += 1;
        return ref.id === outputRef.id ? output : null;
      },
    });

    expect(result).toMatchObject({ status: 'completed' });
    expect(outputReads).toBe(1);
    expect(providerContexts).toHaveLength(2);
    expect(JSON.stringify(providerContexts)).toContain(output);
  });

  test('retains inherited full-output reads across provider boundaries', async () => {
    const fixture = createContext();
    const output = 'Inherited complete persisted tool output.';
    const outputRef = {
      id: createHash('sha256').update(output).digest('hex'),
      mimeType: 'text/plain' as const,
      byteLength: Buffer.byteLength(output),
      summary: 'Inherited tool output',
    };
    const projection = {
      schemaVersion: 1 as const,
      kind: 'toolOutputProjection' as const,
      outputRef,
      projection: { type: 'full' as const },
    };
    const serializedProjection = JSON.stringify(projection);
    const projectionRef = {
      id: createHash('sha256').update(serializedProjection).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-context+json' as const,
      byteLength: Buffer.byteLength(serializedProjection),
      schemaVersion: 1 as const,
      kind: projection.kind,
    };
    const sourceThreadId = uuidV7(1_719_999_996_000);
    const sourceTurnId = uuidV7(1_719_999_996_010);
    const sourceUserId = uuidV7(1_719_999_996_020);
    const sourceToolId = uuidV7(1_719_999_996_030);
    const sourceProjectionId = uuidV7(1_719_999_996_040);
    const sourceTurn = completedTurn(fixture.context.turn, sourceTurnId, [{
      type: 'userMessage',
      id: sourceUserId,
      provenance: { originThreadId: sourceThreadId, originTurnId: sourceTurnId, originItemId: sourceUserId },
      clientId: null,
      acceptedAt: 1_719_999_996_020,
      content: [{ type: 'text', text: 'Read inherited output.' }],
    }, {
      type: 'dynamicToolCall',
      id: sourceToolId,
      provenance: { originThreadId: sourceThreadId, originTurnId: sourceTurnId, originItemId: sourceToolId },
      status: 'completed',
      outputRef,
      namespace: null,
      tool: 'file_read',
      arguments: { file_path: '/workspace/inherited.txt' },
      modelCall: replayableModelCall('file_read', { file_path: '/workspace/inherited.txt' }),
      contentItems: [{ type: 'text', text: 'Inherited bounded output.' }],
      success: true,
      durationMs: 1,
    }, {
      type: 'contextEvidence',
      id: sourceProjectionId,
      provenance: {
        originThreadId: sourceThreadId,
        originTurnId: sourceTurnId,
        originItemId: sourceProjectionId,
      },
      kind: 'toolOutputProjection',
      payloadRef: projectionRef,
      summary: 'Inherited full tool output projection',
      contextRefs: [],
      resourceRefs: [],
      outputRefs: [outputRef],
    }], 1_719_999_996_010);
    const inheritedPayload = {
      schemaVersion: 1 as const,
      kind: 'inheritedContext' as const,
      sourceThreadId,
      coveredThrough: { turnId: sourceTurnId, itemId: sourceProjectionId },
      requestedTurns: 'all' as const,
      turns: [sourceTurn],
    };
    const serializedInherited = JSON.stringify(inheritedPayload);
    const inheritedRef = {
      id: createHash('sha256').update(serializedInherited).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-context+json' as const,
      byteLength: Buffer.byteLength(serializedInherited),
      schemaVersion: 1 as const,
      kind: inheritedPayload.kind,
    };
    const outerTurnId = uuidV7(1_719_999_996_100);
    const inheritedItemId = uuidV7(1_719_999_996_110);
    const outerUserId = uuidV7(1_719_999_996_120);
    const history = completedTurn(fixture.context.turn, outerTurnId, [{
      type: 'contextEvidence',
      id: inheritedItemId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: outerTurnId,
        originItemId: inheritedItemId,
      },
      kind: 'inheritedContext',
      payloadRef: inheritedRef,
      summary: 'Inherited parent context',
      contextRefs: [projectionRef],
      resourceRefs: [],
      outputRefs: [outputRef],
    }, {
      type: 'userMessage',
      id: outerUserId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: outerTurnId,
        originItemId: outerUserId,
      },
      clientId: null,
      acceptedAt: 1_719_999_996_120,
      content: [{ type: 'text', text: 'Continue with inherited evidence.' }],
    }], 1_719_999_996_100);
    let outputReads = 0;
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          await options.transformContext!([]);
          await options.transformContext!([]);
        },
      }),
    });

    await expect(executor.execute({
      ...fixture.context,
      historyBeforeTurn: [history],
      readContext: async (ref) => {
        if (ref.id === inheritedRef.id) return inheritedPayload;
        if (ref.id === projectionRef.id) return projection;
        return null;
      },
      readOutput: async (ref) => {
        outputReads += 1;
        return ref.id === outputRef.id ? output : null;
      },
    })).resolves.toMatchObject({ status: 'completed' });

    expect(outputReads).toBe(1);
  });

  test('evicts output reads that leave the effective context between provider boundaries', async () => {
    const fixture = createContext();
    const outputText = ['First persisted output.', 'Second persisted output.'];
    const outputRefs = outputText.map((output, index) => ({
      id: createHash('sha256').update(output).digest('hex'),
      mimeType: 'text/plain' as const,
      byteLength: Buffer.byteLength(output),
      summary: `Tool output ${index + 1}`,
    }));
    const payloads = outputRefs.map((outputRef) => ({
      schemaVersion: 1 as const,
      kind: 'toolOutputProjection' as const,
      outputRef,
      projection: { type: 'full' as const },
    }));
    const payloadRefs = payloads.map((payload) => {
      const serialized = JSON.stringify(payload);
      return {
        id: createHash('sha256').update(serialized).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-context+json' as const,
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1 as const,
        kind: payload.kind,
      };
    });
    const historyTurnId = uuidV7(1_719_999_997_000);
    const userId = uuidV7(1_719_999_997_010);
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: userId,
      provenance: {
        originThreadId: fixture.context.thread.id,
        originTurnId: historyTurnId,
        originItemId: userId,
      },
      clientId: null,
      acceptedAt: 1_719_999_997_010,
      content: [{ type: 'text', text: 'Inspect the persisted output.' }],
    };
    const itemSets = outputRefs.map((outputRef, index): readonly ThreadItem[] => {
      const toolId = uuidV7(1_719_999_997_020 + index * 10);
      const evidenceId = uuidV7(1_719_999_997_021 + index * 10);
      return [userItem, {
        type: 'dynamicToolCall',
        id: toolId,
        provenance: {
          originThreadId: fixture.context.thread.id,
          originTurnId: historyTurnId,
          originItemId: toolId,
        },
        status: 'completed',
        outputRef,
        namespace: null,
        tool: 'file_read',
        arguments: { file_path: `/workspace/result-${index + 1}.txt` },
        modelCall: replayableModelCall('file_read', { file_path: `/workspace/result-${index + 1}.txt` }),
        contentItems: [{ type: 'text', text: `Bounded output ${index + 1}.` }],
        success: true,
        durationMs: 1,
      }, {
        type: 'contextEvidence',
        id: evidenceId,
        provenance: {
          originThreadId: fixture.context.thread.id,
          originTurnId: historyTurnId,
          originItemId: evidenceId,
        },
        kind: 'toolOutputProjection',
        payloadRef: payloadRefs[index]!,
        summary: `Full tool output projection ${index + 1}`,
        contextRefs: [],
        resourceRefs: [],
        outputRefs: [outputRef],
      }];
    });
    const history = completedTurn(
      fixture.context.turn,
      historyTurnId,
      itemSets[0]!,
      1_719_999_997_000,
    );
    const outputReads = [0, 0];
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createAgent: (options) => ({
        state: { errorMessage: undefined },
        subscribe: () => () => undefined,
        abort: () => undefined,
        steer: () => undefined,
        prompt: async () => {
          await options.transformContext!([]);
          Object.assign(history, { items: itemSets[1]! });
          await options.transformContext!([]);
          Object.assign(history, { items: itemSets[0]! });
          await options.transformContext!([]);
        },
      }),
    });

    await expect(executor.execute({
      ...fixture.context,
      historyBeforeTurn: [history],
      readContext: async (ref) => {
        const index = payloadRefs.findIndex((candidate) => candidate.id === ref.id);
        return index < 0 ? null : payloads[index]!;
      },
      readOutput: async (ref) => {
        const index = outputRefs.findIndex((candidate) => candidate.id === ref.id);
        if (index < 0) return null;
        outputReads[index] += 1;
        return outputText[index]!;
      },
    })).resolves.toMatchObject({ status: 'completed' });

    expect(outputReads).toEqual([2, 1]);
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
    let transformContext: KernelAgentOptions['transformContext'];
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
      refreshDiagnostics: expect.any(Function),
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
      createTools: async () => [historyTestTool('bash')],
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
            modelCall: replayableModelCall('bash', { command: 'pwd' }),
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
      degradations: [],
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
          degradations: [],
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
    const smallModel = { ...testModel, contextWindow: 2_120, maxTokens: 200 };
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
    const imageBytes = ONE_PIXEL_PNG_BYTES;
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
    const persistOutputImage = async (bytes: Uint8Array) => {
      persistedImage = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        observation: imageRef,
        observationBytes: persistedImage,
        sourceDimensions: { width: 1, height: 1 },
        observationDimensions: { width: 1, height: 1 },
      };
    };
    const context: TurnExecutionContext = {
      ...fixture.context,
      persistOutputImage,
      readResource: async (ref) => ref.id === imageRef.id ? persistedImage : null,
    };
    const executor = new PiTurnExecutor({
      resolveRuntimeSettings: async () => runtimeSettings(),
      resolveRuntime: async () => runtimeSelection(),
      createTools: async () => [historyTestTool('file_read')],
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
          await listener!(toolAdmissionEvent(
            'call-image',
            'file_read',
            { file_path: '/workspace/diagram.png' },
          ));
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
        artifactRef: expect.objectContaining({
          retention: 'external',
          original: { kind: 'localFile', path: '/workspace/diagram.png' },
          observation: imageRef,
        }),
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

  test('records generated artifacts matched by explicit preview index', async () => {
    const fixture = createContext();
    const imageBase64 = ONE_PIXEL_PNG_BYTES.toString('base64');
    const missingPreviewPath = '/scratch/generated-images/turn/image-0.png';
    const previewedPath = '/scratch/generated-images/turn/image-1.png';
    const observation = {
      id: createHash('sha256').update(ONE_PIXEL_PNG_BYTES).digest('hex'),
      mimeType: 'image/png',
      byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
      fileName: 'tool-output.png',
    };
    const generatedArtifact = createImageArtifactReference({
      createdAt: 1,
      retention: 'tiered',
      original: {
        kind: 'threadPayload',
        ref: {
          id: 'f'.repeat(64),
          mimeType: 'image/png',
          byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
          fileName: 'original.png',
        },
      },
      observation,
      sourceDimensions: { width: 1, height: 1 },
      observationDimensions: { width: 1, height: 1 },
    });
    const images = [{
      providerIndex: 1,
      path: missingPreviewPath,
      mimeType: 'image/png',
      byteLength: 12_000_000,
    }, {
      providerIndex: 2,
      path: previewedPath,
      mimeType: 'image/png',
      byteLength: 13_000_000,
      previewIndex: 0,
      artifactRef: generatedArtifact,
    }];
    const normalizer = new PiEventNormalizer({
      ...fixture.context,
      readResource: async (ref) => ref.id === observation.id ? ONE_PIXEL_PNG_BYTES : null,
    });
    normalizer.handle(toolAdmissionEvent(
      'call-generate-image',
      'generate_image',
      { prompt: 'A red square' },
    ));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-generate-image',
      toolName: 'generate_image',
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            data: { images },
          }),
        }, {
          type: 'image',
          data: imageBase64,
          mimeType: 'image/png',
        }],
        details: {
          ok: true,
          tool: 'generate_image',
          version: 1,
          status: 'success',
          data: {
            providerId: 'openai',
            modelId: 'gpt-image-2',
            modelName: 'GPT Image 2',
            images,
          },
        },
      },
      isError: false,
    });
    await normalizer.flush();

    const item = fixture.recorder.orderedItems()[0];
    const persistedItem = JSON.stringify(item);
    expect(persistedItem).not.toContain(missingPreviewPath);
    expect(persistedItem).not.toContain(previewedPath);
    expect(item).toMatchObject({
      type: 'dynamicToolCall',
      tool: 'generate_image',
      contentItems: expect.arrayContaining([{
        type: 'image',
        artifactRef: generatedArtifact,
      }]),
    });
    if (item?.type !== 'dynamicToolCall' || !item.outputRef) {
      throw new Error('Expected generated image output reference');
    }
    const persistedOutput = await fixture.context.readOutput(item.outputRef);
    expect(persistedOutput).not.toContain(missingPreviewPath);
    expect(persistedOutput).not.toContain(previewedPath);
    expect(persistedOutput).toContain('Use the adjacent readable path');
  });

  test('preserves namespaced generate_image text at both persistence boundaries', async () => {
    const fixture = createContext();
    const pluginPreview = ONE_PIXEL_PNG_BYTES.toString('base64');
    const pluginText = JSON.stringify({
      ok: true,
      data: {
        images: [{
          path: 'https://plugin.example/image-1',
          id: 'plugin-image-1',
          caption: 'Plugin-owned caption',
        }],
      },
      instructions: 'Keep plugin fields.',
    });
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent(
      'call-plugin-image',
      'myplugin__generate_image',
      { prompt: 'A plugin image' },
    ));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-plugin-image',
      toolName: 'myplugin__generate_image',
      result: {
        content: [
          { type: 'text', text: pluginText },
          { type: 'image', data: pluginPreview, mimeType: 'image/png' },
        ],
        details: {
          ok: true,
          tool: 'generate_image',
          data: {
            images: [{
              id: 'plugin-image-1',
              path: '/plugin-owned/path.png',
              previewIndex: 0,
            }],
          },
        },
      },
      isError: false,
    });
    await normalizer.flush();

    const item = fixture.recorder.orderedItems()[0];
    expect(JSON.stringify(item)).not.toContain('/plugin-owned/path.png');
    expect(item).toMatchObject({
      type: 'dynamicToolCall',
      namespace: 'myplugin',
      tool: 'generate_image',
      contentItems: [
        { type: 'text', text: pluginText },
        {
          type: 'image',
          artifactRef: expect.objectContaining({
            retention: 'observationOnly',
            original: null,
          }),
        },
      ],
    });
    if (item?.type !== 'dynamicToolCall' || !item.outputRef) {
      throw new Error('Expected namespaced image output reference');
    }
    expect(await fixture.context.readOutput(item.outputRef)).toContain(pluginText);
  });

  test('persists tool artifact identity without retaining the producing Turn path', async () => {
    const fixture = createContext();
    const resourceRef: ThreadResourceReference = {
      id: 'e'.repeat(64),
      mimeType: 'application/pdf',
      byteLength: 456,
      fileName: 'report.pdf',
    };
    const producingPath = '/tmp/turn-observation/report.pdf';
    const resultText = JSON.stringify({
      ok: true,
      data: {
        binaryFile: {
          filePath: producingPath,
          resourceRef,
          mimeType: resourceRef.mimeType,
          byteLength: resourceRef.byteLength,
          sha256: resourceRef.id,
        },
      },
    });
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent('call-web-artifact', 'web_fetch', {
      url: 'https://example.com/report.pdf',
    }));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-web-artifact',
      toolName: 'web_fetch',
      result: {
        content: [{ type: 'text', text: resultText }],
        details: { ok: true },
        resourceRefs: [resourceRef],
      },
      isError: false,
    });
    await normalizer.flush();

    const item = fixture.recorder.orderedItems()[0];
    expect(item).toMatchObject({ resourceRefs: [resourceRef] });
    expect(JSON.stringify(item)).not.toContain(producingPath);
    if (item?.type !== 'dynamicToolCall' || !item.outputRef) {
      throw new Error('Expected web_fetch output reference');
    }
    const persistedOutput = await fixture.context.readOutput(item.outputRef);
    expect(persistedOutput).not.toContain(producingPath);
    expect(persistedOutput).toContain(resourceRef.id);
  });

  test('keeps bash artifact handles and repeated instruction paths out of the canonical command Item', async () => {
    const fixture = createContext();
    const resourceRef: ThreadResourceReference = {
      id: 'f'.repeat(64),
      mimeType: 'text/plain',
      byteLength: 32,
      fileName: 'command.log',
    };
    const producingPath = '/tmp/turn-observation/command.log';
    const temporaryOutputPath = '/tmp/turn-observation/running.log';
    const managedOutputRoot = '/tmp/turn-observation/browser-pilot';
    const resultText = JSON.stringify({
      ok: true,
      data: {
        stdout: `saved ${managedOutputRoot}/capture.png`,
        stderr: '',
        persistedOutput: { filePath: producingPath, resourceRef, byteLength: resourceRef.byteLength },
        temporaryOutputPath,
      },
      instructions: `The temporary output path is ${temporaryOutputPath}.`,
    });
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent('call-bash-artifact', 'bash', { command: 'produce-report' }));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-artifact',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: resultText }],
        details: { data: { exitCode: 0 } },
        resourceRefs: [resourceRef],
        persistedTextReplacements: [{
          value: managedOutputRoot,
          replacement: '[managed-output:browser-pilot-output]',
        }],
      },
      isError: false,
    });
    await normalizer.flush();

    const item = fixture.recorder.orderedItems()[0];
    expect(item).toMatchObject({ type: 'commandExecution', resourceRefs: [resourceRef] });
    expect(JSON.stringify(item)).not.toContain(producingPath);
    expect(JSON.stringify(item)).not.toContain(temporaryOutputPath);
    expect(JSON.stringify(item)).not.toContain(managedOutputRoot);
    expect(JSON.stringify(item)).toContain('[temporary-shell-output]');
    expect(JSON.stringify(item)).toContain('[managed-output:browser-pilot-output]/capture.png');
    if (item?.type !== 'commandExecution' || !item.outputRef) {
      throw new Error('Expected bash output reference');
    }
    const persistedOutput = await fixture.context.readOutput(item.outputRef);
    expect(persistedOutput).not.toContain(producingPath);
    expect(persistedOutput).not.toContain(temporaryOutputPath);
    expect(persistedOutput).not.toContain(managedOutputRoot);
    expect(persistedOutput).toContain('[temporary-shell-output]');
    expect(persistedOutput).toContain('[managed-output:browser-pilot-output]/capture.png');
    expect(persistedOutput).toContain(resourceRef.id);
  });

  test('stabilizes task_stop managed-root scan warnings in outputRef', async () => {
    const fixture = createContext();
    const managedOutputRoot = '/tmp/turn-observation/browser-pilot/call-task-stop';
    const warning = `Browser Pilot output could not be scanned: ENOENT: lstat '${managedOutputRoot}'`;
    const resultText = JSON.stringify({
      ok: true,
      tool: 'task_stop',
      data: { artifactWarnings: [warning] },
      warnings: [warning],
    });
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent('call-task-stop-stable', 'task_stop', { task_id: 'task-1' }));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-task-stop-stable',
      toolName: 'task_stop',
      result: {
        content: [{ type: 'text', text: resultText }],
        details: { ok: true },
        persistedTextReplacements: [{
          value: managedOutputRoot,
          replacement: '[managed-output:browser-pilot-output]',
        }],
      },
      isError: false,
    });
    await normalizer.flush();

    const item = fixture.recorder.orderedItems()[0];
    expect(item?.type).toBe('collabAgentToolCall');
    if (item?.type !== 'collabAgentToolCall' || !item.outputRef) {
      throw new Error('Expected task_stop output reference');
    }
    const persistedOutput = await fixture.context.readOutput(item.outputRef);
    expect(persistedOutput).not.toContain(managedOutputRoot);
    expect(persistedOutput).toContain('[managed-output:browser-pilot-output]');
  });

  test('applies host path replacements to dynamic outputRef and canonical content', async () => {
    const fixture = createContext();
    const executionPath = '/tmp/turn-observation/managed-skill/call-dynamic';
    const resultText = JSON.stringify({ warning: `Could not inspect ${executionPath}` });
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle(toolAdmissionEvent('call-dynamic-stable', 'inspect_output', {}));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-dynamic-stable',
      toolName: 'inspect_output',
      result: {
        content: [{ type: 'text', text: resultText }],
        details: { ok: true },
        persistedTextReplacements: [{
          value: executionPath,
          replacement: '[managed-output:managed-skill-output]',
        }],
      },
      isError: false,
    });
    await normalizer.flush();

    const item = fixture.recorder.orderedItems()[0];
    expect(item?.type).toBe('dynamicToolCall');
    expect(JSON.stringify(item)).not.toContain(executionPath);
    expect(JSON.stringify(item)).toContain('[managed-output:managed-skill-output]');
    if (item?.type !== 'dynamicToolCall' || !item.outputRef) {
      throw new Error('Expected dynamic tool output reference');
    }
    const persistedOutput = await fixture.context.readOutput(item.outputRef);
    expect(persistedOutput).not.toContain(executionPath);
    expect(persistedOutput).toContain('[managed-output:managed-skill-output]');
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
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, providerContext, options = {}) => {
          const stream = createAssistantMessageEventStream();
          const response = assistantMessage([]);
          queueMicrotask(async () => {
            await options.onPayload?.({
              model: 'test-model',
              input: providerContext.messages,
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
      }),
      createAgent: (options) => {
        expect(options.transformContext).toBeUndefined();
        expect(options.recoverContextOverflow).toBeUndefined();
        initialState = options.initialState;
        const runtime = new NativeAgentRuntime(options);
        return {
          state: runtime.state,
          subscribe: (listener) => runtime.subscribe(listener),
          abort: () => runtime.abort(),
          steer: (message) => runtime.steer(message),
          prompt: async (message) => {
            receivedPrompt = message as UserMessage;
            await runtime.prompt(message);
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

  test('reconstructs canonical tool calls and results while omitting unsigned reasoning for later Turns', async () => {
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
            modelCall: replayableModelCall('bash', { command: 'pwd' }),
            commandActions: [],
            aggregatedOutput: '/workspace',
            exitCode: 0,
            durationMs: 5,
          },
          { type: 'agentMessage', id: 'agent-2', provenance: provenance('agent-2'), text: 'Continuing.', phase: 'commentary', memoryCitation: null },
          { type: 'reasoning', id: 'reason-2', provenance: provenance('reason-2'), summary: ['Need documentation'], content: ['Search the docs'] },
          {
            type: 'mcpToolCall',
            id: 'call-2',
            provenance: provenance('call-2'),
            server: 'docs',
            tool: 'search',
            status: 'completed',
            outputRef: null,
            modelCall: replayableModelCall('docs__search', { query: 'Thread' }),
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
    expect(messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'toolResult', 'assistant', 'toolResult',
    ]);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
      ],
    });
    expect(messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', content: [{ text: '/workspace' }] });
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Continuing.' },
        { type: 'toolCall', id: 'call-2', name: 'docs__search', arguments: { query: 'Thread' } },
      ],
    });
    expect(messages[4]).toMatchObject({ role: 'toolResult', toolCallId: 'call-2', content: [{ text: '{"matches":2}' }] });
    expect(JSON.stringify(messages)).not.toContain('[Reasoning]');
    expect(JSON.stringify(messages)).not.toContain('Need evidence');
    expect(JSON.stringify(messages)).not.toContain('Need documentation');
  });

  test('bounds persisted tool projections and stores image artifacts instead of base64', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS * 3);
    const fileImageBase64 = ONE_PIXEL_PNG_BYTES.toString('base64');
    const largeArguments = { file_path: '/workspace/large.png', echoed: oversized };
    normalizer.handle({
      type: 'tool_call_admission',
      toolCallId: 'call-file-1',
      providerToolCallId: 'call-file-1',
      toolName: 'file_read',
      decision: await persistToolCallAdmission({
        toolCallId: 'call-file-1',
        providerName: 'file_read',
        outcome: {
          type: 'admitted',
          identity: { namespace: null, name: 'file_read' },
          arguments: largeArguments,
          redactedArguments: largeArguments,
          redactedPaths: [],
          displayArguments: largeArguments,
          schemaDigest: TEST_TOOL_SCHEMA_DIGEST,
          redactedArgumentsReplayable: true,
        },
      }, fixture.context.persistToolCallArguments),
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
    normalizer.handle(toolAdmissionEvent('call-bash-2', 'bash', { command: 'produce output' }));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-2',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: oversized }], details: { data: { exitCode: 0 } } },
      isError: false,
    });
    normalizer.handle(toolAdmissionEvent('call-images-3', 'inspect_images', {}));
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-images-3',
      toolName: 'inspect_images',
      result: {
        content: Array.from({ length: MAX_PERSISTED_TOOL_OUTPUT_IMAGES + 5 }, (_, index) => ({
          type: 'image' as const,
          data: pngFixture(index + 1, 1).toString('base64'),
          mimeType: 'image/png',
        })),
      },
      isError: false,
    });
    const nearLimitImage = pngFixture(1, 1, MAX_TOOL_PAYLOAD_IMAGE_BYTES - 1).toString('base64');
    normalizer.handle(toolAdmissionEvent('call-image-budget-4', 'inspect_large_images', {}));
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
        { type: 'image' },
      ],
    });
    if (fileRead?.type !== 'dynamicToolCall' || fileRead.contentItems?.[1]?.type !== 'image') {
      throw new Error('Expected persisted file_read image artifact.');
    }
    expect(fileRead.contentItems[1].artifactRef).toMatchObject({
      original: { kind: 'localFile', path: '/workspace/large.png' },
      observation: { id: expect.any(String) },
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
    expect(persistedImages.every((content) => (
      content.artifactRef.retention === 'observationOnly' && content.artifactRef.original === null
    ))).toBe(true);
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

  test('keeps file identity fields when canonical arguments are payload-backed', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const argumentsValue = {
      file_path: '/workspace/report.md',
      content: 'x'.repeat(MAX_PERSISTED_TOOL_ARGUMENT_CHARS * 2),
    };
    const decision = await persistToolCallAdmission({
      toolCallId: 'large-file-write',
      providerName: 'file_write',
      outcome: {
        type: 'admitted',
        identity: { namespace: null, name: 'file_write' },
        arguments: argumentsValue,
        redactedArguments: argumentsValue,
        redactedPaths: [],
        displayArguments: argumentsValue,
        schemaDigest: TEST_TOOL_SCHEMA_DIGEST,
        redactedArgumentsReplayable: true,
      },
    }, fixture.context.persistToolCallArguments);
    normalizer.handle({
      type: 'tool_call_admission',
      toolCallId: 'large-file-write',
      providerToolCallId: 'large-file-write',
      toolName: 'file_write',
      decision,
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'large-file-write',
      toolName: 'file_write',
      result: { content: [{ type: 'text', text: 'written' }], details: {} },
      isError: false,
    });
    await normalizer.flush();

    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'fileChange',
      changes: [{ path: '/workspace/report.md', kind: 'add' }],
      modelCall: {
        disposition: 'replayable',
        arguments: { storage: 'payload' },
      },
    });
  });

  test('never persists inline image bytes as text and reports snapshot quota omission', async () => {
    const fixture = createContext();
    const imageBase64 = ONE_PIXEL_PNG_BYTES.toString('base64');
    let completeOutput = '';
    const persistOutputImage = async () => {
      throw new ThreadResourceQuotaError();
    };
    const context: TurnExecutionContext = {
      ...fixture.context,
      persistOutputImage,
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
    normalizer.handle(toolAdmissionEvent('call-quota-image', 'inspect_image', {}));
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

  test('restores the canonical Agent schemas after the real Anthropic tool conversion', async () => {
    const models = ['claude-sonnet-test', 'claude-opus-test'];
    const tools: AgentTool[] = [
      parityTool('agent', AGENT_TOOL_DESCRIPTION, agentInputSchema(models)),
      parityTool('agent_message', AGENT_MESSAGE_TOOL_DESCRIPTION, AGENT_MESSAGE_INPUT_SCHEMA),
      parityTool('task_stop', TASK_STOP_TOOL_DESCRIPTION, TASK_STOP_INPUT_SCHEMA),
    ];
    const rawPayloads: unknown[] = [];
    const restoredPayloads: unknown[] = [];
    const client = {
      messages: {
        create: (payload: unknown) => ({
          asResponse: async () => {
            restoredPayloads.push(payload);
            return anthropicTextResponse('done');
          },
        }),
      },
    };

    const result = await streamAnthropicMessages(anthropicToolParityModel, {
      systemPrompt: 'Test system prompt',
      messages: [{ role: 'user', content: 'Test request', timestamp: 1 }],
      tools,
    }, {
      client: client as never,
      onPayload: (payload, model) => {
        rawPayloads.push(structuredClone(payload));
        return agentProviderPayload(payload, model, null, tools);
      },
    }).result();

    expect(result.stopReason).toBe('stop');
    const rawTools = providerPayloadTools(rawPayloads[0]);
    expect(rawTools.map((tool) => Object.keys(tool.input_schema as object))).toEqual([
      ['type', 'properties', 'required'],
      ['type', 'properties', 'required'],
      ['type', 'properties', 'required'],
    ]);
    expect(rawTools[2]?.input_schema).toMatchObject({ required: [] });

    const restoredTools = providerPayloadTools(restoredPayloads[0]);
    expect(restoredTools.map((tool) => Object.keys(tool))).toEqual([
      ['name', 'description', 'input_schema', 'eager_input_streaming'],
      ['name', 'description', 'input_schema', 'eager_input_streaming'],
      ['name', 'description', 'input_schema', 'eager_input_streaming', 'cache_control'],
    ]);
    expect(restoredTools.map((tool) => tool.input_schema)).toEqual([
      agentInputSchema(models),
      AGENT_MESSAGE_INPUT_SCHEMA,
      TASK_STOP_INPUT_SCHEMA,
    ]);
    expect(Object.keys(restoredTools[0]!.input_schema as object)).toEqual([
      '$schema', 'type', 'properties', 'required', 'additionalProperties',
    ]);
    expect(Object.keys((restoredTools[0]!.input_schema as Record<string, any>).properties)).toEqual([
      'description', 'prompt', 'subagent_type', 'model', 'run_in_background', 'execution', 'isolation',
    ]);
    expect(Object.keys(restoredTools[2]!.input_schema as object)).toEqual([
      '$schema', 'type', 'properties', 'additionalProperties',
    ]);
  });

  test('reattaches signed same-Turn thinking without authoring reasoning markers across three provider calls', async () => {
    const fixture = createContext();
    const providerContexts: Message[][] = [];
    const outgoingPayloads: Array<{ readonly model: string; readonly input: unknown[] }> = [];
    const signatures = [
      openAIReasoningSignature('rs_first'),
      openAIReasoningSignature('rs_second'),
      openAIReasoningSignature('rs_final'),
    ];
    const reasoningTokens = [5, 6, 7];
    let providerCalls = 0;
    let toolExecutions = 0;
    const recoveringTool: AgentTool = {
      ...testTool('replay_tool', 'Reasoning replay test tool'),
      execute: async () => {
        toolExecutions += 1;
        if (toolExecutions === 1) throw new Error('Recoverable tool failure');
        return { content: [{ type: 'text', text: 'recovered' }], details: {} };
      },
    };
    const responses = [
      reasoningAssistantMessage(
        'First native thought',
        signatures[0]!,
        reasoningTokens[0]!,
        [{ type: 'toolCall', id: 'replay-call-1', name: 'replay_tool', arguments: {} }],
      ),
      reasoningAssistantMessage(
        'Second native thought',
        signatures[1]!,
        reasoningTokens[1]!,
        [{ type: 'toolCall', id: 'replay-call-2', name: 'replay_tool', arguments: {} }],
      ),
      reasoningAssistantMessage(
        'Final native thought',
        signatures[2]!,
        reasoningTokens[2]!,
        [{ type: 'text', text: 'Completed after recovery' }],
        'stop',
      ),
    ];
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [recoveringTool],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, providerContext, options = {}) => {
          const message = responses[providerCalls];
          if (!message) throw new Error(`Unexpected provider call ${providerCalls + 1}`);
          providerCalls += 1;
          providerContexts.push(structuredClone(providerContext.messages));
          const payload = {
            model: model.id,
            input: convertResponsesMessages(
              model,
              providerContext,
              new Set([model.provider]),
              { includeSystemPrompt: false },
            ) as unknown[],
          };
          outgoingPayloads.push(payload);
          const stream = createAssistantMessageEventStream();
          queueMicrotask(async () => {
            await options.onPayload?.(payload, model);
            emitAssistantMessage(stream, message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });

    expect(providerCalls).toBe(3);
    expect(toolExecutions).toBe(2);
    for (const payload of outgoingPayloads) {
      expect(JSON.stringify(payload).match(/\[Reasoning\]/g) ?? []).toHaveLength(0);
    }
    expect(outboundThinkingSignatures(providerContexts[0] ?? [])).toEqual([]);
    expect(outboundThinkingSignatures(providerContexts[1] ?? [])).toEqual([signatures[0]]);
    expect(outboundThinkingSignatures(providerContexts[2] ?? [])).toEqual(signatures.slice(0, 2));
    expect(outboundReasoningItemIds(outgoingPayloads[0]!.input)).toEqual([]);
    expect(outboundReasoningItemIds(outgoingPayloads[1]!.input)).toEqual(['rs_first']);
    expect(outboundReasoningItemIds(outgoingPayloads[2]!.input)).toEqual(['rs_first', 'rs_second']);
    expect(fixture.recorder.orderedItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dynamicToolCall', id: 'replay-call-1', status: 'failed' }),
      expect.objectContaining({ type: 'dynamicToolCall', id: 'replay-call-2', status: 'completed' }),
    ]));
    expect(fixture.diagnosticsPayloads[0]?.providerCalls.map((call) => call.response?.usage.reasoning))
      .toEqual(reasoningTokens);
  });

  test('drops signed thinking on provider identity mismatch without failing the Turn', async () => {
    const fixture = createContext();
    const providerContexts: Message[][] = [];
    let providerCalls = 0;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [testTool('mismatch_tool', 'Identity mismatch test tool')],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, providerContext, options = {}) => {
          providerContexts.push(structuredClone(providerContext.messages));
          providerCalls += 1;
          const message = providerCalls === 1
            ? {
                ...reasoningAssistantMessage(
                  'Foreign native thought',
                  'not-a-valid-openai-reasoning-item',
                  4,
                  [
                    { type: 'text', text: 'Foreign commentary' },
                    { type: 'toolCall', id: 'mismatch-call', name: 'mismatch_tool', arguments: {} },
                  ],
                ),
                model: 'foreign-model',
              }
            : assistantMessage([{ type: 'text', text: 'Continued without foreign reasoning' }]);
          const stream = createAssistantMessageEventStream();
          queueMicrotask(async () => {
            await options.onPayload?.({
              model: model.id,
              input: convertResponsesMessages(
                model,
                providerContext,
                new Set([model.provider]),
                { includeSystemPrompt: false },
              ),
            }, model);
            emitAssistantMessage(stream, message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });

    expect(providerCalls).toBe(2);
    expect(outboundThinkingSignatures(providerContexts[1] ?? [])).toEqual([]);
    expect(JSON.stringify(providerContexts[1])).toContain('Foreign commentary');
    expect(JSON.stringify(providerContexts[1])).toContain('mismatch-call');
    expect(JSON.stringify(providerContexts[1])).not.toContain('[Reasoning]');
  });

  test('keeps one signed assistant batch and emits rejected-call evidence after its results', async () => {
    const fixture = createContext();
    const providerContexts: Message[][] = [];
    const signature = openAIReasoningSignature('rs_mixed_evidence');
    let providerCalls = 0;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [historyTestTool('first_tool'), historyTestTool('third_tool')],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (_model, providerContext) => {
          providerContexts.push(structuredClone(providerContext.messages));
          providerCalls += 1;
          const message = providerCalls === 1
            ? reasoningAssistantMessage(
                'One signed thought owns the complete mixed batch.',
                signature,
                5,
                [
                  { type: 'toolCall', id: 'mixed-first', name: 'first_tool', arguments: {} },
                  { type: 'toolCall', id: 'mixed-rejected', name: 'missing_tool', arguments: {} },
                  { type: 'toolCall', id: 'mixed-third', name: 'third_tool', arguments: {} },
                ],
              )
            : assistantMessage([{ type: 'text', text: 'Continued after the mixed batch.' }]);
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => emitAssistantMessage(stream, message));
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });

    const replay = providerContexts[1] ?? [];
    const assistantSegments = replay.filter((message): message is AssistantMessage => (
      message.role === 'assistant' && message.content.some((part) => part.type === 'toolCall')
    ));
    expect(assistantSegments).toHaveLength(1);
    expect(assistantSegments.map((message) => outboundThinkingSignatures([message]))).toEqual([
      [signature],
    ]);
    expect(assistantSegments.map((message) => message.content.flatMap((part) => (
      part.type === 'toolCall' ? [part.name] : []
    )))).toEqual([['first_tool', 'third_tool']]);
    const evidenceIndex = replay.findIndex((message) => JSON.stringify(message).includes('unresolvedTool'));
    const lastToolResultIndex = replay.reduce((last, message, index) => (
      message.role === 'toolResult' ? index : last
    ), -1);
    expect(evidenceIndex).toBeGreaterThan(lastToolResultIndex);
    expect(JSON.stringify(replay)).toContain('unresolvedTool');
  });

  test('retries payload preparation without same-identity thinking when its signature is unrecognised', async () => {
    const fixture = createContext();
    const providerContexts: Message[][] = [];
    const outgoingPayloads: unknown[] = [];
    let providerAttempts = 0;
    let preparedCalls = 0;
    const invalidSignature = 'not-a-valid-openai-reasoning-item';
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [testTool('signature_tool', 'Signature fallback test tool')],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, providerContext, options = {}) => {
          providerAttempts += 1;
          providerContexts.push(structuredClone(providerContext.messages));
          const stream = createAssistantMessageEventStream();
          queueMicrotask(async () => {
            try {
              const payload = {
                model: model.id,
                input: convertResponsesMessages(
                  model,
                  providerContext,
                  new Set([model.provider]),
                  { includeSystemPrompt: false },
                ),
              };
              await options.onPayload?.(payload, model);
              outgoingPayloads.push(payload);
              preparedCalls += 1;
              const message = preparedCalls === 1
                ? reasoningAssistantMessage(
                    'Native thought with an unrecognised signature',
                    invalidSignature,
                    4,
                    [{ type: 'toolCall', id: 'signature-call', name: 'signature_tool', arguments: {} }],
                  )
                : assistantMessage([{ type: 'text', text: 'Continued without invalid thinking' }]);
              emitAssistantMessage(stream, message);
            } catch (error) {
              const message = {
                ...assistantMessage([]),
                stopReason: 'error' as const,
                errorMessage: error instanceof Error ? error.message : String(error),
              };
              stream.push({ type: 'error', reason: 'error', error: message });
              stream.end(message);
            }
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });

    expect(providerAttempts).toBe(3);
    expect(preparedCalls).toBe(2);
    expect(outboundThinkingSignatures(providerContexts[0] ?? [])).toEqual([]);
    expect(outboundThinkingSignatures(providerContexts[1] ?? [])).toEqual([invalidSignature]);
    expect(outboundThinkingSignatures(providerContexts[2] ?? [])).toEqual([]);
    expect(JSON.stringify(outgoingPayloads)).not.toContain(invalidSignature);
    expect(JSON.stringify(outgoingPayloads)).not.toContain('[Reasoning]');
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
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => ({
        ...runtimeSettings(),
        providerTimeoutMs: 4_321,
        providerMaxRetries: 2,
        providerMaxRetryDelayMs: 75,
        providerCacheRetention: 'short',
      }),
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
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
      { timeoutMs: 4_321, maxRetries: 0, maxRetryDelayMs: 75, cacheRetention: 'short' },
      { timeoutMs: 4_321, maxRetries: 0, maxRetryDelayMs: 75, cacheRetention: 'short' },
    ]);
  });

  test('maps kernel budget exhaustion to an interrupted Turn with recorded usage', async () => {
    const fixture = createContext();
    let observedTokens = 0;
    const context: TurnExecutionContext = {
      ...fixture.context,
      remainingTokenBudget: () => ({
        remaining: 4 - observedTokens,
        total: 10,
        used: 6 + observedTokens,
      }),
      onModelCallUsage: (tokens) => { observedTokens += tokens; },
    };
    let providerCalls = 0;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [testTool('budget_tool', 'Budget boundary tool')],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: () => {
          providerCalls += 1;
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = providerCalls === 1
            ? {
                ...assistantMessage([{
                  type: 'toolCall',
                  id: 'budget-call',
                  name: 'budget_tool',
                  arguments: {},
                }]),
                stopReason: 'toolUse',
              }
            : assistantMessage([{ type: 'text', text: 'must not run' }]);
          queueMicrotask(() => {
            stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
            stream.end(message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(context)).resolves.toMatchObject({
      status: 'interrupted',
      error: {
        code: 'subagent_budget_exhausted',
        message: 'Token budget exhausted mid-Turn (13 of 10 tokens)',
      },
      execution: { usage: { totalTokens: 7 } },
    });
    expect(providerCalls).toBe(1);
  });

  test('keeps runtime usage tally when diagnostics cannot match a provider response', async () => {
    const fixture = createContext();
    const observedTokens: number[] = [];
    const context: TurnExecutionContext = {
      ...fixture.context,
      onModelCallUsage: (tokens) => observedTokens.push(tokens),
    };
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: () => {
          const stream = createAssistantMessageEventStream();
          const message = assistantMessage([{ type: 'text', text: 'No captured request payload' }]);
          queueMicrotask(() => {
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(context)).resolves.toMatchObject({
      status: 'completed',
      execution: { usage: { totalTokens: 7 } },
    });
    expect(observedTokens).toEqual([7]);
    expect(fixture.diagnosticsPayloads[0]?.providerCalls).toEqual([]);
  });

  test('keeps an exhausted child user Turn unlimited across provider calls', async () => {
    const fixture = createContext();
    const context: TurnExecutionContext = {
      ...fixture.context,
      thread: {
        ...fixture.context.thread,
        parentThreadId: uuidV7(1_720_000_000_010),
      },
      remainingTokenBudget: () => null,
    };
    let providerCalls = 0;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [testTool('user_budget_tool', 'User budget override tool')],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: () => {
          providerCalls += 1;
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = providerCalls === 1
            ? {
                ...assistantMessage([{
                  type: 'toolCall',
                  id: 'user-budget-call',
                  name: 'user_budget_tool',
                  arguments: {},
                }]),
                stopReason: 'toolUse',
              }
            : assistantMessage([{ type: 'text', text: 'user Turn complete' }]);
          queueMicrotask(() => {
            stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
            stream.end(message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(context)).resolves.toMatchObject({
      status: 'completed',
      execution: { usage: { totalTokens: 14 } },
    });
    expect(providerCalls).toBe(2);
  });

  test('uses raw environment credentials only for the live Turn and redacted history afterward', async () => {
    const fixture = createContext();
    const secret = `sk-proj-${'A'.repeat(74)}T3BlbkFJ${'B'.repeat(74)}`;
    const environmentSecret = 'hunter2hunter2hunter2';
    const command = `OPENAI_API_KEY=${secret} PGPASSWORD=${environmentSecret} curl https://api.openai.com/v1/models`;
    const executions: unknown[] = [];
    const bash = {
      name: 'bash',
      label: 'Run command',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      execute: async (_callId: string, args: unknown) => {
        executions.push(args);
        return { content: [{ type: 'text' as const, text: 'request completed' }], details: {} };
      },
    } as AgentTool;
    const providerContexts: Message[][] = [];
    let providerCalls = 0;
    const runtime = runtimeSelection();
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtime,
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [bash],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (_model, providerContext) => {
          providerCalls += 1;
          providerContexts.push([...providerContext.messages]);
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = providerCalls === 1
            ? {
                ...assistantMessage([{
                  type: 'toolCall',
                  id: 'secret-call',
                  name: 'bash',
                  arguments: { command },
                }]),
                stopReason: 'toolUse',
              }
            : assistantMessage([{ type: 'text', text: 'Done' }]);
          queueMicrotask(() => {
            stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
            stream.end(message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });

    expect(executions).toEqual([{ command }]);
    expect(JSON.stringify(providerContexts[1])).toContain(secret);
    expect(JSON.stringify(providerContexts[1])).toContain(environmentSecret);
    expect(JSON.stringify(fixture.recorder.orderedItems())).not.toContain(secret);
    expect(JSON.stringify(fixture.recorder.orderedItems())).not.toContain(environmentSecret);
    expect(fixture.recorder.orderedItems()).toContainEqual(expect.objectContaining({
      type: 'commandExecution',
      modelCall: expect.objectContaining({ disposition: 'redactedReplay' }),
    }));

    const historical = await new CanonicalContextProjector(runtime.model, fixture.context).projectTurns([{
      ...fixture.context.turn,
      items: fixture.recorder.orderedItems(),
    }]);
    expect(JSON.stringify(historical)).not.toContain(secret);
    expect(JSON.stringify(historical)).not.toContain(environmentSecret);
    expect(JSON.stringify(historical)).toContain('[redacted secret-like content]');
    expect(JSON.stringify(historical)).toContain('replay notice');
  });

  test('persists unique canonical Items when one provider batch repeats a call id', async () => {
    const fixture = createContext();
    const duplicatedId = 'provider-duplicate-id';
    const executions: Array<{ readonly callId: string; readonly args: unknown }> = [];
    const strictTool = {
      name: 'strict_tool',
      label: 'Strict tool',
      description: 'Accepts one required string value.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      execute: async (callId: string, args: unknown) => {
        executions.push({ callId, args });
        return { content: [{ type: 'text' as const, text: 'valid pair completed' }], details: {} };
      },
    } as AgentTool;
    const providerContexts: Message[][] = [];
    let providerCalls = 0;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [strictTool],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, providerContext, options = {}) => {
          providerCalls += 1;
          providerContexts.push([...providerContext.messages]);
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = providerCalls === 1
            ? {
                ...assistantMessage([
                  {
                    type: 'toolCall',
                    id: duplicatedId,
                    name: strictTool.name,
                    arguments: { invalid: true },
                  },
                  {
                    type: 'toolCall',
                    id: duplicatedId,
                    name: strictTool.name,
                    arguments: { value: 'valid' },
                  },
                ]),
                stopReason: 'toolUse',
              }
            : assistantMessage([{ type: 'text', text: 'Done' }]);
          queueMicrotask(async () => {
            await options.onPayload?.({ model: model.id, input: providerContext.messages }, model);
            stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
            stream.end(message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });

    const items = fixture.recorder.orderedItems().filter((item) => (
      item.type === 'dynamicToolCall' && item.tool === strictTool.name
    ));
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    const rejected = items.find((item) => item.modelCall.disposition === 'evidenceOnly');
    const admitted = items.find((item) => item.modelCall.disposition === 'replayable');
    expect(rejected).toMatchObject({ id: duplicatedId, status: 'failed', success: false });
    expect(admitted).toMatchObject({ status: 'completed', success: true });
    expect(admitted?.id).not.toBe(duplicatedId);
    expect(executions).toEqual([{ callId: admitted?.id, args: { value: 'valid' } }]);

    const replay = providerContexts[1] ?? [];
    const replayCalls = replay.flatMap((message) => (
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall')
        : []
    ));
    const replayResults = replay.filter((message) => message.role === 'toolResult');
    expect(JSON.stringify(replay)).toContain('invalidArguments');
    expect(replayCalls).toHaveLength(1);
    expect(replayResults).toHaveLength(1);
    expect(replayCalls[0]?.id).toBe(admitted?.id);
    expect(replayResults[0]?.role === 'toolResult' ? replayResults[0].toolCallId : null)
      .toBe(admitted?.id);

    const executionBatch = fixture.diagnosticsPayloads[0]?.activities.find((activity) => (
      activity.type === 'toolExecutionBatch'
    ));
    expect(executionBatch?.type === 'toolExecutionBatch'
      ? executionBatch.executions.map((execution) => execution.callId)
      : []).toEqual(items.map((item) => item.id));
  });

  test('matches the native kernel Item and diagnostics golden', async () => {
    const fixture = createContext();
    let callCount = 0;
    const executor = new PiTurnExecutor({
      resolveRuntime: async () => runtimeSelection(),
      resolveRuntimeSettings: async () => runtimeSettings(),
      createTools: async () => [testTool('golden_tool', 'Golden parity tool')],
      createGateway: (hooks) => new PiModelGateway({
        ...hooks,
        streamSimple: (model, providerContext, options = {}) => {
          callCount += 1;
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = callCount === 1
            ? {
                ...assistantMessage([{
                  type: 'toolCall',
                  id: 'golden-call',
                  name: 'golden_tool',
                  arguments: {},
                }]),
                stopReason: 'toolUse',
              }
            : assistantMessage([{ type: 'text', text: 'Done' }]);
          queueMicrotask(async () => {
            await options.onPayload?.({
              model: model.id,
              input: providerContext.messages,
            }, model);
            await options.onResponse?.({
              status: 200,
              headers: { 'request-id': `golden-${callCount}` },
            }, model);
            stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
            stream.end(message);
          });
          return stream;
        },
      }),
    });

    await expect(executor.execute(fixture.context)).resolves.toMatchObject({ status: 'completed' });
    const diagnostics = fixture.diagnosticsPayloads[0];
    if (!diagnostics) throw new Error('Missing native kernel diagnostics fixture.');
    const actual = {
      items: fixture.recorder.orderedItems().map((item) => {
        if (item.type === 'dynamicToolCall') {
          return {
            type: item.type,
            tool: item.tool,
            status: item.status,
            success: item.success,
          };
        }
        if (item.type === 'contextEvidence') return { type: item.type, kind: item.kind };
        if (item.type === 'agentMessage') {
          return { type: item.type, text: item.text, phase: item.phase };
        }
        return { type: item.type };
      }),
      activities: diagnostics.activities.map((activity) => {
        if (activity.type === 'acceptedInput') {
          return { type: activity.type, source: activity.source };
        }
        if (activity.type === 'modelCall') {
          return { type: activity.type, callIndex: activity.callIndex };
        }
        if (activity.type === 'toolExecutionBatch') {
          return {
            type: activity.type,
            sourceCallIndex: activity.sourceCallIndex,
            executions: activity.executions.map((execution) => ({
              toolName: execution.toolName,
              status: execution.status,
            })),
          };
        }
        return { type: activity.type };
      }),
      providerStops: diagnostics.providerCalls.map((call) => call.response?.stopReason ?? null),
    };

    expect(actual).toEqual(NATIVE_KERNEL_GOLDEN.itemDiagnostics);
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

const anthropicToolParityModel = {
  id: 'claude-sonnet-test',
  name: 'Claude Sonnet Test',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} satisfies Model<'anthropic-messages'>;

function parityTool(
  name: string,
  description: string,
  parameters: Readonly<Record<string, unknown>>,
): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: parameters as AgentTool['parameters'],
    executionMode: 'sequential',
    execute: async () => ({ content: [{ type: 'text', text: 'unused' }], details: {} }),
  };
}

function providerPayloadTools(payload: unknown): Array<{
  readonly name: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}> {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { tools?: unknown }).tools)) {
    throw new Error('Anthropic provider fixture did not contain tools');
  }
  return (payload as { tools: unknown[] }).tools.map((tool) => {
    if (
      !tool
      || typeof tool !== 'object'
      || typeof (tool as { name?: unknown }).name !== 'string'
      || !(tool as { input_schema?: unknown }).input_schema
      || typeof (tool as { input_schema?: unknown }).input_schema !== 'object'
    ) {
      throw new Error('Anthropic provider fixture contained an invalid tool');
    }
    return tool as {
      readonly name: string;
      readonly input_schema: Readonly<Record<string, unknown>>;
      readonly [key: string]: unknown;
    };
  });
}

function anthropicTextResponse(text: string): Response {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: anthropicToolParityModel.id,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

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
    subagentTokenBudget: 1_500_000,
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
  const persistOutputImage = async (input: Uint8Array, mimeType: string) => {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const dimensions = imageDimensions(bytes);
    return {
      observation: {
        id: createHash('sha256').update(bytes).digest('hex'),
        mimeType,
        byteLength: bytes.byteLength,
        fileName: 'tool-output.png',
      },
      observationBytes: bytes,
      sourceDimensions: dimensions,
      observationDimensions: dimensions,
    };
  };
  const context: TurnExecutionContext = {
    thread,
    turn,
    historyBeforeTurn: [],
    configuration: {
      profileName: 'default',
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: ['bash', 'agent'],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    signal: new AbortController().signal,
    recorder,
    readContext: async () => null,
    readOutput: async (ref) => outputPayloads.get(ref.id) ?? null,
    resolveResourceObservationPath: async () => null,
    resolveImageArtifactPath: async () => null,
    readResource: async () => null,
    persistOutputImage,
    persistOutputResource: async (bytes, mimeType, fileName) => ({
      id: createHash('sha256').update(bytes).digest('hex'),
      mimeType,
      byteLength: bytes.byteLength,
      fileName,
    }),
    persistOutputText: async (_itemId, text, mimeType, summary) => {
      const id = createHash('sha256').update(text).digest('hex');
      outputPayloads.set(id, text);
      return { id, mimeType, byteLength: Buffer.byteLength(text, 'utf8'), summary };
    },
    persistToolCallArguments: async (value) => {
      const payload = { schemaVersion: 1 as const, kind: 'toolCallArguments' as const, value };
      const serialized = JSON.stringify(payload);
      const id = createHash('sha256').update(serialized).digest('hex');
      contextPayloads.set(id, payload);
      return {
        id,
        mimeType: 'application/vnd.tenon.agent-context+json',
        byteLength: Buffer.byteLength(serialized),
        schemaVersion: 1,
        kind: 'toolCallArguments',
      };
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
    resolveImageArtifactPath: async () => null,
  };
}

function imageArtifact(
  original: ThreadFileSource | null,
  observation: ThreadResourceReference,
  sourceDimensions = { width: 1, height: 1 },
  observationDimensions = { width: 1, height: 1 },
): ThreadImageArtifactReference {
  return createImageArtifactReference({
    createdAt: 1,
    retention: original?.kind === 'localFile' ? 'external' : 'observationOnly',
    original,
    observation,
    sourceDimensions,
    observationDimensions,
  });
}

function pngFixture(width = 1, height = 1, byteLength = ONE_PIXEL_PNG_BYTES.byteLength): Buffer {
  const bytes = Buffer.alloc(Math.max(byteLength, ONE_PIXEL_PNG_BYTES.byteLength));
  ONE_PIXEL_PNG_BYTES.copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function imageDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.byteLength < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('Test image is not a PNG fixture.');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
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

function historyTestTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} history fixture`,
    parameters: { type: 'object', additionalProperties: true },
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

function reasoningAssistantMessage(
  thinking: string,
  thinkingSignature: string,
  reasoningTokens: number,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'toolUse',
): AssistantMessage {
  const base = assistantMessage([
    { type: 'thinking', thinking, thinkingSignature },
    ...content,
  ]);
  return {
    ...base,
    stopReason,
    usage: {
      ...base.usage,
      output: reasoningTokens + 4,
      reasoning: reasoningTokens,
      totalTokens: reasoningTokens + 7,
    },
  };
}

function openAIReasoningSignature(id: string): string {
  return JSON.stringify({
    type: 'reasoning',
    id,
    encrypted_content: `encrypted-${id}`,
    summary: [{ type: 'summary_text', text: id }],
  });
}

function outboundThinkingSignatures(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => message.role === 'assistant'
    ? message.content.flatMap((part) => (
        part.type === 'thinking' && part.thinkingSignature ? [part.thinkingSignature] : []
      ))
    : []);
}

function outboundReasoningItemIds(input: readonly unknown[]): string[] {
  return input.flatMap((item) => (
    typeof item === 'object'
    && item !== null
    && 'type' in item
    && item.type === 'reasoning'
    && 'id' in item
    && typeof item.id === 'string'
      ? [item.id]
      : []
  ));
}

function emitAssistantMessage(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
): void {
  stream.push({ type: 'start', partial: message });
  message.content.forEach((part, contentIndex) => {
    if (part.type !== 'thinking') return;
    stream.push({ type: 'thinking_start', contentIndex, partial: message });
    stream.push({ type: 'thinking_delta', contentIndex, delta: part.thinking, partial: message });
    stream.push({ type: 'thinking_end', contentIndex, content: part.thinking, partial: message });
  });
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end(message);
}
