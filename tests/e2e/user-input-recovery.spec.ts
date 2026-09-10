import { expect, test, type Page } from '@playwright/test';
import { openMockedApp, commandCalls } from './outlinerMock';
import { getMessages } from '../../src/core/i18n';

async function ask(page: Page, threadId: string, itemId = 'input-1', revision = 1, single = false, third = false, question = 'How broad?') {
  return page.evaluate(async ({ threadId, itemId, revision, single, third, question }) => {
    const request = { hostGeneration: 'mock-host', threadId, turnId: '01910000-0000-7000-8000-00000000ab01', itemId, revision,
      deadlineAt: Date.now() + 60_000, autoResolutionMs: 60_000,
      questions: [
        { id: 'scope', header: 'Scope', question, options: [{ label: 'Focused', description: 'One module.' }, { label: 'Complete', description: 'All modules.' }] },
        ...(!single ? [{ id: 'schedule', header: 'Schedule', question: 'When?', options: [{ label: 'Now', description: 'Today.' }, { label: 'Later', description: 'Tomorrow.' }] }] : []),
        ...(third ? [{ id: 'detail', header: 'Detail', question: 'How much detail?', options: [{ label: 'Summary', description: 'Main findings.' }, { label: 'Full', description: 'Every finding.' }] }] : []),
      ],
    };
    const previous = (await window.lin!.agentCoreRequest('thread/turns/list', { threadId })).data.find((turn) => turn.id === request.turnId);
    (window as any).__LIN_E2E__.emitAgentCoreNotification({ type: 'turn/started', threadId, turnId: request.turnId, turn: {
      id: request.turnId, itemsView: 'full', status: 'inProgress', error: null,
      provenance: { originThreadId: threadId, originTurnId: request.turnId, trigger: { kind: 'user' } },
      startedAt: Date.now(), completedAt: null, durationMs: null,
      items: [...(previous?.items ?? []), {
        id: itemId, type: 'dynamicToolCall', namespace: null, tool: 'request_user_input', arguments: { questions: request.questions },
        provenance: { originThreadId: threadId, originTurnId: request.turnId, originItemId: itemId },
        modelCall: { disposition: 'replayable', identity: { namespace: null, name: 'request_user_input' }, providerName: 'request_user_input',
          arguments: { storage: 'inline', value: { questions: request.questions } }, schemaDigest: '0'.repeat(64) },
        status: 'inProgress', outputRef: null, contentItems: null, success: null, durationMs: null,
      }],
    } });
    (window as any).__LIN_E2E__.emitAgentCoreNotification({ type: 'userInput/requested', threadId, turnId: request.turnId, itemId, request });
    return request;
  }, { threadId, itemId, revision, single, third, question });
}
async function createThread(page: Page, locale: 'en' | 'zh-Hans' = 'en') {
  const labels = getMessages(locale).agent.thread;
  await page.getByRole('button', { name: labels.list, exact: true }).click();
  await page.getByRole('dialog', { name: labels.title }).getByRole('button', { name: labels.new, exact: true }).click();
  return page.evaluate(async () => (await window.lin!.agentCoreRequest('thread/list', {})).data[0]!.id);
}
async function openQuestions(page: Page) {
  const form = page.getByRole('form', { name: 'Questions' });
  await expect(form).toBeVisible();
  return form;
}
async function responses(page: Page) { return (await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond'); }
async function openRecovery(page: Page) {
  const recovery = page.locator('.thread-transcript-content .thread-user-input-recovery').first();
  if (!await recovery.evaluate((element: HTMLDetailsElement) => element.open)) await recovery.locator(':scope > summary').click();
  await expect(recovery.getByRole('button')).toHaveCount(0);
  return recovery;
}

test('a focused empty composer immediately shows the first question without a preliminary choice', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
  await composer.focus();
  await expect(composer).toBeEmpty();
  await ask(page, threadId, 'three-questions', 1, false, true);
  const form = page.getByRole('form', { name: 'Questions' });
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
  await expect(form.getByRole('button')).toHaveCount(4);
  await form.getByRole('button', { name: 'Skip all', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(composer).toBeFocused();
  expect(await responses(page)).toHaveLength(1);
});

test('paired navigation browses every question without submitting and restores earlier answers', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId, 'three-questions', 1, false, true);
  const form = await openQuestions(page);
  const navigation = form.getByRole('navigation', { name: 'Question navigation' });
  const previous = navigation.getByRole('button', { name: 'Previous question', exact: true });
  const next = navigation.getByRole('button', { name: 'Next question', exact: true });
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(form.locator('.thread-user-input-footer').getByRole('button', { name: 'Next question' })).toHaveCount(0);
  const initialHeight = (await form.boundingBox())!.height;
  await form.getByRole('radio', { name: /Complete/ }).check();
  await next.click();
  await expect(navigation).toContainText('2 / 3');
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  const other = form.getByRole('textbox', { name: 'Your answer' });
  await expect(other).toBeFocused();
  await other.fill('Tuesday morning');
  expect((await form.boundingBox())!.height).toBeCloseTo(initialHeight, 0);
  await next.click();
  await expect(next).toBeDisabled();
  await form.getByRole('radio', { name: /Summary/ }).check();
  await previous.click();
  await expect(other).toHaveValue('Tuesday morning');
  await previous.click();
  await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
  expect(await responses(page)).toHaveLength(0);
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  expect((await responses(page))[0]!.args.answers).toEqual([
    { questionId: 'scope', optionLabel: 'Complete' },
    { questionId: 'schedule', otherText: 'Tuesday morning' },
    { questionId: 'detail', optionLabel: 'Summary' },
  ]);
});

test('unanswered questions stay local during navigation and become skips only on submission', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  await form.getByRole('button', { name: 'Previous question', exact: true }).click();
  await expect(form.getByRole('radio', { checked: true })).toHaveCount(0);
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  await form.getByRole('radio', { name: /Now/ }).check();
  expect(await responses(page)).toHaveLength(0);
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await expect(form).toHaveCount(0);
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.answers).toEqual([{ questionId: 'scope', skipped: true }, { questionId: 'schedule', optionLabel: 'Now' }]);
  await expect(page.locator('.thread-user-input-recovery')).toHaveCount(0);
});

