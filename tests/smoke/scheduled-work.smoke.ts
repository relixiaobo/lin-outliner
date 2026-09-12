import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchSmokeApp, closeSmokeApp, type SmokeApp } from './electronApp';
import { configureSmokeProvider } from './configurationHelpers';

// Real Electron, real capability broker, supervised CLI, SQLite and Turn admission.
// The local provider supplies deterministic model messages without billing a vendor.
test('scheduled assignment created through Bash survives restart and delivers to its task', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const stamp = new Date(Date.now() + 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15);
  const definition = { requestId: 'native-scheduled-create', name: 'Native scheduled review', prompt: 'Deliver the scheduled execution proof.',
    schedule: { rrule: `DTSTART:${stamp}\nRRULE:FREQ=DAILY;COUNT=1`, timezone: 'UTC' } };
  let toolCallSent = false;
  let rootToolOutput = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = JSON.stringify(body.messages);
    const toolName = (body.tools ?? []).map((tool: any) => tool.function.name).find((name: string) => name === 'bash' || name.endsWith('_bash'));
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
      id: 'scheduled-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })}\n\n`);
    if (!toolCallSent && toolName && text.includes('Create the scheduled assignment')) {
      toolCallSent = true;
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'schedule-create', type: 'function', function: { name: toolName,
        arguments: JSON.stringify({ command: 'schedule create --input - --output json', stdin: JSON.stringify(definition) }) } }] }, null);
      send({}, 'tool_calls');
    } else {
      const lastTool = [...body.messages].reverse().find((message: any) => message.role === 'tool');
      if (lastTool) rootToolOutput = typeof lastTool.content === 'string' ? lastTool.content : JSON.stringify(lastTool.content);
      send({ role: 'assistant', content: text.includes('Create the scheduled assignment') ? 'The assignment operation returned.' : 'Scheduled delivery proof from the real Host.' }, null);
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let smoke: SmokeApp | undefined;
  let userDataDir: string | undefined;
  try {
    smoke = await launchSmokeApp(); userDataDir = smoke.userDataDir;
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const page = smoke.window;
    await expect.poll(() => page.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready' });
    await page.evaluate(async () => {
      const { thread } = await window.lin!.agentCoreRequest('thread/start', { source: 'app', threadSource: 'user' });
      await window.lin!.agentCoreRequest('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Create the scheduled assignment using the supplied scheduling command.' }] });
    });
    await expect.poll(() => rootToolOutput, { timeout: 40_000 }).toContain('Native scheduled review');
    expect(rootToolOutput).not.toContain('"ok":false');
    const task = await page.evaluate(async () => (await window.lin!.automationRequest('list', {})).data[0]!);
    expect(task.name).toBe('Native scheduled review');
    expect(task.origin?.threadId).toBeTruthy();
    expect(task.origin?.turnId).toBeTruthy();
    expect(task.origin?.itemId).toBeTruthy();
    const paused = await page.evaluate(async (task) => (await window.lin!.automationRequest('pause', { id: task.id, expectedRevision: task.revision, requestId: 'native-pause' })).automation, task);
    const admitted = await page.evaluate(async (task) => window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'native-manual' }), paused);
    const association = admitted.runs[0]!;
    await expect.poll(() => page.evaluate((id) => window.lin!.automationRequest('result', { id }), association.id), { timeout: 40_000 })
      .toMatchObject({ state: 'completed', answer: 'Scheduled delivery proof from the real Host.' });
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await page.locator('.scheduled-task-row', { hasText: task.name }).click();
    await page.locator('.scheduled-run-row').first().click();
    await expect(page.locator('.scheduled-run-conversation')).toContainText('Scheduled delivery proof from the real Host.');
    await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    const sourceFile = join(smoke.userDataDir, 'scheduled-source.txt');
    await writeFile(sourceFile, 'Read this current source at the next execution.');
    // Stub only the OS picker response. The IPC, file admission and saved task
    // use their real owners and disposable paths.
    await smoke.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, sourceFile);
    await page.getByRole('dialog', { name: 'Task details', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
    await editor.getByRole('textbox', { name: 'Task', exact: true }).fill('Read ');
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add attachment', exact: true }).click();
    await expect(editor.locator('[data-thread-file-ref]')).toHaveCount(1);
    await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('native-scheduled-editor.png'), animations: 'disabled' });
    await editor.getByRole('button', { name: 'Save and run once', exact: true }).click();
    await expect(editor).toBeHidden();
    const edited = (await page.evaluate((id) => window.lin!.automationRequest('read', { id }), task.id)).automation!;
    expect(edited.prompt).toContain('[[file://');
    expect(edited.prompt).toContain('scheduled-source.txt');
    expect(edited.materials).toEqual([]);
    expect(edited.status).toBe('paused');
    expect(edited.schedule).toEqual(paused.schedule);
    await expect.poll(() => page.evaluate(async (id) => (await window.lin!.automationRequest('runs', { automationId: id })).data[0]?.automationRevision, task.id))
      .toBe(edited.revision);
    const rerun = (await page.evaluate((id) => window.lin!.automationRequest('runs', { automationId: id }), task.id)).data[0]!;
    expect(rerun.id).not.toBe(association.id);
    await expect.poll(() => page.evaluate((id) => window.lin!.automationRequest('result', { id }), rerun.id), { timeout: 40_000 })
      .toMatchObject({ state: 'completed', answer: 'Scheduled delivery proof from the real Host.' });
    await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    await page.getByRole('dialog', { name: 'Task details', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor.getByRole('textbox', { name: 'Task', exact: true })).toContainText('scheduled-source.txt');
    await editor.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect.poll(() => page.evaluate(async (id) => (await window.lin!.automationRequest('runs', { automationId: id })).data[0]?.id, task.id))
      .not.toBe(rerun.id);
    const nextRun = (await page.evaluate((id) => window.lin!.automationRequest('runs', { automationId: id }), task.id)).data[0]!;
    await expect.poll(() => page.evaluate((id) => window.lin!.automationRequest('result', { id }), nextRun.id), { timeout: 40_000 })
      .toMatchObject({ state: 'completed' });
    expect((await page.evaluate((id) => window.lin!.automationRequest('read', { id }), task.id)).automation?.status).toBe('paused');
    await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    await page.getByRole('dialog', { name: 'Task details', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Task details', exact: true })).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
      await page.screenshot({ path: testInfo.outputPath(`native-scheduled-${theme}.png`), animations: 'disabled' });
    }
    await closeSmokeApp(smoke, { keepUserData: true }); smoke = undefined;
    smoke = await launchSmokeApp({ userDataDir });
    const replay = await smoke.window.evaluate(async (task) => window.lin!.automationRequest('startNow', {
      id: task.id, expectedRevision: task.revision, requestId: 'native-manual',
    }), paused);
    expect(replay.runs[0]!.id).toBe(association.id);
    expect((await smoke.window.evaluate((id) => window.lin!.automationRequest('read', { id }), task.id)).automation?.prompt).toBe(edited.prompt);
    expect((await smoke.window.evaluate(async () => (await window.lin!.automationRequest('list', {})).data[0]!)).status).toBe('paused');
  } finally {
    if (smoke) await closeSmokeApp(smoke);
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an expired scheduled question retains its draft and foreground slot until the same Turn settles', async ({}, testInfo) => {
  test.setTimeout(120_000);
  let asked = false;
  let followupWaiting = false;
  let releaseFollowup!: () => void;
  const followupGate = new Promise<void>((resolve) => { releaseFollowup = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const requestTool = (body.tools ?? []).map((tool: any) => tool.function.name).find((name: string) => name === 'request_user_input' || name.endsWith('_request_user_input'));
    if (asked) { followupWaiting = true; await followupGate; }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
      id: 'scheduled-question-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })}\n\n`);
    if (!asked && requestTool) {
      asked = true;
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'scheduled-question', type: 'function', function: { name: requestTool,
        arguments: JSON.stringify({ questions: [{ id: 'direction', header: 'Direction', question: 'Which direction should this review take?', options: [] }] }) } }] }, null);
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: 'Scheduled answer after timeout.' }, null); send({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp();
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const page = smoke.window;
    const task = await page.evaluate(async () => {
      const stamp = new Date(Date.now() + 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15);
      return (await window.lin!.automationRequest('create', { requestId: 'question-assignment', name: 'Question review', prompt: 'Review the task after asking for its direction.',
        destination: { kind: 'standalone' }, schedule: { rrule: `DTSTART:${stamp}\nRRULE:FREQ=DAILY;COUNT=1`, timezone: 'UTC' } })).automation;
    });
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await page.locator('.scheduled-task-row', { hasText: 'Question review' }).click();
    const admitted = await page.evaluate(async (task) => window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'question-first' }), task);
    const association = admitted.runs[0]!;
    await page.locator('.scheduled-run-row').first().click();
    await expect(page.locator('.scheduled-run-conversation .thread-user-input-other')).toBeVisible();
    await page.locator('.scheduled-run-conversation .thread-user-input-other').fill('Keep this unsent answer.');
    const pending = await page.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId: threadId! }), association.threadId);
    expect(pending.state.pending?.autoResolutionMs).toBe(60_000);
    // Exercise the real shared 60-second Host deadline, without a separate scheduling timer.
    await expect.poll(() => followupWaiting, { timeout: 75_000 }).toBe(true);
    await expect(page.locator('.scheduled-run-conversation .thread-user-input')).toHaveCount(0);
    await expect(page.locator('.scheduled-run-conversation .thread-user-input-recovery')).toContainText('Keep this unsent answer.');
    const replay = await page.evaluate(async (task) => window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'question-repeat' }), task);
    expect(replay.runs[0]!.id).toBe(association.id);
    const input = await page.evaluate((threadId) => window.lin!.agentCoreRequest('userInput/read', { threadId: threadId! }), association.threadId);
    expect(input.state.pending).toBeNull();
    expect(input.state.settled?.outcome).toBe('timedOut');
    expect(input.state.activeTurnId).toBe(association.turnId);
    await page.screenshot({ path: testInfo.outputPath('native-scheduled-question-expired.png'), animations: 'disabled' });
    releaseFollowup();
    await expect.poll(() => page.evaluate((id) => window.lin!.automationRequest('result', { id }), association.id))
      .toMatchObject({ state: 'completed', answer: 'Scheduled answer after timeout.' });
    expect((await page.evaluate((id) => window.lin!.automationRequest('runs', { automationId: id }), task.id)).data).toHaveLength(1);
  } finally {
    releaseFollowup();
    if (smoke) await closeSmokeApp(smoke);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('scheduled Stop cancels the real owned Turn from history and the read-only conversation', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.write(`data: ${JSON.stringify({ id: 'scheduled-stop-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Working on the scheduled review.' }, finish_reason: null }],
    })}\n\n`);
    // Keep the model stream active until the real Host cancels its request.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp();
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const page = smoke.window;
    const task = await page.evaluate(async () => {
      const stamp = new Date(Date.now() + 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15);
      return (await window.lin!.automationRequest('create', { requestId: 'stop-assignment', name: 'Stop review', prompt: 'Review this assignment.',
        destination: { kind: 'standalone' }, schedule: { rrule: `DTSTART:${stamp}\nRRULE:FREQ=DAILY;COUNT=1`, timezone: 'UTC' } })).automation;
    });
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await page.locator('.scheduled-task-row', { hasText: task.name }).click();
    const details = page.getByRole('dialog', { name: 'Task details', exact: true });
    const runIds: string[] = [];
    for (const surface of ['history', 'conversation'] as const) {
      const admitted = await page.evaluate(async ({ task, surface }) => window.lin!.automationRequest('startNow', {
        id: task.id, expectedRevision: task.revision, requestId: `stop-${surface}`,
      }), { task, surface });
      const run = admitted.runs[0]!;
      runIds.push(run.id);
      await expect.poll(() => page.evaluate((id) => window.lin!.automationRequest('result', { id }), run.id)).toMatchObject({ state: 'running' });
      const historyEntry = details.locator(`.scheduled-run-entry[data-run-id="${run.id}"]`);
      if (surface === 'conversation') await historyEntry.locator('.scheduled-run-row').click();
      const controlSurface = surface === 'history' ? historyEntry : page.locator('.scheduled-run-conversation');
      await expect(controlSurface.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
      for (const theme of ['light', 'dark'] as const) {
        await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
        await page.emulateMedia({ colorScheme: theme });
        await page.screenshot({ path: testInfo.outputPath(`native-stop-${surface}-${theme}.png`), animations: 'disabled' });
      }
      await controlSurface.getByRole('button', { name: 'Stop run', exact: true }).click();
      await expect.poll(() => page.evaluate((id) => window.lin!.automationRequest('result', { id }), run.id)).toMatchObject({ state: 'interrupted' });
      await expect(controlSurface.getByRole('button', { name: 'Stop run', exact: true })).toHaveCount(0);
      await expect(controlSurface.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0);
      if (surface === 'conversation') await page.getByRole('button', { name: 'Back to task', exact: true }).click();
      await expect(historyEntry.locator('.scheduled-run-row')).toContainText('Interrupted');
    }
    expect(new Set(runIds).size).toBe(2);
    const saved = (await page.evaluate((id) => window.lin!.automationRequest('read', { id }), task.id)).automation!;
    expect(saved.status).toBe('active');
    expect(saved.schedule).toEqual(task.schedule);
  } finally {
    if (smoke) await closeSmokeApp(smoke);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
