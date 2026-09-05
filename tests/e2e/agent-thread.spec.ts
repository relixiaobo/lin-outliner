import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { emulateVisualMedia, resolveTokenColor } from './emulatedMedia';
import { clipboardText, commandCalls, ids, openMockedApp, rowBody, rowEditor } from './outlinerMock';
import { ATTACHMENT_UPLOAD_CHUNK_BYTES } from '../../src/core/agentAttachmentLimits';
import { en } from '../../src/core/i18n/messages/en';
import { zhHans } from '../../src/core/i18n/messages/zh-Hans';
import {
  TRANSCRIPT_VIRTUAL_MIN_TURNS,
  TRANSCRIPT_VIRTUAL_OVERSCAN_PX,
} from '../../src/renderer/agent/transcriptVirtualWindow';

const FORMER_SHARED_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

const ACTION_MENU_LABEL_KEYS = [
  'details', 'rename', 'delete', 'hideFromRecall', 'showInRecall', 'recordsUnavailable',
] as const;

/**
 * Every string the action menu can render, in every locale that overrides one.
 *
 * `en` is indexed strictly rather than through an all-optional type, which would
 * accept the complete object and silently drop a renamed key. That is only half
 * the protection it looks like: `tsconfig.json` includes `src` alone, so
 * `bun run typecheck` never reads this file and a stale key here is not a
 * compile error today. The test therefore checks the key set at runtime too —
 * see the assertions in the guard. `zhHans` genuinely may omit an override, so
 * an optional read is right for it, and a key it invents that `Messages` lacks
 * does fail to compile, in `zh-Hans.ts` itself.
 */
const ACTION_MENU_LABELS = [
  ...ACTION_MENU_LABEL_KEYS.map((key) => en.agent.thread[key]),
  ...ACTION_MENU_LABEL_KEYS
    .map((key) => zhHans.agent?.thread?.[key])
    .filter((label): label is string => typeof label === 'string'),
];

async function createNewThread(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })
    .click();
}

test('creates a new Thread with Command-Shift-O and teaches the shortcut in the Thread list', async ({ page }) => {
  await openMockedApp(page);
  const startsBefore = (await commandCalls(page)).filter((call) => call.cmd === 'thread/start').length;
  await page.getByRole('button', { name: 'Collapse agent' }).click();
  await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'collapsed');

  await page.keyboard.press('Meta+Shift+O');

  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'thread/start').length
  )).toBe(startsBefore + 1);
  await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'open');
  await expect(page.locator('.thread-dock-title')).toContainText('Untitled Thread');
  await expect(page.locator('.thread-dock-header').getByRole('button', { name: 'Trajectory' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Show Threads' }).click();
  const newThread = page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread' });
  await expect(newThread).toHaveAttribute('title', 'New Thread (⇧⌘O)');
  await expect(newThread).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+O');
  await expect(page.locator('.thread-list-row')).toHaveCount(2);
});

async function pasteComposerText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', value);
    const target = document.activeElement;
    if (!target) throw new Error('No active composer paste target');
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    }));
  }, text);
}

async function setTranscriptFollowingBottom(page: Page): Promise<void> {
  const transcript = page.locator('.thread-transcript');
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThanOrEqual(1);
}

async function toggleDisclosureWithStableAnchor(toggle: Locator, anchor: Locator = toggle): Promise<void> {
  await expect(toggle).toBeVisible();
  await expect(anchor).toBeVisible();
  const top = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  await toggle.click();
  const frameDeltas = await anchor.evaluate(async (element, expectedTop) => {
    const deltas: number[] = [];
    for (let frame = 0; frame < 16; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      deltas.push(Math.abs(element.getBoundingClientRect().top - expectedTop));
    }
    return deltas;
  }, top);
  expect(Math.max(...frameDeltas)).toBeLessThan(1);
}

async function seedOverflowingTranscript(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000fa01';
    const itemId = '01910000-0000-7000-8000-00000000fa02';
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [{
          id: itemId,
          type: 'agentMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
          text: Array.from(
            { length: 32 },
            (_, index) => `Earlier transcript evidence ${index + 1}.`,
          ).join('\n\n'),
          phase: 'final_answer',
          memoryCitation: null,
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    });
  });
  await expect(page.getByText('Earlier transcript evidence 32.')).toBeVisible();
}

/** A settled Turn whose user message is long enough to clamp, with a short reply
 *  under it. Seeded rather than sent, so no send anchor or tail spacer is in
 *  flight while the disclosure is measured. */
async function seedLongUserMessageTurn(page: Page, label: string): Promise<void> {
  await page.evaluate(async (evidence) => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000fb01';
    const userItemId = '01910000-0000-7000-8000-00000000fb02';
    const replyItemId = '01910000-0000-7000-8000-00000000fb03';
    const provenance = (originItemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId });
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [
          {
            id: userItemId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: provenance(userItemId),
            content: [{
              type: 'text',
              text: Array.from({ length: 80 }, (_, index) => `${evidence} ${index + 1}.`).join(' '),
            }],
          },
          {
            id: replyItemId,
            type: 'agentMessage',
            provenance: provenance(replyItemId),
            text: 'Understood.',
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    });
  }, label);
  await expect(page.locator('.thread-user-expand-button')).toBeVisible();
}

/**
 * A conversation tall enough to scroll but under the virtualization threshold —
 * the flow-layout transcript nearly every real conversation is, where a saved
 * pixel offset does not survive a remount on its own.
 */
async function seedTallFlowTranscript(page: Page, turnCount: number): Promise<void> {
  await page.evaluate(async (count) => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    for (let index = 0; index < count; index += 1) {
      const text = Array.from(
        { length: 30 },
        (_, line) => `Tall message ${index + 1} line ${line + 1} with enough words to wrap across the transcript.`,
      ).join('\n\n');
      await target.lin?.agentCoreRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        clientUserMessageId: `tall-${index + 1}`,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, turnCount);
  await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'false');
}

async function seedPaintContinuityTranscript(page: Page, turnCount: number): Promise<void> {
  await page.evaluate((count) => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    return target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {}).then((response) => {
      const threadId = response.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < count; index += 1) {
        const suffix = String(index + 1).padStart(12, '0');
        const turnId = `01920000-0000-7000-8000-${suffix}`;
        const itemId = `01920000-0000-7001-8000-${suffix}`;
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId,
          turnId,
          turn: {
            id: turnId,
            items: [{
              id: itemId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
              text: `Paint continuity answer ${index + 1}. ${'Stable visible evidence. '.repeat(8)}`,
              phase: 'final_answer',
              memoryCitation: null,
            }],
            itemsView: 'full',
            provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
            status: 'completed',
            error: null,
            startedAt: index * 2 + 1,
            completedAt: index * 2 + 2,
            durationMs: 1,
          },
        });
      }
    });
  }, turnCount);
  await expect(page.locator('.thread-transcript-turns')).toHaveAttribute(
    'data-virtualized',
    turnCount > TRANSCRIPT_VIRTUAL_MIN_TURNS ? 'true' : 'false',
  );
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => (
    requestAnimationFrame(() => resolve())
  ))));
}

interface TranscriptCoverageSample {
  readonly covered: boolean;
  readonly intersectingRows: number;
  readonly mountedRows: number;
  readonly scrollTop: number;
}

async function sampleTranscriptJumpCoverage(
  page: Page,
  target: 'bottom' | 'turnMiddle' | 'turnStart',
): Promise<TranscriptCoverageSample[]> {
  return page.locator('.thread-transcript').evaluate(async (element, jumpTarget) => {
    const readCoverage = (): TranscriptCoverageSample => {
      const turns = element.querySelector<HTMLElement>('.thread-transcript-turns');
      if (!turns) throw new Error('Missing Turn container');
      const scrollBounds = element.getBoundingClientRect();
      const turnsBounds = turns.getBoundingClientRect();
      const viewportTop = scrollBounds.top + element.clientTop;
      const viewportBottom = viewportTop + element.clientHeight;
      const contentTop = Math.max(viewportTop, turnsBounds.top);
      const contentBottom = Math.min(viewportBottom, turnsBounds.bottom);
      const rows = Array.from(turns.querySelectorAll<HTMLElement>('[data-thread-turn-row]'));
      if (contentBottom <= contentTop) {
        return { covered: true, intersectingRows: 0, mountedRows: rows.length, scrollTop: element.scrollTop };
      }
      const intersectingRows = rows.filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > contentTop
          && bounds.top < contentBottom
          && row.checkVisibility({ contentVisibilityAuto: true });
      }).length;
      return {
        covered: intersectingRows > 0,
        intersectingRows,
        mountedRows: rows.length,
        scrollTop: element.scrollTop,
      };
    };

    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const turns = element.querySelector<HTMLElement>('.thread-transcript-turns');
    if (!turns) throw new Error('Missing Turn container');
    const scrollBounds = element.getBoundingClientRect();
    const turnOrigin = element.scrollTop
      + turns.getBoundingClientRect().top
      - (scrollBounds.top + element.clientTop);
    const nextTop = jumpTarget === 'bottom'
      ? element.scrollHeight
      : jumpTarget === 'turnStart'
        ? turnOrigin
        : turnOrigin + turns.scrollHeight / 2;
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event('scroll'));
    const samples = [readCoverage()];
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(readCoverage());
    }
    return samples;
  }, target);
}

function expectTranscriptCoverage(samples: readonly TranscriptCoverageSample[]): void {
  expect(samples).toHaveLength(3);
  expect(samples.every((sample) => sample.covered)).toBe(true);
  expect(Math.min(...samples.map((sample) => sample.intersectingRows))).toBeGreaterThan(0);
}

interface ReadingAnchor {
  readonly offset: number;
  readonly turnId: string;
}

/** Where the reader is: the Turn at the top of the viewport, and its offset. */
async function captureReadingAnchor(page: Page, fraction: number): Promise<ReadingAnchor> {
  const transcript = page.locator('.thread-transcript');
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThan(400);
  return transcript.evaluate(async (element, ratio) => {
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maximum * ratio);
    element.dispatchEvent(new Event('scroll'));
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const viewportTop = element.getBoundingClientRect().top;
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-thread-turn-row]'));
    // The same predicate production anchors on: the last row starting at or
    // above the viewport top. Requiring a row to straddle it would find nothing
    // whenever the offset lands in the 12px gap between two rows.
    const row = rows.filter((candidate) => (
      candidate.getBoundingClientRect().top <= viewportTop
    )).at(-1) ?? rows[0];
    const turnId = row?.dataset.threadTurnRow;
    if (!row || !turnId) throw new Error('Missing reading anchor');
    return { offset: row.getBoundingClientRect().top - viewportTop, turnId };
  }, fraction);
}

/**
 * The anchored Turn is back where it was — and stays there. Settling for one
 * frame is not enough: a transcript that agrees on arrival and is then pushed
 * by rows rendering above it has still lost the reader's place.
 */
async function expectReadingAnchorRestored(page: Page, anchor: ReadingAnchor): Promise<void> {
  const row = page.locator(`[data-thread-turn-row="${anchor.turnId}"]`);
  await expect(row).toHaveCount(1);
  const drift = (element: HTMLElement, expected: number) => {
    const scroller = element.closest('.thread-transcript');
    if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
    return Math.abs(
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected,
    );
  };
  await expect.poll(() => row.evaluate(drift, anchor.offset)).toBeLessThanOrEqual(2);
  const frameDrifts = await row.evaluate(async (element, expected) => {
    const scroller = element.closest('.thread-transcript');
    if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
    const drifts: number[] = [];
    for (let frame = 0; frame < 16; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      drifts.push(Math.abs(
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected,
      ));
    }
    return drifts;
  }, anchor.offset);
  expect(Math.max(...frameDrifts)).toBeLessThanOrEqual(2);
}

async function renameSelectedThread(page: Page, name: string): Promise<void> {
  await openSelectedThreadActions(page);
  await page.getByRole('menu', { name: 'Thread actions' })
    .getByRole('menuitem', { name: 'Rename Thread' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Rename Thread' });
  await dialog.getByRole('textbox', { name: 'Rename Thread' }).fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.thread-dock-title')).toContainText(name);
}

/**
 * One settled Turn holding three consecutive command Items — completed, failed
 * with no exit code, and interrupted — so the counted activity group and each
 * member row can be inspected for their own status treatment.
 */
async function seedMixedStatusToolTurn(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000b001';
    const commandItem = (suffix: string, command: string, status: string, exitCode: number | null) => {
      const id = `01910000-0000-7000-8000-00000000b0${suffix}`;
      return {
        id,
        type: 'commandExecution',
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: id },
        command,
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'bash' },
          providerName: 'bash',
          arguments: { storage: 'inline', value: { command } },
          schemaDigest: '0'.repeat(64),
        },
        description: null,
        cwd: '/mock/workspace',
        processId: null,
        status,
        commandActions: [],
        aggregatedOutput: null,
        exitCode,
        durationMs: 1,
      };
    };
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [
          commandItem('02', 'ls', 'completed', 0),
          commandItem('03', 'timeout 1 sleep 5', 'failed', null),
          commandItem('04', 'sleep 30', 'interrupted', null),
          {
            id: '01910000-0000-7000-8000-00000000b005',
            type: 'agentMessage',
            provenance: {
              originThreadId: threadId,
              originTurnId: turnId,
              originItemId: '01910000-0000-7000-8000-00000000b005',
            },
            text: 'One command failed and one was stopped.',
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 5,
        durationMs: 4,
      },
    });
  });
}

async function openSelectedThreadActions(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .locator('.thread-list-row.is-selected')
    .getByRole('button', { name: 'Thread actions' })
    .click();
}

test('automatic Thread creation preserves outliner focus established while it is pending', async ({ page }) => {
  await openMockedApp(page, { initialThreadStartDelayMs: 750 });
  const editor = rowEditor(page, ids.beta);

  await editor.click();
  await expect(editor).toBeFocused();
  await expect(page.locator('.thread-dock-title')).toContainText('Untitled Thread');
  await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
  await expect(editor).toBeFocused();

  await page.keyboard.type('!');
  await expect(editor).toContainText('!');
  await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toHaveText('');
});