for (const hasAnswers of [false, true]) {
  test(`Skip all sends no answers and preserves independent drafts (${hasAnswers ? 'answered last step' : 'empty first step'})`, async ({ page }) => {
    await openMockedApp(page);
    const threadId = await createThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
    await composer.fill('Keep this ordinary message.');
    await ask(page, threadId);
    const form = await openQuestions(page);
    if (hasAnswers) {
      await form.getByRole('radio', { name: /Complete/ }).check();
      await form.getByRole('button', { name: 'Next question', exact: true }).click();
      await form.getByRole('radio', { name: 'Other', exact: true }).check();
      await form.getByRole('textbox', { name: 'Your answer' }).fill('Keep this answer draft.');
    }
    expect(await responses(page)).toHaveLength(0);
    await form.getByRole('button', { name: 'Skip all', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(composer).toHaveText('Keep this ordinary message.');
    const submitted = await responses(page);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.args.intent).toBe('continue');
    expect(submitted[0]!.args.answers).toEqual([
      { questionId: 'scope', skipped: true },
      { questionId: 'schedule', skipped: true },
    ]);
    if (hasAnswers) {
      const recovery = await openRecovery(page);
      await expect(recovery).toContainText('Complete');
      await expect(recovery).toContainText('Keep this answer draft.');
      await expect(recovery).toContainText('This draft was not submitted.');
    } else await expect(page.locator('.thread-user-input-recovery')).toHaveCount(0);
  });
}

for (const action of ['Skip all', 'Submit answers'] as const) {
  test(`${action} explains a failed attempt and preserves the answers for retry`, async ({ page }) => {
    await openMockedApp(page);
    const threadId = await createThread(page);
    await ask(page, threadId);
    const form = await openQuestions(page);
    await form.getByRole('radio', { name: /Complete/ }).check();
    await page.evaluate(() => {
      const invoke = window.lin!.agentCoreRequest;
      let fail = true;
      window.lin!.agentCoreRequest = ((method: string, input: any) => {
        if (method === 'userInput/respond' && fail) {
          fail = false;
          return Promise.reject(new Error('Internal transport detail'));
        }
        return invoke(method as any, input);
      }) as typeof invoke;
    });
    await form.getByRole('button', { name: action, exact: true }).click();
    await expect(form.getByRole('alert')).toHaveText(action === 'Skip all'
      ? 'Could not skip the questions. Your draft is still here. Try again.'
      : 'Could not submit your answers. Your draft is still here. Try again.');
    await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
    expect(await responses(page)).toHaveLength(0);
    await form.getByRole('button', { name: action, exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(await responses(page)).toHaveLength(1);
  });
}

test('direct submission sends earlier and current answers while preserving inactive text', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  await form.getByRole('textbox', { name: 'Your answer' }).fill('A private alternative');
  await form.getByRole('radio', { name: /Complete/ }).check();
  await expect(form.getByRole('textbox', { name: 'Your answer', includeHidden: true })).toHaveValue('A private alternative');
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  await form.getByRole('textbox', { name: 'Your answer' }).fill('Next Tuesday');
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args).toMatchObject({ intent: 'answer', answers: [
    { questionId: 'scope', optionLabel: 'Complete' }, { questionId: 'schedule', otherText: 'Next Tuesday' },
  ] });
  expect(JSON.stringify(submitted[0]!.args)).not.toContain('private alternative');
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('A private alternative');
  await expect(recovery).toContainText('This draft was not submitted.');
  await expect(recovery).not.toContainText('Question skipped');
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
  await form.getByRole('radio', { name: /Complete/ }).press('Escape');
  await expect(form).toBeVisible();
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt')).toHaveLength(0);
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
  await expect(page.getByRole('form', { name: 'Questions' })).toBeVisible();
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
  await composer.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
  const form = page.getByRole('form', { name: 'Questions' });
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  await form.getByRole('textbox', { name: 'Your answer' }).fill('Keep this answer separate.');
  await form.getByRole('button', { name: 'Skip all', exact: true }).click();
  await expect(composer).toBeFocused();
  await page.getByRole('button', { name: /^(Send|Steer)$/ }).click();
  expect((await responses(page))[0]!.args.answers.every((answer: any) => answer.skipped)).toBe(true);
  const sends = (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit');
  expect(sends).toHaveLength(1);
  expect(JSON.stringify(sends[0]!.args)).toContain('I have more context.');
  expect(JSON.stringify(sends[0]!.args)).toContain('context.txt');
  expect(JSON.stringify(sends[0]!.args)).not.toContain('Keep this answer separate.');
  await expect(await openRecovery(page)).toContainText('Keep this answer separate.');
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
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(composer).toHaveText('Unrelated message draft.');
  const submitted = await responses(page);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.args.intent).toBe('answer');
  expect(JSON.stringify(submitted[0]!.args)).not.toContain('Unrelated message draft.');
  expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/submit')).toHaveLength(0);
});

test('expiry preserves the editing node and caret, then leaves a passive note independent of message sends', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
  await composer.fill('Existing message.');
  await page.locator('.thread-composer-file-input').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment.') });
  const originalMessage = await composer.textContent();
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).check();
  await form.getByRole('button', { name: 'Next question', exact: true }).click();
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  const editor = form.getByRole('textbox', { name: 'Your answer' });
  await editor.fill('Still writing my answer');
  await editor.evaluate((element: HTMLTextAreaElement) => { element.dataset.beforeExpiry = 'same'; element.setSelectionRange(5, 5); });
  await page.clock.fastForward(61_000);
  const retainedEditor = page.getByRole('form', { name: 'Answer draft' }).getByRole('textbox', { name: 'Your answer' });
  await expect(retainedEditor).toBeFocused();
  await expect(retainedEditor).toHaveAttribute('data-before-expiry', 'same');
  expect(await retainedEditor.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(5);
  await retainedEditor.pressSequentially(' continuing');
  await expect(retainedEditor).toHaveValue('Still continuing writing my answer');
  expect(await responses(page)).toHaveLength(0);
  await retainedEditor.press('Escape');
  await expect(composer).toHaveText(originalMessage!);
  await expect(page.locator('.thread-composer-attachment-item')).toHaveCount(1);
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Complete');
  await expect(recovery).toContainText('Still continuing writing my answer');
  await page.evaluate(() => {
    const invoke = window.lin!.agentCoreRequest;
    let failed = false;
    window.lin!.agentCoreRequest = ((method: string, input: any) => {
      if (method === 'turn/submit' && !failed) { failed = true; return Promise.reject(new Error('Synthetic Send failure')); }
      return invoke(method as any, input);
    }) as typeof invoke;
  });
  await page.getByRole('button', { name: /^(Send|Steer)$/ }).click();
  await expect(page.getByText('Synthetic Send failure', { exact: true })).toBeVisible();
  await expect(composer).toHaveText(originalMessage!);
  await expect(recovery).toBeVisible();
  await page.getByRole('button', { name: /^(Send|Steer)$/ }).click();
  await expect(composer).toBeEmpty();
  await expect(recovery).toContainText('Still continuing writing my answer');
});

