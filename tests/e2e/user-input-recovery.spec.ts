import { expect, test, type Page } from '@playwright/test';
import { openMockedApp, commandCalls } from './outlinerMock';

async function ask(page: Page, threadId: string, itemId = 'input-1', revision = 1) {
  return page.evaluate(({ threadId, itemId, revision }) => {
    const request = { hostGeneration: 'mock-host', threadId, turnId: '01910000-0000-7000-8000-00000000ab01', itemId, revision,
      deadlineAt: Date.now() + 60_000, autoResolutionMs: 60_000,
      questions: [
        { id: 'scope', header: 'Scope', question: 'How broad?', options: [{ label: 'Focused', description: 'One module.' }, { label: 'Complete', description: 'All modules.' }] },
        { id: 'schedule', header: 'Schedule', question: 'When?', options: [{ label: 'Now', description: 'Today.' }, { label: 'Later', description: 'Tomorrow.' }] },
      ],
    };
    (window as any).__LIN_E2E__.emitAgentCoreNotification({ type: 'userInput/requested', threadId, turnId: request.turnId, itemId, request });
    return request;
  }, { threadId, itemId, revision });
}

async function createThread(page: Page) {
  await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread', exact: true }).click();
  return page.evaluate(async () => (await window.lin!.agentCoreRequest('thread/list', {})).data[0]!.id);
}

test('skipping a question preserves its withheld text, allows Back, and submits only the other answer', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = page.getByRole('form', { name: 'Input needed' });
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  await form.getByRole('textbox', { name: 'Other', exact: true }).fill('Not ready to share this');
  await form.getByRole('button', { name: 'Skip question', exact: true }).click();
  await expect(form).toContainText('2 of 2');
  await form.getByRole('button', { name: 'Previous question', exact: true }).click();
  await expect(form).toContainText('Skipped. Choose an answer');
  await expect(form.getByRole('textbox', { name: 'Other', exact: true })).toHaveValue('Not ready to share this');
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  await form.getByRole('radio', { name: /Now/ }).check();
  await form.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(form).toHaveCount(0);
  const submitted = (await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond');
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.answers).toEqual([{ questionId: 'scope', skipped: true }, { questionId: 'schedule', optionLabel: 'Now' }]);
  const recovery = page.locator('.thread-user-input-recovery');
  await recovery.locator('summary').click();
  await expect(recovery).toContainText('Question skipped');
  await expect(recovery).toContainText('Not ready to share this');
  await expect(recovery).not.toContainText('When?');
});

for (const skipFirst of [true, false]) {
  test(`the final skip submits immediately with ${skipFirst ? 'all questions skipped' : 'the earlier answer retained'}`, async ({ page }) => {
    await openMockedApp(page);
    const threadId = await createThread(page);
    await ask(page, threadId);
    const form = page.getByRole('form', { name: 'Input needed' });
    if (skipFirst) await form.getByRole('button', { name: 'Skip question', exact: true }).click();
    else {
      await form.getByRole('radio', { name: /Complete/ }).check();
      await form.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await form.getByRole('button', { name: 'Skip and submit', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('.thread-user-input-recovery')).toHaveCount(0);
    const submitted = (await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.args.answers).toEqual([
      { questionId: 'scope', ...(skipFirst ? { skipped: true } : { optionLabel: 'Complete' }) },
      { questionId: 'schedule', skipped: true },
    ]);
  });
}

test('automatic expiry retains every step through Thread switches and preserves rich drafts through explicit Send failure/retry', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/name/set', { threadId, name: 'Recovery conversation' }), threadId);
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  const original = await ask(page, threadId);
  const form = page.getByRole('form', { name: 'Input needed' });
  await form.getByRole('radio', { name: /Complete/ }).check();
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  await form.getByRole('textbox', { name: 'Other', exact: true }).fill('Still writing my answer');
  await createThread(page);
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: /Recovery conversation/ }).click();
  await expect(form.getByRole('textbox', { name: 'Other', exact: true })).toHaveValue('Still writing my answer');
  await expect(form).toContainText('2 of 2');
  await page.clock.fastForward(61_000);
  await expect(form).toHaveCount(0);
  const recovery = page.locator('.thread-user-input-recovery').filter({ hasText: 'Question expired' });
  await recovery.locator('summary').click();
  await expect(recovery).toContainText('Complete');
  await expect(recovery).toContainText('Still writing my answer');
  await composer.fill('Existing message.');
  await page.locator('.thread-composer-file-input').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment.') });
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  const next = await ask(page, threadId, 'input-2', 3);
  await expect(form).toBeVisible();
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Add to message' })).toHaveCount(0);
  await page.evaluate((request) => {
    (window as any).__LIN_E2E__.emitAgentCoreNotification({ type: 'userInput/cleared', threadId: request.threadId, turnId: request.turnId, itemId: request.itemId,
      settlement: { hostGeneration: request.hostGeneration, threadId: request.threadId, turnId: request.turnId, itemId: request.itemId,
        deadlineAt: request.deadlineAt, revision: 4, outcome: 'cancelled' } });
  }, next);
  await expect(form).toHaveCount(0);
  await expect(composer).toContainText('Existing message.');
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  await recovery.getByRole('button', { name: 'Add to message' }).click();
  await expect(composer).toContainText('Existing message.');
  await expect(composer).toContainText('Still writing my answer');
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond' || call.cmd === 'turn/submit')).toHaveLength(0);
  await page.evaluate(() => {
    const invoke = window.lin!.agentCoreRequest;
    let failed = false;
    window.lin!.agentCoreRequest = ((method: string, input: any) => {
      if (method === 'turn/submit' && !failed) { failed = true; return Promise.reject(new Error('Synthetic Send failure')); }
      return invoke(method as any, input);
    }) as typeof invoke;
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Synthetic Send failure', { exact: true })).toBeVisible();
  await expect(recovery).toBeVisible();
  await expect(composer).toContainText('Still writing my answer');
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  const sent = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').at(-1);
  expect(JSON.stringify(sent?.args.input)).toContain('Still writing my answer');
  expect(JSON.stringify(sent?.args.input)).toContain('kept.txt');
  expect((await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond')).toHaveLength(0);
  expect(original.itemId).not.toBe(next.itemId);
});