test.describe('canonical agent Thread surface', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('creates an empty Thread and renders canonical Turn Items', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await expect(composer).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(page.locator('.thread-empty-state')).toHaveCount(0);
    await expect(page.locator('.thread-dock-title')).toContainText('Untitled Thread');
    await expect(page.locator('.thread-dock-header').getByRole('button', { name: 'New Thread' })).toHaveCount(0);
    await expect(page.locator('.thread-dock-header').getByRole('button', { name: 'Thread actions' })).toHaveCount(0);

    await composer.fill('Summarize current outline.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.thread-dock-title')).toContainText('Summarize current outline.');

    const turn = page.locator('.thread-turn').first();
    const userMessage = turn.locator('.thread-user-message');
    const response = turn.locator('.thread-agent-message');
    await expect(userMessage).toContainText('Summarize current outline.');
    await expect(response).toContainText('Current outline focuses on design-system work.');
    // The Turn's work summary rides the speaker's own line — one header, not a
    // band of its own under a separate name row.
    await expect(turn.locator('.thread-speaker-header .thread-process-title')).toHaveCount(1);
    await expect(turn.locator('.thread-process-rule')).toHaveCount(0);
    await page.evaluate(async () => {
      const target = window as unknown as {
        lin?: { agentCoreRequest: (method: string, input: unknown) => Promise<{ data: Array<{ id: string }> }> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const threads = await target.lin!.agentCoreRequest('thread/list', {});
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/name/updated',
        threadId: threads.data[0]!.id,
        threadName: 'Current outline summary',
      });
    });
    await expect(page.locator('.thread-dock-title')).toContainText('Current outline summary');
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await expect(page.locator('.thread-list-row.is-selected')).toContainText('Current outline summary');
    await page.keyboard.press('Escape');
    await response.hover();
    const responseActions = response.locator('.thread-response-actions');
    await expect(responseActions).toHaveCSS('opacity', '1');
    expect(await responseActions.getByRole('button').first().evaluate((button) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-soft)';
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(button).color === expected;
    })).toBe(true);
    expect(await responseActions.getByRole('button').evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label'))
    ))).toEqual([
      'Copy message',
      'Continue in new chat',
      'Open Trajectory',
    ]);
    const [responseBodyBox, responseActionsBox] = await Promise.all([
      response.locator('.thread-agent-message-body').boundingBox(),
      responseActions.boundingBox(),
    ]);
    expect(responseBodyBox).toBeTruthy();
    expect(responseActionsBox).toBeTruthy();
    expect(responseActionsBox!.y).toBeGreaterThanOrEqual(responseBodyBox!.y + responseBodyBox!.height - 1);

    const messageDetailsButton = responseActions.getByRole('button', { name: 'Open Trajectory' });
    await messageDetailsButton.hover();
    const trajectoryHint = page.getByRole('tooltip');
    await expect(trajectoryHint).toHaveCount(1);
    await expect(trajectoryHint).toContainText('Open Trajectory');
    await expect(trajectoryHint).toContainText('200 tok');
    await expect(trajectoryHint).toContainText('$0.00061');
    await expect(trajectoryHint).not.toContainText('Inspect this turn’s context, tools, events, and evidence.');
    const paneCountBeforeDetails = await page.locator('.outline-panel-surface').count();
    await messageDetailsButton.click();
    await expect(page.getByRole('dialog', { name: 'Details' })).toHaveCount(0);
    await expect(trajectoryHint).toHaveCount(0);
    const trajectory = page.locator('.outline-panel-surface.is-thread-trajectory');
    await expect(trajectory).toBeVisible();
    await expect(trajectory).toHaveClass(/active-panel/);
    await expect(page.locator('.outline-panel-surface')).toHaveCount(paneCountBeforeDetails);
    await expect(trajectory).toContainText('Trajectory');
    const assistantTrajectoryRow = trajectory.locator('[data-kind="assistant"]');
    await expect(assistantTrajectoryRow).toContainText('Assistant');
    await expect(assistantTrajectoryRow).toContainText('Mock response');
    await expect(trajectory.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await expect(trajectory.getByRole('tab', { name: 'Preview' })).toBeVisible();
    await expect(trajectory.getByRole('tab', { name: 'Request' })).toBeVisible();
    await expect(trajectory.getByRole('tab', { name: 'Raw' })).toBeVisible();
    await trajectory.getByRole('tab', { name: 'Raw' }).click();
    const trajectoryInspector = trajectory.locator('.thread-trajectory-inspector');
    await expect(trajectoryInspector).toContainText('Part 1 · Text');
    await expect(trajectoryInspector).toContainText('Mock response');
    await expect(trajectoryInspector).toContainText('Typed evidence');
    await expect(trajectoryInspector).toContainText('Mock request');
    await trajectory.getByRole('tab', { name: 'Request' }).click();
    await expect(trajectoryInspector).toContainText('Mock request');

    const closeInspector = trajectory.getByRole('button', { name: 'Close Trajectory inspector' });
    const backToLedger = trajectory.getByRole('button', { name: 'Back to Trajectory ledger' });
    if (await closeInspector.isVisible()) {
      await closeInspector.click();
    } else {
      await backToLedger.click();
    }
    const trajectorySearch = trajectory.getByRole('searchbox', { name: 'Search loaded records' });
    await trajectorySearch.fill('Mock request');
    await expect(trajectory.locator('[data-kind="input"]')).toBeVisible();
    await expect(trajectory.locator('[data-kind="assistant"]')).toHaveCount(0);
    await expect(trajectory).toContainText('Search is scoped to the currently loaded Trajectory window.');
    await trajectorySearch.fill('');
    await expect(trajectory.locator('[data-kind="assistant"]')).toBeVisible();

    const durationToggle = trajectory.getByRole('button', { name: 'Duration' });
    await expect(durationToggle).toHaveAttribute('aria-pressed', 'true');
    await durationToggle.click();
    await expect(durationToggle).toHaveAttribute('aria-pressed', 'false');

    await trajectory.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.locator('.outline-panel-surface.active-panel.is-outliner')).toBeVisible();

    await userMessage.hover();
    expect(await userMessage.locator('.thread-message-actions').getByRole('button').evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label'))
    ))).toEqual(['Edit message', 'Copy message']);

    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Thread Details' }).click();
    const details = page.getByRole('dialog', { name: 'Thread Details' });
    await expect(details).toContainText('Thread ID');
    await expect(details).toContainText('Turn');
    await expect(details).toContainText('Item');
    await expect(details).toContainText('userMessage');
    await expect(details).toContainText('agentMessage');
    const canonicalIds = (await details.locator('code').allTextContents())
      .filter((value) => /^019[0-9a-f]{5}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
    expect(canonicalIds).toHaveLength(4);
    expect(new Set(canonicalIds).size).toBe(4);
    await details.getByRole('button', { name: 'Close Thread Details' }).click();

    const calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).toEqual(expect.arrayContaining([
      'thread/list',
      'thread/start',
      'thread/trajectory/read',
      'thread/trajectory/detail/read',
      'thread/turns/list',
      'turn/submit',
      'goal/get',
    ]));
  });

  test('submits and recalls a structured Thread reference selected by keyboard or pointer', async ({ page }) => {
    await renameSelectedThread(page, 'Launch archive');
    const sourceThreadId = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Source Thread not found');
      return threadId;
    });
    await createNewThread(page);

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('@Launch');
    const keyboardOption = page.getByRole('option', { name: /Launch archive/i });
    await expect(keyboardOption).toBeVisible();
    await expect(page.getByText('Chats', { exact: true })).toBeVisible();
    await composer.press('Enter');
    const reference = composer.locator(`[data-thread-thread-ref="${sourceThreadId}"]`);
    await expect(reference).toContainText('Launch archive');

    await page.getByRole('button', { name: 'Send' }).click();
    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([{
      type: 'threadReference',
      threadId: sourceThreadId,
    }]);
    await expect(page.locator('.thread-user-message').last()).toContainText('Launch archive');

    await composer.press('ArrowUp');
    await expect(composer.locator(`[data-thread-thread-ref="${sourceThreadId}"]`))
      .toContainText('Launch archive');

    await composer.fill('@Launch');
    const pointerOption = page.getByRole('option', { name: /Launch archive/i });
    await expect(pointerOption).toBeVisible();
    await pointerOption.click();
    await expect(composer.locator(`[data-thread-thread-ref="${sourceThreadId}"]`))
      .toContainText('Launch archive');

    await page.locator('.thread-user-message').last().getByRole('link', { name: 'Launch archive' }).click();
    await expect(page.locator('.thread-dock-title')).toHaveText('Launch archive');
  });

  test('renders used Memory as an inline Node reference while keeping supporting work in the process', async ({ page }) => {
    const fixture = await page.evaluate(async ({ memoryNodeId }) => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000b101';
      const userId = '01910000-0000-7000-8000-00000000b102';
      const toolId = '01910000-0000-7000-8000-00000000b103';
      const answerId = '01910000-0000-7000-8000-00000000b104';
      const itemProvenance = (itemId: string) => ({
        originThreadId: threadId,
        originTurnId: turnId,
        originItemId: itemId,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: itemProvenance(userId),
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Use my saved preference.' }],
            },
            {
              id: toolId,
              type: 'dynamicToolCall',
              provenance: itemProvenance(toolId),
              namespace: null,
              tool: 'file_read',
              arguments: { file_path: '/workspace/saved-preference.md' },
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'file_read' },
                providerName: 'file_read',
                arguments: { storage: 'inline', value: { file_path: '/workspace/saved-preference.md' } },
                schemaDigest: '0'.repeat(64),
              },
              status: 'completed',
              outputRef: null,
              contentItems: [{ type: 'json', value: { nodeId: memoryNodeId, text: 'Prefer concise answers.' } }],
              success: true,
              durationMs: 8,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: itemProvenance(answerId),
              text: `I kept the response concise based on [[node://${memoryNodeId}]].`,
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 100,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 120,
              cost: null,
            },
          },
          startedAt: Date.now() - 1_000,
          completedAt: Date.now(),
          durationMs: 1_000,
        },
      });
      return { turnId };
    }, { memoryNodeId: ids.library });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    const answer = turn.locator('.thread-agent-message-final_answer');
    await expect(answer).toBeVisible();
    await expect(answer.getByRole('link', { name: 'Library' })).toBeVisible();
    await expect(turn.locator('.thread-memory-citations')).toHaveCount(0);
    await expect(turn.getByText('Used memory')).toHaveCount(0);
    const process = turn.locator('.thread-speaker');
    await process.getByRole('button', { name: 'Worked for 1s' }).click();
    // The row stays in the process, but says what it did rather than which tool
    // was called.
    await expect(process.locator('.thread-tool').filter({ hasText: 'Read' })).toBeVisible();
    await expect(process).not.toContainText('file_read');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.mouse.move(0, 0);
    await expect(answer.getByRole('link', { name: 'Library' })).toBeVisible();
  });

  test('projects live and settled Turn process before the final response', async ({ page }) => {
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    const ids = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const settledTurnId = '01910000-0000-7000-8000-00000000c101';
      const userId = '01910000-0000-7000-8000-00000000c102';
      const answerId = '01910000-0000-7000-8000-00000000c103';
      const reasoningId = '01910000-0000-7000-8000-00000000c104';
      const provenance = { originThreadId: threadId, originTurnId: settledTurnId, trigger: { kind: 'user' } };
      const itemProvenance = (itemId: string) => ({
        originThreadId: threadId,
        originTurnId: settledTurnId,
        originItemId: itemId,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId: settledTurnId,
        turn: {
          id: settledTurnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: itemProvenance(userId),
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Inspect the rollout order.' }],
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: itemProvenance(answerId),
              text: 'The final response arrived first.',
              phase: 'final_answer',
              memoryCitation: null,
            },
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: itemProvenance(reasoningId),
              summary: ['Checked the canonical evidence.'],
              content: [],
            },
          ],
          itemsView: 'full',
          provenance,
          status: 'completed',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: null,
            },
          },
          startedAt: Date.now() - 2_400,
          completedAt: Date.now(),
          durationMs: 2_400,
        },
      });

      const liveTurnId = '01910000-0000-7000-8000-00000000c201';
      return { liveTurnId, settledTurnId, threadId };
    });

    const settledTurn = page.locator(`[data-thread-turn-row="${ids.settledTurnId}"]`);
    const process = settledTurn.locator('.thread-speaker');
    await expect(process).toHaveCount(1);
    await expect(process.getByRole('button', { name: 'Worked for 2s' })).toBeVisible();
    // The work summary names the Turn from the speaker's own line, above the
    // response it produced — the order this test exists for.
    expect(await settledTurn
      .locator('.thread-speaker-header, .thread-agent-message-final_answer')
      .evaluateAll((elements) => elements.map((element) => element.className))).toEqual([
      'thread-speaker-header',
      'thread-item thread-agent-message thread-agent-message-final_answer',
    ]);
    await process.getByRole('button', { name: 'Worked for 2s' }).click();
    await expect(settledTurn.getByText('Checked the canonical evidence.')).toBeVisible();

    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const userId = '01910000-0000-7000-8000-00000000c202';
      const reasoningId = '01910000-0000-7000-8000-00000000c204';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: userId },
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Show the live state.' }],
            },
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: reasoningId },
              summary: ['Initiating web search.'],
              content: [],
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: null,
            },
          },
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
    }, ids);

    const liveTurn = page.locator(`[data-thread-turn-row="${ids.liveTurnId}"]`);
    await expect(liveTurn.locator('.thread-process-timeline')).toHaveCount(1);
    await expect(liveTurn.locator('.thread-process-title')).toHaveText('Working');
    const liveTitleGeometry = await liveTurn.locator('.thread-process-title').evaluate((element) => {
      const divider = element.closest('.thread-speaker-meta');
      if (!(divider instanceof HTMLElement)) throw new Error('Expected live process summary');
      return {
        numericVariant: getComputedStyle(element).fontVariantNumeric,
        widthDelta: Math.abs(
          element.getBoundingClientRect().width - divider.getBoundingClientRect().width,
        ),
      };
    });
    expect(liveTitleGeometry.numericVariant).toContain('tabular-nums');
    expect(liveTitleGeometry.widthDelta).toBeLessThan(1);
    await expect(liveTurn.getByText('Initiating web search.')).toBeVisible();
    const liveIndicator = liveTurn.getByLabel('Assistant is responding');
    await expect(liveIndicator).toBeVisible();
    const indicatorAlignment = await liveIndicator.evaluate((element) => {
      const footer = element.closest('.thread-response-footer');
      if (!(footer instanceof HTMLElement)) throw new Error('Expected response footer');
      const footerRect = footer.getBoundingClientRect();
      const indicatorRect = element.getBoundingClientRect();
      return Math.abs(
        (footerRect.top + footerRect.height / 2) - (indicatorRect.top + indicatorRect.height / 2),
      );
    });
    expect(indicatorAlignment).toBeLessThan(1);
    await page.evaluate(() => {
      const target = window as Window & {
        lin?: object;
        __threadMessageContextMenuCalls?: number;
      };
      if (!target.lin) throw new Error('Expected renderer bridge');
      target.__threadMessageContextMenuCalls = 0;
      const lin = target.lin as {
        showThreadMessageContextMenu?: () => Promise<null>;
      };
      lin.showThreadMessageContextMenu = async () => {
        target.__threadMessageContextMenuCalls = (target.__threadMessageContextMenuCalls ?? 0) + 1;
        return null;
      };
    });
    await liveIndicator.click({ button: 'right' });
    expect(await page.evaluate(() => (
      (window as Window & { __threadMessageContextMenuCalls?: number }).__threadMessageContextMenuCalls
    ))).toBe(0);
    // The summary names the timeline from the speaker's own line, directly
    // above it. There is no separator band between them to balance any more —
    // what has to hold is that the name and the rows it names stay adjacent.
    const liveProcessGaps = await liveTurn.locator('.thread-speaker').evaluate((element) => {
      const title = element.querySelector<HTMLElement>('.thread-speaker-header .thread-process-title');
      const timeline = element.querySelector<HTMLElement>('.thread-process-timeline');
      if (!title || !timeline) throw new Error('Expected live process geometry elements');
      return {
        gap: timeline.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
        rules: element.querySelectorAll('.thread-process-rule').length,
      };
    });
    expect(liveProcessGaps.rules).toBe(0);
    expect(liveProcessGaps.gap).toBeGreaterThan(0);
    expect(liveProcessGaps.gap).toBeLessThan(20);

    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/providerRetry/changed',
        threadId,
        turnId: liveTurnId,
        status: { kind: 'request', attempt: 1, maxRetries: 5 },
      });
    }, ids);
    const retrying = liveTurn.locator('.thread-response-footer .thread-provider-retry');
    await expect(retrying).toHaveText('Retrying 1/5');
    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/providerRetry/changed',
        threadId,
        turnId: liveTurnId,
        status: { kind: 'stream', attempt: 1, maxRetries: 3 },
      });
    }, ids);
    const reconnect = liveTurn.locator('.thread-response-footer .thread-provider-retry');
    await expect(reconnect).toHaveText('Reconnecting 1/3');
    await expect(liveTurn.getByLabel('Assistant is responding')).toHaveCount(0);
    await expect(page.locator('.thread-transcript-content > .thread-provider-retry')).toHaveCount(0);
    const reconnectAlignment = await reconnect.evaluate((element) => {
      const footer = element.closest('.thread-response-footer');
      if (!(footer instanceof HTMLElement)) throw new Error('Expected response footer');
      const footerRect = footer.getBoundingClientRect();
      const retryRect = element.getBoundingClientRect();
      return Math.abs(
        (footerRect.top + footerRect.height / 2) - (retryRect.top + retryRect.height / 2),
      );
    });
    expect(reconnectAlignment).toBeLessThan(1);
    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/providerRetry/changed',
        threadId,
        turnId: liveTurnId,
        status: null,
      });
    }, ids);
    await expect(liveTurn.getByLabel('Assistant is responding')).toBeVisible();

    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const userId = '01910000-0000-7000-8000-00000000c202';
      const answerId = '01910000-0000-7000-8000-00000000c203';
      const reasoningId = '01910000-0000-7000-8000-00000000c204';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: userId },
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Show the live state.' }],
            },
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: reasoningId },
              summary: ['Initiating web search.'],
              content: [],
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: answerId },
              text: 'The live state is complete.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: null,
            },
          },
          startedAt: Date.now() - 1_400,
          completedAt: Date.now(),
          durationMs: 1_400,
        },
      });
    }, ids);

    await expect(liveTurn.getByLabel('Assistant is responding')).toHaveCount(0);
    await expect(liveTurn.locator('.thread-process-title')).toHaveText('Worked for 1s');
  });

  test('keeps a process-free response stable when the Turn completes', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 340 });
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c301';
      const userId = '01910000-0000-7000-8000-00000000c302';
      const answerId = '01910000-0000-7000-8000-00000000c303';
      const startedAt = Date.now() - 3_000;
      const provenance = { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } };
      const itemProvenance = (itemId: string) => ({
        originThreadId: threadId,
        originTurnId: turnId,
        originItemId: itemId,
      });
      const items = [
        {
          id: userId,
          type: 'userMessage',
          author: { kind: 'reader' },
          provenance: itemProvenance(userId),
          clientId: null,
          acceptedAt: startedAt,
          content: [{ type: 'text', text: 'Hello again.' }],
        },
        {
          id: answerId,
          type: 'agentMessage',
          provenance: itemProvenance(answerId),
          text: 'Hello, I am here. What would you like to work through?',
          phase: 'final_answer',
          memoryCitation: null,
        },
      ];
      const execution = {
        modelProvider: 'openai',
        model: 'openai/gpt-5.4',
        reasoningEffort: 'medium',
        diagnosticsRef: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items,
          itemsView: 'full',
          provenance,
          status: 'inProgress',
          error: null,
          execution,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { execution, items, provenance, startedAt, threadId, turnId };
    });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    const answer = turn.locator('.thread-agent-message-body');
    const transcript = page.locator('.thread-transcript');
    await expect(turn.getByLabel('Assistant is responding')).toBeVisible();
    await expect(answer).toContainText('Hello, I am here.');
    await expect(turn.locator('.thread-process-timeline')).toHaveCount(0);
    await expect(turn.locator('.thread-user-message .thread-message-actions')).toHaveCount(0);
    await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await answer.locator('p').evaluate((element) => { element.dataset.identityProbe = 'stable'; });

    const measure = () => turn.evaluate((element) => {
      const answerBody = element.querySelector<HTMLElement>('.thread-agent-message-body');
      const footer = element.querySelector<HTMLElement>('.thread-response-footer');
      const processTitle = element.querySelector<HTMLElement>('.thread-process-title');
      const scroller = element.closest('.thread-transcript');
      if (!answerBody || !footer || !processTitle || !(scroller instanceof HTMLElement)) {
        throw new Error('Expected stable Turn geometry elements');
      }
      const turnRect = element.getBoundingClientRect();
      const answerRect = answerBody.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const titleRect = processTitle.getBoundingClientRect();
      return {
        answerOffset: answerRect.top - turnRect.top,
        answerTop: answerRect.top,
        bottomGap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        footerHeight: footerRect.height,
        titleToAnswer: answerRect.top - titleRect.bottom,
      };
    });
    const before = await measure();

    await page.evaluate((value) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const completedAt = Date.now();
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: value.threadId,
        turnId: value.turnId,
        turn: {
          id: value.turnId,
          items: value.items,
          itemsView: 'full',
          provenance: value.provenance,
          status: 'completed',
          error: null,
          execution: value.execution,
          startedAt: value.startedAt,
          completedAt,
          durationMs: completedAt - value.startedAt,
        },
      });
    }, fixture);

    await expect(turn.getByLabel('Assistant is responding')).toHaveCount(0);
    await expect(turn.locator('.thread-process-title')).toHaveText('Worked for 3s');
    await expect(turn.locator('.thread-user-message .thread-message-actions').getByRole('button')).toHaveCount(2);
    await expect(turn.locator('.thread-response-actions').getByRole('button')).toHaveCount(3);
    await expect(answer.locator('p')).toHaveAttribute('data-identity-probe', 'stable');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => (
      requestAnimationFrame(() => resolve())
    ))));
    const after = await measure();

    expect(Math.abs(before.answerOffset - after.answerOffset)).toBeLessThan(1);
    expect(Math.abs(before.answerTop - after.answerTop)).toBeLessThan(1);
    expect(Math.abs(before.footerHeight - after.footerHeight)).toBeLessThan(1);
    expect(before.bottomGap).toBeLessThan(1);
    expect(after.bottomGap).toBeLessThan(1);
    // The summary names the answer from one line above it, and completing the
    // Turn does not respace them.
    expect(Math.abs(before.titleToAnswer - after.titleToAnswer)).toBeLessThan(1);
  });

  test('forks history without changing the source Thread', async ({ page }) => {
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Keep this history.');
    await page.getByRole('button', { name: 'Send' }).click();

    const turn = page.locator('.thread-turn').first();
    await turn.hover();
    await turn.getByRole('button', { name: 'Continue in new chat' }).click();

    await expect(page.locator('.thread-turn')).toHaveCount(1);
    await expect(page.locator('.thread-user-message')).toContainText('Keep this history.');
    await page.getByRole('button', { name: 'Show Threads' }).click();

    const rows = page.locator('.thread-list-row');
    await expect(rows).toHaveCount(2);
    let selectedFork = page.locator('.thread-list-row.is-selected');
    await expect(selectedFork).toContainText('Keep this history. (1)');

    await page.keyboard.press('Escape');
    await page.locator('.thread-turn').first().hover();
    await page.locator('.thread-turn').first().getByRole('button', { name: 'Continue in new chat' }).click();
    await page.getByRole('button', { name: 'Show Threads' }).click();
    selectedFork = page.locator('.thread-list-row.is-selected');
    await expect(selectedFork).toContainText('Keep this history. (2)');
    await expect(page.locator('.thread-list-row')).toHaveCount(3);
    expect((await commandCalls(page)).map((call) => call.cmd)).toContain('thread/fork');
  });

  test('keeps the established keyboard contract when editing a user message', async ({ page }) => {
    await createNewThread(page);
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Original request');
    await page.getByRole('button', { name: 'Send' }).click();
    const userMessage = page.locator('.thread-user-message').first();

    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Edit message' }).click();
    const editor = userMessage.getByRole('textbox', { name: 'Edit message' });
    await expect(editor).toBeFocused();
    await editor.fill('Discard this edit');
    await editor.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(userMessage).toContainText('Original request');

    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Edit message' }).click();
    const savedEditor = userMessage.getByRole('textbox', { name: 'Edit message' });
    await savedEditor.fill('Revised request');
    await savedEditor.press('Control+Enter');

    await expect(page.locator('.thread-user-message').last()).toContainText('Revised request');
    const calls = await commandCalls(page);
    expect(calls.filter((call) => call.cmd === 'thread/rollback').at(-1)?.args).toEqual({
      threadId: expect.any(String),
      numTurns: 1,
    });
    expect(calls.filter((call) => call.cmd === 'thread/fork')).toHaveLength(0);
  });

  test('offers Edit only on the latest user message', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('First request');
    await page.getByRole('button', { name: 'Send' }).click();
    await composer.fill('Latest request');
    await page.getByRole('button', { name: 'Send' }).click();

    const messages = page.locator('.thread-user-message');
    await expect(messages).toHaveCount(2);
    await messages.first().hover();
    await expect(messages.first().getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    await expect(messages.first().getByRole('button', { name: 'Copy message' })).toBeVisible();
    await messages.last().hover();
    await expect(messages.last().getByRole('button', { name: 'Edit message' })).toBeVisible();
  });

  test('recalls reader input by visual boundary and restores scratch selection and working copies', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('First request');
    await page.getByRole('button', { name: 'Send' }).click();
    await composer.fill('Second request');
    await page.getByRole('button', { name: 'Send' }).click();

    await composer.fill('scratch draft');
    await composer.evaluate((element) => {
      const text = element.querySelector('p')?.firstChild;
      if (!text) throw new Error('Composer text node was not found');
      (element as HTMLElement).focus();
      const range = document.createRange();
      range.setStart(text, 4);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Second request');
    await composer.fill('Second request edited');
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('First request');
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('First request');
    await composer.press('ArrowDown');
    await expect(composer).toHaveText('Second request edited');
    await composer.press('ArrowDown');
    await expect(composer).toHaveText('scratch draft');
    expect(await composer.evaluate(() => window.getSelection()?.anchorOffset)).toBe(4);
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Second request edited');
    await composer.press('ArrowDown');
    await expect(composer).toHaveText('scratch draft');
    expect(await composer.evaluate(() => window.getSelection()?.anchorOffset)).toBe(4);
    await composer.fill('scratch draft edited');
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Second request edited');
    await composer.press('ArrowDown');
    await expect(composer).toHaveText('scratch draft edited');

    const wrappedDraft = Array.from({ length: 80 }, () => 'soft wrap').join(' ');
    await composer.fill(wrappedDraft);
    const wrappedPrevented = await composer.evaluate((element) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowUp' });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(wrappedPrevented).toBe(false);
    await expect(composer).toHaveText(wrappedDraft);
    const modifiedPrevented = await composer.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowUp',
        shiftKey: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(modifiedPrevented).toBe(false);
    await expect(composer).toHaveText(wrappedDraft);

    await composer.fill('@');
    await expect(page.getByRole('listbox')).toBeVisible();
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('@');
    await composer.press('Escape');

    await composer.fill('IME draft');
    const imePrevented = await composer.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key: 'ArrowUp',
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(imePrevented).toBe(false);
    await expect(composer).toHaveText('IME draft');
  });

  test('uses canonical Item authors for transcript trust and reader history', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c101';
      const authors = [
        { author: { kind: 'feature', feature: 'automation', ref: 'run-1' }, text: 'Automation input' },
        { author: { kind: 'host' }, text: 'Host input' },
        { author: { kind: 'reader' }, text: 'Reader input' },
      ];
      const provenance = (originItemId: string) => ({ threadId, turnId, originItemId });
      const items = authors.map((entry, index) => {
        const id = `01910000-0000-7000-8000-${String(0xc102 + index).padStart(12, '0')}`;
        return {
          id,
          type: 'userMessage',
          author: entry.author,
          provenance: {
            originThreadId: provenance(id).threadId,
            originTurnId: provenance(id).turnId,
            originItemId: provenance(id).originItemId,
          },
          clientId: null,
          acceptedAt: index + 1,
          content: [{ type: 'text', text: entry.text }],
        };
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items,
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 10,
          durationMs: 9,
        },
      });
      return { threadId, turnId };
    });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    await expect(turn.locator('.thread-user-message.thread-host-event')).toHaveCount(3);
    await expect(turn.locator('.thread-user-message:not(.thread-host-event)')).toHaveText('Reader input');
    const hostEvent = turn.locator('.thread-user-message.thread-host-event').last();
    await hostEvent.hover();
    await expect(hostEvent.getByRole('button', { name: 'Edit message' })).toHaveCount(0);

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.focus();
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Reader input');
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Reader input');
  });

  test('recalls structured input with fresh attachment identity and resubmits it as active-Turn steering', async ({ page }) => {
    await openMockedApp(page, { agentTurnStaysActive: true });
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Compare ');
    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send to Agent' }).click();
    await composer.pressSequentially(' with ');
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'history.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('history attachment'),
    });
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
    await page.getByRole('button', { name: 'Send' }).click();

    const firstSubmit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    const firstAttachment = (firstSubmit?.args.input as Array<{
      id?: string;
      source?: { kind?: string; ref?: Record<string, unknown> };
      type?: string;
    }>).find((part) => part.type === 'attachment');
    expect(firstAttachment?.id).toBeTruthy();
    const attachmentOperationsBeforeRecall = (await commandCalls(page)).filter((call) => (
      call.cmd.startsWith('attachment-upload/')
    )).length;

    await composer.focus();
    await composer.press('ArrowUp');
    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(2);
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
    await expect(composer).toContainText('Compare');
    await expect(composer).toContainText('Alpha');
    await expect(composer).toContainText('history.txt');
    await expect(page.getByRole('button', { name: 'Steer' })).toBeVisible();
    await page.getByRole('button', { name: 'Steer' }).click();

    const submits = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit');
    expect(submits).toHaveLength(2);
    const secondInput = submits[1]?.args.input as Array<{
      id?: string;
      nodeId?: string;
      source?: { kind?: string; ref?: Record<string, unknown> };
      type?: string;
    }>;
    const secondAttachment = secondInput.find((part) => part.type === 'attachment');
    expect(secondInput.map((part) => part.type)).toEqual(['text', 'nodeReference', 'text', 'attachment']);
    expect(secondInput.find((part) => part.type === 'nodeReference')?.nodeId).toBe(ids.alpha);
    expect(secondAttachment?.id).not.toBe(firstAttachment?.id);
    expect(secondAttachment?.source?.ref).toEqual(firstAttachment?.source?.ref);
    expect((await commandCalls(page)).filter((call) => call.cmd.startsWith('attachment-upload/')))
      .toHaveLength(attachmentOperationsBeforeRecall);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'thread/rollback')).toHaveLength(0);
  });

  test('retains an image preview after recalled input is accepted as active-Turn steering', async ({ page }) => {
    await openMockedApp(page, { agentTurnStaysActive: true });
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Inspect this image');
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'active-history.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    const thumbnail = page.locator('.thread-composer-attachment-thumbnail');
    await expect(thumbnail).toBeVisible();
    const admittedPreviewUrl = await thumbnail.getAttribute('src');
    expect(admittedPreviewUrl).toMatch(/^blob:/u);

    await page.getByRole('button', { name: 'Send' }).click();
    await composer.focus();
    await composer.press('ArrowUp');
    await expect(thumbnail).toHaveAttribute('src', admittedPreviewUrl!);
    await composer.pressSequentially(' steered');
    await page.getByRole('button', { name: 'Steer' }).click();
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').length
    )).toBe(2);

    await composer.focus();
    await composer.press('ArrowUp');
    await expect(composer).toContainText('Inspect this image');
    await expect(composer).toContainText('steered');
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute('src', admittedPreviewUrl!);
  });

  test('retains a session-known image preview when attachment history is recalled', async ({ page }) => {
    await openMockedApp(page);
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Remember this image');
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'history.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    const thumbnail = page.locator('.thread-composer-attachment-thumbnail');
    await expect(thumbnail).toBeVisible();
    const admittedPreviewUrl = await thumbnail.getAttribute('src');
    expect(admittedPreviewUrl).toMatch(/^blob:/u);

    await page.getByRole('button', { name: 'Send' }).click();
    const attachmentOperationsBeforeRecall = (await commandCalls(page)).filter((call) => (
      call.cmd.startsWith('attachment-upload/')
    )).length;
    await composer.focus();
    await composer.press('ArrowUp');

    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute('src', admittedPreviewUrl!);
    await composer.pressSequentially(' edited');
    await composer.press('ArrowDown');
    await expect(composer).toHaveText('');
    await expect(thumbnail).toHaveCount(0);
    await composer.press('ArrowUp');
    await expect(composer).toContainText('Remember this image');
    await expect(composer).toContainText(' edited');
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute('src', admittedPreviewUrl!);
    expect((await commandCalls(page)).filter((call) => call.cmd.startsWith('attachment-upload/')))
      .toHaveLength(attachmentOperationsBeforeRecall);
  });

  test('moves past an attachment-bearing recalled entry with one further Up press', async ({ page }) => {
    await page.setViewportSize({ width: 1_120, height: 820 });
    await openMockedApp(page);
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Older request');
    await page.getByRole('button', { name: 'Send' }).click();
    await composer.fill('Newest image request');
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'history.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await page.getByRole('button', { name: 'Send' }).click();

    await composer.focus();
    await composer.press('ArrowUp');
    await expect(composer).toContainText('Newest image request');
    await expect(page.locator('.thread-composer-attachment-thumbnail')).toBeVisible();
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Older request');
  });

  test('leaves arrows native during attachment admission and retains the hidden scratch resource', async ({ page }) => {
    await openMockedApp(page, { attachmentUploadDelayMs: 200 });
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Historical request');
    await page.getByRole('button', { name: 'Send' }).click();

    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'pending-history.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('pending history attachment'),
    });
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin').length
    )).toBe(1);
    await composer.focus();
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('');

    await expect(page.locator('.thread-composer-inline-ref[data-thread-file-ref]'))
      .toContainText('pending-history.txt');
    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Historical request');
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(0);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'attachment-resource/discard')).toHaveLength(0);

    await composer.press('ArrowDown');
    await expect(page.locator('.thread-composer-inline-ref[data-thread-file-ref]'))
      .toContainText('pending-history.txt');
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'attachment-resource/discard')).toHaveLength(0);

    await composer.press('ArrowUp');
    await expect(composer).toHaveText('Historical request');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'attachment-resource/discard').length
    )).toBe(1);
  });

  test('restores a rejected recalled structured bundle with its exact selection', async ({ page }) => {
    await openMockedApp(page, { agentTurnSubmitReject: 'Mock recalled send rejection' });
    await createNewThread(page);
    await page.evaluate(async (nodeId) => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c201';
      const userItemId = '01910000-0000-7000-8000-00000000c202';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: userItemId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: userItemId },
            clientId: null,
            acceptedAt: 1,
            content: [
              { type: 'text', text: 'Review ' },
              { type: 'nodeReference', nodeId, note: 'Alpha' },
              { type: 'text', text: ' with ' },
              {
                type: 'attachment',
                id: 'canonical-history-attachment',
                name: 'recalled.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                source: {
                  kind: 'resource',
                  ref: {
                    id: 'a'.repeat(64),
                    mimeType: 'text/plain',
                    byteLength: 12,
                    fileName: 'recalled.txt',
                  },
                },
              },
            ],
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    }, ids.alpha);

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.focus();
    await composer.press('ArrowUp');
    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(2);
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
    await composer.evaluate((element) => {
      const text = element.querySelector('p')?.firstChild;
      if (!text) throw new Error('Composer text node was not found');
      (element as HTMLElement).focus();
      const range = document.createRange();
      range.setStart(text, 3);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('status')).toContainText('Mock recalled send rejection');
    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(2);
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
    expect(await composer.evaluate(() => window.getSelection()?.anchorOffset)).toBe(3);
    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect((submit?.args.input as Array<{ type?: string }>).map((part) => part.type))
      .toEqual(['text', 'nodeReference', 'text', 'attachment']);
  });

  test('sends an Outliner Node to the Thread as structured input', async ({ page }) => {
    await createNewThread(page);
    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send to Agent' }).click();

    await expect(page.locator('.thread-composer-inline-ref')).toContainText('Alpha');
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([{
      type: 'nodeReference',
      nodeId: ids.alpha,
      note: 'Alpha',
    }]);
  });

  test('preserves inline content order when text surrounds a Node reference', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Before ');
    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send to Agent' }).click();
    await composer.pressSequentially('after');
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([
      { type: 'text', text: 'Before ' },
      { type: 'nodeReference', nodeId: ids.alpha, note: 'Alpha' },
      { type: 'text', text: ' after' },
    ]);
    const userMessage = page.locator('.thread-user-message').last();
    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe('Before Alpha after');
  });

  test('keeps same-named files from distinct sources and accepts a regular file above the former shared limit', async ({ page }) => {
    await createNewThread(page);
    const fileInput = page.locator('.thread-composer-file-input');
    await fileInput.setInputFiles({
      name: 'report.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('first'),
    });
    await fileInput.setInputFiles({
      name: 'report.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('other'),
    });
    await fileInput.setInputFiles({
      name: 'archive.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(FORMER_SHARED_ATTACHMENT_LIMIT_BYTES + 1),
    });

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(3);
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    const input = submit?.args.input as Array<{
      name?: string;
      sizeBytes?: number;
      source?: { kind?: string; ref?: { id?: string } };
      type?: string;
    }>;
    const reports = input.filter((part) => part.type === 'attachment' && part.name === 'report.bin');
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((part) => part.source?.ref?.id)).size).toBe(2);
    expect(input).toContainEqual(expect.objectContaining({
      type: 'attachment',
      name: 'archive.bin',
      sizeBytes: FORMER_SHARED_ATTACHMENT_LIMIT_BYTES + 1,
    }));
  });

  test('skips a pathless file that is already attached by content identity', async ({ page }) => {
    await createNewThread(page);
    const fileInput = page.locator('.thread-composer-file-input');
    const file = {
      name: 'duplicate.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('same content'),
    };
    await fileInput.setInputFiles(file);
    await fileInput.setInputFiles(file);

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(1);
    await expect(page.getByRole('status')).toContainText("Skipped 1 file that's already attached.");
  });

  test('rejects Office ownership files before they enter the composer', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: '.~Quarterly review.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: Buffer.from('ownership metadata'),
    });

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(
      '.~Quarterly review.pptx is a temporary Office ownership file. Choose the original document instead.',
    );
    expect((await commandCalls(page)).filter((call) => call.cmd.startsWith('attachment-upload/'))).toHaveLength(0);
  });

  test('serializes overlapping attachment batches at the composer limit', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.thread-composer-file-input');
      if (!input) throw new Error('Composer file input was not found');
      const dispatchBatch = (prefix: string) => {
        const transfer = new DataTransfer();
        for (let index = 0; index < 12; index += 1) {
          transfer.items.add(new File([`${prefix}-${index}`], `${prefix}-${index}.txt`, { type: 'text/plain' }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      dispatchBatch('first');
      dispatchBatch('second');
    });

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(20);
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(20);
    await expect(page.getByRole('status')).toContainText('Skipped 4 files over the 20 attachment limit.');
    expect((await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin')).toHaveLength(20);
    await page.locator('.app').evaluate((element) => {
      (element as HTMLElement).style.setProperty('--agent-width', '280px');
    });
    const trayGeometry = await page.locator('.thread-composer-attachment-tray').evaluate((tray) => {
      tray.scrollLeft = 0;
      const items = Array.from(tray.querySelectorAll<HTMLElement>('.thread-composer-attachment-item'));
      const trayRect = tray.getBoundingClientRect();
      const surfaceRect = tray.closest<HTMLElement>('.thread-composer-surface')?.getBoundingClientRect();
      const first = items[0]?.getBoundingClientRect();
      const second = items[1]?.getBoundingClientRect();
      return {
        clientWidth: tray.clientWidth,
        clipRadius: getComputedStyle(tray).borderTopRightRadius,
        edgeShadow: getComputedStyle(tray.parentElement!, '::after').boxShadow,
        firstHeight: first?.height ?? 0,
        heightDelta: first ? Math.abs(trayRect.height - first.height) : Number.POSITIVE_INFINITY,
        horizontalInsetDelta: first && surfaceRect
          ? Math.abs((first.left - surfaceRect.left) - (surfaceRect.right - trayRect.right))
          : Number.POSITIVE_INFINITY,
        firstWidth: first?.width ?? 0,
        itemGap: first && second ? second.left - first.right : 0,
        rowTops: new Set(items.map((item) => Math.round(item.getBoundingClientRect().top))).size,
        scrollWidth: tray.scrollWidth,
        secondVisible: second ? Math.max(0, Math.min(trayRect.right, second.right) - Math.max(trayRect.left, second.left)) : 0,
      };
    });
    expect(trayGeometry.rowTops).toBe(1);
    expect(trayGeometry.clipRadius).toBe('0px');
    expect(trayGeometry.edgeShadow).not.toBe('none');
    expect(trayGeometry.firstHeight).toBeGreaterThanOrEqual(108);
    expect(trayGeometry.heightDelta).toBeLessThan(1);
    expect(trayGeometry.horizontalInsetDelta).toBeLessThan(1);
    expect(trayGeometry.firstWidth).toBeGreaterThanOrEqual(170);
    expect(trayGeometry.itemGap).toBeGreaterThanOrEqual(8);
    expect(trayGeometry.secondVisible).toBeGreaterThan(24);
    expect(trayGeometry.scrollWidth).toBeGreaterThan(trayGeometry.clientWidth);
    await expect(page.getByRole('button', { name: 'Show more attachments' })).toBeVisible();
    const edgeInsets = await page.getByRole('button', { name: 'Show more attachments' }).evaluate((edge) => {
      const surface = edge.closest<HTMLElement>('.thread-composer-surface');
      const first = surface?.querySelector<HTMLElement>('.thread-composer-attachment-item');
      if (!surface || !first) return null;
      const surfaceRect = surface.getBoundingClientRect();
      return {
        card: first.getBoundingClientRect().left - surfaceRect.left,
        edge: surfaceRect.right - edge.getBoundingClientRect().right,
      };
    });
    expect(edgeInsets).not.toBeNull();
    expect(edgeInsets!.edge).toBeGreaterThan(edgeInsets!.card);
  });

  test('limits images independently from the message attachment budget', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles(Array.from({ length: 12 }, (_, index) => ({
      name: `image-${index + 1}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(`image-${index + 1}`),
    })));

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(10);
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(10);
    await expect(page.getByRole('status')).toContainText('Skipped 2 images over the 10 image limit.');
  });

  test('allows a large paste to replace an attachment at the composer limit', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles(Array.from({ length: 20 }, (_, index) => ({
      name: `limit-${index + 1}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`limit attachment ${index + 1}`),
    })));

    const markers = page.locator('.thread-composer-inline-ref[data-thread-file-ref]');
    await expect(markers).toHaveCount(20);
    await markers.first().evaluate((element) => {
      const range = document.createRange();
      range.selectNode(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      (element.closest('[role="textbox"]') as HTMLElement | null)?.focus();
    });
    await pasteComposerText(page, 'replacement at attachment limit\n'.repeat(5_000));

    await expect(markers).toHaveCount(20);
    await expect(markers.filter({ hasText: 'Pasted.txt' })).toHaveCount(1);
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(20);
    await expect(page.getByRole('status').filter({ hasText: '20 attachment limit' })).toHaveCount(0);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin')).toHaveLength(21);
  });

  test('converts a large plain-text paste into a managed attachment at its marker position', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Before ');
    const pastedText = `large pasted body\nsecond preview line\tthird preview line\n${'x'.repeat(4 * 1024)}`;
    await pasteComposerText(page, pastedText);

    const marker = page.locator('.thread-composer-inline-ref[data-thread-file-ref]');
    await expect(marker).toContainText('Pasted.txt');
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
    const excerpt = page.locator('.thread-composer-attachment-excerpt');
    await expect(excerpt).toContainText('large pasted body second preview line third preview line');
    expect(await excerpt.textContent()).not.toMatch(/\s{2,}/u);
    const insetDelta = await page.locator('.thread-composer-attachment-item').evaluate((card) => {
      const surface = card.closest<HTMLElement>('.thread-composer-surface');
      if (!surface) return Number.POSITIVE_INFINITY;
      const cardRect = card.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      return Math.abs((cardRect.top - surfaceRect.top) - (cardRect.left - surfaceRect.left));
    });
    expect(insetDelta).toBeLessThan(1);
    expect(await composer.textContent()).not.toContain('x'.repeat(1_000));
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([
      { type: 'text', text: 'Before' },
      expect.objectContaining({
        type: 'attachment',
        id: expect.any(String),
        name: 'Pasted.txt',
        mimeType: 'text/plain',
        source: expect.objectContaining({ kind: 'resource' }),
      }),
    ]);
    expect(JSON.stringify(submit?.args.input)).not.toContain('extractedText');
  });

  test('keeps rapid identical large-text pastes as separate attachments', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.focus();
    const pastedText = `repeated large paste\n${'x'.repeat(4 * 1024)}`;
    await pasteComposerText(page, pastedText);
    await pasteComposerText(page, pastedText);

    const markers = page.locator('.thread-composer-inline-ref[data-thread-file-ref]');
    await expect(markers).toHaveCount(2);
    await expect(markers.nth(0)).toContainText('Pasted.txt');
    await expect(markers.nth(1)).toContainText('Pasted-2.txt');
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(2);
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    const attachments = (submit?.args.input as Array<{
      id?: string;
      name?: string;
      source?: { kind?: string; ref?: { id?: string } };
      type?: string;
    }>).filter((part) => part.type === 'attachment');
    expect(attachments.map((attachment) => attachment.name)).toEqual([
      'Pasted.txt',
      'Pasted-2.txt',
    ]);
    expect(new Set(attachments.map((attachment) => attachment.id)).size).toBe(2);
    expect(new Set(attachments.map((attachment) => attachment.source?.ref?.id)).size).toBe(1);
  });

  test('links attachment-block removal preview and deletion to the inline marker', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'linked.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('linked attachment'),
    });
    const marker = page.locator('.thread-composer-inline-ref[data-thread-file-ref]');
    const remove = page.getByRole('button', { name: 'Remove linked.txt and message reference' });
    await expect(marker).toHaveCount(1);
    await remove.hover();
    await expect(marker).toHaveClass(/is-removal-preview/);
    const removeInset = await remove.evaluate((button) => {
      const card = button.closest<HTMLElement>('.thread-composer-attachment-item');
      if (!card) return null;
      const buttonRect = button.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      return {
        right: cardRect.right - buttonRect.right,
        top: buttonRect.top - cardRect.top,
      };
    });
    expect(removeInset).not.toBeNull();
    expect(removeInset!.right).toBeGreaterThanOrEqual(6);
    expect(Math.abs(removeInset!.right - removeInset!.top)).toBeLessThan(1);
    await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.getByRole('textbox', { name: 'Message this Thread' }).hover();
    await expect(marker).not.toHaveClass(/is-removal-preview/);
    await remove.focus();
    await expect(marker).toHaveClass(/is-removal-preview/);
    await remove.press('Escape');
    await expect(marker).not.toHaveClass(/is-removal-preview/);
    await remove.click();
    await expect(marker).toHaveCount(0);
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(0);
  });

  test('opens attachment cards on click without showing a redundant hover preview', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'preview.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Composer attachment preview'),
    });

    const card = page.getByRole('button', { name: 'Preview preview.md' });
    await expect(card).not.toHaveAttribute('title');
    const item = card.locator('xpath=..');
    const restBorderWidth = await item.evaluate((element) => getComputedStyle(element).borderTopWidth);
    await card.hover();
    await page.waitForTimeout(550);
    await expect(item).toHaveCSS('border-top-width', restBorderWidth);
    await expect(page.locator('[data-inline-file-preview]')).toHaveCount(0);

    await card.click();
    await expect(page.locator('.outline-panel-surface.active-panel.is-file-preview'))
      .toContainText('Mock preview text.');
  });

  test('preserves a directory selected from the composer mention menu', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('@');
    await page.getByRole('option', { name: /workspace.*mock\/local-root/i }).click();

    const directoryRef = page.locator('.thread-composer-inline-ref[data-inline-ref-entry-kind="directory"]');
    await expect(directoryRef).toContainText('workspace');
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([expect.objectContaining({
      type: 'attachment',
      name: 'workspace',
      mimeType: 'inode/directory',
      sizeBytes: 0,
      source: { kind: 'localFile', path: '/mock/local-root/workspace' },
    })]);
  });

  test('renders one leading image gallery and keeps every file reference in message order', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ac01';
      const itemId = '01910000-0000-7000-8000-00000000ac02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
            clientId: null,
            acceptedAt: 1,
            content: [
              { type: 'text', text: 'Before' },
              {
                type: 'attachment',
                id: 'document-attachment',
                name: 'agenda.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 12,
                source: { kind: 'localFile', path: '/mock/local-root/agenda.pdf' },
              },
              { type: 'text', text: 'middle' },
              ...Array.from({ length: 6 }, (_, index) => ({
                type: 'attachment' as const,
                id: `image-attachment-${index + 1}`,
                name: `reference-${index + 1}.png`,
                mimeType: 'image/png',
                sizeBytes: 68,
                source: { kind: 'localFile' as const, path: `/mock/local-root/reference-${index + 1}.png` },
              })),
              { type: 'text', text: 'After' },
            ],
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });

    const message = page.locator('.thread-user-message').last();
    const sequence = message.locator('.thread-user-content-sequence');
    const bubbles = sequence.locator(':scope > .thread-user-content-shell');
    const gallery = sequence.locator(':scope > .thread-image-gallery');
    await expect(sequence.locator(':scope > *')).toHaveCount(2);
    await expect(bubbles).toHaveCount(1);
    await expect(bubbles.locator('.thread-user-inline-content')).toContainText(
      'Beforeagenda.pdfmiddlereference-1.png reference-2.png reference-3.png reference-4.png reference-5.png reference-6.pngAfter',
    );
    await expect(gallery).toHaveAccessibleName('6 images');
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(4);
    await expect(gallery.locator('.thread-image-gallery-preview').first()).toHaveAccessibleName('reference-1.png');
    await expect(gallery.locator('.thread-image-gallery-preview img').first()).toHaveAttribute('alt', 'reference-1.png');
    await expect(message.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    const showAll = gallery.getByRole('button', { name: 'Show all 6 images' });
    await expect(showAll).toHaveText('+2');
    await expect(showAll).toHaveAttribute('aria-expanded', 'false');
    expect(await sequence.evaluate((element) => Array.from(element.children).map((child) => child.className))).toEqual([
      'thread-image-gallery',
      'thread-user-content-shell',
    ]);
    const narrative = bubbles.locator('.thread-user-inline-content');
    const inlineFlow = await narrative.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        overflowWrap: style.overflowWrap,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(inlineFlow).toEqual({
      overflowWrap: 'anywhere',
      whiteSpace: 'pre-wrap',
    });
    await expect(narrative.locator('.thread-message-file-ref')).toHaveText([
      'agenda.pdf',
      'reference-1.png',
      'reference-2.png',
      'reference-3.png',
      'reference-4.png',
      'reference-5.png',
      'reference-6.png',
    ]);
    expect(await narrative.locator('.thread-message-file-ref').evaluateAll((references) => (
      references.map((reference) => reference.getAttribute('data-inline-ref-path'))
    ))).toEqual([
      '/mock/local-root/agenda.pdf',
      '/mock/local-root/reference-1.png',
      '/mock/local-root/reference-2.png',
      '/mock/local-root/reference-3.png',
      '/mock/local-root/reference-4.png',
      '/mock/local-root/reference-5.png',
      '/mock/local-root/reference-6.png',
    ]);
    const imageReferenceTops = await narrative.locator('.thread-message-file-ref').evaluateAll((references) => (
      references.slice(1).map((reference) => Math.round(reference.getBoundingClientRect().top))
    ));
    expect(new Set(imageReferenceTops).size).toBeLessThan(imageReferenceTops.length);
    expect(await narrative.evaluate((element) => Array.from(element.children).map((child) => ({
      className: child.className,
      text: child.textContent,
    })))).toEqual([
      { className: '', text: 'Before' },
      { className: 'inline-ref thread-message-file-ref', text: 'agenda.pdf' },
      { className: '', text: 'middle' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-1.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-2.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-3.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-4.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-5.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-6.png' },
      { className: '', text: 'After' },
    ]);
    await message.hover();
    await message.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe(
      'Beforeagenda.pdfmiddlereference-1.png reference-2.png reference-3.png reference-4.png reference-5.png reference-6.pngAfter',
    );

    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(showAll, gallery);
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(6);
    await expect(gallery).toHaveAttribute('data-layout-count', 'many');
    await expect(showAll).toHaveCount(0);
    const showFewer = gallery.getByRole('button', { name: 'Show fewer images' });
    await expect(showFewer).toBeVisible();
    await toggleDisclosureWithStableAnchor(showFewer, gallery);
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(4);
    await expect(gallery).toHaveAttribute('data-layout-count', '4');
    await expect(gallery.getByRole('button', { name: 'Show all 6 images' })).toBeVisible();

    await page.setViewportSize({ width: 420, height: 760 });
    await expect(gallery).toBeInViewport();
    const overflowBadge = gallery.getByRole('button', { name: 'Show all 6 images' });
    const readOverflowContrast = () => overflowBadge.evaluate((element) => {
      const buttonStyle = getComputedStyle(element);
      return {
        background: buttonStyle.backgroundColor,
        backdropFilter: buttonStyle.backdropFilter,
        foreground: buttonStyle.color,
        reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      };
    });
    const expectResolvedOverflowContrast = async (reducedTransparency: boolean) => {
      const expected = {
        background: await resolveTokenColor(page, '--media-hud-bg'),
        backdropFilter: 'none',
        foreground: await resolveTokenColor(page, '--media-hud-fg'),
        reducedTransparency,
      };
      await expect.poll(readOverflowContrast, {
        message: `Overflow badge contrast did not settle for reducedTransparency=${reducedTransparency}`,
      }).toEqual(expected);
      return expected;
    };

    await emulateVisualMedia(page, { colorScheme: 'dark', reducedTransparency: 'no-preference' });
    const standardContrast = await expectResolvedOverflowContrast(false);

    await emulateVisualMedia(page, { colorScheme: 'dark', reducedTransparency: 'reduce' });
    const reducedContrast = await expectResolvedOverflowContrast(true);
    expect(reducedContrast.background).not.toBe(standardContrast.background);
    const reducedInteractionBackgrounds = {
      hover: await resolveTokenColor(page, '--media-hud-hover-bg'),
      active: await resolveTokenColor(page, '--media-hud-active-bg'),
    };

    await emulateVisualMedia(page, { colorScheme: 'dark', reducedTransparency: 'no-preference' });
    const interactionBackgrounds = {
      hover: await resolveTokenColor(page, '--media-hud-hover-bg'),
      active: await resolveTokenColor(page, '--media-hud-active-bg'),
    };
    expect(interactionBackgrounds.hover).not.toBe(reducedInteractionBackgrounds.hover);
    expect(interactionBackgrounds.active).not.toBe(reducedInteractionBackgrounds.active);

    const overflowGeometry = await gallery.getByRole('button', { name: 'Show all 6 images' }).evaluate((element) => {
      const tile = element.closest('.thread-image-gallery-tile');
      if (!tile) throw new Error('Overflow badge tile was not found');
      const buttonRect = element.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      const tileStyle = getComputedStyle(tile);
      const cornerInset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-4'));
      return {
        areaRatio: (buttonRect.width * buttonRect.height) / (tileRect.width * tileRect.height),
        rightInset: tileRect.right - buttonRect.right,
        bottomInset: tileRect.bottom - buttonRect.bottom,
        expectedRightInset: cornerInset + Number.parseFloat(tileStyle.borderRightWidth),
        expectedBottomInset: cornerInset + Number.parseFloat(tileStyle.borderBottomWidth),
      };
    });
    expect(overflowGeometry.areaRatio).toBeLessThan(0.25);
    expect(overflowGeometry.rightInset).toBe(overflowGeometry.expectedRightInset);
    expect(overflowGeometry.bottomInset).toBe(overflowGeometry.expectedBottomInset);
    await overflowBadge.hover();
    await expect(overflowBadge).toHaveCSS('background-color', interactionBackgrounds.hover);
    await page.mouse.down();
    await expect(overflowBadge).toHaveCSS('background-color', interactionBackgrounds.active);
    await page.mouse.up();
  });

  test('keeps a native selected image as a canonical local-file reference', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('@');
    await page.getByRole('option', { name: /reference\.png.*mock\/local-root/i }).click();

    const imageRef = page.locator('.thread-composer-inline-ref[data-inline-ref-path="/mock/local-root/reference.png"]');
    await expect(imageRef).toContainText('reference.png');
    await expect(imageRef).toHaveAttribute('data-inline-ref-thumbnail-data-url', /^data:image\/png;base64,/);
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([expect.objectContaining({
      type: 'attachment',
      name: 'reference.png',
      mimeType: 'image/png',
      source: { kind: 'localFile', path: '/mock/local-root/reference.png' },
    })]);
  });

  test('does not reject an image at the renderer boundary because it exceeds the former shared limit', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'large-source.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(FORMER_SHARED_ATTACHMENT_LIMIT_BYTES + 1),
    });

    await expect(page.locator('.thread-composer-inline-ref')).toContainText('large-source.png');
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('streams a pathless image in bounded chunks and records only a managed reference', async ({ page }) => {
    await createNewThread(page);
    const originalSize = 2 * 1024 * 1024 + 123;
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'noise.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(originalSize, 7),
    });

    const imageRef = page.locator('.thread-composer-inline-ref');
    await expect(imageRef).toContainText('noise.png');
    await expect(imageRef).toHaveAttribute('data-inline-ref-thumbnail-data-url', /^blob:/);
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    const attachment = (submit?.args.input as Array<{
      mimeType?: string;
      sizeBytes?: number;
      source?: { kind?: string; ref?: { byteLength?: number; mimeType?: string } };
    }>)[0];
    expect(attachment?.mimeType).toBe('image/png');
    expect(attachment?.sizeBytes).toBe(originalSize);
    expect(attachment?.source).toMatchObject({
      kind: 'resource',
      ref: { byteLength: originalSize, mimeType: 'image/png' },
    });
    const chunks = (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/append');
    const chunkSizes = chunks.map((call) => Number(call.args.byteLength));
    expect(chunkSizes.every((size) => (
      Number.isInteger(size) && size > 0 && size <= ATTACHMENT_UPLOAD_CHUNK_BYTES
    ))).toBe(true);
    expect(chunkSizes.reduce((total, size) => total + size, 0)).toBe(originalSize);
  });

  test('discards an unsent managed resource when its composer reference is removed', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'draft.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('draft payload'),
    });
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await expect(page.locator('.thread-composer-inline-ref')).toContainText('draft.bin');

    await composer.focus();
    await composer.press('End');
    await composer.press('Backspace');
    await composer.press('Backspace');

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(0);
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'attachment-resource/discard').length
    )).toBe(1);
  });

  test('retains measured long-message disclosure behavior', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Line 1');
    for (let line = 2; line <= 9; line += 1) {
      await composer.press('Shift+Enter');
      await composer.pressSequentially(`Line ${line}`);
    }
    await page.getByRole('button', { name: 'Send' }).click();

    const disclosure = page.getByRole('button', { name: 'Show more' });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('restores composer focus when the Agent rail reopens', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });

    await page.getByRole('button', { name: 'Collapse agent' }).click();
    await page.getByRole('button', { name: 'Expand agent' }).click();

    await expect(composer).toBeFocused();
  });

  test('retains the established full-bleed composer geometry', async ({ page }) => {
    await createNewThread(page);
    const metrics = await page.locator('.thread-view').evaluate((view) => {
      const dock = view.closest('.thread-dock');
      const composer = view.querySelector('.thread-composer-region');
      const surface = view.querySelector('.thread-composer-surface');
      const editor = view.querySelector('.thread-composer-editor');
      const editorText = editor?.querySelector('.ProseMirror');
      const attachment = surface?.querySelector('.icon-button-composerTool');
      const action = surface?.querySelector('.icon-button-composerAction');
      if (!(dock instanceof HTMLElement)
        || !(composer instanceof HTMLElement)
        || !(surface instanceof HTMLElement)
        || !(editor instanceof HTMLElement)
        || !(editorText instanceof HTMLElement)
        || !(attachment instanceof HTMLElement)
        || !(action instanceof HTMLElement)) return null;
      const viewBox = view.getBoundingClientRect();
      const dockBox = dock.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      const editorBox = editor.getBoundingClientRect();
      const editorTextBox = editorText.getBoundingClientRect();
      const attachmentBox = attachment.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      const surfaceStyle = getComputedStyle(surface);
      const attachmentStyle = getComputedStyle(attachment);
      const actionStyle = getComputedStyle(action);
      return {
        actionBottomInset: surfaceBox.bottom - actionBox.bottom,
        actionRadius: Number.parseFloat(actionStyle.borderTopLeftRadius),
        actionRightInset: surfaceBox.right - actionBox.right,
        actionSize: actionBox.width,
        attachmentBottomInset: surfaceBox.bottom - attachmentBox.bottom,
        attachmentLeftInset: attachmentBox.left - surfaceBox.left,
        attachmentRadius: Number.parseFloat(attachmentStyle.borderTopLeftRadius),
        attachmentSize: attachmentBox.width,
        composerBottomDelta: Math.abs(viewBox.bottom - composerBox.bottom),
        editorLeftInset: editorBox.left - surfaceBox.left,
        editorRightInset: surfaceBox.right - editorBox.right,
        editorTextLeftInset: editorTextBox.left - surfaceBox.left,
        editorTextRightInset: surfaceBox.right - editorTextBox.right,
        surfaceBottomDelta: Math.abs(viewBox.bottom - surfaceBox.bottom),
        surfaceLeftInset: surfaceBox.left - dockBox.left,
        surfacePaddingBottom: Number.parseFloat(surfaceStyle.paddingBottom),
        surfacePaddingLeft: Number.parseFloat(surfaceStyle.paddingLeft),
        surfacePaddingRight: Number.parseFloat(surfaceStyle.paddingRight),
        surfaceRightInset: dockBox.right - surfaceBox.right,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.composerBottomDelta).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceBottomDelta).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceLeftInset).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceRightInset).toBeLessThanOrEqual(1);
    expect(metrics!.surfacePaddingLeft).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.surfacePaddingBottom).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.actionSize).toBe(metrics!.attachmentSize);
    expect(metrics!.actionRadius).toBeGreaterThanOrEqual(metrics!.actionSize / 2);
    expect(metrics!.attachmentRadius).toBeGreaterThanOrEqual(metrics!.attachmentSize / 2);
    expect(Math.abs(metrics!.attachmentLeftInset - metrics!.surfacePaddingLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentBottomInset - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset - metrics!.surfacePaddingRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionBottomInset - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(metrics!.editorLeftInset).toBeLessThanOrEqual(1);
    expect(metrics!.editorRightInset).toBeLessThanOrEqual(1);
    expect(metrics!.editorTextLeftInset).toBe(metrics!.editorTextRightInset);
    expect(metrics!.editorTextLeftInset).toBeGreaterThanOrEqual(metrics!.surfacePaddingLeft);
  });

  test('reuses the composer slash menu for directly invocable Skills', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('/');

    const menu = page.getByRole('listbox', { name: 'Thread slash commands' });
    await expect(menu.getByRole('option', { name: /compact/ })).toContainText('Replace earlier context with a durable summary');
    await expect(menu.getByRole('option', { name: /clear/ })).toContainText('Start a new context epoch without deleting history');
    const skill = menu.getByRole('option', { name: /workspace-review/ });
    await expect(skill).toContainText('Review workspace conventions before automatic use.');
    await skill.click();

    await expect(composer).toHaveText('/workspace-review ');
    await expect(composer).toBeFocused();
    expect((await commandCalls(page)).filter((call) => call.cmd === 'agent_list_all_skills').at(-1)?.args)
      .toMatchObject({ userInvocableOnly: true });
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`renders context boundaries and reset affinity in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await createNewThread(page);
      const composer = page.getByRole('textbox', { name: 'Message this Thread' });
      await composer.fill('Establish context before reset.');
      await page.getByRole('button', { name: 'Send' }).click();

      const fixture = await page.evaluate(async () => {
        const target = window as Window & {
          lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        const threadResponse = await target.lin!.agentCoreRequest<{
          data: Array<{ id: string }>;
        }>('thread/list', {});
        const threadId = threadResponse.data[0]?.id;
        if (!threadId) throw new Error('Mock Thread not found');
        const turnsResponse = await target.lin!.agentCoreRequest<{
          data: Array<{ id: string; items: Array<{ id: string }> }>;
        }>('thread/turns/list', { threadId, itemsView: 'full' });
        const prior = turnsResponse.data.at(-1);
        const clearedItem = prior?.items.at(-1);
        if (!prior || !clearedItem) throw new Error('Mock prior Turn not found');
        const resetTurnId = '01910000-0000-7000-8000-00000000fc01';
        const resetItemId = '01910000-0000-7000-8000-00000000fc02';
        const epochTurnId = '01910000-0000-7000-8000-00000000fc03';
        const epochUserItemId = '01910000-0000-7000-8000-00000000fc04';
        const epochAgentItemId = '01910000-0000-7000-8000-00000000fc05';
        const compactionTurnId = '01910000-0000-7000-8000-00000000fc06';
        const compactionItemId = '01910000-0000-7000-8000-00000000fc07';
        const execution = {
          modelProvider: 'openai',
          model: 'openai/gpt-5.4',
          reasoningEffort: 'medium',
          diagnosticsRef: null,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: null,
          },
        };
        const emitTurn = (turn: unknown, turnId: string) => target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId,
          turnId,
          turn,
        });
        emitTurn({
          id: resetTurnId,
          items: [{
            id: resetItemId,
            type: 'contextReset',
            provenance: { originThreadId: threadId, originTurnId: resetTurnId, originItemId: resetItemId },
            clearedThrough: { turnId: prior.id, itemId: clearedItem.id },
          }],
          itemsView: 'full',
          provenance: {
            originThreadId: threadId,
            originTurnId: resetTurnId,
            trigger: { kind: 'feature', feature: 'context.clear', ref: 'e2e-clear' },
          },
          status: 'completed',
          error: null,
          execution,
          startedAt: 100,
          completedAt: 101,
          durationMs: 1,
        }, resetTurnId);

        const epochItemProvenance = (itemId: string) => ({
          originThreadId: threadId,
          originTurnId: epochTurnId,
          originItemId: itemId,
        });
        emitTurn({
          id: epochTurnId,
          items: [
            {
              id: epochUserItemId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: epochItemProvenance(epochUserItemId),
              clientId: null,
              acceptedAt: 102,
              content: [{ type: 'text', text: 'Establish context after reset.' }],
            },
            {
              id: epochAgentItemId,
              type: 'agentMessage',
              provenance: epochItemProvenance(epochAgentItemId),
              text: 'The new context epoch is active.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: {
            originThreadId: threadId,
            originTurnId: epochTurnId,
            trigger: { kind: 'user' },
          },
          status: 'completed',
          error: null,
          execution,
          startedAt: 102,
          completedAt: 103,
          durationMs: 1,
        }, epochTurnId);

        const summaryRef = {
          id: 'a'.repeat(64),
          mimeType: 'application/vnd.tenon.agent-context+json',
          byteLength: 100,
          schemaVersion: 1,
          kind: 'compactionSummary',
        };
        const restoredStateRef = {
          id: 'b'.repeat(64),
          mimeType: 'application/vnd.tenon.agent-context+json',
          byteLength: 100,
          schemaVersion: 1,
          kind: 'compactionRestoredState',
        };
        emitTurn({
          id: compactionTurnId,
          items: [{
            id: compactionItemId,
            type: 'contextCompaction',
            provenance: {
              originThreadId: threadId,
              originTurnId: compactionTurnId,
              originItemId: compactionItemId,
            },
            trigger: 'manual',
            coveredFrom: { turnId: epochTurnId, itemId: epochUserItemId },
            coveredThrough: { turnId: epochTurnId, itemId: epochAgentItemId },
            preservedFrom: null,
            summaryRef,
            restoredStateRef,
            instructionsRef: null,
            contextRefs: [],
            resourceRefs: [],
            outputRefs: [],
          }],
          itemsView: 'full',
          provenance: {
            originThreadId: threadId,
            originTurnId: compactionTurnId,
            trigger: { kind: 'feature', feature: 'context.compact', ref: 'e2e-compact' },
          },
          status: 'completed',
          error: null,
          execution,
          startedAt: 104,
          completedAt: 105,
          durationMs: 1,
        }, compactionTurnId);
        return { compactionTurnId, resetItemId };
      });

      const boundaries = page.locator('.thread-compaction');
      await expect(boundaries).toHaveText(['Context cleared.', 'Context compacted.']);
      await expect(boundaries.last()).toBeInViewport();
      const transcript = page.locator('.thread-transcript');
      await expect.poll(() => transcript.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
        .toBe(colorScheme === 'dark');

      const compactionTurn = page.locator(`[data-thread-turn-row="${fixture.compactionTurnId}"]`);
      await expect(compactionTurn.getByRole('button', { name: 'Copy message' })).toHaveCount(0);
      await expect(compactionTurn.getByRole('button', { name: 'Continue in new chat' })).toHaveCount(0);
      await compactionTurn.hover();
      await compactionTurn.getByRole('button', { name: 'Open Trajectory' }).click();
      const trajectory = page.locator('.outline-panel-surface.is-thread-trajectory');
      await expect(trajectory).toContainText('Trajectory');
      await expect(trajectory.locator('[data-kind="compaction"]')).toContainText('Compacted');
      await expect(trajectory.locator('.thread-trajectory-inspector')).toContainText('No retained evidence.');
      await expect.poll(() => trajectory.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    });
  }

  test('keeps Thread actions in an anchored keyboard menu', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 620 });
    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    const trigger = page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-row.is-selected')
      .getByRole('button', { name: 'Thread actions' });
    await trigger.click();

    const menu = page.getByRole('menu', { name: 'Thread actions' });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(760);
    expect(box!.y + box!.height).toBeLessThanOrEqual(620);
    await expect(menu.getByRole('menuitem', { name: 'Thread Details' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Rename Thread' })).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  // The menu's width is a constant the anchoring math needs, so a label that
  // outgrows it cannot widen the menu — it wrapped under the icon before, and
  // ellipsizes now. Both are the same defect at the point a label is written,
  // which is where this fails.
  test('fits every action label on one line', async ({ page }) => {
    await openSelectedThreadActions(page);
    await expect(page.getByRole('menu', { name: 'Thread actions' })).toBeVisible();

    const items = await page.locator('.thread-action-menu button').evaluateAll((buttons) => buttons.map((button) => {
      const label = button.querySelector('.thread-action-menu-label');
      return {
        text: label?.textContent ?? '',
        height: button.getBoundingClientRect().height,
        overflow: label ? label.scrollWidth - label.clientWidth : 0,
      };
    }));

    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.text, 'every item routes its label through the ellipsizing span').not.toBe('');
      expect(item.overflow, `"${item.text}" is truncated`).toBeLessThanOrEqual(0);
      expect(item.height, `"${item.text}" wrapped to a second line`).toBeLessThanOrEqual(32);
      // The key list below is hand-written, and nothing typechecks this file, so
      // a rename that updates the component and the messages leaves it stale and
      // silently measuring one string fewer. What the menu actually rendered has
      // to be in the set, or the set is not the set.
      expect(ACTION_MENU_LABELS, `"${item.text}" is rendered but never measured`).toContain(item.text);
    }

    for (const key of ACTION_MENU_LABEL_KEYS) {
      expect(en.agent.thread, `no en label for "${key}" — the key list is stale`).toHaveProperty(key);
    }

    // What the menu renders is one locale's answer to one records state: the
    // mock always reports `recorded: true`, so "Show in Recall", the failure
    // label, and every zh-Hans label are never on screen to be measured. Feed
    // each through a real label element instead — same font, same box, same
    // available width — so the guard covers the strings rather than the run.
    const measured = await page.locator('.thread-action-menu-label').first()
      .evaluate((label, labels) => {
        const rendered = label.textContent;
        const widths = labels.map((text) => {
          label.textContent = text;
          return { text, overflow: label.scrollWidth - label.clientWidth };
        });
        label.textContent = rendered;
        return widths;
      }, ACTION_MENU_LABELS);

    // No count assertion here: `measured` is `ACTION_MENU_LABELS.map(...)`, so
    // any comparison between the two is true by construction. What keeps the set
    // complete is the strict `en` read where it is built, which fails to
    // compile rather than at runtime.
    for (const label of measured) {
      expect(label.overflow, `"${label.text}" does not fit the menu`).toBeLessThanOrEqual(0);
    }
  });

  test('renames and deletes a Thread through in-app dialogs', async ({ page }) => {
    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Rename Thread' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename Thread' });
    await renameDialog.getByRole('textbox', { name: 'Rename Thread' }).fill('Research notes');
    await renameDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.thread-dock-title')).toContainText('Research notes');

    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Delete Thread' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete Thread' });
    await expect(deleteDialog).toContainText('Research notes');
    await deleteDialog.getByRole('button', { name: 'Delete Thread' }).click();

    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    await expect(page.locator('.thread-dock-title')).toContainText('Untitled Thread');
    await expect(page.locator('.thread-empty-state')).toHaveCount(0);
    const calls = (await commandCalls(page)).map((call) => call.cmd);
    expect(calls).toEqual(expect.arrayContaining(['thread/name/set', 'thread/delete']));
    expect(calls.filter((command) => command === 'thread/start')).toHaveLength(2);
  });

  test('changes the canonical Thread model and reasoning from the composer', async ({ page }) => {
    await createNewThread(page);

    const control = page.getByRole('button', { name: 'Model and reasoning' });
    await expect(control).toContainText('GPT-5.4');
    await expect(control).toContainText('Medium');
    await control.click();
    await page.getByRole('menu', { name: 'Model and reasoning' })
      .getByRole('menuitem', { name: 'GPT-5.4' })
      .click();
    await page.getByRole('menu', { name: 'Model', exact: true })
      .getByRole('menuitemradio', { name: 'GPT-5.4 Mini' })
      .click();
    await expect(control).toContainText('GPT-5.4 Mini');

    await control.click();
    await page.getByRole('menu', { name: 'Model and reasoning' })
      .getByRole('menuitem', { name: /Reasoning/ })
      .click();
    await page.getByRole('menu', { name: 'Reasoning' })
      .getByRole('menuitemradio', { name: 'High' })
      .click();
    await expect(control).toContainText('High');

    const updates = (await commandCalls(page)).filter((call) => call.cmd === 'thread/configuration/set');
    expect(updates.map((call) => call.args)).toEqual([
      expect.objectContaining({
        modelProvider: 'openai',
        model: 'openai/gpt-5.4-mini',
        reasoningEffort: 'medium',
      }),
      expect.objectContaining({
        modelProvider: 'openai',
        model: 'openai/gpt-5.4-mini',
        reasoningEffort: 'high',
      }),
    ]);

    await control.click();
    await expect(page.getByRole('menu', { name: 'Model and reasoning' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Model and reasoning' })).toHaveCount(0);
    await expect(control).toBeFocused();
  });

  test('returns a pinned Thread to the connection\'s newest model without changing provider', async ({ page }) => {
    await createNewThread(page);

    const control = page.getByRole('button', { name: 'Model and reasoning' });
    const openModelList = async () => {
      await control.click();
      await page.getByRole('menu', { name: 'Model and reasoning' })
        .getByRole('menuitem', { name: /GPT-5\.4/ })
        .click();
      return page.getByRole('menu', { name: 'Model', exact: true });
    };

    // Pinning is what used to be a one-way door: the menu offered only concrete
    // models, so a Thread could never be handed back to "whatever is newest".
    await (await openModelList()).getByRole('menuitemradio', { name: 'GPT-5.4 Mini' }).click();
    await expect(control).toContainText('GPT-5.4 Mini');

    const alwaysNewest = (await openModelList()).getByRole('menuitemradio', { name: /Always newest/ });
    await expect(alwaysNewest).toHaveAttribute('aria-checked', 'false');
    // The row names what selecting it switches TO — the head — not the model
    // currently pinned, which is what it would advertise if it read the resolved
    // option while pinned.
    await expect(alwaysNewest).not.toContainText('Mini');
    await alwaysNewest.click();
    // The pill keeps naming the model that will run — now the ranked head again.
    // Asserted as an exclusion too: 'GPT-5.4' is a substring of 'GPT-5.4 Mini',
    // so containment alone would pass without the pill ever updating.
    await expect(control).not.toContainText('Mini');
    await expect(control).toContainText('GPT-5.4');

    const restored = (await openModelList()).getByRole('menuitemradio', { name: /Always newest/ });
    await expect(restored).toHaveAttribute('aria-checked', 'true');
    // Floating must not read as a pin to the model it happens to resolve to.
    await expect(
      page.getByRole('menu', { name: 'Model', exact: true })
        .getByRole('menuitemradio', { name: 'GPT-5.4', exact: true }),
    ).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    const updates = (await commandCalls(page)).filter((call) => call.cmd === 'thread/configuration/set');
    expect(updates.map((call) => call.args)).toEqual([
      expect.objectContaining({ modelProvider: 'openai', model: 'openai/gpt-5.4-mini' }),
      // Only the model field moves; the connection is left exactly as it was.
      expect.objectContaining({ modelProvider: 'openai', model: 'inherit' }),
    ]);
  });

  test('retains the anchored Thread list dismissal and row-action interactions', async ({ page }) => {
    await createNewThread(page);
    const listButton = page.getByRole('button', { name: 'Show Threads' });
    await listButton.click();

    const list = page.getByRole('dialog', { name: 'Threads' });
    const row = list.locator('.thread-list-row:not(.is-selected)').first();
    const selectedRow = list.locator('.thread-list-row.is-selected');
    await expect(list).toBeVisible();
    await expect(selectedRow.locator('.thread-list-actions')).toHaveCSS('opacity', '1');
    await expect(row.locator('.thread-list-actions')).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(row.locator('.thread-list-actions')).toHaveCSS('opacity', '1');
    await expect(row.locator('.thread-list-actions').getByRole('button')).toHaveAttribute('aria-label', 'Thread actions');
    await expect(row.locator('small')).not.toContainText('user');

    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(listButton).toBeFocused();

    await listButton.click();
    await page.locator('.thread-transcript').click({ position: { x: 12, y: 180 } });
    await expect(list).toHaveCount(0);
  });

  test('refreshes provider gating without discarding the composer draft', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Keep this draft.');

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: {
          invoke: <T>(command: string, input?: Record<string, unknown>) => Promise<T>;
          notifySettingsChanged?: () => Promise<void>;
        };
      };
      await target.lin?.invoke('agent_delete_provider_config', { providerId: 'openai' });
      await target.lin?.notifySettingsChanged?.();
    });

    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute('title', 'Configure an AI provider before starting a Thread.');
    await expect(page.getByRole('button', { name: 'Add attachment' })).toBeDisabled();
    await expect(composer).toHaveText('Keep this draft.');
  });

  test('presents, stops, inspects, and clears generic background Tool Tasks', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock root Thread not found');
      const now = Date.now();
      const task = (input: Record<string, unknown>) => ({
        taskId: input.taskId,
        ownerThreadId: threadId,
        sourceTurnId: '01910000-0000-7000-8000-00000000ed01',
        sourceItemId: String(input.taskId),
        producer: 'bash',
        description: input.description,
        state: input.state,
        deliveryState: input.deliveryState ?? 'pending',
        progress: input.progress ?? null,
        exitCode: input.exitCode ?? null,
        signal: null,
        outcomeReason: input.outcomeReason ?? null,
        error: input.error ?? null,
        detailState: input.detailState ?? 'available',
        artifacts: [],
        artifactWarnings: [],
        outputBytes: input.outputBytes ?? 0,
        detailBytes: input.detailBytes ?? 0,
        storagePressure: input.storagePressure ?? null,
        startedAt: input.startedAt ?? now,
        completedAt: input.completedAt ?? null,
        deliveryTurnId: input.deliveryTurnId ?? null,
      });
      const running = task({
        taskId: 'task-e2e-running',
        description: 'Render preview',
        state: 'running',
        progress: { phase: 'render', message: 'Frame 12', fraction: 0.5, updatedAt: now },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'toolTask/changed', threadId, task: running });
      return { threadId, now };
    });

    const pill = page.locator('.thread-work-strip-pill');
    await expect(pill).toHaveText('1 running');
    await pill.click();
    const runningRow = page.locator('.thread-tool-task-row').filter({ hasText: 'Render preview' });
    await expect(runningRow).toContainText('Frame 12');
    await runningRow.locator('.thread-work-strip-open').click();
    await expect(runningRow.locator('.thread-tool-task-output')).toHaveText('Mock background output');
    await runningRow.getByRole('button', { name: 'Stop Render preview' }).click();
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'task/stop').at(-1)?.args
    )).toEqual({ threadId: fixture.threadId, taskId: 'task-e2e-running' });
    await expect(runningRow).toContainText('Cancelled');

    await page.evaluate(({ threadId, now }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const base = {
        ownerThreadId: threadId,
        sourceTurnId: '01910000-0000-7000-8000-00000000ed01',
        producer: 'video',
        progress: null,
        signal: null,
        artifacts: [],
        artifactWarnings: [],
        startedAt: now + 1,
        completedAt: Date.now(),
      };
      const reclaimable = {
        ...base,
        taskId: 'task-e2e-reclaimable',
        sourceItemId: 'task-e2e-reclaimable',
        description: 'Earlier export',
        state: 'succeeded',
        deliveryState: 'delivered',
        exitCode: 0,
        outcomeReason: 'exit_zero',
        error: null,
        detailState: 'available',
        outputBytes: 256,
        detailBytes: 256,
        storagePressure: null,
        deliveryTurnId: '01910000-0000-7000-8000-00000000ed02',
      };
      const pressured = {
        ...base,
        taskId: 'task-e2e-pressure',
        sourceItemId: 'task-e2e-pressure',
        description: 'Large export',
        state: 'failed',
        deliveryState: 'pending',
        exitCode: null,
        outcomeReason: 'storage_limit',
        error: 'Not enough managed task storage.',
        detailState: 'storage_pressure',
        outputBytes: 0,
        detailBytes: 0,
        storagePressure: {
          scope: 'thread',
          limitBytes: 1_024,
          usedBytes: 1_024,
          requiredBytes: 512,
          reclaimableBytes: 256,
          protectedBytes: 768,
        },
        deliveryTurnId: null,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'toolTask/changed', threadId, task: reclaimable });
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'toolTask/changed', threadId, task: pressured });
    }, fixture);

    const pressureRow = page.locator('.thread-tool-task-row').filter({ hasText: 'Large export' });
    await pressureRow.locator('.thread-work-strip-open').click();
    await expect(pressureRow.locator('.thread-tool-task-pressure')).toContainText('512 B');
    await pressureRow.getByRole('button', { name: 'Clear eligible details' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear delivered task details?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear eligible details' }).click();
    await expect(pressureRow.locator('.thread-tool-task-pressure')).toContainText('256 B cleared');
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'task/details/clear').length
    )).toBe(1);
  });
  for (const colorScheme of ['light', 'dark'] as const) {
  }

  test('renders reasoning and grouped tool Items with disclosure and copy interactions', async ({ page }) => {
    await createNewThread(page);
    await seedOverflowingTranscript(page);
    await page.evaluate(async (nodeId) => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000aa01';
      const item = (suffix: string) => `01910000-0000-7000-8000-00000000${suffix}`;
      const provenance = (itemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: itemId });
      const reasoningId = item('aa02');
      const commandId = item('aa03');
      const toolId = item('aa04');
      const summaryOnlyReasoningId = item('aa05');
      const answerId = item('aa06');
      const turn = {
        id: turnId,
        items: [
          {
            id: reasoningId,
            type: 'reasoning',
            provenance: provenance(reasoningId),
            summary: ['Inspect the current workspace'],
            content: ['The workspace has enough evidence.'],
          },
          {
            id: commandId,
            type: 'commandExecution',
            provenance: provenance(commandId),
            command: 'pwd',
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'bash' },
              providerName: 'bash',
              arguments: { storage: 'inline', value: { command: 'pwd' } },
              schemaDigest: '0'.repeat(64),
            },
            cwd: '/mock/workspace',
            processId: null,
            status: 'completed',
            commandActions: [],
            aggregatedOutput: '/mock/workspace',
            exitCode: 0,
            durationMs: 4,
          },
          {
            id: toolId,
            type: 'dynamicToolCall',
            provenance: provenance(toolId),
            namespace: null,
            tool: 'file_read',
            arguments: { file_path: 'notes with spaces.md' },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'file_read' },
              providerName: 'file_read',
              arguments: {
                storage: 'inline',
                value: { file_path: 'notes with spaces.md' },
              },
              schemaDigest: '0'.repeat(64),
            },
            status: 'completed',
            contentItems: [{ type: 'json', value: { title: 'Alpha' } }],
            success: true,
            durationMs: 8,
          },
          {
            id: summaryOnlyReasoningId,
            type: 'reasoning',
            provenance: provenance(summaryOnlyReasoningId),
            summary: [],
            content: ['Preparing the final response'],
          },
          {
            id: answerId,
            type: 'agentMessage',
            provenance: provenance(answerId),
            text: 'Finished with evidence.',
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 13,
        durationMs: 12,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn,
      });
    }, ids.alpha);

    const process = page.getByRole('button', { name: 'Worked for <1s' });
    await expect(process).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(process);
    await expect(process).toHaveAttribute('aria-expanded', 'true');
    await toggleDisclosureWithStableAnchor(process);
    await expect(process).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(process);
    await expect(process).toHaveAttribute('aria-expanded', 'true');

    const thought = page.locator('.thread-reasoning-toggle').first();
    await expect(thought).toBeVisible();
    await expect(thought).toHaveAccessibleName('Inspect the current workspace');
    await expect(thought.locator('.thread-reasoning-summary')).toHaveCSS('font-weight', '400');
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
    const thoughtChevron = thought.locator('.thread-reasoning-chevron');
    await expect(thoughtChevron).toHaveCSS('opacity', '0');
    const activity = page.getByRole('button', { name: /^Ran a command · read / });
    const [thoughtBox, activityBox] = await Promise.all([thought.boundingBox(), activity.boundingBox()]);
    expect(thoughtBox).toBeTruthy();
    expect(activityBox).toBeTruthy();
    expect(Math.abs(thoughtBox!.x - activityBox!.x)).toBeLessThan(1);
    await thought.hover();
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    expect(await thought.boundingBox()).toEqual(thoughtBox);
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(thought);
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    const reasoningBody = page.locator('.thread-reasoning-body');
    await expect(reasoningBody).toContainText('The workspace has enough evidence.');
    await expect(reasoningBody).not.toContainText('Inspect the current workspace');
    await expect(reasoningBody.locator('p')).toHaveCount(1);
    const [thoughtHeadlineBox, reasoningBodyBox] = await Promise.all([
      thought.locator('.thread-reasoning-summary').boundingBox(),
      reasoningBody.boundingBox(),
    ]);
    expect(thoughtHeadlineBox).toBeTruthy();
    expect(reasoningBodyBox).toBeTruthy();
    expect(Math.abs(thoughtHeadlineBox!.x - reasoningBodyBox!.x)).toBeLessThan(1);
    await toggleDisclosureWithStableAnchor(thought);
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(thought);
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    const singleLineThought = page.locator('.thread-reasoning-summary', {
      hasText: 'Preparing the final response',
    });
    await expect(singleLineThought).toHaveCount(1);
    expect(await singleLineThought.evaluate((element) => element.parentElement?.tagName)).toBe('DIV');
    await expect(singleLineThought.locator('xpath=..').locator('.thread-reasoning-chevron')).toHaveCount(0);
    await expect(page.getByText('Thought', { exact: true })).toHaveCount(0);

    const activityStatus = activity.locator('.thread-disclosure-status');
    const activityChevron = activity.locator('.thread-disclosure-chevron');
    await expect(activityStatus).toHaveCSS('opacity', '1');
    await expect(activityChevron).toHaveCSS('opacity', '0');
    await activity.hover();
    await expect(activityStatus).toHaveCSS('opacity', '0');
    await expect(activityChevron).toHaveCSS('opacity', '1');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(activity);
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    await toggleDisclosureWithStableAnchor(activity);
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(activity);
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    const command = page.getByRole('button', { name: /Ran.*pwd/ });
    await expect(command).toBeVisible();
    const commandAlignment = await command.evaluate((element) => {
      const icon = element.querySelector<HTMLElement>('.thread-disclosure-status svg');
      const label = element.querySelector<HTMLElement>('.thread-tool-label');
      if (!icon || !label) return null;
      const iconBox = icon.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
      return Math.abs((iconBox.top + iconBox.height / 2) - (labelBox.top + lineHeight / 2));
    });
    expect(commandAlignment).not.toBeNull();
    expect(commandAlignment!).toBeLessThan(1);
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(command);
    await expect(command.locator('xpath=..')).not.toContainText('exit 0');
    await expect(command.locator('xpath=..').getByRole('button', { name: 'Copy output' })).toHaveCount(1);
    await toggleDisclosureWithStableAnchor(command);
    await expect(command).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(command);
    await expect(command).toHaveAttribute('aria-expanded', 'true');
    await command.locator('xpath=..').locator('.thread-tool-section').last().locator('.agent-code-block').hover();
    await page.getByRole('button', { name: 'Copy output' }).click();
    expect(await clipboardText(page)).toBe('/mock/workspace');

    const commandPaths = command.locator('xpath=..').locator('.thread-tool-path-reference');
    await expect(commandPaths).toHaveCount(1);
    await expect(commandPaths).toHaveAttribute('data-tool-path', '/mock/workspace');
    const nodeTool = page.getByRole('button', { name: /^Read / });
    await nodeTool.click();
    const relativePath = nodeTool.locator('xpath=..').locator('.thread-tool-path-reference');
    await expect(relativePath).toHaveAttribute('data-tool-path', '/mock/workspace/notes with spaces.md');
    await expect(relativePath).toHaveAttribute('data-inline-ref-kind', 'local-file');
    await expect(relativePath).toHaveAttribute('data-inline-ref-path', '/mock/workspace/notes with spaces.md');
    await expect(relativePath).toHaveAttribute('data-inline-ref-entry-kind', 'file');
    await expect(relativePath).toHaveAttribute('title', 'notes with spaces.md');
    await expect(relativePath).not.toHaveAttribute('aria-label', /.+/);
    await expect(relativePath).not.toHaveClass(/inline-ref/);
    await expect(relativePath.locator('.inline-ref-file-icon')).toHaveCount(0);
    await expect(relativePath).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(relativePath).toHaveCSS('cursor', 'auto');
    await expect(relativePath).toHaveCSS('white-space', 'pre');

    const panels = page.locator('.outline-panel-surface');
    const panelCount = await panels.count();
    await relativePath.click();
    await expect(panels).toHaveCount(panelCount);
    await expect(page.locator('.outline-panel-surface.is-file-preview')).toHaveCount(0);

    await relativePath.focus();
    await page.keyboard.press('Enter');
    await expect(panels).toHaveCount(panelCount);
    await expect(page.locator('.outline-panel-surface.active-panel.is-file-preview'))
      .toContainText('Mock preview text.');

    await relativePath.hover();
    await page.keyboard.down('Meta');
    await expect(page.locator('html')).toHaveClass(/is-primary-modifier-pressed/);
    await expect(relativePath).toHaveCSS('cursor', 'pointer');
    await expect(relativePath).toHaveCSS('text-decoration-line', 'underline');
    await page.keyboard.up('Meta');
    await expect(page.locator('html')).not.toHaveClass(/is-primary-modifier-pressed/);
    await expect(relativePath).toHaveCSS('cursor', 'auto');

    await relativePath.click({ modifiers: ['Meta'] });
    await expect(panels).toHaveCount(panelCount + 1);
    await expect(page.locator('.outline-panel-surface.active-panel.is-file-preview'))
      .toContainText('Mock preview text.');

    await page.locator('[data-thread-turn-row="01910000-0000-7000-8000-00000000aa01"]')
      .getByRole('button', { name: 'Copy message' })
      .click();
    expect(await clipboardText(page)).toBe([
      '```tool bash',
      JSON.stringify({ command: 'pwd' }, null, 2),
      '```',
      '',
      '```tool-result',
      '/mock/workspace',
      '```',
      '',
      '```tool file_read',
      JSON.stringify({ file_path: 'notes with spaces.md' }, null, 2),
      '```',
      '',
      '```tool-result',
      JSON.stringify({ title: 'Alpha' }, null, 2),
      '```',
      '',
      'Finished with evidence.',
    ].join('\n'));

    const disclosureOverrides = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((candidate) => (
        candidate.startsWith('tenon:thread-disclosure:v1:')
      ));
      return key ? JSON.parse(window.localStorage.getItem(key) ?? '{}') : {};
    });
    expect(disclosureOverrides).toMatchObject({
      'process:01910000-0000-7000-8000-00000000aa01': true,
      'reasoning:01910000-0000-7000-8000-00000000aa02': true,
      'tool:01910000-0000-7000-8000-00000000aa03': true,
      'tools:01910000-0000-7000-8000-00000000aa03': true,
    });
  });

  test('groups tools across empty commentary and spaces a truncated reasoning line', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000af01';
      const itemId = (suffix: string) => `01910000-0000-7000-8000-00000000${suffix}`;
      const provenance = (originItemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId });
      const webSearch = (id: string, query: string) => ({
        id,
        type: 'webSearch',
        provenance: provenance(id),
        query,
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'web_search' },
          providerName: 'web_search',
          arguments: { storage: 'inline', value: { query } },
          schemaDigest: '0'.repeat(64),
        },
        results: [{ title: 'Forecast', url: 'https://example.com/weather', snippet: 'Rain' }],
        status: 'completed',
        error: null,
      });
      const webFetch = (id: string, url: string) => ({
        id,
        type: 'dynamicToolCall',
        provenance: provenance(id),
        namespace: null,
        tool: 'web_fetch',
        arguments: { url },
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'web_fetch' },
          providerName: 'web_fetch',
          arguments: { storage: 'inline', value: { url } },
          schemaDigest: '0'.repeat(64),
        },
        status: 'completed',
        outputRef: null,
        contentItems: [{ type: 'text', text: 'Forecast loaded' }],
        success: true,
        durationMs: 4,
      });
      const emptyCommentary = (id: string) => ({
        id,
        type: 'agentMessage',
        provenance: provenance(id),
        text: '',
        phase: 'commentary',
        memoryCitation: null,
      });
      const reasoningId = itemId('af06');
      const answerId = itemId('af10');
      const reasoningText = [
        'Planning an additional official NMC search with enough detail to exceed the compact timeline width',
        'while preserving the complete reasoning text when the disclosure is opened',
      ].join(' ');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            webSearch(itemId('af02'), 'Chengdu weather August 5'),
            emptyCommentary(itemId('af03')),
            webFetch(itemId('af04'), 'https://weather.example.com/chengdu'),
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: provenance(reasoningId),
              summary: [reasoningText],
              content: [],
            },
            webSearch(itemId('af07'), 'Chengdu NMC forecast'),
            emptyCommentary(itemId('af08')),
            webFetch(itemId('af09'), 'https://www.nmc.cn/chengdu'),
            {
              id: answerId,
              type: 'agentMessage',
              provenance: provenance(answerId),
              text: 'Rain is expected today.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 36_001,
          durationMs: 36_000,
        },
      });
      return { reasoningText, turnId };
    });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    await turn.getByRole('button', { name: 'Worked for 36s' }).click();
    const summary = turn.locator('.thread-reasoning-summary', {
      hasText: fixture.reasoningText,
    });
    await expect(summary).toHaveCount(1);
    await expect(turn.locator('.thread-tool-activity-toggle')).toHaveCount(2);
    await expect(turn.locator('.thread-tool-toggle')).toHaveCount(0);
    await expect(turn.locator('.thread-agent-message-commentary')).toHaveCount(0);
    await expect(turn.getByText('Thought', { exact: true })).toHaveCount(0);

    const rhythm = await summary.evaluate((element) => {
      const reasoning = element.closest<HTMLElement>('.thread-reasoning');
      const timeline = reasoning?.parentElement;
      const previousTool = reasoning?.previousElementSibling
        ?.querySelector<HTMLElement>('.thread-tool-activity-toggle');
      const nextTool = reasoning?.nextElementSibling
        ?.querySelector<HTMLElement>('.thread-tool-activity-toggle');
      if (!reasoning || !timeline || !previousTool || !nextTool) {
        throw new Error('Missing split web timeline rhythm elements');
      }
      const expected = Number.parseFloat(getComputedStyle(timeline).rowGap);
      const previousRect = previousTool.getBoundingClientRect();
      const reasoningRect = reasoning.getBoundingClientRect();
      const nextRect = nextTool.getBoundingClientRect();
      return {
        above: reasoningRect.top - previousRect.bottom,
        below: nextRect.top - reasoningRect.bottom,
        expected,
      };
    });
    expect(rhythm.expected).toBeGreaterThan(0);
    expect(Math.abs(rhythm.above - rhythm.expected)).toBeLessThan(1);
    expect(Math.abs(rhythm.below - rhythm.expected)).toBeLessThan(1);
    expect(Math.abs(rhythm.above - rhythm.below)).toBeLessThan(1);

    const reasoningToggle = summary.locator('xpath=..');
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false');
    expect(await summary.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(true);
    await reasoningToggle.click();
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'true');
    const expandedMetrics = await summary.evaluate((element) => ({
      fits: element.scrollWidth <= element.clientWidth + 1,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      height: element.getBoundingClientRect().height,
      text: element.textContent,
    }));
    expect(expandedMetrics).toEqual(expect.objectContaining({
      fits: true,
      text: fixture.reasoningText,
    }));
    expect(expandedMetrics.height).toBeGreaterThan(expandedMetrics.lineHeight + 1);
    await expect(turn.locator('.thread-reasoning-body')).toHaveCount(0);
  });

  test('explains only non-zero shell exit codes', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000af01';
      const commandId = '01910000-0000-7000-8000-00000000af02';
      const answerId = '01910000-0000-7000-8000-00000000af03';
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: commandId,
              type: 'commandExecution',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: commandId },
              command: 'false',
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'bash' },
                providerName: 'bash',
                arguments: { storage: 'inline', value: { command: 'false' } },
                schemaDigest: '0'.repeat(64),
              },
              cwd: '/mock/workspace',
              processId: null,
              status: 'failed',
              commandActions: [],
              aggregatedOutput: 'permission denied',
              exitCode: 2,
              durationMs: 4,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
              text: 'The command failed.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
    });

    await page.getByRole('button', { name: 'Worked for <1s' }).click();
    const commandDetails = page.locator('.thread-tool').filter({ hasText: 'false' });
    const command = commandDetails.locator('.thread-tool-toggle');
    await command.click();
    const sections = commandDetails.locator('.thread-tool-section');
    await expect(sections.locator('header')).toHaveText(['Arguments', 'Output · Exit code 2']);
    const failedHeader = sections.filter({ has: page.locator('header', { hasText: 'Exit code 2' }) });
    await expect(failedHeader.locator('header')).toHaveCSS(
      'color',
      await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--status-danger)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
    );
    // The failure is stated where it adds something and nowhere else: the folded
    // row already carries `failed`, so the detail owes no sentence of its own.
    await expect(commandDetails.locator('.thread-inline-error')).toHaveCount(0);
    await expect(commandDetails).not.toContainText('Command failed');
  });

  test('never claims a settled Turn is still working, and states the wait as a wait', async ({ page }) => {
    await createNewThread(page);
    const ids = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c001';
      const toolId = '01910000-0000-7000-8000-00000000c002';
      // A settled Turn with tool work and no final response: the divider used to
      // fall through to the live "Working" label.
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: toolId,
            type: 'dynamicToolCall',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
            namespace: null,
            tool: 'file_read',
            arguments: { file_path: '/mock/workspace/notes.md' },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'file_read' },
              providerName: 'file_read',
              arguments: { storage: 'inline', value: { file_path: '/mock/workspace/notes.md' } },
              schemaDigest: '0'.repeat(64),
            },
            status: 'completed',
            outputRef: null,
            contentItems: null,
            success: true,
            durationMs: 3,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
      return { threadId };
    });
    const liveTurnId = '01910000-0000-7000-8000-00000000c003';

    const divider = page.locator('.thread-process-title').first();
    await expect(divider).toHaveText('Read notes.md');
    await expect(page.locator('.thread-speaker')).not.toContainText('Working');

    // Blocked on the user: the label says so, and no shimmer claims progress.
    await page.evaluate(async ({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const inputToolId = '01910000-0000-7000-8000-00000000c004';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [{
            id: inputToolId,
            type: 'dynamicToolCall',
            provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: inputToolId },
            namespace: null,
            tool: 'request_user_input',
            arguments: { questions: [] },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'request_user_input' },
              providerName: 'request_user_input',
              arguments: { storage: 'inline', value: { questions: [] } },
              schemaDigest: '0'.repeat(64),
            },
            status: 'inProgress',
            outputRef: null,
            contentItems: null,
            success: null,
            durationMs: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/plan/updated',
        threadId,
        turnId: liveTurnId,
        explanation: null,
        plan: [{ step: 'Answer the clarification', status: 'in_progress' }],
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/status/changed',
        threadId,
        status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      });
    }, { ...ids, liveTurnId });

    const live = page.locator(`[data-thread-turn-row="${liveTurnId}"] .thread-speaker`);
    await expect(live.locator('.thread-process-title')).toHaveText('Waiting for input');
    await expect(live.locator('.working-text')).toHaveCount(0);
    const requestedInput = live.locator('.thread-tool-inProgress');
    await expect(requestedInput).toContainText('Asking a question');
    await expect(requestedInput.locator('.working-text')).toHaveCount(0);
    const blockedPlan = page.locator('.thread-plan-progress-summary');
    await expect(blockedPlan).toHaveText('1/1 · Answer the clarification');
    await expect(blockedPlan.locator('.working-text')).toHaveCount(0);
    const liveTurn = page.locator(`[data-thread-turn-row="${liveTurnId}"]`);
    await expect(liveTurn.locator('.thread-streaming-shape')).toHaveCSS('animation-name', 'none');
    await expect(liveTurn.locator('.thread-streaming-shape path')).toHaveCSS('animation-name', 'none');
  });

  test('states an interrupted Turn once, and never leaves an unlabelled timeline', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const emit = (suffix: string, hasResponse: boolean) => {
        const turnId = `01910000-0000-7000-8000-00000000c1${suffix}`;
        const toolId = `01910000-0000-7000-8000-00000000c2${suffix}`;
        const answerId = `01910000-0000-7000-8000-00000000c3${suffix}`;
        const items: unknown[] = [{
          id: toolId,
          type: 'commandExecution',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
          command: 'sleep 30',
          modelCall: {
            disposition: 'replayable',
            identity: { namespace: null, name: 'bash' },
            providerName: 'bash',
            arguments: { storage: 'inline', value: { command: 'sleep 30' } },
            schemaDigest: '0'.repeat(64),
          },
          description: null,
          cwd: '/mock/workspace',
          processId: null,
          status: 'interrupted',
          outputRef: null,
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: 2,
        }];
        if (hasResponse) {
          items.push({
            id: answerId,
            type: 'agentMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
            text: 'Partial answer.',
            phase: 'final_answer',
            memoryCitation: null,
          });
        }
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId,
          turnId,
          turn: {
            id: turnId,
            items,
            itemsView: 'full',
            provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
            status: 'interrupted',
            error: null,
            startedAt: 1,
            completedAt: 5,
            durationMs: 4,
          },
        });
      };
      emit('01', false);
      emit('02', true);
    });

    const blocks = page.locator('.thread-speaker');
    await expect(blocks).toHaveCount(2);

    // No response: exactly one "Turn interrupted", owned by the divider.
    const noResponse = blocks.first();
    await expect(noResponse.getByText('Turn interrupted')).toHaveCount(1);

    // With a response the tail owns the status, but the timeline still needs a
    // name — it used to render as an unlabelled list of rows.
    const withResponse = blocks.last();
    await expect(withResponse.locator('.thread-process-timeline')).toHaveCount(1);
    // A neutral, status-free name for the timeline: the duration when known,
    // never a status claim and never the live "Working" label.
    const header = withResponse.locator('.thread-process-title');
    await expect(header).toHaveCount(1);
    await expect(header).toHaveText('Worked for <1s');
    // Exactly one owner per Turn: the divider for the Turn without a response,
    // the response tail for the Turn with one — two in total, never three.
    await expect(page.getByText('Turn interrupted')).toHaveCount(2);
  });

  test('states an interrupted Turn that produced nothing at all', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c401';
      const userId = '01910000-0000-7000-8000-00000000c402';
      // Interrupted before any process Item existed: no tool call, no
      // reasoning, no response. `groupTurnContent` renders no process block at
      // all here, so there is no divider to own the status.
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: userId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: userId },
            clientId: null,
            content: [{ type: 'text', text: 'Stop right away.' }],
            acceptedAt: 1,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'interrupted',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
    });

    await expect(page.locator('.thread-process-block')).toHaveCount(0);
    await expect(page.locator('.thread-process-title')).toHaveCount(0);
    // The status must still be stated — by the response tail, since nothing
    // else can.
    await expect(page.getByText('Turn interrupted')).toHaveCount(1);
  });

  test('keeps an explicitly opened live reasoning disclosure open when a newer Item lands', async ({ page }) => {
    await createNewThread(page);
    const ids = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c501';
      const reasoningId = '01910000-0000-7000-8000-00000000c502';
      const toolId = '01910000-0000-7000-8000-00000000c503';
      const reasoning = {
        id: reasoningId,
        type: 'reasoning',
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: reasoningId },
        summary: ['Deciding which file to open'],
        content: ['Checking the available file candidates.'],
      };
      const liveTurn = (items: unknown[]) => ({
        id: turnId,
        items,
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress',
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started', threadId, turnId, turn: liveTurn([reasoning]),
      });
      return { threadId, turnId, toolId, reasoning };
    });

    const reasoningToggle = page.locator('.thread-reasoning-toggle');
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
    await reasoningToggle.click();
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(1);

    // A tool call lands: the reasoning is no longer the tail. It must not snap
    // shut and shift the layout under the reader.
    await page.evaluate(({ threadId, turnId, toolId, reasoning }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [reasoning, {
            id: toolId,
            type: 'dynamicToolCall',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
            namespace: null,
            tool: 'file_read',
            arguments: { file_path: '/mock/workspace/notes.md' },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'file_read' },
              providerName: 'file_read',
              arguments: { storage: 'inline', value: { file_path: '/mock/workspace/notes.md' } },
              schemaDigest: '0'.repeat(64),
            },
            status: 'inProgress',
            outputRef: null,
            contentItems: null,
            success: null,
            durationMs: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
    }, ids);

    await expect(page.locator('.thread-tool')).toHaveCount(1);
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(1);

    await reasoningToggle.click();
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
  });

  test('paints structural process updates at the followed bottom with one compact rhythm', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 520 });
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c601';
      const userItemId = '01910000-0000-7000-8000-00000000c602';
      const itemId = (sequence: number) => (
        `01910000-0000-7000-8000-${sequence.toString().padStart(12, '0')}`
      );
      const itemProvenance = (originItemId: string) => ({
        originThreadId: threadId,
        originTurnId: turnId,
        originItemId,
      });
      const fileReadItem = (
        id: string,
        index: number,
        status: 'completed' | 'inProgress',
      ) => ({
        id,
        type: 'dynamicToolCall',
        provenance: itemProvenance(id),
        namespace: null,
        tool: 'file_read',
        arguments: { file_path: `/mock/process-${index}.json` },
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'file_read' },
          providerName: 'file_read',
          arguments: {
            storage: 'inline',
            value: { file_path: `/mock/process-${index}.json` },
          },
          schemaDigest: '0'.repeat(64),
        },
        status,
        outputRef: null,
        contentItems: status === 'completed' ? [{ type: 'text', text: 'ok' }] : null,
        success: status === 'completed' ? true : null,
        durationMs: status === 'completed' ? 5 : null,
      });
      const processItems = Array.from({ length: 8 }, (_, index) => {
        const reasoningId = itemId(10_000 + index * 2);
        const toolId = itemId(10_001 + index * 2);
        return [
          {
            id: reasoningId,
            type: 'reasoning',
            provenance: itemProvenance(reasoningId),
            summary: [`Process reasoning ${index + 1}`],
            content: [],
          },
          fileReadItem(toolId, index + 1, 'completed'),
        ];
      }).flat();
      const finalReasoningId = itemId(10_100);
      const nextToolId = itemId(10_101);
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userItemId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: itemProvenance(userItemId),
              clientId: null,
              acceptedAt: Date.now(),
              content: [{ type: 'text', text: 'Keep this process timeline stable.' }],
            },
            ...processItems,
            {
              id: finalReasoningId,
              type: 'reasoning',
              provenance: itemProvenance(finalReasoningId),
              summary: ['Preparing the next file read'],
              content: ['Confirming the final candidate before the read.'],
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      return {
        finalReasoningId,
        nextTool: fileReadItem(nextToolId, 9, 'inProgress'),
        nextToolId,
        threadId,
        turnId,
      };
    });

    const transcript = page.locator('.thread-transcript');
    const reasoningToggle = page.locator(
      `[data-thread-disclosure-id="reasoning:${fixture.finalReasoningId}"]`,
    );
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false');
    await reasoningToggle.click();
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'true');
    await setTranscriptFollowingBottom(page);
    await reasoningToggle.evaluate((element) => { element.dataset.identityProbe = 'stable'; });

    const frames = await page.evaluate(async ({ nextTool, nextToolId, threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const scroll = document.querySelector<HTMLElement>('.thread-transcript');
      const anchor = document.querySelector<HTMLElement>('[data-identity-probe="stable"]');
      if (!scroll || !anchor) throw new Error('Missing process stability probe');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'item/started',
        threadId,
        turnId,
        item: nextTool,
      });
      const samples: Array<{
        anchorTop: number;
        bottomGap: number;
        toolMounted: boolean;
      }> = [];
      const toolDisclosureId = `tool:${nextToolId}`;
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push({
          anchorTop: anchor.getBoundingClientRect().top,
          bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          toolMounted: Boolean(document.querySelector(
            `[data-thread-disclosure-id="${CSS.escape(toolDisclosureId)}"]`,
          )),
        });
      }
      return samples;
    }, fixture);

    const mountedFrames = frames.filter((frame) => frame.toolMounted);
    expect(mountedFrames.length).toBeGreaterThan(1);
    expect(mountedFrames[0]!.bottomGap).toBeLessThanOrEqual(1);
    expect(Math.max(...mountedFrames.map((frame) => frame.bottomGap))).toBeLessThanOrEqual(1);
    expect(Math.max(...mountedFrames.map((frame) => frame.anchorTop))
      - Math.min(...mountedFrames.map((frame) => frame.anchorTop))).toBeLessThan(1);
    await expect(reasoningToggle).toHaveAttribute('data-identity-probe', 'stable');
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);

    const rhythm = await reasoningToggle.evaluate((toggle) => {
      const reasoning = toggle.closest<HTMLElement>('.thread-reasoning');
      const timeline = reasoning?.parentElement;
      const bodyLine = reasoning?.querySelector<HTMLElement>(
        '.thread-reasoning-body .thread-markdown > :first-child',
      );
      const previousTool = reasoning?.previousElementSibling?.querySelector<HTMLElement>('.thread-tool-toggle');
      const nextTool = reasoning?.nextElementSibling?.querySelector<HTMLElement>('.thread-tool-toggle');
      if (!reasoning || !timeline || !bodyLine || !previousTool || !nextTool) {
        throw new Error('Missing compact process rhythm elements');
      }
      const expected = Number.parseFloat(getComputedStyle(timeline).rowGap);
      const previousRect = previousTool.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();
      const bodyRect = bodyLine.getBoundingClientRect();
      const nextRect = nextTool.getBoundingClientRect();
      return {
        actual: [
          toggleRect.top - previousRect.bottom,
          bodyRect.top - toggleRect.bottom,
          nextRect.top - bodyRect.bottom,
        ],
        expected,
      };
    });
    expect(rhythm.expected).toBeGreaterThan(0);
    for (const interval of rhythm.actual) {
      expect(Math.abs(interval - rhythm.expected)).toBeLessThan(1);
    }
  });

  test('says a command failed without inventing an exit code it never reported', async ({ page }) => {
    await createNewThread(page);
    await seedMixedStatusToolTurn(page);

    await page.getByRole('button', { name: 'Worked for <1s' }).click();
    await page.locator('.thread-tool-activity-toggle').click();
    const failed = page.locator('.thread-tool-failed.thread-tool');
    await failed.locator('.thread-tool-toggle').click();
    // A timeout reported no code and no output, so the detail adds nothing: the
    // row's own `failed` segment is the whole statement, and no plausible
    // -looking code is borrowed to fill the gap.
    await expect(failed.locator('.thread-tool-label')).toContainText('failed');
    await expect(failed.locator('.thread-tool-section header')).toHaveText(['Arguments']);
    await expect(failed.locator('.thread-inline-error')).toHaveCount(0);
    await expect(failed).not.toContainText('Exit code');
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`carries tool-row status by colour and label in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await createNewThread(page);
      await seedMixedStatusToolTurn(page);

      await page.getByRole('button', { name: 'Worked for <1s' }).click();
      const group = page.locator('.thread-tool-activity-group');
      await expect(group).toHaveClass(/thread-tool-failed/);
      await expect(group.locator('.thread-tool-activity-summary'))
        .toHaveText('Ran 3 commands · 1 failed · 1 interrupted');
      await group.locator('.thread-tool-activity-toggle').click();
      await expect(page.locator('.thread-tool-activity-members .thread-tool')).toHaveCount(3);

      const probe = await page.evaluate(() => {
        const channels = (value: string): readonly number[] =>
          (value.match(/[\d.]+/g) ?? []).map(Number);
        const luminance = (rgb: readonly number[]): number => {
          const linear = rgb.slice(0, 3).map((channel) => {
            const ratio = channel / 255;
            return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
        };
        const contrast = (a: readonly number[], b: readonly number[]): number => {
          const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
          return (high! + 0.05) / (low! + 0.05);
        };
        const paintedBackground = (element: Element): readonly number[] => {
          let node: Element | null = element;
          while (node) {
            const background = channels(getComputedStyle(node).backgroundColor);
            if ((background[3] ?? 1) > 0.99) return background;
            node = node.parentElement;
          }
          return channels(getComputedStyle(document.body).backgroundColor);
        };
        const token = (name: string): readonly number[] => {
          const probeElement = document.createElement('span');
          probeElement.style.color = `var(${name})`;
          document.body.append(probeElement);
          const resolved = channels(getComputedStyle(probeElement).color);
          probeElement.remove();
          return resolved;
        };
        const leadingSpaceWidth = (element: Element | null): number => {
          const node = element?.firstChild;
          if (!node) return -1;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 1);
          return range.getBoundingClientRect().width;
        };
        const row = (status: string) => {
          const element = document.querySelector(`.thread-tool-activity-members .thread-tool-${status}`);
          if (!element) throw new Error(`Missing ${status} row`);
          const slot = element.querySelector('.thread-disclosure-status')!;
          const label = element.querySelector('.thread-tool-label')!;
          const slotStyle = getComputedStyle(slot);
          return {
            glyph: slot.querySelector('svg')?.outerHTML ?? '',
            labelColor: channels(getComputedStyle(label).color).slice(0, 3),
            slotBackgroundAlpha: channels(slotStyle.backgroundColor)[3] ?? 1,
            slotBorderWidth: slotStyle.borderTopWidth,
            slotHeight: Math.round(slot.getBoundingClientRect().height),
          };
        };
        const failedRow = row('failed');
        const summary = document.querySelector('.thread-tool-activity-summary')!;
        const tally = summary.querySelector('.thread-tool-activity-count-failed')!;
        return {
          completed: row('completed'),
          failed: failedRow,
          interrupted: row('interrupted'),
          statusDanger: token('--status-danger'),
          textFaint: token('--text-faint'),
          textSoft: token('--text-soft'),
          group: {
            summaryColor: channels(
              getComputedStyle(summary.querySelector('.thread-tool-summary-act')!).color,
            ).slice(0, 3),
            // The act shrinks and the tally is pinned, so a narrow pane can
            // never ellipsize the only failure cue away.
            actFlexShrink: getComputedStyle(summary.querySelector('.thread-tool-summary-act')!).flexShrink,
            tallyFlexShrink: getComputedStyle(tally).flexShrink,
            glyphColor: channels(
              getComputedStyle(document.querySelector('.thread-tool-activity-toggle .thread-disclosure-status')!).color,
            ).slice(0, 3),
            tallyColor: channels(getComputedStyle(tally).color).slice(0, 3),
            tallyText: tally.textContent,
            // Measure the separator as rendered. Text-content assertions
            // normalize whitespace, so they pass on markup that draws
            // "Ran 3 commands· 1 failed".
            tallyLeadingSpaceWidth: leadingSpaceWidth(tally),
            rowLeadingSpaceWidth: leadingSpaceWidth(
              document.querySelector('.thread-tool-activity-members .thread-tool-failed .thread-tool-activity-count-failed'),
            ),
          },
          failedLabelContrast: contrast(
            failedRow.labelColor,
            paintedBackground(document.querySelector('.thread-tool-failed.thread-tool')!),
          ),
        };
      });

      // The tool keeps its own glyph, so a broken row still says which tool broke.
      expect(probe.failed.glyph).toBe(probe.completed.glyph);
      expect(probe.interrupted.glyph).toBe(probe.completed.glyph);
      // Status is colour on the label, never a fill or a second slot geometry.
      expect(probe.failed.labelColor).toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.interrupted.labelColor).toEqual(probe.textFaint.slice(0, 3));
      expect(probe.failed.slotBackgroundAlpha).toBe(0);
      expect(probe.failed.slotBorderWidth).toBe('0px');
      expect(probe.failed.slotHeight).toBe(probe.completed.slotHeight);
      // The whole --status-* family is calibrated as marks and fills, not as
      // small text: measured on the content surface, danger is 3.91 (light) /
      // 3.46 (dark) — better than success (3.33 light) and warning (2.44
      // light). 3:1 is therefore the bar this system actually holds; raising
      // the family to AA small-text is a design-system-wide recalibration
      // owned by docs/plans/dark-mode-contrast-pass.md, not by this row.
      expect(probe.failedLabelContrast).toBeGreaterThanOrEqual(3);

      // A mixed-outcome group stays neutral apart from its tally: one failed
      // call out of three must not paint the line, or the whole group reads as
      // broken. The group glyph stays neutral for the same reason.
      expect(probe.group.tallyText).toBe(' · 1 failed');
      expect(probe.group.tallyColor).toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.group.summaryColor).not.toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.group.summaryColor).toEqual(probe.textSoft.slice(0, 3));
      expect(probe.group.glyphColor).not.toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.group.glyphColor).toEqual(probe.textFaint.slice(0, 3));
      expect(probe.group.tallyFlexShrink).toBe('0');
      expect(probe.group.actFlexShrink).not.toBe('0');
      // The " · " separator has to actually occupy width; a flex item
      // blockifies and a block trims its leading whitespace.
      expect(probe.group.tallyLeadingSpaceWidth).toBeGreaterThan(0);
      expect(probe.group.rowLeadingSpaceWidth).toBeGreaterThan(0);

      // The tint has to survive interaction — the chevron swap used to erase it.
      await page.locator('.thread-tool-failed.thread-tool .thread-tool-toggle').hover();
      const hoveredLabelColor = await page.evaluate(() => getComputedStyle(
        document.querySelector('.thread-tool-activity-members .thread-tool-failed .thread-tool-label')!,
      ).color);
      expect((hoveredLabelColor.match(/[\d.]+/g) ?? []).map(Number).slice(0, 3))
        .toEqual(probe.statusDanger.slice(0, 3));
    });
  }

  test('hands running group motion between its summary and expanded members', async ({ page }) => {
    await createNewThread(page);
    const ids = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const liveTurnId = '01910000-0000-7000-8000-00000000b101';
      const doneId = '01910000-0000-7000-8000-00000000b102';
      const runningId = '01910000-0000-7000-8000-00000000b103';
      const commandItem = (id: string, command: string, status: string, exitCode: number | null) => ({
        id,
        type: 'commandExecution',
        provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: id },
        command,
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'bash' },
          providerName: 'bash',
          arguments: { storage: 'inline', value: { command } },
          schemaDigest: '0'.repeat(64),
        },
        cwd: '/mock/workspace',
        processId: null,
        status,
        commandActions: [],
        aggregatedOutput: null,
        exitCode,
        durationMs: null,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [
            commandItem(doneId, 'ls', 'completed', 0),
            commandItem(runningId, 'sleep 30', 'inProgress', null),
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/plan/updated',
        threadId,
        turnId: liveTurnId,
        explanation: null,
        plan: [{ step: 'Wait for the command output', status: 'in_progress' }],
      });
      return { threadId, turnId: liveTurnId };
    });

    const turn = page.locator(`[data-thread-turn-row="${ids.turnId}"]`);
    const group = turn.locator('.thread-tool-activity-group');
    await expect(group).toHaveClass(/thread-tool-inProgress/);
    const groupToggle = group.locator(':scope > .thread-tool-activity-toggle');
    await expect(groupToggle.locator('.working-text')).toHaveCount(1);
    const animationSurface = await groupToggle.locator('.working-text').evaluate((root) => {
      const rootRect = root.getBoundingClientRect();
      const metadata = new Set(['offset', 'computedOffset', 'easing', 'composite']);
      return {
        contain: getComputedStyle(root).contain,
        animations: root.getAnimations({ subtree: true }).map((animation) => {
          const effect = animation.effect;
          if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof HTMLElement)) {
            throw new Error('WorkingText must use an element keyframe effect');
          }
          const targetRect = effect.target.getBoundingClientRect();
          const properties = Array.from(new Set(
            effect.getKeyframes().flatMap((keyframe) => Object.keys(keyframe)),
          )).filter((property) => !metadata.has(property)).sort();
          return {
            targetClass: effect.target.className,
            properties,
            insideRoot:
              targetRect.left >= rootRect.left - 0.5
              && targetRect.top >= rootRect.top - 0.5
              && targetRect.right <= rootRect.right + 0.5
              && targetRect.bottom <= rootRect.bottom + 0.5,
          };
        }),
      };
    });
    expect(animationSurface).toEqual({
      contain: 'paint',
      animations: [{
        targetClass: 'working-text-base',
        properties: ['backgroundPositionX', 'backgroundPositionY'],
        insideRoot: true,
      }],
    });
    await expect(turn.locator('.thread-streaming-shape')).toHaveCSS('animation-name', 'none');
    await expect(turn.locator('.thread-streaming-shape path')).toHaveCSS('animation-name', 'none');
    await expect(groupToggle.locator('.thread-disclosure-status svg')).toHaveCSS('animation-name', 'none');
    const groupSweep = groupToggle.locator('.working-text-base');
    await expect(groupSweep).toHaveCSS('animation-name', 'working-text-sweep');
    await expect(page.locator('.thread-plan-progress .working-text')).toHaveCount(1);
    await page.evaluate(({ threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/providerRetry/changed',
        threadId,
        turnId,
        status: { kind: 'stream', attempt: 1, maxRetries: 3 },
      });
    }, ids);
    await expect(turn.locator('.thread-provider-retry')).toHaveText('Reconnecting 1/3');
    await expect(groupToggle.locator('.working-text')).toHaveCount(0);
    await expect(page.locator('.thread-plan-progress .working-text')).toHaveCount(0);
    await page.evaluate(({ threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/providerRetry/changed',
        threadId,
        turnId,
        status: null,
      });
    }, ids);
    const resumedGroupSweep = groupToggle.locator('.working-text-base');
    await expect(resumedGroupSweep).toHaveCSS('display', 'block');
    await expect(resumedGroupSweep).toHaveCSS('animation-name', 'working-text-sweep');
    await expect(page.locator('.thread-plan-progress .working-text')).toHaveCount(1);
    await expect(group.locator('.thread-tool-activity-members')).toHaveCount(0);

    // The semantic group glyph uses the ordinary disclosure handoff on hover.
    await groupToggle.hover();
    await expect(groupToggle.locator('.thread-disclosure-status')).toHaveCSS('opacity', '0');
    await expect(groupToggle.locator('.thread-disclosure-chevron')).toHaveCSS('opacity', '1');
    await groupToggle.click();
    const running = turn.locator('.thread-tool-activity-members .thread-tool-inProgress');
    const done = turn.locator('.thread-tool-activity-members .thread-tool-completed');
    await expect(running).toHaveCount(1);
    await expect(groupToggle.locator('.working-text')).toHaveCount(0);
    await expect(running.locator('.working-text')).toHaveCount(1);
    await expect(done.locator('.working-text')).toHaveCount(0);
    await expect(running.locator('.thread-disclosure-status svg')).toHaveCSS('animation-name', 'none');
    expect(await running.locator('.thread-tool-summary-act').evaluate((element) => (
      getComputedStyle(element).color
    ))).toBe(await done.locator('.thread-tool-summary-act').evaluate((element) => (
      getComputedStyle(element).color
    )));

    await groupToggle.click();
    await expect(group.locator('.thread-tool-activity-members')).toHaveCount(0);
    await expect(groupToggle.locator('.working-text')).toHaveCount(1);
  });

  test('keeps working state legible for reduced motion and increased contrast', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000b111';
      const toolId = '01910000-0000-7000-8000-00000000b112';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: toolId,
            type: 'commandExecution',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
            command: 'sleep 30',
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'bash' },
              providerName: 'bash',
              arguments: { storage: 'inline', value: { command: 'sleep 30' } },
              schemaDigest: '0'.repeat(64),
            },
            description: 'Wait for the background process',
            cwd: '/mock/workspace',
            processId: null,
            status: 'inProgress',
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
    });

    const row = page.locator('.thread-tool-inProgress');
    const glyph = row.locator('.thread-disclosure-status');
    const label = row.locator('.working-text-base');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(label).toHaveCSS('animation-name', 'none');
    await expect(glyph).toHaveCSS('color', await resolveTokenColor(page, '--text-soft'));
    await expect(page.locator('.thread-streaming-shape')).toHaveCSS('animation-name', 'none');

    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [
        { name: 'prefers-color-scheme', value: 'light' },
        { name: 'prefers-reduced-motion', value: 'no-preference' },
        { name: 'forced-colors', value: 'none' },
        { name: 'prefers-contrast', value: 'more' },
        { name: 'prefers-reduced-transparency', value: 'no-preference' },
      ],
    });
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-contrast: more)').matches)).toBe(true);
    await expect(label).toHaveCSS('animation-name', 'none');
    await expect(glyph).toHaveCSS('color', await resolveTokenColor(page, '--text-soft'));
    await expect(page.locator('.thread-streaming-shape')).toHaveCSS('animation-name', 'thread-shape-spin');
  });

  test('shows web tool arguments and results as direct JSON', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ae01';
      const toolId = '01910000-0000-7000-8000-00000000ae02';
      const answerId = '01910000-0000-7000-8000-00000000ae03';
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: toolId,
              type: 'webSearch',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
              query: 'Chengdu weather',
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'web_search' },
                providerName: 'web_search',
                arguments: { storage: 'inline', value: { query: 'Chengdu weather' } },
                schemaDigest: '0'.repeat(64),
              },
              results: [{ title: 'Forecast', url: 'https://example.com/weather', snippet: 'Sunny' }],
              status: 'completed',
              error: null,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
              text: 'It will be sunny.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
    });

    await page.getByRole('button', { name: 'Worked for <1s' }).click();
    const tool = page.locator('.thread-tool').filter({ hasText: 'Chengdu weather' });
    await tool.getByRole('button', { name: /Searched the web/ }).click();
    const sections = tool.locator('.thread-tool-section');
    await expect(tool.getByRole('button', { name: 'Copy arguments' })).toHaveCount(1);
    await expect(tool.getByRole('button', { name: 'Copy output' })).toHaveCount(1);
    await expect(sections.nth(0)).toContainText('Arguments');
    await expect(sections.nth(0).locator('.agent-code-body')).toContainText('"query": "Chengdu weather"');
    await expect(sections.nth(1)).toContainText('Result');
    await expect(sections.nth(1).locator('.agent-code-body')).toContainText('"title": "Forecast"');
  });

  test('keeps Node and local-file references interactive in canonical Agent Markdown', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async ({ nodeId }) => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ac01';
      const answerId = '01910000-0000-7000-8000-00000000ac02';
      const turn = {
        id: turnId,
        items: [{
          id: answerId,
          type: 'agentMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
          text: `Review [[node://${nodeId.slice('node:'.length)}]] and [[file:///mock/notes.md]].`,
          phase: 'final_answer',
          memoryCitation: null,
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 13,
        durationMs: 12,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn,
      });
    }, { nodeId: ids.alpha });

    const message = page.locator('.thread-agent-message').last();
    await expect(message).not.toContainText('[[node:');
    const nodeRef = message.locator(`[data-inline-ref="${ids.alpha}"]`);
    await expect(nodeRef).toHaveText('Alpha');
    await expect(nodeRef).toHaveAttribute('href', `#lin-node:${encodeURIComponent(ids.alpha)}`);

    const fileRef = message.locator('[data-inline-ref-kind="local-file"]');
    await expect(fileRef).toHaveText('notes.md');
    await fileRef.hover();
    await expect(page.locator('[data-inline-file-preview]')).toContainText('/mock/notes.md');
    await fileRef.click();
    const preview = page.locator('.outline-panel-surface.active-panel.is-file-preview');
    await expect(preview.locator('.file-preview-content')).toContainText('Mock preview text.');
  });

  test('reads an all-complete Plan as complete, not as its last step', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000e101';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId, items: [], itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress', error: null, startedAt: Date.now(), completedAt: null, durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/plan/updated',
        threadId,
        turnId,
        explanation: null,
        plan: [
          { step: 'Read the source', status: 'completed' },
          { step: 'Write the summary', status: 'completed' },
        ],
      });
    });

    // `2/2` beside a check was distinguishable from "on step two" only by the
    // icon; a finished Plan is not "on" its last step.
    await expect(page.locator('.thread-plan-progress-summary')).toHaveText('Plan complete');
  });

  test('shows Turn-local Plan progress only while the Turn is active', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ae01';
      const itemId = '01910000-0000-7000-8000-00000000ae02';
      const turn = {
        id: turnId,
        items: [{
          id: itemId,
          type: 'userMessage',
          author: { kind: 'reader' },
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
          clientId: null,
          acceptedAt: 1,
          content: [{ type: 'text', text: 'Implement the interaction' }],
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress',
        error: null,
        execution: {
          modelProvider: 'openai',
          model: 'openai/gpt-5.4',
          reasoningEffort: 'medium',
          diagnosticsRef: null,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: null,
          },
        },
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn,
      });
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/plan/updated',
        threadId,
        turnId,
        explanation: 'Working through the interaction contract',
        plan: Array.from({ length: 24 }, (_, index) => ({
          step: index === 0
            ? 'Inspect the current behavior'
            : index === 1
              ? 'Implement the transient projection'
              : `Verify interaction checkpoint ${index + 1}`,
          status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
        })),
      });
      return { threadId, turn };
    });

    const progress = page.locator('.thread-plan-progress-summary');
    // The persistent affordance is the current step's text, not a bare counter.
    const workingLabel = progress.locator('.thread-plan-progress-label.working-text');
    await expect(workingLabel.locator('.working-text-base'))
      .toHaveText('2/24 · Implement the transient projection');
    await expect(workingLabel.locator('.working-text-base')).toHaveCount(1);
    await expect(progress).toHaveAccessibleName('2/24 · Implement the transient projection');
    await expect(progress).toHaveAttribute('aria-expanded', 'false');
    await progress.hover();
    const checklist = page.locator('.thread-plan-progress-popover');
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText('Working through the interaction contract');
    await expect(checklist.locator('li')).toHaveCount(24);
    // Each row states its status for assistive tech; the icons are decorative.
    await expect(checklist.locator('li').first()).toHaveText('Completed: Inspect the current behavior');
    await expect(checklist.locator('li').last()).toHaveText('Pending: Verify interaction checkpoint 24');
    // The current step is marked by semantics, weight, colour, and a filled dot,
    // so opening the Plan can stop all motion without losing working state.
    const currentStep = checklist.locator('li.is-in_progress');
    await expect(currentStep).toHaveCount(1);
    await expect(currentStep).toHaveAttribute('aria-current', 'step');
    await expect(currentStep).toHaveCSS('font-weight', '600');
    expect(await checklist.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    await checklist.hover();
    await page.mouse.wheel(0, 480);
    await expect.poll(() => checklist.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.mouse.move(1, 1);
    await expect(checklist).not.toBeVisible();
    await progress.focus();
    await progress.press('Enter');
    await expect(progress).toHaveAttribute('aria-expanded', 'true');
    await expect(checklist).toBeVisible();
    await expect(checklist).toBeFocused();
    await expect(page.locator('.thread-plan-progress .working-text')).toHaveCount(0);
    const currentCue = await currentStep.locator('.thread-plan-step-status').evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        backgroundColor: style.backgroundColor,
        content: style.content,
        height: style.height,
        width: style.width,
      };
    });
    expect(currentCue).toMatchObject({ content: '\"\"', height: '5px', width: '5px' });
    expect(currentCue.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    await checklist.evaluate((element) => { element.scrollTop = 0; });
    await checklist.press('PageDown');
    await expect.poll(() => checklist.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await checklist.press('Escape');
    await expect(progress).toHaveAttribute('aria-expanded', 'false');
    await expect(checklist).not.toBeVisible();
    await expect(progress.locator('.thread-plan-progress-label.working-text')).toHaveCount(1);
    await expect(progress.locator('.working-text-base'))
      .toHaveText('2/24 · Implement the transient projection');
    // Closing hands focus back to the composer, not to the pill: the Plan is a
    // transient status affordance, not a destination to be stranded in.
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeFocused();

    await page.evaluate(({ threadId, turn }) => {
      const e2eWindow = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId: turn.id,
        turn: { ...turn, status: 'completed', completedAt: 2, durationMs: 1 },
      });
    }, fixture);

    await expect(page.locator('.thread-plan-progress')).toHaveCount(0);
    await expect(page.getByText('Used update_plan')).toHaveCount(0);
  });

  test('opens a lone terminal reasoning Item when the Turn has no final response', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ab01';
      const userMessageId = '01910000-0000-7000-8000-00000000ab02';
      const reasoningId = '01910000-0000-7000-8000-00000000ab03';
      const commentaryId = '01910000-0000-7000-8000-00000000ab04';
      const provenance = (itemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: itemId });
      const turn = {
        id: turnId,
        items: [
          {
            id: userMessageId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: provenance(userMessageId),
            clientId: null,
            acceptedAt: 1,
            content: [{ type: 'text', text: 'Inspect the outline.' }],
          },
          {
            id: reasoningId,
            type: 'reasoning',
            provenance: provenance(reasoningId),
            summary: ['The outline is currently empty.'],
            content: ['No outline nodes require inspection.'],
          },
          {
            id: commentaryId,
            type: 'agentMessage',
            provenance: provenance(commentaryId),
            text: '   ',
            phase: 'commentary',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        execution: {
          modelProvider: 'openai',
          model: 'openai/gpt-5.4',
          reasoningEffort: 'medium',
          diagnosticsRef: null,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: null,
          },
        },
        startedAt: Date.now() - 28,
        completedAt: Date.now(),
        durationMs: 28,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn,
      });
    });

    const thought = page.getByRole('button', { name: 'The outline is currently empty.' });
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('The outline is currently empty.', { exact: true })).toBeVisible();
    await expect(page.getByText('No outline nodes require inspection.', { exact: true })).toBeVisible();
    await expect(page.getByText('Thought', { exact: true })).toHaveCount(0);
  });

  test('keeps live lone reasoning folded when the Turn settles without a response', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ac01';
      const reasoningId = '01910000-0000-7000-8000-00000000ac02';
      const reasoning = {
        id: reasoningId,
        type: 'reasoning',
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: reasoningId },
        summary: ['Inspecting the current outline'],
        content: ['No outline nodes currently require changes.'],
      };
      const turn = {
        id: turnId,
        items: [reasoning],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress',
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'turn/started', threadId, turnId, turn });
      return { reasoningId, threadId, turn, turnId };
    });

    const toggle = page.locator(`[data-thread-disclosure-id="reasoning:${fixture.reasoningId}"]`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
    const top = await toggle.evaluate((element) => element.getBoundingClientRect().top);

    await page.evaluate(({ threadId, turn, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: { ...turn, status: 'completed', completedAt: 2, durationMs: 1 },
      });
    }, fixture);

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
    expect(Math.abs(await toggle.evaluate((element) => element.getBoundingClientRect().top) - top)).toBeLessThan(1);
  });

  test('keeps the composer primary action identical to the active Turn state', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000bb01';
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      });
    });

    await expect(page.getByRole('button', { name: 'Interrupt Turn' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add attachment' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Model and reasoning' })).toBeDisabled();
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Use the shorter path.');
    await expect(page.getByRole('button', { name: 'Steer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Interrupt Turn' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Steer' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([{ type: 'text', text: 'Use the shorter path.' }]);
    expect(submit?.args).not.toHaveProperty('expectedTurnId');
  });

  test('uses the established step flow for canonical user input without losing the composer draft', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Keep this draft while answering.');
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ab01';
      const itemId = '01910000-0000-7000-8000-00000000ab02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'userInput/requested',
        threadId,
        turnId,
        itemId,
        request: {
          threadId,
          turnId,
          itemId,
          questions: [
            {
              id: 'scope',
              header: 'Scope',
              question: 'How broad should the pass be?',
              options: [
                { label: 'Focused', description: 'Only the selected module.' },
                { label: 'Complete', description: 'Cover the full workflow.' },
              ],
            },
            {
              id: 'schedule',
              header: 'Schedule',
              question: 'When should this run?',
              options: [
                { label: 'Now', description: 'Run immediately.' },
                { label: 'Tonight', description: 'Run after work.' },
              ],
            },
          ],
        },
      });
    });

    const form = page.getByRole('form', { name: 'Input needed' });
    await expect(form).toContainText('1 of 2');
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeHidden();
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next' }).click();
    await expect(form).toContainText('2 of 2');
    await expect(form.getByRole('radio', { name: /Now/ })).toBeFocused();

    await form.getByRole('button', { name: 'Previous question' }).click();
    await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
    await form.getByRole('button', { name: 'Next' }).click();
    await form.getByRole('radio', { name: 'Other' }).check();
    await form.getByRole('textbox', { name: 'Other' }).fill('Every morning');
    await form.getByRole('button', { name: 'Submit' }).click();

    const response = (await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond').at(-1);
    expect(response?.args.answers).toEqual([
      { questionId: 'scope', optionLabel: 'Complete' },
      { questionId: 'schedule', otherText: 'Every morning' },
    ]);

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'userInput/resolved',
        threadId,
        turnId: '01910000-0000-7000-8000-00000000ab01',
        itemId: '01910000-0000-7000-8000-00000000ab02',
        response: {
          threadId,
          turnId: '01910000-0000-7000-8000-00000000ab01',
          itemId: '01910000-0000-7000-8000-00000000ab02',
          answers: [],
          autoResolved: false,
        },
      });
    });
    await expect(composer).toHaveText('Keep this draft while answering.');
  });

  test('keeps a short transcript in natural flow after send', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      await target.lin?.agentCoreRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Earlier short conversation evidence.' }],
        clientUserMessageId: 'short-conversation-evidence',
      });
    });

    const transcript = page.locator('.thread-transcript');
    const earlier = page.locator('.thread-user-message').filter({ hasText: 'Earlier short conversation evidence.' });
    await expect(earlier).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Keep this short conversation settled.');
    await page.getByRole('button', { name: 'Send' }).click();

    const latest = page.locator('.thread-user-message').filter({ hasText: 'Keep this short conversation settled.' });
    await expect(latest).toBeVisible();
    await expect(page.locator('.thread-send-anchor-spacer')).toHaveCount(0);
    await expect.poll(async () => {
      const [earlierBox, latestBox] = await Promise.all([earlier.boundingBox(), latest.boundingBox()]);
      if (!earlierBox || !latestBox) return false;
      return earlierBox.y < latestBox.y;
    }).toBe(true);
  });

  test('anchors a sent message and resumes streaming follow only after jumping to latest', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 10; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Earlier scroll evidence ${index + 1}` }],
          clientUserMessageId: `scroll-evidence-${index + 1}`,
        });
      }
    });

    const transcript = page.locator('.thread-transcript');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    await expect(
      page.locator('.thread-user-message').filter({ hasText: 'Earlier scroll evidence 10' }),
    ).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill([
      'Anchor this request.',
      ...Array.from({ length: 80 }, (_, index) => `Disclosure evidence ${index + 1}.`),
    ].join(' '));
    await page.getByRole('button', { name: 'Send' }).click();

    const userMessage = page.locator('.thread-user-message').filter({ hasText: 'Anchor this request.' });
    await expect(userMessage).toBeVisible();
    await expect.poll(() => userMessage.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    })).toBeLessThanOrEqual(2);
    const sendAnchorSpacer = page.locator('.thread-send-anchor-spacer');
    await expect(sendAnchorSpacer).toHaveCount(1);
    const initialSpacerHeight = await sendAnchorSpacer.evaluate((element) => (
      element.getBoundingClientRect().height
    ));
    expect(initialSpacerHeight).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    const anchoredTop = await transcript.evaluate((element) => element.scrollTop);

    const live = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const threads = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = threads?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const history = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>(
        'thread/turns/list',
        { threadId, limit: 100, itemsView: 'full' },
      );
      const turn = history?.data.at(-1) as Record<string, unknown> | undefined;
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      const items = Array.isArray(turn?.items) ? turn.items as Array<Record<string, unknown>> : [];
      const userItem = items.find((item) => item.type === 'userMessage');
      const responseItem = items.find((item) => item.type === 'agentMessage');
      const responseItemId = typeof responseItem?.id === 'string' ? responseItem.id : null;
      if (!turnId || !userItem || !responseItem || !responseItemId) throw new Error('Missing sent Turn');
      const streamingText = Array.from(
        { length: 36 },
        (_, index) => `Streaming anchored evidence ${index + 1}.`,
      ).join('\n\n');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          ...turn,
          items: [userItem, { ...responseItem, text: streamingText }],
          status: 'inProgress',
          completedAt: null,
          durationMs: null,
        },
      });
      return { responseItemId, threadId, turnId };
    });

    await expect(page.getByText('Streaming anchored evidence 36.')).toBeVisible();
    await expect.poll(async () => (
      await sendAnchorSpacer.count() === 0
        ? 0
        : sendAnchorSpacer.evaluate((element) => element.getBoundingClientRect().height)
    )).toBeLessThan(initialSpacerHeight);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(anchoredTop - 2);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(anchoredTop + 2);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);

    await page.evaluate(({ responseItemId, threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'item/delta',
        threadId,
        turnId,
        itemId: responseItemId,
        delta: {
          type: 'agentMessageText',
          delta: Array.from({ length: 18 }, (_, index) => `\n\nPinned stream delta ${index + 1}.`).join(''),
        },
      });
    }, live);
    await expect(page.getByText('Pinned stream delta 18.')).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);
  });

  /**
   * The end state was already covered above; this covers the way there.
   *
   * A sent message reaches the transcript on the `turn/started` notification, a
   * whole round trip before `turn/submit` answers — and the anchor used to wait
   * for that answer, so the reader watched their message sit at the bottom edge
   * and then watched the viewport travel a full screen to put it at the top,
   * overshooting it by ~40px on the way. Nothing about the settled position
   * showed any of that, so the assertion here is over every frame.
   *
   * Reduced motion, so the anchor is the cut it used to be and every frame can
   * be pinned exactly: the message exists at the anchor or it does not exist.
   * The animated arrival is the next test.
   */
  test('puts a sent message at the top on the frame it first renders when motion is reduced', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 10; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Earlier scroll evidence ${index + 1}` }],
          clientUserMessageId: `frame-evidence-${index + 1}`,
        });
      }
    });
    const transcript = page.locator('.thread-transcript');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    await expect(
      page.locator('.thread-user-message').filter({ hasText: 'Earlier scroll evidence 10' }),
    ).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    // The mock answers `turn/submit` in the same microtask as the notification
    // it emits, which is the one ordering the real host never has. Holding the
    // response back restores the gap the reader actually sits through.
    await page.evaluate(() => {
      const target = window as Window & {
        lin?: { agentCoreRequest: (method: string, input?: Record<string, unknown>) => Promise<unknown> };
      };
      const original = target.lin!.agentCoreRequest.bind(target.lin);
      target.lin!.agentCoreRequest = (method: string, input?: Record<string, unknown>) => {
        const pending = original(method, input);
        if (method !== 'turn/submit') return pending;
        return pending.then(async (result) => {
          await new Promise((resolve) => { setTimeout(resolve, 180); });
          return result;
        });
      };
    });

    const recording = page.evaluate(async () => {
      const scroller = document.querySelector('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      const frames: Array<{ readonly offset: number; readonly top: number }> = [];
      for (let frame = 0; frame < 90; frame += 1) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
        const message = [...document.querySelectorAll('.thread-user-message')]
          .find((element) => element.textContent?.includes('Anchor on arrival.'));
        if (!message) continue;
        frames.push({
          offset: message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset,
          top: scroller.scrollTop,
        });
      }
      return frames;
    });

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Anchor on arrival.');
    await page.getByRole('button', { name: 'Send' }).click();
    const frames = await recording;

    expect(frames.length).toBeGreaterThan(10);
    // Every frame, not just the last: an intermediate position is the bug.
    const offBy = frames.map((frame) => Math.abs(frame.offset));
    expect(Math.max(...offBy)).toBeLessThanOrEqual(2);
    const tops = frames.map((frame) => frame.top);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  });

  /**
   * With motion allowed the anchor is spent as travel rather than as a cut, and
   * the shape of that travel is the assertion: one arrival, decelerating, never
   * reversing, never past the top, finished inside the layout-motion budget.
   * The bug it replaces looked nothing like this — a long stall at the bottom
   * edge, then a single frame across the whole viewport, then a step back.
   */
  test('travels to the anchor in one arrival instead of cutting to it', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 10; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Earlier travel evidence ${index + 1}` }],
          clientUserMessageId: `travel-evidence-${index + 1}`,
        });
      }
    });
    const transcript = page.locator('.thread-transcript');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    await expect(
      page.locator('.thread-user-message').filter({ hasText: 'Earlier travel evidence 10' }),
    ).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    const recording = page.evaluate(async () => {
      const scroller = document.querySelector('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      const frames: Array<{ readonly at: number; readonly offset: number }> = [];
      for (let frame = 0; frame < 120; frame += 1) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
        const message = [...document.querySelectorAll('.thread-user-message')]
          .find((element) => element.textContent?.includes('Travel to the anchor.'));
        if (!message) continue;
        frames.push({
          at: performance.now(),
          offset: message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset,
        });
      }
      return frames;
    });

    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Travel to the anchor.');
    await page.getByRole('button', { name: 'Send' }).click();
    const frames = await recording;

    expect(frames.length).toBeGreaterThan(10);
    const first = frames[0]!;
    // It starts below the anchor and moves: a cut would already be at the top.
    expect(first.offset).toBeGreaterThan(2);
    for (let index = 1; index < frames.length; index += 1) {
      // Monotone: every frame is at or above the previous one. The overshoot
      // this replaces went past the top and came back, which reverses here.
      expect(frames[index]!.offset).toBeLessThanOrEqual(frames[index - 1]!.offset + 1);
    }
    expect(Math.min(...frames.map((frame) => frame.offset))).toBeGreaterThanOrEqual(-2);
    const settled = frames.find((frame) => Math.abs(frame.offset) <= 2);
    expect(settled).toBeDefined();
    // The whole arrival is one layout-motion budget, with slack for the frame
    // the send itself costs. A stall would blow straight through it.
    expect(settled!.at - first.at).toBeLessThan(400);
    expect(Math.abs(frames.at(-1)!.offset)).toBeLessThanOrEqual(2);
  });

  /**
   * The gate holds `turn/submit` before it reaches the mock, so while it is shut
   * the host has not seen the send at all — no Turn, no notification, nothing
   * the transcript could be drawing from. Whatever is on screen in that window
   * is the composer's own echo, which is the point: the reader's message is not
   * supposed to wait for a round trip. Releasing the gate then has to be a swap
   * and not an arrival — one message before, one after, never two.
   */
  test('draws the sent message before the host has it, then swaps it for the canonical Turn', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 10; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Earlier echo evidence ${index + 1}` }],
          clientUserMessageId: `echo-evidence-${index + 1}`,
        });
      }
    });
    const transcript = page.locator('.thread-transcript');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    await expect(
      page.locator('.thread-user-message').filter({ hasText: 'Earlier echo evidence 10' }),
    ).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    await page.evaluate(() => {
      const target = window as Window & {
        lin?: { agentCoreRequest: (method: string, input?: Record<string, unknown>) => Promise<unknown> };
        __SUBMIT_GATE__?: { open: () => void };
      };
      const original = target.lin!.agentCoreRequest.bind(target.lin);
      let openGate = (): void => undefined;
      const gate = new Promise<void>((resolve) => { openGate = () => resolve(); });
      target.__SUBMIT_GATE__ = { open: openGate };
      target.lin!.agentCoreRequest = async (method: string, input?: Record<string, unknown>) => {
        if (method === 'turn/submit') await gate;
        return original(method, input);
      };
    });

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Echo before the host knows.');
    await page.getByRole('button', { name: 'Send' }).click();

    const sent = page.locator('.thread-user-message').filter({ hasText: 'Echo before the host knows.' });
    await expect(sent).toHaveCount(1);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/submit')).toHaveLength(0);
    const anchoredOffset = async () => sent.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    });
    // Polled, not immediate: the anchor is spent as travel, and where the echo
    // ends up is this test's business while how long it takes to get there is
    // the travel test's.
    await expect.poll(anchoredOffset).toBeLessThanOrEqual(2);

    // Watch the handover frame by frame: the echo leaves in the same commit the
    // canonical row arrives, so no frame may hold two of the message.
    const handover = page.evaluate(async () => {
      const counts: number[] = [];
      for (let frame = 0; frame < 45; frame += 1) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
        counts.push([...document.querySelectorAll('.thread-user-message')]
          .filter((element) => element.textContent?.includes('Echo before the host knows.')).length);
      }
      return counts;
    });
    await page.evaluate(() => {
      (window as Window & { __SUBMIT_GATE__?: { open: () => void } }).__SUBMIT_GATE__?.open();
    });
    expect(Math.max(...(await handover))).toBe(1);

    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').length
    )).toBe(1);
    await expect(sent).toHaveCount(1);
    // The reply is the proof the row is the canonical Turn now: the echo has no
    // response to render, and the row it occupied is the one that grew one.
    const sentRow = page.locator('[data-thread-turn-row]').filter({ has: sent });
    await expect(sentRow.getByText('Current outline focuses on design-system work.')).toBeVisible();
    await expect.poll(anchoredOffset).toBeLessThanOrEqual(2);
  });

  /**
   * Not every send becomes a message. `/clear` and `/compact` leave the composer
   * as ordinary text and come back as a `contextReset` Item under a Turn of
   * their own, carrying nothing of the reader's — so the client id the stand-in
   * row waits for never arrives, and waiting on it alone left a permanent
   * phantom bubble spinning under the reset it had just performed. The Turn the
   * host reports accepting is the other way home, and the deduplicated repeat —
   * which reports no Turn at all — has to retire the row on the spot.
   */
  test('retires the stand-in row for a send that becomes no message at all', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 3; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Context evidence ${index + 1}` }],
          clientUserMessageId: `context-evidence-${index + 1}`,
        });
      }
    });
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    const phantom = page.locator('.thread-user-message').filter({ hasText: '/clear' });

    await composer.fill('/clear');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Context cleared.')).toHaveCount(1);
    await expect(phantom).toHaveCount(0);

    // The repeat is deduplicated by the host, which answers with no Turn at all.
    await composer.fill('/clear');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').length
    )).toBe(2);
    await expect(phantom).toHaveCount(0);
    await expect(page.getByText('Context cleared.')).toHaveCount(1);
  });

  /**
   * The virtualized path is where a latched anchor target used to become fatal:
   * the row has no measured height on the pass that first sees it, so the anchor
   * bails there and has to come back on a later pass — against a Turn id it must
   * resolve afresh, because the id it saw first may have been the stand-in's and
   * that row leaves the DOM as soon as the canonical Turn lands. An anchor that
   * never completes also never releases, and a pending anchor is what suspends
   * the bottom pin.
   */
  test('completes the anchor for a send into a virtualized transcript', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      // Past TRANSCRIPT_VIRTUAL_MIN_TURNS, so the transcript virtualizes.
      for (let index = 0; index < 45; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Virtual evidence ${index + 1}` }],
          clientUserMessageId: `virtual-evidence-${index + 1}`,
        });
      }
    });
    const transcript = page.locator('.thread-transcript');
    await expect.poll(() => transcript.evaluate((element) => (
      element.querySelector('[data-virtualized="true"]') !== null
    ))).toBe(true);

    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Send into a virtual transcript.');
    await page.getByRole('button', { name: 'Send' }).click();
    const sent = page.locator('.thread-user-message').filter({ hasText: 'Send into a virtual transcript.' });
    await expect(sent).toHaveCount(1);
    await expect.poll(() => sent.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    })).toBeLessThanOrEqual(2);
  });

  // Which point of a clamped message holds still, over the geometries that make
  // the answer differ: riding a real tail, scrolled back, no tail at all, and the
  // way back from expanded.
  test('keeps a bottom-positioned long-message disclosure anchored', async ({ page }) => {
    await createNewThread(page);
    // A tail the reader could actually scroll away from. Without content above
    // it the transcript is shorter than its own viewport, which is a different
    // case with a different answer — the no-scroll-range judge below.
    await seedOverflowingTranscript(page);
    await seedLongUserMessageTurn(page, 'Long message evidence');

    const transcript = page.locator('.thread-transcript');
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.clientHeight
    ))).toBeGreaterThan(0);
    await setTranscriptFollowingBottom(page);
    const disclosure = page.locator('.thread-user-expand-button');
    await expect(disclosure).toHaveAccessibleName('Show more');
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);

    await toggleDisclosureWithStableAnchor(disclosure);
    await expect(disclosure).toHaveAccessibleName('Show less');
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);

    await toggleDisclosureWithStableAnchor(disclosure);
    await expect(disclosure).toHaveAccessibleName('Show more');
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);
  });

  test('opens a long message downward when the transcript has no tail to ride', async ({ page }) => {
    await createNewThread(page);
    // The shape an Agent's own transcript usually has: a brief the reader is
    // looking straight at, and not enough below it to scroll. `follow` is true
    // here only because there is nowhere to go, which is not the same as riding
    // a bottom — reading it as one is what pushed the brief off the top.
    await seedLongUserMessageTurn(page, 'Briefing evidence');

    const transcript = page.locator('.thread-transcript');
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.clientHeight
    ))).toBeLessThanOrEqual(1);
    const shell = page.locator('.thread-user-message .thread-user-content-shell');
    const disclosure = page.locator('.thread-user-expand-button');
    const collapsed = await transcript.evaluate((element) => element.scrollTop);

    await toggleDisclosureWithStableAnchor(disclosure, shell);
    await expect(disclosure).toHaveAccessibleName('Show less');
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(collapsed);
    await expect.poll(() => page.locator('.thread-transcript-content').evaluate((element) => (
      element.style.paddingBottom
    ))).toBe('');
  });

  test('opens a scrolled-back long-message disclosure downward from its own top edge', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill(Array.from(
      { length: 80 },
      (_, index) => `Scrolled-back evidence ${index + 1}.`,
    ).join(' '));
    await page.getByRole('button', { name: 'Send' }).click();
    // Content below the message, so the reader can be off the tail with the
    // clamped message still on screen — the way an Agent's brief sits at the
    // head of its own transcript.
    await seedOverflowingTranscript(page);

    const transcript = page.locator('.thread-transcript');
    const shell = page.locator('.thread-user-message .thread-user-content-shell');
    const disclosure = page.locator('.thread-user-expand-button');
    await expect(disclosure).toHaveAccessibleName('Show more');
    // Back to the head of the transcript, where the clamped message is what the
    // reader is looking at.
    await transcript.hover();
    await page.mouse.wheel(0, -10_000);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(1);
    // Proof the reader is genuinely off the tail: the bottom pin is what makes
    // holding the control the right answer, and it is not riding here.
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    const collapsed = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.thread-transcript');
      const button = document.querySelector<HTMLElement>('.thread-user-expand-button');
      if (!scroller || !button) throw new Error('Missing transcript or disclosure');
      return { buttonTop: button.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
    });

    // The message's own top edge is the fixed point, so the revealed lines open
    // downward instead of shoving its first line off the top of the viewport.
    await toggleDisclosureWithStableAnchor(disclosure, shell);
    await expect(disclosure).toHaveAccessibleName('Show less');
    const expanded = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.thread-transcript');
      const button = document.querySelector<HTMLElement>('.thread-user-expand-button');
      const content = document.querySelector<HTMLElement>('.thread-transcript-content');
      if (!scroller || !button || !content) throw new Error('Missing transcript or disclosure');
      return {
        buttonTop: button.getBoundingClientRect().top,
        // Growing downward needs no scroll range that is not already there, so
        // the transient tail runway never appears.
        paddingBottom: content.style.paddingBottom,
        scrollTop: scroller.scrollTop,
      };
    });
    expect(expanded.scrollTop).toBe(collapsed.scrollTop);
    expect(expanded.paddingBottom).toBe('');
    // The control travelled the full height of what it revealed, which is what
    // "downward" means: nothing above it moved to make the room.
    expect(expanded.buttonTop).toBeGreaterThan(collapsed.buttonTop + 100);
  });

  test('collapses a scrolled-back long message under the control that closed it', async ({ page }) => {
    await createNewThread(page);
    // The message first, the bulk after it, so scrolling back puts the clamped
    // message on screen with a tail still below.
    await seedLongUserMessageTurn(page, 'Collapse evidence');
    await seedOverflowingTranscript(page);

    const transcript = page.locator('.thread-transcript');
    await transcript.hover();
    await page.mouse.wheel(0, -10_000);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(1);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    const disclosure = page.locator('.thread-user-expand-button');
    await toggleDisclosureWithStableAnchor(
      disclosure,
      page.locator('.thread-user-message .thread-user-content-shell'),
    );
    await expect(disclosure).toHaveAccessibleName('Show less');

    // Reaching Show less in a message taller than the viewport means scrolling
    // well past the block's top edge. Nothing grows on the way back, so the
    // control is the fixed point — holding the block instead pins a point far
    // above the reader and drops the collapsed message out of view behind them.
    await disclosure.scrollIntoViewIfNeeded();
    const expanded = await transcript.evaluate((element) => element.scrollTop);
    expect(expanded).toBeGreaterThan(0);
    await disclosure.click();
    await expect(disclosure).toHaveAccessibleName('Show more');

    const shell = page.locator('.thread-user-message .thread-user-content-shell');
    await expect(shell).toBeInViewport();
    // Not pushed further down the transcript to hold a point that is no longer
    // anywhere near the reader.
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(expanded);
    await expect.poll(() => page.locator('.thread-transcript-content').evaluate((element) => (
      element.style.paddingBottom
    ))).toBe('');
  });

  test('lets a keyboard send supersede a pending disclosure anchor', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill(Array.from(
      { length: 80 },
      (_, index) => `Pending disclosure evidence ${index + 1}.`,
    ).join(' '));
    await page.getByRole('button', { name: 'Send' }).click();

    const disclosure = page.locator('.thread-user-expand-button');
    await expect(disclosure).toHaveAccessibleName('Show more');
    await composer.fill('Send while the disclosure anchor is pending.');
    await page.evaluate(() => {
      const toggle = document.querySelector<HTMLButtonElement>('.thread-user-expand-button');
      const editor = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message this Thread"]');
      if (!toggle || !editor) throw new Error('Missing disclosure or composer');
      toggle.click();
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Enter',
        key: 'Enter',
      }));
    });

    const sentMessage = page.locator('.thread-user-message').filter({
      hasText: 'Send while the disclosure anchor is pending.',
    });
    await expect(sentMessage).toBeVisible();
    await expect.poll(() => sentMessage.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    })).toBeLessThanOrEqual(2);
    await expect.poll(() => page.locator('.thread-transcript-content').evaluate((element) => (
      element.style.paddingBottom
    ))).toBe('');
  });

  test('replays bottom follow after a streaming update waits on a disclosure anchor', async ({ page }) => {
    await createNewThread(page);
    await seedOverflowingTranscript(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000fb01';
      const userItemId = '01910000-0000-7000-8000-00000000fb02';
      const reasoningItemId = '01910000-0000-7000-8000-00000000fb03';
      const responseItemId = '01910000-0000-7000-8000-00000000fb04';
      const provenance = (originItemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userItemId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: provenance(userItemId),
              content: [{ type: 'text', text: 'Keep following this short live response.' }],
            },
            {
              id: reasoningItemId,
              type: 'reasoning',
              provenance: provenance(reasoningItemId),
              summary: ['Inspect'],
              content: ['Review the response stream.'],
            },
            {
              id: responseItemId,
              type: 'agentMessage',
              provenance: provenance(responseItemId),
              text: 'Streaming follow checkpoint.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: 3,
          completedAt: null,
          durationMs: null,
        },
      });
      return { responseItemId, threadId, turnId };
    });

    const transcript = page.locator('.thread-transcript');
    const thought = page.locator('.thread-reasoning-toggle').last();
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    const anchoredTop = await thought.evaluate((element) => element.getBoundingClientRect().top);
    await page.evaluate(({ responseItemId, threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const toggle = document.querySelectorAll<HTMLButtonElement>('.thread-reasoning-toggle');
      toggle[toggle.length - 1]?.click();
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'item/delta',
        threadId,
        turnId,
        itemId: responseItemId,
        delta: { type: 'agentMessageText', delta: ' continued' },
      });
    }, fixture);
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    expect(Math.abs(await thought.evaluate((element) => (
      element.getBoundingClientRect().top
    )) - anchoredTop)).toBeLessThan(1);
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);
  });

  test('does not pull the transcript down after the reader scrolls upward', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ee01';
      const itemId = '01910000-0000-7000-8000-00000000ee02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'agentMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
            text: Array.from({ length: 80 }, (_, index) => `Earlier evidence ${index + 1}`).join('\n\n'),
            phase: 'final_answer',
            memoryCitation: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });

    const transcript = page.locator('.thread-transcript');
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await setTranscriptFollowingBottom(page);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const frames = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const scroll = document.querySelector<HTMLElement>('.thread-transcript');
      if (!scroll) throw new Error('Thread transcript not found');
      const turnId = '01910000-0000-7000-8000-00000000ef01';
      const itemId = '01910000-0000-7000-8000-00000000ef02';
      scroll.scrollTop = 0;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'agentMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
            text: 'New evidence arrived.',
            phase: 'final_answer',
            memoryCitation: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 3,
          completedAt: 4,
          durationMs: 1,
        },
      });
      const samples: Array<{ bottomGap: number; messageMounted: boolean; scrollTop: number }> = [];
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push({
          bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          messageMounted: document.body.textContent?.includes('New evidence arrived.') ?? false,
          scrollTop: scroll.scrollTop,
        });
      }
      return samples;
    });

    const mountedFrames = frames.filter((frame) => frame.messageMounted);
    expect(mountedFrames.length).toBeGreaterThan(1);
    expect(Math.max(...mountedFrames.map((frame) => frame.scrollTop))).toBeLessThanOrEqual(1);
    expect(Math.min(...mountedFrames.map((frame) => frame.bottomGap))).toBeGreaterThan(1);
    await expect(page.getByText('New evidence arrived.')).toHaveCount(1);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  });

  test('keeps the exact flow threshold painted through a distant jump', async ({ page }) => {
    await createNewThread(page);
    await seedPaintContinuityTranscript(page, TRANSCRIPT_VIRTUAL_MIN_TURNS);
    await expect(page.locator('[data-thread-turn-row]')).toHaveCount(TRANSCRIPT_VIRTUAL_MIN_TURNS);

    expectTranscriptCoverage(await sampleTranscriptJumpCoverage(page, 'bottom'));
  });

  test('repairs the first virtual Turn count before a distant jump returns', async ({ page }) => {
    await createNewThread(page);
    const turnCount = TRANSCRIPT_VIRTUAL_MIN_TURNS + 1;
    await seedPaintContinuityTranscript(page, turnCount);
    await expect.poll(() => page.locator('[data-thread-turn-row]').count()).toBeLessThan(turnCount);

    const samples = await sampleTranscriptJumpCoverage(page, 'bottom');
    expectTranscriptCoverage(samples);
    expect(samples[0]?.mountedRows).toBeLessThan(turnCount);
  });

  test('uses the Turn-local origin after a Goal taller than the viewport', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      await target.lin?.agentCoreRequest('goal/create', {
        threadId,
        objective: Array.from(
          { length: 140 },
          (_, index) => `Goal evidence ${index + 1} must remain ahead of the Turn coordinate origin.`,
        ).join(' '),
      });
    });
    await seedPaintContinuityTranscript(page, 80);
    const leadingExtent = await page.locator('.thread-transcript').evaluate((element) => {
      element.scrollTop = 0;
      const turns = element.querySelector<HTMLElement>('.thread-transcript-turns');
      if (!turns) throw new Error('Missing Turn container');
      return {
        height: element.clientHeight,
        turnOrigin: turns.getBoundingClientRect().top
          - (element.getBoundingClientRect().top + element.clientTop),
      };
    });
    expect(leadingExtent.turnOrigin).toBeGreaterThan(leadingExtent.height);
    expect(leadingExtent.turnOrigin).toBeGreaterThan(TRANSCRIPT_VIRTUAL_OVERSCAN_PX);

    expectTranscriptCoverage(await sampleTranscriptJumpCoverage(page, 'turnStart'));
    expectTranscriptCoverage(await sampleTranscriptJumpCoverage(page, 'turnMiddle'));
  });

  test('keeps the latest rapidly alternating virtual jump covered', async ({ page }) => {
    await createNewThread(page);
    await seedPaintContinuityTranscript(page, 80);
    const result = await page.locator('.thread-transcript').evaluate(async (element) => {
      const readCoverage = () => {
        const turns = element.querySelector<HTMLElement>('.thread-transcript-turns');
        if (!turns) throw new Error('Missing Turn container');
        const viewportTop = element.getBoundingClientRect().top + element.clientTop;
        const viewportBottom = viewportTop + element.clientHeight;
        const turnsBounds = turns.getBoundingClientRect();
        const contentTop = Math.max(viewportTop, turnsBounds.top);
        const contentBottom = Math.min(viewportBottom, turnsBounds.bottom);
        if (contentBottom <= contentTop) return true;
        return Array.from(turns.querySelectorAll<HTMLElement>('[data-thread-turn-row]')).some((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.bottom > contentTop
            && bounds.top < contentBottom
            && row.checkVisibility({ contentVisibilityAuto: true });
        });
      };
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const targets = [maximum, 0, maximum * 0.55, maximum * 0.9, maximum * 0.1, maximum];
      const covered = targets.map((top) => {
        element.scrollTop = top;
        element.dispatchEvent(new Event('scroll'));
        return readCoverage();
      });
      for (let frame = 0; frame < 2; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        covered.push(readCoverage());
      }
      return {
        covered,
        maximum: Math.max(0, element.scrollHeight - element.clientHeight),
        target: targets.at(-1) ?? 0,
        top: element.scrollTop,
      };
    });

    expect(result.covered.every(Boolean)).toBe(true);
    expect(Math.abs(result.top - Math.min(result.maximum, result.target))).toBeLessThanOrEqual(1);
  });

  test('coalesces covered incremental virtual scrolling without urgent range changes', async ({ page }) => {
    await createNewThread(page);
    await seedPaintContinuityTranscript(page, 80);
    const result = await page.locator('.thread-transcript').evaluate(async (element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const rowIds = () => Array.from(
        element.querySelectorAll<HTMLElement>('[data-thread-turn-row]'),
        (row) => row.dataset.threadTurnRow,
      );
      const initial = rowIds();
      const synchronousWindows: Array<Array<string | undefined>> = [];
      for (let step = 0; step < 4; step += 1) {
        element.scrollTop += 24;
        element.dispatchEvent(new Event('scroll'));
        synchronousWindows.push(rowIds());
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { initial, synchronousWindows };
    });

    expect(result.synchronousWindows.every((ids) => (
      JSON.stringify(ids) === JSON.stringify(result.initial)
    ))).toBe(true);
  });

  test('prepares virtual restore coverage before the lifecycle scroll write', async ({ page }) => {
    const lifecycleWarnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('flushSync')) {
        lifecycleWarnings.push(message.text());
      }
    });
    await createNewThread(page);
    await renameSelectedThread(page, 'Restore coverage');
    await seedPaintContinuityTranscript(page, 80);
    const anchor = await captureReadingAnchor(page, 0.72);
    await createNewThread(page);

    await page.evaluate(() => {
      interface ScrollWriteSample {
        readonly beforeCovered: boolean;
        readonly distance: number;
        readonly mountedRows: number;
      }
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      if (!descriptor?.get || !descriptor.set || descriptor.configurable === false) {
        throw new Error('Cannot instrument scrollTop');
      }
      const samples: ScrollWriteSample[] = [];
      (window as Window & { __transcriptRestoreWrites?: ScrollWriteSample[] })
        .__transcriptRestoreWrites = samples;
      Object.defineProperty(Element.prototype, 'scrollTop', {
        ...descriptor,
        get: descriptor.get,
        set(value: number) {
          if (this instanceof HTMLElement && this.matches('.thread-transcript')) {
            const currentTop = descriptor.get!.call(this) as number;
            const targetTop = Math.max(
              0,
              Math.min(Math.max(0, this.scrollHeight - this.clientHeight), Number(value)),
            );
            const turns = this.querySelector<HTMLElement>('.thread-transcript-turns');
            if (turns && Math.abs(targetTop - currentTop) >= 1) {
              const delta = targetTop - currentTop;
              const viewportTop = this.getBoundingClientRect().top + this.clientTop;
              const viewportBottom = viewportTop + this.clientHeight;
              const turnsBounds = turns.getBoundingClientRect();
              const contentTop = Math.max(viewportTop, turnsBounds.top - delta);
              const contentBottom = Math.min(viewportBottom, turnsBounds.bottom - delta);
              const rows = Array.from(turns.querySelectorAll<HTMLElement>('[data-thread-turn-row]'));
              const beforeCovered = contentBottom <= contentTop || rows.some((row) => {
                const bounds = row.getBoundingClientRect();
                return bounds.bottom - delta > contentTop
                  && bounds.top - delta < contentBottom
                  && row.checkVisibility({ contentVisibilityAuto: true });
              });
              samples.push({
                beforeCovered,
                distance: Math.abs(targetTop - currentTop),
                mountedRows: rows.length,
              });
            }
          }
          descriptor.set!.call(this, value);
        },
      });
    });

    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Restore coverage' })
      .click();
    await expectReadingAnchorRestored(page, anchor);
    const writes = await page.evaluate(() => (
      (window as Window & {
        __transcriptRestoreWrites?: Array<{
          beforeCovered: boolean;
          distance: number;
          mountedRows: number;
        }>;
      }).__transcriptRestoreWrites ?? []
    ));
    expect(writes.some((write) => write.distance > 400)).toBe(true);
    expect(writes.every((write) => write.beforeCovered && write.mountedRows > 0)).toBe(true);
    expect(lifecycleWarnings).toEqual([]);
  });

  test('virtualizes long Threads and restores their scroll position after switching', async ({ page }) => {
    await createNewThread(page);
    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Rename Thread' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename Thread' });
    await renameDialog.getByRole('textbox', { name: 'Rename Thread' }).fill('Long history');
    await renameDialog.getByRole('button', { name: 'Save' }).click();

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data.find((thread) => thread.id)?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 45; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Long history message ${index + 1}` }],
          clientUserMessageId: `long-history-${index + 1}`,
        });
        if (index % 5 === 4) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
    });

    const transcript = page.locator('.thread-transcript');
    const turns = page.locator('.thread-transcript-turns');
    await expect(turns).toHaveAttribute('data-virtualized', 'true');
    await expect.poll(() => page.locator('[data-thread-turn-row]').count()).toBeLessThan(45);
    const compensationAnchor = await transcript.evaluate(async (element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.max(1, maximum - 80);
      element.dispatchEvent(new Event('scroll'));
      for (let frame = 0; frame < 16; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const viewportTop = element.getBoundingClientRect().top;
      const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-thread-turn-row]'));
      const anchor = rows.find((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.top <= viewportTop && bounds.bottom > viewportTop;
      });
      const growthRow = rows.filter((row) => row.getBoundingClientRect().bottom <= viewportTop - 121).at(-1);
      const anchorTurnId = anchor?.dataset.threadTurnRow;
      const growthTurnId = growthRow?.dataset.threadTurnRow;
      if (!anchor || !anchorTurnId || !growthRow || !growthTurnId) {
        throw new Error('Missing virtual compensation rows');
      }
      const result = {
        anchorTurnId,
        growthTurnId,
        offset: anchor.getBoundingClientRect().top - viewportTop,
        scrollTop: element.scrollTop,
      };
      const coverageSamples: boolean[] = [];
      (window as Window & { __virtualCompensationCoverage?: boolean[] })
        .__virtualCompensationCoverage = coverageSamples;
      element.addEventListener('scroll', () => {
        const turns = element.querySelector<HTMLElement>('.thread-transcript-turns');
        if (!turns) return;
        const currentViewportTop = element.getBoundingClientRect().top + element.clientTop;
        const currentViewportBottom = currentViewportTop + element.clientHeight;
        const turnsBounds = turns.getBoundingClientRect();
        const contentTop = Math.max(currentViewportTop, turnsBounds.top);
        const contentBottom = Math.min(currentViewportBottom, turnsBounds.bottom);
        coverageSamples.push(contentBottom <= contentTop || Array.from(
          turns.querySelectorAll<HTMLElement>('[data-thread-turn-row]'),
        ).some((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.bottom > contentTop
            && bounds.top < contentBottom
            && candidate.checkVisibility({ contentVisibilityAuto: true });
        }));
      }, { passive: true });
      const growthProbe = document.createElement('div');
      growthProbe.dataset.virtualGrowthProbe = 'true';
      growthProbe.style.height = '120px';
      growthRow.append(growthProbe);
      return result;
    });
    const compensationRow = page.locator(
      `[data-thread-turn-row="${compensationAnchor.anchorTurnId}"]`,
    );
    await expect.poll(() => compensationRow.evaluate((element, expectedOffset) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      return Math.abs(
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expectedOffset,
      );
    }, compensationAnchor.offset)).toBeLessThanOrEqual(2);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(compensationAnchor.scrollTop + 100);
    const growthCoverage = await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return (window as Window & { __virtualCompensationCoverage?: boolean[] })
        .__virtualCompensationCoverage ?? [];
    });
    expect(growthCoverage.length).toBeGreaterThan(0);
    expect(growthCoverage.every(Boolean)).toBe(true);
    await page.evaluate(() => {
      const samples = (window as Window & { __virtualCompensationCoverage?: boolean[] })
        .__virtualCompensationCoverage;
      if (samples) samples.length = 0;
    });
    await page.locator(
      `[data-thread-turn-row="${compensationAnchor.growthTurnId}"]`,
    ).evaluate((element) => {
      element.querySelector('[data-virtual-growth-probe]')?.remove();
    });
    await expect.poll(() => compensationRow.evaluate((element, expectedOffset) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      return Math.abs(
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expectedOffset,
      );
    }, compensationAnchor.offset)).toBeLessThanOrEqual(2);
    const shrinkCoverage = await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return (window as Window & { __virtualCompensationCoverage?: boolean[] })
        .__virtualCompensationCoverage ?? [];
    });
    expect(shrinkCoverage.length).toBeGreaterThan(0);
    expect(shrinkCoverage.every(Boolean)).toBe(true);
    await transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const top = Math.max(1, Math.min(480, Math.floor(maximum / 2)));
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByText('Long history message 1', { exact: true })).toHaveCount(1);
    const readingAnchor = await transcript.evaluate(async (element) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      }));
      const viewportTop = element.getBoundingClientRect().top;
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-thread-turn-row]'))
        .find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.top <= viewportTop && bounds.bottom > viewportTop;
        });
      const turnId = row?.dataset.threadTurnRow;
      if (!row || !turnId) throw new Error('Missing reading anchor');
      return {
        offset: row.getBoundingClientRect().top - viewportTop,
        scrollTop: element.scrollTop,
        turnId,
      };
    });
    expect(readingAnchor.scrollTop).toBeGreaterThan(0);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Long history' })
      .click();

    await expect(page.locator('.thread-dock-title')).toContainText('Long history');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    const restoredRow = page.locator(
      `[data-thread-turn-row="${readingAnchor.turnId}"]`,
    );
    await expect(restoredRow).toHaveCount(1);
    await expect.poll(() => restoredRow.evaluate((element, expectedOffset) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const actualOffset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      return Math.abs(actualOffset - expectedOffset);
    }, readingAnchor.offset)).toBeLessThanOrEqual(2);

    const savedNearBottom = await transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.max(1, maximum - 80);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    const originalViewport = page.viewportSize();
    if (!originalViewport) throw new Error('Missing viewport');
    await createNewThread(page);
    await page.setViewportSize({
      height: originalViewport.height + 240,
      width: originalViewport.width,
    });
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Long history' })
      .click();
    await expect(page.locator('.thread-dock-title')).toContainText('Long history');
    await expect.poll(() => transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      return Math.abs(element.scrollTop - maximum);
    })).toBeLessThanOrEqual(2);
    const clampedRestore = await transcript.evaluate((element) => ({
      maximum: Math.max(0, element.scrollHeight - element.clientHeight),
      top: element.scrollTop,
    }));
    expect(clampedRestore.maximum).toBeGreaterThan(0);
    expect(clampedRestore.maximum).toBeLessThan(savedNearBottom);
    expect(Math.abs(clampedRestore.top - clampedRestore.maximum)).toBeLessThanOrEqual(2);
    await page.setViewportSize(originalViewport);
  });

  test('keeps reconnect status announced when virtualization unmounts the live Turn', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 41; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Reconnect history ${index + 1}` }],
          clientUserMessageId: `reconnect-history-${index + 1}`,
        });
      }
      const turnId = '01910000-0000-7000-8000-00000000ef91';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/providerRetry/changed',
        threadId,
        turnId,
        status: { kind: 'stream', attempt: 2, maxRetries: 3 },
      });
      return { turnId };
    });

    const transcript = page.locator('.thread-transcript');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    await expect(page.getByRole('status')).toHaveText('Reconnecting 2/3');
    await transcript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator(`[data-thread-turn-row="${fixture.turnId}"]`)).toHaveCount(0);
    await expect(page.locator('.thread-provider-retry')).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Reconnecting 2/3');
  });

  test('returns a flow-layout Thread to the Turn it was left on', async ({ page }) => {
    await createNewThread(page);
    await renameSelectedThread(page, 'Tall history');
    await seedTallFlowTranscript(page, TRANSCRIPT_VIRTUAL_MIN_TURNS);
    const anchor = await captureReadingAnchor(page, 0.6);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Tall history' })
      .click();
    await expect(page.locator('.thread-dock-title')).toContainText('Tall history');

    await expectReadingAnchorRestored(page, anchor);
  });

  test('lets a send after a restore reach the end instead of being pulled back', async ({ page }) => {
    await createNewThread(page);
    await renameSelectedThread(page, 'Tall history');
    await seedTallFlowTranscript(page, TRANSCRIPT_VIRTUAL_MIN_TURNS);
    const anchor = await captureReadingAnchor(page, 0.6);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Tall history' })
      .click();
    await expectReadingAnchorRestored(page, anchor);

    // The restore owns the position until the reader acts. Sending is the reader
    // acting: the new message anchors at the transcript top, and no restore that
    // outlived its arrival gets to pull the transcript back up behind it.
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Anchor this send.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    const sent = page.locator('.thread-user-message').filter({ hasText: 'Anchor this send.' });
    await expect(sent).toBeVisible();
    await expect.poll(() => sent.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    })).toBeLessThanOrEqual(2);
    await expect(page.locator(`[data-thread-turn-row="${anchor.turnId}"]`)).not.toBeInViewport();
  });
});

