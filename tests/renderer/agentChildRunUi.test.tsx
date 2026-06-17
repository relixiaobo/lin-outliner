import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ToolCall, Usage } from '../../src/core/agentTypes';
import type { AgentRenderChildRunEntity } from '../../src/core/agentRenderProjection';
import type { AgentTaskEntry } from '../../src/renderer/agent/runtime';
import type { DocumentIndex } from '../../src/renderer/state/document';
import { AgentToolCallBlock } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { AgentChildRunDetailsPanel } from '../../src/renderer/ui/agent/AgentChildRunDetailsPanel';
import { AgentTaskPanel } from '../../src/renderer/ui/agent/AgentTaskPanel';

interface RenderedComponent {
  cleanup: () => void;
  commands: Array<{ cmd: string; args: Record<string, unknown> }>;
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: RenderedComponent[] = [];
const TEST_INDEX = {
  projection: { nodes: [], libraryId: 'library', trashId: 'trash' },
  byId: new Map(),
} as unknown as DocumentIndex;

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('agent child run UI', () => {
  test('renders a compact Agent tool block and opens transcript details', async () => {
    let openedChildRunId: string | null = null;
    const rendered = renderComponent(
      <AgentToolCallBlock
        onOpenChildRunTranscript={(childRunId) => {
          openedChildRunId = childRunId;
        }}
        pendingToolCallIds={new Set()}
        conversationId="conversation-1"
        childRun={childRunEntity()}
        toolCall={agentToolCall()}
        turnActive={false}
      />,
    );

    expect(rendered.container.textContent).toContain('Agent task · Inspect child run UI');

    await click(rendered, textButton(rendered, 'Agent task · Inspect child run UI'));

    expect(rendered.container.textContent).toContain('Status');
    expect(rendered.container.textContent).toContain('completed');
    expect(rendered.container.textContent).toContain('fork · explorer');
    expect(rendered.container.textContent).toContain('Inspect the current UI.');
    expect(rendered.container.textContent).toContain('Found the relevant UI path.');

    await click(rendered, textButton(rendered, 'View transcript'));
    expect(openedChildRunId).toBe('child-1');
  });

  test('loads a child run transcript and keeps nested tool calls expandable', async () => {
    const payloadText = JSON.stringify({
      v: 1,
      runId: 'child-1',
      messageCount: 4,
      messages: [
        {
          role: 'user',
          timestamp: 100,
          content: [{ type: 'text', text: 'Inspect the current UI.' }],
        },
        {
          role: 'assistant',
          timestamp: 120,
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-5.4',
          usage: emptyUsage(),
          stopReason: 'toolUse',
          content: [
            { type: 'thinking', thinking: 'Find relevant node context.', redacted: false },
            { type: 'toolCall', id: 'tool-read-1', name: 'node_read', arguments: { nodeId: 'today' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'tool-read-1',
          toolName: 'node_read',
          timestamp: 140,
          content: [{ type: 'text', text: 'Daily note content.' }],
          isError: false,
        },
        {
          role: 'assistant',
          timestamp: 180,
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-5.4',
          usage: emptyUsage(),
          stopReason: 'stop',
          content: [{ type: 'text', text: 'The UI path is ready.' }],
        },
      ],
    });
    const rendered = renderComponent(
      <AgentChildRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        childRun={childRunEntity()}
      />,
      {
        payloads: { 'child-1': payloadText },
      },
    );

    await waitForText(rendered, 'Inspect the current UI.');
    expect(rendered.container.textContent).toContain('Thought · Read node "today"');
    expect(rendered.container.textContent).toContain('The UI path is ready.');
    expect(rendered.container.textContent).not.toContain('Daily note content.');
    expect(rendered.container.textContent).toContain('Find relevant node context.');
    expect(rendered.container.textContent).toContain('Read node "today"');

    await click(rendered, firstToolCallToggle(rendered));

    expect(rendered.container.textContent).toContain('Daily note content.');
  });

  test('child run transcript details can open nested child runs', async () => {
    let openedChildRunId: string | null = null;
    const nestedRun = {
      ...childRunEntity(),
      id: 'child-2',
      description: 'Nested child run',
      parentToolCallId: 'tool-nested-agent',
    };
    const payloadText = JSON.stringify({
      v: 1,
      runId: 'child-1',
      messageCount: 1,
      messages: [
        {
          role: 'assistant',
          timestamp: 120,
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-5.4',
          usage: emptyUsage(),
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              id: 'tool-nested-agent',
              name: 'Agent',
              arguments: { description: 'Nested child run', prompt: 'Inspect the nested UI.' },
            },
          ],
        },
      ],
    });
    const rendered = renderComponent(
      <AgentChildRunDetailsPanel
        onClose={() => undefined}
        onOpenChildRunTranscript={(childRunId) => {
          openedChildRunId = childRunId;
        }}
        conversationId="conversation-1"
        index={TEST_INDEX}
        childRun={childRunEntity()}
        childRunsByParentToolCallId={new Map([[nestedRun.parentToolCallId!, nestedRun]])}
      />,
      {
        payloads: { 'child-1': payloadText },
      },
    );

    await waitForText(rendered, 'Agent task · Nested child run');
    await click(rendered, textButton(rendered, 'Agent task · Nested child run'));
    await click(rendered, textButton(rendered, 'View transcript'));

    expect(openedChildRunId).toBe('child-2');
  });

  test('threads child run duration and failure into shared transcript rows', async () => {
    const completedRun = {
      ...childRunEntity(),
      completedAt: 63_100,
      updatedAt: 63_100,
    };
    const completed = renderComponent(
      <AgentChildRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        childRun={completedRun}
      />,
      {
        payloads: {
          'child-1': JSON.stringify({
            v: 1,
            runId: 'child-1',
            messageCount: 3,
            messages: [
              {
                role: 'assistant',
                timestamp: 120,
                api: 'openai-completions',
                provider: 'openai',
                model: 'gpt-5.4',
                usage: emptyUsage(),
                stopReason: 'stop',
                content: [
                  { type: 'thinking', thinking: 'Inspect the relevant node.', redacted: false },
                  { type: 'toolCall', id: 'tool-read-duration', name: 'node_read', arguments: { nodeId: 'today' } },
                  { type: 'text', text: 'The UI path is ready.' },
                ],
              },
              {
                role: 'toolResult',
                toolCallId: 'tool-read-duration',
                toolName: 'node_read',
                timestamp: 140,
                content: [{ type: 'text', text: 'Daily note content.' }],
                isError: false,
              },
            ],
          }),
        },
      },
    );

    await waitForText(completed, 'Worked for 1m 3s');

    const failedRun = {
      ...childRunEntity(),
      completedAt: 63_100,
      result: undefined,
      status: 'failed' as const,
      updatedAt: 63_100,
    };
    const failed = renderComponent(
      <AgentChildRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        childRun={failedRun}
      />,
      {
        payloads: {
          'child-1': JSON.stringify({
            v: 1,
            runId: 'child-1',
            messageCount: 1,
            messages: [{
              role: 'assistant',
              timestamp: 120,
              api: 'openai-completions',
              provider: 'openai',
              model: 'gpt-5.4',
              usage: emptyUsage(),
              stopReason: 'toolUse',
              content: [
                { type: 'thinking', thinking: 'Inspect the relevant node.', redacted: false },
                { type: 'toolCall', id: 'tool-read-failed', name: 'node_read', arguments: { nodeId: 'today' } },
              ],
            }],
          }),
        },
      },
    );

    await waitForText(failed, 'Interrupted after thinking');
  });

  test('renders orphan tool results as capped plain text', async () => {
    const longOutput = `# not markdown\n${'stdout '.repeat(260)}`;
    const rendered = renderComponent(
      <AgentChildRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        childRun={childRunEntity()}
      />,
      {
        payloads: {
          'child-1': JSON.stringify({
            v: 1,
            runId: 'child-1',
            messageCount: 1,
            messages: [{
              role: 'toolResult',
              toolCallId: 'orphan-tool',
              toolName: 'bash',
              timestamp: 140,
              content: [{ type: 'text', text: longOutput }],
              isError: false,
            }],
          }),
        },
      },
    );

    await waitForText(rendered, '# not markdown');
    const pre = rendered.container.querySelector('.agent-transcript-tool-result-row pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent?.length ?? 0).toBeLessThanOrEqual(1203);
    expect(rendered.container.querySelector('.agent-transcript-tool-result-row h1')).toBeNull();
  });

  test('sends follow-ups and stops running childRuns through runtime commands', async () => {
    const rendered = renderComponent(
      <AgentChildRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        childRun={{
          ...childRunEntity(),
          completedAt: undefined,
          result: undefined,
          status: 'running',
        }}
      />,
      {
        payloads: {
          'child-1': JSON.stringify({
            v: 1,
            runId: 'child-1',
            messageCount: 1,
            messages: [{
              role: 'user',
              timestamp: 100,
              content: [{ type: 'text', text: 'Inspect the current UI.' }],
            }],
          }),
        },
      },
    );

    await waitForText(rendered, 'Inspect the current UI.');
    await changeTextarea(rendered, 'Agent task follow-up', 'Continue with layout risks.');
    await click(rendered, textButton(rendered, 'Send'));
    await click(rendered, textButton(rendered, 'Stop'));

    expect(rendered.commands.filter((call) => call.cmd === 'agent_child_run_send' || call.cmd === 'agent_child_run_stop')).toEqual([
      {
        cmd: 'agent_child_run_send',
        args: {
          agentId: 'child-1',
          message: 'Continue with layout risks.',
          conversationId: 'conversation-1',
        },
      },
      {
        cmd: 'agent_child_run_stop',
        args: {
          agentId: 'child-1',
          conversationId: 'conversation-1',
        },
      },
    ]);
  });

  test('lists child run tasks and stops a running task', async () => {
    let openedChildRunId: string | null = null;
    const running = childRunEntity();
    running.status = 'running';
    running.completedAt = undefined;
    const completed = {
      ...childRunEntity(),
      id: 'child-2',
      description: 'Summarize notes',
      status: 'completed' as const,
      updatedAt: 320,
      completedAt: 320,
    };
    const rendered = renderComponent(
      <AgentTaskPanel
        conversationId="conversation-1"
        onClose={() => undefined}
        onOpenChildRun={(childRunId) => {
          openedChildRunId = childRunId;
        }}
        tasks={[taskEntry(running), taskEntry(completed)]}
      />,
    );

    expect(rendered.container.textContent).toContain('Tasks');
    expect(rendered.container.textContent).toContain('1 task running');
    expect(rendered.container.querySelector('[aria-live="polite"]')?.textContent).toContain('1 task running');
    expect(rendered.container.textContent).toContain('Inspect child run UI');
    expect(rendered.container.textContent).toContain('Summarize notes');

    await click(rendered, textButton(rendered, 'Inspect child run UI'));
    expect(openedChildRunId).toBe('child-1');

    await click(rendered, ariaButton(rendered, 'Stop task'));
    await waitForCommand(rendered, 'agent_child_run_stop');

    expect(rendered.commands.filter((call) => call.cmd === 'agent_child_run_stop')).toEqual([{
      cmd: 'agent_child_run_stop',
      args: {
        agentId: 'child-1',
        conversationId: 'conversation-1',
      },
      }]);
  });

  test('an open panel refetches the transcript when the projected entity changes', async () => {
    // The conversation projection carries no per-message child data, so the
    // panel must refetch on every entity change (status flips, updatedAt
    // bumps) — the regression was a fetch keyed on childRun.id alone, which
    // froze an open panel for the run's whole lifetime.
    let setChildRun: (entity: AgentRenderChildRunEntity) => void = () => undefined;
    function Wrapper() {
      const [childRun, set] = useState<AgentRenderChildRunEntity>({
        ...childRunEntity(),
        status: 'running',
        completedAt: undefined,
        result: undefined,
        updatedAt: 100,
      });
      setChildRun = set;
      return (
        <AgentChildRunDetailsPanel
          onClose={() => undefined}
          conversationId="conversation-1"
          index={TEST_INDEX}
          childRun={childRun}
        />
      );
    }
    const rendered = renderComponent(<Wrapper />, {
      payloads: {
        'child-1': JSON.stringify({
          messages: [{ role: 'user', timestamp: 100, content: [{ type: 'text', text: 'Inspect the current UI.' }] }],
        }),
      },
    });

    await waitForText(rendered, 'Inspect the current UI.');
    const fetchCount = () => rendered.commands.filter((call) => call.cmd === 'agent_child_run_transcript').length;
    const before = fetchCount();
    expect(before).toBeGreaterThanOrEqual(1);

    // The run completes: the projected entity's status/updatedAt change and
    // the panel re-fetches without being closed and reopened.
    await act(async () => {
      setChildRun({ ...childRunEntity(), updatedAt: 300, completedAt: 300 });
      await Promise.resolve();
    });
    await waitForText(rendered, 'Inspect the current UI.');
    expect(fetchCount()).toBeGreaterThan(before);
  });

  test('lists Dream tasks as read-only agent tasks', async () => {
    let openedChildRunId: string | null = null;
    const dreamTask: AgentTaskEntry = {
      id: 'dream:dream-run-1',
      kind: 'dream',
      status: 'completed',
      trigger: 'manual',
      principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
      startedAt: 100,
      updatedAt: 150,
      completedAt: 150,
      runId: 'dream-run-1',
      processed: { totalMessageCount: 3, totalCharCount: 900, consolidateOnly: false },
      changes: { added: 1, updated: 0, forgotten: 0, skipped: 0 },
    };
    const rendered = renderComponent(
      <AgentTaskPanel
        conversationId="conversation-1"
        onClose={() => undefined}
        onOpenChildRun={(childRunId) => {
          openedChildRunId = childRunId;
        }}
        tasks={[dreamTask]}
      />,
    );

    expect(rendered.container.textContent).toContain('Dream');
    expect(rendered.container.textContent).toContain('Memory Dream');
    expect(rendered.container.textContent).toContain('Manual');
    expect(rendered.container.textContent).toContain('3 messages');
    expect(rendered.container.textContent).toContain('1 memory change');
    const meta = rendered.container.querySelector('.agent-task-meta');
    // Memory collapsed to one believer pool: a Dream task no longer shows a pool label.
    expect(meta?.textContent).toContain('Manual · 3 messages · 1 memory change');
    expect(meta?.textContent).not.toContain('About you');
    expect(meta?.childElementCount).toBe(0);
    expect(rendered.container.querySelector('[aria-label="Open task"]')).toBeNull();
    expect(openedChildRunId).toBeNull();
  });
});

function renderComponent(
  element: ReactNode,
  options: { payloads?: Record<string, string> } = {},
): RenderedComponent {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const { commands, restore } = installDomGlobals(window, options.payloads ?? {});

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });

  const rendered = {
    cleanup: () => {
      act(() => root.unmount());
      restore();
    },
    commands,
    container,
    document,
    window,
  } satisfies RenderedComponent & { root?: Root };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window, payloads: Record<string, string>) {
  const commands: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const previousGlobalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  const getComputedStyle = () => ({
    lineHeight: '26px',
    getPropertyValue: (property: string) => (property === 'line-height' ? '26px' : ''),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: getComputedStyle,
  });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: getComputedStyle,
  });
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: window.navigator,
  });
  (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    window: Window & {
      lin?: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
  }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => undefined },
  });
  (window as Window & {
    lin?: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
  }).lin = {
    invoke: async <T,>(cmd: string, args: Record<string, unknown> = {}) => {
      commands.push({ cmd, args: { ...args } });
      if (cmd === 'agent_payload_text') {
        return (payloads[String(args.payloadId)] ?? null) as T;
      }
      if (cmd === 'agent_child_run_transcript') {
        const raw = payloads[String(args.runId)];
        if (!raw) return null as T;
        return { messages: (JSON.parse(raw) as { messages: unknown[] }).messages } as T;
      }
      if (cmd === 'agent_child_run_send') {
        return {
          status: 'queued',
          agent_id: args.agentId,
          description: 'Inspect child run UI',
          prompt: 'Inspect the current UI.',
          agent_type: 'explorer',
          context_mode: 'fork',
          started_at: 100,
          updated_at: 300,
          transcript_message_count: 1,
        } as T;
      }
      if (cmd === 'agent_child_run_stop') {
        return {
          status: 'cancelled',
          agent_id: args.agentId,
          description: 'Inspect child run UI',
          prompt: 'Inspect the current UI.',
          agent_type: 'explorer',
          context_mode: 'fork',
          started_at: 100,
          updated_at: 300,
          completed_at: 300,
          transcript_message_count: 1,
        } as T;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    },
  };
  return {
    commands,
    restore: () => {
      if (previousGlobalGetComputedStyle) {
        Object.defineProperty(globalThis, 'getComputedStyle', previousGlobalGetComputedStyle);
      } else {
        delete (globalThis as typeof globalThis & { getComputedStyle?: unknown }).getComputedStyle;
      }
    },
  };
}

