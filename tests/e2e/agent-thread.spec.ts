import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { emulateVisualMedia, resolveTokenColor } from './emulatedMedia';
import { clipboardText, commandCalls, ids, openMockedApp, rowBody } from './outlinerMock';
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

  test('renders used Memory as an inline Node reference while keeping node_read in the process', async ({ page }) => {
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
              tool: 'node_read',
              arguments: { node_id: memoryNodeId },
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'node_read' },
                providerName: 'node_read',
                arguments: { storage: 'inline', value: { node_id: memoryNodeId } },
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
              text: `I kept the response concise based on [[node:Saved preference^${memoryNodeId}]].`,
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
    }, { memoryNodeId: ids.today });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    const answer = turn.locator('.thread-agent-message-final_answer');
    await expect(answer).toBeVisible();
    await expect(answer.getByRole('link', { name: 'Saved preference' })).toBeVisible();
    await expect(turn.locator('.thread-memory-citations')).toHaveCount(0);
    await expect(turn.getByText('Used memory')).toHaveCount(0);
    const process = turn.locator('.thread-speaker');
    await process.getByRole('button', { name: 'Worked for 1s' }).click();
    // The row stays in the process, but says what it did rather than which tool
    // was called.
    await expect(process.locator('.thread-tool').filter({ hasText: 'Read' })).toBeVisible();
    await expect(process).not.toContainText('node_read');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.mouse.move(0, 0);
    await expect(answer.getByRole('link', { name: 'Saved preference' })).toBeVisible();
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
      const first = items[0]?.getBoundingClientRect();
      const second = items[1]?.getBoundingClientRect();
      return {
        clientWidth: tray.clientWidth,
        firstWidth: first?.width ?? 0,
        rowTops: new Set(items.map((item) => Math.round(item.getBoundingClientRect().top))).size,
        scrollWidth: tray.scrollWidth,
        secondVisible: second ? Math.max(0, Math.min(trayRect.right, second.right) - Math.max(trayRect.left, second.left)) : 0,
      };
    });
    expect(trayGeometry.rowTops).toBe(1);
    expect(trayGeometry.firstWidth).toBeGreaterThanOrEqual(170);
    expect(trayGeometry.secondVisible).toBeGreaterThan(24);
    expect(trayGeometry.scrollWidth).toBeGreaterThan(trayGeometry.clientWidth);
    await expect(page.getByRole('button', { name: 'Show more attachments' })).toBeVisible();
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

  test('converts a large plain-text paste into a managed attachment at its marker position', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Before ');
    const pastedText = `large pasted body\n${'x'.repeat(4 * 1024)}`;
    await pasteComposerText(page, pastedText);

    const marker = page.locator('.thread-composer-inline-ref[data-thread-file-ref]');
    await expect(marker).toContainText('pasted-content.txt');
    await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
    await expect(page.locator('.thread-composer-attachment-excerpt')).toContainText('large pasted body');
    expect(await composer.textContent()).not.toContain('x'.repeat(1_000));
    await page.getByRole('button', { name: 'Send' }).click();

    const submit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(submit?.args.input).toEqual([
      { type: 'text', text: 'Before' },
      expect.objectContaining({
        type: 'attachment',
        id: expect.any(String),
        name: 'pasted-content.txt',
        mimeType: 'text/plain',
        source: expect.objectContaining({ kind: 'threadPayload' }),
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
    await expect(markers.nth(0)).toContainText('pasted-content.txt');
    await expect(markers.nth(1)).toContainText('pasted-content-2.txt');
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
      'pasted-content.txt',
      'pasted-content-2.txt',
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
      kind: 'threadPayload',
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

  test('opens a resumable Agent in place without switching the root conversation', async ({ page }) => {
    await createNewThread(page);
    const childId = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const child = {
        ...root,
        id: '01910000-0000-7000-8000-00000000dd01',
        parentThreadId: root.id,
        agentNickname: 'research',
        agentRole: 'explorer',
        name: 'Research child',
        source: 'collaboration',
        threadSource: 'subagent',
        updatedAt: Number(root.updatedAt) + 1,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'thread/started', threadId: child.id, thread: child });
      const turnId = '01910000-0000-7000-8000-00000000dd02';
      const itemId = '01910000-0000-7000-8000-00000000dd03';
      const callId = '01910000-0000-7000-8000-00000000dd04';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: root.id,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: callId,
            type: 'collabAgentToolCall',
            provenance: { originThreadId: root.id, originTurnId: turnId, originItemId: callId },
            tool: 'agent',
            status: 'completed',
            outputRef: null,
            senderThreadId: root.id,
            receiverThreadIds: [child.id],
            prompt: 'Research the deployment',
            summary: null,
            model: null,
            reasoningEffort: null,
            agentsStates: {},
            modelCall: null,
          }, {
            id: itemId,
            type: 'subAgentActivity',
            provenance: { originThreadId: root.id, originTurnId: turnId, originItemId: itemId },
            kind: 'started',
            agentThreadId: child.id,
            agentTurnId: null,
            agentPath: '/root/research',
            error: null,
            spawnItemId: callId,
          }],
          itemsView: 'full',
          provenance: { originThreadId: root.id, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
      return child.id;
    });

    const parentTitle = await page.locator('.thread-dock-title').innerText();
    const chip = page.getByRole('button', { name: /^Open research/u });

    // The chip is a way in, not a disclosure: opening pushes a view rather than
    // expanding a region, so nothing about it claims an expandable slot.
    await expect(chip).not.toHaveAttribute('aria-expanded', /.*/u);
    const detail = page.locator('.thread-agent-detail');
    await expect(detail).toHaveCount(0);

    await chip.click();
    await expect(detail).toBeVisible();
    // The pushed level takes the title bar, and the list chevron goes with it:
    // there is nothing below that a conversation switch could act on.
    await expect(page.locator('.thread-dock-title')).toHaveText('research');
    await expect(page.locator('.thread-title-chevron')).toHaveCount(0);
    const childComposer = detail.getByRole('textbox', { name: 'Message this Thread' });
    await expect(childComposer).toBeVisible();
    await expect(detail.locator('.thread-composer-model-control')).toHaveCount(0);
    await childComposer.fill('/');
    await expect(detail.getByRole('listbox', { name: 'Thread slash commands' })).toHaveCount(0);
    await childComposer.fill('Continue with deployment logs.');
    await detail.getByRole('button', { name: 'Send' }).click();
    const childSubmit = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
    expect(childSubmit?.args).toMatchObject({
      threadId: childId,
      input: [{ type: 'text', text: 'Continue with deployment logs.' }],
    });
    expect(childSubmit?.args.userView).toBeDefined();
    // The mock settles the resumed Turn synchronously, so no Stop remains.
    await expect(detail.getByRole('button', { name: 'Interrupt Turn' })).toHaveCount(0);

    // Back returns the title bar, and the conversation, to the reader.
    await page.getByRole('button', { name: /^Back:/u }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.locator('.thread-dock-title')).toHaveText(parentTitle);
    await expect(chip).toBeVisible();

    // A child is an execution artifact, not a conversation: never a list row.
    await page.getByRole('button', { name: 'Show Threads' }).click();
    const list = page.getByRole('dialog', { name: 'Threads' });
    await expect(list.locator('.thread-list-row').filter({ hasText: 'Research child' })).toHaveCount(0);
    // Only the two root conversations this test created.
    await expect(list.locator('.thread-list-row')).toHaveCount(2);
    await expect(list.locator('.thread-list-row small').filter({ hasText: 'Subagent' })).toHaveCount(0);
  });

  test('drills root to depth three in one Subagent container and backs out one level at a time', async ({ page }) => {
    await createNewThread(page);
    const parentTurnCount = TRANSCRIPT_VIRTUAL_MIN_TURNS;
    const fixture = await page.evaluate(async (flowTurnCount) => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          emitAgentCoreNotification: (n: unknown) => void;
          setMockThreadTurns: (threadId: string, turns: readonly unknown[]) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const child = {
        ...root,
        id: '01910000-0000-7000-8000-00000000ea01',
        parentThreadId,
        agentNickname: null,
        agentRole: 'worker',
        name: 'research',
        source: 'collaboration',
        threadSource: 'subagent',
        status: { type: 'idle' },
      };
      const grandchild = {
        ...child,
        id: '01910000-0000-7000-8000-00000000ea02',
        parentThreadId: child.id,
        name: 'audit',
      };
      const greatGrandchild = {
        ...grandchild,
        id: '01910000-0000-7000-8000-00000000ea03',
        parentThreadId: grandchild.id,
        name: 'verify',
      };
      const sibling = {
        ...child,
        id: '01910000-0000-7000-8000-00000000ea04',
        name: 'review',
      };
      for (const thread of [child, grandchild, greatGrandchild, sibling]) {
        target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'thread/started', threadId: thread.id, thread });
      }
      const provenance = (threadId: string, turnId: string, itemId: string) => ({
        originThreadId: threadId, originTurnId: turnId, originItemId: itemId,
      });
      const researchCallId = '01910000-0000-7000-8000-00000000ecaa';
      // Enough parent Turns that the transcript scrolls at all, while staying
      // in flow layout so the offscreen Agent chip remains mounted.
      for (let index = 0; index < flowTurnCount; index += 1) {
        const turnId = `01910000-0000-7000-8000-0000000eb0${index.toString(16)}`;
        const itemId = `01910000-0000-7000-8000-0000000ec0${index.toString(16)}`;
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId: parentThreadId,
          turnId,
          turn: {
            id: turnId,
            items: index === flowTurnCount - 1
              ? [{
                  // The real shape: the delegating call is in the Turn and the
                  // spawn claims it, so the child's own Turn trigger names a
                  // call this conversation actually indexes.
                  id: researchCallId,
                  type: 'collabAgentToolCall',
                  provenance: provenance(parentThreadId, turnId, researchCallId),
                  tool: 'agent',
                  status: 'completed',
                  outputRef: null,
                  senderThreadId: parentThreadId,
                  receiverThreadIds: [child.id],
                  prompt: 'Investigate the deployment story.',
                  summary: null,
                  model: null,
                  reasoningEffort: null,
                  agentsStates: {},
                  modelCall: null,
                }, {
                  id: itemId,
                  type: 'subAgentActivity',
                  provenance: provenance(parentThreadId, turnId, itemId),
                  kind: 'started',
                  agentThreadId: child.id,
                  agentTurnId: null,
                  agentPath: '/root/research',
                  error: null,
                  spawnItemId: researchCallId,
                }, {
                  id: '01910000-0000-7000-8000-00000000ecff',
                  type: 'subAgentActivity',
                  provenance: provenance(
                    parentThreadId,
                    turnId,
                    '01910000-0000-7000-8000-00000000ecff',
                  ),
                  kind: 'started',
                  agentThreadId: sibling.id,
                  agentTurnId: null,
                  agentPath: '/root/review',
                  error: null,
                  spawnItemId: null,
                }]
              : [{
                  id: itemId,
                  type: 'agentMessage',
                  provenance: provenance(parentThreadId, turnId, itemId),
                  phase: 'final_answer',
                  text: `Answer ${index}\n\nwith enough body to give the transcript some height.`,
                }],
            itemsView: 'full',
            provenance: { originThreadId: parentThreadId, originTurnId: turnId, trigger: { kind: 'user' } },
            status: 'completed',
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
          },
        });
      }
      // The child's own transcript: a Turn a delegation started, so its "user"
      // message is the task the parent wrote. Seeded as canonical history, not
      // pushed as a notification — the drawer LOADS the child from the host.
      const childTurnId = '01910000-0000-7000-8000-00000000ed01';
      target.__LIN_E2E__?.setMockThreadTurns(child.id, [
        {
          id: childTurnId,
          items: [
            {
              id: '01910000-0000-7000-8000-00000000ed02',
              type: 'userMessage',
              provenance: provenance(child.id, childTurnId, '01910000-0000-7000-8000-00000000ed02'),
              content: [{ type: 'text', text: 'Investigate the deployment story.' }],
            },
            {
              id: '01910000-0000-7000-8000-00000000ed03',
              type: 'subAgentActivity',
              provenance: provenance(child.id, childTurnId, '01910000-0000-7000-8000-00000000ed03'),
              kind: 'started',
              agentThreadId: grandchild.id,
              agentTurnId: null,
              agentPath: '/root/research/audit',
              error: null,
              spawnItemId: null,
            },
            {
              id: '01910000-0000-7000-8000-00000000ed04',
              type: 'collabAgentToolCall',
              provenance: provenance(child.id, childTurnId, '01910000-0000-7000-8000-00000000ed04'),
              tool: 'agent_message',
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'agent_message' },
                providerName: 'agent_message',
                arguments: {
                  storage: 'inline',
                  value: { to: sibling.id, summary: 'ask for review', message: 'Review the evidence.' },
                },
                schemaDigest: '0'.repeat(64),
              },
              status: 'completed',
              outputRef: null,
              senderThreadId: child.id,
              receiverThreadIds: [sibling.id],
              prompt: 'Review the evidence.',
              summary: 'ask for review',
              model: null,
              reasoningEffort: null,
              agentsStates: {
                [sibling.id]: {
                  status: 'completed',
                  taskPath: '/root/review',
                  nickname: null,
                  role: 'worker',
                },
              },
            },
          ],
          itemsView: 'full',
          provenance: {
            originThreadId: child.id,
            originTurnId: childTurnId,
            trigger: { kind: 'subagent', parentThreadId, parentItemId: researchCallId },
          },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      ]);
      const grandchildTurnId = '01910000-0000-7000-8000-00000000ee01';
      target.__LIN_E2E__?.setMockThreadTurns(grandchild.id, [
        {
          id: grandchildTurnId,
          items: [
            {
              id: '01910000-0000-7000-8000-00000000ee02',
              type: 'userMessage',
              provenance: provenance(
                grandchild.id,
                grandchildTurnId,
                '01910000-0000-7000-8000-00000000ee02',
              ),
              content: [{ type: 'text', text: 'Audit the deployment evidence.' }],
            },
            {
              id: '01910000-0000-7000-8000-00000000ee03',
              type: 'subAgentActivity',
              provenance: provenance(
                grandchild.id,
                grandchildTurnId,
                '01910000-0000-7000-8000-00000000ee03',
              ),
              kind: 'started',
              agentThreadId: greatGrandchild.id,
              agentTurnId: null,
              agentPath: '/root/research/audit/verify',
              error: null,
              spawnItemId: null,
            },
          ],
          itemsView: 'full',
          provenance: {
            originThreadId: grandchild.id,
            originTurnId: grandchildTurnId,
            trigger: { kind: 'subagent', parentThreadId: child.id, parentItemId: 'spawn-audit' },
          },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      ]);
      target.__LIN_E2E__?.setMockThreadTurns(greatGrandchild.id, []);
      target.__LIN_E2E__?.setMockThreadTurns(sibling.id, []);
      return { parentThreadId };
    }, parentTurnCount);

    // Scrolled by hand, so the transcript stops following the tail the way it
    // would for a reader who scrolled up to re-read something.
    const scroll = page.locator('.thread-transcript');
    await scroll.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => scroll.evaluate((element) => element.scrollTop))
      .toBeLessThan(await scroll.evaluate((element) => element.scrollHeight - element.clientHeight));
    // Proof the reader is genuinely off the tail: the jump-to-latest affordance
    // only exists when the transcript has stopped following.
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    const deckTitle = page.locator('.thread-dock-title');
    const conversationTitle = (await deckTitle.textContent()) ?? '';
    expect(conversationTitle).not.toBe('');

    await page.getByRole('button', { name: /^Open research/u }).click();
    const detail = page.locator('.thread-agent-detail');
    await expect(detail).toBeVisible();
    // The pushed level owns the title bar, and Back names the level below — so
    // position in the stack is legible rather than inferred. At depth one that
    // level is the conversation, and Back says its name: falling back to the
    // Back label read `Back: Back` for the commonest case there is.
    await expect(deckTitle).toHaveText('research');
    await expect(page.getByRole('button', { name: `Back: ${conversationTitle}` })).toBeVisible();

    // Host-authored child input is an Agent event rather than a user bubble.
    // The child can receive new direction, but its existing history cannot be
    // rewritten or forked through root-only actions.
    // The brief the parent wrote, named as the task it is — not as an "event",
    // which is what a peer Agent's message to a conversation is.
    // Position is identity: the brief leaves the reader's own slot and becomes
    // prose under the avatar and name of the Agent that wrote it, so "main asked
    // this" never rides on a hover.
    const brief = detail.locator('.thread-user-message.thread-host-event');
    await expect(brief).toContainText('Investigate the deployment story.');
    const briefSpeaker = detail.locator('.thread-speaker').first();
    await expect(briefSpeaker.locator('.thread-user-message.thread-host-event')).toHaveCount(1);
    await expect(briefSpeaker.locator('.thread-speaker-name')).toHaveText('main');
    // Every participant wears the same generated mark; identity is its COLOUR,
    // and here it must be the same colour `main` wears out in the conversation.
    // `main` is keyed by NAME everywhere, not by the conversation's Thread id:
    // keyed by id, the one participant that is always there would wear a
    // different hue inside a pushed view than in the conversation the reader
    // had just left.
    expect(await briefSpeaker.locator('.thread-speaker-avatar').evaluate((avatar) => {
      const hue = (root: Element | null | undefined): string => {
        const shape = root?.querySelector('svg path[mask]');
        return shape === null || shape === undefined ? '' : getComputedStyle(shape).fill;
      };
      const outside = [...document.querySelectorAll('.thread-dock-conversation .thread-speaker')]
        .map((group) => ({
          name: group.querySelector('.thread-speaker-name')?.textContent,
          fill: hue(group.querySelector('.thread-speaker-avatar')),
        }))
        .find((speaker) => speaker.name === 'main');
      if (outside === undefined) throw new Error('Expected a main speaker in the conversation');
      const inside = hue(avatar);
      // A resolved paint, not an unresolved token: an empty or `none` fill
      // would pass a naive equality check while drawing nothing.
      if (!inside.startsWith('rgb')) throw new Error(`Expected a resolved mark fill, got ${inside}`);
      return inside === outside.fill;
    })).toBe(true);
    // The pushed view names participants exactly as the conversation does: an
    // Agent that answers to its type out there cannot answer to its task
    // description in here, or its mark changes hue on the way in. The TITLE bar
    // is the other job — which Agent this is — so it keeps the task, the way a
    // chip does.
    await expect(detail.locator('.thread-speaker-name').last()).toHaveText('worker');
    // Keyed by TYPE, so a delegate's hue is its own and not the conversation's.
    expect(await detail.evaluate((root) => {
      const hue = (group: Element | null): string => {
        const shape = group?.querySelector('.thread-speaker-avatar svg path[mask]');
        return shape === null || shape === undefined ? '' : getComputedStyle(shape).fill;
      };
      const groups = [...root.querySelectorAll('.thread-speaker')];
      const worker = groups.at(-1) ?? null;
      const brief = groups[0] ?? null;
      return { worker: hue(worker), brief: hue(brief) };
    })).toEqual({ worker: expect.stringMatching(/^rgb/u), brief: expect.stringMatching(/^rgb/u) });
    await expect(deckTitle).toHaveText('research');

    await expect(detail.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Continue in new chat' })).toHaveCount(0);

    // D2 pushes ANOTHER level of the same view — one viewport, one scroll
    // region, depth said in the header rather than drawn as indentation.
    await detail.getByRole('button', { name: /^Open audit/u }).click();
    await expect(detail).toHaveCount(1);
    await expect(deckTitle).toHaveText('audit');
    await expect(page.getByRole('button', { name: 'Back: research' })).toBeVisible();

    // Two participants of ONE type stay two speakers. The brief here was
    // written by a `worker` parent and the work below it belongs to a `worker`
    // child: merged on type, the child's header swallowed its parent's words
    // and hung its own elapsed over them.
    await expect(detail.locator('.thread-speaker')).toHaveCount(2);
    await expect(detail.locator('.thread-speaker').first())
      .toContainText('Audit the deployment evidence.');
    await expect(detail.locator('.thread-speaker').first().locator('.thread-speaker-meta'))
      .toHaveCount(0);
    await expect(detail.locator('.thread-speaker-name')).toHaveText(['worker', 'worker']);

    await detail.getByRole('button', { name: /^Open verify/u }).click();
    await expect(detail).toHaveCount(1);
    await expect(deckTitle).toHaveText('verify');
    await expect(page.getByRole('button', { name: 'Back: audit' })).toBeVisible();

    // Back unwinds the stack one level at a time: d3 -> d2 -> d1 -> conversation.
    await page.getByRole('button', { name: 'Back: audit' }).click();
    await expect(deckTitle).toHaveText('audit');
    await page.getByRole('button', { name: 'Back: research' }).click();
    await expect(deckTitle).toHaveText('research');

    // agent_message may address a sibling, but reachability is not lineage.
    // The sibling opens at ITS own level; the stack must never draw a
    // research -> review edge that the delegation graph does not have.
    await detail.getByRole('button', { name: /^Open review/u }).click();
    await expect(deckTitle).toHaveText('review');
    await expect(page.getByRole('button', { name: `Back: ${conversationTitle}` })).toBeVisible();
    await page.getByRole('button', { name: `Back: ${conversationTitle}` }).click();
    await expect(detail).toHaveCount(0);
  });

  test('browses and cleans up Subagents from parent Thread Details', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          createMockSubagentThread: (input: {
            parentThreadId: string;
            name: string;
            active?: boolean;
            queuedWork?: boolean;
          }) => { id: string };
          emitAgentCoreNotification: (notification: unknown) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const parentThreadId = response?.data[0]?.id;
      if (!parentThreadId) throw new Error('Mock Thread not found');
      const finished = target.__LIN_E2E__?.createMockSubagentThread({ parentThreadId, name: 'finished worker' });
      (window as Window & { __LIN_E2E_FINISHED_ID__?: string }).__LIN_E2E_FINISHED_ID__ = finished?.id;
      const live = target.__LIN_E2E__?.createMockSubagentThread({
        parentThreadId,
        name: 'live worker',
        active: true,
      });
      target.__LIN_E2E__?.createMockSubagentThread({ parentThreadId, name: 'queued worker', queuedWork: true });
      // A child is read from the delegation row that spawned it, which is what
      // production records for every delegated form — so the Turn that
      // delegated has to carry one here too.
      const turnId = '01910000-0000-7000-8000-00000000f101';
      const itemId = '01910000-0000-7000-8000-00000000f102';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parentThreadId, originTurnId: turnId, originItemId: itemId },
            kind: 'started',
            agentThreadId: live!.id,
            agentPath: '/root/live_worker',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });

    // A live descendant is the only thing the list says about children now.
    await page.getByRole('button', { name: 'Show Threads' }).click();
    const list = page.getByRole('dialog', { name: 'Threads' });
    await expect(list.locator('.thread-list-row.is-selected .thread-list-activity')).toBeVisible();
    await expect(list.locator('.thread-list-row')).toHaveCount(2);
    await page.keyboard.press('Escape');

    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Thread Details' }).click();
    const details = page.getByRole('dialog', { name: 'Thread Details' });
    await expect(details.locator('.thread-details-subagent')).toHaveCount(3);
    await expect(details.getByRole('button', { name: 'Open live worker' })).toContainText('Running');
    await expect(details.getByRole('button', { name: 'Open finished worker' })).toContainText('Idle');
    // Idle is not finished: this child is holding work the parent handed over.
    await expect(details.getByRole('button', { name: 'Open queued worker' })).toContainText('Work queued');

    // The dialog does not subscribe to the store, so the decision is re-taken
    // against a fresh read on confirm: this child starts running in between.
    await details.getByRole('button', { name: 'Delete finished Subagents' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete finished Subagents' });
    await expect(confirm).toContainText('Delete 1 finished Subagent and its child Threads?');
    await page.evaluate(() => {
      const target = window as Window & {
        __LIN_E2E__?: { setMockThreadActive: (threadId: string, active: boolean) => void };
        __LIN_E2E_FINISHED_ID__?: string;
      };
      if (target.__LIN_E2E_FINISHED_ID__) {
        target.__LIN_E2E__?.setMockThreadActive(target.__LIN_E2E_FINISHED_ID__, true);
      }
    });
    await confirm.getByRole('button', { name: 'Delete Thread' }).click();
    // Nothing was deleted: every child was busy by the time it was confirmed.
    await expect(details.locator('.thread-details-subagent')).toHaveCount(3);
    await expect(details.getByRole('button', { name: 'Open finished worker' })).toContainText('Running');

    // Now let it settle and sweep for real.
    await page.evaluate(() => {
      const target = window as Window & {
        __LIN_E2E__?: { setMockThreadActive: (threadId: string, active: boolean) => void };
        __LIN_E2E_FINISHED_ID__?: string;
      };
      if (target.__LIN_E2E_FINISHED_ID__) {
        target.__LIN_E2E__?.setMockThreadActive(target.__LIN_E2E_FINISHED_ID__, false);
      }
    });
    await details.getByRole('button', { name: 'Delete finished Subagents' }).click();
    await page.getByRole('dialog', { name: 'Delete finished Subagents' })
      .getByRole('button', { name: 'Delete Thread' }).click();
    await expect(details.locator('.thread-details-subagent')).toHaveCount(2);
    await expect(details.getByRole('button', { name: 'Open finished worker' })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Open live worker' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Open queued worker' })).toBeVisible();

    // Details is a browse surface, so its rows land where the transcript rows
    // do — including opening the process fold the row sits inside, which a
    // settled Turn keeps shut. Expanding only the leaf would write a key
    // nothing reads, and nothing would appear on screen.
    await details.getByRole('button', { name: 'Open live worker' }).click();
    const detail = page.locator('.thread-agent-detail');
    await expect(detail).toBeVisible();
    await expect(page.locator('.thread-dock-title')).toHaveText('live worker');
  });
  test('shows a live isolated Skill child and keeps nested Thread motion independent', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000df01';
      const skillItemId = '01910000-0000-7000-8000-00000000df02';
      const activityId = '01910000-0000-7000-8000-00000000df03';
      const childId = '01910000-0000-7000-8000-00000000df10';
      const childTurnId = '01910000-0000-7000-8000-00000000df11';
      const childReasoningId = '01910000-0000-7000-8000-00000000df12';
      const taskPath = '/root/skill_research_ab12cd34ef56';
      const startedAt = Date.now() - 5_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'explorer',
          name: null,
          // The distinguishing bit: a delegated child that is NOT collaboration.
          source: 'agent.skill',
          threadSource: 'subagent',
          status: { type: 'active', activeFlags: [] },
          updatedAt: startedAt,
        },
      });
      // The host records the Skill's own name on its execution row, which is
      // what every surface reads; the task path is an address, not a name.
      target.__LIN_E2E__?.setMockSubagentExecution(childId, { description: 'research' });
      const childTurn = {
        id: childTurnId,
        items: [{
          id: childReasoningId,
          type: 'reasoning',
          provenance: {
            originThreadId: childId,
            originTurnId: childTurnId,
            originItemId: childReasoningId,
          },
          summary: ['Inspecting the delegated evidence'],
          content: [],
        }],
        itemsView: 'full',
        provenance: {
          originThreadId: childId,
          originTurnId: childTurnId,
          trigger: { kind: 'subagent', parentThreadId, parentItemId: skillItemId },
        },
        status: 'inProgress',
        error: null,
        startedAt,
        completedAt: null,
        durationMs: null,
      };
      target.__LIN_E2E__?.setMockThreadTurns(childId, [childTurn]);
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: childId,
        turnId: childTurnId,
        turn: childTurn,
      });
      const provenance = (itemId: string) => ({
        originThreadId: parentThreadId,
        originTurnId: parentTurnId,
        originItemId: itemId,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: [
            {
              id: activityId,
              type: 'subAgentActivity',
              provenance: provenance(activityId),
              kind: 'started',
              agentThreadId: childId,
              agentPath: taskPath,
              error: null,
              spawnItemId: null,
            },
            {
              id: skillItemId,
              type: 'dynamicToolCall',
              provenance: provenance(skillItemId),
              namespace: null,
              tool: 'skill',
              arguments: { name: 'research' },
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'skill' },
                providerName: 'skill',
                arguments: { storage: 'inline', value: { name: 'research' } },
                schemaDigest: '0'.repeat(64),
              },
              contentItems: null,
              status: 'inProgress',
              success: null,
              durationMs: null,
              outputRef: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { childId, childTurnId, parentTurnId, taskPath };
    });

    const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
    // One chip per delegated child, live, in the delegating call's slot.
    const skillLine = parentTurn.locator('.thread-agent-chip-line');
    await expect(skillLine).toHaveCount(1);
    await expect(skillLine.locator('.thread-agent-chip-name')).toHaveText('research');
    await expect(skillLine.locator('.thread-agent-chip-meta')).toContainText(/^\d+[smhd]/u);
    // A Skill is not an Agent type, so nothing names one — not even the title,
    // which is where an Agent's type lives now.
    await expect(skillLine.locator('.thread-agent-chip'))
      .toHaveAttribute('title', /^research · \d+[smhd] · waiting for it$/u);
    const skillRow = skillLine.getByRole('button', { name: /Open research/u });
    // No wait is in flight, so the divider must not claim to be waiting on it.
    await expect(parentTurn.locator('.thread-process-title')).toContainText(/Working for \d+[smhd]/u);

    // The parent's own live cue belongs to the more specific representation:
    // the Skill tool row that is running, not the Turn summary above it.
    const parentSkillSweep = parentTurn.locator('.thread-tool-inProgress .working-text-base');
    await expect(parentSkillSweep).toHaveCSS('animation-name', 'working-text-sweep');

    await skillRow.click();
    const detail = page.locator('.thread-agent-detail');
    await expect(detail).toBeVisible();
    // A Skill takes no direction: its result is owned by the call that invoked it.
    await expect(detail.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);
    // One mover, on the most specific row that is working. The header states
    // the same status and stays still, so the pushed view never says the work
    // is advancing twice.
    await expect(detail.locator('.thread-agent-detail-status .working-text')).toHaveCount(0);
    await expect(detail.locator('.thread-streaming-shape')).toHaveCSS('animation-name', 'thread-shape-spin');

    await page.evaluate(({ childId, childTurnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/providerRetry/changed',
        threadId: childId,
        turnId: childTurnId,
        status: { kind: 'stream', attempt: 1, maxRetries: 3 },
      });
    }, fixture);
    await expect(detail.locator('.thread-provider-retry')).toHaveText('Reconnecting 1/3');
  });


  test('keeps one live row per child, stops one from its row, and leaves the rest running', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000fa01';
      const startedAt = Date.now() - 4_000;
      const children = [
        {
          id: '01910000-0000-7000-8000-00000000fa10',
          turnId: '01910000-0000-7000-8000-00000000fa11',
          activityId: '01910000-0000-7000-8000-00000000fa12',
          taskPath: '/root/research',
          description: 'research',
        },
        {
          id: '01910000-0000-7000-8000-00000000fa20',
          turnId: '01910000-0000-7000-8000-00000000fa21',
          activityId: '01910000-0000-7000-8000-00000000fa22',
          taskPath: '/root/audit',
          description: 'audit',
        },
      ];
      for (const child of children) {
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'thread/started',
          threadId: child.id,
          thread: {
            ...root,
            id: child.id,
            parentThreadId,
            agentNickname: null,
            agentRole: 'worker',
            name: null,
            source: 'collaboration',
            threadSource: 'subagent',
            status: { type: 'active', activeFlags: [] },
            updatedAt: startedAt,
          },
        });
        target.__LIN_E2E__?.setMockSubagentExecution(child.id, {
          description: child.description,
          currentTurnId: child.turnId,
        });
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/started',
          threadId: child.id,
          turnId: child.turnId,
          turn: {
            id: child.turnId,
            items: [],
            itemsView: 'full',
            provenance: {
              originThreadId: child.id,
              originTurnId: child.turnId,
              trigger: { kind: 'subagent', parentThreadId, parentItemId: child.activityId },
            },
            status: 'inProgress',
            error: null,
            startedAt,
            completedAt: null,
            durationMs: null,
          },
        });
      }
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: children.map((child) => ({
            id: child.activityId,
            type: 'subAgentActivity',
            provenance: {
              originThreadId: parentThreadId,
              originTurnId: parentTurnId,
              originItemId: child.activityId,
            },
            kind: 'started',
            agentThreadId: child.id,
            agentPath: child.taskPath,
            error: null,
            spawnItemId: null,
          })),
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { children, parentThreadId, parentTurnId };
    });

    // Live: one chip per child, in the timeline, with no second presentation.
    const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
    const rows = parentTurn.locator('.thread-agent-chip-line');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.thread-agent-chip-meta').first()).toContainText(/^\d+[smhd]/u);

    // Stop one child from its row; the other keeps running.
    await parentTurn.getByRole('button', { name: 'Stop research' }).click();
    const interrupts = (await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt');
    expect(interrupts.at(-1)?.args).toEqual({
      threadId: fixture.children[0]!.id,
      turnId: fixture.children[0]!.turnId,
    });
    await expect(parentTurn.locator('.thread-agent-chip-block.thread-subagent-interrupted')).toHaveCount(1);
    await expect(parentTurn.getByRole('button', { name: 'Stop audit' })).toBeVisible();
    await expect(parentTurn.getByRole('button', { name: 'Stop research' })).toHaveCount(0);

    // The last child settles in place: same rows, same slots, new status.
    await page.evaluate((child) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: child.id,
        turnId: child.turnId,
        turn: {
          id: child.turnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: child.id,
            originTurnId: child.turnId,
            trigger: { kind: 'subagent', parentThreadId: child.parentThreadId, parentItemId: child.activityId },
          },
          status: 'completed',
          error: null,
          startedAt: Date.now() - 2_000,
          completedAt: Date.now(),
          durationMs: 2_000,
        },
      });
    }, { ...fixture.children[1]!, parentThreadId: fixture.parentThreadId });

    await expect(rows).toHaveCount(2);
    await expect(parentTurn.locator('.thread-agent-chip-block.thread-subagent-finished')).toHaveCount(1);
    await expect(parentTurn.getByRole('button', { name: /^Stop / })).toHaveCount(0);
  });

  test('shows background work in the strip only while there is any, and stops one from it', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          emitAgentCoreNotification: (n: unknown) => void;
          setMockSubagentExecution: (agentId: string, patch: Record<string, unknown>) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const childId = '01910000-0000-7000-8000-00000000fb10';
      const childTurnId = '01910000-0000-7000-8000-00000000fb11';
      const startedAt = Date.now() - 3_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'worker',
          name: null,
          source: 'collaboration',
          threadSource: 'subagent',
          status: { type: 'active', activeFlags: [] },
          updatedAt: startedAt,
        },
      });
      target.__LIN_E2E__?.setMockSubagentExecution(childId, { description: 'survey the runtime' });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: childId,
        turnId: childTurnId,
        turn: {
          id: childTurnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: childId,
            originTurnId: childTurnId,
            trigger: { kind: 'subagent', parentThreadId, parentItemId: 'spawn' },
          },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { childId, childTurnId, parentThreadId };
    });

    // Ambient, not archival: one pill, only while this conversation has live
    // background work.
    const pill = page.locator('.thread-work-strip-pill');
    await expect(pill).toHaveText('1 running');
    await pill.click();
    const row = page.locator('.thread-work-strip-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.thread-work-strip-name')).toHaveText('survey the runtime');

    // The strip's Stop reaches that Agent alone, addressed at its own Turn.
    await row.getByRole('button', { name: 'Stop survey the runtime' }).click();
    const interrupts = (await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt');
    expect(interrupts.at(-1)?.args).toEqual({
      threadId: fixture.childId,
      turnId: fixture.childTurnId,
    });
    await expect(pill).toHaveText('Just finished');

    // Foreground work never enters the strip: it belongs to the Turn it blocks.
    await page.evaluate((childId) => {
      const target = window as Window & {
        __LIN_E2E__?: { setMockSubagentExecution: (agentId: string, patch: Record<string, unknown>) => void };
      };
      target.__LIN_E2E__?.setMockSubagentExecution(childId, { runMode: 'foreground' });
    }, fixture.childId);
    await expect(page.locator('.thread-work-strip')).toHaveCount(0);
  });

  test('never folds a settled Turn over a child that is still running', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000fc01';
      const activityId = '01910000-0000-7000-8000-00000000fc03';
      const answerId = '01910000-0000-7000-8000-00000000fc04';
      const childId = '01910000-0000-7000-8000-00000000fc10';
      const childTurnId = '01910000-0000-7000-8000-00000000fc11';
      const startedAt = Date.now() - 6_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'worker',
          name: 'research',
          source: 'collaboration',
          threadSource: 'subagent',
          status: { type: 'active', activeFlags: [] },
          updatedAt: startedAt,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: childId,
        turnId: childTurnId,
        turn: {
          id: childTurnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: childId,
            originTurnId: childTurnId,
            trigger: { kind: 'subagent', parentThreadId, parentItemId: activityId },
          },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      const provenance = (itemId: string) => ({
        originThreadId: parentThreadId,
        originTurnId: parentTurnId,
        originItemId: itemId,
      });
      const parentItems = [
            {
              id: activityId,
              type: 'subAgentActivity',
              provenance: provenance(activityId),
              kind: 'started',
              agentThreadId: childId,
              agentTurnId: childTurnId,
              agentPath: '/root/research',
              error: null,
              // This test's subject is the fold, not the stand-in: the call that
              // delegated is out of scope here and covered elsewhere.
              spawnItemId: null,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: provenance(answerId),
              phase: 'final_answer',
              memoryCitation: null,
              text: 'Delegated and answered.',
            },
      ];
      const parentTurn = (status: string, settled: boolean) => ({
        id: parentTurnId,
        items: parentItems,
        itemsView: 'full',
        provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
        status,
        error: null,
        startedAt,
        completedAt: settled ? Date.now() : null,
        durationMs: settled ? 6_000 : null,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: parentTurn('inProgress', false),
      });
      // The parent answers and settles while its child keeps working — the
      // fire-and-forget shape whose terminal activity lands in a LATER Turn.
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: parentTurn('completed', true),
      });
      return { activityId, childId, childTurnId, parentThreadId, parentTurnId };
    });

    // The fold defaults to closed, so folding here would hide the only signal
    // that a subagent is still burning time and the only Stop that reaches it.
    const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
    const row = parentTurn.locator('.thread-agent-chip-line');
    await expect(row).toBeVisible();
    await expect(row.locator('.thread-agent-chip-meta')).toContainText(/^\d+[smhd]/u);
    await expect(parentTurn.getByRole('button', { name: 'Stop research' })).toBeVisible();
    await expect(parentTurn.locator('.thread-process-toggle')).toHaveCount(0);

    // Once it settles the Turn is ordinary history again, and folds.
    await page.evaluate((child) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: child.childId,
        turnId: child.childTurnId,
        turn: {
          id: child.childTurnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: child.childId,
            originTurnId: child.childTurnId,
            trigger: { kind: 'subagent', parentThreadId: child.parentThreadId, parentItemId: child.activityId },
          },
          status: 'completed',
          error: null,
          startedAt: Date.now() - 192_000,
          completedAt: Date.now(),
          durationMs: 192_000,
        },
      });
    }, fixture);

    // Ordinary history now: the Turn folds, and the row is behind the fold with
    // the settled span its own Turn recorded rather than a clock it no longer has.
    await expect(parentTurn.locator('.thread-process-toggle')).toHaveCount(1);
    await expect(row).toHaveCount(0);
    await parentTurn.locator('.thread-process-toggle').click();
    await expect(row.locator('.thread-agent-chip-meta')).toHaveText('Finished · 3m 12s');
  });

  test('delivers a result as the Agent\'s own folded message, never the host notification', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          emitAgentCoreNotification: (n: unknown) => void;
          setMockSubagentExecution: (agentId: string, patch: Record<string, unknown>) => void;
          setMockThreadTurns: (threadId: string, turns: readonly unknown[]) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-000000004a01';
      const callId = '01910000-0000-7000-8000-000000004a06';
      const activityId = '01910000-0000-7000-8000-000000004a02';
      const deliveryTurnId = '01910000-0000-7000-8000-000000004a03';
      const noticeId = '01910000-0000-7000-8000-000000004a04';
      const settledActivityId = '01910000-0000-7000-8000-000000004a08';
      const evidenceId = '01910000-0000-7000-8000-000000004a09';
      const proseId = '01910000-0000-7000-8000-000000004a05';
      const childId = '01910000-0000-7000-8000-000000004a10';
      const childTurnId = '01910000-0000-7000-8000-000000004a11';
      const childAnswerId = '01910000-0000-7000-8000-000000004a12';
      const startedAt = Date.now() - 4_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'worker',
          name: null,
          source: 'collaboration',
          threadSource: 'subagent',
          status: { type: 'idle' },
          updatedAt: startedAt,
        },
      });
      target.__LIN_E2E__?.setMockSubagentExecution(childId, {
        description: 'research',
        currentTurnId: childTurnId,
      });
      const childProvenance = {
        originThreadId: childId,
        originTurnId: childTurnId,
        trigger: { kind: 'subagent', parentThreadId, parentItemId: callId },
      };
      const childTurn = {
        id: childTurnId,
        items: [{
          id: childAnswerId,
          type: 'agentMessage',
          provenance: { originThreadId: childId, originTurnId: childTurnId, originItemId: childAnswerId },
          text: [
            'The rollout order is safe.',
            ...Array.from({ length: 12 }, (_, index) => `Evidence line ${index + 1}.`),
          ].join('\n\n'),
          phase: 'final_answer',
          memoryCitation: null,
        }],
        itemsView: 'full',
        provenance: childProvenance,
        status: 'completed',
        error: null,
        startedAt,
        completedAt: startedAt + 2_000,
        durationMs: 2_000,
      };
      target.__LIN_E2E__?.setMockThreadTurns(childId, [childTurn]);
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: childId,
        turnId: childTurnId,
        turn: childTurn,
      });
      const provenance = (itemId: string) => ({
        originThreadId: parentThreadId,
        originTurnId: parentTurnId,
        originItemId: itemId,
      });
      const delegatingTurn = {
        id: parentTurnId,
        items: [{
          id: callId,
          type: 'collabAgentToolCall',
          provenance: provenance(callId),
          tool: 'agent',
          status: 'completed',
          outputRef: null,
          senderThreadId: parentThreadId,
          receiverThreadIds: [childId],
          prompt: 'Check the rollout order.',
          summary: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
          modelCall: null,
        }, {
          id: activityId,
          type: 'subAgentActivity',
          provenance: provenance(activityId),
          kind: 'started',
          agentThreadId: childId,
          agentTurnId: null,
          agentPath: '/root/research',
          error: null,
          spawnItemId: callId,
        }],
        itemsView: 'full',
        provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt,
        completedAt: startedAt + 1_000,
        durationMs: 1_000,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: delegatingTurn,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: delegatingTurn,
      });
      // The delivery Turn, in the shape the host actually writes: the settled
      // activity Item flushed here, the context evidence for the wake-up, the
      // notification framing, then the model's answer to the reader.
      const deliveryTurn = {
        id: deliveryTurnId,
        items: [
          {
            id: settledActivityId,
            type: 'subAgentActivity',
            provenance: {
              originThreadId: parentThreadId,
              originTurnId: deliveryTurnId,
              originItemId: settledActivityId,
            },
            kind: 'completed',
            agentThreadId: childId,
            agentTurnId: childTurnId,
            agentPath: '/root/research',
            error: null,
            spawnItemId: null,
          },
          {
            id: evidenceId,
            type: 'contextEvidence',
            provenance: {
              originThreadId: parentThreadId,
              originTurnId: deliveryTurnId,
              originItemId: evidenceId,
            },
            kind: 'turnEnvironment',
            payloadRef: {
              id: '0'.repeat(64),
              mimeType: 'application/vnd.tenon.agent-context+json',
              byteLength: 461,
              schemaVersion: 1,
              kind: 'turnEnvironment',
            },
            summary: 'Turn environment',
            contextRefs: [],
            resourceRefs: [],
            outputRefs: [],
          },
          {
            id: noticeId,
            type: 'userMessage',
            provenance: {
              originThreadId: parentThreadId,
              originTurnId: deliveryTurnId,
              originItemId: noticeId,
            },
            clientId: null,
            acceptedAt: startedAt + 2_100,
            content: [{
              type: 'text',
              text: '<task-notification>Agent research finished. Read its transcript at …</task-notification>',
            }],
          },
          {
            id: proseId,
            type: 'agentMessage',
            provenance: {
              originThreadId: parentThreadId,
              originTurnId: deliveryTurnId,
              originItemId: proseId,
            },
            text: 'Research says the order holds, so we can ship it.',
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: {
          originThreadId: parentThreadId,
          originTurnId: deliveryTurnId,
          trigger: { kind: 'subagent', parentThreadId, parentItemId: callId },
        },
        status: 'completed',
        error: null,
        startedAt: startedAt + 2_100,
        completedAt: startedAt + 3_000,
        durationMs: 900,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: deliveryTurnId,
        turn: deliveryTurn,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId: deliveryTurnId,
        turn: deliveryTurn,
      });
      target.__LIN_E2E__?.setMockSubagentExecution(childId, {
        terminalStatus: 'finished',
        notificationState: 'delivered',
        deliveryTurnId,
        deliveryClass: 'ordinary',
        coverageDisposition: 'full',
      });
      return { childId, deliveryTurnId, parentThreadId };
    });

    // The conversation is still the narrative: the main agent's prose is the
    // thing to read, and the host's own wake-up framing reaches nobody.
    const deliveryTurn = page.locator(`[data-thread-turn-row="${fixture.deliveryTurnId}"]`);
    await expect(deliveryTurn).toContainText('Research says the order holds');
    await expect(page.locator('.thread-transcript')).not.toContainText('task-notification');

    // What replaces it is a MESSAGE from the Agent, in the shape every
    // participant here speaks in: its own avatar and name, never the reader's
    // own slot. The Turn holds two speakers — the child that delivered, and the
    // agent that read the result and answered — and says so.
    const report = deliveryTurn.locator('.thread-agent-report');
    await expect(report).toContainText('The rollout order is safe.');
    // Exactly two speakers, in order. The Turn opens with Items that draw
    // nothing — the settled activity row, the context evidence — and a named
    // `main` standing over that empty box, before the child that actually
    // spoke, is what this asserts against.
    //
    // A participant is named by its TYPE; the task it was handed is the card's
    // own first line. A task label standing where a name goes read as a
    // sentence fragment rather than as somebody speaking.
    await expect(deliveryTurn.locator('.thread-speaker-name')).toHaveText(['worker', 'main']);
    // The speaker header and the chip row below it NO LONGER share one glyph
    // column, and deliberately so (PM 2026-08-19). That rule was written for a
    // one-line header carrying a 16px letter disc; the header is now two lines
    // anchored by a mark sized to span them, and a mark that anchors two lines
    // cannot also sit on a 12px chip glyph's axis. The two rules could not both
    // hold, and the header won: it says WHO IS SPEAKING, while a chip is a row
    // of content inside what they said.
    //
    // What survives is the header's OWN column: its two lines share one left
    // edge beside the mark, and nothing in it pokes outside the block or
    // indents past that edge — the mark carries no optical overhang, and the
    // work line's control no inline padding of its own.
    expect(await deliveryTurn.locator('.thread-speaker-header').first().evaluate((header) => {
      const avatar = header.querySelector('.thread-speaker-avatar');
      const name = header.querySelector('.thread-speaker-name');
      const meta = header.querySelector('.thread-process-title, .thread-speaker-meta');
      if (!avatar || !name || !meta) throw new Error('Expected a mark, a name and a work line');
      const left = (element: Element) => Math.round(element.getBoundingClientRect().left);
      return {
        // Who and what-they-did start on the same edge.
        titleToWorkLine: Math.abs(left(name) - left(meta)),
        // Nothing reaches left of the block: the mark IS the block's edge.
        markOutdent: left(header) - left(avatar),
      };
    })).toEqual({ titleToWorkLine: 0, markOutdent: 0 });

    // Both headers are the same shape — who, then what they did, on its own
    // line in the meta type. The child's elapsed is ITS OWN: the Turn around it
    // is the parent reading a result, which took no time next to the work
    // being reported.
    await expect(deliveryTurn.locator('.thread-speaker-meta')).toHaveText([
      'Worked for 2s',
      /^Worked for/u,
    ]);
    expect(await deliveryTurn.locator('.thread-speaker-header').evaluateAll((elements) => ({
      heights: [...new Set(elements.map((element) => element.getBoundingClientRect().height))],
      fonts: [...new Set(elements.map((element) => {
        const meta = element.querySelector('.thread-speaker-meta');
        return meta === null ? '' : getComputedStyle(meta).fontSize;
      }))],
    }))).toEqual({ heights: [expect.any(Number)], fonts: [expect.any(String)] });
    // A report is a block like any other: its BOX sits the same distance under
    // its speaker's header as a paragraph's first line sits under its own.
    expect(await deliveryTurn.locator('.thread-speaker').evaluateAll((groups) => {
      const gaps = groups.flatMap((group) => {
        const header = group.querySelector('.thread-speaker-header');
        const block = group.querySelector('.thread-agent-report, .thread-agent-message-body');
        return header === null || block === null
          ? []
          : [Math.round(block.getBoundingClientRect().top - header.getBoundingClientRect().bottom)];
      });
      return [...new Set(gaps)];
    })).toEqual([expect.any(Number)]);
    // A report keeps the measure every message here keeps. Run to the full width
    // of a widened deck it stopped reading as one thing somebody said and
    // started reading as a panel — measured against a wide box, since the deck
    // is narrower than the cap until the reader drags it open.
    expect(await report.evaluate((card) => {
      const wide = document.createElement('div');
      wide.style.width = '1200px';
      document.body.append(wide);
      const clone = card.cloneNode(false) as HTMLElement;
      wide.append(clone);
      const width = Math.round(clone.getBoundingClientRect().width);
      wide.remove();
      return width;
    })).toBe(520);

    // And inside it breathes on the prose rhythm: container-to-text is the same
    // distance as text-to-text, rather than a tighter one of its own.
    expect(await report.evaluate((card) => {
      const probe = document.createElement('div');
      probe.style.marginTop = 'var(--space-5)';
      card.append(probe);
      const matches = getComputedStyle(card).paddingTop === getComputedStyle(probe).marginTop;
      probe.remove();
      return matches;
    })).toBe(true);
    const reportSpeaker = deliveryTurn.locator('.thread-speaker').first();
    await expect(reportSpeaker.locator('.thread-agent-report')).toHaveCount(1);
    // The delegate signs its own report: its mark, in its own hue, not the
    // conversation's — the card came back from somewhere else.
    expect(await reportSpeaker.evaluate((group) => {
      const shape = group.querySelector('.thread-speaker-avatar svg path[mask]');
      return shape === null ? '' : getComputedStyle(shape).fill;
    })).toMatch(/^rgb/u);
    await expect(report.locator('.thread-agent-report-task')).toHaveText('research');

    // A preview, clamped: no in-place Show more, because opening the card is
    // already the way to read the whole thing, and its content takes no clicks
    // of its own so there is one meaning for a click here.
    const body = report.locator('.thread-agent-report-body');
    await expect(report.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    expect(await body.evaluate((element) => ({
      clamped: element.scrollHeight > element.clientHeight,
      pointerEvents: getComputedStyle(element).pointerEvents,
    }))).toEqual({ clamped: true, pointerEvents: 'none' });
    // The hint rides the slot the message actions hold, so saying what the card
    // does moves nothing (B7) — and a report ends exactly where any other
    // message ends, which means the same row occupying the same height.
    const shell = deliveryTurn.locator('.thread-agent-report-shell');
    const heightBefore = await shell.evaluate((element) => element.getBoundingClientRect().height);
    await shell.hover();
    await expect(shell.locator('.thread-agent-report-hint')).toBeVisible();
    expect(await shell.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(heightBefore);
    expect(await page.locator('.thread-message-actions-slot').evaluateAll((slots) => [
      ...new Set(slots.map((slot) => slot.getBoundingClientRect().height)),
    ])).toEqual([expect.any(Number)]);
    expect(await shell.locator('.thread-agent-report-hint').evaluate((hint) => ({
      height: hint.getBoundingClientRect().height,
      slotHeight: hint.closest('.thread-message-actions-slot')!.getBoundingClientRect().height,
      icons: hint.querySelectorAll('svg').length,
    }))).toEqual({ height: expect.any(Number), slotHeight: expect.any(Number), icons: 1 });
    expect(await shell.locator('.thread-agent-report-hint').evaluate((hint) => (
      hint.getBoundingClientRect().height === hint.closest('.thread-message-actions-slot')!
        .getBoundingClientRect().height
    ))).toBe(true);

    // A steering message typed while the continuation is still running is the
    // READER's, and belongs to the reader: replacing every user-role Item in a
    // delivery Turn rendered the report twice and made those words vanish.
    await page.evaluate((ids) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'item/completed',
        threadId: ids.parentThreadId,
        turnId: ids.deliveryTurnId,
        item: {
          id: '01910000-0000-7000-8000-000000004a0b',
          type: 'userMessage',
          provenance: {
            originThreadId: ids.parentThreadId,
            originTurnId: ids.deliveryTurnId,
            originItemId: '01910000-0000-7000-8000-000000004a0b',
          },
          clientId: null,
          acceptedAt: 3,
          content: [{ type: 'text', text: 'Also check the changelog.' }],
        },
      });
    }, fixture);
    await expect(deliveryTurn.locator('.thread-agent-report')).toHaveCount(1);
    await expect(deliveryTurn.locator('.thread-user-message')).toContainText('Also check the changelog.');

    // Depth beyond the report is the detail view, one push away — the whole
    // card is the control that gets there.
    await report.click();
    await expect(page.locator('.thread-agent-detail')).toBeVisible();
    await expect(page.locator('.thread-dock-title')).toHaveText('research');
  });

  test('sends the composer Stop against the delegating Turn that owns the request', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000fb01';
      const childId = '01910000-0000-7000-8000-00000000fb10';
      const activityId = '01910000-0000-7000-8000-00000000fb12';
      const startedAt = Date.now() - 3_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'worker',
          name: null,
          source: 'collaboration',
          threadSource: 'subagent',
          status: { type: 'active', activeFlags: [] },
          updatedAt: startedAt,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: childId,
        turnId: '01910000-0000-7000-8000-00000000fb11',
        turn: {
          id: '01910000-0000-7000-8000-00000000fb11',
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: childId,
            originTurnId: '01910000-0000-7000-8000-00000000fb11',
            trigger: { kind: 'subagent', parentThreadId, parentItemId: activityId },
          },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: [{
            id: activityId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, originItemId: activityId },
            kind: 'started',
            agentThreadId: childId,
            agentPath: '/root/research',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { parentThreadId, parentTurnId };
    });

    await expect(page.locator('.thread-agent-chip-line')).toBeVisible();
    await page.getByRole('button', { name: 'Interrupt Turn' }).click();

    // The host closes the request from this pair; the renderer's job is to
    // address the delegating Turn that owns it, not to enumerate children.
    const interrupts = (await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt');
    expect(interrupts.map((call) => call.args)).toEqual([
      { threadId: fixture.parentThreadId, turnId: fixture.parentTurnId },
    ]);
  });
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`projects live Agent status without inferring wait progress in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await createNewThread(page);
      await page.clock.install({ time: new Date('2026-08-12T09:00:00Z') });
      const fixture = await page.evaluate(async () => {
        const target = window as Window & {
          lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
        const root = response?.data[0];
        if (!root) throw new Error('Mock root Thread not found');
        const parentThreadId = String(root.id);
        const parentTurnId = '01910000-0000-7000-8000-00000000de01';
        const startedAt = Date.now() - 9_000;
        const children = [
          {
            id: '01910000-0000-7000-8000-00000000de10',
            turnId: '01910000-0000-7000-8000-00000000de11',
            activityId: '01910000-0000-7000-8000-00000000de12',
            callItemId: '01910000-0000-7000-8000-00000000de13',
            taskPath: '/root/research',
            nickname: 'Researcher',
          },
          {
            id: '01910000-0000-7000-8000-00000000de20',
            turnId: '01910000-0000-7000-8000-00000000de21',
            activityId: '01910000-0000-7000-8000-00000000de22',
            callItemId: '01910000-0000-7000-8000-00000000de23',
            taskPath: '/root/audit',
            nickname: 'Auditor',
          },
        ];
        for (const child of children) {
          const thread = {
            ...root,
            id: child.id,
            parentThreadId,
            agentNickname: child.nickname,
            agentRole: 'worker',
            name: null,
            source: 'collaboration',
            threadSource: 'subagent',
            status: { type: 'active', activeFlags: [] },
            updatedAt: startedAt,
          };
          target.__LIN_E2E__?.emitAgentCoreNotification({
            type: 'thread/started',
            threadId: child.id,
            thread,
          });
          target.__LIN_E2E__?.emitAgentCoreNotification({
            type: 'turn/started',
            threadId: child.id,
            turnId: child.turnId,
            turn: {
              id: child.turnId,
              items: [],
              itemsView: 'full',
              provenance: {
                originThreadId: child.id,
                originTurnId: child.turnId,
                trigger: {
                  kind: 'subagent',
                  parentThreadId,
                  parentItemId: child.callItemId,
                },
              },
              status: 'inProgress',
              error: null,
              startedAt,
              completedAt: null,
              durationMs: null,
            },
          });
        }
        const provenance = (itemId: string) => ({
          originThreadId: parentThreadId,
          originTurnId: parentTurnId,
          originItemId: itemId,
        });
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/started',
          threadId: parentThreadId,
          turnId: parentTurnId,
          turn: {
            id: parentTurnId,
            items: [
              ...children.flatMap((child) => [{
                  id: child.activityId,
                  type: 'subAgentActivity',
                  provenance: provenance(child.activityId),
                  kind: 'started',
                  agentThreadId: child.id,
                  agentPath: child.taskPath,
                  error: null,
                  spawnItemId: child.callItemId,
                }, {
                  id: child.callItemId,
                  type: 'collabAgentToolCall',
                  provenance: provenance(child.callItemId),
                  tool: 'agent',
                  modelCall: {
                    disposition: 'replayable',
                    identity: { namespace: null, name: 'agent' },
                    providerName: 'agent',
                    arguments: {
                      storage: 'inline',
                      value: { description: child.nickname, prompt: `Run ${child.taskPath}` },
                    },
                    schemaDigest: '0'.repeat(64),
                  },
                  status: 'inProgress',
                  outputRef: null,
                  senderThreadId: parentThreadId,
                  receiverThreadIds: [child.id],
                  prompt: `Run ${child.taskPath}`,
                  summary: null,
                  model: null,
                  reasoningEffort: null,
                  agentsStates: {},
                }]),
            ],
            itemsView: 'full',
            provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
            status: 'inProgress',
            error: null,
            startedAt,
            completedAt: null,
            durationMs: null,
          },
        });
        return { children, parentThreadId, parentTurnId, startedAt };
      });

      const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
      await expect(parentTurn.locator('.thread-process-title'))
        .toContainText(/Working for \d+[smhd]/u);
      const rows = parentTurn.locator('.thread-agent-chip-block');
      await expect(rows).toHaveCount(2);
      await expect(rows.locator('.thread-agent-chip-meta').first())
        .toContainText(/^\d+[smhd]/u);
      // The disclosure owns the flexible space and Stop owns the fixed edge.
      // Crossing the first digit-count boundary must not move the action.
      const researchRow = parentTurn.locator('.thread-agent-chip-block', { hasText: 'research' });
      const researchElapsed = researchRow.locator('.thread-agent-chip-meta .working-text-base');
      const researchStop = parentTurn.getByRole('button', { name: 'Stop research' });
      await expect(researchElapsed).toHaveText('9s');
      await expect(researchRow.locator('.thread-agent-chip-meta')).toHaveCSS(
        'font-variant-numeric',
        /tabular-nums/u,
      );
      const stopAtNineSeconds = await researchStop.boundingBox();
      expect(stopAtNineSeconds).not.toBeNull();
      await page.clock.runFor(1_000);
      await expect(researchElapsed).toHaveText('10s');
      const stopAtTenSeconds = await researchStop.boundingBox();
      expect(stopAtTenSeconds).not.toBeNull();
      expect(Math.abs(stopAtTenSeconds!.x - stopAtNineSeconds!.x)).toBeLessThan(0.01);
      expect(Math.abs(stopAtTenSeconds!.width - stopAtNineSeconds!.width)).toBeLessThan(0.01);
      await page.clock.resume();
      // Identity stays still while only each live status phrase owns motion.
      await expect(rows.locator('.thread-agent-chip-name .working-text')).toHaveCount(0);
      await expect(rows.locator('.thread-agent-chip-meta.working-text')).toHaveCount(2);
      await expect(rows.locator('.thread-agent-chip-meta .working-text-base')).toHaveCount(2);
      // Every colour comes from the ink tokens, so the row follows the scheme
      // instead of carrying a hardcoded value that only works in light. The row
      // also has to share the tool rows' type ramp: it is one more thing the
      // Turn did, and rendering it at content size made it the loudest line in
      // a timeline of quiet ones.
      const rowPaint = await rows.first().evaluate((element) => {
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        document.body.append(probe);
        const resolve = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const status = element.querySelector('.thread-agent-chip-meta');
        probe.style.fontSize = 'var(--font-meta)';
        const paint = {
          fontSize: getComputedStyle(element).fontSize,
          ink: root.getPropertyValue('--ink').trim(),
          metaFontSize: getComputedStyle(probe).fontSize,
          status: status ? getComputedStyle(status).color : '',
          text: getComputedStyle(element).color,
          textSoft: resolve('--text-soft'),
          textTertiary: resolve('--text-tertiary'),
        };
        probe.remove();
        return paint;
      });
      // The assertion is that the row follows the ink tokens, not what those
      // tokens currently are: pinning the literals here would fail an E2E in
      // this file for a change made in `tokens.css`.
      expect(rowPaint.text).toBe(rowPaint.textSoft);
      expect(rowPaint.status).toBe(rowPaint.textTertiary);
      expect(rowPaint.fontSize).toBe(rowPaint.metaFontSize);
      expect(rowPaint.ink).toBe(colorScheme === 'dark' ? '255 255 255' : '0 0 0');
      const auditRow = parentTurn.locator('.thread-agent-chip-block', { hasText: 'audit' });

      await page.evaluate(({ child, parentThreadId, startedAt }) => {
        const target = window as Window & {
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId: child.id,
          turnId: child.turnId,
          turn: {
            id: child.turnId,
            items: [],
            itemsView: 'full',
            provenance: {
              originThreadId: child.id,
              originTurnId: child.turnId,
              trigger: { kind: 'subagent', parentThreadId, parentItemId: '01910000-0000-7000-8000-00000000de02' },
            },
            status: 'completed',
            error: null,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          },
        });
      }, { child: fixture.children[0]!, parentThreadId: fixture.parentThreadId, startedAt: fixture.startedAt });

      await expect(parentTurn.locator('.thread-process-title'))
        .toContainText(/Working for \d+[smhd]/u);
      const finishedRow = parentTurn.locator('.thread-agent-chip-block.thread-subagent-finished');
      await expect(finishedRow).toHaveCount(1);
      await expect(finishedRow.locator('.thread-agent-chip-meta.working-text')).toHaveCount(0);

      await page.evaluate(({ child, parentThreadId, startedAt }) => {
        const target = window as Window & {
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId: child.id,
          turnId: child.turnId,
          turn: {
            id: child.turnId,
            items: [],
            itemsView: 'full',
            provenance: {
              originThreadId: child.id,
              originTurnId: child.turnId,
              trigger: { kind: 'subagent', parentThreadId, parentItemId: '01910000-0000-7000-8000-00000000de02' },
            },
            status: 'failed',
            error: {
              message: 'Token budget exhausted (9876 of 9000 tokens)',
              code: 'subagent_budget_exhausted',
            },
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          },
        });
      }, { child: fixture.children[1]!, parentThreadId: fixture.parentThreadId, startedAt: fixture.startedAt });

      // A settled row states its own Turn's span, failures included.
      await expect(auditRow.locator('.thread-agent-chip-meta'))
        .toHaveText(/^Failed · \d+[smhd]/u);
      await expect(auditRow).toContainText('Task reached the system resource limit. Results have been preserved.');
      await expect(auditRow).not.toContainText('9876');
      await expect(auditRow).not.toContainText('9000');
      await expect(auditRow.locator('.thread-agent-chip-error')).toHaveCSS('white-space', 'normal');
      expect(await auditRow.locator('.thread-agent-chip-error').evaluate((element) => (
        element.scrollWidth <= element.clientWidth
      ))).toBe(true);
      // The status colour survives hover: pointing at a failed delegation must
      // not repaint it neutral, which is what a hover rule that did not exempt
      // the status states would do. Polled because the row shares the tool
      // rows' colour transition, so a single read can land mid-interpolation.
      await auditRow.locator('.thread-agent-chip').hover();
      await expect.poll(async () => auditRow.locator('.thread-agent-chip-name').evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--status-danger)';
        document.body.append(probe);
        const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
        probe.remove();
        return matches;
      })).toBe(true);
    });
  }

  test('renders reasoning and grouped tool Items with disclosure and copy interactions', async ({ page }) => {
    await createNewThread(page);
    await seedOverflowingTranscript(page);
    await page.evaluate(async () => {
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
            namespace: 'node',
            tool: 'read',
            arguments: { node_id: 'node-alpha', file_path: 'notes with spaces.md' },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: 'node', name: 'read' },
              providerName: 'node__read',
              arguments: {
                storage: 'inline',
                value: { node_id: 'node-alpha', file_path: 'notes with spaces.md' },
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
    });

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
      '```tool node.read',
      JSON.stringify({ node_id: 'node-alpha', file_path: 'notes with spaces.md' }, null, 2),
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
          text: `Review [[node:Alpha^${nodeId}]] and [[file:notes.md^%2Fmock%2Fnotes.md]].`,
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
    await expect(nodeRef).toHaveAttribute('href', new RegExp(`lin-node:${ids.alpha}`));

    const fileRef = message.locator('[data-inline-ref-kind="local-file"]');
    await expect(fileRef).toHaveText('notes.md');
    await fileRef.hover();
    await expect(page.locator('[data-inline-file-preview]')).toContainText('/mock/notes.md');
    await fileRef.click();
    const preview = page.locator('.outline-panel-surface.active-panel.is-file-preview');
    await expect(preview.locator('.file-preview-content')).toContainText('Mock preview text.');
  });

  test('shows a Plan on a Thread that has no composer', async ({ page }) => {
    // `update_plan` is `anyThread`-scoped, so a watched child or automation
    // Thread has a Plan — and the chip used to mount only inside the composer
    // branch, so it had nowhere to appear.
    await createNewThread(page);
    const childThreadId = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin
        ?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const parent = response?.data[0];
      if (!parent) throw new Error('Mock Thread not found');
      const thread = {
        ...parent,
        id: '01910000-0000-7000-8000-00000000ce01',
        parentThreadId: parent.id,
        name: 'Child agent',
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'thread/started', thread });
      // A child is not a list row, so the parent transcript is the way in.
      const parentTurnId = '01910000-0000-7000-8000-00000000ce04';
      const activityId = '01910000-0000-7000-8000-00000000ce05';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parent.id,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: [{
            id: activityId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parent.id, originTurnId: parentTurnId, originItemId: activityId },
            kind: 'started',
            agentThreadId: thread.id,
            agentPath: '/root/plan_child',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parent.id, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
      return thread.id;
    });

    // Select before seeding: notifications for a Thread whose Turns are not yet
    // loaded are dropped, and selecting reloads them.
    await page.getByRole('button', { name: 'Open Child agent' }).click();
    await page.evaluate((threadId) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const turnId = '01910000-0000-7000-8000-00000000ce02';
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
        type: 'turn/plan/updated',
        threadId,
        turnId,
        explanation: null,
        plan: [
          { step: 'Gather the sources', status: 'completed' },
          { step: 'Cross-check the citations', status: 'in_progress' },
        ],
      });
    }, childThreadId);

    // The child's run detail is the composer-less surface; the parent's
    // composer stays on screen, still the parent's.
    const detail = page.locator('.thread-agent-detail');
    await expect(detail.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);
    const pill = detail.locator('.thread-plan-progress-summary');
    await expect(pill.locator('.working-text-base')).toHaveText('2/2 · Cross-check the citations');

    // With no composer to return to, Escape must still land focus somewhere
    // reachable rather than dropping it to the document body.
    await pill.click();
    await expect(page.locator('.thread-plan-progress-popover')).toBeFocused();
    await page.locator('.thread-plan-progress-popover').press('Escape');
    await expect(pill).toBeFocused();

    // The checklist gets the Thread's width here, not the pill's.
    await pill.click();
    const widths = await page.evaluate(() => {
      const popover = document.querySelector('.thread-plan-progress-popover');
      const region = document.querySelector('.thread-composer-region');
      return {
        popover: popover?.getBoundingClientRect().width ?? 0,
        region: region?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(widths.popover).toBeGreaterThan(widths.region * 0.5);
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

  test('shows loaded and isolated Skills through the same tool disclosure', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ad01';
      const loadedId = '01910000-0000-7000-8000-00000000ad02';
      const isolatedId = '01910000-0000-7000-8000-00000000ad03';
      const provenance = (itemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: itemId });
      const turn = {
        id: turnId,
        items: [{
          id: loadedId,
          type: 'dynamicToolCall',
          provenance: provenance(loadedId),
          namespace: null,
          tool: 'skill',
          arguments: { skill: 'review-pr', args: '429 --focus rendering' },
          modelCall: {
            disposition: 'replayable',
            identity: { namespace: null, name: 'skill' },
            providerName: 'skill',
            arguments: {
              storage: 'inline',
              value: { skill: 'review-pr', args: '429 --focus rendering' },
            },
            schemaDigest: '0'.repeat(64),
          },
          status: 'completed',
          contentItems: [{ type: 'text', text: 'Launching skill: review-pr' }],
          success: true,
          durationMs: 2,
        }, {
          id: isolatedId,
          type: 'dynamicToolCall',
          provenance: provenance(isolatedId),
          namespace: null,
          tool: 'skill',
          arguments: { skill: 'investigate', args: 'render regression' },
          modelCall: {
            disposition: 'replayable',
            identity: { namespace: null, name: 'skill' },
            providerName: 'skill',
            arguments: {
              storage: 'inline',
              value: { skill: 'investigate', args: 'render regression' },
            },
            schemaDigest: '0'.repeat(64),
          },
          status: 'completed',
          contentItems: [{ type: 'text', text: 'Isolated skill result.' }],
          success: true,
          durationMs: 8,
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
    });

    await expect(page.locator('.thread-process-title')).toHaveText('Used 2 skills');
    await page.getByRole('button', { name: 'Used 2 skills' }).click();
    const skills = page.locator('.thread-tool-toggle');
    await expect(skills).toHaveCount(2);
    await skills.nth(0).click();
    await expect(skills.nth(0).locator('xpath=..')).toContainText('review-pr');
    await expect(skills.nth(0).locator('xpath=..')).toContainText('429 --focus rendering');
    await expect(skills.nth(0).locator('xpath=..')).toContainText('Launching skill: review-pr');
    await skills.nth(1).click();
    await expect(page.getByText('Isolated skill result.')).toBeVisible();
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

  test('reads a Subagent without moving the parent conversation at all', async ({ page }) => {
    await createNewThread(page);
    await renameSelectedThread(page, 'Parent history');
    await seedTallFlowTranscript(page, TRANSCRIPT_VIRTUAL_MIN_TURNS);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          createMockSubagentThread: (input: { parentThreadId: string; name: string }) => { id: string };
          emitAgentCoreNotification: (notification: unknown) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const parentThreadId = response?.data[0]?.id;
      if (!parentThreadId) throw new Error('Mock Thread not found');
      const child = target.__LIN_E2E__?.createMockSubagentThread({ parentThreadId, name: 'research worker' });
      // A chip is where a child is read, so the Turn that delegated it has to
      // carry the spawn — which is what production records for every form.
      const turnId = '01910000-0000-7000-8000-00000000ef01';
      const itemId = '01910000-0000-7000-8000-00000000ef02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parentThreadId, originTurnId: turnId, originItemId: itemId },
            kind: 'started',
            agentThreadId: child!.id,
            agentTurnId: null,
            agentPath: '/root/research_worker',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });
    // Reading an Agent pushes a level over the deck; the deck still names the
    // conversation, and Back returns the reader exactly where they were.
    const chip = page.locator('.thread-agent-chip').first();
    const detail = page.locator('.thread-agent-detail');
    const chipTop = () => chip.evaluate((element) => Math.round(element.getBoundingClientRect().top));
    const conversationScroll = page.locator('.thread-dock-conversation .thread-transcript');
    const scrollTop = () => conversationScroll.evaluate((element) => Math.round(element.scrollTop));
    const scrollHeight = () => conversationScroll.evaluate((element) => Math.round(element.scrollHeight));

    // Let the transcript settle on its tail first, then leave it deliberately:
    // a transcript that is still following has no reading position to lose, so
    // the invariant is only testable off the tail.
    // The virtualizer measures Turns as they mount, so the scrollable extent
    // keeps growing for a moment; a position captured before it settles is a
    // position the transcript is still moving away from.
    await expect.poll(async () => {
      const first = await scrollHeight();
      await page.waitForTimeout(150);
      return await scrollHeight() === first && first > 0;
    }, { timeout: 15_000 }).toBe(true);
    await chip.click();
    await expect(detail).toBeVisible();
    await expect(page.locator('.thread-dock-title')).toHaveText('research worker');

    // Covered, not unmounted. The transcript under the pushed view keeps its
    // scroll position and its measured layout, and the reader's place is read
    // from there rather than restored from a snapshot on the way back.
    await expect.poll(async () => {
      const first = await scrollTop();
      await page.waitForTimeout(150);
      return await scrollTop() === first;
    }).toBe(true);
    const coveredAt = await scrollTop();
    const coveredHeight = await scrollHeight();
    const openedAt = await chipTop();

    await page.getByRole('button', { name: /^Back:/u }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.locator('.thread-dock-title')).toHaveText('Parent history');
    // The invariant the push has to keep: returning is a reveal, not a reload —
    // same position, same measured transcript, same chip under the pointer.
    expect(await scrollTop()).toBe(coveredAt);
    expect(await scrollHeight()).toBe(coveredHeight);
    expect(await chipTop()).toBe(openedAt);
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

  await expect(page.locator('.thread-composer-pending-ref')).toContainText('pasted-content.txt');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove pasted-content.txt and message reference' }).click();
  await expect(page.locator('.thread-composer-pending-ref')).toHaveCount(0);
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(0);
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/abort').length
  )).toBe(1);
  expect((await commandCalls(page)).some((call) => call.cmd === 'attachment-upload/finish')).toBe(false);
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
    'pasted-content.txt could not be attached, so the paste was not inserted.',
  );
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/abort').length
  )).toBe(1);
});