test('opens a long message downward while a send spacer owns the rendered bottom', async ({ page }) => {
  await openMockedApp(page, { agentTurnStaysActive: true });
  await createNewThread(page);
  await seedOverflowingTranscript(page);

  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill(Array.from(
    { length: 80 },
    (_, index) => `Synthetic-bottom disclosure evidence ${index + 1}.`,
  ).join(' '));
  await page.getByRole('button', { name: 'Send' }).click();

  const message = page.locator('.thread-user-message')
    .filter({ hasText: 'Synthetic-bottom disclosure evidence 1.' });
  const shell = message.locator('.thread-user-content-shell');
  const disclosure = message.locator('.thread-user-expand-button');
  const spacer = page.locator('.thread-send-anchor-spacer');
  const transcript = page.locator('.thread-transcript');
  await expect(disclosure).toHaveAccessibleName('Show more');
  await expect(spacer).toHaveCount(1);
  await expect.poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(0);

  // Following this bottom means following the send anchor's temporary range,
  // not riding real transcript content. The sent message remains the surface
  // the reader is looking at, so it must still open from its own top edge.
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThanOrEqual(1);
  const before = await message.evaluate((element) => {
    const transcriptElement = element.closest<HTMLElement>('.thread-transcript');
    const messageShell = element.querySelector<HTMLElement>('.thread-user-content-shell');
    const toggle = element.querySelector<HTMLElement>('.thread-user-expand-button');
    const sendSpacer = transcriptElement?.querySelector<HTMLElement>('.thread-send-anchor-spacer');
    if (!transcriptElement || !messageShell || !toggle || !sendSpacer) {
      throw new Error('Missing disclosure geometry');
    }
    return {
      bottomDistance: transcriptElement.scrollHeight
        - transcriptElement.scrollTop
        - transcriptElement.clientHeight,
      buttonTop: toggle.getBoundingClientRect().top,
      shellTop: messageShell.getBoundingClientRect().top,
      spacerHeight: sendSpacer.getBoundingClientRect().height,
      scrollTop: transcriptElement.scrollTop,
    };
  });
  expect(before.bottomDistance).toBeLessThanOrEqual(1);
  expect(before.spacerHeight).toBeGreaterThan(0);

  await disclosure.click();
  await expect(disclosure).toHaveAccessibleName('Show less');
  const after = await message.evaluate((element) => {
    const transcriptElement = element.closest<HTMLElement>('.thread-transcript');
    const messageShell = element.querySelector<HTMLElement>('.thread-user-content-shell');
    const toggle = element.querySelector<HTMLElement>('.thread-user-expand-button');
    const content = element.closest<HTMLElement>('.thread-transcript-content');
    if (!transcriptElement || !messageShell || !toggle || !content) {
      throw new Error('Missing disclosure geometry');
    }
    return {
      buttonTop: toggle.getBoundingClientRect().top,
      paddingBottom: content.style.paddingBottom,
      shellTop: messageShell.getBoundingClientRect().top,
      scrollTop: transcriptElement.scrollTop,
    };
  });
  expect(after.shellTop).toBeCloseTo(before.shellTop, 0);
  expect(after.scrollTop).toBeCloseTo(before.scrollTop, 0);
  expect(after.buttonTop).toBeGreaterThan(before.buttonTop + 100);
  expect(after.paddingBottom).toBe('');
});

