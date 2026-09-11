import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT, type SmokeApp } from './electronApp';
import { configureSmokeProvider } from './configurationHelpers';

const run = promisify(execFile);

test('real Electron normalizer preserves pixels, orientation, limits and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-image-normalizer-smoke-'));
  try {
    const fixture = join(root, 'fixture.mjs');
    await run('bun', ['build', 'tests/smoke/fixtures/image-normalization.ts', '--target', 'node', '--format', 'esm', '--external', 'electron', '--outfile', fixture], { cwd: REPO_ROOT });
    const result = await run(join(REPO_ROOT, 'node_modules/.bin/electron'), [fixture], { cwd: REPO_ROOT, timeout: 30_000 });
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true, pixelFidelity: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uploaded blob images and file reads retain exact provider pixels after reopening', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'tenon-image-provider-smoke-'));
  const localImage = join(root, 'marked.blob');
  let smoke: SmokeApp | undefined;
  let readStep = 0;
  let readMode = false;
  const observations: string[][] = [];
  const toolResults: unknown[] = [];
  const model = 'qwen/qwen3.6-27b';
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: model, object: 'model' }] })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    toolResults.push(...body.messages.filter((message: any) => message.role === 'tool'));
    const images = body.messages.flatMap((message: any) => Array.isArray(message.content)
      ? message.content.flatMap((part: any) => part.type === 'image_url' ? [part.image_url.url] : []) : []);
    const toolNames = (body.tools ?? []).map((tool: any) => tool.function.name);
    const fileRead = toolNames.find((name: string) => name === 'file_read' || name.endsWith('_file_read'));
    if (fileRead) observations.push(images);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: 'image-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
    if (fileRead && readMode && readStep++ === 0) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'image-read', type: 'function', function: {
        name: fileRead, arguments: JSON.stringify({ file_path: localImage }),
      } }] }, null); send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: 'Image fixture received.' }, null); send({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    smoke = await launchSmokeApp();
    await configureSmokeProvider(smoke, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const source = await smoke.app.evaluate(({ nativeImage }) => {
      const width = 80, height = 40, bitmap = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bitmap.set(
        y < 12 ? (x < 24 ? [0, 0, 255, 255] : [0, 255, 0, 255]) : (x < 24 ? [255, 0, 0, 255] : [0, 0, 0, 0]), (y * width + x) * 4);
      const image = nativeImage.createFromBitmap(bitmap, { width, height });
      return { png: image.toPNG().toString('base64'), bitmap: image.toBitmap().toString('base64') };
    });
    await writeFile(localImage, Buffer.from(source.png, 'base64'));
    let page = smoke.window;
    const { thread } = await page.evaluate(() => window.lin!.agentCoreRequest('thread/start', { source: 'app', threadSource: 'user', modelProvider: 'groq', configurationSource: { kind: 'user' } }));
    await page.evaluate(({ threadId, model }) => window.lin!.agentCoreRequest('thread/configuration/set', { threadId, modelProvider: 'groq', model: `groq/${model}`, reasoningEffort: 'off' }), { threadId: thread.id, model });
    const refs = await page.evaluate(async ({ threadId, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const attachments = [];
      for (const name of ['marked.png', 'marked.blob', 'marked']) {
        const attachmentId = crypto.randomUUID();
        const { uploadId } = await window.lin!.beginAttachmentUpload({ threadId, attachmentId, name, mimeType: 'image/png', sizeBytes: bytes.byteLength });
        await window.lin!.appendAttachmentUpload({ threadId, attachmentId, uploadId, bytes: bytes.buffer });
        const ref = await window.lin!.finishAttachmentUpload({ threadId, attachmentId, uploadId });
        attachments.push({ type: 'attachment' as const, id: attachmentId, name, mimeType: 'image/png', sizeBytes: bytes.byteLength, source: { kind: 'resource' as const, ref } });
      }
      await window.lin!.agentCoreRequest('turn/start', { threadId, input: [{ type: 'text', text: 'Inspect these marked images.' }, ...attachments] });
      return attachments;
    }, { threadId: thread.id, base64: source.png });
    const completed = async () => expect.poll(async () => (await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), thread.id)).data[0]?.status).toBe('completed');
    await completed();
    expect(observations[0]).toHaveLength(3);
    const assertPixels = async (urls: string[]) => {
      for (const url of urls) {
        const decoded = await smoke!.app.evaluate(({ nativeImage }, url) => {
          const image = nativeImage.createFromDataURL(url);
          return { size: image.getSize(), bitmap: image.toBitmap().toString('base64') };
        }, url);
        expect(decoded).toEqual({ size: { width: 80, height: 40 }, bitmap: source.bitmap });
      }
    };
    await assertPixels(observations[0]!);
    const before = await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), thread.id);
    const history = await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/read', { threadId, includeTurns: true }), thread.id);
    const attachments = history.thread.turns!.flatMap((turn) => turn.items.flatMap((item) => item.type === 'userMessage'
      ? item.content.filter((part) => part.type === 'attachment') : []));
    expect(attachments).toHaveLength(3);
    for (const attachment of attachments) expect(attachment.artifactRef?.geometry).toEqual({
      sourceWidth: 80, sourceHeight: 40, observationWidth: 80, observationHeight: 40, observationToSource: [1, 0, 0, 1, 0, 0],
    });
    // The actual ContentStore uses .blob access paths; original bytes are unchanged.
    const files = await readdir(join(smoke.userDataDir, 'content'), { recursive: true });
    const expectedHash = createHash('sha256').update(Buffer.from(source.png, 'base64')).digest('hex');
    const blobs = files.filter((file) => file.endsWith('.blob'));
    expect(blobs.length).toBeGreaterThan(0);
    expect(await Promise.all(blobs.map(async (file) => createHash('sha256').update(await readFile(join(smoke!.userDataDir, 'content', file))).digest('hex')))).toContain(expectedHash);
    const userDataDir = smoke.userDataDir;
    await closeSmokeApp(smoke, { keepUserData: true }); smoke = await launchSmokeApp({ userDataDir }); page = smoke.window;
    await expect.poll(() => page.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready' });
    expect(await page.evaluate((threadId) => window.lin!.agentCoreRequest('thread/turns/list', { threadId }), thread.id)).toEqual(before);
    readMode = true;
    await page.evaluate(({ threadId, localImage }) => window.lin!.agentCoreRequest('turn/start', { threadId, input: [{ type: 'text', text: `Read the authorized test image at ${localImage}.` }] }), { threadId: thread.id, localImage });
    await expect.poll(() => observations.length).toBeGreaterThanOrEqual(3);
    await completed();
    expect(observations.at(-1)!.length, JSON.stringify(toolResults)).toBeGreaterThanOrEqual(4);
    await assertPixels(observations.at(-1)!);
    expect(refs).toHaveLength(3);
  } finally {
    if (smoke) await closeSmokeApp(smoke);
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