test('ordinary message failure and retry leave skipped answers at the original question', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  const answer = form.getByRole('textbox', { name: 'Your answer' });
  await answer.fill('Answer draft.');
  await form.getByRole('button', { name: 'Skip all', exact: true }).click();
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
  await page.getByRole('button', { name: /^(Send|Steer)$/ }).click();
  await expect(page.getByText('Synthetic Send failure', { exact: true })).toBeVisible();
  await expect(composer).toHaveText('Message draft.');
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Answer draft.');
  expect(await responses(page)).toHaveLength(1);
  await page.getByRole('button', { name: /^(Send|Steer)$/ }).click();
  await expect(composer).toBeEmpty();
  await expect(recovery).toContainText('Answer draft.');
  expect(await responses(page)).toHaveLength(1);
});

test('a newer question leaves an expired editor in place and recovery stays available beside it', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: 'Other', exact: true }).check();
  const editor = form.getByRole('textbox', { name: 'Your answer' });
  await editor.fill('Still finishing this thought');
  await page.clock.fastForward(61_000);
  const retained = page.getByRole('form', { name: 'Answer draft' }).getByRole('textbox', { name: 'Your answer' });
  await expect(retained).toBeFocused();
  await ask(page, threadId, 'next-input', 3);
  await expect(retained).toBeFocused();
  await expect(page.getByRole('form', { name: 'Questions' })).toHaveCount(0);
  await retained.pressSequentially('.');
  await expect(retained).toHaveValue('Still finishing this thought.');
  await retained.press('Tab');
  await expect(page.getByRole('form', { name: 'Questions' })).toBeVisible();
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Still finishing this thought.');
  await expect(recovery).toHaveAttribute('data-user-input-item', 'input-1');
  await expect(page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true })).toBeEmpty();
  expect(await responses(page)).toHaveLength(0);
});

