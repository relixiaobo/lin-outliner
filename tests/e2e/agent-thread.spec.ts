import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

test.describe('canonical agent Thread surface', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('creates an empty Thread and renders canonical Turn Items', async ({ page }) => {
    await expect(page.getByText('Start a Thread to work with the agent.')).toBeVisible();

    await page.getByRole('button', { name: 'New Thread' }).last().click();
    await expect(page.locator('.thread-dock-title')).toContainText('Untitled Thread');

    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Summarize current outline.');
    await page.getByRole('button', { name: 'Send' }).click();

    const turn = page.locator('.thread-turn').first();
    await expect(turn.locator('.thread-user-message')).toContainText('Summarize current outline.');
    await expect(turn.locator('.thread-agent-message')).toContainText('Current outline focuses on design-system work.');
    await expect(turn.locator('.thread-turn-footer')).toContainText('24 ms');

    await page.locator('.thread-dock-header').getByRole('button', { name: 'Thread actions' }).click();
    await page.locator('.thread-header-menu').getByRole('button', { name: 'Thread Details' }).click();
    const details = page.getByRole('dialog', { name: 'Thread Details' });
    await expect(details).toContainText('Thread ID');
    await expect(details).toContainText('Turn');
    await expect(details).toContainText('Item');
    await expect(details).toContainText('userMessage');
    await expect(details).toContainText('agentMessage');
    const canonicalIds = (await details.locator('code').allTextContents())
      .filter((value) => /^019[0-9a-f]{5}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
    expect(canonicalIds).toHaveLength(4);
    expect(new Set(canonicalIds).size).toBe(4);
    await details.getByRole('button', { name: 'Close Thread Details' }).click();

    const calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).toEqual(expect.arrayContaining([
      'thread/list',
      'thread/start',
      'thread/turns/list',
      'turn/start',
      'goal/get',
    ]));
  });

  test('forks history without changing the source Thread', async ({ page }) => {
    await page.getByRole('button', { name: 'New Thread' }).last().click();
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Keep this history.');
    await page.getByRole('button', { name: 'Send' }).click();

    const turn = page.locator('.thread-turn').first();
    await turn.hover();
    await turn.getByRole('button', { name: 'Fork after Turn' }).click();

    await expect(page.locator('.thread-turn')).toHaveCount(1);
    await expect(page.locator('.thread-user-message')).toContainText('Keep this history.');
    await page.getByRole('button', { name: 'Show Threads' }).click();

    const rows = page.locator('.thread-list-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ has: page.locator('.thread-list-actions') })).toHaveCSS('--thread-depth', '1');
    expect((await commandCalls(page)).map((call) => call.cmd)).toContain('thread/fork');
  });

  test('renames and deletes a Thread through in-app dialogs', async ({ page }) => {
    await page.getByRole('button', { name: 'New Thread' }).last().click();

    await page.locator('.thread-dock-header').getByRole('button', { name: 'Thread actions' }).click();
    await page.locator('.thread-header-menu').getByRole('button', { name: 'Rename Thread' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename Thread' });
    await renameDialog.getByRole('textbox', { name: 'Rename Thread' }).fill('Research notes');
    await renameDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.thread-dock-title')).toContainText('Research notes');

    await page.locator('.thread-dock-header').getByRole('button', { name: 'Thread actions' }).click();
    await page.locator('.thread-header-menu').getByRole('button', { name: 'Delete Thread' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete Thread' });
    await expect(deleteDialog).toContainText('Research notes');
    await deleteDialog.getByRole('button', { name: 'Delete Thread' }).click();

    await expect(page.getByText('Start a Thread to work with the agent.')).toBeVisible();
    const calls = (await commandCalls(page)).map((call) => call.cmd);
    expect(calls).toEqual(expect.arrayContaining(['thread/name/set', 'thread/delete']));
  });
});
