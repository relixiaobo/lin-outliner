import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

test.describe('Automation surface', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Open Automations' }).click();
  });

  test('creates, pauses, resumes, starts, opens, and deletes an Automation', async ({ page }) => {
    await expect(page.locator('.thread-dock-title')).toHaveText('Automations');
    await expect(page.getByText('No Automations yet.')).toBeVisible();

    await page.locator('.automations-toolbar').getByRole('button', { name: 'New Automation' }).click();
    const createDrawer = page.getByRole('dialog', { name: 'New Automation' });
    await expect(createDrawer).toBeVisible();
    await page.getByRole('textbox', { name: 'Name' }).fill('Daily repository review');
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Review the repository and summarize important changes.');
    await page.getByRole('button', { name: 'Create Automation' }).click();

    const detailDrawer = page.getByRole('dialog', { name: 'Daily repository review' });
    await expect(detailDrawer).toBeVisible();
    await expect(page.locator('.automation-list-row', { hasText: 'Daily repository review' })).toBeVisible();
    await expect(detailDrawer.getByRole('combobox', { name: 'Runs in' })).toHaveValue('standalone');
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Review the repository and summarize verified changes.');
    await expect(page.getByRole('button', { name: 'Start now' })).toBeDisabled();
    await page.getByText('Advanced capabilities', { exact: true }).click();
    const toolsMode = page.getByRole('radiogroup', { name: 'Tools' });
    await expect(toolsMode.getByRole('radio', { name: 'Inherit' })).toBeChecked();
    await toolsMode.getByRole('radio', { name: 'None' }).click();
    await expect(page.getByRole('textbox', { name: 'Tools' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Automation actions' }).click();
    await page.getByRole('menu', { name: 'Automation actions' }).getByRole('menuitem', { name: 'Pause' }).click();
    await expect(detailDrawer).toContainText('Paused');
    await page.getByRole('button', { name: 'Automation actions' }).click();
    await page.getByRole('menu', { name: 'Automation actions' }).getByRole('menuitem', { name: 'Resume' }).click();
    await expect(detailDrawer).toContainText('Active');
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Review the repository and summarize verified changes after resuming.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Start now' }).click();
    const run = page.locator('.automation-run').first();
    await expect(run).toContainText('Started');
    await run.getByRole('button', { name: /Daily repository review/ }).click();

    await expect(page.locator('.thread-dock-title')).toHaveText('Daily repository review');
    await expect(page.locator('.thread-user-message')).toContainText('verified changes after resuming');
    await expect(page.locator('.thread-agent-message')).toContainText('Automation completed');
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Show Threads' }).click();
    await expect(page.getByRole('dialog', { name: 'Threads' })
      .getByRole('button', { name: 'Open Automations' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Open Automations' }).click();
    await page.locator('.automation-list-row', { hasText: 'Daily repository review' }).click();
    await page.getByRole('button', { name: 'Automation actions' }).click();
    await page.getByRole('menu', { name: 'Automation actions' }).getByRole('menuitem', { name: 'Delete Automation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Automation' });
    await expect(dialog).toContainText('Future occurrences will stop.');
    await dialog.getByRole('button', { name: 'Delete Automation' }).click();
    await expect(page.getByText('No Automations yet.')).toBeVisible();

    const calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).toEqual(expect.arrayContaining([
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
    expect(calls.find((call) => call.cmd === 'automation/update')?.args.configuration)
      .toMatchObject({ tools: [] });
  });

  test('confirms before closing a dirty drawer and remembers keyboard resizing', async ({ page }) => {
    const newAutomation = page.locator('.automations-toolbar').getByRole('button', { name: 'New Automation' });
    await newAutomation.click();
    const drawer = page.getByRole('dialog', { name: 'New Automation' });
    const handle = page.getByRole('separator', { name: 'Resize Automation details' });
    const originalHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height);
    await handle.press('ArrowDown');
    const resizedHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height);
    expect(resizedHeight).toBeLessThan(originalHeight);

    await page.getByRole('textbox', { name: 'Name' }).fill('Unsaved Automation');
    await page.getByRole('button', { name: 'Close Automation details' }).click();
    const discard = page.getByRole('dialog', { name: 'Discard changes?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(drawer).toBeVisible();
    await page.getByRole('button', { name: 'Close Automation details' }).click();
    await discard.getByRole('button', { name: 'Discard changes' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(newAutomation).toBeFocused();

    await newAutomation.click();
    const restoredHeight = await page.getByRole('dialog', { name: 'New Automation' })
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(restoredHeight - resizedHeight)).toBeLessThan(2);
  });
});
