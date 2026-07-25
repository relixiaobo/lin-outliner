import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

test.describe('Automation surface', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .getByRole('button', { name: 'Open Automations' })
      .click();
  });

  test('creates, pauses, resumes, starts, opens, and deletes an Automation', async ({ page }) => {
    await expect(page.locator('.thread-dock-title')).toHaveText('Automations');
    await expect(page.getByText('No Automations yet.')).toBeVisible();

    await page.getByRole('button', { name: 'New Automation' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Daily repository review');
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Review the repository and summarize important changes.');
    await page.getByRole('button', { name: 'Create Automation' }).click();

    await expect(page.locator('.automation-subview-header')).toContainText('Daily repository review');
    await expect(page.locator('.automation-detail-metadata')).toContainText('New Thread');
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Review the repository and summarize verified changes.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.automation-subview-header')).toContainText('Daily repository review');
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

    await page.getByRole('button', { name: 'Start now' }).click();
    const run = page.locator('.automation-run').first();
    await expect(run).toContainText('Started');
    await run.getByRole('button', { name: 'Open Thread' }).click();

    await expect(page.locator('.thread-dock-title')).toHaveText('Daily repository review');
    await expect(page.locator('.thread-user-message')).toContainText('summarize verified changes');
    await expect(page.locator('.thread-agent-message')).toContainText('Automation completed');
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .getByRole('button', { name: 'Open Automations' })
      .click();
    await page.locator('.automation-list-row', { hasText: 'Daily repository review' }).click();
    await page.getByRole('button', { name: 'Delete Automation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Automation' });
    await expect(dialog).toContainText('Future occurrences will stop.');
    await dialog.getByRole('button', { name: 'Delete Automation' }).click();
    await expect(page.getByText('No Automations yet.')).toBeVisible();

    expect((await commandCalls(page)).map((call) => call.cmd)).toEqual(expect.arrayContaining([
      'automation/list',
      'automation/runs',
      'automation/create',
      'automation/update',
      'automation/pause',
      'automation/resume',
      'automation/startNow',
      'automation/runMarkRead',
      'automation/delete',
    ]));
  });
});
