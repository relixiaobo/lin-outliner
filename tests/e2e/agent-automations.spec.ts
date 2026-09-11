import { expect, test, type Page } from '@playwright/test';
import type { ScheduledRunResult } from '../../src/core/agent/scheduledResult';
import { commandCalls, openMockedApp } from './outlinerMock';

async function createTask(page: Page, name = 'Repository review') {
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New task' });
  await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Review the repository and report important changes.');
  await sheet.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await sheet.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.scheduled-header h2')).toHaveText(name);
}

async function setResult(page: Page, runId: string, result: Partial<ScheduledRunResult>) {
  await page.evaluate(({ runId, result }) => {
    (window as unknown as { __LIN_E2E__: { setScheduledResult: (id: string, result: Partial<ScheduledRunResult>) => void } }).__LIN_E2E__.setScheduledResult(runId, result);
  }, { runId, result });
}

test.describe('Scheduled tasks in Agent Deck', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await expect(page.locator('.scheduled-workspace')).toBeVisible();
    await expect(page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Scheduled tasks', exact: true })).toHaveCount(0);
    await expect(page.locator('.agent-dock .scheduled-workspace')).toBeVisible();
  });

  test('task navigation and conversation drafts survive switching without changing Outline panes', async ({ page }) => {
    const layout = await page.evaluate(() => localStorage.getItem('lin-outliner:workspace-layout:v7'));
    const backToConversation = page.locator('.thread-dock-header').getByRole('button', { name: 'Back to Threads', exact: true });
    await backToConversation.click();
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Keep my conversation draft.');
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await createTask(page);
    await page.locator('.scheduled-task-detail').getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Search scheduled tasks', exact: true }).click();
    await page.locator('.scheduled-search').fill('Repository');
    await page.locator('.scheduled-task-row').click();
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await backToConversation.click();
    await expect(composer).toHaveText('Keep my conversation draft.');
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await expect(page.locator('.scheduled-search')).toHaveValue('Repository');
    await page.locator('.scheduled-task-row').click();
    await expect(page.locator('.scheduled-header h2')).toHaveText('Repository review');
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
    expect(await page.evaluate(() => localStorage.getItem('lin-outliner:workspace-layout:v7'))).toBe(layout);
  });

  test('a task notice opens its assignment in a collapsed Deck without navigating the Outline', async ({ page }) => {
    await createTask(page);
    const layout = await page.evaluate(() => localStorage.getItem('lin-outliner:workspace-layout:v7'));
    await page.getByRole('button', { name: 'Collapse agent', exact: true }).click();
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'collapsed');
    await page.evaluate(async () => {
      const task = (await window.lin!.automationRequest('list', {})).data[0]!;
      const testHost = (window as unknown as { __LIN_E2E__: { emitAutomationNotification: (event: unknown) => void } }).__LIN_E2E__;
      testHost.emitAutomationNotification({ type: 'automation/open', automationId: task.id });
    });
    await expect(page.locator('.agent-dock')).toHaveAttribute('data-rail-state', 'open');
    await expect(page.locator('.scheduled-header h2')).toHaveText('Repository review');
    expect(await page.evaluate(() => localStorage.getItem('lin-outliner:workspace-layout:v7'))).toBe(layout);
  });

  test('Discuss result switches to an ordinary conversation and retains the task for return', async ({ page }) => {
    await createTask(page);
    await page.locator('.scheduled-task-detail').getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
    const starts = (await commandCalls(page)).filter((call) => call.cmd === 'thread/start').length;
    await page.getByRole('button', { name: 'Discuss result', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    await expect(page.locator('.scheduled-workspace')).toBeHidden();
    expect((await commandCalls(page)).filter((call) => call.cmd === 'thread/start')).toHaveLength(starts + 1);
    await expect(page.locator('.thread-composer-contexts')).toContainText('Repository review');
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Explain this result.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page)).filter((call) => call.cmd === 'turn/submit').length).toBe(1);
    const send = (await commandCalls(page)).findLast((call) => call.cmd === 'turn/submit');
    const run = (await page.evaluate(() => window.lin!.automationRequest('runs', {}))).data[0]!;
    const context = (send?.args.additionalContext as Record<string, { kind: string; value: string }>)[`scheduled-result:${run.id}`]!;
    expect(context.kind).toBe('untrusted');
    expect(JSON.parse(context.value)).toMatchObject({ automationRunId: run.id, threadId: run.threadId, turnId: run.turnId });
    expect(context.value).not.toContain('The scheduled review was delivered.');
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await expect(page.locator('.scheduled-header h2')).toHaveText('Repository review');
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
  });

  test('a hidden task surface leaves new results unread until the Deck is reopened', async ({ page }) => {
    await createTask(page);
    await page.getByRole('button', { name: 'Collapse agent', exact: true }).click();
    const runId = await page.evaluate(async () => {
      const task = (await window.lin!.automationRequest('list', {})).data[0]!;
      const response = await window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'hidden-run' });
      return response.runs[0]!.id;
    });
    expect((await commandCalls(page)).filter((call) => call.cmd === 'automation/runMarkRead' && call.args.id === runId)).toHaveLength(0);
    await page.getByRole('button', { name: 'Expand agent', exact: true }).click();
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
    await expect.poll(async () => (await commandCalls(page)).filter((call) => call.cmd === 'automation/runMarkRead' && call.args.id === runId).length).toBe(1);
  });

  test('creates an assignment, runs while paused, reads its result and restores an archive paused', async ({ page }) => {
    await createTask(page);
    const detail = page.locator('.scheduled-task-detail');
    await page.getByRole('button', { name: 'Task actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Pause schedule', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Edit task', exact: true })).toHaveText('Paused');
    await detail.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(detail.getByText('The scheduled review was delivered.', { exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Edit task', exact: true })).toHaveText('Paused');
    const run = (await commandCalls(page)).find((call) => call.cmd === 'automation/startNow');
    expect(run?.args.expectedRevision).toBe(2);
    await page.getByRole('button', { name: 'Task actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Edit task', exact: true })).toHaveText('Paused');
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

  test('process inspection retains the exact task in the Deck and preserves its selected run', async ({ page }) => {
    await createTask(page);
    await page.locator('.scheduled-task-detail').getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
    await page.locator('.scheduled-result').getByRole('button', { name: 'View process', exact: true }).click();
    await expect(page.locator('.thread-trajectory-panel')).toBeVisible();
    await expect(page.locator('.agent-dock .scheduled-header h2')).toHaveText('Repository review');
    await page.locator('.thread-trajectory-panel').getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(page.locator('.scheduled-header h2')).toHaveText('Repository review');
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
    await expect(page.locator('.scheduled-result')).toHaveAttribute('data-run-id', /.+/);
    await expect(page.locator('.scheduled-history')).toHaveCount(0);
  });

  test('external edits preserve the draft and require an explicit reload or deliberate revision', async ({ page }) => {
    await createTask(page);
    await page.locator('.scheduled-task-detail').getByRole('button', { name: 'Edit task', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Edit task' });
    await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Unsent local instructions');
    await page.evaluate(async () => {
      const task = (await window.lin!.automationRequest('list', {})).data[0]!;
      await window.lin!.automationRequest('update', { id: task.id, expectedRevision: task.revision, prompt: 'Externally saved instructions' });
    });
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sheet.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Unsent local instructions');
    await sheet.getByText('Saved task changed', { exact: true }).click();
    await expect(sheet.getByText('Externally saved instructions', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Reload saved task', exact: true }).click();
    await expect(sheet.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Externally saved instructions');
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

  test('an unfinished task editor survives a global new-conversation shortcut', async ({ page }) => {
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'New task' });
    await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Keep this unfinished task draft.');
    await page.keyboard.press('Meta+Shift+O');
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    await page.locator('.thread-dock-header').getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Keep this unfinished task draft.');
    await expect(sheet).toBeFocused();
  });

  test('supports shared date/time controls, materials and one primary location', async ({ page }, testInfo) => {
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
    await sheet.locator('.automation-editor-scroll').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('scheduled-task-editor.png') });
  });

  test('the list has one title, on-demand search and keyboard-accessible archive discovery', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Scheduled tasks', exact: true })).toHaveCount(1);
    await expect(page.locator('.scheduled-search')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Needs attention/ })).toHaveCount(0);
    await expect(page.getByText('No scheduled tasks yet.', { exact: true })).toBeVisible();
    await page.keyboard.press('Meta+f');
    await expect(page.locator('.scheduled-search')).toBeFocused();
    await page.locator('.scheduled-search').fill('No such assignment');
    await expect(page.getByText('No matching tasks', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.scheduled-search')).toHaveCount(0);
    const more = page.getByRole('button', { name: 'Task list options', exact: true });
    await more.focus(); await page.keyboard.press('Enter');
    const archive = page.getByRole('menuitem', { name: 'Show archived tasks', exact: true });
    await expect(archive).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Archived tasks', exact: true })).toBeVisible();
    await expect(page.getByText('No archived tasks.', { exact: true })).toBeVisible();
  });

  test('results lead the detail and older issues stay reachable after a newer success', async ({ page }, testInfo) => {
    await createTask(page, 'AI morning brief');
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    const first = (await page.evaluate(() => window.lin!.automationRequest('runs', {}))).data[0]!;
    await setResult(page, first.id, { state: 'failed', answer: null, parts: [], issues: [
      { key: 'source-unavailable', text: 'The news source could not be reached.', turnId: first.turnId, terminal: true, acknowledged: false },
    ] });
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    const second = (await page.evaluate(() => window.lin!.automationRequest('runs', {}))).data[0]!;
    const answer = '## Three developments to watch\n\n**Smaller models are becoming more practical.** New releases focus on efficient local inference and lower operating costs.\n\n**Coding tools are improving their review workflow.** The useful change is clearer evidence before accepting edits.\n\n**Reliability still needs scrutiny.** Compare published results with your own tasks before switching providers.';
    await setResult(page, second.id, { answer, parts: [{ text: answer, itemId: 'brief-answer', turnId: second.turnId!, finalCitations: [] }] });
    await expect(page.locator('.scheduled-result')).toHaveAttribute('data-run-id', second.id);
    await expect(page.locator('.scheduled-result')).toContainText('Three developments to watch');
    expect(await page.locator('.scheduled-result .thread-markdown p').evaluateAll((nodes) => nodes[1]!.getBoundingClientRect().top - nodes[0]!.getBoundingClientRect().bottom)).toBeGreaterThan(0);
    await expect(page.locator('.scheduled-history')).not.toHaveAttribute('open');
    await expect(page.locator('.scheduled-task-info')).not.toHaveAttribute('open');
    await expect(page.getByRole('button', { name: 'Pause schedule', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`task-result-${colorScheme}.png`) });
    }
    await page.locator('.scheduled-attention-history summary').click();
    await page.locator('.scheduled-attention-history button').click();
    await expect(page.locator('.scheduled-result')).toHaveAttribute('data-run-id', first.id);
    await expect(page.getByText('The news source could not be reached.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Acknowledge issue', exact: true }).click();
    const acknowledgement = (await commandCalls(page)).findLast((call) => call.cmd === 'automation/acknowledge');
    expect(acknowledgement?.args).toMatchObject({ id: first.id, issueKey: 'source-unavailable' });
  });

  test('attention beyond the first history page is discoverable from a successful result', async ({ page }) => {
    await createTask(page);
    await page.getByRole('button', { name: 'Collapse agent', exact: true }).click();
    const first = await page.evaluate(async () => {
      const task = (await window.lin!.automationRequest('list', {})).data[0]!;
      let first: string | null = null;
      for (let count = 0; count < 51; count++) {
        const run = (await window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: `history-${count}` })).runs[0]!;
        first ??= run.id;
      }
      return first!;
    });
    await setResult(page, first, { state: 'failed', answer: null, parts: [], issues: [
      { key: 'older-cause', text: 'The old delivery still needs review.', turnId: null, terminal: true, acknowledged: false },
    ] });
    await page.getByRole('button', { name: 'Expand agent', exact: true }).click();
    await expect(page.locator('.scheduled-result')).toContainText('The scheduled review was delivered.');
    const attention = page.locator('.scheduled-attention-history');
    await attention.locator('summary').click();
    await attention.getByRole('button', { name: 'Previous runs', exact: true }).click();
    await expect(attention.getByRole('button', { name: /Failed/ })).toBeVisible();
    await attention.getByRole('button', { name: /Failed/ }).click();
    await expect(page.locator('.scheduled-result')).toHaveAttribute('data-run-id', first);
    await expect(page.getByText('The old delivery still needs review.', { exact: true })).toBeVisible();
  });

  test('task rows expose timing and attention without copying generated result text', async ({ page }, testInfo) => {
    await createTask(page, 'AI morning brief');
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    const first = (await page.evaluate(() => window.lin!.automationRequest('runs', {}))).data[0]!;
    await setResult(page, first.id, { state: 'failed', answer: null, parts: [], issues: [
      { key: 'source', text: 'Provider diagnostics that must not become a list preview', turnId: first.turnId, terminal: true, acknowledged: false },
    ] });
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await createTask(page, 'Weekly reading roundup');
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await createTask(page, 'Review project changes');
    await page.getByRole('button', { name: 'Task actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Pause schedule', exact: true }).click();
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await expect(page.locator('.scheduled-task-row')).toHaveCount(3);
    await expect(page.locator('.scheduled-task-list')).toContainText('Needs your attention');
    await expect(page.locator('.scheduled-task-list')).not.toContainText('Provider diagnostics');
    await expect(page.locator('.scheduled-task-list')).not.toContainText('No result yet');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`task-list-${colorScheme}.png`) });
    }
    await page.getByRole('button', { name: /Needs attention/ }).click();
    await expect(page.locator('.scheduled-task-row')).toHaveCount(1);
    await expect(page.locator('.scheduled-task-row')).toContainText('AI morning brief');
  });

  test('a waiting run has its own status and replaces Run now with Stop run', async ({ page }) => {
    await createTask(page);
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    const run = (await page.evaluate(() => window.lin!.automationRequest('runs', {}))).data[0]!;
    await setResult(page, run.id, { state: 'waiting', answer: null, parts: [] });
    await expect(page.getByText('This task is waiting to start.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run now', exact: true })).toHaveCount(0);
    await expect(page.locator('.scheduled-result')).not.toContainText('No delivered answer');
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keeps a narrow pane navigable in ${colorScheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1100, height: 850 });
      await createTask(page);
      const workspace = page.locator('.scheduled-workspace');
      await expect(page.getByRole('button', { name: 'Back to tasks', exact: true })).toBeVisible();
      await expect(workspace.getByRole('button', { name: 'Run now', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
      await expect(page.locator('.scheduled-task-row', { hasText: 'Repository review' })).toBeVisible();
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`scheduled-tasks-${colorScheme}.png`) });
      expect(await workspace.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    });
  }
});
