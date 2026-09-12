import { expect, test, type Page } from '@playwright/test';
import { commandCalls, ids, openMockedApp } from './outlinerMock';
import { formatNodeReferenceMarker, formatFileReferenceMarker } from '../../src/core/referenceMarkup';

async function editor(page: Page) {
  await openMockedApp(page);
  await page.getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  return page.getByRole('dialog', { name: 'New task', exact: true });
}

test('the normal task and time decisions fit a window-level sheet in both themes', async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const sheet = await editor(page);
  const task = sheet.getByRole('textbox', { name: 'Task', exact: true });
  await task.fill('Summarize the latest AI news and include source links.');
  await expect(sheet.getByRole('button', { name: 'Create task' })).toBeEnabled();
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toBeHidden();
  const bounds = await sheet.boundingBox();
  expect(bounds!.width).toBeGreaterThan(500);
  expect(Math.abs(bounds!.x + bounds!.width / 2 - 450)).toBeLessThan(2);
  const body = sheet.locator('.automation-editor-scroll');
  expect(await body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: info.outputPath(`editor-${colorScheme}.png`), animations: 'disabled' });
  }
  await sheet.getByRole('button', { name: 'Create task' }).click();
  const input = (await commandCalls(page)).find((call) => call.cmd === 'automation/create')!.args;
  expect(input.prompt).toBe('Summarize the latest AI news and include source links.');
  expect(input.configuration).toMatchObject({ modelProvider: null, model: null });
  expect(input.contextHints).toEqual([]);
});