test('restores the reader position when turn/submit rejects', async ({ page }) => {
  await openMockedApp(page, { agentTurnSubmitReject: 'Mock turn/submit rejection' });
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000fc01';
    const itemId = '01910000-0000-7000-8000-00000000fc02';
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [{
          id: itemId,
          type: 'agentMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
          text: Array.from({ length: 100 }, (_, index) => `Rejected send evidence ${index + 1}.`).join('\n\n'),
          phase: 'final_answer',
          memoryCitation: null,
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    });
  });

  const transcript = page.locator('.thread-transcript');
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const savedTop = await transcript.evaluate((element) => {
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.max(1, Math.floor(maximum / 2));
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop;
  });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Keep my reading position when this fails.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.locator('.thread-inline-error')).toContainText('Mock turn/submit rejection');
  await expect(composer).toHaveText('Keep my reading position when this fails.');
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(savedTop - 2);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeLessThan(savedTop + 2);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
});

/**
 * The other half of the same rule: a steer joins the Turn already running, so
 * anchoring it would drag the viewport to the top of a reply the reader is in
 * the middle of. The transcript tells the two apart by which Turn the Item
 * lands in, and only a Turn that did not exist at click time is anchored.
 */
test('keeps a steer on the bottom-follow path instead of anchoring the reply it joined', async ({ page }) => {
  await openMockedApp(page, { agentTurnStaysActive: true });
  await createNewThread(page);
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    for (let index = 0; index < 10; index += 1) {
      await target.lin?.agentCoreRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text: `Earlier steer evidence ${index + 1}` }],
        clientUserMessageId: `steer-evidence-${index + 1}`,
      });
    }
  });
  const transcript = page.locator('.thread-transcript');
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await setTranscriptFollowingBottom(page);

  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Steer the running reply.');
  await expect(page.getByRole('button', { name: 'Steer' })).toBeVisible();
  await page.getByRole('button', { name: 'Steer' }).click();

  const steered = page.locator('.thread-user-message').filter({ hasText: 'Steer the running reply.' });
  await expect(steered).toBeVisible();
  await expect(page.locator('.thread-send-anchor-spacer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThanOrEqual(1);
});

