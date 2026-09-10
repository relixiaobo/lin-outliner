import { expect, test, type Page } from '@playwright/test';
import { openMockedApp, commandCalls } from './outlinerMock';

async function ask(page: Page, threadId: string, itemId = 'input-1', revision = 1, single = false) {
  return page.evaluate(({ threadId, itemId, revision, single }) => {
    const request = { hostGeneration: 'mock-host', threadId, turnId: '01910000-0000-7000-8000-00000000ab01', itemId, revision,
      deadlineAt: Date.now() + 60_000, autoResolutionMs: 60_000,
      questions: [
        { id: 'scope', header: 'Scope', question: 'How broad?', options: [{ label: 'Focused', description: 'One module.' }, { label: 'Complete', description: 'All modules.' }] },
        ...(!single ? [{ id: 'schedule', header: 'Schedule', question: 'When?', options: [{ label: 'Now', description: 'Today.' }, { label: 'Later', description: 'Tomorrow.' }] }] : []),
      ],
    };
    (window as any).__LIN_E2E__.emitAgentCoreNotification({ type: 'userInput/requested', threadId, turnId: request.turnId, itemId, request });
    return request;
  }, { threadId, itemId, revision, single });
}
async function createThread(page: Page) {
  await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread', exact: true }).click();
  return page.evaluate(async () => (await window.lin!.agentCoreRequest('thread/list', {})).data[0]!.id);
}
async function openQuestions(page: Page) {
  const form = page.getByRole('form', { name: 'Input needed' });
  await expect.poll(async () => await form.isVisible() || await page.getByRole('button', { name: 'Answer questions', exact: true }).isVisible()).toBe(true);
  if (!await form.isVisible()) await page.getByRole('button', { name: 'Answer questions', exact: true }).click();
  await expect(form).toBeVisible();
  return form;
}
async function responses(page: Page) { return (await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond'); }
async function chooseQuestionAction(page: Page, name: string) {
  await page.getByRole('button', { name: 'More question actions', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function openRecovery(page: Page) {
  const shelf = page.locator('.thread-user-input-recoveries');
  await shelf.locator(':scope > summary').click();
  const recovery = shelf.locator('.thread-user-input-recovery').first();
  await recovery.locator(':scope > summary').click();
  return recovery;
}

test('skip stays local through review and only explicit submission sends partial answers', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('textbox', { name: 'Write an answer' }).fill('Not ready to share this');
  await form.getByRole('button', { name: 'Skip question', exact: true }).click();
  await form.getByRole('button', { name: 'Scope', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Write an answer' })).toHaveValue('Not ready to share this');
  await expect(form).toContainText('Unanswered');
  await form.getByRole('button', { name: 'Schedule', exact: true }).click();
  await form.getByRole('radio', { name: /Now/ }).check();
  await form.getByRole('button', { name: 'Review answers', exact: true }).last().click();
  expect(await responses(page)).toHaveLength(0);
  await expect(form.locator('.thread-user-input-review')).toContainText('Unanswered');
  await form.getByRole('button', { name: 'Send answers', exact: true }).click();
  await expect(form).toHaveCount(0);
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.answers).toEqual([{ questionId: 'scope', skipped: true }, { questionId: 'schedule', optionLabel: 'Now' }]);
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Not ready to share this');
  await expect(recovery).not.toContainText('When?');
});

for (const skipFirst of [true, false]) {
  test(`last skip opens review without submitting (${skipFirst ? 'all skipped' : 'partial answers'})`, async ({ page }) => {
    await openMockedApp(page);
    const threadId = await createThread(page);
    await ask(page, threadId);
    const form = await openQuestions(page);
    if (skipFirst) await form.getByRole('button', { name: 'Skip question', exact: true }).click();
    else {
      await form.getByRole('radio', { name: /Complete/ }).check();
      await form.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await form.getByRole('button', { name: 'Skip question', exact: true }).click();
    expect(await responses(page)).toHaveLength(0);
    await expect(form.locator('.thread-user-input-review')).toBeVisible();
    await expect(form.locator('.thread-user-input-review')).toBeFocused();
    await form.getByRole('button', { name: skipFirst ? 'Continue without answers' : 'Send answers', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('.thread-user-input-recoveries')).toHaveCount(0);
    expect((await responses(page))[0]!.args.answers).toEqual([
      { questionId: 'scope', ...(skipFirst ? { skipped: true } : { optionLabel: 'Complete' }) },
      { questionId: 'schedule', skipped: true },
    ]);
  });
}

test('Continue sends active earlier and current answers while preserving inactive text', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('textbox', { name: 'Write an answer' }).fill('A private alternative');
  await form.getByRole('radio', { name: /Complete/ }).check();
  await expect(form.getByRole('textbox', { name: 'Write an answer' })).toHaveValue('A private alternative');
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  await form.getByRole('textbox', { name: 'Write an answer' }).fill('Next Tuesday');
  await chooseQuestionAction(page, 'Continue with answers');
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args).toMatchObject({ intent: 'continue', answers: [
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
  await form.getByRole('textbox', { name: 'Write an answer' }).press('Escape');
  await expect(form).toHaveCount(0);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt')).toHaveLength(0);
  await openQuestions(page);
  await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
  await form.getByRole('button', { name: 'Send answer', exact: true }).click();
  expect(await responses(page)).toHaveLength(1);
});

test('an incoming question preserves message focus, IME, and attachments and permits direct discussion', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('I have more context.');
  await page.locator('.thread-composer-file-input').setInputFiles({ name: 'context.txt', mimeType: 'text/plain', buffer: Buffer.from('Read this context.') });
  await composer.focus();
  await composer.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'context' })));
  await ask(page, threadId);
  await expect(composer).toBeFocused();
  await expect(composer).toContainText('I have more context.');
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  await expect(page.getByRole('form', { name: 'Input needed' })).toHaveCount(0);
  await composer.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
  await page.getByRole('button', { name: 'Send and discuss', exact: true }).click();
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.intent).toBe('discuss');
  expect(JSON.stringify(submitted[0]!.args.message)).toContain('I have more context.');
  expect(JSON.stringify(submitted[0]!.args.message)).toContain('context.txt');
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/submit')).toHaveLength(0);
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
});

test('Chat stays local and a lost discussion acknowledgement reconciles the one accepted message', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).check();
  await chooseQuestionAction(page, 'Chat about this');
  expect(await responses(page)).toHaveLength(0);
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await expect(composer).toBeFocused();
  await composer.fill('What does the second question mean?');
  await page.evaluate(() => {
    const invoke = window.lin!.agentCoreRequest;
    window.lin!.agentCoreRequest = (async (method: string, input: any) => {
      const response = await invoke(method as any, input);
      if (method === 'userInput/respond') throw new Error('Synthetic lost acknowledgement');
      return response;
    }) as typeof invoke;
  });
  await page.getByRole('button', { name: 'Send and discuss', exact: true }).click();
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
  await expect(composer).toBeEmpty();
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.answers).toEqual([{ questionId: 'scope', optionLabel: 'Complete' }, { questionId: 'schedule', skipped: true }]);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/submit')).toHaveLength(0);
});

