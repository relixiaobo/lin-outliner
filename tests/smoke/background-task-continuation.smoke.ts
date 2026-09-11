import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT, type SmokeApp } from './electronApp';
import { configureSmokeProvider } from './configurationHelpers';

test('real gateway hands over a usable service silently and delivers a finite result once', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'tenon-continuation-smoke-'));
  const artifacts = join(REPO_ROOT, 'tmp/background-task-continuation');
  await mkdir(artifacts, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const checkDirectory = join(root, 'verification');
  await mkdir(checkDirectory);
  const serverFile = join(root, 'application.cjs');
  const portFile = join(root, 'port');
  const exitFile = join(root, 'exit');
  const finiteGate = join(root, 'finite-done');
  await writeFile(serverFile, `const fs = require('node:fs'); const http = require('node:http');
const server = http.createServer((req, res) => { res.end('usable application'); });
server.listen({ port: 0, host: '::1', ipv6Only: true }, () => fs.writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));
setInterval(() => { if (fs.existsSync(${JSON.stringify(exitFile)})) process.exit(7); }, 30);`);
  const checkFile = join(root, 'check.cjs');
  await writeFile(checkFile, `const fs = require('node:fs');
(async () => { for (let attempt = 0; attempt < 80; attempt++) { try {
 const port = fs.readFileSync(${JSON.stringify(portFile)}, 'utf8');
 const response = await fetch('http://[::1]:' + port);
 if (await response.text() === 'usable application') { console.log('Application endpoint verified'); return; }
 } catch {} await new Promise(r => setTimeout(r, 50)); } process.exitCode = 1; })();`);
  let smoke: SmokeApp | undefined;
  let phase: 'service' | 'finite' | 'idle' = 'service';
  let step = 0;
  let calls = 0;
  let taskId = '';
  let finiteTaskId = '';
  let handoff: any;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const names: string[] = (body.tools ?? []).map((tool: any) => tool.function.name);
    const toolName = (name: string) => names.find((candidate) => candidate === name || candidate.endsWith(`_${name}`))!;
    const lastTool = [...body.messages].reverse().find((message: any) => message.role === 'tool');
    let data: any;
    if (lastTool) {
      const content = typeof lastTool.content === 'string' ? lastTool.content
        : lastTool.content.map((part: any) => part.text ?? '').join('\n');
      try { data = JSON.parse(content).data; } catch { data = null; }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-task-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    })}\n\n`);
    const tool = (name: string, args: unknown) => {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function',
        function: { name: toolName(name), arguments: JSON.stringify(args) } }] }, null);
      send({}, 'tool_calls');
    };
    const done = (text: string) => { send({ role: 'assistant', content: text }, null); send({}, 'stop'); };
    if (!toolName('bash')) done('Task continuation smoke');
    else {
      calls += 1;
      if (phase === 'service') {
        step += 1;
        if (step === 1) tool('bash', { command: `${quote(process.execPath)} ${quote(serverFile)}`, cwd: root,
          description: 'Local application', run_in_background: true, completion_agreement: { kind: 'service' } });
        else if (step === 2 && data?.backgroundTaskId) {
          taskId = data.backgroundTaskId;
          tool('bash', { command: `${quote(process.execPath)} ${quote(checkFile)}`, cwd: checkDirectory, description: 'Verify application readiness' });
        } else if (step === 3 && data?.evidence) tool('task_control', { request: { action: 'handoff', task_id: taskId,
          operation_id: 'smoke-handoff', expected_revision: 0, readiness: [data.evidence] } });
        else {
          handoff = data;
          done('Application is ready.'); phase = 'idle';
        }
      } else if (phase === 'finite') {
        step += 1;
        if (step === 1) tool('bash', { command: `while [ ! -f ${quote(finiteGate)} ]; do sleep 0.05; done; printf 'finite-result'`,
          cwd: root, description: 'Finite export', run_in_background: true });
        else if (step === 2) { finiteTaskId = data?.backgroundTaskId ?? ''; done('Job is running.'); }
        else { done('Finite job completed.'); phase = 'idle'; }
      } else done('Unexpected automatic continuation.');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    smoke = await launchSmokeApp();
    if (!process.env.TENON_SMOKE_EXECUTABLE) expect(await smoke.app.evaluate(({ app }) => app.getAppPath())).toBe(REPO_ROOT);
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    let page = smoke.window;
    await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
    await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread', exact: true }).click();
    let composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
    await composer.fill('Start a local application for me to use. Verify it and hand it over.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Application is ready.', { exact: true })).toBeVisible();
    expect(handoff?.receipt?.status, JSON.stringify(handoff)).toBe('accepted');
    const threadId = await page.evaluate(async () => (await window.lin!.agentCoreRequest('thread/list', {})).data[0]!.id);
    const readTask = (id: string) => page.evaluate(({ threadId, taskId }) => window.lin!.agentCoreRequest('task/read', { threadId, taskId }), { threadId, taskId: id });
    expect((await readTask(taskId)).task.continuation.handoff).toBeTruthy();
    const port = await (await import('node:fs/promises')).readFile(portFile, 'utf8');
    await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(await (await fetch(`http://[::1]:${port}`)).text()).toBe('usable application');
    const callsBeforeExit = calls;
    const handedTask = (await readTask(taskId)).task;
    expect(handedTask.executionContext?.address.cwd).toContain('tenon-continuation-smoke-');
    await expect.poll(async () => (await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), threadId)).data[0]?.status).toBe('completed');
    const userDataDir = smoke.userDataDir;
    const closed = smoke.app.waitForEvent('close');
    smoke.app.process().kill('SIGKILL');
    await closed;
    smoke = await launchSmokeApp({ userDataDir });
    page = smoke.window;
    composer = page.getByRole('textbox', { name: 'Message this Thread', includeHidden: true });
    await expect.poll(async () => (await readTask(taskId)).task.state).toBe('running');
    expect((await readTask(taskId)).task.continuation.handoff).toBeTruthy();
    expect(calls).toBe(callsBeforeExit);
    const gatewayRequestsBeforeExit = requests.length;
    await writeFile(exitFile, 'external close');
    await expect.poll(async () => (await readTask(taskId)).task.deliveryState).toBe('silent');
    expect((await readTask(taskId)).task).toMatchObject({ state: 'failed', exitCode: 7, continuation: { stop: null } });
    await page.waitForTimeout(1500);
    expect(calls).toBe(callsBeforeExit);
    const extraGatewayRequestsAfterServiceExit = requests.length - gatewayRequestsBeforeExit;
    expect(extraGatewayRequestsAfterServiceExit).toBe(0);
    expect((await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), threadId)).data).toHaveLength(1);
    await page.locator('.thread-work-strip-pill').filter({ hasText: 'Task needs attention' }).click();
    await page.locator('.thread-work-strip-open').filter({ hasText: 'Local application' }).click();
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('.agent-dock').screenshot({ path: join(artifacts, `${theme}-task.png`) });
    }
    await page.locator('.thread-work-strip-pill').filter({ hasText: 'Task needs attention' }).click();
    phase = 'finite'; step = 0;
    await composer.fill('Run a finite export in the background and report its result.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Job is running.', { exact: true })).toBeVisible();
    expect(finiteTaskId).toBeTruthy();
    await writeFile(finiteGate, 'done');
    await expect(page.getByText('Finite job completed.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await readTask(finiteTaskId)).task.deliveryState).toBe('delivered');
    expect(calls).toBe(callsBeforeExit + 3);
    expect((await readTask(finiteTaskId)).task.continuation.event).toMatchObject({ disposition: 'admitted', handling: { kind: 'completion' } });
    expect((await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), threadId)).data).toHaveLength(3);
    await writeFile(join(artifacts, 'gateway-counts.json'), JSON.stringify({ serviceCalls: callsBeforeExit, callsAfterSilentExit: callsBeforeExit,
      finiteCalls: 3, totalCalls: calls, extraGatewayRequestsAfterServiceExit, handoff, terminal: (await readTask(taskId)).task.continuation }, null, 2));
  } finally {
    await writeFile(join(artifacts, 'gateway-requests.json'), JSON.stringify(requests, null, 2));
    if (smoke) await closeSmokeApp(smoke);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
