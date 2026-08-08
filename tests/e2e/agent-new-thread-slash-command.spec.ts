import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  commandCalls,
  ids,
  openMockedApp,
  rowBody,
  setNextThreadStartBehavior,
} from './outlinerMock';

async function callCount(page: Page, command: string): Promise<number> {
  return (await commandCalls(page)).filter((call) => call.cmd === command).length;
}

test.describe('new Thread composer slash command', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('discovers /new, inserts it without executing, then creates one empty Thread', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    const initialThreadStarts = await callCount(page, 'thread/start');
    await composer.fill('/');

    const menu = page.getByRole('listbox', { name: 'Thread slash commands' });
    await expect(menu.getByRole('option').first()).toContainText('/compact');
    const option = menu.getByRole('option', { name: /^\/new Start a new Thread$/ });
    await expect(option).toContainText('Start a new Thread');
    await option.click();

    await expect(composer).toHaveText('/new');
    await expect(composer).toBeFocused();
    await expect(menu).toHaveCount(0);
    expect(await callCount(page, 'thread/start')).toBe(initialThreadStarts);

    await composer.press('Enter');

    await expect.poll(() => callCount(page, 'thread/start')).toBe(initialThreadStarts + 1);
    expect(await callCount(page, 'turn/start')).toBe(0);
    await expect(composer).toHaveText('');
    await expect(composer).toBeFocused();
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await expect(page.locator('.thread-list-row')).toHaveCount(2);
  });

  test('preserves structured /new content until the reference is removed and retried', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    const initialThreadStarts = await callCount(page, 'thread/start');
    await composer.fill('/new');
    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send to Agent' }).click();
    await expect(page.locator('.thread-composer-inline-ref')).toContainText('Alpha');

    await page.getByRole('button', { name: 'New Thread' }).click();

    await expect(page.locator('.thread-composer-main .thread-inline-error')).toContainText(
      'Remove attachments and references before starting a new Thread.',
    );
    await expect(composer).toContainText('/new');
    await expect(page.locator('.thread-composer-inline-ref')).toContainText('Alpha');
    expect(await callCount(page, 'thread/start')).toBe(initialThreadStarts);
    expect(await callCount(page, 'turn/start')).toBe(0);

    await composer.press('End');
    await composer.press('Backspace');
    await composer.press('Backspace');
    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(0);
    await expect(page.locator('.thread-composer-main .thread-inline-error')).toHaveCount(0);
    await composer.press('Enter');
    await expect.poll(() => callCount(page, 'thread/start')).toBe(initialThreadStarts + 1);
    expect(await callCount(page, 'turn/start')).toBe(0);
  });

  test('uses menu completion for casing variants and keeps additional text on the ordinary Turn path', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    const initialThreadStarts = await callCount(page, 'thread/start');

    await composer.fill('/New');
    const menu = page.getByRole('listbox', { name: 'Thread slash commands' });
    await expect(menu.getByRole('option').first()).toContainText('/new');
    await composer.press('Enter');
    await expect(composer).toHaveText('/new');
    await expect(menu).toHaveCount(0);
    expect(await callCount(page, 'turn/start')).toBe(0);
    expect(await callCount(page, 'thread/start')).toBe(initialThreadStarts);

    await composer.fill('/new project');
    await composer.press('Enter');
    await expect.poll(() => callCount(page, 'turn/start')).toBe(1);

    expect(await callCount(page, 'thread/start')).toBe(initialThreadStarts);
  });

  test('submits an exact no-argument runtime command on the first Enter', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('/clear');

    await expect(page.getByRole('listbox', { name: 'Thread slash commands' })).toHaveCount(0);
    await composer.press('Enter');

    await expect.poll(() => callCount(page, 'turn/start')).toBe(1);
    const turnStart = (await commandCalls(page)).find((call) => call.cmd === 'turn/start');
    expect(turnStart?.args.input).toEqual([{ type: 'text', text: '/clear' }]);
  });

  test('uses any usable provider for /new instead of the selected Thread send gate', async ({ page }) => {
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: {
          invoke: <T>(command: string, input?: Record<string, unknown>) => Promise<T>;
          notifySettingsChanged?: () => Promise<void>;
        };
      };
      await target.lin?.invoke('agent_set_provider_api_key', {
        providerId: 'anthropic',
        apiKey: 'sk-anthropic-saved',
      });
      await target.lin?.invoke('agent_set_active_provider', { providerId: 'anthropic' });
      await target.lin?.invoke('agent_delete_provider_config', { providerId: 'openai' });
      await target.lin?.notifySettingsChanged?.();
    });

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Current Thread cannot send this.');
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute('title', 'Configure an AI provider before starting a Thread.');
    await composer.fill('/new');
    const action = page.getByRole('button', { name: 'New Thread' });
    await expect(action).toBeEnabled();
    const initialThreadStarts = await callCount(page, 'thread/start');
    await action.click();
    await expect.poll(() => callCount(page, 'thread/start')).toBe(initialThreadStarts + 1);
  });

  test('keeps exact /new behind the Thread creation provider gate', async ({ page }) => {
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: {
          invoke: <T>(command: string, input?: Record<string, unknown>) => Promise<T>;
          notifySettingsChanged?: () => Promise<void>;
        };
      };
      await target.lin?.invoke('agent_delete_provider_config', { providerId: 'openai' });
      await target.lin?.notifySettingsChanged?.();
    });

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('/new');
    const action = page.getByRole('button', { name: 'New Thread' });
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute('title', 'Configure an AI provider before starting a Thread.');
    const initialThreadStarts = await callCount(page, 'thread/start');
    await composer.press('Enter');
    expect(await callCount(page, 'thread/start')).toBe(initialThreadStarts);
    await expect(composer).toHaveText('/new');
    await expect(page.locator('.thread-composer-main .thread-inline-error')).toContainText(
      'Configure an AI provider before starting a Thread.',
    );
  });

  test('keeps /new and the selected Thread when creation fails', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    const initialThreadStarts = await callCount(page, 'thread/start');
    await setNextThreadStartBehavior(page, { error: 'Mock Thread creation failed' });
    await composer.fill('/new');
    await composer.press('Enter');

    await expect(page.getByRole('alert')).toContainText('Mock Thread creation failed');
    await expect(composer).toHaveText('/new');
    await expect(composer).toBeFocused();
    expect(await callCount(page, 'thread/start')).toBe(initialThreadStarts + 1);
    expect(await callCount(page, 'turn/start')).toBe(0);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await expect(page.locator('.thread-list-row')).toHaveCount(1);
  });

  test('deduplicates repeated submission while Thread creation is pending', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    const initialThreadStarts = await callCount(page, 'thread/start');
    await setNextThreadStartBehavior(page, { delayMs: 400 });
    await composer.fill('/new');
    await composer.press('Enter');
    await page.keyboard.press('Enter');

    await expect.poll(() => callCount(page, 'thread/start')).toBe(initialThreadStarts + 1);
    await expect(composer).toHaveAttribute('aria-disabled', 'true');
    await expect(composer).toHaveText('/new');
    await expect.poll(() => callCount(page, 'thread/start')).toBe(initialThreadStarts + 1);
    await expect(composer).toHaveText('');
    await expect(composer).toBeFocused();
  });
});

