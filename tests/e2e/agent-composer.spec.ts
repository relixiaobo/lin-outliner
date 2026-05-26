import { expect, test, type Page } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  emitAgentProjection,
  emitDocumentEvent,
  openMockedApp,
} from './outlinerMock';

async function waitForAgentSession(page: import('@playwright/test').Page) {
  await expect.poll(async () => {
    const calls = await commandCalls(page);
    return calls.some((call) => call.cmd === 'agent_restore_latest_session');
  }).toBe(true);
}

async function invokeDocumentCommand(page: Page, cmd: string, args: Record<string, unknown>) {
  await page.evaluate(async ({ cmd, args }) => {
    const win = window as unknown as {
      lin?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    await win.lin?.invoke(cmd, args);
  }, { cmd, args });
  await emitDocumentEvent(page, {
    type: 'projection_changed',
    origin: 'test',
    projection: await e2eProjection(page),
    timestamp: Date.now(),
  });
}

test.describe('agent composer controls', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await waitForAgentSession(page);
  });

  test('sends from the primary action', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.fill('Summarize current outline.');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_send_message')?.args;
    }).toMatchObject({
      message: 'Summarize current outline.',
      sessionId: 'mock-agent-session',
    });
  });

  test('inserts attachments inline and sends them as context', async ({ page }) => {
    await page.locator('.agent-composer-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from test'),
    });
    await expect(page.locator('[data-agent-file-ref]')).toContainText('notes.txt');
    await expect(page.locator('[data-agent-file-ref] .agent-composer-inline-file-icon')).toHaveAttribute('data-extension', 'TXT');
    await expect(page.locator('.agent-attachment-chip')).toHaveCount(0);

    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => (
        call.cmd === 'agent_send_message'
        && Array.isArray(call.args.attachments)
        && call.args.attachments.some((attachment: { name?: string }) => attachment.name === 'notes.txt')
      ))?.args;
    }).toMatchObject({
      attachments: [{ name: 'notes.txt' }],
      message: '[[file:notes.txt]]',
    });
  });

  test('uses the native attachment picker when available', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          pickLocalFiles?: () => Promise<{
            canceled: boolean;
            files: Array<{
              path: string;
              name: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
            }>;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.pickLocalFiles = async () => ({
        canceled: false,
        files: [{
          path: '/Users/test/Documents/local-notes.md',
          name: 'local-notes.md',
          mimeType: 'text/plain',
          sizeBytes: 42,
          lastModified: 1_800_000_000_000,
        }],
      });
    });

    await page.getByRole('button', { name: 'Add attachment' }).click();
    await expect(page.locator('[data-agent-file-ref]')).toContainText('local-notes.md');

    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => (
        call.cmd === 'agent_send_message'
        && Array.isArray(call.args.attachments)
        && call.args.attachments.some((attachment: { path?: string }) => attachment.path === '/Users/test/Documents/local-notes.md')
      ))?.args;
    }).toMatchObject({
      attachments: [{ kind: 'file', path: '/Users/test/Documents/local-notes.md' }],
      message: '[[file:local-notes.md]]',
    });
  });

  test('renders sent attachment mentions inline without raw image placeholders', async ({ page }) => {
    const marker = {
      version: 1,
      instructions: 'Images are visible as image content blocks. Files and folders are available at local paths; use file_read for files and file_glob for folders instead of assuming they are already visible. Inline text attachments are included in this user message.',
      attachments: [
        {
          kind: 'file',
          ref: '.DS_Store',
          name: '.DS_Store',
          mimeType: 'application/octet-stream',
          sizeBytes: 26_624,
          path: '/Users/test/Desktop/.DS_Store',
        },
        {
          kind: 'file',
          ref: 'Coding',
          name: 'Coding',
          mimeType: 'inode/directory',
          sizeBytes: 0,
          path: '/Users/test/Documents/Coding',
        },
        {
          kind: 'image',
          ref: 'Screenshot 2026-05-26 at 14.50.16.png',
          name: 'Screenshot 2026-05-26 at 14.50.16.png',
          mimeType: 'image/png',
          sizeBytes: 481_000,
          inline: true,
        },
      ],
    };

    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [{
        nodeId: 'agent-user-with-attachments',
        message: {
          role: 'user',
          timestamp: 1_800_000_000_500,
          content: [
            {
              type: 'text',
              text: `<system-reminder>\n<user-attachments>\n${JSON.stringify(marker, null, 2)}\n</user-attachments>\n</system-reminder>`,
            },
            {
              type: 'text',
              text: '[[file:.DS_Store]] 总结一下，然后跟 [[file:Coding]] 对比一下，然后添加到 [[Alpha^node-alpha]]，参考 [[file:Screenshot 2026-05-26 at 14.50.16.png]]',
            },
            { type: 'text', text: 'Image attachment' },
          ],
        },
        branches: null,
      }],
    });

    const row = page.locator('.agent-message-row.user').filter({ hasText: '总结一下' });
    const bubble = row.locator('.agent-user-bubble');
    await expect(row.locator('.agent-user-file-chip')).toHaveCount(0);
    await expect(bubble.locator('.agent-message-inline-file')).toHaveCount(3);
    await expect(bubble.locator('.agent-message-inline-file').nth(0)).toContainText('.DS_Store');
    await expect(bubble.locator('.agent-message-inline-file').nth(1)).toContainText('Coding');
    await expect(bubble.locator('.agent-message-inline-file').nth(2)).toContainText('Screenshot 2026-05-26 at 14.50.16.png');
    await expect(bubble.locator('.agent-message-inline-ref')).toHaveText('Alpha');
    await expect.poll(async () => bubble.evaluate((element) => (
      element.textContent?.replace(/\s+/gu, ' ').trim()
    ))).toBe('.DS_Store 总结一下，然后跟 Coding 对比一下，然后添加到 Alpha，参考 Screenshot 2026-05-26 at 14.50.16.png');
    await expect(row.locator('.agent-user-bubble')).not.toContainText('@.DS_Store');
    await expect(row.locator('.agent-user-bubble')).not.toContainText('@Coding');
    await expect(row.locator('.agent-user-bubble')).not.toContainText('[[file:');
    await expect(row.locator('.agent-user-bubble')).not.toContainText('Image attachment');
  });

  test('searches local files from @ mentions and sends the selected file as context', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          prepareLocalFile?: (options: { id: string }) => Promise<{
            file: {
              entryKind?: 'file' | 'directory';
              path: string;
              name: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
            } | null;
          }>;
          searchLocalFiles?: (options: { query: string; limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              iconDataUrl?: string;
              thumbnailDataUrl?: string;
            }>;
            query: string;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.searchLocalFiles = async (options) => ({
        files: options.query.toLowerCase().includes('report')
          ? [{
              id: 'local-file-report',
              entryKind: 'file',
              path: '/Users/test/Documents/Project Report.md',
              name: 'Project Report.md',
              parentPath: '/Users/test/Documents',
              mimeType: 'text/plain',
              sizeBytes: 2048,
              lastModified: 1_800_000_000_000,
            }]
          : [],
        query: options.query,
      });
      win.lin.prepareLocalFile = async (options) => ({
        file: options.id === 'local-file-report'
          ? {
              entryKind: 'file',
              path: '/Users/test/Documents/Project Report.md',
              name: 'Project Report.md',
              mimeType: 'text/plain',
              sizeBytes: 2048,
              lastModified: 1_800_000_000_000,
            }
          : null,
      });
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@report');

    const menu = page.getByRole('listbox', { name: 'Agent mention suggestions' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('.agent-composer-mention-section', { hasText: 'Files' })).toBeVisible();
    await expect(menu.getByRole('option', { name: /Project Report\.md/ })).toBeVisible();
    await menu.getByRole('option', { name: /Project Report\.md/ }).click();

    await expect(page.locator('[data-agent-file-ref]')).toContainText('Project Report.md');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => (
        call.cmd === 'agent_send_message'
        && Array.isArray(call.args.attachments)
        && call.args.attachments.some((attachment: { path?: string }) => (
          attachment.path === '/Users/test/Documents/Project Report.md'
        ))
      ))?.args;
    }).toMatchObject({
      attachments: [{ kind: 'file', path: '/Users/test/Documents/Project Report.md' }],
      message: '[[file:Project Report.md]]',
    });
  });

  test('searches local folders from @ mentions and sends the selected folder path as context', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          prepareLocalFile?: (options: { id: string }) => Promise<{
            file: {
              entryKind?: 'file' | 'directory';
              path: string;
              name: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
            } | null;
          }>;
          searchLocalFiles?: (options: { query: string; limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              iconDataUrl?: string;
              thumbnailDataUrl?: string;
            }>;
            query: string;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.searchLocalFiles = async (options) => ({
        files: options.query.toLowerCase().includes('design')
          ? [{
              entryKind: 'directory',
              id: 'local-folder-design',
              path: '/Users/test/Documents/design-system',
              name: 'design-system',
              parentPath: '/Users/test/Documents',
              mimeType: 'inode/directory',
              sizeBytes: 0,
              lastModified: 1_800_000_000_000,
            }]
          : [],
        query: options.query,
      });
      win.lin.prepareLocalFile = async (options) => ({
        file: options.id === 'local-folder-design'
          ? {
              entryKind: 'directory',
              path: '/Users/test/Documents/design-system',
              name: 'design-system',
              mimeType: 'inode/directory',
              sizeBytes: 0,
              lastModified: 1_800_000_000_000,
            }
          : null,
      });
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@design');

    const menu = page.getByRole('listbox', { name: 'Agent mention suggestions' });
    await expect(menu.getByRole('option', { name: /design-system/ })).toHaveAttribute('data-entry-kind', 'directory');
    await menu.getByRole('option', { name: /design-system/ }).click();

    await expect(page.locator('[data-agent-file-ref]')).toContainText('design-system');
    await expect(page.locator('[data-agent-file-ref] .agent-composer-inline-file-icon')).toHaveAttribute('data-extension', 'DIR');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => (
        call.cmd === 'agent_send_message'
        && Array.isArray(call.args.attachments)
        && call.args.attachments.some((attachment: { path?: string }) => (
          attachment.path === '/Users/test/Documents/design-system'
        ))
      ))?.args;
    }).toMatchObject({
      attachments: [{ kind: 'file', path: '/Users/test/Documents/design-system' }],
      message: '[[file:design-system]]',
    });
  });

  test('uses a presentation icon for local slide decks in @ mentions', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          searchLocalFiles?: (options: { query: string; limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              iconDataUrl?: string;
              thumbnailDataUrl?: string;
            }>;
            query: string;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.searchLocalFiles = async (options) => ({
        files: options.query.toLowerCase().includes('slides')
          ? [{
              entryKind: 'file',
              id: 'local-file-slides',
              path: '/Users/test/Documents/demo-slides.pptx',
              name: 'demo-slides.pptx',
              parentPath: '/Users/test/Documents',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
            }]
          : [],
        query: options.query,
      });
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@slides');

    const slidesOption = page.getByRole('listbox', { name: 'Agent mention suggestions' })
      .getByRole('option', { name: /demo-slides\.pptx/ });
    await expect(slidesOption.locator('[data-file-icon="presentation"]')).toBeVisible();
  });

  test('uses native local file icons when search returns one', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          searchLocalFiles?: (options: { query: string; limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              iconDataUrl?: string;
              thumbnailDataUrl?: string;
            }>;
            query: string;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.searchLocalFiles = async (options) => ({
        files: options.query.toLowerCase().includes('native')
          ? [{
              entryKind: 'file',
              id: 'local-file-native-icon',
              path: '/Users/test/Documents/native-icon.pdf',
              name: 'native-icon.pdf',
              parentPath: '/Users/test/Documents',
              mimeType: 'application/pdf',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
              iconDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPvsZAAAAABJRU5ErkJggg==',
            }]
          : [],
        query: options.query,
      });
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@native');

    const nativeOption = page.getByRole('listbox', { name: 'Agent mention suggestions' })
      .getByRole('option', { name: /native-icon\.pdf/ });
    await expect(nativeOption.locator('[data-file-icon="native"]')).toBeVisible();
  });

  test('uses local file thumbnails for mention rows, hover previews, and inline references', async ({ page }) => {
    await page.evaluate(() => {
      const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPvsZAAAAABJRU5ErkJggg==';
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          prepareLocalFile?: (options: { id: string }) => Promise<{
            file: {
              entryKind?: 'file' | 'directory';
              path: string;
              name: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              thumbnailDataUrl?: string;
            } | null;
          }>;
          searchLocalFiles?: (options: { query: string; limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              thumbnailDataUrl?: string;
            }>;
            query: string;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.searchLocalFiles = async (options) => ({
        files: options.query.toLowerCase().includes('image')
          ? [{
              entryKind: 'file',
              id: 'local-file-image',
              path: '/Users/test/Pictures/gpt4.png',
              name: 'gpt4.png',
              parentPath: '/Users/test/Pictures',
              mimeType: 'image/png',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
              thumbnailDataUrl: thumbnail,
            }]
          : [],
        query: options.query,
      });
      win.lin.prepareLocalFile = async (options) => ({
        file: options.id === 'local-file-image'
          ? {
              entryKind: 'file',
              path: '/Users/test/Pictures/gpt4.png',
              name: 'gpt4.png',
              mimeType: 'image/png',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
              thumbnailDataUrl: thumbnail,
            }
          : null,
      });
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@image');

    const imageOption = page.getByRole('listbox', { name: 'Agent mention suggestions' })
      .getByRole('option', { name: /gpt4\.png/ });
    await expect(imageOption.locator('[data-file-icon="thumbnail"]')).toBeVisible();
    await imageOption.hover();
    const preview = page.locator('[data-file-preview]');
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText('gpt4.png');
    const optionBox = await imageOption.boundingBox();
    const previewBox = await preview.boundingBox();
    expect(previewBox?.width).toBeLessThanOrEqual(170);
    expect(previewBox?.height).toBeLessThanOrEqual(125);
    expect(Math.abs(((previewBox?.y ?? 0) + ((previewBox?.height ?? 0) / 2)) - ((optionBox?.y ?? 0) + ((optionBox?.height ?? 0) / 2)))).toBeLessThan(90);
    await imageOption.click();
    await expect(page.locator('[data-agent-file-ref]')).toContainText('gpt4.png');
    await expect(page.locator('[data-agent-file-ref] [data-file-icon="thumbnail"]')).toBeVisible();
    await expect(page.locator('[data-agent-file-ref]')).not.toHaveAttribute('title', /gpt4\.png/);
    await expect(page.locator('[data-agent-file-ref]')).toHaveAttribute('aria-label', /gpt4\.png/);
  });

  test('loads an image preview after selecting a result that only returned an icon', async ({ page }) => {
    await page.evaluate(() => {
      const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPvsZAAAAABJRU5ErkJggg==';
      const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPvsZAAAAABJRU5ErkJggg==';
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          previewLocalFile?: (options: { id: string }) => Promise<{ thumbnailDataUrl: string | null }>;
          searchLocalFiles?: (options: { query: string; limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              iconDataUrl?: string;
            }>;
            query: string;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.searchLocalFiles = async (options) => ({
        files: options.query.toLowerCase().includes('lazyimage')
          ? [{
              entryKind: 'file',
              id: 'local-file-lazy-image',
              path: '/Users/test/Pictures/lazy-image.png',
              name: 'lazy-image.png',
              parentPath: '/Users/test/Pictures',
              mimeType: 'image/png',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
              iconDataUrl: icon,
            }]
          : [],
        query: options.query,
      });
      win.lin.previewLocalFile = async (options) => {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        return {
          thumbnailDataUrl: options.id === 'local-file-lazy-image' ? thumbnail : null,
        };
      };
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@lazyimage');

    const imageOption = page.getByRole('listbox', { name: 'Agent mention suggestions' })
      .getByRole('option', { name: /lazy-image\.png/ });
    await expect(imageOption.locator('[data-file-icon="native"]')).toBeVisible();
    await expect(imageOption.locator('[data-file-icon="thumbnail"]')).toBeVisible();
    await expect(page.locator('[data-file-preview]')).toBeVisible();
  });

  test('middle-truncates long local filenames while preserving the extension', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          searchLocalFiles?: (options: { query: string; limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
            }>;
            query: string;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.searchLocalFiles = async (options) => ({
        files: options.query.toLowerCase().includes('screenshot')
          ? [{
              entryKind: 'file',
              id: 'local-file-long-screenshot',
              path: '/Users/test/Desktop/Screenshot 2026-05-26 at 14.50.30 with a very long name.png',
              name: 'Screenshot 2026-05-26 at 14.50.30 with a very long name.png',
              parentPath: '/Users/test/Desktop',
              mimeType: 'image/png',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
            }]
          : [],
        query: options.query,
      });
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@screenshot');

    const menu = page.getByRole('listbox', { name: 'Agent mention suggestions' });
    const name = menu.locator('.agent-composer-file-name-middle', {
      has: page.locator('.agent-composer-file-name-end', { hasText: ' name.png' }),
    });
    await expect(name).toHaveAttribute('title', 'Screenshot 2026-05-26 at 14.50.30 with a very long name.png');
    await expect(name.locator('.agent-composer-file-name-start')).toContainText('Screenshot 2026-05-26 at 14.50.30 with a very long');
    await expect(name.locator('.agent-composer-file-name-end')).toHaveText(' name.png');
  });

  test('passes slash commands through for runtime compact and skill handling', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.fill('/compact keep only current project decisions');
    await page.getByRole('button', { name: 'Send message' }).click();

    await input.fill('/auto-skill runtime-check');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls
        .filter((call) => call.cmd === 'agent_send_message')
        .map((call) => call.args.message);
    }).toEqual([
      '/compact keep only current project decisions',
      '/auto-skill runtime-check',
    ]);
  });

  test('suggests slash commands from the composer editor', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('/');

    const menu = page.getByRole('listbox', { name: 'Agent slash commands' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option', { name: /\/compact/ })).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(input).toContainText('/compact');
  });

  test('clears the composer immediately after handing off a compact command', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        __resolveAgentSend?: () => void;
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
        };
      };
      const originalInvoke = win.lin?.invoke;
      if (!originalInvoke || !win.lin) return;
      win.lin.invoke = ((cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'agent_send_message') {
          return new Promise((resolve) => {
            win.__resolveAgentSend = () => resolve(undefined);
          });
        }
        return originalInvoke(cmd, args);
      }) as typeof originalInvoke;
    });

    const input = page.getByLabel('Agent message');
    await input.fill('/compact');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(input).toHaveText('');
    await page.evaluate(() => {
      const win = window as typeof window & { __resolveAgentSend?: () => void };
      win.__resolveAgentSend?.();
    });
  });

  test('inserts node references and sends explicit referenced node context', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@Alpha');

    const menu = page.getByRole('listbox', { name: 'Agent mention suggestions' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('.agent-composer-mention-section', { hasText: 'Nodes' })).toBeVisible();
    const alphaOption = menu.getByRole('option', { name: /Alpha/ });
    await expect(alphaOption.locator('.row-bullet-shape.content')).toBeVisible();
    await alphaOption.click();

    await expect(page.locator('[data-agent-node-ref="node-alpha"]')).toBeVisible();
    await page.keyboard.type('details');
    await expect(input).toContainText('Alpha details');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => (
        call.cmd === 'agent_send_message'
        && call.args.userViewContext
        && typeof call.args.userViewContext === 'object'
        && 'referencedNodes' in call.args.userViewContext
      ))?.args;
    }).toMatchObject({
      message: '[[Alpha^node-alpha]] details',
      userViewContext: {
        referencedNodes: [{ nodeId: 'node-alpha', title: 'Alpha' }],
      },
    });

    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [{
        nodeId: 'agent-user-with-ref',
        message: {
          role: 'user',
          timestamp: 1_800_000_000_500,
          content: [{ type: 'text', text: '[[Alpha^node-alpha]] details' }],
        },
        branches: null,
      }],
    });

    const userBubble = page.locator('.agent-user-bubble', { hasText: 'details' });
    await expect(userBubble.locator('[data-inline-ref="node-alpha"]')).toHaveText('Alpha');
    await expect(userBubble).not.toContainText('[[Alpha^node-alpha]]');
  });

  test('excludes trashed nodes from node mention suggestions', async ({ page }) => {
    await invokeDocumentCommand(page, 'create_node', {
      parentId: 'library',
      index: null,
      text: 'Visible AgentTrashCandidate',
    });
    await invokeDocumentCommand(page, 'create_node', {
      parentId: 'library',
      index: null,
      text: 'Deleted AgentTrashCandidate',
    });
    const deletedId = (await e2eProjection(page)).nodes.find((node) => (
      node.content.text === 'Deleted AgentTrashCandidate'
    ))?.id;
    expect(deletedId).toBeTruthy();
    await invokeDocumentCommand(page, 'trash_node', { nodeId: deletedId });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@AgentTrashCandidate');

    const menu = page.getByRole('listbox', { name: 'Agent mention suggestions' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('.agent-composer-mention-section', { hasText: 'Nodes' })).toBeVisible();
    await expect(menu.getByRole('option', { name: /Visible AgentTrashCandidate/ })).toBeVisible();
    await expect(menu.getByRole('option', { name: /Deleted AgentTrashCandidate/ })).toHaveCount(0);
  });

  test('renders node reference markers in assistant and tool output', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [{
        nodeId: 'agent-assistant-inline-ref',
        message: {
          role: 'assistant',
          timestamp: 1_800_000_000_700,
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-5.4',
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: 'Review [[Alpha^node-alpha]] and [[^node-alpha]] before [[^node-missing]].' },
            { type: 'toolCall', id: 'tool-ref-output', name: 'node_read', arguments: { nodeId: 'node-alpha' } },
          ],
        },
        branches: null,
      }],
      messages: [{
        role: 'toolResult',
        toolCallId: 'tool-ref-output',
        toolName: 'node_read',
        timestamp: 1_800_000_000_800,
        content: [{ type: 'text', text: 'Tool output references [[^node-alpha]].' }],
        isError: false,
      }],
    });

    await expect(page.locator('.agent-markdown [data-inline-ref="node-alpha"]')).toHaveText(['Alpha', 'Alpha']);
    await expect(page.locator('.agent-markdown [data-inline-ref="node-missing"]')).toHaveText('Referenced node');
    await expect(page.locator('.agent-markdown [data-inline-ref="node-missing"]')).not.toContainText('node-missing');
    const tabCount = await page.locator('.workspace-tab').count();
    const panelCount = await page.locator('.outline-panel-surface').count();

    await page.locator('.agent-markdown [data-inline-ref="node-alpha"]').first().click();
    await expect(page.locator('.workspace-tab')).toHaveCount(tabCount);
    await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCount);
    await expect(page.locator('.workspace-tab.active')).toContainText('Alpha');

    await page.locator('.agent-markdown [data-inline-ref="node-alpha"]').nth(1).click({ modifiers: ['Meta'] });
    await expect(page.locator('.workspace-tab')).toHaveCount(tabCount + 1);
    await expect(page.locator('.workspace-tab.active')).toContainText('Alpha');

    await page.getByRole('button', { name: /Read node/ }).click();
    await expect(page.locator('.agent-tool-call-section [data-inline-ref="node-alpha"]')).toHaveText('Alpha');
  });

  test('uses node icons in reference suggestions when available', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      return win.lin?.invoke('set_node_icon', {
        nodeId: 'node-alpha',
        icon: '🏀',
        iconKind: 'emoji',
      });
    });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@Alpha');

    const alphaOption = page.getByRole('listbox', { name: 'Agent mention suggestions' })
      .getByRole('option', { name: /Alpha/ });
    await expect(alphaOption.locator('.popover-node-emoji')).toHaveText('🏀');
  });

  test('opens a sectioned mention menu from bare @', async ({ page }) => {
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          recentLocalFiles?: (options?: { limit?: number }) => Promise<{
            files: Array<{
              entryKind: 'file' | 'directory';
              id: string;
              path: string;
              name: string;
              parentPath: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              iconDataUrl?: string;
              thumbnailDataUrl?: string;
            }>;
          }>;
        };
      };
      if (!win.lin) return;
      win.lin.recentLocalFiles = async () => ({
        files: [{
          entryKind: 'file',
          id: 'recent-local-notes',
          path: '/Users/test/Documents/recent-notes.md',
          name: 'recent-notes.md',
          parentPath: '/Users/test/Documents',
          mimeType: 'text/plain',
          sizeBytes: 123,
          lastModified: 1_800_000_000_000,
        }],
      });
    });

    const input = page.getByLabel('Agent message');
    await input.click();
    await page.keyboard.type('@');

    const menu = page.getByRole('listbox', { name: 'Agent mention suggestions' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('.agent-composer-mention-section', { hasText: 'Recent' })).toBeVisible();
    await expect(menu.getByRole('option', { name: /recent-notes\.md/ })).toBeVisible();
    await expect(menu.getByRole('option')).not.toHaveCount(0);
  });

  test('shows compact progress before expandable summaries', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      activeCompaction: {
        id: 'active-compact-1',
        trigger: 'manual',
        startedAt: 1_800_000_000_000,
      },
    });

    const compactStatus = page.locator('.agent-compaction-toggle.is-active');
    await expect(compactStatus).toBeVisible();
    await expect(compactStatus).toContainText('Compacting');
    await expect(compactStatus).toContainText('Manual');
    await expect(page.getByRole('button', { name: /Compacted/ })).toHaveCount(0);

    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        {
          nodeId: 'user-before-compact',
          message: {
            role: 'user',
            timestamp: 1_800_000_000_000 - 800,
            content: [{ type: 'text', text: 'Previous user request before compact.' }],
          },
        },
        {
          nodeId: 'assistant-before-compact',
          message: {
            role: 'assistant',
            timestamp: 1_800_000_000_000 - 700,
            api: 'openai-completions',
            provider: 'openai',
            model: 'gpt-5.4',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
            content: [
              { type: 'text', text: 'Previous assistant response before compact.' },
              { type: 'toolCall', id: 'compact-archive-tool-1', name: 'node_read', arguments: { nodeId: 'node-alpha' } },
            ],
          },
        },
        {
          kind: 'compaction',
          compaction: {
            id: 'compact-1',
            messageId: 'compact-root',
            summary: 'Primary Request and Intent\n\nContinue implementing the compact UI boundary.',
            compactedThroughMessageId: 'assistant-before-compact',
            trigger: 'manual',
            createdAt: 1_800_000_000_000,
          },
        },
      ],
      messages: [{
        role: 'toolResult',
        toolCallId: 'compact-archive-tool-1',
        toolName: 'node_read',
        timestamp: 1_800_000_000_000 - 650,
        content: [{ type: 'text', text: 'Previous tool result before compact.' }],
        isError: false,
      }],
    }, 2);

    await expect(compactStatus).toHaveCount(0);
    const compactToggle = page.getByRole('button', { name: /Compacted/ });
    await expect(compactToggle).toBeVisible();
    await expect(compactToggle).toContainText('Manual');
    await expect(page.locator('.agent-user-bubble', { hasText: 'Conversation compacted.' })).toHaveCount(0);
    await expect(page.getByText('Primary Request and Intent')).toHaveCount(0);
    await expect(page.getByText('Previous user request before compact.')).toBeVisible();
    await expect(page.getByText('Previous assistant response before compact.')).toBeVisible();
    await page.getByRole('button', { name: /Read node/ }).click();
    await expect(page.getByText(/Previous tool result before compact/)).toBeVisible();

    await compactToggle.click();

    await expect(page.getByText('Primary Request and Intent')).toBeVisible();
    await expect(page.getByText('Continue implementing the compact UI boundary.')).toBeVisible();
  });

  test('uses shared menu semantics for model and reasoning controls', async ({ page }) => {
    const modelButton = page.getByRole('button', { name: 'Select model' });
    await expect(modelButton).toHaveAttribute('aria-expanded', 'false');
    await modelButton.click();
    await expect(modelButton).toHaveAttribute('aria-expanded', 'true');

    const menu = page.getByRole('menu', { name: 'Model and reasoning settings' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('border-top-width', '0px');
    await expect(menu.getByRole('menuitem', { name: 'GPT-5.4', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Claude Sonnet 4.5', exact: true })).toHaveCount(0);
    const thinkingSwitch = menu.getByRole('switch', { name: 'Thinking' });
    const thinkingSwitchMark = thinkingSwitch.locator('.switch-mark');
    await expect(thinkingSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(thinkingSwitchMark).toHaveClass(/checked/);
    await expect(thinkingSwitchMark).toHaveCSS('width', '30px');
    await expect(thinkingSwitchMark).toHaveCSS('height', '18px');
    await expect(thinkingSwitch.locator('.switch-mark-thumb')).toHaveCSS('width', '14px');

    await menu.getByRole('menuitem', { name: 'GPT-5.4 Mini', exact: true }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => (
        call.cmd === 'agent_upsert_provider_config'
        && call.args.provider
        && typeof call.args.provider === 'object'
        && 'modelId' in call.args.provider
        && call.args.provider.modelId === 'gpt-5.4-mini'
      ));
    }).toBe(true);

    await modelButton.click();
    await page.getByRole('button', { name: 'Thinking level' }).click();
    const thinkingLevels = page.getByRole('menu', { name: 'Thinking levels' });
    await expect(thinkingLevels).toHaveCSS('border-top-width', '0px');
    await expect(thinkingLevels.getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    await thinkingLevels.getByRole('menuitemradio', { name: 'High' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => (
        call.cmd === 'agent_upsert_provider_config'
        && call.args.provider
        && typeof call.args.provider === 'object'
        && 'reasoningLevel' in call.args.provider
        && call.args.provider.reasoningLevel === 'high'
      ));
    }).toBe(true);
  });

  test('keeps provider settings in the top chrome more menu', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Agent settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open settings' })).toHaveCount(0);

    await page.locator('.top-chrome-right').getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Provider settings' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Select model' }).click();
    await expect(page.getByRole('menuitem', { name: 'API Settings' })).toHaveCount(0);
  });

  test('keeps the composer surface unified with neutral focus', async ({ page }) => {
    await expect(page.locator('.agent-composer-toolbar')).toHaveCSS('border-top-width', '0px');

    const input = page.locator('.agent-composer-editor .ProseMirror');
    await input.click();
    await expect(input).toBeFocused();
    const focusState = await input.evaluate((element) => {
      const surface = element.closest('.agent-composer-surface');
      if (!(surface instanceof HTMLElement)) {
        return null;
      }

      return {
        focusWithin: surface.matches(':focus-within'),
        shadow: getComputedStyle(surface).boxShadow,
      };
    });

    expect(focusState).not.toBeNull();
    expect(focusState!.focusWithin).toBe(true);
    expect(focusState!.shadow).not.toContain('244, 63, 94');
  });

  test('keeps the composer bottom-aligned with the shared dock inset', async ({ page }) => {
    const metrics = await page.locator('.agent-chat-panel').evaluate((panel) => {
      const dock = document.querySelector('.agent-dock');
      const header = document.querySelector('.agent-dock-header');
      const outlinePanel = document.querySelector('.outline-panel-surface');
      const sidebar = document.querySelector('.sidebar-dock');
      const scroll = document.querySelector('.agent-chat-scroll');
      const composer = document.querySelector('.agent-composer');
      const surface = document.querySelector('.agent-composer-surface');
      if (
        !(dock instanceof HTMLElement)
        || !(header instanceof HTMLElement)
        || !(outlinePanel instanceof HTMLElement)
        || !(sidebar instanceof HTMLElement)
        || !(scroll instanceof HTMLElement)
        || !(composer instanceof HTMLElement)
        || !(surface instanceof HTMLElement)
        || !(panel instanceof HTMLElement)
      ) {
        return null;
      }

      const dockBox = dock.getBoundingClientRect();
      const outlinePanelBox = outlinePanel.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      const composerStyle = getComputedStyle(composer);
      const outlinePanelStyle = getComputedStyle(outlinePanel);
      const sidebarStyle = getComputedStyle(sidebar);
      const scrollStyle = getComputedStyle(scroll);
      const headerStyle = getComputedStyle(header);
      const surfaceStyle = getComputedStyle(surface);
      const actionButton = surface.querySelector('.agent-composer-action-button');
      const attachmentButton = surface.querySelector('.agent-composer-tool-button');
      const modelButton = surface.querySelector('.agent-composer-model-button');
      const actionStyle = actionButton instanceof HTMLElement ? getComputedStyle(actionButton) : null;
      const attachmentStyle = attachmentButton instanceof HTMLElement ? getComputedStyle(attachmentButton) : null;
      const modelStyle = modelButton instanceof HTMLElement ? getComputedStyle(modelButton) : null;
      const actionBox = actionButton instanceof HTMLElement ? actionButton.getBoundingClientRect() : null;
      const attachmentBox = attachmentButton instanceof HTMLElement ? attachmentButton.getBoundingClientRect() : null;
      const rootStyle = getComputedStyle(document.documentElement);

      return {
        actionBottomInset: actionBox ? surfaceBox.bottom - actionBox.bottom : null,
        actionRadius: actionStyle ? Number.parseFloat(actionStyle.borderTopLeftRadius) : null,
        actionRightInset: actionBox ? surfaceBox.right - actionBox.right : null,
        actionSize: actionBox ? actionBox.width : null,
        attachmentBottomInset: attachmentBox ? surfaceBox.bottom - attachmentBox.bottom : null,
        attachmentLeftInset: attachmentBox ? attachmentBox.left - surfaceBox.left : null,
        attachmentRadius: attachmentStyle ? Number.parseFloat(attachmentStyle.borderTopLeftRadius) : null,
        attachmentSize: attachmentBox ? attachmentBox.width : null,
        expectedSurfaceRadius: Number.parseFloat(rootStyle.getPropertyValue('--agent-composer-radius')),
        modelRadius: modelStyle ? Number.parseFloat(modelStyle.borderTopLeftRadius) : null,
        composerBottomDelta: Math.abs(panelBox.bottom - composerBox.bottom),
        composerPaddingBottom: Number.parseFloat(composerStyle.paddingBottom),
        composerPaddingLeft: Number.parseFloat(composerStyle.paddingLeft),
        composerPaddingRight: Number.parseFloat(composerStyle.paddingRight),
        headerPaddingLeft: Number.parseFloat(headerStyle.paddingLeft),
        headerPaddingRight: Number.parseFloat(headerStyle.paddingRight),
        panelRadius: Number.parseFloat(outlinePanelStyle.borderTopLeftRadius),
        sidebarPaddingRight: Number.parseFloat(sidebarStyle.paddingRight),
        scrollPaddingLeft: Number.parseFloat(scrollStyle.paddingLeft),
        scrollPaddingRight: Number.parseFloat(scrollStyle.paddingRight),
        surfaceBottomToPanelBottom: Math.abs(outlinePanelBox.bottom - surfaceBox.bottom),
        surfaceLeftInset: surfaceBox.left - dockBox.left,
        surfacePaddingBottom: Number.parseFloat(surfaceStyle.paddingBottom),
        surfacePaddingLeft: Number.parseFloat(surfaceStyle.paddingLeft),
        surfacePaddingRight: Number.parseFloat(surfaceStyle.paddingRight),
        surfaceRadius: Number.parseFloat(surfaceStyle.borderTopLeftRadius),
        surfaceRightInset: dockBox.right - surfaceBox.right,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.composerBottomDelta).toBeLessThanOrEqual(1);
    expect(metrics!.composerPaddingBottom).toBe(0);
    expect(metrics!.composerPaddingLeft).toBe(0);
    expect(metrics!.composerPaddingRight).toBe(0);
    expect(metrics!.headerPaddingLeft).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.headerPaddingRight).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.scrollPaddingLeft).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.scrollPaddingRight).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.surfaceBottomToPanelBottom).toBeLessThanOrEqual(1);
    expect(metrics!.surfacePaddingLeft).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.surfacePaddingBottom).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.surfaceRadius).toBe(metrics!.expectedSurfaceRadius);
    expect(metrics!.surfaceRadius).toBe(metrics!.panelRadius);
    expect(metrics!.actionRadius).toBe(metrics!.surfaceRadius - metrics!.surfacePaddingRight);
    expect(metrics!.attachmentRadius).toBe(metrics!.surfaceRadius - metrics!.surfacePaddingLeft);
    expect(metrics!.modelRadius).toBe(metrics!.actionRadius);
    expect(metrics!.actionSize).toBe(metrics!.attachmentSize);
    expect(Math.abs(metrics!.attachmentLeftInset! - metrics!.surfacePaddingLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentBottomInset! - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset! - metrics!.surfacePaddingRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionBottomInset! - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentLeftInset! - metrics!.attachmentBottomInset!)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset! - metrics!.actionBottomInset!)).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceLeftInset).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceRightInset).toBeLessThanOrEqual(1);
  });

  test('conversation menu stays anchored inside narrow agent surfaces', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 620 });

    await page.getByRole('button', { name: 'Show conversations' }).click();
    const menu = page.getByRole('dialog', { name: 'Conversations' });
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(752);
  });

  test('keeps the header title compact and free of decorative status dots', async ({ page }) => {
    const metrics = await page.locator('.agent-dock-header').evaluate((header) => {
      const titleButton = header.querySelector('.agent-dock-title-button');
      const title = header.querySelector('.agent-dock-title');
      const chevron = header.querySelector('.agent-title-chevron');
      const actions = header.querySelector('.agent-dock-actions');
      if (
        !(header instanceof HTMLElement)
        || !(titleButton instanceof HTMLElement)
        || !(title instanceof HTMLElement)
        || !(chevron instanceof SVGElement)
        || !(actions instanceof HTMLElement)
      ) {
        return null;
      }

      const titleButtonBox = titleButton.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const chevronBox = chevron.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      const titleStyle = getComputedStyle(titleButton);
      const firstAction = actions.querySelector('.agent-menu-button');
      const actionStyle = firstAction instanceof HTMLElement ? getComputedStyle(firstAction) : null;
      const rootStyle = getComputedStyle(document.documentElement);

      function computedTokenColor(token: string) {
        const swatch = document.createElement('span');
        swatch.style.color = token;
        document.body.appendChild(swatch);
        const color = getComputedStyle(swatch).color;
        swatch.remove();
        return color;
      }

      return {
        actionColor: actionStyle?.color ?? null,
        buttonBackground: titleStyle.backgroundColor,
        buttonExtraWidth: titleButtonBox.width - titleBox.width - chevronBox.width,
        buttonPaddingLeft: Number.parseFloat(titleStyle.paddingLeft),
        chevronOpacity: getComputedStyle(chevron).opacity,
        gapToActions: actionsBox.left - titleButtonBox.right,
        textFaint: computedTokenColor(rootStyle.getPropertyValue('--text-faint').trim()),
        textSoft: computedTokenColor(rootStyle.getPropertyValue('--text-soft').trim()),
        textStrong: computedTokenColor(rootStyle.getPropertyValue('--text-strong').trim()),
        titleColor: getComputedStyle(title).color,
        titleText: title.textContent?.trim() ?? '',
        statusDotCount: header.querySelectorAll('.agent-status-dot').length,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.statusDotCount).toBe(0);
    expect(metrics!.titleText.startsWith('#')).toBe(false);
    expect(metrics!.buttonBackground).toBe('rgba(0, 0, 0, 0)');
    expect(metrics!.titleColor).toBe(metrics!.textSoft);
    expect(metrics!.actionColor).toBe(metrics!.textFaint);
    expect(metrics!.chevronOpacity).toBe('0');
    expect(metrics!.buttonPaddingLeft).toBe(4);
    expect(metrics!.buttonExtraWidth).toBeLessThanOrEqual(24);
    expect(metrics!.gapToActions).toBeGreaterThanOrEqual(8);

    await page.locator('.agent-dock-title-button').hover();
    await expect.poll(async () => page.locator('.agent-dock-header').evaluate((header) => {
      const titleButton = header.querySelector('.agent-dock-title-button');
      const title = header.querySelector('.agent-dock-title');
      const chevron = header.querySelector('.agent-title-chevron');
      if (
        !(titleButton instanceof HTMLElement)
        || !(title instanceof HTMLElement)
        || !(chevron instanceof SVGElement)
      ) {
        return null;
      }

      return {
        buttonBackground: getComputedStyle(titleButton).backgroundColor,
        chevronOpacity: getComputedStyle(chevron).opacity,
        titleColor: getComputedStyle(title).color,
      };
    })).toEqual({
      buttonBackground: 'rgba(0, 0, 0, 0)',
      chevronOpacity: '0.72',
      titleColor: metrics!.textStrong,
    });
  });

  test('renders node reference session titles without node ids', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: '[[你好^node:abcd7362-b2e4-498d-a1b2]] 你好',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [],
    });

    await expect(page.locator('.agent-dock-title')).toHaveText('你好 你好');
    await expect(page.locator('.agent-dock-title')).not.toContainText('node:');
  });

  test('keeps conversation rename geometry stable', async ({ page }) => {
    await page.getByRole('button', { name: 'Show conversations' }).click();
    const menu = page.getByRole('dialog', { name: 'Conversations' });
    await expect(menu).toBeVisible();

    const row = menu.locator('.agent-session-row').nth(1);
    await expect(row).toBeVisible();
    const before = await row.boundingBox();
    expect(before).toBeTruthy();

    await row.hover();
    await row.getByRole('button', { name: 'Rename conversation' }).click();
    await expect(row.getByLabel('Conversation title')).toBeVisible();

    const after = await row.boundingBox();
    expect(after).toBeTruthy();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  });

  test('switches the primary action between stop and steer while streaming', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation: [],
      streamingMessage: null,
      isStreaming: true,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const stopIcon = await page.getByRole('button', { name: 'Stop agent' }).locator('svg').evaluate((icon) => {
      const style = getComputedStyle(icon);
      return {
        fill: style.fill,
        strokeWidth: style.strokeWidth,
      };
    });
    expect(stopIcon.fill).not.toBe('none');
    expect(Number.parseFloat(stopIcon.strokeWidth)).toBe(0);

    await page.getByRole('button', { name: 'Stop agent' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'agent_stop_session');
    }).toBe(true);

    await page.getByLabel('Agent message').fill('Compare tag layout stability.');
    await page.getByRole('button', { name: 'Steer agent' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_steer_session')?.args;
    }).toMatchObject({
      message: 'Compare tag layout stability.',
      sessionId: 'mock-agent-session',
    });
    await expect(page.getByText('Compare tag layout stability.')).toBeVisible();
  });

  test('opens subagent details and expands nested tool calls', async ({ page }) => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };

    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        {
          nodeId: 'agent-user-subagent',
          message: {
            role: 'user',
            timestamp: 1_800_000_000_500,
            content: [{ type: 'text', text: 'Use a subagent to inspect the UI.' }],
          },
          branches: null,
        },
        {
          nodeId: 'agent-assistant-subagent',
          message: {
            role: 'assistant',
            timestamp: 1_800_000_000_700,
            api: 'openai-completions',
            provider: 'openai',
            model: 'gpt-5.4',
            usage,
            stopReason: 'toolUse',
            content: [{
              type: 'toolCall',
              id: 'tool-agent-1',
              name: 'Agent',
              arguments: {
                description: 'Inspect subagent UI',
                prompt: 'Inspect the current UI.',
              },
            }],
          },
          branches: null,
        },
      ],
      subagents: [{
        id: 'subagent-1',
        description: 'Inspect subagent UI',
        prompt: 'Inspect the current UI.',
        subagentType: 'explorer',
        contextMode: 'fork',
        status: 'running',
        startedAt: 1_800_000_000_800,
        updatedAt: 1_800_000_001_200,
        transcriptPayloadId: 'subagent-transcript-1',
        transcriptMessageCount: 4,
        parentToolCallId: 'tool-agent-1',
      }],
    });

    await expect(page.getByText('Subagent · Inspect subagent UI')).toBeVisible();
    await page.getByText('Subagent · Inspect subagent UI').click();
    await expect(page.getByText('fork · explorer')).toBeVisible();

    await page.getByRole('button', { name: 'View transcript' }).click();
    const details = page.getByRole('complementary', { name: 'Subagent details' });
    await expect(details).toBeVisible();
    await expect(details.getByText('Timeline (4)')).toBeVisible();
    await expect(details.getByText('Inspect the current UI.')).toBeVisible();
    await expect(details.getByText('Read node "today"')).toBeVisible();

    await details.getByText('Read node "today"').click();
    await expect(details.getByText('Daily note content from subagent.')).toBeVisible();

    await details.getByLabel('Subagent follow-up').fill('Continue with layout risks.');
    await details.getByRole('button', { name: 'Send' }).click();
    await details.getByRole('button', { name: 'Stop' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.filter((call) => call.cmd === 'agent_subagent_send' || call.cmd === 'agent_subagent_stop')
        .map((call) => ({ cmd: call.cmd, args: call.args }));
    }).toEqual([
      {
        cmd: 'agent_subagent_send',
        args: {
          agentId: 'subagent-1',
          message: 'Continue with layout risks.',
          sessionId: 'mock-agent-session',
        },
      },
      {
        cmd: 'agent_subagent_stop',
        args: {
          agentId: 'subagent-1',
          sessionId: 'mock-agent-session',
        },
      },
    ]);
  });
});
