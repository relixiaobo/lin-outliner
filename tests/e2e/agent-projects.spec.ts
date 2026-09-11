import { expect, test, type Page } from '@playwright/test';
import { commandCalls, openMockedApp, setNextThreadStartBehavior } from './outlinerMock';

async function manager(page: Page) {
  await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads', exact: true }).getByRole('button', { name: 'Projects', exact: true }).click();
  return page.getByRole('dialog', { name: 'Projects', exact: true });
}
async function nextFolder(page: Page, path: string) {
  await page.evaluate((path) => { (window as unknown as { __nextProjectFolder: string }).__nextProjectFolder = path; }, path);
}
async function details(page: Page) {
  await page.locator('.thread-location-chip').click();
  return page.getByRole('dialog', { name: 'Project and work folder', exact: true });
}
for (const theme of ['light', 'dark'] as const) {
  test(`Project folders, Add menu and independent conversation defaults in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    await expect(page.locator('.thread-composer')).toBeVisible();
    await expect(page.locator('.thread-location-chip')).toHaveCount(0);
    await page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true }).click();
    const add = page.getByRole('menu', { name: 'Add', exact: true });
    await expect(add.getByRole('menuitem', { name: 'Add attachment' })).toBeVisible();
    await expect(add.getByRole('menuitem', { name: 'Choose project', exact: true })).toBeEnabled();
    await add.getByRole('menuitem', { name: 'Set work folder', exact: true }).click();
    let location = page.getByRole('dialog', { name: 'Project and work folder', exact: true });
    await expect(location.getByText('/Users/developer', { exact: true })).toBeVisible();
    await nextFolder(page, '/Users/developer/worktree');
    await location.getByRole('button', { name: 'Set work folder', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('worktree');
    await location.getByRole('button', { name: 'Close', exact: true }).click();

    let catalog = await manager(page);
    await catalog.getByRole('button', { name: 'New Project', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New Project', exact: true });
    await nextFolder(page, '/Users/developer/tenon');
    await form.getByRole('button', { name: 'Add folder', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('tenon');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Tenon');
    await nextFolder(page, '/Users/developer/reference');
    await form.getByRole('button', { name: 'Add folder', exact: true }).click();
    await expect(form.getByText('/Users/developer/reference', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    catalog = page.getByRole('dialog', { name: 'Projects', exact: true });
    await setNextThreadStartBehavior(page, { error: 'Project changed; inspect it again before retrying' });
    await catalog.getByRole('button', { name: 'New Chat in Project', exact: true }).click();
    await expect(catalog.getByRole('alert')).toHaveText('Project changed; inspect it again before retrying');
    await catalog.getByRole('button', { name: 'New Chat in Project', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('Tenon');
    location = await details(page);
    await expect(location.getByText('/Users/developer/reference', { exact: true })).toBeVisible();
    await location.getByRole('button', { name: 'Clear work folder', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('Tenon · Application default');
    await expect(location.getByText('/Users/developer', { exact: true })).toBeVisible();
    await location.getByRole('button', { name: 'Close', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`composer-${theme}.png`) });
    await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
    await expect(page.locator('.thread-list-select').getByText(/Tenon · Application default/)).toBeVisible();
    await page.keyboard.press('Escape');
    location = await details(page);
    await location.getByRole('button', { name: 'Choose project', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose project', exact: true });
    await picker.getByRole('button', { name: 'No Project', exact: true }).click();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveCount(0);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'thread/delete')).toHaveLength(0);
  });

  test(`membership-only selection, unavailable saved paths and keyboard Add in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    const project = await page.evaluate(async () => (await window.lin.agentCoreRequest('project/manage', {
      operation: 'create', name: 'A long Project name for narrow composition', folders: ['/one/repo', '/two/references'], primaryFolder: '/one/repo',
    })).project!);
    const add = page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true });
    await add.focus(); await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Choose project', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose project', exact: true });
    await picker.getByRole('textbox', { name: 'Search projects' }).fill('long');
    await picker.getByRole('button', { name: /A long Project name/ }).click();
    await expect(picker.getByRole('checkbox')).not.toBeChecked();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText(`${project.name} · Application default`);
    let location = await details(page);
    await nextFolder(page, '/one/worktree');
    await location.getByRole('button', { name: 'Set work folder', exact: true }).click();
    await location.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => {
      (window as unknown as { __unavailableProjectFolders: string[] }).__unavailableProjectFolders = ['/one/worktree'];
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('.thread-location-chip').getByRole('img', { name: 'Unavailable' })).toBeVisible();
    await expect(page.locator('.thread-location-chip')).toHaveAttribute('title', /Unavailable/);
    const box = await page.locator('.thread-composer').boundingBox();
    expect(box).not.toBeNull();
    await page.screenshot({ path: testInfo.outputPath(`location-${theme}.png`) });
    location = await details(page);
    await expect(location.getByText('/one/worktree', { exact: true })).toBeVisible();
    await location.getByRole('button', { name: 'Clear work folder', exact: true }).click();
    await location.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText(`${project.name} · Application default`);
    await page.locator('.app').evaluate((element) => (element as HTMLElement).style.setProperty('--agent-width', '280px'));
    await page.locator('.thread-composer').screenshot({ path: testInfo.outputPath(`narrow-${theme}.png`) });
    const geometry = await page.locator('.thread-composer-toolbar').evaluate((toolbar) => {
      const box = toolbar.getBoundingClientRect();
      return Object.fromEntries(['.thread-location-folder', '.thread-location-project', '.thread-composer-model-name', '.thread-composer-reasoning-chip', '.icon-button-composerAction']
        .map((selector) => {
          const node = toolbar.querySelector(selector) as HTMLElement;
          const rect = node.getBoundingClientRect();
          return [selector, { width: rect.width, left: rect.left, right: rect.right, clipped: node.scrollWidth > node.clientWidth, inside: rect.left >= box.left && rect.right <= box.right + 1 }];
        }));
    });
    expect(geometry['.thread-location-folder'], JSON.stringify(geometry)).toMatchObject({ clipped: false, inside: true });
    expect(geometry['.thread-composer-model-name'].width, JSON.stringify(geometry)).toBeGreaterThan(20);
    expect(geometry['.thread-composer-reasoning-chip']).toMatchObject({ clipped: false, inside: true });
    expect(geometry['.icon-button-composerAction']).toMatchObject({ width: 28, inside: true });
    expect(geometry['.thread-location-folder'].right).toBeLessThanOrEqual(geometry['.thread-composer-model-name'].left);
    expect(geometry['.thread-composer-model-name'].right).toBeLessThanOrEqual(geometry['.thread-composer-reasoning-chip'].left);
    expect(geometry['.thread-composer-reasoning-chip'].right).toBeLessThanOrEqual(geometry['.icon-button-composerAction'].left);
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
