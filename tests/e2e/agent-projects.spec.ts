import { expect, test, type Page } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

async function nextFolder(page: Page, path: string | string[]) {
  await page.evaluate((path) => { (window as unknown as { __nextProjectFolders: string[] }).__nextProjectFolders = Array.isArray(path) ? path : [path]; }, path);
}
async function projectMenu(page: Page) {
  await page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true }).click();
  const add = page.getByRole('menu', { name: 'Add', exact: true });
  await add.locator('[aria-haspopup="menu"]').hover();
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
    await expect(flyout.getByRole('textbox')).toHaveCount(0);
    await expect(flyout.getByRole('menuitemradio')).toHaveCount(0);
    await expect(flyout.getByRole('status')).toHaveCount(0);
    await expect(flyout.getByRole('separator')).toHaveCount(0);
    await expect(flyout.getByRole('menuitem')).toHaveCount(1);
    await expect(flyout.getByRole('menuitem', { name: 'New Project', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Set work folder', exact: true })).toHaveCount(0);
    const add = page.getByRole('menu', { name: 'Add', exact: true });
    await expect(add.getByRole('menuitem', { name: 'Add attachment' })).toBeVisible();
    const anchorBox = (await page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true }).boundingBox())!;
    const addBox = (await add.boundingBox())!, flyoutBox = (await flyout.boundingBox())!;
    expect(Math.abs(addBox.x - anchorBox.x)).toBeLessThan(2);
    expect(addBox.y + addBox.height).toBeLessThanOrEqual(anchorBox.y);
    expect(flyoutBox.x).toBeGreaterThanOrEqual(addBox.x + addBox.width);
    await page.screenshot({ path: testInfo.outputPath(`project-empty-${theme}.png`) });
    await flyout.getByRole('menuitem', { name: 'New Project', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Create project', exact: true });
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
    await form.screenshot({ path: testInfo.outputPath(`project-create-empty-${theme}.png`) });
    expect((await form.getByRole('button', { name: 'Add folders', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(100);
    await nextFolder(page, '/Users/developer/tenon');
    await form.getByRole('button', { name: 'Add folders', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('tenon');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Tenon');
    await nextFolder(page, '/Users/developer/reference');
    await form.getByRole('button', { name: 'Add folders', exact: true }).click();
    const folderAlignment = await form.evaluate((dialog) => {
      const folderIcon = dialog.querySelector('.project-list-row .project-icon-slot')!.getBoundingClientRect();
      const addIcon = dialog.querySelector('.project-add-folder-action .project-icon-slot')!.getBoundingClientRect();
      return { folder: folderIcon.left, add: addIcon.left };
    });
    expect(folderAlignment.add).toBe(folderAlignment.folder);
    await form.screenshot({ path: testInfo.outputPath(`project-create-folders-${theme}.png`) });
    await form.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('Tenon');
    await expect(form).toHaveCount(0);
    const chip = page.locator('.thread-location-chip');
    const folderIcon = chip.locator('.thread-location-icon > .app-icon');
    const remove = chip.getByRole('button', { name: 'Remove project from chat', exact: true });
    await page.locator('.thread-dock-header').hover();
    await page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true }).focus();
    await expect(folderIcon).toHaveCSS('opacity', '1');
    await expect(remove).toHaveCSS('opacity', '0');
    const restingBox = await chip.boundingBox();
    await page.locator('.thread-composer').screenshot({ path: testInfo.outputPath(`project-chip-rest-${theme}.png`) });
    await chip.hover();
    await expect(folderIcon).toHaveCSS('opacity', '0');
    await expect(remove).toHaveCSS('opacity', '1');
    expect(await chip.boundingBox()).toEqual(restingBox);
    await page.locator('.thread-composer').screenshot({ path: testInfo.outputPath(`project-chip-hover-${theme}.png`) });
    const hoverColor = await chip.evaluate((element) => getComputedStyle(element).backgroundColor);
    const addButton = page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true });
    await addButton.hover();
    await expect(addButton).toHaveCSS('background-color', hoverColor);
    const addSize = (await addButton.boundingBox())!;
    expect(addSize.width).toBe(addSize.height);
    await page.locator('.thread-composer').screenshot({ path: testInfo.outputPath(`composer-add-hover-${theme}.png`) });
    const modelButton = page.locator('.thread-composer-model-button');
    await modelButton.hover();
    await expect(modelButton).toHaveCSS('background-color', hoverColor);
    await page.locator('.thread-composer').screenshot({ path: testInfo.outputPath(`composer-model-hover-${theme}.png`) });
    for (const width of ['280px', '560px']) {
      await page.locator('.app').evaluate((element, width) => (element as HTMLElement).style.setProperty('--agent-width', width), width);
      await chip.hover();
      const content = await chip.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const name = element.querySelector('.thread-location-project')!.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { width: box.width, trailingGap: box.right - name.right, padding: parseFloat(style.paddingRight) };
      });
      expect(content.width).toBeLessThan(100);
      expect(content.padding).toBe(8);
      expect(content.trailingGap).toBeCloseTo(content.padding, 0);
      const controls = [addButton, chip, modelButton, page.locator('.thread-composer-toolbar .icon-button-composerAction')];
      for (const control of controls) {
        const beforeHover = (await control.boundingBox())!;
        await control.hover();
        const afterHover = (await control.boundingBox())!;
        expect(afterHover.height).toBe(28);
        expect(afterHover).toEqual(beforeHover);
        expect(afterHover.y).toBe((await addButton.boundingBox())!.y);
      }
      await modelButton.hover();
      const modelGeometry = await modelButton.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const name = element.querySelector('.thread-composer-model-name')!.getBoundingClientRect();
        const caret = element.querySelector('svg')!.getBoundingClientRect();
        return { leading: name.left - box.left, trailing: box.right - caret.right, caretWidth: caret.width, nameWidth: name.width };
      });
      expect(modelGeometry.leading).toBeGreaterThanOrEqual(8);
      expect(modelGeometry.trailing).toBeGreaterThanOrEqual(8);
      expect(modelGeometry.caretWidth).toBeGreaterThan(0);
      expect(modelGeometry.nameWidth).toBeGreaterThan(8);
      await page.locator('.thread-composer').screenshot({ path: testInfo.outputPath(`composer-model-${width}-${theme}.png`) });
    }
    await page.locator('.thread-dock-header').hover();
    await remove.focus();
    await expect(remove).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: 'Change project', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Edit Project:/ }).click();
    const details = page.getByRole('dialog', { name: 'Edit Project', exact: true });
    await expect(details.locator('.project-folder-path').filter({ hasText: '/Users/developer/reference' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Set work folder', exact: true })).toHaveCount(0);
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    flyout = await projectMenu(page);
    await expect(page.getByRole('menu', { name: 'Add', exact: true }).getByRole('menuitem', { name: 'Tenon', exact: true })).toBeVisible();
    await expect(flyout.getByRole('menuitemradio', { name: 'Tenon', exact: true })).toHaveAttribute('aria-checked', 'true');
    await flyout.getByRole('menuitemradio', { name: 'Tenon', exact: true }).hover();
    await expect(flyout).toBeVisible();
    const menuAlignment = await flyout.evaluate((menu) => {
      const search = menu.querySelector('input')!;
      const inputStyle = getComputedStyle(search);
      return {
        textStart: search.getBoundingClientRect().left + parseFloat(inputStyle.paddingLeft),
        labels: [...menu.querySelectorAll('.project-menu-label')].map((label) => label.getBoundingClientRect().left),
        icons: [...menu.querySelectorAll('.project-icon-slot')].map((icon) => ({ left: icon.getBoundingClientRect().left, width: icon.getBoundingClientRect().width })),
        heights: [...menu.querySelectorAll('.project-menu-search, .project-menu-item')].map((row) => row.getBoundingClientRect().height),
      };
    });
    for (const left of menuAlignment.labels) expect(left).toBeCloseTo(menuAlignment.textStart, 1);
    for (const icon of menuAlignment.icons) { expect(icon.width).toBe(16); expect(icon.left).toBe(menuAlignment.icons[0]!.left); }
    for (const height of menuAlignment.heights) expect(height).toBe(28);
    await page.screenshot({ path: testInfo.outputPath(`project-flyout-${theme}.png`) });
    const clearProject = flyout.getByRole('menuitem', { name: "Don't work in a project", exact: true });
    const newProject = flyout.getByRole('menuitem', { name: 'New Project', exact: true });
    expect((await clearProject.boundingBox())!.y).toBeGreaterThan((await newProject.boundingBox())!.y);
    await flyout.getByRole('textbox', { name: 'Search projects' }).fill('no matching project');
    await expect(flyout.getByRole('status')).toHaveText('No projects found.');
    await expect(clearProject).toBeVisible();
    await clearProject.click();
    await expect(page.locator('.thread-location-chip')).toHaveCount(0);
    flyout = await projectMenu(page);
    await expect(flyout.getByRole('menuitem', { name: "Don't work in a project", exact: true })).toHaveCount(0);
    await expect(page.getByRole('menu', { name: 'Add', exact: true }).getByRole('menuitem', { name: 'Choose project', exact: true })).toBeVisible();
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
    await expect(flyout.getByRole('textbox', { name: 'Search projects' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(flyout.getByRole('menuitemradio', { name: project.name, exact: true })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('menuitem', { name: 'Choose project', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const search = flyout.getByRole('textbox', { name: 'Search projects' });
    await search.fill('missing project');
    await expect(flyout.getByRole('status')).toHaveText('No projects found.');
    await expect(flyout.getByRole('menuitem', { name: 'New Project', exact: true })).toBeVisible();
    await search.fill('long');
    await page.keyboard.press('ArrowLeft');
    await expect(search).toBeFocused();
    await expect(flyout).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(flyout).toHaveCount(0);
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
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'New task', exact: true });
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Project check');
    await editor.getByRole('textbox', { name: 'Task', exact: true }).fill('Check the saved workspace.');
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Choose project', exact: true }).click();
    await page.getByRole('menuitemradio', { name: project.name, exact: true }).click();
    await expect(editor.locator('.thread-location-chip')).toContainText(project.name);
    await editor.getByRole('button', { name: 'Create task', exact: true }).click();
    await page.getByRole('dialog', { name: 'Task details', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Edit task', exact: true });
    const create = (await commandCalls(page)).find((call) => call.cmd === 'automation/create');
    expect(create?.args.contextHints).toEqual([{ source: { kind: 'project', projectId: project.id }, executionMode: 'local' }]);
    // A missing-reference fixture exercises history rendering; the real Host's
    // active-definition deletion fence is covered by the SQLite lifecycle tests.
    await page.evaluate(async (project) => {
      await window.lin.agentCoreRequest('project/manage', { operation: 'delete', projectId: project.id, expectedRevision: project.revision });
      window.dispatchEvent(new Event('focus'));
    }, project);
    await expect(detail.locator('.thread-location-chip')).toContainText('Unavailable');
    await expect(detail.getByRole('textbox', { name: 'Project 1 path', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`automation-project-${theme}.png`), animations: 'disabled' });
    await detail.getByRole('button', { name: 'Remove task project', exact: true }).click();
    await expect(detail.locator('.thread-location-chip')).toHaveCount(0);
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
  const form = page.getByRole('dialog', { name: 'Create project', exact: true });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Created once');
  await form.getByRole('button', { name: 'Create project', exact: true }).click();
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
  await page.getByRole('dialog', { name: 'Create project', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.thread-location-chip')).toHaveText('Created once · Application default');
});


test('Project flyout lists the whole catalog and keeps creation visible while scrolling', async ({ page }, testInfo) => {
  await openMockedApp(page);
  await page.evaluate(async () => {
    localStorage.removeItem('tenon.recent-projects.v1');
    for (let index = 0; index < 12; index++) {
      await window.lin.agentCoreRequest('project/manage', {
        operation: 'create', name: `Project ${String(index).padStart(2, '0')}`, folders: [], primaryFolder: null,
      });
    }
    window.dispatchEvent(new Event('focus'));
  });
  const flyout = await projectMenu(page);
  await expect(flyout.getByRole('menuitemradio')).toHaveCount(12);
  await expect(flyout.getByRole('menuitem', { name: 'All Projects…' })).toHaveCount(0);
  const create = flyout.getByRole('menuitem', { name: 'New Project', exact: true });
  const before = (await create.boundingBox())!;
  await flyout.getByRole('menuitemradio', { name: 'Project 11', exact: true }).scrollIntoViewIfNeeded();
  await expect(create).toBeVisible();
  expect((await create.boundingBox())!.y).toBe(before.y);
  await flyout.screenshot({ path: testInfo.outputPath('project-catalog-scroll.png') });
  await flyout.getByRole('textbox', { name: 'Search projects' }).fill('Project 11');
  await expect(flyout.getByRole('menuitemradio')).toHaveCount(1);
  await flyout.getByRole('menuitemradio', { name: 'Project 11', exact: true }).click();
  await expect(page.locator('.thread-location-chip')).toHaveText('Project 11 · Application default');
});


test('Project chip changes and removes membership directly, retaining selection on failure', async ({ page }, testInfo) => {
  await openMockedApp(page);
  await page.evaluate(async () => {
    for (const name of ['First', 'Second']) await window.lin.agentCoreRequest('project/manage', {
      operation: 'create', name, folders: [], primaryFolder: null,
    });
    window.dispatchEvent(new Event('focus'));
  });
  let picker = await projectMenu(page);
  await picker.getByRole('menuitemradio', { name: 'First', exact: true }).click();
  const change = page.getByRole('button', { name: 'Change project', exact: true });
  await change.click();
  picker = page.getByRole('menu', { name: 'Choose project', exact: true });
  await expect(page.getByRole('menu', { name: 'Add', exact: true })).toHaveCount(0);
  await picker.getByRole('menuitemradio', { name: 'Second', exact: true }).click();
  await expect(page.locator('.thread-location-chip')).toHaveText('Second · Application default');
  await expect(change).toBeFocused();
  const chipGeometry = await page.locator('.thread-location-chip').evaluate((chip) => {
    const name = chip.querySelector('.thread-location-project')!.getBoundingClientRect();
    const location = chip.querySelector('.thread-location-folder')!.getBoundingClientRect();
    const remove = chip.querySelector('.icon-button')!.getBoundingClientRect();
    return { nameWidth: name.width, noOverlap: remove.right <= name.left && name.right <= location.left };
  });
  expect(chipGeometry.nameWidth).toBeGreaterThan(0);
  expect(chipGeometry.noOverlap).toBe(true);
  await change.click();
  await page.screenshot({ path: testInfo.outputPath('project-chip-picker.png') });
  await page.keyboard.press('Escape');
  await expect(change).toBeFocused();
  await page.evaluate(() => {
    const request = window.lin.agentCoreRequest.bind(window.lin);
    let fail = true;
    window.lin.agentCoreRequest = (async (method: string, input: Record<string, unknown>) => {
      if (method === 'project/manage' && input.operation === 'bind' && input.projectId === null && fail) {
        fail = false; throw new Error('Removal interrupted');
      }
      return request(method as never, input as never);
    }) as typeof window.lin.agentCoreRequest;
  });
  await page.getByRole('button', { name: 'Remove project from chat', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Removal interrupted');
  await expect(page.locator('.thread-location-chip')).toHaveText('Second · Application default');
  await page.getByRole('dialog', { name: 'Remove project from chat' }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Remove project from chat', exact: true }).click();
  await expect(page.locator('.thread-location-chip')).toHaveCount(0);
  await expect(page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true })).toBeFocused();
  expect((await page.evaluate(() => window.lin.agentCoreRequest('project/inspect', {}))).projects).toHaveLength(2);
});

for (const theme of ['light', 'dark'] as const) {
  test(`Project editing and deletion stay in the composer in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    const project = await page.evaluate(async () => (await window.lin.agentCoreRequest('project/manage', {
      operation: 'create', name: 'Workspace', folders: ['/work/main', '/work/reference'], primaryFolder: '/work/main',
    })).project!);
    await (await projectMenu(page)).getByRole('menuitemradio', { name: 'Workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Show Threads', exact: true }).click();
    const threads = page.getByRole('dialog', { name: 'Threads', exact: true });
    await expect(threads.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(threads.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
    await threads.getByRole('button', { name: 'Thread actions', exact: true }).first().click();
    await expect(page.getByRole('menuitem', { name: 'Move to Project', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const change = page.getByRole('button', { name: 'Change project', exact: true });
    await change.click();
    const picker = page.getByRole('menu', { name: 'Choose project', exact: true });
    await expect(picker.getByRole('menuitem', { name: 'Project details', exact: true })).toHaveCount(0);
    await picker.getByRole('menuitem', { name: /^Edit Project:/ }).click();
    const form = page.getByRole('dialog', { name: 'Edit Project', exact: true });
    const name = form.getByRole('textbox', { name: 'Name', exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Workspace');
    await expect(form.getByRole('button', { name: 'Primary', exact: true })).toHaveCount(0);
    const rows = form.locator('.project-list-row');
    const secondary = rows.filter({ hasText: '/work/reference' });
    const makePrimary = secondary.getByRole('button', { name: 'Make primary', exact: true });
    await expect(makePrimary).toHaveCSS('opacity', '0');
    const beforeHover = await secondary.boundingBox();
    await secondary.hover();
    await expect(makePrimary).toHaveCSS('opacity', '1');
    expect(await secondary.boundingBox()).toEqual(beforeHover);
    await name.hover();
    await makePrimary.focus();
    await expect(makePrimary).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await rows.filter({ hasText: '/work/reference' }).getByRole('button', { name: 'Remove folder', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(form.getByText('Choose a replacement primary folder before saving.', { exact: true })).toBeVisible();
    await rows.filter({ hasText: '/work/main' }).getByRole('button', { name: 'Make primary', exact: true }).click();
    await nextFolder(page, '/work/main');
    await form.getByRole('button', { name: 'Add folders', exact: true }).click();
    await expect(form.getByRole('alert')).toHaveCount(0);
    await nextFolder(page, Array.from({ length: 20 }, (_, index) => `/too-many/${index}`));
    await form.getByRole('button', { name: 'Add folders', exact: true }).click();
    await expect(form.getByRole('alert')).toHaveText('A Project can contain up to 20 folders. Add fewer folders.');
    await form.screenshot({ path: testInfo.outputPath(`project-edit-error-${theme}.png`) });
    const longFolder = '/Users/developer/Projects/' + 'long-parent-directory/'.repeat(6) + 'lin-outliner-workbench-test';
    await nextFolder(page, longFolder);
    await form.getByRole('button', { name: 'Add folders', exact: true }).click();
    await rows.filter({ hasText: longFolder }).getByRole('button', { name: 'Make primary', exact: true }).click();
    await name.fill('Renamed workspace');
    const pathGeometry = await rows.filter({ hasText: longFolder }).locator('.project-folder-path').evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      title: el.getAttribute('title'),
      text: el.textContent,
      rowHeight: el.parentElement!.getBoundingClientRect().height,
    }));
    expect(pathGeometry.title).toBe(longFolder);
    expect(pathGeometry.text).toBe(longFolder);
    expect(pathGeometry.height).toBeLessThanOrEqual(20);
    expect(pathGeometry.rowHeight).toBe(28);
    const leaf = rows.filter({ hasText: longFolder }).locator('.project-folder-name');
    expect((await form.boundingBox())!.width).toBe(560);
    expect(await leaf.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 400, height: viewport.height });
    expect((await form.boundingBox())!.width).toBeLessThanOrEqual(368);
    expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const narrowPath = await leaf.evaluate((el) => {
      const row = el.closest('.project-list-row')!.getBoundingClientRect();
      const text = el.getBoundingClientRect();
      const action = el.closest('.project-list-row')!.querySelector('.project-primary-action')!.getBoundingClientRect();
      return { inside: text.left >= row.left && text.right <= action.left, height: row.height };
    });
    expect(narrowPath.inside).toBe(true);
    expect(narrowPath.height).toBe(28);
    await form.screenshot({ path: testInfo.outputPath(`project-edit-narrow-${theme}.png`) });
    await page.setViewportSize(viewport);

    await form.screenshot({ path: testInfo.outputPath(`project-edit-${theme}.png`) });
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('.thread-location-chip')).toHaveText('Renamed workspace');
    await expect(change).toBeFocused();
    const saved = (await page.evaluate(() => window.lin.agentCoreRequest('project/inspect', {}))).projects.find((entry) => entry.id === project.id)!;
    expect(saved.name).toBe('Renamed workspace');
    expect(saved.folders).toEqual(['/work/main', longFolder]);
    expect(saved.primaryFolder).toBe(longFolder);
    expect((await commandCalls(page)).filter((entry) => entry.cmd === 'project/manage' && entry.args.operation === 'bind')).toHaveLength(1);
    await change.click();
    await picker.getByRole('menuitem', { name: /^Edit Project:/ }).click();
    await name.fill('Discard this name');
    await form.getByRole('button', { name: 'Delete Project', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Delete Project', exact: true });
    await expect(deletion.getByText('Renamed workspace', { exact: true })).toBeVisible();
    await deletion.screenshot({ path: testInfo.outputPath(`project-delete-${theme}.png`) });
    await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Discard this name');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.thread-location-chip')).toHaveText('Renamed workspace');
    await change.click();
    await picker.getByRole('menuitem', { name: /^Edit Project:/ }).click();
    await form.getByRole('button', { name: 'Delete Project', exact: true }).click();
    await page.evaluate(() => {
      const request = window.lin.agentCoreRequest.bind(window.lin);
      let fail = true;
      window.lin.agentCoreRequest = (async (method: string, input: Record<string, unknown>) => {
        if (method === 'project/manage' && input.operation === 'delete' && fail) {
          fail = false; throw new Error('An Automation still references this Project.');
        }
        return request(method as never, input as never);
      }) as typeof window.lin.agentCoreRequest;
    });
    await deletion.getByRole('button', { name: 'Delete Project', exact: true }).click();
    await expect(deletion.getByRole('alert')).toHaveText('An Automation still references this Project.');
    await expect(page.locator('.thread-location-chip')).toHaveText('Renamed workspace');
    await deletion.screenshot({ path: testInfo.outputPath(`project-delete-error-${theme}.png`) });
    await deletion.getByRole('button', { name: 'Delete Project', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(page.locator('.thread-location-chip')).toHaveCount(0);
    await expect(page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true })).toBeFocused();
    const empty = await projectMenu(page);
    await expect(empty.getByRole('status')).toHaveCount(0);
    await expect(empty.getByRole('separator')).toHaveCount(0);
    await expect(empty.getByRole('menuitem')).toHaveCount(1);
    await expect(empty.getByRole('menuitem', { name: 'New Project', exact: true })).toBeVisible();
  });
}

test('Project folder multiselection appends unique folders and preserves existing primary', async ({ page }) => {
  await openMockedApp(page);
  await (await projectMenu(page)).getByRole('menuitem', { name: 'New Project', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create project', exact: true });
  const add = form.getByRole('button', { name: 'Add folders', exact: true });
  await nextFolder(page, []);
  await add.click();
  await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
  await expect(form.locator('.project-list-row')).toHaveCount(0);
  await nextFolder(page, ['/sources/app', '/sources/docs', '/sources/app', '/sources/shared']);
  await add.click();
  await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('app');
  await expect(form.locator('.project-list-row')).toHaveCount(3);
  await expect(form.locator('.project-list-row').filter({ hasText: '/sources/app' }).getByText('Primary', { exact: true })).toBeVisible();
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('My workspace');
  await form.locator('.project-list-row').filter({ hasText: '/sources/docs' }).getByRole('button', { name: 'Make primary', exact: true }).click();
  await nextFolder(page, ['/sources/shared', '/sources/tests', '/sources/examples']);
  await add.click();
  await expect(form.locator('.project-list-row')).toHaveCount(5);
  await expect(form.locator('.project-list-row').filter({ hasText: '/sources/docs' }).getByText('Primary', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(form).toHaveCount(0);
  const catalog = await page.evaluate(() => window.lin.agentCoreRequest('project/inspect', {}));
  expect(catalog.projects[0]).toMatchObject({ name: 'My workspace', primaryFolder: '/sources/docs',
    folders: ['/sources/app', '/sources/docs', '/sources/shared', '/sources/tests', '/sources/examples'] });
});

for (const theme of ['light', 'dark'] as const) {
  test(`each Project row edits its own Project without changing chat selection in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    await page.evaluate(async () => {
      for (const name of ['Current', 'Another']) await window.lin.agentCoreRequest('project/manage', {
        operation: 'create', name, folders: [], primaryFolder: null,
      });
    });
    await (await projectMenu(page)).getByRole('menuitemradio', { name: 'Current', exact: true }).click();
    await page.getByRole('button', { name: 'Change project', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Choose project', exact: true });
    await expect(menu.getByRole('menuitem', { name: 'Edit Project', exact: true })).toHaveCount(0);
    const selectedRow = menu.locator('.project-picker-row').filter({ has: page.getByRole('menuitemradio', { name: 'Current', exact: true }) });
    const check = selectedRow.locator('.project-menu-check');
    const selectedEdit = selectedRow.getByRole('menuitem', { name: 'Edit Project: Current', exact: true });
    // A mouse-focused row must return to its resting state once the pointer leaves.
    await menu.getByRole('textbox').click();
    await selectedRow.getByRole('menuitemradio').focus();
    await page.locator('.thread-dock-header').hover();
    await expect(check).toHaveCSS('opacity', '1');
    await expect(selectedEdit).toHaveCSS('opacity', '0');
    const selectedBounds = await selectedRow.boundingBox();
    const selectedLabelBounds = await selectedRow.locator('.project-menu-label').boundingBox();
    const checkBounds = (await check.boundingBox())!;
    await menu.screenshot({ path: testInfo.outputPath('project-picker-rest.png') });
    await selectedRow.hover();
    await expect(selectedEdit).toHaveCSS('opacity', '1');
    await expect(check).toHaveCSS('opacity', '0');
    const pencilBounds = (await selectedEdit.locator('svg').boundingBox())!;
    expect(pencilBounds.x + pencilBounds.width / 2).toBe(checkBounds.x + checkBounds.width / 2);
    expect(pencilBounds.y + pencilBounds.height / 2).toBe(checkBounds.y + checkBounds.height / 2);
    expect(await selectedRow.boundingBox()).toEqual(selectedBounds);
    expect(await selectedRow.locator('.project-menu-label').boundingBox()).toEqual(selectedLabelBounds);
    await menu.screenshot({ path: testInfo.outputPath('project-picker-hover.png') });
    await menu.getByRole('textbox').hover();
    await expect(selectedEdit).toHaveCSS('opacity', '0');
    await expect(check).toHaveCSS('opacity', '1');
    const row = menu.locator('.project-picker-row').filter({ has: page.getByRole('menuitemradio', { name: 'Another', exact: true }) });
    const edit = row.getByRole('menuitem', { name: 'Edit Project: Another', exact: true });
    await menu.getByRole('textbox').hover();
    await expect(edit).toHaveCSS('opacity', '0');
    const before = await row.boundingBox();
    const label = await row.locator('.project-menu-label').boundingBox();
    await row.hover();
    await expect(edit).toHaveCSS('opacity', '1');
    expect(await row.boundingBox()).toEqual(before);
    expect(await row.locator('.project-menu-label').boundingBox()).toEqual(label);
    await menu.screenshot({ path: testInfo.outputPath('project-row-edit.png') });
    await menu.getByRole('textbox').hover();
    await row.getByRole('menuitemradio').focus();
    await page.keyboard.press('ArrowDown');
    await expect(edit).toBeFocused();
    await expect(edit).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    const form = page.getByRole('dialog', { name: 'Edit Project', exact: true });
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Another');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed another');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('.thread-location-chip')).toHaveText('Current · Application default');
    expect((await commandCalls(page)).filter((entry) => entry.cmd === 'project/manage' && entry.args.operation === 'bind')).toHaveLength(1);
    await page.getByRole('button', { name: 'Change project', exact: true }).click();
    await expect(menu.getByRole('menuitemradio', { name: 'Renamed another', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Current', exact: true })).toHaveAttribute('aria-checked', 'true');
  });
}

for (const action of ['select', 'clear'] as const) {
  test(`Project ${action} failure restores keyboard navigation and dismissal`, async ({ page }) => {
    await openMockedApp(page);
    await page.evaluate(async () => {
      await window.lin.agentCoreRequest('project/manage', {
        operation: 'create', name: 'Keyboard project', folders: [], primaryFolder: null,
      });
    });
    if (action === 'clear') {
      await (await projectMenu(page)).getByRole('menuitemradio', { name: 'Keyboard project', exact: true }).click();
    }
    await page.evaluate(() => {
      const request = window.lin.agentCoreRequest.bind(window.lin);
      window.lin.agentCoreRequest = (async (method: string, input: Record<string, unknown>) => {
        if (method === 'project/manage' && input.operation === 'bind') {
          await new Promise<void>((_resolve, reject) => {
            (window as unknown as { rejectProjectSelection: () => void }).rejectProjectSelection =
              () => reject(new Error('Project membership conflict'));
          });
        }
        return request(method as never, input as never);
      }) as typeof window.lin.agentCoreRequest;
    });
    const trigger = action === 'select'
      ? page.locator('.thread-composer-toolbar').getByRole('button', { name: 'Add', exact: true })
      : page.getByRole('button', { name: 'Change project', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    if (action === 'select') {
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
    }
    const menu = page.getByRole('menu', { name: 'Choose project', exact: true });
    await expect(menu.getByRole('textbox')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    if (action === 'clear') await page.keyboard.press('End');
    const target = action === 'select'
      ? menu.getByRole('menuitemradio', { name: 'Keyboard project', exact: true })
      : menu.getByRole('menuitem', { name: "Don't work in a project", exact: true });
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(target).toBeDisabled();
    await expect(menu).toBeFocused();
    await page.evaluate(() => (window as unknown as { rejectProjectSelection: () => void }).rejectProjectSelection());
    await expect(menu.getByRole('alert')).toHaveText('Project membership conflict');
    await expect(target).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole(action === 'select' ? 'textbox' : 'menuitem', {
      name: action === 'select' ? 'Search projects' : 'New Project', exact: true,
    })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator('.thread-location-chip')).toHaveCount(action === 'select' ? 0 : 1);
  });
}
