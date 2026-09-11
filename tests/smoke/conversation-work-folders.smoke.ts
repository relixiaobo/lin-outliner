import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';
import { configureSmokeProvider } from './configurationHelpers';

test('native picker and Agent CLI persist independent conversation folders across restart', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-folders-smoke-')));
  const a = join(root, 'repository'), b = join(root, 'worktree');
  await mkdir(a); await mkdir(b);
  let smoke: SmokeApp | undefined;
  let threadId = '';
  let step = 0;
  const results: any[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const names: string[] = (body.tools ?? []).map((tool: any) => tool.function.name);
    const toolName = (name: string) => names.find((candidate) => candidate === name || candidate.endsWith(`_${name}`));
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-folder-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    })}\n\n`);
    const tool = (name: string, args: unknown) => {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `folder-${step}`, type: 'function',
        function: { name: toolName(name), arguments: JSON.stringify(args) } }] }, null);
      send({}, 'tool_calls');
    };
    const done = (text: string) => { send({ role: 'assistant', content: text }, null); send({}, 'stop'); };
    if (!toolName('bash')) done('Folder workflow');
    else {
      const lastTool = [...body.messages].reverse().find((message: any) => message.role === 'tool');
      if (lastTool) results.push(lastTool.content);
      step++;
      const projectCommand = (input: unknown) => tool('bash', {
        command: 'delegate project --input - --output json', stdin: JSON.stringify(input), cwd: a,
      });
      if (step === 1) projectCommand({ action: 'manage', operationId: 'native-create', request: {
        operation: 'create', name: 'Native folder Project', folders: [a, b], primaryFolder: a,
      } });
      else if (step === 2) projectCommand({ action: 'manage', operationId: 'native-folder', request: {
        operation: 'setWorkFolder', threadId, path: b, expectedRevision: 1,
      } });
      else if (step === 3) tool('file_write', { file_path: 'native-proof.txt', content: 'Saved folder execution after Agent update.' });
      else done('Folder setting saved and verified.');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    smoke = await launchSmokeApp();
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    await smoke.app.evaluate(({ dialog }, path) => {
      (globalThis as any).__folderReviews = [];
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async (_parent: unknown, options: unknown) => {
        (globalThis as any).__folderReviews.push(options);
        return { response: 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, a);
    let page = smoke.window;
    await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
    await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread', exact: true }).click();
    threadId = await page.evaluate(async () => (await window.lin!.agentCoreRequest('thread/list', {})).data[0]!.id);
    await page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Set work folder', exact: true }).click();
    const details = page.getByRole('dialog', { name: 'Project and work folder', exact: true });
    await details.getByRole('button', { name: 'Set work folder', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('repository');
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true }).fill('Create the Project and use its worktree for this conversation.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Folder setting saved and verified.', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await readFile(join(b, 'native-proof.txt'), 'utf8'), JSON.stringify(results)).toBe('Saved folder execution after Agent update.');
    await expect(page.locator('.thread-location-chip')).toHaveText('worktree');
    const reviews = await smoke.app.evaluate(() => (globalThis as any).__folderReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(reviews[0].detail).toContain('Native folder Project');
    expect(reviews[0].detail).toContain(a);
    expect(reviews[0].detail).toContain(b);
    const inspect = () => page.evaluate((threadId) => window.lin!.agentCoreRequest('project/inspect', { threadIds: [threadId] }), threadId);
    const before = await inspect();
    expect(before.workFolders[0]).toMatchObject({ path: b, revision: 2 });
    const project = before.projects.find((entry) => entry.name === 'Native folder Project')!;
    await page.evaluate(({ threadId, project }) => window.lin!.agentCoreRequest('project/manage', {
      operation: 'bind', threadId, projectId: project.id, expectedRevision: project.revision, expectedMembershipRevision: 0,
    }), { threadId, project });
    const userDataDir = smoke.userDataDir;
    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = await launchSmokeApp({ userDataDir }); page = smoke.window;
    await expect.poll(() => page.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready' });
    expect((await inspect()).workFolders[0]).toEqual(before.workFolders[0]);
    await expect(page.locator('.thread-location-chip')).toHaveText('Native folder Project · worktree');
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('.agent-dock').screenshot({ path: testInfo.outputPath(`native-${theme}.png`) });
    }
    await page.evaluate((threadId) => window.lin!.agentCoreRequest('project/manage', {
      operation: 'setWorkFolder', threadId, path: null, expectedRevision: 2,
    }), threadId);
    await expect(page.locator('.thread-location-chip')).toHaveText('Native folder Project · Application default');
    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = await launchSmokeApp({ userDataDir }); page = smoke.window;
    await expect.poll(async () => (await inspect()).workFolders[0]?.path).toBeNull();
    await expect(page.locator('.thread-location-chip')).toHaveText('Native folder Project · Application default');
    await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
    await expect(page.locator('.thread-list-select').getByText(/Native folder Project · Application default/)).toBeVisible();
  } finally {
    if (smoke) await closeSmokeApp(smoke);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
