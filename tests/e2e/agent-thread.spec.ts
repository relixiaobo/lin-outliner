import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MAX_INLINE_IMAGE_BASE64_CHARS, MAX_RAW_INLINE_IMAGE_BYTES } from '../../src/core/agentAttachmentLimits';
import { clipboardText, commandCalls, ids, openMockedApp, rowBody } from './outlinerMock';

async function createNewThread(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })
    .click();
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
      'Details',
    ]);
    const [responseBodyBox, responseActionsBox] = await Promise.all([
      response.locator('.thread-agent-message-body').boundingBox(),
      responseActions.boundingBox(),
    ]);
    expect(responseBodyBox).toBeTruthy();
    expect(responseActionsBox).toBeTruthy();
    expect(responseActionsBox!.y).toBeGreaterThanOrEqual(responseBodyBox!.y + responseBodyBox!.height - 1);

    const messageDetailsButton = responseActions.getByRole('button', { name: 'Details' });
    await messageDetailsButton.hover();
    const usage = page.getByRole('tooltip');
    await expect(usage).toContainText('Usage details');
    await expect(usage).toContainText('Input120');
    await messageDetailsButton.click();
    const messageDetails = page.getByRole('dialog', { name: 'Details' });
    await expect(messageDetails).toContainText('openai/gpt-5.4');
    await expect(messageDetails).toContainText('Total 200');
    await page.keyboard.press('Escape');
    await expect(messageDetails).toHaveCount(0);

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
      'thread/turns/list',
      'turn/start',
      'goal/get',
    ]));
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
    const process = settledTurn.locator('.thread-process-block');
    await expect(process).toHaveCount(1);
    await expect(process.getByRole('button', { name: 'Worked for 2s' })).toBeVisible();
    expect(await settledTurn.locator('.thread-process-block, .thread-agent-message-final_answer')
      .evaluateAll((elements) => elements.map((element) => element.className))).toEqual([
      'thread-process-block',
      'thread-item thread-agent-message thread-agent-message-final_answer',
    ]);
    await process.getByRole('button', { name: 'Worked for 2s' }).click();
    await expect(settledTurn.getByText('Checked the canonical evidence.')).toBeVisible();

    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const userId = '01910000-0000-7000-8000-00000000c202';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [{
            id: userId,
            type: 'userMessage',
            provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: userId },
            clientId: null,
            content: [{ type: 'text', text: 'Show the live state.' }],
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
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
    await expect(liveTurn.locator('.thread-process-block')).toHaveCount(1);
    await expect(liveTurn.locator('.thread-process-title')).toHaveText('Working');
    await expect(liveTurn.getByLabel('Assistant is responding')).toBeVisible();

    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const userId = '01910000-0000-7000-8000-00000000c202';
      const answerId = '01910000-0000-7000-8000-00000000c203';
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
              content: [{ type: 'text', text: 'Show the live state.' }],
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
    const selectedFork = page.locator('.thread-list-row.is-selected');
    await expect(selectedFork).toContainText('Keep this history.');
    await expect(selectedFork).toHaveCSS('--thread-depth', '0');
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
    await page.getByRole('menuitem', { name: 'Send to composer' }).click();

    await expect(page.locator('.thread-composer-inline-ref')).toContainText('Alpha');
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([{
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
    await page.getByRole('menuitem', { name: 'Send to composer' }).click();
    await composer.pressSequentially('after');
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([
      { type: 'text', text: 'Before' },
      { type: 'nodeReference', nodeId: ids.alpha, note: 'Alpha' },
      { type: 'text', text: 'after' },
    ]);
  });

  test('keeps same-named files from distinct sources and accepts a regular file above the image limit', async ({ page }) => {
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
      buffer: Buffer.alloc(MAX_RAW_INLINE_IMAGE_BYTES + 1),
    });

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(3);
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    const input = start?.args.input as Array<{
      name?: string;
      sizeBytes?: number;
      source?: { kind?: string; path?: string };
      type?: string;
    }>;
    const reports = input.filter((part) => part.type === 'attachment' && part.name === 'report.bin');
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((part) => part.source?.path)).size).toBe(2);
    expect(input).toContainEqual(expect.objectContaining({
      type: 'attachment',
      name: 'archive.bin',
      sizeBytes: MAX_RAW_INLINE_IMAGE_BYTES + 1,
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

  test('preserves a directory selected from the composer mention menu', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('@');
    await page.getByRole('option', { name: /workspace.*mock\/local-root/i }).click();

    const directoryRef = page.locator('.thread-composer-inline-ref[data-inline-ref-entry-kind="directory"]');
    await expect(directoryRef).toContainText('workspace');
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([expect.objectContaining({
      type: 'attachment',
      name: 'workspace',
      mimeType: 'inode/directory',
      sizeBytes: 0,
      source: { kind: 'localFile', path: '/mock/local-root/workspace' },
    })]);
  });

  test('keeps a native selected image as canonical inline vision input', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('@');
    await page.getByRole('option', { name: /reference\.png.*mock\/local-root/i }).click();

    const imageRef = page.locator('.thread-composer-inline-ref[data-inline-ref-path="/mock/local-root/reference.png"]');
    await expect(imageRef).toContainText('reference.png');
    await expect(imageRef).toHaveAttribute('data-inline-ref-thumbnail-data-url', /^blob:/);
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([expect.objectContaining({
      type: 'attachment',
      name: 'reference.png',
      mimeType: 'image/png',
      source: { kind: 'inline', dataBase64: 'bW9jayBpbWFnZQ==' },
    })]);
  });

  test('rejects an image above the raw image limit before decoding it', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'oversized.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(MAX_RAW_INLINE_IMAGE_BYTES + 1),
    });

    await expect(page.getByRole('status')).toContainText('oversized.png is larger than 10 MB');
    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(0);
  });

  test('compresses a pathless image to the bounded inline model payload', async ({ page }) => {
    await createNewThread(page);
    const originalSize = await page.locator('.thread-composer-file-input').evaluate(async (element) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1_536;
      canvas.height = 1_536;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      const image = context.createImageData(canvas.width, canvas.height);
      for (let offset = 0; offset < image.data.length; offset += 65_536) {
        crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65_536, image.data.length)));
      }
      for (let offset = 3; offset < image.data.length; offset += 4) image.data[offset] = 255;
      context.putImageData(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png');
      });
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'noise.png', { type: 'image/png' }));
      const input = element as HTMLInputElement;
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return blob.size;
    });
    expect(originalSize * 4 / 3).toBeGreaterThan(MAX_INLINE_IMAGE_BASE64_CHARS);

    const imageRef = page.locator('.thread-composer-inline-ref');
    await expect(imageRef).toContainText('noise.png');
    await expect(imageRef).toHaveAttribute('data-inline-ref-thumbnail-data-url', /^blob:/);
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    const attachment = (start?.args.input as Array<{
      mimeType?: string;
      source?: { kind?: string; dataBase64?: string };
    }>)[0];
    expect(attachment?.mimeType).toBe('image/jpeg');
    expect(attachment?.source?.kind).toBe('inline');
    expect(attachment?.source?.dataBase64?.length).toBeLessThanOrEqual(MAX_INLINE_IMAGE_BASE64_CHARS);
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
    const skill = menu.getByRole('option', { name: /workspace-review/ });
    await expect(skill).toContainText('Review workspace conventions before automatic use.');
    await skill.click();

    await expect(composer).toHaveText('/workspace-review ');
    await expect(composer).toBeFocused();
    expect((await commandCalls(page)).filter((call) => call.cmd === 'agent_list_all_skills').at(-1)?.args)
      .toMatchObject({ userInvocableOnly: true });
  });

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

  test('keeps Subagent Threads inspectable without exposing a direct composer', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
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
        threadSource: 'subagent',
        updatedAt: Number(root.updatedAt) + 1,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'thread/started', threadId: child.id, thread: child });
      const turnId = '01910000-0000-7000-8000-00000000dd02';
      const itemId = '01910000-0000-7000-8000-00000000dd03';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: root.id,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'subAgentActivity',
            provenance: { originThreadId: root.id, originTurnId: turnId, originItemId: itemId },
            kind: 'completed',
            agentThreadId: child.id,
            agentPath: '/root/research',
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
    });

    await page.getByRole('button', { name: 'Open Subagent Thread /root/research' }).click();
    await expect(page.locator('.thread-dock-title')).toHaveText('Research child');
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Show Threads' }).click();
    const childRow = page.getByRole('dialog', { name: 'Threads' }).locator('.thread-list-row').filter({ hasText: 'Research child' });
    await expect(childRow.getByRole('button', { name: /Research child/ })).toBeVisible();
    await expect(childRow).toHaveCSS('--thread-depth', '1');
    await expect(childRow.locator('small')).toContainText('Subagent · research [explorer]');
  });

  test('renders reasoning and grouped tool Items with disclosure and copy interactions', async ({ page }) => {
    await createNewThread(page);
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
            arguments: { node_id: 'node-alpha' },
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
    await process.click();

    const thought = page.locator('.thread-reasoning-toggle').first();
    await expect(thought).toBeVisible();
    await expect(thought).toHaveAccessibleName(/Thought.*Inspect the current workspace/);
    const thoughtChevron = thought.locator('.thread-reasoning-chevron');
    await expect(thoughtChevron).toHaveCSS('opacity', '0');
    const activity = page.getByRole('button', { name: 'Ran a command · read a node' });
    const [thoughtBox, activityBox] = await Promise.all([thought.boundingBox(), activity.boundingBox()]);
    expect(thoughtBox).toBeTruthy();
    expect(activityBox).toBeTruthy();
    expect(Math.abs(thoughtBox!.x - activityBox!.x)).toBeLessThan(1);
    await thought.hover();
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    await thought.click();
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    const reasoningBody = page.locator('.thread-reasoning-body');
    await expect(reasoningBody).toContainText('Inspect the current workspace');
    await expect(reasoningBody).toContainText('The workspace has enough evidence.');
    await expect(reasoningBody.locator('p')).toHaveCount(2);
    const summaryOnlyReasoning = page.locator('.thread-reasoning-summary');
    await expect(summaryOnlyReasoning).toHaveText('Thought· Preparing the final response');
    await expect(summaryOnlyReasoning.getByRole('button')).toHaveCount(0);

    const activityStatus = activity.locator('.thread-disclosure-status');
    const activityChevron = activity.locator('.thread-disclosure-chevron');
    await expect(activityStatus).toHaveCSS('opacity', '1');
    await expect(activityChevron).toHaveCSS('opacity', '0');
    await activity.hover();
    await expect(activityStatus).toHaveCSS('opacity', '0');
    await expect(activityChevron).toHaveCSS('opacity', '1');
    await activity.click();
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
    await command.click();
    await expect(command.locator('xpath=..').getByRole('button', { name: 'Copy output' })).toHaveCount(1);
    await command.locator('xpath=..').locator('.thread-tool-section').last().locator('.agent-code-block').hover();
    await page.getByRole('button', { name: 'Copy output' }).click();
    expect(await clipboardText(page)).toBe('/mock/workspace');

    await page.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe([
      '```tool bash',
      JSON.stringify({ command: 'pwd', cwd: '/mock/workspace' }, null, 2),
      '```',
      '',
      '```tool-result',
      '/mock/workspace',
      '```',
      '',
      '```tool node.read',
      JSON.stringify({ node_id: 'node-alpha' }, null, 2),
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

  test('keeps loaded Skills compact while isolated Skill runs remain expandable', async ({ page }) => {
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
    const loaded = page.locator('.thread-loaded-skill');
    await expect(loaded.locator('.thread-loaded-skill-name')).toHaveText('/review-pr');
    await expect(loaded.locator('.thread-loaded-skill-args')).toHaveText('429 --focus rendering');
    await expect(loaded.getByRole('button')).toHaveCount(0);

    const isolated = page.locator('.thread-tool-toggle');
    await expect(isolated).toHaveCount(1);
    await isolated.click();
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
      const provenance = (itemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: itemId });
      const turn = {
        id: turnId,
        items: [
          {
            id: userMessageId,
            type: 'userMessage',
            provenance: provenance(userMessageId),
            content: [{ type: 'text', text: 'Inspect the outline.' }],
          },
          {
            id: reasoningId,
            type: 'reasoning',
            provenance: provenance(reasoningId),
            summary: ['The outline is currently empty.'],
            content: [],
          },
        ],
        status: 'completed',
        error: null,
        createdAt: Date.now(),
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

    const thought = page.getByRole('button', { name: 'Thought' });
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('The outline is currently empty.', { exact: true })).toBeVisible();
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

    const steer = (await commandCalls(page)).filter((call) => call.cmd === 'turn/steer').at(-1);
    expect(steer?.args.input).toEqual([{ type: 'text', text: 'Use the shorter path.' }]);
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
    await transcript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ef01';
      const itemId = '01910000-0000-7000-8000-00000000ef02';
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
    });

    await expect(page.getByText('New evidence arrived.')).toHaveCount(1);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
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
    const savedTop = await transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const top = Math.max(1, Math.min(480, Math.floor(maximum / 2)));
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    expect(savedTop).toBeGreaterThan(0);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Long history' })
      .click();

    await expect(page.locator('.thread-dock-title')).toContainText('Long history');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(savedTop - 2);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(savedTop + 2);
  });
});