test('anchors a new Turn when the request-time active Turn finishes during submission', async ({ page }) => {
  await openMockedApp(page, { agentTurnSubmitFinishingDelayMs: 40 });
  await seedOverflowingTranscript(page);
  const activeTurnId = await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: {
        emitAgentCoreNotification: (notification: unknown) => void;
        setMockThreadActive: (threadId: string, active: boolean) => void;
      };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000fd01';
    const userItemId = '01910000-0000-7000-8000-00000000fd02';
    const responseItemId = '01910000-0000-7000-8000-00000000fd03';
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/started',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [
          {
            id: userItemId,
            type: 'userMessage',
            author: { kind: 'reader' },
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: userItemId },
            content: [{ type: 'text', text: 'Finish this request before admitting the next one.' }],
          },
          {
            id: responseItemId,
            type: 'agentMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: responseItemId },
            text: 'Finishing response.',
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress',
        error: null,
        startedAt: 3,
        completedAt: null,
        durationMs: null,
      },
    });
    target.__LIN_E2E__?.setMockThreadActive(threadId, true);
    return turnId;
  });

  const transcript = page.locator('.thread-transcript');
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await setTranscriptFollowingBottom(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Anchor the newly admitted Turn.');
  await expect(page.getByRole('button', { name: 'Steer' })).toBeVisible();
  await page.getByRole('button', { name: 'Steer' }).click();

  const sent = page.locator('.thread-user-message').filter({ hasText: 'Anchor the newly admitted Turn.' });
  await expect(sent).toBeVisible();
  const sentRow = page.locator('[data-thread-turn-row]').filter({ has: sent });
  await expect(sentRow).not.toHaveAttribute('data-thread-turn-row', activeTurnId);
  await expect.poll(() => sent.evaluate((element) => {
    const scroller = element.closest('.thread-transcript');
    if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
    const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
  })).toBeLessThanOrEqual(2);
  const calls = await commandCalls(page);
  expect(calls.filter((call) => call.cmd === 'turn/submit')).toHaveLength(1);
  expect(calls.filter((call) => call.cmd === 'turn/start')).toHaveLength(0);
  expect(calls.filter((call) => call.cmd === 'turn/steer')).toHaveLength(0);
});

