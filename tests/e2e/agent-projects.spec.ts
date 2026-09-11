import { expect, test, type Page } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

async function nextFolder(page: Page, path: string) {
  await page.evaluate((path) => { (window as unknown as { __nextProjectFolder: string }).__nextProjectFolder = path; }, path);
}
async function projectMenu(page: Page) {
  await page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true }).click();
  const add = page.getByRole('menu', { name: 'Add', exact: true });
  await add.getByRole('menuitem', { name: 'Project', exact: true }).hover();
  return page.getByRole('menu', { name: 'Choose project', exact: true });
}
for (const theme of ['light', 'dark'] as const) {
  test(`Project flyout creates, selects and remembers projects in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    await page.evaluate(() => localStorage.removeItem('tenon.recent-projects.v1'));
    await page.locator('.app').evaluate((element) => (element as HTMLElement).style.setProperty('--agent-width', '560px'));
    await expect(page.locator('.thread-location-chip')).toHaveCount(0);
    let flyout = await projectMenu(page);
    await expect(page.getByRole('menuitem', { name: 'Set work folder', exact: true })).toHaveCount(0);
    const add = page.getByRole('menu', { name: 'Add', exact: true });
    await expect(add.getByRole('menuitem', { name: 'Add attachment' })).toBeVisible();
    const anchorBox = (await page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true }).boundingBox())!;
    const addBox = (await add.boundingBox())!, flyoutBox = (await flyout.boundingBox())!;
    expect(Math.abs(addBox.x - anchorBox.x)).toBeLessThan(2);
    expect(addBox.y + addBox.height).toBeLessThanOrEqual(anchorBox.y);
    expect(flyoutBox.x).toBeGreaterThanOrEqual(addBox.x + addBox.width);
    await flyout.getByRole('menuitem', { name: 'New Project', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New Project', exact: true });
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
    await nextFolder(page, '/Users/developer/tenon');
    await form.getByRole('button', { name: 'Add folder', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('tenon');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Tenon');
    await nextFolder(page, '/Users/developer/reference');
    await form.getByRole('button', { name: 'Add folder', exact: true }).click();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('Tenon');
    await expect(form).toHaveCount(0);
    await page.locator('.thread-location-chip').click();
    const details = page.getByRole('dialog', { name: 'Project details', exact: true });
    await expect(details.getByText('/Users/developer/reference', { exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Set work folder', exact: true })).toHaveCount(0);
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    flyout = await projectMenu(page);
    await expect(flyout.getByRole('menuitemradio', { name: 'Tenon', exact: true })).toHaveAttribute('aria-checked', 'true');
    await flyout.getByRole('menuitemradio', { name: 'Tenon', exact: true }).hover();
    await expect(flyout).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`project-flyout-${theme}.png`) });
    await flyout.getByRole('menuitemradio', { name: 'No Project', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveCount(0);
    flyout = await projectMenu(page);
    await flyout.getByRole('menuitemradio', { name: 'Tenon', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('Tenon');
    expect((await commandCalls(page)).filter((call) => call.cmd === 'project/manage' && call.args.operation === 'create')).toHaveLength(1);
  });

  test(`Project keyboard navigation, primary edits and narrow layout in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    const project = await page.evaluate(async () => (await window.lin.agentCoreRequest('project/manage', {
      operation: 'create', name: 'A long Project name for narrow composition', folders: ['/one/repo', '/two/references'], primaryFolder: '/one/repo',
    })).project!);
    const add = page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true });
    await add.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Add attachment', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
    const flyout = page.getByRole('menu', { name: 'Choose project', exact: true });
    await expect(flyout.getByRole('menuitemradio', { name: 'No Project', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('menuitem', { name: 'Project', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await flyout.getByRole('menuitem', { name: 'All Projects…', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose project', exact: true });
    await picker.getByRole('textbox', { name: 'Search projects' }).fill('long');
    await picker.getByRole('button', { name: /A long Project name/ }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.locator('.thread-location-chip')).toHaveText(project.name);
    await page.evaluate(async (project) => {
      await window.lin.agentCoreRequest('project/manage', { operation: 'update', projectId: project.id, expectedRevision: 1,
        name: project.name, folders: project.folders, primaryFolder: '/two/references' });
      (window as unknown as { __unavailableProjectFolders: string[] }).__unavailableProjectFolders = ['/two/references'];
      window.dispatchEvent(new Event('focus'));
    }, project);
    await expect(page.locator('.thread-location-chip')).toHaveAttribute('title', /\/two\/references/);
    await expect(page.locator('.thread-location-chip').getByRole('img', { name: 'Unavailable' })).toBeVisible();
    await page.locator('.app').evaluate((element) => (element as HTMLElement).style.setProperty('--agent-width', '280px'));
    await page.locator('.thread-composer').screenshot({ path: testInfo.outputPath(`narrow-${theme}.png`) });
    const geometry = await page.locator('.thread-composer-toolbar').evaluate((toolbar) => {
      const box = toolbar.getBoundingClientRect();
      return ['.thread-location-chip', '.thread-composer-model-name', '.icon-button-composerAction'].map((selector) => {
        const rect = toolbar.querySelector(selector)!.getBoundingClientRect();
        return { width: rect.width, inside: rect.left >= box.left && rect.right <= box.right + 1 };
      });
    });
    for (const entry of geometry) { expect(entry.inside, JSON.stringify(geometry)).toBe(true); expect(entry.width).toBeGreaterThan(0); }
    await projectMenu(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Add', exact: true })).toHaveCount(0);
    await expect(add).toBeFocused();
    const narrowFlyout = await projectMenu(page);
    const parentBox = (await page.getByRole('menu', { name: 'Add', exact: true }).boundingBox())!;
    const childBox = (await narrowFlyout.boundingBox())!;
    expect(childBox.x + childBox.width).toBeLessThanOrEqual(parentBox.x);
    await add.click();
    await expect(narrowFlyout).toHaveCount(0);
    await expect(add).toBeFocused();
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Automation Project selection and unavailable hints in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    const project = await page.evaluate(async () => (await window.lin.agentCoreRequest('project/manage', {
      operation: 'create', name: 'Scheduled workspace', folders: ['/Users/developer/scheduled'], primaryFolder: '/Users/developer/scheduled',
    })).project!);
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Open Automations' }).click();
    await page.locator('.automations-toolbar').getByRole('button', { name: 'New Automation' }).click();
    const editor = page.getByRole('dialog', { name: 'New Automation' });
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Project check');
    await editor.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Check the saved workspace.');
    await editor.getByRole('combobox', { name: 'Project', exact: true }).selectOption('local');
    await editor.getByRole('combobox', { name: 'Projects', exact: true }).selectOption(project.id);
    await expect(editor.getByText('/Users/developer/scheduled', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create Automation' }).click();
    const detail = page.getByRole('dialog', { name: 'Project check', exact: true });
    await expect(detail.getByRole('combobox', { name: 'Projects', exact: true })).toHaveValue(project.id);
    const create = (await commandCalls(page)).find((call) => call.cmd === 'automation/create');
    expect(create?.args.contextHints).toEqual([{ source: { kind: 'project', projectId: project.id }, executionMode: 'local' }]);
    // A missing-reference fixture exercises history rendering; the real Host's
    // active-definition deletion fence is covered by the SQLite lifecycle tests.
    await page.evaluate(async (project) => {
      await window.lin.agentCoreRequest('project/manage', { operation: 'delete', projectId: project.id, expectedRevision: project.revision });
      window.dispatchEvent(new Event('focus'));
    }, project);
    await expect(detail.getByRole('combobox', { name: 'Projects', exact: true }).locator('option:checked')).toHaveText('Unavailable');
    await expect(detail.getByRole('textbox', { name: 'Project 1 path', exact: true })).toHaveCount(0);
    await detail.getByRole('combobox', { name: 'Projects', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`automation-project-${theme}.png`) });
    await detail.getByRole('combobox', { name: 'Projects', exact: true }).selectOption('');
    await expect(detail.getByRole('textbox', { name: 'Project 1 path', exact: true })).toHaveValue('');
  });
}

test('failed selection after creation retries the saved Project and never creates a duplicate', async ({ page }) => {
  await openMockedApp(page);
  await page.evaluate(() => {
    localStorage.removeItem('tenon.recent-projects.v1');
    const request = window.lin.agentCoreRequest.bind(window.lin);
    let fail = true;
    window.lin.agentCoreRequest = (async (method: string, input: Record<string, unknown>) => {
      if (method === 'project/manage' && input.operation === 'bind' && fail) {
        fail = false;
        throw new Error('Selection interrupted');
      }
      return request(method as never, input as never);
    }) as typeof window.lin.agentCoreRequest;
  });
  const flyout = await projectMenu(page);
  await flyout.getByRole('menuitem', { name: 'New Project', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New Project', exact: true });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Created once');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose project', exact: true });
  await expect(picker.getByRole('alert')).toHaveText('Selection interrupted');
  await expect(page.locator('.thread-location-chip')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('tenon.recent-projects.v1'))).toBeNull();
  await picker.getByRole('button', { name: 'Retry selection', exact: true }).click();
  await expect(page.locator('.thread-location-chip')).toHaveText('Created once · Application default');
  const projects = await page.evaluate(() => window.lin.agentCoreRequest('project/inspect', {}));
  expect(projects.projects).toHaveLength(1);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'project/manage' && call.args.operation === 'create')).toHaveLength(1);
  const menu = await projectMenu(page);
  await menu.getByRole('menuitem', { name: 'New Project', exact: true }).click();
  await page.getByRole('dialog', { name: 'New Project', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.thread-location-chip')).toHaveText('Created once · Application default');
});
