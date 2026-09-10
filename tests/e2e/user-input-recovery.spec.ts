import { expect, test, type Page } from '@playwright/test';
import { openMockedApp, commandCalls } from './outlinerMock';
import { getMessages } from '../../src/core/i18n';

async function ask(page: Page, threadId: string, itemId = 'input-1', revision = 1, single = false, third = false, question = 'How broad?', options?: Array<{ label: string; description: string }>) {
  return page.evaluate(async ({ threadId, itemId, revision, single, third, question, options }) => {
    const request = { hostGeneration: 'mock-host', threadId, turnId: '01910000-0000-7000-8000-00000000ab01', itemId, revision,
      deadlineAt: Date.now() + 60_000, autoResolutionMs: 60_000,
      questions: [
        { id: 'scope', header: 'Scope', question, options: options ?? [{ label: 'Focused', description: 'One module.' }, { label: 'Complete', description: 'All modules.' }] },
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
  }, { threadId, itemId, revision, single, third, question, options });
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
  await expect(form.locator('.thread-user-input-position')).toContainText('Question 1 of 3');
  await expect(composer).toBeHidden();
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Answer questions', exact: true })).toHaveCount(0);
  expect(await responses(page)).toHaveLength(0);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.locator('.agent-dock').screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/direct-question-${colorScheme}.png` });
  }
  await expect(form.getByRole('button')).toHaveCount(4);
  await expect(form.locator('.thread-user-input-heading').getByRole('button')).toHaveCount(2);
  await form.getByRole('button', { name: 'Skip all', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(composer).toBeFocused();
  expect(await responses(page)).toHaveLength(1);
});

test('Next only navigates and final submission includes answers retained through Previous', async ({ page }) => {
  await openMockedApp(page);
  await page.clock.install();
  const threadId = await createThread(page);
  await ask(page, threadId, 'three-questions', 1, false, true);
  const form = await openQuestions(page);
  await expect(form.getByRole('timer')).toHaveText('1:00');
  await expect(form.getByRole('timer')).toHaveAttribute('title', getMessages('en').agent.thread.inputDeadlineHint);
  await page.clock.fastForward(6_000);
  await expect(form.getByRole('timer')).toHaveText('0:54');
  const navigation = form.locator('.thread-user-input-heading');
  const previous = navigation.getByRole('button', { name: 'Previous question', exact: true });
  const next = form.getByRole('button', { name: 'Next', exact: true });
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(0);
  const initialHeight = (await form.boundingBox())!.height;
  const footerY = (await form.locator('.thread-user-input-footer').boundingBox())!.y;
  await form.getByRole('radio', { name: /Complete/ }).press('Space');
  await next.click();
  await expect(form.locator('.thread-user-input-position')).toContainText('2 / 3');
  await form.getByRole('textbox', { name: 'Your answer' }).focus();
  const other = form.getByRole('textbox', { name: 'Your answer' });
  await expect(other).toBeFocused();
  await other.fill('Tuesday morning');
  expect((await form.boundingBox())!.height).toBeCloseTo(initialHeight, 0);
  expect((await form.locator('.thread-user-input-footer').boundingBox())!.y).toBeCloseTo(footerY, 0);
  await next.click();
  await expect(next).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toBeEnabled();
  await form.getByRole('radio', { name: /Summary/ }).press('Space');
  await previous.click();
  await expect(other).toHaveValue('Tuesday morning');
  await previous.click();
  await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
  await expect(form.getByRole('timer')).toHaveText('0:54');
  expect(await responses(page)).toHaveLength(0);
  await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(0);
  await next.click();
  await next.click();
  expect(await responses(page)).toHaveLength(0);
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  expect((await responses(page))[0]!.args.answers).toEqual([
    { questionId: 'scope', optionLabel: 'Complete' },
    { questionId: 'schedule', otherText: 'Tuesday morning' },
    { questionId: 'detail', optionLabel: 'Summary' },
  ]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`free-text questions require text for Next and retain it when browsing in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await openMockedApp(page);
    const threadId = await createThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
    await composer.fill('An independent message draft.');
    await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '344px'; element.style.minWidth = '344px'; });
    await ask(page, threadId, 'free-text', 1, false, false, 'What should the greeting say?', []);
    const form = await openQuestions(page);
    const reply = form.getByRole('textbox', { name: 'Your answer' });
    const next = form.getByRole('button', { name: 'Next', exact: true });
    await expect(form.getByRole('radio')).toHaveCount(0);
    await expect(reply).toHaveAttribute('placeholder', 'Reply…');
    await expect(next).toBeDisabled();
    await reply.fill('   ');
    await expect(next).toBeDisabled();
    await reply.fill('');
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/free-text-empty-${theme}.png` });
    const shortHeight = (await reply.boundingBox())!.height;
    await reply.fill('A longer greeting that wraps naturally in the narrow dock. '.repeat(12));
    expect((await reply.boundingBox())!.height).toBeGreaterThan(shortHeight);
    expect(await reply.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(next).toBeInViewport();
    await reply.fill('Hello');
    await expect(next).toBeEnabled();
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/free-text-filled-${theme}.png` });
    await next.click();
    expect(await responses(page)).toHaveLength(0);
    await expect(form.getByRole('button', { name: 'Next question', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: 'Previous question', exact: true }).click();
    await expect(reply).toHaveValue('Hello');
    await reply.fill('');
    await expect(next).toBeDisabled();
    await reply.fill('Hello again');
    await next.click();
    await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
    expect((await responses(page))[0]!.args.answers).toEqual([
      { questionId: 'scope', otherText: 'Hello again' }, { questionId: 'schedule', skipped: true },
    ]);
    await expect(composer).toHaveText('An independent message draft.');
  });
}

