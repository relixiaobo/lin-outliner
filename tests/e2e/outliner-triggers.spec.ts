import { expect, test } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  ids,
  nodeByText,
  openMockedApp,
  row,
  trailingEditor,
} from './outlinerMock';

async function lastTodayChildId(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children.at(-1);
}

test.describe('outliner trigger parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('# in trailing input creates a trigger row, opens tag selector, and applies a created tag', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('#project');

    const listbox = page.getByRole('listbox', { name: 'Tag suggestions' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('option', { name: /Create project/ })).toBeVisible();

    const triggerRowId = await lastTodayChildId(page);
    expect(triggerRowId).toBeTruthy();

    await page.keyboard.press('Enter');

    await expect(page.locator('.trigger-popover')).toHaveCount(0);
    await expect(row(page, triggerRowId!).locator('.tag-badge-label')).toContainText('project');
    await expect.poll(async () => (await nodeByText(page, 'project'))?.type).toBe('tagDef');
  });

  test('@ in trailing input splits to tree reference creation when the trigger owns the whole row', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('@Zeta');

    const listbox = page.getByRole('listbox', { name: 'Reference suggestions' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('option', { name: /Create "Zeta"/ })).toBeVisible();

    const triggerRowId = await lastTodayChildId(page);
    expect(triggerRowId).toBeTruthy();

    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      return projection.nodes.find((node) => node.id === triggerRowId)?.type;
    }).toBe('reference');
    await expect(row(page, triggerRowId!)).toContainText('Zeta');
  });

  test('/ in trailing input opens slash commands and Field command creates an inline field', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('/');

    const listbox = page.getByRole('listbox', { name: 'Slash commands' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('option', { name: /Field/ })).toBeVisible();

    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'create_inline_field_after_node');
    }).toBe(true);
  });

  test('> in trailing input directly creates an inline field without leaving a trigger row', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'create_inline_field');
    }).toBe(true);
    await expect(page.locator('.trigger-popover')).toHaveCount(0);
  });

});

test.describe('outliner option picker parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { optionsField: true });
  });

  test('options field picker exposes listbox state and creates a selected option', async ({ page }) => {
    const pickerInput = row(page, ids.priorityEntry).locator('.node-picker-input');
    await pickerInput.click();

    const listbox = page.getByRole('listbox', { name: 'Field options' });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(listbox.getByRole('option', { name: 'High' })).toBeVisible();

    await page.keyboard.type('Urgent');
    await expect(listbox.getByRole('option', { name: 'Create "Urgent"' })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('listbox', { name: 'Field options' })).toHaveCount(0);
    await expect(pickerInput).toHaveValue('Urgent');
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const entry = projection.nodes.find((node) => node.id === ids.priorityEntry);
      const valueNode = projection.nodes.find((node) => node.parentId === ids.priorityEntry);
      const optionNode = projection.nodes.find((node) => node.id === valueNode?.targetId);
      return {
        entryChildren: entry?.children.length,
        option: optionNode?.content.text,
      };
    }).toEqual({
      entryChildren: 1,
      option: 'Urgent',
    });
  });
});