async function click(rendered: RenderedComponent, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

async function waitForText(rendered: RenderedComponent, text: string) {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (rendered.container.textContent?.includes(text)) return;
  }
  throw new Error(`Missing text: ${text}`);
}

async function changeTextarea(rendered: RenderedComponent, ariaLabel: string, value: string) {
  const element = rendered.document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${ariaLabel}"]`);
  if (!element) throw new Error(`Missing textarea: ${ariaLabel}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(rendered.window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new rendered.window.Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new rendered.window.Event('change', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function textButton(rendered: RenderedComponent, text: string): HTMLButtonElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function firstToolCallToggle(rendered: RenderedComponent): HTMLButtonElement {
  const found = rendered.document.querySelector<HTMLButtonElement>('.agent-tool-call-toggle');
  if (!found) throw new Error('Missing tool call toggle');
  return found;
}

function ariaButton(rendered: RenderedComponent, label: string): HTMLButtonElement {
  const found = rendered.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing aria button: ${label}`);
  return found;
}

async function waitForCommand(rendered: RenderedComponent, cmd: string) {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (rendered.commands.some((call) => call.cmd === cmd)) return;
  }
  throw new Error(`Missing command: ${cmd}`);
}

function agentToolCall(): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-agent-1',
    name: 'Agent',
    arguments: {
      description: 'Inspect child run UI',
      prompt: 'Inspect the current UI.',
    },
  };
}

function childRunEntity(): AgentRenderChildRunEntity {
  return {
    id: 'child-1',
    description: 'Inspect child run UI',
    prompt: 'Inspect the current UI.',
    agentType: 'explorer',
    contextMode: 'fork',
    executingAgentId: 'built-in:tenon:explorer',
    parentAgentId: 'built-in:tenon:assistant',
    memoryOwnerAgentId: 'built-in:tenon:assistant',
    status: 'completed',
    startedAt: 100,
    updatedAt: 260,
    completedAt: 260,
    result: 'Found the relevant UI path.',
    parentToolCallId: 'tool-agent-1',
  };
}

function taskEntry(childRun: AgentRenderChildRunEntity): AgentTaskEntry {
  return {
    id: `child-run:${childRun.id}`,
    kind: 'child-run',
    status: childRun.status,
    title: childRun.description,
    subtitle: `${childRun.contextMode} · ${childRun.agentType}`,
    startedAt: childRun.startedAt,
    updatedAt: childRun.updatedAt,
    completedAt: childRun.completedAt,
    childRunId: childRun.id,
    childRun,
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
