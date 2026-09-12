import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp } from './electronApp';
import { configureSmokeProvider, openConfiguration } from './configurationHelpers';

test('Profile files share native settings, source revisions and conflict-preserving edits', async ({}, testInfo) => {
  const userDataDir = await mkdtemp('/tmp/tenon-profile-files-');
  await mkdir(join(userDataDir, 'config'));
  await writeFile(join(userDataDir, 'config/settings.jsonc'), '{"appearance":{"language":"en"}}');
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    await expect.poll(() => smoke.window.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready' });
    const page = await openConfiguration(smoke, 'agents');
    const group = page.getByRole('list', { name: 'Personal context', exact: true });
    await expect(group).toBeVisible();
    await group.getByRole('button', { name: 'About you', exact: false }).first().click();
    const dialog = page.getByRole('dialog');
    const textarea = dialog.getByRole('textbox', { name: 'About you', exact: true });
    const original = '# User\n\n## reports\nScope: Research reports\nLead with the conclusion.\n';
    await textarea.fill(original);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readFile(join(userDataDir, 'agent/user/USER.md'), 'utf8')).toBe(original);
    const inspection = await page.evaluate(() => window.lin!.invoke('memory_inspect', { request: { operation: 'profile' } })) as any;
    expect(inspection.files.find((file: any) => file.kind === 'user')).toMatchObject({ state: 'accepted', entries: [{ authorship: 'manual' }] });
    await group.getByRole('button', { name: 'About you', exact: false }).first().click();
    const draft = original.replace('conclusion.', 'decision and evidence.');
    await textarea.fill(draft);
    await writeFile(join(userDataDir, 'agent/user/USER.md'), original.replace('conclusion.', 'summary.'));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Profile file changed; refresh before retrying');
    await expect(textarea).toHaveValue(draft);
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.screenshot({ path: testInfo.outputPath(`profile-conflict-${theme}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await dialog.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(textarea).toHaveValue(draft);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readFile(join(userDataDir, 'agent/user/USER.md'), 'utf8')).toBe(draft);
    const status = JSON.parse(await readFile(join(userDataDir, 'agent/profile-status.json'), 'utf8'));
    expect(status.files.user.savedDigest).toBe(status.files.user.acceptedDigest);
    await page.close();
  } finally { await closeSmokeApp(smoke); await rm(userDataDir, { recursive: true, force: true }); }
});

test('Profile updates preserve system text and prior provider messages while appending current state', async () => {
  test.setTimeout(90_000);
  const userDataDir = await mkdtemp('/tmp/tenon-profile-context-');
  await mkdir(join(userDataDir, 'config'));
  await mkdir(join(userDataDir, 'agent/user'), { recursive: true });
  await writeFile(join(userDataDir, 'config/settings.jsonc'), '{"appearance":{"language":"en"}}');
  const userPath = join(userDataDir, 'agent/user/USER.md');
  await writeFile(userPath, '# User\n\n## reports\nScope: Reports\nCONCLUSION_FIRST_PROFILE\n');
  const requests: any[] = [];
  let finishFirst: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const root = (body.tools ?? []).length > 0;
    if (root) requests.push(body);
    const finish = () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      for (const choice of [{ delta: { role: 'assistant', content: 'Profile context verified.' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
        response.write(`data: ${JSON.stringify({ id: 'profile-fixture', object: 'chat.completion.chunk', created: 1,
          model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    };
    if (root && requests.length === 1) finishFirst = finish;
    else finish();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const page = smoke.window;
    const { thread } = await page.evaluate(() => window.lin!.agentCoreRequest('thread/start', {
      source: 'app', threadSource: 'user', modelProvider: 'groq', configurationSource: { kind: 'user' },
    }));
    const start = () => page.evaluate((threadId) => window.lin!.agentCoreRequest('turn/start', {
      threadId, input: [{ type: 'text', text: 'Write a short report.' }],
    }), thread.id);
    await start();
    await expect.poll(() => requests.length).toBe(1);
    const firstSystem = requests[0].messages.find((message: any) => message.role === 'system' || message.role === 'developer');
    expect(JSON.stringify(firstSystem)).not.toContain('CONCLUSION_FIRST_PROFILE');
    expect(JSON.stringify(requests[0].messages.filter((message: any) => message.role === 'user'))).toContain('CONCLUSION_FIRST_PROFILE');
    await writeFile(userPath, '# User\n\n## reports\nScope: Reports\nEVIDENCE_FIRST_PROFILE\n');
    await writeFile(join(userDataDir, 'agent/config.json'), '{"profiles":{"default":{"tools":[]}}}');
    finishFirst!();
    finishFirst = undefined;
    await expect.poll(async () => (await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/read', { threadId }), thread.id)).thread.status.type).toBe('idle');
    await start();
    await expect.poll(() => requests.length).toBe(2);
    const currentSystem = requests[1].messages.find((message: any) => message.role === 'system' || message.role === 'developer');
    expect(currentSystem).toEqual(firstSystem);
    expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
    const update = JSON.stringify(requests[1].messages.slice(requests[0].messages.length));
    expect(update).toContain('EVIDENCE_FIRST_PROFILE');
    expect(update).not.toContain('CONCLUSION_FIRST_PROFILE');
    expect(update).toContain('replaces its earlier value');
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].model).toBe(requests[0].model);
    await expect.poll(async () => (await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/read', { threadId }), thread.id)).thread.status.type).toBe('idle');
    await start();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].messages.slice(0, requests[1].messages.length)).toEqual(requests[1].messages);
    expect(JSON.stringify(requests[2].messages.slice(requests[1].messages.length))).not.toContain('EVIDENCE_FIRST_PROFILE');
    expect(requests[2].tools).toEqual(requests[0].tools);
    await expect.poll(async () => (await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/read', { threadId }), thread.id)).thread.status.type).toBe('idle');
  } finally {
    finishFirst?.();
    await closeSmokeApp(smoke);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(userDataDir, { recursive: true, force: true });
  }
});