test('opens provider settings instead of creating a Thread when no provider is usable', async ({ page }) => {
  await openMockedApp(page, { agentProviderUsable: false });

  await page.getByRole('button', { name: 'Show Threads' }).click();
  await expect(page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open Providers' }).click();

  const calls = await commandCalls(page);
  expect(calls).toContainEqual({ cmd: 'open_settings', args: { category: 'providers' } });
  expect(calls.some((call) => call.cmd === 'thread/start')).toBe(false);
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
      'Copy message',
      'Continue in new chat',
      'Details',
    ]);
    const [errorBox, actionsBox] = await Promise.all([error.boundingBox(), actions.boundingBox()]);
    expect(errorBox).toBeTruthy();
    expect(actionsBox).toBeTruthy();
    expect(actionsBox!.y).toBeGreaterThanOrEqual(errorBox!.y + errorBox!.height - 1);
    await actions.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe('HTTP 404 - No endpoints found for gpt-5.4');

    const userMessage = page.locator('.thread-user-message').last();
    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Edit message' }).click();
    const editor = userMessage.getByRole('textbox', { name: 'Edit message' });
    await editor.fill('Try the attachment again');
    await editor.press('Control+Enter');

    const calls = await commandCalls(page);
    const starts = calls.filter((call) => call.cmd === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.args.input).toEqual([
      { type: 'text', text: 'Try the attachment again' },
      expect.objectContaining({ type: 'attachment', name: 'diagram.png', mimeType: 'image/png' }),
    ]);
    expect(calls.filter((call) => call.cmd === 'thread/rollback')).toHaveLength(1);
    expect(calls.filter((call) => call.cmd === 'thread/fork')).toHaveLength(0);
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
