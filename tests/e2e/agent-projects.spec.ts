import { expect, test, type Page } from '@playwright/test';
import { commandCalls, openMockedApp, setNextThreadStartBehavior } from './outlinerMock';

async function manager(page: Page) {
  await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads', exact: true }).getByRole('button', { name: 'Projects', exact: true }).click();
  return page.getByRole('dialog', { name: 'Projects', exact: true });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Project catalog lifecycle in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    await expect(page.locator('.thread-composer')).toBeVisible();
    await expect(page.locator('.thread-project-control')).toHaveCount(0);
    let catalog = await manager(page);
    await expect(catalog.getByText('No Projects yet.')).toBeVisible();
    await catalog.getByRole('button', { name: 'New Project', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New Project', exact: true });
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Tenon');
    await form.getByRole('textbox', { name: 'Directory hint (optional)', exact: true }).fill('/Users/developer/tenon');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    catalog = page.getByRole('dialog', { name: 'Projects', exact: true });
    await expect(catalog.getByText('/Users/developer/tenon', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`projects-${theme}.png`) });
    await setNextThreadStartBehavior(page, { error: 'Project changed; inspect it again before retrying' });
    await catalog.getByRole('button', { name: 'New Chat in Project', exact: true }).click();
    await expect(catalog.getByRole('alert')).toHaveText('Project changed; inspect it again before retrying');
    await catalog.getByRole('button', { name: 'New Chat in Project', exact: true }).click();
    await expect(page.locator('.thread-project-control')).toHaveText('Tenon');
    const starts = (await commandCalls(page)).filter((call) => call.cmd === 'thread/start');
    expect(starts.at(-1)?.args).toMatchObject({ project: { expectedRevision: 1 } });
    expect(starts.at(-1)?.args).not.toHaveProperty('cwd');
    await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
    await expect(page.locator('.thread-project-heading')).toHaveText(['Tenon', 'No Project']);
    await page.keyboard.press('Escape');

    catalog = await manager(page);
    await catalog.getByRole('button', { name: 'Tenon /Users/developer/tenon', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Project', exact: true });
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Workbench');
    await editor.getByRole('textbox', { name: 'Directory hint (optional)', exact: true }).fill('/Users/developer/workbench');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    catalog = page.getByRole('dialog', { name: 'Projects', exact: true });
    await expect(catalog.getByText('Workbench', { exact: true })).toBeVisible();
    await catalog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.thread-project-control')).toHaveText('Workbench');
    await page.locator('.thread-project-control').click();
    const assignment = page.getByRole('dialog', { name: 'Move to Project', exact: true });
    await assignment.getByRole('button', { name: 'No Project', exact: true }).click();
    await expect(page.locator('.thread-project-control')).toHaveCount(0);

    catalog = await manager(page);
    await catalog.getByRole('button', { name: 'New Chat in Project', exact: true }).click();
    await expect(page.locator('.thread-project-control')).toHaveText('Workbench');
    catalog = await manager(page);
    await catalog.getByRole('button', { name: 'Delete Project', exact: true }).click();
    let confirmation = page.getByRole('dialog', { name: 'Delete Project', exact: true });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Projects', exact: true }).getByText('Workbench', { exact: true })).toBeVisible();
    await page.getByRole('dialog', { name: 'Projects', exact: true }).getByRole('button', { name: 'Delete Project', exact: true }).click();
    confirmation = page.getByRole('dialog', { name: 'Delete Project', exact: true });
    await confirmation.getByRole('button', { name: 'Delete Project', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Projects', exact: true }).getByText('No Projects yet.')).toBeVisible();
    await page.getByRole('dialog', { name: 'Projects', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.thread-project-control')).toHaveCount(0);
    expect((await commandCalls(page)).filter((call) => call.cmd === 'thread/delete')).toHaveLength(0);
  });
  test(`Automation Project selection and unavailable hints in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    const project = await page.evaluate(async () => (await window.lin.agentCoreRequest('project/manage', {
      operation: 'create', name: 'Scheduled workspace', rootHint: '/Users/developer/scheduled',
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
    await expect(detail.getByRole('combobox', { name: 'Projects', exact: true }).locator('option:checked')).toHaveText('Unavailable Project');
    await expect(detail.getByRole('textbox', { name: 'Project 1 path', exact: true })).toHaveCount(0);
    await detail.getByRole('combobox', { name: 'Projects', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`automation-project-${theme}.png`) });
    await detail.getByRole('combobox', { name: 'Projects', exact: true }).selectOption('');
    await expect(detail.getByRole('textbox', { name: 'Project 1 path', exact: true })).toHaveValue('');
  });

}