test('inline references keep repeated roles, newlines and source policy across save and reopen', async ({ page }) => {
  const sheet = await editor(page);
  const task = sheet.getByRole('textbox', { name: 'Task', exact: true });
  await task.fill('Compare ');
  await task.pressSequentially('@Alpha');
  await page.getByRole('option', { name: 'Alpha', exact: true }).click();
  await task.pressSequentially('with ');
  await task.pressSequentially('@Beta');
  await page.getByRole('option', { name: 'Beta', exact: true }).click();
  await task.press('Enter');
  await task.pressSequentially('Update @Beta');
  await page.getByRole('option', { name: 'Beta', exact: true }).click();
  await expect(sheet).toBeVisible();
  await expect(task.locator('[data-thread-node-ref]')).toHaveCount(3);
  await sheet.getByText('Reference options', { exact: true }).click();
  const beta = sheet.locator('.scheduled-reference-policy').filter({ hasText: 'Beta' });
  await beta.getByRole('checkbox', { name: 'Continue if unavailable', exact: true }).check();
  await sheet.getByRole('button', { name: 'Create task', exact: true }).click();
  const create = (await commandCalls(page)).find((call) => call.cmd === 'automation/create')!;
  const expected = `Compare ${formatNodeReferenceMarker(ids.alpha)} with ${formatNodeReferenceMarker(ids.beta)} \nUpdate ${formatNodeReferenceMarker(ids.beta)} `;
  expect(create.args.prompt).toBe(expected);
  expect(create.args.materials).toEqual([{ kind: 'note', reference: ids.beta, required: false }]);
  await page.locator('.scheduled-task-detail').getByRole('button', { name: 'Edit task', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(edit.getByRole('textbox', { name: 'Task', exact: true }).locator('[data-thread-node-ref]')).toHaveCount(3);
  await expect(edit.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
});

test('a file picker inserts a durable path at the caret and undo restores its position', async ({ page }) => {
  const sheet = await editor(page);
  await page.evaluate(() => { window.lin!.pickLocalFiles = async () => ({ canceled: false, files: [{ path: '/tmp/review.md', name: 'review.md', mimeType: 'text/markdown', sizeBytes: 20, lastModified: 1 }] }); });
  const task = sheet.getByRole('textbox', { name: 'Task', exact: true });
  await task.fill('Review ');
  await sheet.getByRole('button', { name: 'Choose files', exact: true }).click();
  await expect(task.locator('[data-thread-file-ref]')).toHaveCount(1);
  await task.press('Meta+z');
  await expect(task.locator('[data-thread-file-ref]')).toHaveCount(0);
  await task.press('Meta+Shift+z');
  await expect(task.locator('[data-thread-file-ref]')).toHaveCount(1);
  await sheet.getByRole('button', { name: 'Create task', exact: true }).click();
  expect((await commandCalls(page)).find((call) => call.cmd === 'automation/create')!.args.prompt).toBe(`Review ${formatFileReferenceMarker('/tmp/review.md')} `);
  expect((await commandCalls(page)).filter((call) => call.cmd.includes('attachment-upload'))).toEqual([]);
});

test('dropping a transient file keeps the draft and provides the durable-file action', async ({ page }) => {
  const sheet = await editor(page);
  const task = sheet.getByRole('textbox', { name: 'Task', exact: true });
  await task.fill('Keep these instructions.');
  await task.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['temporary'], 'clipboard.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(task).toHaveText('Keep these instructions.');
  await expect(sheet.getByRole('alert')).toHaveText('Use @ or Choose files to reference a saved local file.');
  await expect(sheet).toBeVisible();
});

test('pending file selection blocks save and a late picker cannot populate another draft', async ({ page }) => {
  const sheet = await editor(page);
  await page.evaluate(() => {
    window.lin!.pickLocalFiles = () => new Promise((resolve) => {
      (window as unknown as { finishTaskPicker: () => void }).finishTaskPicker = () => resolve({ canceled: false, files: [{ path: '/tmp/late.md', name: 'late.md', mimeType: 'text/markdown', sizeBytes: 1, lastModified: 1 }] });
    });
  });
  await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Read the selected file.');
  await sheet.getByRole('button', { name: 'Choose files', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.evaluate(() => (window as unknown as { finishTaskPicker: () => void }).finishTaskPicker());
  await expect(sheet.locator('[data-thread-file-ref]')).toHaveCount(0);
  await expect(sheet.getByRole('textbox', { name: 'Task', exact: true })).toHaveText('');
});

test('unsupported saved rules and attached context survive a description-only edit', async ({ page }) => {
  await openMockedApp(page);
  const saved = await page.evaluate(async () => (await window.lin!.automationRequest('create', {
    name: 'Last workday review', prompt: 'Review the project.', destination: { kind: 'standalone' },
    schedule: { rrule: 'DTSTART:20270901T090000\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', timezone: 'UTC' },
    materials: [{ kind: 'url', reference: 'https://example.com/brief', required: false }], status: 'paused',
  })).automation);
  await page.getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
  await page.locator('.scheduled-task-row', { hasText: saved.name }).click();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(sheet.getByText('Saved custom schedule', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Paused · Saving keeps this task paused.', { exact: true })).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Review the project and summarize risks.');
  await sheet.getByRole('button', { name: 'Save changes', exact: true }).click();
  const input = (await commandCalls(page)).find((call) => call.cmd === 'automation/update')!.args;
  expect(input.schedule).toEqual(saved.schedule);
  expect(input.materials).toEqual(saved.materials);
  expect(input).not.toHaveProperty('status');
});

test('applying a reviewed conflict cannot silently adopt a newer unseen revision', async ({ page }) => {
  const sheet = await editor(page);
  await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Review current changes.');
  await sheet.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await edit.getByRole('textbox', { name: 'Task', exact: true }).fill('My edited instructions.');
  const change = async (prompt: string) => page.evaluate(async (prompt) => {
    const task = (await window.lin!.automationRequest('list', {})).data[0]!;
    await window.lin!.automationRequest('update', { id: task.id, expectedRevision: task.revision, prompt });
  }, prompt);
  await change('Remote version two.');
  await edit.getByRole('button', { name: 'Review saved version', exact: true }).click();
  await expect(edit.getByText('Saved version: Remote version two.', { exact: true })).toBeVisible();
  await change('Remote version three.');
  await edit.getByRole('button', { name: 'Save my draft against this version', exact: true }).click();
  await expect(edit.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await expect(edit.getByRole('textbox', { name: 'Task', exact: true })).toHaveText('My edited instructions.');
});
