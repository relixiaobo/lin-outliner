import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AgentRunDetailPayload, AgentRunListEntry, ToolCall, Usage } from '../../src/core/agentTypes';
import type { AgentRenderRunEntity } from '../../src/core/agentRenderProjection';
import type { DocumentIndex } from '../../src/renderer/state/document';
import { AgentToolCallBlock } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { AgentToolActivityGroup } from '../../src/renderer/ui/agent/AgentToolActivityGroup';
import { AgentRunDetailsPanel } from '../../src/renderer/ui/agent/AgentRunDetailsPanel';
import { AgentRunsPanel } from '../../src/renderer/ui/agent/AgentRunsPanel';
import { renderAssistantBlocks } from '../../src/renderer/ui/agent/AgentAssistantTurnContent';
import type { AgentExpandState } from '../../src/renderer/ui/agent/agentProcessTypes';

interface RenderedComponent {
  cleanup: () => void;
  commands: Array<{ cmd: string; args: Record<string, unknown> }>;
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: RenderedComponent[] = [];
// Honours the caller's default so a live process opens expanded (no user toggle
// is recorded in these tests).
const NOOP_EXPAND_STATE: AgentExpandState = {
  isExpanded: (_id, defaultExpanded = false) => defaultExpanded,
  toggle: () => {},
};
const TEST_INDEX = {
  projection: { nodes: [], libraryId: 'library', trashId: 'trash' },
  byId: new Map(),
} as unknown as DocumentIndex;

interface ChildRunFixture {
  id: string;
  description: string;
  prompt: string;
  executingAgentId: string;
  status: AgentRunListEntry['status'];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: string;
  parentRunId?: string;
  parentToolCallId?: string;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('agent child run UI', () => {
  test('renders child runs through the ordinary Agent tool block and opens transcript details', async () => {
    let openedChildRunId: string | null = null;
    const rendered = renderComponent(
      <AgentToolCallBlock
        onOpenRunTranscript={(runId) => {
          openedChildRunId = runId;
        }}
        pendingToolCallIds={new Set()}
        conversationId="conversation-1"
        subRun={renderRunEntity()}
        toolCall={agentToolCall()}
        turnActive={false}
      />,
    );

    expect(rendered.container.textContent).toContain('Ran agent run');
    expect(rendered.container.textContent).toContain('Inspect Run UI');

    await click(rendered, firstToolCallToggle(rendered));

    expect(rendered.container.textContent).toContain('Input');
    expect(rendered.container.textContent).toContain('Inspect the current UI.');
    expect(rendered.container.textContent).not.toContain('Found the relevant UI path.');

    await click(rendered, textButton(rendered, 'View transcript'));
    expect(openedChildRunId).toBe('child-1');
  });

  test('uses child run status when summarizing ordinary tool activity groups', () => {
    const runningSubRun = {
      ...renderRunEntity(),
      completedAt: undefined,
      status: 'running' as const,
    };
    const rendered = renderComponent(
      <AgentToolActivityGroup
        conversationId="conversation-1"
        expandState={NOOP_EXPAND_STATE}
        id="activity:tool-bash-1"
        index={TEST_INDEX}
        members={[
          {
            id: 'tool:tool-bash-1',
            type: 'toolCall',
            toolCall: { type: 'toolCall', id: 'tool-bash-1', name: 'bash', arguments: { command: 'pwd' } },
            outcome: 'completed',
          },
          {
            id: 'tool:tool-agent-1',
            type: 'toolCall',
            toolCall: agentToolCall(),
            subRun: runningSubRun,
          },
        ]}
        pendingToolCallIds={new Set()}
        results={new Map()}
        turnActive
      />,
    );

    expect(rendered.container.textContent).toContain('Ran a command · managing an agent run');
  });

  test('loads a run transcript and keeps nested tool calls expandable', async () => {
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
            { type: 'toolCall', id: 'tool-read-1', name: 'node_read', arguments: { node_id: 'today' } },
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
      <AgentRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
      />,
      {
        payloads: { 'child-1': payloadText },
      },
    );

    await waitForText(rendered, 'Inspect the current UI.');
    expect(rendered.container.textContent).toContain('The UI path is ready.');
    expect(rendered.container.textContent).not.toContain('Daily note content.');
    // The thinking's first line shows as the dim gist beside the "Thought" label
    // (Codex `reasoning` preview); the full body is one click away.
    expect(rendered.container.textContent).toContain('Find relevant node context.');
    expect(rendered.container.textContent).toContain('Read node "today"');

    await click(rendered, firstToolCallToggle(rendered));

    expect(rendered.container.textContent).toContain('Daily note content.');
  });

  test('uses structured run submission as the detail result', async () => {
    const payloadText = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          timestamp: 180,
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-5.4',
          usage: emptyUsage(),
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Activity transcript text.' }],
        },
      ],
      latestSubmission: {
        runId: 'child-1',
        seq: 7,
        submittedAt: 200,
        summary: 'Structured submitted result.',
        source: 'final_assistant_message',
      },
    });
    const rendered = renderComponent(
      <AgentRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
      />,
      {
        details: {
          'child-1': runDetailPayload({
            result: {
              runId: 'child-1',
              seq: 7,
              submittedAt: 200,
              summary: 'Structured submitted result.',
              source: 'final_assistant_message',
            },
          }),
        },
        payloads: { 'child-1': payloadText },
      },
    );