test('expiry preserves the same editing node, caret, every step, and explicit recovery through Send failure', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Existing message.');
  await page.locator('.thread-composer-file-input').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment.') });
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).check();
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  const editor = form.getByRole('textbox', { name: 'Write an answer' });
  await editor.fill('Still writing my answer');
  await editor.evaluate((element: HTMLTextAreaElement) => { element.dataset.beforeExpiry = 'same'; element.setSelectionRange(5, 5); });
  await page.clock.fastForward(61_000);
  const retainedEditor = page.getByRole('form', { name: 'Unsent answer draft' }).getByRole('textbox', { name: 'Write an answer' });
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

test('late receipt recovery clears only the accepted message when notification, response, and first read were lost', async ({ page }) => {
  await openMockedApp(page, { dropDiscussionNotifications: true });
  const threadId = await createThread(page);
  await ask(page, threadId);
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Please discuss this once.');
  await page.evaluate(() => {
    const invoke = window.lin!.agentCoreRequest;
    let accepted = false;
    (window as any).__allowInputReads = false;
    window.lin!.agentCoreRequest = (async (method: string, input: any) => {
      if (method === 'userInput/read' && accepted && !(window as any).__allowInputReads) throw new Error('Synthetic read loss');
      const response = await invoke(method as any, input);
      if (method === 'userInput/respond') { accepted = true; throw new Error('Synthetic unconfirmed submission'); }
      return response;
    }) as typeof invoke;
  });
  await page.getByRole('button', { name: 'Send and discuss', exact: true }).click();
  await expect(composer).toContainText('Please discuss this once.');
  await expect(page.getByRole('button', { name: 'Send and discuss', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).__allowInputReads = true; });
  await page.locator('.thread-user-input-recovery-state').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(composer).toBeEmpty();
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
  expect(await responses(page)).toHaveLength(1);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/submit')).toHaveLength(0);
});

test('a newer question leaves an expired editor in place and recovery stays available beside it', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  const editor = form.getByRole('textbox', { name: 'Write an answer' });
  await editor.fill('Still finishing this thought');
  await page.clock.fastForward(61_000);
  const retained = page.getByRole('form', { name: 'Unsent answer draft' }).getByRole('textbox', { name: 'Write an answer' });
  await expect(retained).toBeFocused();
  await ask(page, threadId, 'next-input', 3);
  await expect(retained).toBeFocused();
  await expect(page.getByRole('button', { name: 'Answer questions', exact: true })).toBeVisible();
  await retained.pressSequentially('.');
  await expect(retained).toHaveValue('Still finishing this thought.');
  await page.getByRole('button', { name: 'Answer questions', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Input needed' })).toBeVisible();
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Still finishing this thought.');
  await recovery.getByRole('button', { name: 'Add to message', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toContainText('Still finishing this thought.');
  expect(await responses(page)).toHaveLength(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`question, review, and recovery controls fit a narrow ${theme} dock`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await openMockedApp(page);
    const threadId = await createThread(page);
    await ask(page, threadId);
    const form = await openQuestions(page);
    await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '320px'; element.style.minWidth = '320px'; });
    await form.getByRole('textbox', { name: 'Write an answer' }).fill('A longer answer that remains editable in the narrow conversation dock.');
    const overflow = await form.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(form.getByRole('button', { name: 'Interrupt Turn', exact: true })).toHaveCount(0);
    await expect(form.locator('.thread-user-input-footer').getByRole('button')).toHaveCount(3);
    await page.locator('.agent-dock').screenshot({ path: `tmp/user-input-recovery/ux-320-${theme}.png` });
    await form.screenshot({ path: `tmp/user-input-recovery/simplified-question-${theme}.png` });
    await form.getByRole('button', { name: 'More question actions', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'More question actions', exact: true });
    await expect(menu.getByRole('menuitem', { name: 'Chat about this', exact: true })).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: 'Continue with answers', exact: true })).toBeVisible();
    await menu.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(form).toBeVisible();
    expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt')).toHaveLength(0);
    await form.getByRole('button', { name: 'Next', exact: true }).click();
    await form.getByRole('button', { name: 'Review answers', exact: true }).click();
    expect(await form.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  });
}