test('leaves an active prior Turn running and marks its root as background work', async ({ page }) => {
  await openMockedApp(page, { agentTurnStaysActive: true });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Keep working in the background.');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Interrupt Turn' })).toBeVisible();

  await composer.fill('/new');
  await expect(page.getByRole('button', { name: 'New Thread' })).toBeEnabled();
  await composer.press('Enter');
  await expect(composer).toHaveText('');
  await expect(composer).toBeFocused();

  await page.getByRole('button', { name: 'Show Threads' }).click();
  const priorThread = page.locator('.thread-list-row').filter({ hasText: 'Keep working in the background.' });
  await expect(priorThread.getByRole('img', { name: 'Background work running' })).toBeVisible();
  const calls = await commandCalls(page);
  expect(calls.filter((call) => call.cmd === 'turn/start')).toHaveLength(1);
  expect(calls.filter((call) => call.cmd === 'turn/steer')).toHaveLength(0);
  expect(calls.filter((call) => call.cmd === 'turn/interrupt')).toHaveLength(0);
});

test('does not label a prior Thread waiting on the user as background work', async ({ page }) => {
  await openMockedApp(page, { agentTurnStaysActive: true });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Wait for my input.');
  await composer.press('Enter');
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'thread/status/changed',
      threadId,
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    });
  });

  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('button', { name: 'New Thread' }).click();
  await page.getByRole('button', { name: 'Show Threads' }).click();

  const priorThread = page.locator('.thread-list-row').filter({ hasText: 'Wait for my input.' });
  await expect(priorThread).toHaveCount(1);
  await expect(priorThread.getByRole('img', { name: 'Background work running' })).toHaveCount(0);
});
