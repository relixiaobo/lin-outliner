import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  ThreadId,
  ToolTaskProjection,
  ToolTaskReadResponse,
} from '../../src/core/agent/protocol';
import {
  TOOL_TASK_STRIP_LINGER_MS,
  ToolTaskStrip,
  taskStripRows,
} from '../../src/renderer/agent/components/ToolTaskStrip';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const OWNER_ID = 'thread-owner' as ThreadId;
const GLOBAL_KEYS = ['document', 'Event', 'HTMLElement', 'Node', 'window'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('Tool Task strip', () => {
  test('orders active work first and keeps terminal work only for the linger window', () => {
    const now = 20_000;
    const running = task('running', 'running', 10_000, null);
    const recent = task('recent', 'failed', 5_000, now - 1_000);
    const stale = task('stale', 'succeeded', 1_000, now - TOOL_TASK_STRIP_LINGER_MS);

    expect(taskStripRows([recent, stale, running], now).map((candidate) => candidate.taskId))
      .toEqual(['running', 'recent']);
  });

  test('reads terminal detail on demand and stops active work through generic task controls', async () => {
    const { document, root } = installDom();
    const stopped: string[] = [];
    const read: string[] = [];
    const now = 20_000;
    const running = task('running', 'running', 10_000, null);
    const terminal = {
      ...task('terminal', 'failed', 5_000, now - 1_000),
      error: 'Renderer failed.',
      artifacts: [{
        ref: { id: 'a'.repeat(64), mimeType: 'video/mp4', byteLength: 12, fileName: 'clip.mp4' },
        readablePath: '/tmp/clip.mp4',
        label: 'Rendered clip',
      }],
    };
    const onRead = async (_threadId: ThreadId, taskId: string): Promise<ToolTaskReadResponse> => {
      read.push(taskId);
      return {
        task: taskId === terminal.taskId ? terminal : running,
        output: { stdout: 'bounded output', stderr: '', stdoutTruncated: false, stderrTruncated: false },
      };
    };

    await render(root, (
      <ToolTaskStrip
        now={now}
        onClearDetails={async () => 0}
        onRead={onRead}
        onStop={async (_threadId, taskId) => { stopped.push(taskId); }}
        ownerThreadId={OWNER_ID}
        tasks={[terminal, running]}
      />
    ));
    await act(async () => {
      document.querySelector<HTMLElement>('.thread-work-strip-pill')?.click();
    });
    expect(document.querySelectorAll('.thread-tool-task-row')).toHaveLength(2);

    await act(async () => {
      document.querySelector<HTMLElement>('.thread-work-strip-stop')?.click();
      const rows = document.querySelectorAll<HTMLElement>('.thread-work-strip-open');
      rows[1]?.click();
      await Promise.resolve();
    });
    expect(stopped).toEqual(['running']);
    expect(read).toEqual(['terminal']);
    expect(document.querySelector('.thread-tool-task-output')?.textContent).toBe('bounded output');
    expect(document.querySelector('.thread-tool-task-artifacts')?.textContent).toContain('Rendered clip');
    expect(document.querySelector('.thread-tool-task-error')?.textContent).toBe('Renderer failed.');
  });

  test('removes the final terminal row when the injected clock leaves the linger window', async () => {
    const { document, root } = installDom();
    const clock = 20_000;
    const terminal = task('terminal', 'succeeded', clock - 2_000, clock - 1_000);
    const view = (now: number) => (
      <ToolTaskStrip
        now={now}
        onRead={async () => { throw new Error('not read'); }}
        onClearDetails={async () => 0}
        onStop={async () => undefined}
        ownerThreadId={OWNER_ID}
        tasks={[terminal]}
      />
    );
    await render(root, view(clock));
    expect(document.querySelector('.thread-work-strip')).not.toBeNull();
    await render(root, view(clock + TOOL_TASK_STRIP_LINGER_MS * 2));
    expect(document.querySelector('.thread-work-strip')).toBeNull();
  });

  test('requires confirmation before clearing eligible details under storage pressure', async () => {
    const { document, root } = installDom();
    const calls: string[] = [];
    const pressured = {
      ...task('pressure', 'failed', 10_000, 19_000),
      detailState: 'storage_pressure' as const,
      storagePressure: {
        scope: 'thread' as const,
        limitBytes: 1_024,
        usedBytes: 1_024,
        requiredBytes: 512,
        reclaimableBytes: 256,
        protectedBytes: 768,
      },
    };
    await render(root, (
      <ToolTaskStrip
        now={20_000}
        onClearDetails={async (threadId) => { calls.push(threadId); return 256; }}
        onRead={async () => ({ task: pressured, output: null })}
        onStop={async () => undefined}
        ownerThreadId={OWNER_ID}
        tasks={[pressured]}
      />
    ));
    await act(async () => {
      document.querySelector<HTMLElement>('.thread-work-strip-pill')?.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('.thread-work-strip-open')?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('.thread-tool-task-pressure')?.textContent).toContain('512 B');
    await act(async () => {
      document.querySelector<HTMLElement>('.thread-tool-task-pressure button')?.click();
    });
    expect(calls).toEqual([]);
    expect(document.querySelector('.confirm-dialog')).not.toBeNull();
    await act(async () => {
      const buttons = document.querySelectorAll<HTMLElement>('.confirm-dialog-actions button');
      buttons[1]?.click();
      await Promise.resolve();
    });
    expect(calls).toEqual([OWNER_ID]);
    expect(document.querySelector('.thread-tool-task-pressure')?.textContent).toContain('256 B cleared');
  });
});

function task(
  taskId: string,
  state: ToolTaskProjection['state'],
  startedAt: number,
  completedAt: number | null,
): ToolTaskProjection {
  return {
    taskId,
    ownerThreadId: OWNER_ID,
    sourceTurnId: 'turn-source',
    sourceItemId: 'item-source',
    producer: 'bash',
    description: `${taskId} command`,
    state,
    deliveryState: completedAt === null ? 'pending' : 'delivered',
    progress: null,
    exitCode: completedAt === null ? null : state === 'succeeded' ? 0 : 1,
    signal: null,
    outcomeReason: null,
    error: null,
    detailState: 'available',
    artifacts: [],
    artifactWarnings: [],
    outputBytes: 0,
    detailBytes: 0,
    storagePressure: null,
    startedAt,
    completedAt,
    deliveryTurnId: completedAt === null ? null : 'turn-delivery',
  };
}

async function render(root: ReturnType<typeof createRoot>, tree: ReactNode): Promise<void> {
  await act(async () => { root.render(<I18nProvider>{tree}</I18nProvider>); });
}

function installDom(): {
  readonly document: Document;
  readonly root: ReturnType<typeof createRoot>;
  readonly window: Window & typeof globalThis;
} {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(window, {
    lin: {
      initialLanguage: 'en',
      invoke: async () => ({}),
      onLanguageChanged: () => () => undefined,
    },
  });
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  return { document, root, window: window as Window & typeof globalThis };
}
