import { expect, test } from '@playwright/test';
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

test('real tool delivery recovers dropped notification and reload, then expires with all unsent steps intact', async () => {
  test.setTimeout(180_000);
  let smoke: SmokeApp | undefined;
  let releaseQuestion: (() => void) | undefined;
  let continuationCount = 0;
  const outputs: string[] = [];
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
    const toolResult = last?.role === 'tool';
    const emit = () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-input-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      })}\n\n`);
      if (toolResult) {
        continuationCount += 1;
        outputs.push(JSON.stringify(last.content));
        const outcome = JSON.stringify(last.content).includes('timedOut') ? 'timedOut' : 'answered';
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
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Ask about the pass.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const form = page.getByRole('form', { name: 'Input needed' });
    await expect(form).toBeVisible();
    const first = await page.evaluate(async () => {
      const threads = await window.lin!.agentCoreRequest('thread/list', {});
      return window.lin!.agentCoreRequest('userInput/read', { threadId: threads.data[0]!.id });
    });
    expect(first.state.pending?.autoResolutionMs).toBe(60_000);
    const threadId = first.state.threadId;
    await page.reload();
    await expect(form).toBeVisible();
    const restored = await page.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId }), threadId);
    expect(restored.state.pending).toEqual(first.state.pending);
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next', exact: true }).click();
    await form.getByRole('radio', { name: 'Other', exact: true }).check();
    await form.getByRole('textbox', { name: 'Other', exact: true }).fill('Tomorrow morning');
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Continued once: answered', { exact: true })).toBeVisible();
    expect(continuationCount).toBe(1);

    await composer.fill('Ask and expire.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => Boolean(releaseQuestion)).toBe(true);
    await composer.fill('Keep the ordinary draft.');
    releaseQuestion!();
    await expect(form).toBeVisible();
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next', exact: true }).click();
    await form.getByRole('radio', { name: 'Other', exact: true }).check();
    await form.getByRole('textbox', { name: 'Other', exact: true }).fill('Still typing when it expires');
    await page.getByRole('button', { name: 'Collapse agent', exact: true }).click();
    await page.getByRole('button', { name: 'Expand agent', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Other', exact: true })).toHaveValue('Still typing when it expires');
    const artifacts = join(REPO_ROOT, 'tmp/user-input-recovery');
    await mkdir(artifacts, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('.agent-dock').screenshot({ path: join(artifacts, `${theme}-form.png`) });
    }
    await expect(form).toHaveCount(0, { timeout: 65_000 });
    await expect(page.getByText('Continued once: timedOut', { exact: true })).toBeVisible();
    expect(continuationCount).toBe(2);
    expect(outputs[1]).toContain('timedOut');
    expect(outputs[1]).not.toContain('answers');
    expect(outputs[1]).not.toContain('Still typing');
    const recovery = page.locator('.thread-user-input-recovery');
    await recovery.locator('summary').click();
    await expect(recovery).toContainText('Complete');
    await expect(recovery).toContainText('Still typing when it expires');
    await expect(composer).toHaveText('Keep the ordinary draft.');
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
    await expect(form).toBeVisible();
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next', exact: true }).click();
    await form.getByRole('radio', { name: 'Other', exact: true }).check();
    await form.getByRole('textbox', { name: 'Other', exact: true }).fill('Withheld by Skip');
    await form.getByRole('button', { name: 'Skip and submit', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(() => continuationCount).toBe(3);
    expect(outputs[2]).toContain('skipped');
    expect(outputs[2]).toContain('Complete');
    expect(outputs[2]).not.toContain('Withheld by Skip');
    await recovery.locator('summary').click();
    await expect(recovery).toContainText('Withheld by Skip');
    await expect(recovery).not.toContainText('How broad');
    await recovery.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByText('Continued once: answered', { exact: true })).toHaveCount(2);
    await composer.fill('Ask before restart.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(form).toBeVisible();
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
          turnId: old.turnId, itemId: old.itemId, answers: [{ questionId: 'scope', optionLabel: 'Complete' }, { questionId: 'schedule', optionLabel: 'Now' }] });
        return false;
      } catch { return true; }
    }, old);
    expect(rejected).toBe(true);
    expect(continuationCount).toBe(3);
  } finally {
    if (smoke) await closeSmokeApp(smoke);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