test('tabbing into the response field preserves the selected option until text is edited', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId, 'keyboard-answer', 1, true);
  const form = await openQuestions(page);
  const option = form.getByRole('radio', { name: /Complete/ });
  await option.press('Space');
  await option.press('Tab');
  const response = form.getByRole('textbox', { name: 'Your answer' });
  await expect(response).toBeFocused();
  await expect(option).toBeChecked();
  await response.fill('Use my own scope.');
  await expect(option).not.toBeChecked();
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  expect((await responses(page))[0]!.args.answers).toEqual([{ questionId: 'scope', otherText: 'Use my own scope.' }]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`preset and custom answers switch in place without editing the retained text in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await openMockedApp(page);
    const threadId = await createThread(page);
    await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '320px'; element.style.minWidth = '320px'; });
    await ask(page, threadId, 'switch-answer', 1, true);
    const form = await openQuestions(page);
    const preset = form.getByRole('radio', { name: /Complete/ });
    const custom = form.getByRole('radio', { name: 'Your answer', exact: true });
    const response = form.getByRole('textbox', { name: 'Your answer' });
    const submit = form.getByRole('button', { name: 'Submit answers', exact: true });
    await preset.click();
    const editor = await response.elementHandle();
    const position = await response.boundingBox();
    const height = (await form.boundingBox())!.height;
    expect((await preset.boundingBox())!.width).toBeLessThanOrEqual(16);
    await custom.click();
    await expect(response).toBeFocused();
    await expect(custom).toBeChecked();
    await expect(preset).not.toBeChecked();
    await expect(submit).toBeDisabled();
    expect(await response.boundingBox()).toEqual(position);
    await response.fill('A custom scope');
    await preset.click();
    await expect(preset).toBeChecked();
    await expect(custom).not.toBeChecked();
    await expect(response).toHaveValue('A custom scope');
    expect(await response.boundingBox()).toEqual(position);
    await page.mouse.move(0, 0);
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/preset-with-text-${theme}.png` });
    await response.click();
    await expect(custom).toBeChecked();
    await expect(response).toHaveValue('A custom scope');
    await expect(submit).toBeEnabled();
    expect(await response.evaluate((element, original) => element === original, editor)).toBe(true);
    expect((await form.boundingBox())!.height).toBe(height);
    await page.mouse.move(0, 0);
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/custom-restored-${theme}.png` });
    await preset.click();
    await preset.press('ArrowDown');
    await expect(custom).toBeChecked();
    await expect(custom).toBeFocused();
    await custom.press('Tab');
    await expect(response).toBeFocused();
    await expect(response).toHaveValue('A custom scope');
    expect(await responses(page)).toHaveLength(0);
    await submit.click();
    expect((await responses(page))[0]!.args.answers).toEqual([{ questionId: 'scope', otherText: 'A custom scope' }]);
  });
}

test('double-clicking Next cannot submit the final question', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).press('Space');
  await form.getByRole('button', { name: 'Next', exact: true }).dblclick();
  await expect(form.locator('.thread-user-input-position')).toContainText('2 / 2');
  const submit = form.getByRole('button', { name: 'Submit answers', exact: true });
  await expect(submit).toBeEnabled();
  expect(await responses(page)).toHaveLength(0);
  await submit.click();
  expect(await responses(page)).toHaveLength(1);
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
  await form.getByRole('radio', { name: /Now/ }).press('Space');
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
      await form.getByRole('radio', { name: /Complete/ }).press('Space');
      await form.getByRole('button', { name: 'Next', exact: true }).click();
      await form.getByRole('textbox', { name: 'Your answer' }).focus();
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
    await ask(page, threadId, 'single-attempt', 1, true);
    const form = await openQuestions(page);
    await form.getByRole('radio', { name: /Complete/ }).press('Space');
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

test('final submission sends earlier and current answers while preserving inactive text', async ({ page }) => {
  await openMockedApp(page);
  const threadId = await createThread(page);
  await ask(page, threadId);
  const form = await openQuestions(page);
  await form.getByRole('textbox', { name: 'Your answer' }).focus();
  await form.getByRole('textbox', { name: 'Your answer' }).fill('A private alternative');
  await form.getByRole('radio', { name: /Complete/ }).press('Space');
  await expect(form.getByRole('textbox', { name: 'Your answer', includeHidden: true })).toHaveValue('A private alternative');
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  await form.getByRole('textbox', { name: 'Your answer' }).focus();
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
  await form.getByRole('radio', { name: /Complete/ }).press('Space');
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
  await form.getByRole('textbox', { name: 'Your answer' }).focus();
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
  await ask(page, threadId, 'single-acknowledgement', 1, true);
  const form = await openQuestions(page);
  await form.getByRole('radio', { name: /Complete/ }).press('Space');
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
  await form.getByRole('radio', { name: /Complete/ }).press('Space');
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  await form.getByRole('textbox', { name: 'Your answer' }).focus();
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
  await form.getByRole('textbox', { name: 'Your answer' }).focus();
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
  await form.getByRole('textbox', { name: 'Your answer' }).focus();
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
  await form.getByRole('radio', { name: /Complete/ }).press('Space');
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
  await form.getByRole('textbox', { name: labels.inputWriteAnswer }).focus();
  await form.getByRole('textbox', { name: labels.inputWriteAnswer }).fill('Keep this local draft.');
  await expect(form.getByRole('button', { name: labels.inputSkipAll, exact: true })).toBeInViewport();
  await expect(form.locator('.thread-user-input-footer').getByRole('button', { name: labels.inputNext, exact: true })).toBeInViewport();
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
  test(`short questions group metadata and fit their content in a ${theme} dock`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await openMockedApp(page);
    const threadId = await createThread(page);
    await page.locator('.agent-dock').evaluate((element: HTMLElement) => { element.style.width = '344px'; element.style.minWidth = '344px'; });
    await ask(page, threadId, 'color-question', 1, false, true, '你更喜欢哪种颜色？', [
      { label: '蓝色 (Recommended)', description: '平静、专业的常见选择' },
      { label: '红色', description: '热情、醒目' },
      { label: '绿色', description: '自然、清新' },
    ]);
    const form = await openQuestions(page);
    const header = form.locator('.thread-user-input-heading');
    const body = form.locator('.thread-user-input-step');
    const footer = form.locator('.thread-user-input-footer');
    await expect(header.locator('.thread-user-input-countdown')).toBeVisible();
    await expect(footer.getByRole('button')).toHaveCount(2);
    await expect(footer.locator('.thread-user-input-countdown')).toHaveCount(0);
    const bounds = { form: (await form.boundingBox())!, body: (await body.boundingBox())!, footer: (await footer.boundingBox())! };
    expect(bounds.form.height).toBeLessThan(page.viewportSize()!.height * 0.5);
    expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    expect(bounds.footer.y - (bounds.body.y + bounds.body.height)).toBeLessThanOrEqual(12);
    await expect(form.getByRole('textbox', { name: 'Your answer' })).toBeInViewport();
    const choice = form.locator('.thread-user-input-choice').first();
    const label = choice.locator('strong');
    expect((await choice.getByRole('radio').boundingBox())!.x).toBeLessThan((await label.boundingBox())!.x);
    const rowBounds = await choice.boundingBox();
    await choice.hover();
    expect(await choice.boundingBox()).toEqual(rowBounds);
    await label.click();
    await expect(choice.getByRole('radio')).toBeChecked();
    const tokens = await choice.evaluate((element) => {
      const probe = document.createElement('div');
      probe.style.color = 'var(--text-strong)';
      probe.style.fontSize = 'var(--font-content)';
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const actual = getComputedStyle(element);
      const result = { actualAccent: getComputedStyle(element.querySelector('input')!).accentColor, expectedAccent: expected.color,
        actualFont: actual.fontSize, expectedFont: expected.fontSize, cursor: actual.cursor };
      probe.remove();
      return result;
    });
    expect(tokens.actualAccent).toBe(tokens.expectedAccent);
    expect(tokens.actualFont).toBe(tokens.expectedFont);
    expect(tokens.cursor).not.toBe('pointer');
    await expect(footer.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/compact-color-${theme}.png` });
    await page.locator('.agent-dock').screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/compact-dock-${theme}.png` });
    await form.getByRole('button', { name: 'Next', exact: true }).click();
    expect((await form.boundingBox())!.height).toBeLessThan(bounds.form.height);
    expect((await footer.boundingBox())!.y).toBeCloseTo(bounds.footer.y, 0);
    await form.getByRole('textbox', { name: 'Your answer' }).focus();
    await expect(form.getByRole('textbox', { name: 'Your answer' })).toBeInViewport();
    await expect(footer.getByRole('button', { name: 'Next', exact: true })).toBeInViewport();
    expect(await responses(page)).toHaveLength(0);
  });

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
    await form.getByRole('textbox', { name: 'Your answer' }).focus();
    await form.getByRole('textbox', { name: 'Your answer' }).fill('Start with the editor and revisit search afterward.');
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await header.boundingBox())!.y).toBeCloseTo(before.header.y, 0);
    expect((await footer.boundingBox())!.y).toBeCloseTo(before.footer.y, 0);
    expect((await form.boundingBox())!.height).toBeCloseTo(before.form.height, 0);
    await expect(form.getByRole('button', { name: 'Next', exact: true })).toBeInViewport();
    await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(0);
    await form.screenshot({ animations: 'disabled', path: `tmp/user-input-recovery/long-question-${theme}.png` });
    await form.getByRole('button', { name: 'Next', exact: true }).click();
    expect((await form.boundingBox())!.height).toBeLessThan(before.form.height);
    expect((await footer.boundingBox())!.y).toBeCloseTo(before.footer.y, 0);
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
    await form.getByRole('textbox', { name: 'Your answer' }).focus();
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
    await form.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible();
    await expect(page.locator('.thread-user-input-review')).toHaveCount(0);
    expect(await form.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  });
}
