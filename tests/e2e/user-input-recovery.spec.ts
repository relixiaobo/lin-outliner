import { expect, test, type Page } from '@playwright/test';
import { openMockedApp, commandCalls } from './outlinerMock';

async function ask(page: Page, threadId: string, itemId = 'input-1', revision = 1, single = false, third = false) {
  return page.evaluate(({ threadId, itemId, revision, single, third }) => {
    const request = { hostGeneration: 'mock-host', threadId, turnId: '01910000-0000-7000-8000-00000000ab01', itemId, revision,
      deadlineAt: Date.now() + 60_000, autoResolutionMs: 60_000,
      questions: [
        { id: 'scope', header: 'Scope', question: 'How broad?', options: [{ label: 'Focused', description: 'One module.' }, { label: 'Complete', description: 'All modules.' }] },
        ...(!single ? [{ id: 'schedule', header: 'Schedule', question: 'When?', options: [{ label: 'Now', description: 'Today.' }, { label: 'Later', description: 'Tomorrow.' }] }] : []),
        ...(third ? [{ id: 'detail', header: 'Detail', question: 'How much detail?', options: [{ label: 'Summary', description: 'Main findings.' }, { label: 'Full', description: 'Every finding.' }] }] : []),
      ],
    };
    (window as any).__LIN_E2E__.emitAgentCoreNotification({ type: 'userInput/requested', threadId, turnId: request.turnId, itemId, request });
    return request;
  }, { threadId, itemId, revision, single, third });
}
async function createThread(page: Page) {
  await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread', exact: true }).click();
  return page.evaluate(async () => (await window.lin!.agentCoreRequest('thread/list', {})).data[0]!.id);
}
async function openQuestions(page: Page) {
  const form = page.getByRole('form', { name: 'Input needed' });
  const back = page.getByRole('button', { name: 'Resume questions', exact: true });
  if (await back.isVisible()) await back.click();
  await expect(form).toBeVisible();
  return form;
}
async function responses(page: Page) { return (await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond'); }
async function openRecovery(page: Page) {
  const shelf = page.locator('.thread-user-input-recoveries');
  await shelf.locator(':scope > summary').click();
  const recovery = shelf.locator('.thread-user-input-recovery').first();
  await recovery.locator(':scope > summary').click();
  return recovery;
}

test('a focused empty composer immediately shows the first question without a preliminary choice', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
  await composer.focus();
  await expect(composer).toBeEmpty();
  await ask(page, threadId, 'three-questions', 1, false, true);
  const form = page.getByRole('form', { name: 'Input needed' });
  await expect(form.getByRole('radio', { name: /Complete/ })).toBeVisible();
  await expect(form.locator('.thread-user-input-step')).toBeFocused();
  await expect(form).toContainText('Question 1 of 3');
  await expect(composer).toBeHidden();
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Answer questions', exact: true })).toHaveCount(0);
  expect(await responses(page)).toHaveLength(0);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.locator('.agent-dock').screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/direct-question-${colorScheme}.png` });
  }
  await form.getByRole('button', { name: 'Close questions', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume questions', exact: true })).toBeVisible();
  await expect(page.getByText('Send your message and the active answers to discuss these questions.', { exact: true })).toHaveCount(0);
  await expect(composer).toBeFocused();
  await page.getByRole('button', { name: 'Resume questions', exact: true }).click();
  await expect(form.getByRole('radio', { name: /Complete/ })).toBeVisible();
  expect(await responses(page)).toHaveLength(0);
});

test('skipping a question stays local and the last question submits directly', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('textbox', { name: 'Other answer' }).fill('Not ready to share this');
  await form.getByRole('button', { name: 'Skip', exact: true }).click();
  await form.getByRole('button', { name: 'Previous question', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Other answer' })).toHaveValue('Not ready to share this');
  await expect(form).toContainText('Unanswered');
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  await form.getByRole('radio', { name: /Now/ }).check();
  expect(await responses(page)).toHaveLength(0);
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await expect(form).toHaveCount(0);
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.answers).toEqual([{ questionId: 'scope', skipped: true }, { questionId: 'schedule', optionLabel: 'Now' }]);
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Not ready to share this');
  await expect(recovery).not.toContainText('When?');
});

for (const skipFirst of [true, false]) {
  test(`last Skip and finish explicitly submits once (${skipFirst ? 'all skipped' : 'partial answers'})`, async ({ page }) => {
    await openMockedApp(page);
    const threadId = await createThread(page);
    await ask(page, threadId);
    const form = await openQuestions(page);
    if (skipFirst) await form.getByRole('button', { name: 'Skip', exact: true }).click();
    else {
      await form.getByRole('radio', { name: /Complete/ }).check();
      await form.getByRole('button', { name: 'Next question', exact: true }).click();
    }
    expect(await responses(page)).toHaveLength(0);
    await form.getByRole('button', { name: 'Skip and finish', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('.thread-user-input-recoveries')).toHaveCount(0);
    const submitted = await responses(page);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.args.answers).toEqual([
      { questionId: 'scope', ...(skipFirst ? { skipped: true } : { optionLabel: 'Complete' }) },
      { questionId: 'schedule', skipped: true },
    ]);
  });
}

test('direct submission sends earlier and current answers while preserving inactive text', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('textbox', { name: 'Other answer' }).fill('A private alternative');
  await form.getByRole('radio', { name: /Complete/ }).check();
  await expect(form.getByRole('textbox', { name: 'Other answer' })).toHaveValue('A private alternative');
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  await form.getByRole('textbox', { name: 'Other answer' }).fill('Next Tuesday');
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args).toMatchObject({ intent: 'answer', answers: [
    { questionId: 'scope', optionLabel: 'Complete' }, { questionId: 'schedule', otherText: 'Next Tuesday' },
  ] });
  expect(JSON.stringify(submitted[0]!.args)).not.toContain('private alternative');
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('A private alternative');
  await expect(recovery).not.toContainText('Next Tuesday');
});

test('single choice never auto-selects or submits and Escape does not stop the task', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId, 'single', 1, true);
  const form = await openQuestions(page);
  await expect(form.getByRole('radio').first()).not.toBeChecked();
  await form.getByRole('radio', { name: /Complete/ }).check();
  expect(await responses(page)).toHaveLength(0);
  await form.getByRole('textbox', { name: 'Other answer' }).press('Escape');
  await expect(form).toHaveCount(0);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt')).toHaveLength(0);
  await openQuestions(page);
  await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  expect(await responses(page)).toHaveLength(1);
});

test('message focus, IME, attachments, and sending remain independent of the question', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
  await composer.fill('I have more context.');
  await page.locator('.thread-composer-file-input').setInputFiles({ name: 'context.txt', mimeType: 'text/plain', buffer: Buffer.from('Read this context.') });
  await composer.focus();
  await composer.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'context' })));
  const originalComposer = await composer.elementHandle();
  await ask(page, threadId);
  await expect(composer).toBeHidden();
  expect(await composer.evaluate((element, original) => element === original, originalComposer)).toBe(true);
  await expect(composer).toContainText('I have more context.');
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  await expect(page.getByRole('form', { name: 'Input needed' })).toBeVisible();
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
  await composer.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
  const form = page.getByRole('form', { name: 'Input needed' });
  await form.getByRole('textbox', { name: 'Other answer' }).fill('Keep this answer separate.');
  await form.getByRole('textbox', { name: 'Other answer' }).press('Escape');
  await expect(composer).toBeFocused();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(await responses(page)).toHaveLength(0);
  const sends = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit');
  expect(sends).toHaveLength(1);
  expect(JSON.stringify(sends[0]!.args)).toContain('I have more context.');
  expect(JSON.stringify(sends[0]!.args)).toContain('context.txt');
  expect(JSON.stringify(sends[0]!.args)).not.toContain('Keep this answer separate.');
  await openQuestions(page);
  await expect(form.getByRole('textbox', { name: 'Other answer' })).toHaveValue('Keep this answer separate.');
  await expect(composer).toBeEmpty();
});

test('answer submission and a lost acknowledgement never consume the ordinary message draft', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
  await composer.fill('Unrelated message draft.');
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).check();
  await page.evaluate(() => {
    const invoke = window.lin!.agentCoreRequest;
    window.lin!.agentCoreRequest = (async (method: string, input: any) => {
      const response = await invoke(method as any, input);
      if (method === 'userInput/respond') throw new Error('Synthetic lost acknowledgement');
      return response;
    }) as typeof invoke;
  });
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(composer).toHaveText('Unrelated message draft.');
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.intent).toBe('answer');
  expect(JSON.stringify(submitted[0]!.args)).not.toContain('Unrelated message draft.');
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/submit')).toHaveLength(0);
});

test('expiry preserves the same editing node, caret, every step, and explicit recovery through Send failure', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
  await composer.fill('Existing message.');
  await page.locator('.thread-composer-file-input').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment.') });
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).check();
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  const editor = form.getByRole('textbox', { name: 'Other answer' });
  await editor.fill('Still writing my answer');
  await editor.evaluate((element: HTMLTextAreaElement) => { element.dataset.beforeExpiry = 'same'; element.setSelectionRange(5, 5); });
  await page.clock.fastForward(61_000);
  const retainedEditor = page.getByRole('form', { name: 'Unsent answer draft' }).getByRole('textbox', { name: 'Other answer' });
  await expect(retainedEditor).toBeFocused();
  await expect(retainedEditor).toHaveAttribute('data-before-expiry', 'same');
  expect(await retainedEditor.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(5);
  await retainedEditor.pressSequentially(' continuing');
  await expect(retainedEditor).toHaveValue('Still continuing writing my answer');
  expect(await responses(page)).toHaveLength(0);
  await page.getByRole('form', { name: 'Unsent answer draft' }).getByRole('button', { name: 'Add to message', exact: true }).click();
  await expect(composer).toContainText('Existing message.');
  await expect(composer).toContainText('Complete');
  await expect(composer).toContainText('Still continuing writing my answer');
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  const recovery = await openRecovery(page);
  await expect(recovery.getByRole('button', { name: 'In message draft', exact: true })).toBeDisabled();
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
  await expect(composer).toContainText('Still continuing writing my answer');
  await expect(recovery).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.thread-user-input-recoveries')).toHaveCount(0);
});

test('ordinary message failure and retry preserve both drafts without answering the question', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  const answer = form.getByRole('textbox', { name: 'Other answer' });
  await answer.fill('Answer draft.');
  await answer.press('Escape');
  const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
  await composer.fill('Message draft.');
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
  await expect(composer).toHaveText('Message draft.');
  await openQuestions(page);
  await expect(answer).toHaveValue('Answer draft.');
  await answer.press('Escape');
  expect(await responses(page)).toHaveLength(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer).toBeEmpty();
  await openQuestions(page);
  await expect(answer).toHaveValue('Answer draft.');
  await answer.press('Escape');
  expect(await responses(page)).toHaveLength(0);
});

test('a newer question leaves an expired editor in place and recovery stays available beside it', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  const editor = form.getByRole('textbox', { name: 'Other answer' });
  await editor.fill('Still finishing this thought');
  await page.clock.fastForward(61_000);
  const retained = page.getByRole('form', { name: 'Unsent answer draft' }).getByRole('textbox', { name: 'Other answer' });
  await expect(retained).toBeFocused();
  await ask(page, threadId, 'next-input', 3);
  await expect(retained).toBeFocused();
  await expect(page.getByRole('button', { name: 'How broad?', exact: true })).toBeVisible();
  await retained.pressSequentially('.');
  await expect(retained).toHaveValue('Still finishing this thought.');
  await page.getByRole('button', { name: 'How broad?', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Input needed' })).toBeVisible();
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Still finishing this thought.');
  await recovery.getByRole('button', { name: 'Add to message', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true })).toContainText('Still finishing this thought.');
  expect(await responses(page)).toHaveLength(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`question and recovery controls fit a narrow ${theme} dock`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await openMockedApp(page);
    const threadId = await createThread(page);
    await ask(page, threadId);
    const form = await openQuestions(page);
    await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '320px'; element.style.minWidth = '320px'; });
    await form.getByRole('textbox', { name: 'Other answer' }).fill('A longer answer that remains editable in the narrow conversation dock.');
    const overflow = await form.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(form.getByRole('button', { name: 'Interrupt Turn', exact: true })).toHaveCount(0);
    await expect(form.locator('.thread-user-input-footer').getByRole('button')).toHaveCount(2);
    await page.locator('.agent-dock').screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/ux-320-${theme}.png` });
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/simplified-question-${theme}.png` });
    await expect(form.getByRole('button', { name: 'More question actions', exact: true })).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Previous question', exact: true })).toBeDisabled();
    await form.getByRole('textbox', { name: 'Other answer' }).press('Escape');
    await expect(form).toHaveCount(0);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt')).toHaveLength(0);
    await openQuestions(page);
    await form.getByRole('button', { name: 'Next question', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible();
    await expect(page.locator('.thread-user-input-review')).toHaveCount(0);
    expect(await form.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  });
}
