import { expect, test, type Page } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

async function createTask(page: Page) {
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New task' });
  await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Review the repository and report important changes.');
  await sheet.getByRole('textbox', { name: 'Name', exact: true }).fill('Repository review');
  await sheet.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.scheduled-task-detail h2')).toHaveText('Repository review');
}

test.describe('Scheduled tasks workspace', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await expect(page.locator('.scheduled-workspace')).toBeVisible();
  });

  test('creates an assignment, runs while paused, reads its result and restores an archive paused', async ({ page }) => {
    await createTask(page);
    const detail = page.locator('.scheduled-task-detail');
    await detail.getByRole('button', { name: 'Pause schedule', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Resume schedule', exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(detail.getByText('The scheduled review was delivered.', { exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Resume schedule', exact: true })).toBeVisible();
    const run = (await commandCalls(page)).find((call) => call.cmd === 'automation/startNow');
    expect(run?.args.expectedRevision).toBe(2);
    await detail.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Resume schedule', exact: true })).toBeVisible();
    await expect(detail.getByText('The scheduled review was delivered.', { exact: true })).toBeVisible();
  });

  test('a local pause preserves dirty instructions and saves against the accepted revision', async ({ page }) => {
    await createTask(page);
    await page.locator('.scheduled-task-detail').getByRole('button', { name: 'Edit task', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Edit task' });
    await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Keep this unsaved instruction while pausing.');
    await sheet.getByRole('button', { name: 'Pause schedule', exact: true }).click();
    await expect(sheet.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Keep this unsaved instruction while pausing.');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    const update = (await commandCalls(page)).find((call) => call.cmd === 'automation/update');
    expect(update?.args.expectedRevision).toBe(2);
    expect(update?.args.prompt).toBe('Keep this unsaved instruction while pausing.');
    expect(update?.args).not.toHaveProperty('status');
  });

  test('dirty close requires an explicit discard and restores the opener', async ({ page }) => {
    const opener = page.getByRole('button', { name: 'New task', exact: true });
    await opener.click();
    const sheet = page.getByRole('dialog', { name: 'New task' });
    await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('A draft');
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    const discard = page.getByRole('dialog', { name: 'Discard changes?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(sheet.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('A draft');
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('supports shared date/time controls, materials and one primary location', async ({ page }) => {
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'New task' });
    await expect(sheet.getByRole('combobox', { name: 'Destination' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Add project' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Add material', exact: true }).click();
    await sheet.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('url');
    await sheet.getByRole('textbox', { name: 'Reference', exact: true }).fill('https://example.com/release-notes');
    await expect(sheet.getByRole('checkbox', { name: 'Required', exact: true })).toBeChecked();
    const repeat = sheet.getByRole('combobox', { name: 'Repeat', exact: true });
    await repeat.selectOption('once');
    await sheet.getByRole('button', { name: 'Date', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toBeVisible();
    await page.keyboard.press('Escape');
    await repeat.selectOption('daily');
    await sheet.getByRole('button', { name: 'Choose time', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Time picker' })).toBeVisible();
    await page.keyboard.press('Escape');
    await repeat.selectOption('custom');
    await sheet.getByRole('combobox', { name: 'Repeats', exact: true }).selectOption('yearly');
    await expect(sheet.getByRole('combobox', { name: 'In', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'On days', exact: true })).toBeVisible();
    await expect(sheet.getByText('/mock/workspace', { exact: true })).toBeVisible();
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keeps a narrow pane navigable in ${colorScheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1100, height: 850 });
      await createTask(page);
      const workspace = page.locator('.scheduled-workspace');
      await expect(workspace.getByRole('button', { name: 'Back to tasks', exact: true })).toBeVisible();
      await expect(workspace.getByRole('button', { name: 'Run now', exact: true })).toBeVisible();
      await workspace.getByRole('button', { name: 'Back to tasks', exact: true }).click();
      await expect(page.locator('.scheduled-task-row', { hasText: 'Repository review' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`scheduled-tasks-${colorScheme}.png`) });
      expect(await workspace.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    });
  }
});
