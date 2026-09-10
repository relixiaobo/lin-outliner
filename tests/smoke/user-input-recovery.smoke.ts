import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT, type SmokeApp } from './electronApp';
import { configureSmokeProvider } from './configurationHelpers';

const questions = [
  { id: 'scope', header: 'Scope', question: 'How broad should the pass be?', options: [
    { label: 'Focused', description: 'Only this module.' }, { label: 'Complete', description: 'The full workflow.' },
  ] },
  { id: 'schedule', header: 'Schedule', question: 'When should this run?', options: [
    { label: 'Now', description: 'Run today.' }, { label: 'Later', description: 'Run tomorrow.' },
  ] },
];

async function openQuestions(page: Page) {
  const form = page.getByRole('form', { name: 'Input needed' });
  await expect(form).toBeVisible();
  await expect(page.locator('.thread-user-input-strip')).toHaveCount(0);
}

test('real tool delivery recovers loss and keeps ordinary messages independent of question answers', async () => {
  test.setTimeout(180_000);
  let smoke: SmokeApp | undefined;
  let releaseQuestion: (() => void) | undefined;
  let continuationCount = 0;
  const outputs: string[] = [];
  const steeringRequests: any[][] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'llama-3.1-8b-instant', object: 'model', created: 1, owned_by: 'groq' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const toolName = body.tools?.find((tool: any) => tool.function.name === 'request_user_input')?.function.name;
    const last = body.messages?.at(-1);
    const steering = last?.role === 'user' && JSON.stringify(last).includes('Keep this ordinary message separate.');
    const lastTool = body.messages?.findLast((message: any) => message.role === 'tool');
    const toolResult = last?.role === 'tool' || (steering && lastTool);
    const emit = () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-input-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      })}\n\n`);
      if (toolResult) {
        continuationCount += 1;
        outputs.push(JSON.stringify(lastTool.content));
        if (steering) steeringRequests.push(body.messages);
        const outcome = JSON.stringify(lastTool.content).includes('timedOut') ? 'timedOut' : 'answered';
        send({ role: 'assistant', content: `Continued once: ${outcome}` }, null);
        send({}, 'stop');
      } else if (toolName) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-input-${continuationCount}`, type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ questions }) } }] }, null);
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: 'Input recovery smoke' }, null);
        send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    };
    if (toolName && !toolResult && JSON.stringify(last).includes('Ask and expire')) releaseQuestion = emit;
    else emit();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    smoke = await launchSmokeApp();
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const page = smoke.window;
    await smoke.app.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find((window) => /\/index\.html$/.test(window.webContents.getURL()))!;
      const send = target.webContents.send.bind(target.webContents);
      let dropped = false;
      target.webContents.send = ((channel: string, ...args: unknown[]) => {
        const payload = args[0] as { type?: string } | undefined;
        if (!dropped && payload?.type === 'userInput/requested') { dropped = true; return; }
        send(channel, ...args);
      }) as typeof target.webContents.send;
    });
    await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
    await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
    await composer.fill('Ask about the pass.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const form = page.getByRole('form', { name: 'Input needed' });
    await openQuestions(page);
    const first = await page.evaluate(async () => {
      const threads = await window.lin!.agentCoreRequest('thread/list', {});
      return window.lin!.agentCoreRequest('userInput/read', { threadId: threads.data[0]!.id });
    });
    expect(first.state.pending?.autoResolutionMs).toBe(60_000);
    const threadId = first.state.threadId;
    await page.reload();
    await openQuestions(page);
    const restored = await page.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId }), threadId);
    expect(restored.state.pending).toEqual(first.state.pending);
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next question', exact: true }).click();
    await form.getByRole('textbox', { name: 'Other answer', exact: true }).fill('Tomorrow morning');
    await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await expect(page.getByText('Continued once: answered', { exact: true })).toBeVisible();
    expect(continuationCount).toBe(1);

    await composer.fill('Ask and expire.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => Boolean(releaseQuestion)).toBe(true);
    await composer.fill('Keep the ordinary draft.');
    releaseQuestion!();
    await expect(form).toBeVisible();
    await expect(composer).toBeHidden();
    await expect(composer).toHaveText('Keep the ordinary draft.');
    await openQuestions(page);
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next question', exact: true }).click();
    const answerEditor = page.getByRole('textbox', { name: 'Other answer', exact: true });
    await answerEditor.fill('Still typing when it expires');
    await page.getByRole('button', { name: 'Collapse agent', exact: true }).click();
    await page.getByRole('button', { name: 'Expand agent', exact: true }).click();
    await expect(answerEditor).toHaveValue('Still typing when it expires');
    await answerEditor.focus();
    const editor = await answerEditor.elementHandle();
    const artifacts = join(REPO_ROOT, 'tmp/user-input-recovery');
    await mkdir(artifacts, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('.agent-dock').screenshot({ path: join(artifacts, `${theme}-form.png`) });
    }
    await answerEditor.focus();
    await expect(form).toHaveCount(0, { timeout: 65_000 });
    expect(await answerEditor.evaluate((element, original) => element === original, editor)).toBe(true);
    await expect(answerEditor).toBeFocused();
    await answerEditor.press('End');
    await answerEditor.pressSequentially(' locally');
    await expect(page.getByText('Continued once: timedOut', { exact: true })).toBeVisible();
    expect(continuationCount).toBe(2);
    expect(outputs[1]).toContain('timedOut');
    expect(outputs[1]).not.toContain('answers');
    expect(outputs[1]).not.toContain('Still typing');
    const recovery = page.locator('.thread-user-input-recovery');
    await page.locator('.thread-user-input-recoveries > summary').click();
    await recovery.locator('summary').click();
    await expect(recovery).toContainText('Complete');
    await expect(recovery).toContainText('Still typing when it expires locally');
    await expect(page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true })).toHaveText('Keep the ordinary draft.');
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('.agent-dock').screenshot({ path: join(artifacts, `${theme}-recovery.png`) });
    }
    await recovery.getByRole('button', { name: 'Add to message', exact: true }).click();
    await expect(composer).toContainText('Keep the ordinary draft.');
    await expect(composer).toContainText('Still typing when it expires');
    expect(continuationCount).toBe(2);
    await recovery.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(recovery).toHaveCount(0);
    const turns = await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), threadId);
    expect(turns.data).toHaveLength(2);
    await composer.fill('Ask and allow a skip.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await openQuestions(page);
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next question', exact: true }).click();
    await form.getByRole('textbox', { name: 'Other answer', exact: true }).fill('Withheld by Skip');
    await form.getByRole('button', { name: 'Skip and finish', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(() => continuationCount).toBe(3);
    expect(outputs[2]).toContain('skipped');
    expect(outputs[2]).toContain('Complete');
    expect(outputs[2]).not.toContain('Withheld by Skip');
    await page.locator('.thread-user-input-recoveries > summary').click();
    await recovery.locator('summary').click();
    await expect(recovery).toContainText('Withheld by Skip');
    await expect(recovery.locator('pre')).not.toContainText('How broad');
    await recovery.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByText('Continued once: answered', { exact: true })).toHaveCount(2);
    await composer.fill('Ask while I send a separate message.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await openQuestions(page);
    await form.getByRole('radio', { name: /Complete/ }).check();
    const beforeSteering = await page.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId }), threadId);
    expect(continuationCount).toBe(3);
    await form.getByRole('button', { name: 'Close questions', exact: true }).click();
    await composer.fill('Keep this ordinary message separate.');
    await page.getByRole('button', { name: 'Steer', exact: true }).click();
    await expect(composer).toBeEmpty();
    const afterMessage = await page.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId }), threadId);
    expect(afterMessage.state.pending).toEqual(beforeSteering.state.pending);
    expect(continuationCount).toBe(3);
    await composer.fill('Another unsent message.');
    await page.getByRole('button', { name: 'Resume questions', exact: true }).click();
    await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
    await expect(composer).toBeHidden();
    await form.getByRole('button', { name: 'Next question', exact: true }).click();
    await form.getByRole('button', { name: 'Skip and finish', exact: true }).click();
    await expect.poll(() => continuationCount).toBe(4);
    await expect(composer).toHaveText('Another unsent message.');
    expect(continuationCount).toBe(4);
    expect(outputs[3]).not.toContain('discussed');
    expect(outputs[3]).toContain('Complete');
    expect(outputs[3]).not.toContain('Keep this ordinary message');
    expect(steeringRequests).toHaveLength(1);
    expect(steeringRequests[0]!.filter((message) => message.role === 'user' && JSON.stringify(message).includes('Keep this ordinary message separate.'))).toHaveLength(1);
    const afterSteering = await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), threadId);
    expect(afterSteering.data).toHaveLength(4);
    const steeredTurn = afterSteering.data.find((turn) => turn.id === beforeSteering.state.pending!.turnId)!;
    expect(steeredTurn.items.filter((item) => item.type === 'userMessage' && JSON.stringify(item).includes('Keep this ordinary message separate.'))).toHaveLength(1);
    await expect(composer).toHaveText('Another unsent message.');
    await composer.fill('Ask before restart.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await openQuestions(page);
    const beforeRestart = await page.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId }), threadId);
    const userDataDir = smoke.userDataDir;
    const closed = smoke.app.waitForEvent('close');
    smoke.app.process().kill('SIGKILL');
    await closed;
    smoke = await launchSmokeApp({ userDataDir });
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready' });
    const afterRestart = await smoke.window.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId }), threadId);
    expect(afterRestart.state.hostGeneration).not.toBe(beforeRestart.state.hostGeneration);
    expect(afterRestart.state.pending).toBeNull();
    await expect(smoke.window.getByRole('form', { name: 'Input needed' })).toHaveCount(0);
    const old = beforeRestart.state.pending!;
    const rejected = await smoke.window.evaluate(async (old) => {
      try {
        await window.lin!.agentCoreRequest('userInput/respond', { hostGeneration: old.hostGeneration, threadId: old.threadId,
          turnId: old.turnId, itemId: old.itemId, submissionId: 'restart-reply', intent: 'answer',
          answers: [{ questionId: 'scope', optionLabel: 'Complete' }, { questionId: 'schedule', optionLabel: 'Now' }] });
        return false;
      } catch { return true; }
    }, old);
    expect(rejected).toBe(true);
    expect(continuationCount).toBe(4);
  } finally {
    if (smoke) await closeSmokeApp(smoke);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