test('aborts an in-flight pathless upload when its Thread is left', async ({ page }) => {
  await openMockedApp(page, { attachmentUploadDelayMs: 200 });
  await page.locator('.thread-composer-file-input').setInputFiles({
    name: 'pending.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(2 * 1024 * 1024),
  });
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin').length
  )).toBe(1);

  await createNewThread(page);

  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/abort').length
  )).toBe(1);
  expect((await commandCalls(page)).some((call) => call.cmd === 'attachment-upload/finish')).toBe(false);
});

test('keeps Send disabled and cancels a pending large-paste attachment when removed', async ({ page }) => {
  await openMockedApp(page, { attachmentUploadDelayMs: 200 });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.focus();
  await pasteComposerText(page, 'pending paste\n'.repeat(6_000));

  await expect(page.locator('.thread-composer-pending-ref')).toContainText('Pasted.txt');
  await expect(page.getByRole('status', { name: 'Attaching Pasted.txt' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Attaching Pasted.txt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove Pasted.txt and message reference' }).click();
  await expect(page.locator('.thread-composer-pending-ref')).toHaveCount(0);
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(0);
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/abort').length
  )).toBe(1);
  expect((await commandCalls(page)).some((call) => call.cmd === 'attachment-upload/finish')).toBe(false);
});

test('blocks Enter submission while a large-paste attachment is pending', async ({ page }) => {
  await openMockedApp(page, { attachmentUploadDelayMs: 500 });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Keep this text ');
  await pasteComposerText(page, 'pending Enter paste\n'.repeat(6_000));

  await expect(page.locator('.thread-composer-pending-ref')).toContainText('Pasted.txt');
  await composer.press('Enter');
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/submit')).toHaveLength(0);

  await expect(page.locator('.thread-composer-pending-ref')).toHaveCount(0);
  await expect(page.locator('.thread-composer-inline-ref[data-thread-file-ref]')).toContainText('Pasted.txt');
  await composer.press('Enter');
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').length
  )).toBe(1);
});