    await waitForText(rendered, 'Structured submitted result.');
    expect(rendered.container.textContent).not.toContain('Old projected result.');
  });

  test('run transcript details can open nested runs', async () => {
    let openedChildRunId: string | null = null;
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
              name: 'spawn_run',
              arguments: { description: 'Nested sub-run', objective: 'Inspect the nested UI.' },
            },
          ],
        },
      ],
    });
    const rendered = renderComponent(
      <AgentRunDetailsPanel
        onClose={() => undefined}
        onOpenRun={(runId) => {
          openedChildRunId = runId;
        }}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
      />,
      {
        details: {
          'child-1': runDetailPayload({
            subRuns: [
              runDetailChild({
                runId: 'child-2',
                title: 'Nested sub-run',
                parentToolCallId: 'tool-nested-agent',
              }),
            ],
          }),
        },
        payloads: { 'child-1': payloadText },
      },
    );

    await waitForText(rendered, 'Ran agent run');
    await click(rendered, firstToolCallToggle(rendered));
    await click(rendered, textButton(rendered, 'View transcript'));

    expect(openedChildRunId).toBe('child-2');
  });

  test('threads run duration and failure into shared transcript rows', async () => {
    const completedRun = {
      ...childRunEntity(),
      completedAt: 63_100,
      updatedAt: 63_100,
    };
    const completed = renderComponent(
      <AgentRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
      />,
      {
        details: {
          'child-1': runDetailPayload({
            updatedAt: completedRun.updatedAt,
            completedAt: completedRun.completedAt,
          }),
        },
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
                  { type: 'toolCall', id: 'tool-read-duration', name: 'node_read', arguments: { node_id: 'today' } },
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
      <AgentRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
      />,
      {
        details: {
          'child-1': runDetailPayload({
            status: failedRun.status,
            updatedAt: failedRun.updatedAt,
            completedAt: failedRun.completedAt,
            result: undefined,
          }),
        },
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
                { type: 'toolCall', id: 'tool-read-failed', name: 'node_read', arguments: { node_id: 'today' } },
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
      <AgentRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
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

  test('stops running runs from read-only details', async () => {
    const rendered = renderComponent(
      <AgentRunDetailsPanel
        onClose={() => undefined}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
      />,
      {
        details: {
          'child-1': runDetailPayload({
            completedAt: undefined,
            result: undefined,
            status: 'running',
          }),
        },
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
    expect(rendered.document.querySelector('textarea[aria-label="Agent run follow-up"]')).toBeNull();
    await click(rendered, textButton(rendered, 'Stop'));

    expect(rendered.commands.filter((call) => call.cmd === 'agent_run_steer' || call.cmd === 'agent_run_stop')).toEqual([
      {
        cmd: 'agent_run_stop',
        args: {
          runId: 'child-1',
          conversationId: 'conversation-1',
        },
      },
    ]);
  });

  test('shows direct child runs in the run details page', async () => {
    let openedChildRunId: string | null = null;
    const parent = {
      ...childRunEntity(),
      result: '- [ ] Complete testing.\n- [ ] Finish review.\n- [ ] Prepare release.',
    };
    const nestedRun = {
      ...childRunEntity(),
      id: 'child-2',
      description: 'Verify launch checklist',
      parentRunId: 'child-1',
      parentToolCallId: 'tool-agent-2',
      startedAt: 180,
      updatedAt: 260,
      completedAt: 260,
    };
    const rendered = renderComponent(
      <AgentRunDetailsPanel
        onClose={() => undefined}
        onOpenRun={(runId) => {
          openedChildRunId = runId;
        }}
        conversationId="conversation-1"
        index={TEST_INDEX}
        runId="child-1"
      />,
      {
        details: {
          'child-1': runDetailPayload({
            result: {
              runId: 'child-1',
              seq: 2,
              submittedAt: 260,
              summary: parent.result!,
              source: 'final_assistant_message',
            },
            verificationRuns: [
              runDetailChild({
                runId: nestedRun.id,
                title: nestedRun.description,
                objectiveRole: 'verifier',
                runProfile: 'verify',
                runProfileLabel: 'Verify',
                parentToolCallId: nestedRun.parentToolCallId,
                startedAt: nestedRun.startedAt,
                updatedAt: nestedRun.updatedAt,
                completedAt: nestedRun.completedAt,
              }),
            ],
          }),
        },
        payloads: {
          'child-1': JSON.stringify({
            v: 1,
            runId: 'child-1',
            messageCount: 0,
            messages: [],
          }),
        },
      },
    );

    await waitForText(rendered, 'Verification');
    expect(rendered.container.textContent).toContain('Result');
    expect(rendered.container.textContent).toContain('Complete testing.');
    expect(rendered.container.querySelector('.agent-run-detail-section-header [aria-label="Copy run result"]')).not.toBeNull();
    expect(rendered.container.querySelector('.agent-run-detail-result-actions')).toBeNull();
    expect(rendered.container.querySelector('.agent-run-detail-result-box .contains-task-list')).not.toBeNull();
    expect(rendered.container.querySelectorAll('.agent-run-detail-result-box .task-list-item')).toHaveLength(3);
    expect(rendered.container.textContent).toContain('Verifier');

    await click(rendered, textButton(rendered, 'Verifier'));
    expect(openedChildRunId).toBe('child-2');
  });

  test('lists run trees and stops a running run', async () => {
    let openedRunId: string | null = null;
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
      parentRunId: 'child-1',
    };
    const verifierPrompt = 'You are an independent verifier Run. Inspect the submitted child Run result.';
    const verifier = {
      ...runEntry(completed),
      runId: 'child-3',
      parentRunId: 'child-1',
      purpose: 'verify' as const,
      status: 'failed' as const,
      title: verifierPrompt,
    };
    const rendered = renderComponent(
      <AgentRunsPanel
        error={null}
        loading={false}
        onOpenRun={(run) => {
          openedRunId = run.runId;
        }}
        onRefresh={() => undefined}
        runs={[runEntry(running), runEntry(completed), verifier]}
      />,
    );

    expect(rendered.container.querySelector('[role="tree"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain('Inspect Run UI');
    expect(rendered.container.textContent).toContain('Summarize notes');
    expect(rendered.container.textContent).toContain('Verifier');
    expect(rendered.container.textContent).not.toContain(verifierPrompt);
    expect(rendered.container.textContent).toContain('Sub-runs 1/2');
    expect(rendered.container.textContent).not.toContain('General ·');
    expect(rendered.container.textContent).not.toContain('Verified ·');
    expect(rendered.container.querySelector('.agent-run-child-toggle')).not.toBeNull();

    await click(rendered, textButton(rendered, 'Sub-runs 1/2'));
    expect(openedRunId).toBeNull();

    await click(rendered, textTreeItem(rendered, 'Inspect Run UI'));
    expect(openedRunId).toBe('child-1');

    await click(rendered, ariaButton(rendered, 'Stop run'));
    await waitForCommand(rendered, 'agent_run_stop');

    expect(rendered.commands.filter((call) => call.cmd === 'agent_run_stop')).toEqual([{
      cmd: 'agent_run_stop',
      args: {
        runId: 'child-1',
        conversationId: 'conversation-1',
      },
      }]);
  });

  test('an open panel refetches the transcript when the run index entry changes', async () => {
    // The Run detail payload carries no per-message transcript data, so the
    // panel refetches when the Run index entry changes (status flips, updatedAt
    // bumps) and keeps polling while the run is live.
    let setRunUpdatedAt: (updatedAt: number) => void = () => undefined;
    function Wrapper() {
      const [runUpdatedAt, set] = useState(100);
      setRunUpdatedAt = set;
      return (
        <AgentRunDetailsPanel
          onClose={() => undefined}
          conversationId="conversation-1"
          index={TEST_INDEX}
          runId="child-1"
          runUpdatedAt={runUpdatedAt}
        />
      );
    }
    const rendered = renderComponent(<Wrapper />, {
      details: {
        'child-1': runDetailPayload({
          status: 'running',
          completedAt: undefined,
          result: undefined,
          updatedAt: 100,
        }),
      },
      payloads: {
        'child-1': JSON.stringify({
          messages: [{ role: 'user', timestamp: 100, content: [{ type: 'text', text: 'Inspect the current UI.' }] }],
        }),
      },
    });

    await waitForText(rendered, 'Inspect the current UI.');
    const fetchCount = () => rendered.commands.filter((call) => call.cmd === 'agent_run_transcript').length;
    const before = fetchCount();
    expect(before).toBeGreaterThanOrEqual(1);

    // The run index entry changes and the panel re-fetches without being closed
    // and reopened.
    await act(async () => {
      setRunUpdatedAt(300);
      await Promise.resolve();
    });
    await waitForText(rendered, 'Inspect the current UI.');
    expect(fetchCount()).toBeGreaterThan(before);
  });

});

describe('assistant turn interrupted verdict', () => {
  // A thinking-only turn whose run is flagged interrupted but is STILL active
  // (a failed/cancelled run on the path being recovered by a newer live run —
  // retry / reactive-compaction). The live turn must never render the RED
  // "Interrupted after thinking" header nor the error styling: an active turn is
  // working, not interrupted.
  test('an active turn is never labelled interrupted', () => {
    const rendered = renderComponent(
      <AssistantTurn turnActive turnInterrupted />,
    );
    // `.is-error` is the RED verdict styling (exactly `turnFailedWithoutProse`).
    expect(rendered.container.querySelector('.agent-process-block.is-error')).toBeNull();
    expect(rendered.container.textContent?.toLowerCase()).not.toContain('interrupted');
  });

  // The settled-failure case is unchanged: a turn whose run ended
  // interrupted (no live run) keeps the RED label + error styling.
  test('a settled interrupted turn keeps the interrupted label', () => {
    const rendered = renderComponent(
      <AssistantTurn turnActive={false} turnInterrupted />,
    );
    expect(rendered.container.querySelector('.agent-process-block.is-error')).not.toBeNull();
    expect(rendered.container.textContent?.toLowerCase()).toContain('interrupted');
  });
});

function AssistantTurn({ turnActive, turnInterrupted }: { turnActive: boolean; turnInterrupted: boolean }) {
  const message = {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '**Preparing PPT in Chinese**' }],
    stopReason: null,
  } as unknown as Parameters<typeof renderAssistantBlocks>[0];
  return (
    <>
      {renderAssistantBlocks(
        message,
        'turn-1',
        TEST_INDEX,
        NOOP_EXPAND_STATE,
        undefined,
        undefined,
        new Set(),
        'conversation-1',
        turnActive,
        undefined,
        new Map(),
        turnActive,
        turnInterrupted,
        false,
        null,
        null,
      )}
    </>
  );
}

function renderComponent(
  element: ReactNode,
  options: { details?: Record<string, AgentRunDetailPayload>; payloads?: Record<string, string> } = {},
): RenderedComponent {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const { commands, restore } = installDomGlobals(window, options.payloads ?? {}, options.details ?? {});

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

function installDomGlobals(
  window: Window,
  payloads: Record<string, string>,
  details: Record<string, AgentRunDetailPayload>,
) {
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
      if (cmd === 'agent_run_detail') {
        const runId = String(args.runId);
        return (details[runId] ?? (runId === 'child-1' ? runDetailPayload() : null)) as T;
      }
      if (cmd === 'agent_run_transcript') {
        const raw = payloads[String(args.runId)];
        if (!raw) return null as T;
        const parsed = JSON.parse(raw) as { messages: unknown[]; latestSubmission?: unknown };
        return {
          messages: parsed.messages,
          latestSubmission: parsed.latestSubmission,
        } as T;
      }
      if (cmd === 'agent_run_steer') {
        const runId = args.runId;
        return {
          status: 'queued',
          runId: runId,
          description: 'Inspect Run UI',
          runProfile: 'default',
          context_mode: 'brief',
          started_at: 100,
          updated_at: 300,
          transcript_message_count: 1,
        } as T;
      }
      if (cmd === 'agent_run_stop') {
        const runId = args.runId;
        return {
          status: 'cancelled',
          runId: runId,
          description: 'Inspect Run UI',
          runProfile: 'default',
          context_mode: 'brief',
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

function textButton(rendered: RenderedComponent, text: string): HTMLButtonElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function textTreeItem(rendered: RenderedComponent, text: string): HTMLElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`Missing tree item: ${text}`);
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
    name: 'spawn_run',
    arguments: {
      description: 'Inspect Run UI',
      objective: 'Inspect the current UI.',
    },
  };
}

function renderRunEntity(overrides: Partial<AgentRenderRunEntity> = {}): AgentRenderRunEntity {
  return {
    id: 'child-1',
    agentId: 'built-in:tenon:explorer',
    anchor: { type: 'conversation', agentId: 'built-in:tenon:explorer', conversationId: 'conversation-1' },
    conversationId: 'conversation-1',
    title: 'Inspect Run UI',
    parentToolCallId: 'tool-agent-1',
    runProfile: 'default',
    runProfileLabel: 'Default',
    status: 'completed',
    objectiveStatus: 'verified',
    objectiveRole: 'worker',
    context: 'brief',
    startedAt: 100,
    updatedAt: 260,
    completedAt: 260,
    ...overrides,
  };
}

function childRunEntity(): ChildRunFixture {
  return {
    id: 'child-1',
    description: 'Inspect Run UI',
    prompt: 'Inspect the current UI.',
    executingAgentId: 'built-in:tenon:explorer',
    status: 'completed',
    startedAt: 100,
    updatedAt: 260,
    completedAt: 260,
    result: 'Found the relevant UI path.',
    parentToolCallId: 'tool-agent-1',
  };
}

function runDetailPayload(overrides: Partial<AgentRunDetailPayload> = {}): AgentRunDetailPayload {
  return {
    runId: 'child-1',
    conversationId: 'conversation-1',
    agentId: 'built-in:tenon:explorer',
    kind: 'delegation',
    title: 'Inspect Run UI',
    status: 'completed',
    runProfile: 'default',
    runProfileLabel: 'Default',
    context: 'brief',
    disposition: 'attended',
    parentToolCallId: 'tool-agent-1',
    startedAt: 100,
    updatedAt: 260,
    completedAt: 260,
    objective: {
      text: 'Inspect the current UI.',
      criteria: [],
    },
    result: {
      runId: 'child-1',
      seq: 1,
      submittedAt: 260,
      summary: 'Found the relevant UI path.',
      source: 'final_assistant_message',
    },
    subRuns: [],
    verificationRuns: [],
    transcriptMessageCount: 1,
    ...overrides,
  };
}

function runDetailChild(overrides: Partial<AgentRunDetailPayload['subRuns'][number]> = {}): AgentRunDetailPayload['subRuns'][number] {
  return {
    runId: 'child-2',
    title: 'Nested run',
    status: 'completed',
    runProfile: 'default',
    runProfileLabel: 'Default',
    parentRunId: 'child-1',
    startedAt: 180,
    updatedAt: 260,
    completedAt: 260,
    ...overrides,
  };
}

function runEntry(childRun: ChildRunFixture): AgentRunListEntry {
  return {
    runId: childRun.id,
    conversationId: 'conversation-1',
    conversationTitle: 'General',
    agentId: childRun.executingAgentId,
    kind: 'delegation',
    status: childRun.status,
    purpose: undefined,
    parentRunId: childRun.parentRunId ?? null,
    title: childRun.description,
    startedAt: childRun.startedAt,
    updatedAt: childRun.updatedAt,
    completedAt: childRun.completedAt,
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