test('opens provider settings instead of creating a Thread when no provider is usable', async ({ page }) => {
  await openMockedApp(page, { agentProviderUsable: false });

  await page.getByRole('button', { name: 'Show Threads' }).click();
  await expect(page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })).toBeDisabled();
  await page.keyboard.press('Escape');
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
      'Retry',
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

  test('retries a failed Turn through turn/retry without renderer rollback or resubmission', async ({ page }) => {
    await openMockedApp(page, { agentTurnFailure: 'Mock provider failure' });
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Retry this canonical request');
    await page.getByRole('button', { name: 'Send' }).click();

    const response = page.locator('.thread-agent-message-response').last();
    await expect(response.locator('.thread-response-error')).toHaveText('Mock provider failure');
    const failedRow = page.locator('[data-thread-turn-row]').filter({ has: response });
    const failedTurnId = await failedRow.getAttribute('data-thread-turn-row');
    expect(failedTurnId).toBeTruthy();
    await response.hover();
    await response.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'turn/retry').length
    )).toBe(1);
    await expect(page.locator(`[data-thread-turn-row="${failedTurnId}"]`)).toHaveCount(0);
    await expect(page.getByLabel('Assistant is responding')).toBeVisible();
    const calls = await commandCalls(page);
    expect(calls.filter((call) => call.cmd === 'turn/retry')).toEqual([{
      cmd: 'turn/retry',
      args: { threadId: expect.any(String), turnId: failedTurnId },
    }]);
    expect(calls.filter((call) => call.cmd === 'thread/rollback')).toHaveLength(0);
    expect(calls.filter((call) => call.cmd === 'turn/submit')).toHaveLength(1);
  });

  test('keeps an interrupted partial response without Retry or Regenerate', async ({ page }) => {
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
    await expect(response.getByRole('button', { name: 'Retry response' })).toHaveCount(0);
    await expect(response.getByRole('button', { name: 'Regenerate response' })).toHaveCount(0);
    await expect(response.getByRole('button', { name: 'Continue in new chat' })).toBeVisible();
  });
});