test('rejects a large paste that would replace a pending paste marker', async ({ page }) => {
  await openMockedApp(page, { attachmentUploadDelayMs: 200, attachmentUploadReject: true });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Keep this text ');
  await pasteComposerText(page, 'first pending paste\n'.repeat(6_000));

  const pendingMarker = page.locator('.thread-composer-pending-ref');
  await expect(pendingMarker).toContainText('Pasted.txt');
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin').length
  )).toBe(1);
  await pendingMarker.evaluate((element) => {
    const range = document.createRange();
    range.selectNode(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element.closest('[role="textbox"]') as HTMLElement | null)?.focus();
  });
  await pasteComposerText(page, 'second pending paste\n'.repeat(6_000));

  await expect(page.locator('.thread-inline-error')).toContainText(
    'Pasted text could not be attached in the current composer state.',
  );
  expect((await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin')).toHaveLength(1);
  await expect(pendingMarker).toHaveCount(0);
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(0);
  await expect(composer).toHaveText('Keep this text ');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send' }).click();
  const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
  expect(submit?.args.input).toEqual([{ type: 'text', text: 'Keep this text' }]);
});

test('restores the replaced composer slice when large-paste attachment upload fails', async ({ page }) => {
  await openMockedApp(page, { attachmentUploadReject: true });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Before selected after');
  await composer.evaluate((element) => {
    const paragraph = element.querySelector('p');
    const text = paragraph?.firstChild;
    if (!text) throw new Error('Composer text node was not found');
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 15);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
  });
  await pasteComposerText(page, 'replacement paste\n'.repeat(5_000));

  await expect(page.locator('.thread-composer-pending-ref')).toHaveCount(0);
  await expect(composer).toHaveText('Before selected after');
  await expect(page.getByRole('status')).toContainText(
    'Pasted.txt could not be attached, so the paste was not inserted.',
  );
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/abort').length
  )).toBe(1);
});

