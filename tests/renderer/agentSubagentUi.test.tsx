import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ToolCall, Usage } from '../../src/core/agentTypes';
import type { AgentRenderSubagentEntity } from '../../src/core/agentRenderProjection';
import { AgentToolCallBlock } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { AgentSubagentDetailsPanel } from '../../src/renderer/ui/agent/AgentSubagentDetailsPanel';

interface RenderedComponent {
  cleanup: () => void;
  commands: Array<{ cmd: string; args: Record<string, unknown> }>;
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: RenderedComponent[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('agent subagent UI', () => {
  test('renders a compact Agent tool block and opens transcript details', async () => {
    let openedSubagentId: string | null = null;
    const rendered = renderComponent(
      <AgentToolCallBlock
        onOpenSubagentTranscript={(subagentId) => {
          openedSubagentId = subagentId;
        }}
        pendingToolCallIds={new Set()}
        sessionId="session-1"
        subagent={subagentEntity()}
        toolCall={agentToolCall()}
        turnActive={false}
      />,
    );

    expect(rendered.container.textContent).toContain('Subagent · Inspect subagent UI');

    await click(rendered, textButton(rendered, 'Subagent · Inspect subagent UI'));

    expect(rendered.container.textContent).toContain('Status');
    expect(rendered.container.textContent).toContain('completed');
    expect(rendered.container.textContent).toContain('fork · explorer');
    expect(rendered.container.textContent).toContain('Inspect the current UI.');
    expect(rendered.container.textContent).toContain('Found the relevant UI path.');

    await click(rendered, textButton(rendered, 'View transcript'));
    expect(openedSubagentId).toBe('subagent-1');
  });

  test('loads a subagent transcript and keeps nested tool calls expandable', async () => {
    const payloadText = JSON.stringify({
      v: 1,
      runId: 'subagent-1',
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
      <AgentSubagentDetailsPanel
        onClose={() => undefined}
        sessionId="session-1"
        subagent={subagentEntity()}
      />,
      {
        payloads: { 'subagent-transcript-1': payloadText },
      },
    );

    await waitForText(rendered, 'Inspect the current UI.');
    expect(rendered.container.textContent).toContain('Find relevant node context.');
    expect(rendered.container.textContent).toContain('Read node "today"');
    expect(rendered.container.textContent).toContain('The UI path is ready.');
    expect(rendered.container.textContent).not.toContain('Daily note content.');

    await click(rendered, textButton(rendered, 'Read node "today"'));

    expect(rendered.container.textContent).toContain('Daily note content.');
  });

  test('sends follow-ups and stops running subagents through runtime commands', async () => {
    const rendered = renderComponent(
      <AgentSubagentDetailsPanel
        onClose={() => undefined}
        sessionId="session-1"
        subagent={{
          ...subagentEntity(),
          completedAt: undefined,
          result: undefined,
          status: 'running',
        }}
      />,
      {
        payloads: {
          'subagent-transcript-1': JSON.stringify({
            v: 1,
            runId: 'subagent-1',
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
    await changeTextarea(rendered, 'Subagent follow-up', 'Continue with layout risks.');
    await click(rendered, textButton(rendered, 'Send'));
    await click(rendered, textButton(rendered, 'Stop'));

    expect(rendered.commands.filter((call) => call.cmd.startsWith('agent_subagent_'))).toEqual([
      {
        cmd: 'agent_subagent_send',
        args: {
          agentId: 'subagent-1',
          message: 'Continue with layout risks.',
          sessionId: 'session-1',
        },
      },
      {
        cmd: 'agent_subagent_stop',
        args: {
          agentId: 'subagent-1',
          sessionId: 'session-1',
        },
      },
    ]);
  });
});

function renderComponent(
  element: ReactNode,
  options: { payloads?: Record<string, string> } = {},
): RenderedComponent {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const commands = installDomGlobals(window, options.payloads ?? {});

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });

  const rendered = {
    cleanup: () => {
      act(() => root.unmount());
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
      if (cmd === 'agent_subagent_send') {
        return {
          status: 'queued',
          agent_id: args.agentId,
          description: 'Inspect subagent UI',
          prompt: 'Inspect the current UI.',
          subagent_type: 'explorer',
          context_mode: 'fork',
          started_at: 100,
          updated_at: 300,
          transcript_message_count: 1,
        } as T;
      }
      if (cmd === 'agent_subagent_stop') {
        return {
          status: 'stopped',
          agent_id: args.agentId,
          description: 'Inspect subagent UI',
          prompt: 'Inspect the current UI.',
          subagent_type: 'explorer',
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
  return commands;
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

function agentToolCall(): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-agent-1',
    name: 'Agent',
    arguments: {
      description: 'Inspect subagent UI',
      prompt: 'Inspect the current UI.',
    },
  };
}

function subagentEntity(): AgentRenderSubagentEntity {
  return {
    id: 'subagent-1',
    description: 'Inspect subagent UI',
    prompt: 'Inspect the current UI.',
    subagentType: 'explorer',
    contextMode: 'fork',
    status: 'completed',
    startedAt: 100,
    updatedAt: 260,
    completedAt: 260,
    result: 'Found the relevant UI path.',
    transcriptPayloadId: 'subagent-transcript-1',
    transcriptMessageCount: 4,
    parentToolCallId: 'tool-agent-1',
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