test('an unavailable receipt retains answers without claiming that submission failed or succeeded', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  const request = await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).check();
  await page.evaluate(async (request) => {
    const invoke = window.lin!.agentCoreRequest;
    window.lin!.agentCoreRequest = ((method: string, input: any) => {
      if (method === 'userInput/read') return Promise.resolve({ observed: null, state: {
        hostGeneration: request.hostGeneration, threadId: request.threadId, revision: request.revision + 1,
        activeTurnId: null, pending: null, settled: null,
      } });
      return invoke(method as any, input);
    }) as typeof invoke;
    const turn = (await invoke('thread/turns/list', { threadId: request.threadId })).data.find((turn) => turn.id === request.turnId)!;
    (window as any).__LIN_E2E__.emitAgentCoreNotification({ type: 'turn/completed', threadId: request.threadId, turnId: request.turnId,
      turn: { ...turn, status: 'completed', completedAt: Date.now() } });
  }, request);
  await expect(form).toHaveCount(0);
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText('Complete');
  await expect(recovery).toContainText('Could not confirm whether your answers were submitted.');
  await expect(recovery.locator('summary')).toContainText('Answer draft');
  await expect(recovery.locator('summary')).not.toContainText('Not submitted');
  expect(await responses(page)).toHaveLength(0);
});