test('restores attachment state when a failed large paste replaced its marker', async ({ page }) => {
  await openMockedApp(page, { attachmentUploadReject: true });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await page.locator('.thread-composer-file-input').setInputFiles({
    name: 'existing.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(0),
  });
  const marker = page.locator('.thread-composer-inline-ref[data-thread-file-ref]');
  await expect(marker).toContainText('existing.txt');
  await marker.evaluate((element) => {
    const range = document.createRange();
    range.selectNode(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element.closest('[role="textbox"]') as HTMLElement | null)?.focus();
  });
  await pasteComposerText(page, 'replacement attachment paste\n'.repeat(5_000));

  await expect(page.locator('.thread-composer-pending-ref')).toHaveCount(0);
  await expect(marker).toContainText('existing.txt');
  await expect(page.getByRole('button', { name: 'Preview existing.txt' })).toBeVisible();
  expect((await commandCalls(page)).filter((call) => call.cmd === 'attachment-resource/discard')).toHaveLength(0);
  await page.getByRole('button', { name: 'Send' }).click();
  const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
  expect(submit?.args.input).toEqual([expect.objectContaining({
    type: 'attachment',
    name: 'existing.txt',
    source: expect.objectContaining({ kind: 'resource' }),
  })]);
});

test('opens provider settings instead of creating a Thread when no provider is usable', async ({ page }) => {
  await openMockedApp(page, { agentProviderUsable: false });

  await page.getByRole('button', { name: 'Show Threads' }).click();
  await expect(page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+O');
  await page.getByRole('button', { name: 'Open Providers' }).click();

  const calls = await commandCalls(page);
  // Model services is a page inside Agent now, so the dock's CTA opens it
  // directly rather than landing on a category and leaving the user to find it.
  expect(calls).toContainEqual({ cmd: 'open_settings', args: { page: 'services' } });
  expect(calls.some((call) => call.cmd === 'thread/start')).toBe(false);
});

test('holds the model submenu still when its list is expanded', async ({ page }) => {
  await openMockedApp(page, { manyModelProvider: true });
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread' }).click();

  await page.getByRole('button', { name: 'Model and reasoning' }).click();
  await page.getByRole('menu', { name: 'Model and reasoning' })
    .getByRole('menuitem', { name: 'GPT-5.4' })
    .click();
  const submenu = page.getByRole('menu', { name: 'Model', exact: true });
  const firstRow = submenu.getByRole('menuitemradio').first();
  const expander = submenu.getByRole('button', { name: /Show all \(24\)/ });
  await expect(expander).toBeVisible();
  const before = await submenu.evaluate((element) => ({
    firstRowTop: element.querySelector('[role="menuitemradio"]')?.getBoundingClientRect().top,
    top: element.getBoundingClientRect().top,
  }));

  await expander.click();
  await expect(submenu.getByRole('menuitemradio')).toHaveCount(27);

  // Nothing the reader was already reading moves: the surface keeps its place
  // and absorbs the taller list by scrolling inside itself.
  const after = await submenu.evaluate((element) => ({
    firstRowTop: element.querySelector('[role="menuitemradio"]')?.getBoundingClientRect().top,
    scrolls: element.scrollHeight > element.clientHeight,
    top: element.getBoundingClientRect().top,
    withinViewport: element.getBoundingClientRect().bottom <= window.innerHeight,
  }));
  expect(after.top).toBeCloseTo(before.top!, 0);
  expect(after.firstRowTop).toBeCloseTo(before.firstRowTop!, 0);
  expect(after.scrolls).toBe(true);
  expect(after.withinViewport).toBe(true);
});

test('places the model submenu the same however the reader reached it', async ({ page }) => {
  await openMockedApp(page, { manyModelProvider: true });
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread' }).click();

  const menu = page.getByRole('menu', { name: 'Model and reasoning' });
  const submenu = page.getByRole('menu', { name: 'Model', exact: true });
  const readGeometry = () => submenu.evaluate((element) => ({
    maxHeight: element.style.maxHeight,
    top: Math.round(element.getBoundingClientRect().top),
  }));

  await page.getByRole('button', { name: 'Model and reasoning' }).click();
  await menu.getByRole('menuitem', { name: 'GPT-5.4' }).click();
  await expect(submenu).toBeVisible();
  const direct = await readGeometry();

  // Straight across to the sibling flyout, which is much shorter, and straight
  // back — no close in between, so the surface would still be wearing the other
  // one's ceiling. Measured while clipped it places itself short, and the
  // placement being a fixed point, it stays short for the rest of the session.
  await menu.getByRole('menuitem', { name: /Reasoning/ }).click();
  await expect(page.getByRole('menu', { name: 'Reasoning', exact: true })).toBeVisible();
  await expect(submenu).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'GPT-5.4' }).click();
  await expect(submenu).toBeVisible();

  expect(await readGeometry()).toEqual(direct);
});

test.describe('terminal Thread history actions', () => {
  test('revises an attachment-only failed Turn through same-Thread Edit', async ({ page }) => {
    await openMockedApp(page, {
      agentTurnFailure: 'OpenRouter API error (404): {"error":{"message":"No endpoints found for gpt-5.4"},"request_id":"private"}',
    });
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mock image'),
    });
    await expect(page.locator('.thread-composer-inline-ref')).toContainText('diagram.png');
    await page.getByRole('button', { name: 'Send' }).click();
    const response = page.locator('.thread-agent-message-response');
    const error = response.locator('.thread-response-error');
    await expect(error).toHaveText('HTTP 404 - No endpoints found for gpt-5.4');
    await expect(response).not.toContainText('request_id');
    await response.hover();
    const actions = response.locator('.thread-response-actions');
    expect(await actions.getByRole('button').evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label'))
    ))).toEqual([
      // A failure the user did not cause leads with the way out of it.
      'Rerun turn',
      'Copy message',
      'Continue in new chat',
      'Open Trajectory',
    ]);
    const [errorBox, actionsBox] = await Promise.all([error.boundingBox(), actions.boundingBox()]);
    expect(errorBox).toBeTruthy();
    expect(actionsBox).toBeTruthy();
    expect(actionsBox!.y).toBeGreaterThanOrEqual(errorBox!.y + errorBox!.height - 1);
    await actions.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe('HTTP 404 - No endpoints found for gpt-5.4');

    const userMessage = page.locator('.thread-user-message').last();
    await expect(userMessage.locator('.thread-message-file-ref')).toHaveText('diagram.png');
    await expect(userMessage.locator('.thread-image-gallery-preview')).toHaveAccessibleName('diagram.png');
    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Edit message' }).click();
    const editor = userMessage.getByRole('textbox', { name: 'Edit message' });
    await editor.fill('Try the attachment again');
    await editor.press('Control+Enter');

    const calls = await commandCalls(page);
    const submissions = calls.filter((call) => call.cmd === 'turn/submit');
    const starts = calls.filter((call) => call.cmd === 'turn/start');
    expect(submissions).toHaveLength(2);
    expect(starts).toHaveLength(0);
    expect(submissions.at(-1)?.args.input).toEqual([
      { type: 'text', text: 'Try the attachment again' },
      expect.objectContaining({ type: 'attachment', name: 'diagram.png', mimeType: 'image/png' }),
    ]);
    expect(calls.filter((call) => call.cmd === 'thread/rollback')).toHaveLength(1);
    expect(calls.filter((call) => call.cmd === 'thread/fork')).toHaveLength(0);
  });

  test('reruns a failed Turn without renderer rollback or resubmission', async ({ page }) => {
    await openMockedApp(page, { agentTurnFailure: 'Mock provider failure' });
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Rerun this canonical request');
    await page.getByRole('button', { name: 'Send' }).click();

    const response = page.locator('.thread-agent-message-response').last();
    await expect(response.locator('.thread-response-error')).toHaveText('Mock provider failure');
    const failedRow = page.locator('[data-thread-turn-row]').filter({ has: response });
    const failedTurnId = await failedRow.getAttribute('data-thread-turn-row');
    expect(failedTurnId).toBeTruthy();
    await response.hover();
    await response.getByRole('button', { name: 'Rerun turn' }).click();

    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'turn/rerun').length
    )).toBe(1);
    await expect(page.locator(`[data-thread-turn-row="${failedTurnId}"]`)).toHaveCount(0);
    await expect(page.getByLabel('Assistant is responding')).toBeVisible();
    const calls = await commandCalls(page);
    expect(calls.filter((call) => call.cmd === 'turn/rerun')).toEqual([{
      cmd: 'turn/rerun',
      args: { threadId: expect.any(String), turnId: failedTurnId, confirmToolReplay: false },
    }]);
    expect(calls.filter((call) => call.cmd === 'thread/rollback')).toHaveLength(0);
    expect(calls.filter((call) => call.cmd === 'turn/submit')).toHaveLength(1);
  });

  test('continues from settled failed evidence by appending a linked Turn', async ({ page }) => {
    await openMockedApp(page, {
      agentTurnFailure: 'Mock provider failure',
      agentTurnFailureHasResponse: true,
    });
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Preserve the settled result');
    await composer.press('Enter');
    const failedRow = page.locator('[data-thread-turn-row]').last();
    await expect(failedRow).toContainText('Mock provider failure');
    const failedTurnId = await failedRow.getAttribute('data-thread-turn-row');
    expect(failedTurnId).not.toBeNull();

    await failedRow.getByRole('button', { name: 'Continue from failure' }).click();

    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'turn/continue').length
    )).toBe(1);
    await expect(page.locator(`[data-thread-turn-row="${failedTurnId}"]`)).toBeVisible();
    await expect(page.getByLabel('Assistant is responding')).toBeVisible();
    expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/continue')).toEqual([{
      cmd: 'turn/continue',
      args: { threadId: expect.any(String), turnId: failedTurnId },
    }]);
  });

  test('keeps an interrupted partial response without recovery or Regenerate', async ({ page }) => {
    await openMockedApp(page);
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000fa01';
      const userItemId = '01910000-0000-7000-8000-00000000fa02';
      const responseItemId = '01910000-0000-7000-8000-00000000fa03';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userItemId,
              type: 'userMessage',
              author: { kind: 'reader' },
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: userItemId },
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Stop after a partial answer.' }],
            },
            {
              id: responseItemId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: responseItemId },
              text: 'This partial answer remains visible.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'interrupted',
          error: null,
          startedAt: 10,
          completedAt: 20,
          durationMs: 10,
        },
      });
    });

    const response = page.locator('.thread-agent-message').last();
    await expect(response).toContainText('This partial answer remains visible.');
    await expect(response.locator('.thread-response-stopped')).toHaveText('Turn interrupted');
    await response.hover();
    await expect(response.getByRole('button', { name: 'Rerun turn' })).toHaveCount(0);
    await expect(response.getByRole('button', { name: 'Regenerate response' })).toHaveCount(0);
    await expect(response.getByRole('button', { name: 'Continue in new chat' })).toBeVisible();
  });
});
