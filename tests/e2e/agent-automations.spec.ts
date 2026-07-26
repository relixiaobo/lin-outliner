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
    const toolbar = page.locator('.automations-toolbar');
    await expect(toolbar.locator('.automations-search')).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'New Automation' })).toBeVisible();
    const filterWidths = await page.locator('.automations-filter .segmented-control-option')
      .evaluateAll((options) => options.map((option) => option.getBoundingClientRect().width));
    expect(Math.max(...filterWidths) - Math.min(...filterWidths)).toBeLessThan(1);

    await toolbar.getByRole('button', { name: 'New Automation' }).click();
    const createDrawer = page.getByRole('dialog', { name: 'New Automation' });
    await expect(createDrawer).toBeVisible();
    await page.getByRole('textbox', { name: 'Name' }).fill('Daily repository review');
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Review the repository and summarize important changes.');
    const repeat = createDrawer.getByRole('combobox', { name: 'Repeat' });
    await repeat.selectOption('weekly');
    const weekdays = createDrawer.getByRole('button', { name: 'On', exact: true });
    await weekdays.click();
    const weekdayMenu = page.getByRole('menu', { name: 'On', exact: true });
    for (const [name, selected] of [
      ['Monday', true], ['Tuesday', false], ['Wednesday', true], ['Thursday', false],
      ['Friday', false], ['Saturday', false], ['Sunday', false],
    ] as const) {
      const option = weekdayMenu.getByRole('menuitemcheckbox', { name });
      if ((await option.getAttribute('aria-checked')) !== String(selected)) await option.click();
    }
    const saturday = weekdayMenu.getByRole('menuitemcheckbox', { name: 'Saturday' });
    await saturday.click();
    await saturday.click();
    await expect(saturday).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(weekdayMenu).toHaveCount(0);
    const time = createDrawer.getByLabel('At', { exact: true });
    await expect(time).toBeVisible();
    await time.fill('09:05');
    await page.getByRole('button', { name: 'Create Automation' }).click();

    const detailDrawer = page.getByRole('dialog', { name: 'Daily repository review' });
    await expect(detailDrawer).toBeVisible();
    const automationRow = page.locator('.automation-list-row', { hasText: 'Daily repository review' });
    await expect(automationRow).toBeVisible();
    await expect(automationRow.locator('.automation-status-dot')).toBeVisible();
    const alignedLefts = await Promise.all([
      page.locator('.automations-search'),
      page.locator('.automations-filter'),
      automationRow,
    ].map((locator) => locator.evaluate((element) => element.getBoundingClientRect().left)));
    expect(Math.max(...alignedLefts) - Math.min(...alignedLefts)).toBeLessThan(1);
    await expect(detailDrawer.getByRole('combobox', { name: 'Runs in' })).toHaveValue('standalone');
    const model = detailDrawer.getByRole('combobox', { name: 'Model' });
    await expect(model).toHaveValue('');
    await model.selectOption('openai/gpt-5.4');
    const timezone = detailDrawer.getByRole('combobox', { name: 'Timezone' });
    await timezone.selectOption('Asia/Shanghai');
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
      .toMatchObject({
        modelProvider: 'openai',
        model: 'openai/gpt-5.4',
        tools: [],
      });
    expect(calls.find((call) => call.cmd === 'automation/create')?.args.schedule.rrule)
      .toMatch(/RRULE:FREQ=WEEKLY;BYDAY=MO,WE$/);
    expect(calls.find((call) => call.cmd === 'automation/create')?.args.schedule.rrule)
      .toMatch(/^DTSTART:\d{8}T090500/m);
  });

  test('shows complete controls for each schedule preset', async ({ page }) => {
    await page.locator('.automations-toolbar').getByRole('button', { name: 'New Automation' }).click();
    const drawer = page.getByRole('dialog', { name: 'New Automation' });
    const repeat = drawer.getByRole('combobox', { name: 'Repeat' });

    await repeat.selectOption('once');
    const date = drawer.getByRole('button', { name: 'Date', exact: true });
    await expect(date).toBeVisible();
    await expect(drawer.getByLabel('At', { exact: true })).toBeVisible();
    await date.click();
    const datePicker = page.getByRole('dialog', { name: 'Date picker' });
    await expect(datePicker).toBeVisible();
    await expect(datePicker.getByRole('button', { name: 'Clear' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await repeat.selectOption('hourly');
    await expect(drawer.getByRole('button', { name: 'On', exact: true })).toHaveCount(0);
    await expect(drawer.getByLabel('At', { exact: true })).toHaveCount(0);

    await repeat.selectOption('daily');
    const dailyTime = drawer.getByLabel('At', { exact: true });
    await expect(dailyTime).toBeVisible();
    await drawer.getByRole('button', { name: 'Choose time' }).click();
    const timePicker = page.getByRole('dialog', { name: 'Time picker' });
    await expect(timePicker).toBeVisible();
    const hourList = timePicker.getByRole('listbox', { name: 'Hour' });
    const scrollContract = await hourList.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        paddingInlineEnd: style.paddingInlineEnd,
        paddingInlineStart: style.paddingInlineStart,
        scrollbarGutter: style.scrollbarGutter,
      };
    });
    expect(scrollContract.scrollbarGutter).toContain('stable');
    expect(scrollContract.paddingInlineStart).toBe(scrollContract.paddingInlineEnd);
    expect(Number.parseFloat(scrollContract.paddingInlineEnd)).toBeGreaterThan(0);
    await hourList.getByRole('option', { name: '10', exact: true }).click();
    await timePicker.getByRole('listbox', { name: 'Minute' }).getByRole('option', { name: '17', exact: true }).click();
    await expect(timePicker).toHaveCount(0);
    await expect(dailyTime).toHaveValue('10:17');
    await dailyTime.fill('25:75');
    await dailyTime.blur();
    await expect(dailyTime).toHaveValue('10:17');

    await repeat.selectOption('weekdays');
    await expect(drawer.getByRole('button', { name: 'On', exact: true })).toHaveCount(0);
    await expect(drawer.getByLabel('At', { exact: true })).toBeVisible();

    await repeat.selectOption('weekly');
    await expect(drawer.getByRole('button', { name: 'On', exact: true })).toBeVisible();
    await expect(drawer.getByLabel('At', { exact: true })).toBeVisible();

    await repeat.selectOption('custom');
    const repeats = drawer.getByRole('combobox', { name: 'Repeats' });
    await expect(drawer.getByRole('spinbutton', { name: 'Every' })).toBeVisible();
    await repeats.selectOption('weekly');
    await expect(drawer.getByRole('button', { name: 'On', exact: true })).toBeVisible();
    await expect(drawer.getByLabel('At', { exact: true })).toBeVisible();
    await repeats.selectOption('monthly');
    await expect(drawer.getByRole('button', { name: 'On days', exact: true })).toBeVisible();
    await repeats.selectOption('yearly');
    await expect(drawer.getByRole('combobox', { name: 'In', exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'On days', exact: true })).toBeVisible();
    await repeats.selectOption('hourly');
    await expect(drawer.getByRole('spinbutton', { name: 'At minute' })).toBeVisible();
    await expect(drawer.getByLabel('At', { exact: true })).toHaveCount(0);
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
