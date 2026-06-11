import { expect, test, type Page } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  emitAgentProjection,
  emitAgentEvent,
  emitDocumentEvent,
  ids,
  openMockedApp,
  rowEditor,
  setAgentMessageContextMenuAction,
} from './outlinerMock';

async function waitForAgentConversation(page: import('@playwright/test').Page) {
  await expect.poll(async () => {
    const calls = await commandCalls(page);
    return calls.some((call) => call.cmd === 'agent_restore_latest_conversation');
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

async function pendingQuestionMetrics(page: Page) {
  return page.locator('.agent-question-card').evaluate((card) => {
    const surface = card.closest('.agent-composer-surface');
    const option = card.querySelector('.agent-question-option');
    const textarea = card.querySelector('.agent-question-text');
    const button = card.querySelector('.agent-approval-button.is-primary');
    if (
      !(card instanceof HTMLElement)
      || !(surface instanceof HTMLElement)
      || !(option instanceof HTMLElement)
      || !(textarea instanceof HTMLElement)
      || !(button instanceof HTMLElement)
    ) {
      return null;
    }

    const cardBox = card.getBoundingClientRect();
    const surfaceBox = surface.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    const optionStyle = getComputedStyle(option);
    const textareaStyle = getComputedStyle(textarea);
    const buttonStyle = getComputedStyle(button);
    const title = card.querySelector('.agent-question-title');
    const titleStyle = title instanceof HTMLElement ? getComputedStyle(title) : null;

    return {
      cardOverflow: card.scrollWidth > card.clientWidth + 1,
      optionOverflow: option.scrollWidth > option.clientWidth + 1,
      textareaOverflow: textarea.scrollWidth > textarea.clientWidth + 1,
      insideSurface:
        cardBox.left >= surfaceBox.left - 1
        && cardBox.right <= surfaceBox.right + 1
        && cardBox.top >= surfaceBox.top - 1
        && cardBox.bottom <= surfaceBox.bottom + 1,
      titleColor: titleStyle?.color ?? '',
      cardColor: cardStyle.color,
      optionBackground: optionStyle.backgroundColor,
      textareaBackground: textareaStyle.backgroundColor,
      buttonBackground: buttonStyle.backgroundColor,
      buttonColor: buttonStyle.color,
      buttonHeight: Math.round(button.getBoundingClientRect().height),
    };
  });
}

test.describe('agent composer controls', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await waitForAgentConversation(page);
  });

  test('opening the agent dock focuses the composer editor', async ({ page }) => {
    const composer = page.locator('.agent-composer-editor .ProseMirror');

    await page.getByTitle('Collapse agent').click();
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'collapsed');
    await rowEditor(page, ids.beta).click();
    await expect(rowEditor(page, ids.beta)).toBeFocused();

    await page.getByTitle('Expand agent').click();
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'open');
    await expect(composer).toBeFocused();
  });

  test('resolving a pending question after dock reopen does not steal focus into the composer', async ({ page }) => {
    const requestId = 'question-focus-e2e';
    const composer = page.locator('.agent-composer-editor .ProseMirror');

    await page.getByTitle('Collapse agent').click();
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'collapsed');
    await emitAgentEvent(page, {
      type: 'user_question_request',
      conversationId: 'mock-agent-conversation',
      requestId,
      question: {
        requestId,
        conversationId: 'mock-agent-conversation',
        runId: 'run-question-focus-e2e',
        toolCallId: 'tool-question-focus-e2e',
        request: {
          submitLabel: 'Continue',
          questions: [{
            id: 'path',
            type: 'single_choice',
            question: 'Which path should the agent take?',
            required: true,
            options: [{ id: 'continue', label: 'Continue' }],
          }],
        },
      },
      timestamp: 1_800_000_002_000,
    });

    await rowEditor(page, ids.beta).click();
    await expect(rowEditor(page, ids.beta)).toBeFocused();
    await page.getByTitle('Expand agent').click();
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'open');
    await expect(page.locator('.agent-question-card')).toBeVisible();

    await rowEditor(page, ids.beta).click();
    await expect(rowEditor(page, ids.beta)).toBeFocused();
    await emitAgentEvent(page, {
      type: 'user_question_resolved',
      conversationId: 'mock-agent-conversation',
      requestId,
      timestamp: 1_800_000_002_100,
    });

    await expect(page.locator('.agent-question-card')).toHaveCount(0);
    await expect(rowEditor(page, ids.beta)).toBeFocused();
    await expect(composer).not.toBeFocused();
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
      conversationId: 'mock-agent-conversation',
    });
  });

  test('renders skill trust approvals as accept/not-now cards', async ({ page }) => {
    await emitAgentEvent(page, {
      type: 'approval_request',
      conversationId: 'mock-agent-conversation',
      requestId: 'skill-trust-e2e',
      request: {
        requestId: 'skill-trust-e2e',
        conversationId: 'mock-agent-conversation',
        kind: 'skill_trust',
        toolCallId: 'tool-skill-trust-e2e',
        toolName: 'skill',
        title: 'Skill review-pr requests automatic use.',
        target: '/review-pr',
        reason: 'Accept the current skill content hash before Lin can invoke it automatically.',
        details: [{ label: 'Content hash', value: 'abc123' }],
        skillTrust: {
          name: 'review-pr',
          source: 'project',
          contentHash: 'abc123',
        },
      },
      timestamp: 1_800_000_003_000,
    });

    const card = page.locator('.agent-approval-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Skill review-pr requests automatic use.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept skill' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve once' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hand everything to Lin, stop asking' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Accept skill' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_resolve_approval' && call.args.requestId === 'skill-trust-e2e')?.args;
    }).toMatchObject({
      conversationId: 'mock-agent-conversation',
      requestId: 'skill-trust-e2e',
      approved: true,
      scope: 'once',
    });
  });

  test('renders permission notices as dismiss-only cards', async ({ page }) => {
    await emitAgentEvent(page, {
      type: 'approval_request',
      conversationId: 'mock-agent-conversation',
      requestId: 'permission-notice-e2e',
      request: {
        requestId: 'permission-notice-e2e',
        conversationId: 'mock-agent-conversation',
        kind: 'permission_notice',
        toolCallId: 'tool-notice-e2e',
        toolName: 'bash',
        title: 'Blocked unknown shell command',
        target: '$(cat ./script.sh)',
        reason: 'Unknown or ambiguous shell execution.',
        details: [{ label: 'Permission kind', value: 'shell.unknown' }],
      },
      timestamp: 1_800_000_003_100,
    });

    const card = page.locator('.agent-approval-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Blocked unknown shell command')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve once' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Accept skill' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deny once' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_resolve_approval' && call.args.requestId === 'permission-notice-e2e')?.args;
    }).toMatchObject({
      conversationId: 'mock-agent-conversation',
      requestId: 'permission-notice-e2e',
      approved: false,
      scope: 'once',
    });
  });

  test('pastes multi-line text as multiple lines instead of collapsing to one', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'first line\nsecond line\nthird line');
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });

    // Every line survives: the single-paragraph schema keeps them as hardBreaks
    // rather than dropping everything after the first line.
    await expect.poll(async () => (
      await input.evaluate((element) => (element as HTMLElement).innerText.replace(/\r/gu, ''))
    )).toContain('third line');

    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_send_message')?.args.message;
    }).toBe('first line\nsecond line\nthird line');
  });

  test('keeps pending user questions visually stable in light and dark themes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await emitAgentEvent(page, {
      type: 'user_question_request',
      conversationId: 'mock-agent-conversation',
      requestId: 'question-e2e',
      question: {
        requestId: 'question-e2e',
        conversationId: 'mock-agent-conversation',
        runId: 'run-question-e2e',
        toolCallId: 'tool-question-e2e',
        request: {
          submitLabel: 'Use this path',
          questions: [{
            id: 'path',
            type: 'single_choice',
            header: 'Implementation path',
            question: 'Which implementation path should the agent use for the memory profile surface?',
            required: true,
            allowOther: true,
            options: [{
              id: 'verify-existing',
              label: 'Verify existing UI',
              description: 'Use the shipped Settings Memory pane and add focused verification.',
            }, {
              id: 'rebuild',
              label: 'Rebuild the pane',
              description: 'Replace the current pane with a new profile-specific surface.',
            }],
          }, {
            id: 'notes',
            type: 'free_text',
            header: 'Extra context',
            question: 'Anything else the implementation should preserve?',
            required: false,
          }],
        },
      },
      timestamp: 1_800_000_001_000,
    });

    const card = page.locator('.agent-question-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Input needed')).toBeVisible();
    await expect(card.getByText('Which implementation path should the agent use')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use this path' })).toBeDisabled();

    const light = await pendingQuestionMetrics(page);
    expect(light).not.toBeNull();
    expect(light!.insideSurface).toBe(true);
    expect(light!.cardOverflow).toBe(false);
    expect(light!.optionOverflow).toBe(false);
    expect(light!.textareaOverflow).toBe(false);
    expect(light!.buttonBackground).not.toContain('244, 63, 94');
    expect(light!.buttonHeight).toBeGreaterThanOrEqual(28);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await pendingQuestionMetrics(page))?.optionBackground)
      .not.toBe(light!.optionBackground);
    const dark = await pendingQuestionMetrics(page);
    expect(dark).not.toBeNull();
    expect(dark!.insideSurface).toBe(true);
    expect(dark!.cardOverflow).toBe(false);
    expect(dark!.optionOverflow).toBe(false);
    expect(dark!.textareaOverflow).toBe(false);
    expect(dark!.titleColor).not.toBe(light!.titleColor);
    expect(dark!.buttonBackground).not.toContain('255, 93, 118');
    expect(dark!.buttonHeight).toBe(light!.buttonHeight);

    await card.getByLabel('Verify existing UI').check();
    await expect(page.getByRole('button', { name: 'Use this path' })).toBeEnabled();
    await page.getByRole('button', { name: 'Use this path' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_resolve_user_question')?.args;
    }).toMatchObject({
      conversationId: 'mock-agent-conversation',
      requestId: 'question-e2e',
      result: {
        requestId: 'question-e2e',
        answers: [
          { questionId: 'path', selectedOptionIds: ['verify-existing'] },
          { questionId: 'notes' },
        ],
      },
    });
  });

  test('submits pending question answers with node refs, file refs, and attachments', async ({ page }) => {
    await emitAgentEvent(page, {
      type: 'user_question_request',
      conversationId: 'mock-agent-conversation',
      requestId: 'question-rich-answer-e2e',
      question: {
        requestId: 'question-rich-answer-e2e',
        conversationId: 'mock-agent-conversation',
        runId: 'run-question-rich-answer-e2e',
        toolCallId: 'tool-question-rich-answer-e2e',
        request: {
          submitLabel: 'Send answer',
          questions: [{
            id: 'context',
            type: 'free_text',
            header: 'Context',
            question: 'What context should the agent use?',
            required: true,
            allowReferences: true,
            allowAttachments: true,
          }],
        },
      },
      timestamp: 1_800_000_001_500,
    });

    const card = page.locator('.agent-question-card');
    const input = card.locator('.agent-composer-editor .ProseMirror');
    await input.click();
    await page.keyboard.type('@Alpha');
    const menu = page.getByRole('listbox', { name: 'Agent mention suggestions' });
    await expect(menu).toBeVisible();
    await menu.getByRole('option', { name: /Alpha/ }).click();
    await page.keyboard.type('use this with ');
    await card.locator('.agent-composer-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('question notes'),
    });

    await expect(card.locator('[data-agent-node-ref="node-alpha"]')).toBeVisible();
    await expect(card.locator('[data-agent-file-ref]')).toContainText('notes.txt');
    await page.getByRole('button', { name: 'Send answer' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_resolve_user_question')?.args;
    }).toMatchObject({
      conversationId: 'mock-agent-conversation',
      requestId: 'question-rich-answer-e2e',
      result: {
        requestId: 'question-rich-answer-e2e',
        outcome: 'answered',
        answers: [{
          questionId: 'context',
          text: '[[node:Alpha^node-alpha]] use this with [[file:notes.txt^%2Fmock%2Flocal-root%2Ftmp%2Fagent-attachments%2F1-notes.txt]]',
          nodeRefs: [{ nodeId: 'node-alpha', label: 'Alpha' }],
          fileRefs: [{
            name: 'notes.txt',
            path: '/mock/local-root/tmp/agent-attachments/1-notes.txt',
            ref: 'notes.txt',
            mimeType: 'text/plain',
          }],
          attachments: [{
            kind: 'file',
            name: 'notes.txt',
            path: '/mock/local-root/tmp/agent-attachments/1-notes.txt',
          }],
        }],
      },
    });
  });

  test('resolves pending questions through the discuss action', async ({ page }) => {
    await emitAgentEvent(page, {
      type: 'user_question_request',
      conversationId: 'mock-agent-conversation',
      requestId: 'question-discuss-e2e',
      question: {
        requestId: 'question-discuss-e2e',
        conversationId: 'mock-agent-conversation',
        runId: 'run-question-discuss-e2e',
        toolCallId: 'tool-question-discuss-e2e',
        request: {
          questions: [{
            id: 'path',
            type: 'single_choice',
            question: 'Which path should the agent take?',
            required: true,
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          }],
        },
      },
      timestamp: 1_800_000_001_600,
    });

    await page.getByRole('button', { name: 'Discuss first' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_resolve_user_question')?.args;
    }).toMatchObject({
      conversationId: 'mock-agent-conversation',
      requestId: 'question-discuss-e2e',
      result: {
        requestId: 'question-discuss-e2e',
        outcome: 'discussed',
        answers: [],
        discuss: { message: 'I want to discuss this before answering.' },
      },
    });
  });

  test('inserts attachments inline and sends them as context', async ({ page }) => {
    await page.locator('.agent-composer-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from test'),
    });
    await expect(page.locator('[data-agent-file-ref]')).toContainText('notes.txt');
    await expect(page.locator('[data-agent-file-ref] .inline-ref-file-icon')).toHaveAttribute('data-file-icon-kind', 'text');
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
      attachments: [{
        kind: 'file',
        name: 'notes.txt',
        path: '/mock/local-root/tmp/agent-attachments/1-notes.txt',
      }],
      message: '[[file:notes.txt^%2Fmock%2Flocal-root%2Ftmp%2Fagent-attachments%2F1-notes.txt]]',
    });
  });

  test('keeps distinct pathless files with the same name and size', async ({ page }) => {
    await page.locator('.agent-composer-file-input').setInputFiles([{
      name: 'same.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('aaaa'),
    }, {
      name: 'same.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('bbbb'),
    }]);
    await expect(page.locator('[data-agent-file-ref]')).toHaveCount(2);

    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => (
        call.cmd === 'agent_send_message'
        && Array.isArray(call.args.attachments)
        && call.args.attachments.filter((attachment: { name?: string }) => attachment.name === 'same.txt').length === 2
      ))?.args;
    }).toMatchObject({
      attachments: [
        { kind: 'file', name: 'same.txt', path: '/mock/local-root/tmp/agent-attachments/1-same.txt' },
        { kind: 'file', name: 'same.txt', path: '/mock/local-root/tmp/agent-attachments/2-same.txt' },
      ],
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
      message: '[[file:local-notes.md^%2FUsers%2Ftest%2FDocuments%2Flocal-notes.md]]',
    });
  });

  test('rejects oversized native picker images instead of silently downgrading to files', async ({ page }) => {
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
          path: '/Users/test/Pictures/huge.png',
          name: 'huge.png',
          mimeType: 'image/png',
          sizeBytes: 11 * 1024 * 1024,
          lastModified: 1_800_000_000_000,
        }],
      });
    });

    await page.getByRole('button', { name: 'Add attachment' }).click();
    await expect(page.getByRole('status')).toContainText('huge.png is larger than 10 MB');
    await expect(page.locator('[data-agent-file-ref]')).toHaveCount(0);
  });

  test('renders sent attachment mentions inline without raw image placeholders', async ({ page }) => {
    const imagePath = '/Users/test/Desktop/Screenshot 2026-05-26 at 14.50.16.png';

    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [{
        nodeId: 'agent-user-with-attachments',
        message: {
          role: 'user',
          timestamp: 1_800_000_000_500,
          content: [
            {
              type: 'text',
              text: `[[file:.DS_Store^%2FUsers%2Ftest%2FDesktop%2F.DS_Store]] 总结一下，然后跟 [[file:Coding^%2FUsers%2Ftest%2FDocuments%2FCoding^directory]] 对比一下，然后添加到 [[node:Alpha^node-alpha]]，参考 [[file:Screenshot 2026-05-26 at 14.50.16.png^${encodeURIComponent(imagePath)}]]`,
            },
            {
              type: 'image',
              data: 'iVBORw0KGgo=',
              mimeType: 'image/png',
            },
          ],
        },
        branches: null,
      }],
    });

    const row = page.locator('.agent-message-row.user').filter({ hasText: '总结一下' });
    const bubble = row.locator('.agent-user-bubble');
    await expect(row.locator('.agent-user-file-chip')).toHaveCount(0);
    await expect(bubble.locator('[data-agent-message-file-ref]')).toHaveCount(3);
    await expect(bubble.locator('[data-agent-message-file-ref]').nth(0)).toContainText('.DS_Store');
    await expect(bubble.locator('[data-agent-message-file-ref]').nth(1)).toContainText('Coding');
    await expect(bubble.locator('[data-agent-message-file-ref]').nth(2)).toContainText('Screenshot 2026-05-26 at 14.50.16.png');
    await expect(bubble.locator('[data-agent-message-file-ref] .inline-ref-file-icon').nth(1)).toHaveAttribute('data-file-icon-kind', 'folder');
    await expect(bubble.locator('[data-inline-ref]')).toHaveText('Alpha');
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
      message: '[[file:Project Report.md^%2FUsers%2Ftest%2FDocuments%2FProject%20Report.md]]',
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
    await expect(page.locator('[data-agent-file-ref] .inline-ref-file-icon')).toHaveAttribute('data-file-icon-kind', 'folder');
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
      message: '[[file:design-system^%2FUsers%2Ftest%2FDocuments%2Fdesign-system^directory]]',
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
      const imageDataBase64 = thumbnail.slice(thumbnail.indexOf(',') + 1);
      const win = window as typeof window & {
        __openedLocalFiles?: string[];
        lin?: {
          invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
          openLocalFile?: (options: { path: string }) => Promise<{ opened: boolean }>;
          prepareLocalFile?: (options: { id: string }) => Promise<{
            file: {
              entryKind?: 'file' | 'directory';
              path: string;
              name: string;
              mimeType: string;
              sizeBytes: number;
              lastModified: number;
              imageDataBase64?: string;
              thumbnailDataUrl?: string;
            } | null;
          }>;
          previewLocalFileReference?: (options: { path: string }) => Promise<{
            file: {
              entryKind: 'file' | 'directory';
              path: string;
              name: string;
              parentPath: string;
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
      win.__openedLocalFiles = [];
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
              imageDataBase64,
              thumbnailDataUrl: thumbnail,
            }
          : null,
      });
      win.lin.previewLocalFileReference = async (options) => ({
        file: options.path === '/Users/test/Pictures/gpt4.png'
          ? {
              entryKind: 'file',
              path: '/Users/test/Pictures/gpt4.png',
              name: 'gpt4.png',
              parentPath: '/Users/test/Pictures',
              mimeType: 'image/png',
              sizeBytes: 4096,
              lastModified: 1_800_000_000_000,
              thumbnailDataUrl: thumbnail,
            }
          : null,
      });
      win.lin.openLocalFile = async (options) => {
        win.__openedLocalFiles?.push(options.path);
        return { opened: true };
      };
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
    await expect(page.locator('[data-agent-file-ref] .inline-ref-file-icon')).toHaveAttribute('data-file-icon-kind', 'image');
    await expect(page.locator('[data-agent-file-ref]')).not.toHaveAttribute('title', /gpt4\.png/);
    await expect(page.locator('[data-agent-file-ref]')).toHaveAttribute('aria-label', /gpt4\.png/);

    const inlineRef = page.locator('[data-agent-file-ref]');
    const inlinePreview = page.locator('[data-inline-file-preview]');
    await inlineRef.hover();
    await page.waitForTimeout(100);
    await page.mouse.move(20, 20);
    await page.waitForTimeout(500);
    await expect(inlinePreview).toHaveCount(0);

    await inlineRef.hover();
    await expect(inlinePreview).toBeVisible();
    await expect(inlinePreview).toContainText('gpt4.png');
    const [inlineRefBox, inlinePreviewBox] = await Promise.all([
      inlineRef.boundingBox(),
      inlinePreview.boundingBox(),
    ]);
    expect(inlineRefBox).toBeTruthy();
    expect(inlinePreviewBox).toBeTruthy();
    expect(inlinePreviewBox!.y + inlinePreviewBox!.height).toBeLessThanOrEqual(inlineRefBox!.y - 4);
    expect(inlineRefBox!.y - (inlinePreviewBox!.y + inlinePreviewBox!.height)).toBeLessThan(24);
    await page.mouse.move(20, 20);
    await expect(inlinePreview).toHaveCount(0);

    await inlineRef.hover();
    await expect(inlinePreview).toBeVisible();
    await inlineRef.click();
    await expect.poll(async () => page.evaluate(() => {
      const win = window as typeof window & { __openedLocalFiles?: string[] };
      return win.__openedLocalFiles ?? [];
    })).toEqual([]);

    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => (
        call.cmd === 'agent_send_message'
        && Array.isArray(call.args.attachments)
        && call.args.attachments.some((attachment: { kind?: string; path?: string }) =>
          attachment.kind === 'image' && attachment.path === '/Users/test/Pictures/gpt4.png')
      ))?.args;
    }).toMatchObject({
      attachments: [{ kind: 'image', path: '/Users/test/Pictures/gpt4.png' }],
      message: '[[file:gpt4.png^%2FUsers%2Ftest%2FPictures%2Fgpt4.png]]',
    });
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
      message: '[[node:Alpha^node-alpha]] details',
      userViewContext: {
        referencedNodes: [{ nodeId: 'node-alpha', title: 'Alpha' }],
      },
    });

    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [{
        nodeId: 'agent-user-with-ref',
        message: {
          role: 'user',
          timestamp: 1_800_000_000_500,
          content: [{ type: 'text', text: '[[node:Alpha^node-alpha]] details' }],
        },
        branches: null,
      }],
    });

    const userBubble = page.locator('.agent-user-bubble', { hasText: 'details' });
    await expect(userBubble.locator('[data-inline-ref="node-alpha"]')).toHaveText('Alpha');
    await expect(userBubble).not.toContainText('[[node:Alpha^node-alpha]]');
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
    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Agent System',
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
            { type: 'text', text: 'Review [[node:Alpha^node-alpha]] and [[node:^node-alpha]] before [[node:^node-missing]].' },
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
        content: [{ type: 'text', text: 'Tool output references [[node:^node-alpha]].' }],
        isError: false,
      }],
    });

    await expect(page.locator('.agent-markdown [data-inline-ref="node-alpha"]')).toHaveText(['Alpha', 'Alpha']);
    await expect(page.locator('.agent-markdown [data-inline-ref="node-missing"]')).toHaveText('Referenced node');
    await expect(page.locator('.agent-markdown [data-inline-ref="node-missing"]')).not.toContainText('node-missing');
    const panelCount = await page.locator('.outline-panel-surface').count();

    // Plain click navigates the active pane in place (no new pane).
    await page.locator('.agent-markdown [data-inline-ref="node-alpha"]').first().click();
    await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCount);
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Alpha');

    // Meta/Ctrl+click opens the reference in a new split pane.
    await page.locator('.agent-markdown [data-inline-ref="node-alpha"]').nth(1).click({ modifiers: ['Meta'] });
    await expect(page.locator('.outline-panel-surface')).toHaveCount(panelCount + 1);
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Alpha');

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
    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Agent System',
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Agent System',
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
            source: { fromMessageId: 'user-before-compact', throughMessageId: 'assistant-before-compact' },
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

  test('shows channel speaker identity, time separators, and message details', async ({ page }) => {
    const usage = {
      input: 1200,
      output: 34,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 1244,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };

    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Planning Channel',
      members: [
        { principal: { type: 'user', userId: 'local-user' }, mention: '', displayName: 'You' },
        {
          principal: { type: 'agent', agentId: 'built-in:core:assistant' },
          mention: 'assistant',
          displayName: 'Agent System',
          coordinator: true,
        },
        {
          principal: { type: 'agent', agentId: 'built-in:tenon:general' },
          mention: 'general',
          displayName: 'general',
        },
      ],
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        {
          nodeId: 'agent-user-meta',
          actor: { type: 'user', userId: 'local-user' },
          message: {
            role: 'user',
            timestamp: 1_800_000_000_000,
            content: [{ type: 'text', text: 'Start the UX review.' }],
          },
        },
        {
          nodeId: 'assistant-coordinator-meta',
          actor: { type: 'agent', agentId: 'built-in:core:assistant' },
          message: {
            role: 'assistant',
            timestamp: 1_800_000_000_100,
            api: 'openai-completions',
            provider: 'openai',
            model: 'gpt-5.4',
            usage,
            stopReason: 'stop',
            content: [{ type: 'text', text: 'Coordinator result.' }],
          },
        },
        {
          nodeId: 'assistant-peer-meta',
          actor: { type: 'agent', agentId: 'built-in:tenon:general' },
          message: {
            role: 'assistant',
            timestamp: 1_800_000_000_100 + 2 * 60 * 60 * 1000,
            api: 'openai-completions',
            provider: 'openai',
            model: 'gpt-5.4',
            usage,
            stopReason: 'stop',
            content: [{ type: 'text', text: 'General result.' }],
          },
        },
      ],
    });

    await expect(page.locator('.agent-message-time-separator')).toHaveCount(1);
    const coordinatorRow = page.locator('.agent-message-row.assistant', { hasText: 'Coordinator result.' });
    await expect(coordinatorRow.locator('.agent-message-actor')).toContainText('Agent System');
    await expect(coordinatorRow.locator('.agent-message-actor')).toContainText('@assistant');
    await expect(coordinatorRow.locator('.agent-identity-avatar')).toBeVisible();

    const peerRow = page.locator('.agent-message-row.assistant', { hasText: 'General result.' });
    await expect(peerRow.locator('.agent-message-actor')).toContainText('general');
    await expect(peerRow.locator('.agent-message-actor')).toContainText('@general');

    await setAgentMessageContextMenuAction(page, 'details');
    await peerRow.click({ button: 'right' });

    const details = page.getByRole('dialog', { name: 'Details' });
    await expect(details).toBeVisible();
    await expect(details).toContainText('general');
    await expect(details).toContainText('@general');
    await expect(details).toContainText('openai/gpt-5.4');
    await expect(details).toContainText('input 1,200');
    await expect(details).toContainText('output 34');
    await expect(details).toContainText('cache read 10');
    await expect(details).toContainText('total 1,244');
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_message_context_menu')?.args;
    }).toMatchObject({
      canCopy: true,
      canRegenerate: true,
      canShowDetails: true,
    });
  });

  test('opens provider config from the model chip without mutating model settings inline', async ({ page }) => {
    const modelButton = page.getByRole('button', { name: 'Open model settings' });
    await expect(modelButton).toContainText('GPT-5.4');
    await expect(modelButton).toContainText('Medium');

    await modelButton.click();

    await expect(page.getByRole('menu', { name: 'Model and reasoning settings' })).toHaveCount(0);
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_provider_config')?.args;
    }).toMatchObject({ providerId: 'openai', mode: 'configure' });
    expect((await commandCalls(page)).some((call) => call.cmd === 'agent_upsert_provider_config')).toBe(false);
  });

  test('keeps the model chip a stable display control', async ({ page }) => {
    const modelButton = page.getByRole('button', { name: 'Open model settings' });
    const before = await modelButton.boundingBox();
    expect(before).not.toBeNull();

    await modelButton.hover();
    const after = await modelButton.boundingBox();

    expect(after).not.toBeNull();
    expect(after!.width).toBeCloseTo(before!.width, 1);
    expect(after!.height).toBeCloseTo(before!.height, 1);
    await expect(page.locator('.agent-composer-thinking-row')).toHaveCount(0);
    await expect(page.locator('.agent-composer-model-menu')).toHaveCount(0);
  });

  test('keeps settings in the sidebar, never duplicated in the agent surface', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Agent settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open settings' })).toHaveCount(0);

    // The floating-rails shell (#57) dissolved the top chrome: Settings now lives at
    // the sidebar bottom, not in a top-chrome More menu.
    await expect(
      page.locator('.sidebar-bottom').getByRole('button', { name: 'Settings' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Open model settings' }).click();
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

      const style = getComputedStyle(surface);
      return {
        focusWithin: surface.matches(':focus-within'),
        background: style.backgroundColor,
        shadow: style.boxShadow,
      };
    });

    expect(focusState).not.toBeNull();
    expect(focusState!.focusWithin).toBe(true);
    // Focus is indicated by a neutral --fill background step (B3): never the rose
    // accent, and never a brand-coloured ring. (We assert neutrality rather than a
    // before/after delta to stay robust against the background's fade transition.)
    expect(focusState!.background).not.toContain('244, 63, 94');
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
      const panelBox = panel.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      const composerStyle = getComputedStyle(composer);
      const outlinePanelStyle = getComputedStyle(outlinePanel);
      const sidebarStyle = getComputedStyle(sidebar);
      const scrollStyle = getComputedStyle(scroll);
      const headerStyle = getComputedStyle(header);
      const surfaceStyle = getComputedStyle(surface);
      const editor = surface.querySelector('.agent-composer-editor');
      const editorText = surface.querySelector('.agent-composer-editor .ProseMirror');
      const editorBox = editor instanceof HTMLElement ? editor.getBoundingClientRect() : null;
      const editorTextBox = editorText instanceof HTMLElement ? editorText.getBoundingClientRect() : null;
      const actionButton = surface.querySelector('.agent-composer-action-button');
      const attachmentButton = surface.querySelector('.agent-composer-tool-button');
      const modelButton = surface.querySelector('.agent-composer-model-button');
      const actionStyle = actionButton instanceof HTMLElement ? getComputedStyle(actionButton) : null;
      const attachmentStyle = attachmentButton instanceof HTMLElement ? getComputedStyle(attachmentButton) : null;
      const modelStyle = modelButton instanceof HTMLElement ? getComputedStyle(modelButton) : null;
      const actionBox = actionButton instanceof HTMLElement ? actionButton.getBoundingClientRect() : null;
      const attachmentBox = attachmentButton instanceof HTMLElement ? attachmentButton.getBoundingClientRect() : null;
      const rootStyle = getComputedStyle(document.documentElement);
      // The flush composer's rounded top corners match the dock's own radius
      // (--panel-radius), so its bottom corners — clipped by the dock — share the same
      // curvature. Resolve the token to px via a probe (it is a calc()).
      const radiusProbe = document.createElement('div');
      radiusProbe.style.width = 'var(--panel-radius)';
      document.body.appendChild(radiusProbe);
      const expectedSurfaceRadius = Number.parseFloat(getComputedStyle(radiusProbe).width);
      radiusProbe.remove();

      return {
        expectedSurfaceRadius,
        actionBottomInset: actionBox ? surfaceBox.bottom - actionBox.bottom : null,
        actionRadius: actionStyle ? Number.parseFloat(actionStyle.borderTopLeftRadius) : null,
        actionRightInset: actionBox ? surfaceBox.right - actionBox.right : null,
        actionSize: actionBox ? actionBox.width : null,
        attachmentBottomInset: attachmentBox ? surfaceBox.bottom - attachmentBox.bottom : null,
        attachmentLeftInset: attachmentBox ? attachmentBox.left - surfaceBox.left : null,
        attachmentRadius: attachmentStyle ? Number.parseFloat(attachmentStyle.borderTopLeftRadius) : null,
        attachmentSize: attachmentBox ? attachmentBox.width : null,
        dockInset: Number.parseFloat(rootStyle.getPropertyValue('--rail-pad')),
        modelRadius: modelStyle ? Number.parseFloat(modelStyle.borderTopLeftRadius) : null,
        modelHeight: modelStyle ? Number.parseFloat(modelStyle.height) : null,
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
        // Floating rails (#57) don't bottom-align across docks, so the composer
        // surface bottoms out flush within its OWN chat panel, not the outline panel.
        surfaceBottomToPanelBottom: Math.abs(panelBox.bottom - surfaceBox.bottom),
        surfaceLeftInset: surfaceBox.left - dockBox.left,
        surfacePaddingBottom: Number.parseFloat(surfaceStyle.paddingBottom),
        surfacePaddingLeft: Number.parseFloat(surfaceStyle.paddingLeft),
        surfacePaddingRight: Number.parseFloat(surfaceStyle.paddingRight),
        surfaceRadius: Number.parseFloat(surfaceStyle.borderTopLeftRadius),
        surfaceRightInset: dockBox.right - surfaceBox.right,
        // The editor scroll viewport is full-bleed to the surface edges so its native
        // overflow scrollbar hugs the panel edge (like .agent-chat-scroll), not floating
        // a surface-pad inside it; the text column is re-inset by the editor's own padding.
        editorLeftToSurface: editorBox ? editorBox.left - surfaceBox.left : null,
        editorRightToSurface: editorBox ? surfaceBox.right - editorBox.right : null,
        editorTextLeftInset: editorTextBox ? editorTextBox.left - surfaceBox.left : null,
        editorTextRightInset: editorTextBox ? surfaceBox.right - editorTextBox.right : null,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.composerBottomDelta).toBeLessThanOrEqual(1);
    expect(metrics!.composerPaddingBottom).toBe(0);
    expect(metrics!.composerPaddingLeft).toBe(0);
    expect(metrics!.composerPaddingRight).toBe(0);
    // The floating rails (#57) each own their inset, so the dock no longer borrows the
    // sidebar's padding. The agent content shares one horizontal inset instead: the
    // header and transcript scroll left-align and the scroll is symmetric. (The header's
    // right inset is larger to clear the agent collapse toggle.)
    expect(metrics!.headerPaddingLeft).toBe(metrics!.scrollPaddingLeft);
    expect(metrics!.scrollPaddingLeft).toBe(metrics!.scrollPaddingRight);
    expect(metrics!.headerPaddingRight).toBeGreaterThanOrEqual(metrics!.scrollPaddingRight);
    // The composer is flush to the dock floor (its input REGION, not a floating card):
    // its surface bottom meets the dock's inner bottom, no rail-pad gap.
    expect(metrics!.surfaceBottomToPanelBottom).toBeLessThanOrEqual(1);
    expect(metrics!.surfacePaddingLeft).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.surfacePaddingBottom).toBe(metrics!.surfacePaddingRight);
    // The flush composer's rounded TOP corners use the dock's own --panel-radius so
    // they match the dock's bottom corners (which clip the composer's flush bottom) —
    // one consistent curvature edge-to-edge.
    expect(metrics!.surfaceRadius).toBe(metrics!.expectedSurfaceRadius);
    // The footer controls are fully-rounded capsules (B6), NOT on the concentric
    // container chain that gives the surface its radius: --radius-pill makes each
    // square icon button a circle and the wide model button a stadium, so every
    // 28px-tall control shows the same corner arc (>= half its own height) and they
    // line up. (Asserting >= half-height is robust to the browser returning either
    // the specified --radius-pill length or its box-clamped used value.)
    expect(metrics!.actionRadius!).toBeGreaterThanOrEqual(metrics!.actionSize! / 2);
    expect(metrics!.attachmentRadius!).toBeGreaterThanOrEqual(metrics!.attachmentSize! / 2);
    expect(metrics!.modelRadius!).toBeGreaterThanOrEqual(metrics!.modelHeight! / 2);
    expect(metrics!.actionSize).toBe(metrics!.attachmentSize);
    expect(Math.abs(metrics!.attachmentLeftInset! - metrics!.surfacePaddingLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentBottomInset! - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset! - metrics!.surfacePaddingRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionBottomInset! - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentLeftInset! - metrics!.attachmentBottomInset!)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset! - metrics!.actionBottomInset!)).toBeLessThanOrEqual(1);
    // The composer surface is full-bleed to the dock's side edges (a flush input
    // region, not an inset card); the dock's --panel-radius + overflow:hidden round
    // its bottom corners.
    expect(metrics!.surfaceLeftInset).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceRightInset).toBeLessThanOrEqual(1);
    // The editor's scroll viewport reaches both surface edges, so its native overflow
    // scrollbar sits at the panel edge (B10) like the transcript scroll — not floating a
    // surface-pad inside it — while its own padding keeps the text on the shared column.
    expect(metrics!.editorLeftToSurface!).toBeLessThanOrEqual(1);
    expect(metrics!.editorRightToSurface!).toBeLessThanOrEqual(1);
    expect(metrics!.editorTextLeftInset!).toBe(metrics!.editorTextRightInset!);
    expect(metrics!.editorTextLeftInset!).toBeGreaterThanOrEqual(metrics!.surfacePaddingLeft);
  });

  test('conversation menu stays anchored inside narrow agent surfaces', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 620 });

    await page.getByRole('button', { name: 'Show channels' }).click();
    const menu = page.getByRole('dialog', { name: 'Channels' });
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
      const titleStack = header.querySelector('.agent-dock-title-stack');
      const avatar = header.querySelector('.agent-identity-avatar');
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
      const titleStackBox = titleStack instanceof HTMLElement ? titleStack.getBoundingClientRect() : titleBox;
      const avatarBox = avatar instanceof HTMLElement ? avatar.getBoundingClientRect() : null;
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
        buttonExtraWidth: titleButtonBox.width - titleStackBox.width - (avatarBox?.width ?? 0) - chevronBox.width,
        buttonPaddingLeft: Number.parseFloat(titleStyle.paddingLeft),
        chevronOpacity: getComputedStyle(chevron).opacity,
        gapToActions: actionsBox.left - titleButtonBox.right,
        identityAvatarCount: header.querySelectorAll('.agent-identity-avatar').length,
        textFaint: computedTokenColor(rootStyle.getPropertyValue('--text-faint').trim()),
        textSecondary: computedTokenColor(rootStyle.getPropertyValue('--text-secondary').trim()),
        textSoft: computedTokenColor(rootStyle.getPropertyValue('--text-soft').trim()),
        textStrong: computedTokenColor(rootStyle.getPropertyValue('--text-strong').trim()),
        titleColor: getComputedStyle(title).color,
        titleText: title.textContent?.trim() ?? '',
        statusDotCount: header.querySelectorAll('.agent-status-dot').length,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.statusDotCount).toBe(0);
    expect(metrics!.identityAvatarCount).toBe(1);
    expect(metrics!.titleText.startsWith('#')).toBe(false);
    expect(metrics!.buttonBackground).toBe('rgba(0, 0, 0, 0)');
    expect(metrics!.titleColor).toBe(metrics!.textSoft);
    // Header action icons (+ / bug) share the window-chrome rail toggles' ink
    // (--text-secondary, 0.55), NOT the fainter --text-faint (0.30): at 0.30 the thin SVG
    // strokes read as blurry low-contrast edges on the dark rail; 0.55 resolves them crisp.
    expect(metrics!.actionColor).toBe(metrics!.textSecondary);
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

  test('renders node reference conversation titles without node ids', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: '[[node:你好^abcd7362-b2e4-498d-a1b2]] 你好',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [],
    });

    await expect(page.locator('.agent-dock-title')).toHaveText('你好 你好');
    await expect(page.locator('.agent-dock-title')).not.toContainText('node:');
  });

  test('keeps conversation rename geometry stable', async ({ page }) => {
    await page.getByRole('button', { name: 'Show channels' }).click();
    const menu = page.getByRole('dialog', { name: 'Channels' });
    await expect(menu).toBeVisible();

    const row = menu.locator('.agent-conversation-row').nth(1);
    await expect(row).toBeVisible();
    const before = await row.boundingBox();
    expect(before).toBeTruthy();

    await row.hover();
    await row.getByRole('button', { name: 'Rename channel' }).click();
    await expect(row.getByLabel('Channel name')).toBeVisible();

    const after = await row.boundingBox();
    expect(after).toBeTruthy();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  });

  test('switches the primary action between stop and steer while streaming', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Agent System',
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
      return calls.some((call) => call.cmd === 'agent_stop_conversation');
    }).toBe(true);

    await page.getByLabel('Agent message').fill('Compare tag layout stability.');
    await page.getByRole('button', { name: 'Steer agent' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_steer_conversation')?.args;
    }).toMatchObject({
      message: 'Compare tag layout stability.',
      conversationId: 'mock-agent-conversation',
    });
    await expect(page.getByText('Compare tag layout stability.')).toBeVisible();
  });

  test('opens child run details and expands nested tool calls', async ({ page }) => {
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

    await emitAgentProjection(page, 'mock-agent-conversation', {
      conversationTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        {
          nodeId: 'agent-user-child-run',
          message: {
            role: 'user',
            timestamp: 1_800_000_000_500,
            content: [{ type: 'text', text: 'Use a child run to inspect the UI.' }],
          },
          branches: null,
        },
        {
          nodeId: 'agent-assistant-child-run',
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
                description: 'Inspect child run UI',
                prompt: 'Inspect the current UI.',
              },
            }],
          },
          branches: null,
        },
      ],
      childRuns: [{
        id: 'child-run-1',
        description: 'Inspect child run UI',
        prompt: 'Inspect the current UI.',
        agentType: 'explorer',
        contextMode: 'fork',
        status: 'running',
        startedAt: 1_800_000_000_800,
        updatedAt: 1_800_000_001_200,
        parentToolCallId: 'tool-agent-1',
      }],
    });

    // A main-agent-spawned child run renders as an inline boundary in the
    // transcript (the conversation's permanent record of the run), not as a
    // tool-call block inside the assistant bubble. The bubble is suppressed.
    const boundary = page.getByRole('region', { name: 'Agent task · Inspect child run UI' });
    await expect(boundary).toBeVisible();
    await expect(boundary.getByText('Running…')).toBeVisible();
    await expect(page.getByText('Agent task · Inspect child run UI', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Open task panel' }).click();
    const tasks = page.getByRole('complementary', { name: 'Agent tasks' });
    await expect(tasks).toBeVisible();
    await expect(tasks.getByText('1 task running')).toBeVisible();
    await expect(tasks.getByText('Inspect child run UI')).toBeVisible();
    await tasks.getByRole('button', { name: 'Open task' }).click();

    const details = page.getByRole('complementary', { name: 'Agent task details' });
    await expect(details).toBeVisible();
    await expect(details.getByText('Inspect child run UI')).toBeVisible();
    await expect(page.getByText('fork · explorer')).toBeVisible();

    await expect(details).toBeVisible();
    await expect(details.getByText('Timeline (4)')).toBeVisible();
    await expect(details.getByText('Inspect the current UI.')).toBeVisible();
    await expect(details.getByText('Read node "today"')).toBeVisible();

    await details.getByText('Read node "today"').click();
    await expect(details.getByText('Daily note content from child run.')).toBeVisible();

    await details.getByLabel('Agent task follow-up').fill('Continue with layout risks.');
    await details.getByRole('button', { name: 'Send' }).click();
    await details.getByRole('button', { name: 'Stop' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.filter((call) => call.cmd === 'agent_child_run_send' || call.cmd === 'agent_child_run_stop')
        .map((call) => ({ cmd: call.cmd, args: call.args }));
    }).toEqual([
      {
        cmd: 'agent_child_run_send',
        args: {
          agentId: 'child-run-1',
          message: 'Continue with layout risks.',
          conversationId: 'mock-agent-conversation',
        },
      },
      {
        cmd: 'agent_child_run_stop',
        args: {
          agentId: 'child-run-1',
          conversationId: 'mock-agent-conversation',
        },
      },
    ]);

    await details.getByRole('button', { name: 'Close agent task details' }).click();
    await expect(details).toHaveCount(0);
    await tasks.getByRole('button', { name: 'Close task panel' }).click();
    await expect(tasks).toHaveCount(0);
  });
});