test('Chinese question and draft actions keep the same meanings in a narrow dock', async ({ page }) => {
  const labels = getMessages('zh-Hans').agent.thread;
  await openMockedApp(page, { initialLanguage: 'zh-Hans' });
  const threadId = await createThread(page, 'zh-Hans');
  await ask(page, threadId);
  await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '320px'; element.style.minWidth = '320px'; });
  const form = page.getByRole('form', { name: labels.inputNeeded, exact: true });
  await form.getByRole('radio', { name: labels.other, exact: true }).check();
  await form.getByRole('textbox', { name: labels.inputWriteAnswer }).fill('Keep this local draft.');
  await expect(form.getByRole('button', { name: labels.inputSkipAll, exact: true })).toBeInViewport();
  await expect(form.getByRole('button', { name: labels.inputSendAnswers, exact: true })).toBeInViewport();
  expect(await form.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await form.screenshot({ animations: 'disabled', path: 'tmp/user-input-recovery/question-copy-zh.png' });
  await form.getByRole('button', { name: labels.inputSkipAll, exact: true }).click();
  const recovery = await openRecovery(page);
  await expect(recovery).toContainText(labels.inputRetainedDraft);
  await expect(recovery).toContainText(labels.inputNotSubmitted);
  await expect(recovery.getByRole('button')).toHaveCount(0);
  expect((await responses(page))[0]!.args.answers).toEqual([
    { questionId: 'scope', skipped: true }, { questionId: 'schedule', skipped: true },
  ]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`long questions scroll independently of navigation and submission in a narrow ${theme} dock`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await openMockedApp(page);
    const threadId = await createThread(page);
    await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '320px'; element.style.minWidth = '320px'; });
    await ask(page, threadId, 'long-question', 1, false, false,
      'Should the review cover one module or the complete workspace? Consider the editor, navigation, search, saved views, export, and agent interactions. Include keyboard access, recovery from interrupted work, and how existing drafts remain available while moving between questions.');
    const form = await openQuestions(page);
    const body = form.locator('.thread-user-input-step');
    const header = form.locator('.thread-user-input-heading');
    const footer = form.locator('.thread-user-input-footer');
    const before = { form: (await form.boundingBox())!, header: (await header.boundingBox())!, footer: (await footer.boundingBox())! };
    expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
    await form.getByRole('radio', { name: 'Other', exact: true }).check();
    await form.getByRole('textbox', { name: 'Your answer' }).fill('Start with the editor and revisit search afterward.');
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await header.boundingBox())!.y).toBeCloseTo(before.header.y, 0);
    expect((await footer.boundingBox())!.y).toBeCloseTo(before.footer.y, 0);
    expect((await form.boundingBox())!.height).toBeCloseTo(before.form.height, 0);
    await expect(form.getByRole('button', { name: 'Next question', exact: true })).toBeInViewport();
    await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toBeInViewport();
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/long-question-${theme}.png` });
    await form.getByRole('button', { name: 'Next question', exact: true }).click();
    expect((await form.boundingBox())!.height).toBeCloseTo(before.form.height, 0);
    await expect(form.getByRole('button', { name: 'Skip all', exact: true })).toBeInViewport();
    await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toBeInViewport();
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/last-question-${theme}.png` });
    await form.getByRole('button', { name: 'Previous question', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Start with the editor and revisit search afterward.');
    expect(await responses(page)).toHaveLength(0);
  });

  test(`question and recovery controls fit a narrow ${theme} dock`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await openMockedApp(page);
    const threadId = await createThread(page);
    await ask(page, threadId);
    const form = await openQuestions(page);
    await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '320px'; element.style.minWidth = '320px'; });
    await form.getByRole('radio', { name: 'Other', exact: true }).check();
    await form.getByRole('textbox', { name: 'Your answer' }).fill('A longer answer that remains editable in the narrow conversation dock.');
    const overflow = await form.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(form.getByRole('button', { name: 'Interrupt Turn', exact: true })).toHaveCount(0);
    await expect(form.locator('.thread-user-input-footer').getByRole('button')).toHaveCount(2);
    await page.locator('.agent-dock').screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/ux-320-${theme}.png` });
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/simplified-question-${theme}.png` });
    await expect(form.getByRole('button', { name: 'More question actions', exact: true })).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Previous question', exact: true })).toBeDisabled();
    await form.getByRole('textbox', { name: 'Your answer' }).press('Escape');
    await expect(form).toBeVisible();
    expect((await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt')).toHaveLength(0);
    await form.getByRole('button', { name: 'Next question', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible();
    await expect(page.locator('.thread-user-input-review')).toHaveCount(0);
    expect(await form.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  });
}
