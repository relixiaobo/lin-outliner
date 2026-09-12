import { expect, test, type Page } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

async function start(page: Page) {
  await openMockedApp(page);
  await page.getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
}
async function createTask(page: Page) {
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New task', exact: true });
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Repository review');
  await editor.getByRole('textbox', { name: 'Task', exact: true }).fill('Review the repository and report important changes.');
  await editor.getByRole('button', { name: 'Create task', exact: true }).click();
  const task = page.getByRole('dialog', { name: 'Task details', exact: true });
  await expect(task).toBeVisible();
  return task;
}

test('list selection opens the unified task window read-only; editing and canceling stay in that window', async ({ page }) => {
  await start(page);
  const task = await createTask(page);
  await expect(task.getByText('Review the repository and report important changes.', { exact: true })).toBeVisible();
  await expect(task.getByRole('textbox', { name: 'Task', exact: true })).toHaveCount(0);
  await expect(task.getByRole('heading', { name: 'Run history', exact: true })).toBeVisible();
  await task.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await editor.getByRole('textbox', { name: 'Task', exact: true }).fill('Unsaved instructions');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  const discard = page.getByRole('dialog', { name: 'Discard changes?', exact: true });
  await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(task).toBeVisible();
  await expect(task).not.toContainText('Unsaved instructions');
  await task.getByRole('button', { name: 'Close task', exact: true }).last().click();
  await expect(task).toBeHidden();
  const row = page.locator('.scheduled-task-row', { hasText: 'Repository review' });
  await row.click();
  await expect(task.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  expect((await commandCalls(page)).filter((call) => call.cmd === 'automation/update')).toHaveLength(0);
});

test('pause keeps dirty editing intact and the final save returns to the same task window', async ({ page }) => {
  await start(page); const task = await createTask(page);
  await task.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await editor.getByRole('textbox', { name: 'Task', exact: true }).fill('Keep this instruction while pausing.');
  await editor.getByRole('button', { name: 'Saved schedule actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pause saved schedule', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Task', exact: true })).toHaveText('Keep this instruction while pausing.');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(task).toContainText('Keep this instruction while pausing.');
  await expect(task.getByText('Paused', { exact: true })).toBeVisible();
  const update = (await commandCalls(page)).find((call) => call.cmd === 'automation/update')!;
  expect(update.args.expectedRevision).toBe(2); expect(update.args).not.toHaveProperty('status');
});

test('Run once enters the canonical conversation and Back restores the task window without changing the original chat draft', async ({ page }) => {
  await openMockedApp(page);
  await page.getByRole('textbox', { name: 'Message this Thread', exact: true }).fill('Keep my chat draft.');
  await page.getByRole('button', { name: 'Scheduled tasks', exact: true }).click();
  const task = await createTask(page);
  await task.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pause schedule', exact: true }).click();
  await task.getByRole('button', { name: 'Run once', exact: true }).click();
  await expect(task).toBeHidden();
  const conversation = page.locator('.scheduled-run-conversation');
  await expect(conversation).toContainText('Automation completed in the canonical Thread.');
  await conversation.getByRole('button', { name: 'Back to task', exact: true }).click();
  await expect(task).toBeVisible();
  await expect(task.getByText('Paused', { exact: true })).toBeVisible();
  await expect(task.locator('.scheduled-run-entry')).toHaveCount(1);
  await task.getByRole('button', { name: 'Close task', exact: true }).last().click();
  await page.getByRole('button', { name: 'Back to Threads', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message this Thread', exact: true })).toHaveText('Keep my chat draft.');
});

test('an opened task does not mark history read; clicking a run targets the owned completion Turn', async ({ page }) => {
  await start(page); const task = await createTask(page);
  const run = await page.evaluate(async () => {
    const task = (await window.lin!.automationRequest('list', {})).data[0]!;
    const run = (await window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'history' })).runs[0]!;
    const history = await window.lin!.agentCoreRequest('thread/turns/list', { threadId: run.threadId!, limit: 100, itemsView: 'full' });
    const original = history.data[0]!;
    const completion = { ...original, id: '01930000-0000-7000-8000-000000000090', startedAt: original.startedAt + 10,
      items: [{ type: 'agentMessage', id: 'completion-answer', text: 'The owned completion result.', phase: 'final_answer', provenance: { originThreadId: run.threadId, originTurnId: '01930000-0000-7000-8000-000000000090', originItemId: 'completion-answer' } }] };
    const host = (window as unknown as { __LIN_E2E__: { setMockThreadTurns: (id: string, turns: unknown[]) => void; setScheduledResult: (id: string, result: unknown) => void } }).__LIN_E2E__;
    host.setMockThreadTurns(run.threadId!, [original, completion]);
    host.setScheduledResult(run.id, { resultTurnId: completion.id, parts: [{ text: 'The owned completion result.', itemId: 'completion-answer', turnId: completion.id, finalCitations: [] }] });
    return { ...run, target: completion.id };
  });
  await expect(task.locator('.scheduled-run-entry')).toHaveCount(1);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'automation/runMarkRead')).toHaveLength(0);
  await task.locator('.scheduled-run-row').click();
  await expect(page.locator(`.scheduled-run-conversation [data-thread-turn-row="${run.target}"]`)).toBeVisible();
  await expect(page.locator('.scheduled-run-conversation [data-thread-item-id="completion-answer"]')).toBeInViewport();
  await expect.poll(async () => (await commandCalls(page)).filter((call) => call.cmd === 'automation/runMarkRead' && call.args.id === run.id).length).toBeGreaterThan(0);
});

test('unavailable conversations keep the task window open with an explicit error', async ({ page }) => {
  await start(page); const task = await createTask(page);
  await page.evaluate(async () => {
    const task = (await window.lin!.automationRequest('list', {})).data[0]!;
    await window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'unavailable-run' });
    const request = window.lin!.agentCoreRequest;
    window.lin!.agentCoreRequest = (async (method: string, input: unknown) => {
      if (method === 'thread/read') throw new Error('Conversation is unavailable');
      return request(method as never, input as never);
    }) as typeof request;
    const host = (window as unknown as { __LIN_E2E__: { setMockThreadTurns: (id: string, turns: unknown[]) => void } }).__LIN_E2E__;
    const run = (await window.lin!.automationRequest('runs', {})).data[0]!;
    host.setMockThreadTurns(run.threadId!, []);
  });
  await expect(task.locator('.scheduled-run-row')).toHaveCount(1);
  await task.locator('.scheduled-run-row').click();
  await expect(task).toBeVisible();
  await expect(task.getByRole('alert')).toContainText('unavailable');
  await expect(page.locator('.scheduled-run-conversation')).toHaveCount(0);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`task window and list hover remain understandable and stable in ${colorScheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme }); await start(page);
    const task = await createTask(page);
    await page.screenshot({ path: info.outputPath(`task-window-${colorScheme}.png`), animations: 'disabled' });
    await task.getByRole('button', { name: 'Close task', exact: true }).last().click();
    const row = page.locator('.scheduled-task-row', { hasText: 'Repository review' });
    const rect = await row.boundingBox(); await row.hover(); expect(await row.boundingBox()).toEqual(rect);
    expect(await row.evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`list-hover-${colorScheme}.png`), animations: 'disabled' });
  });
}

test('a historical message is located inside a long virtualized run conversation', async ({ page }) => {
  await start(page); const task = await createTask(page);
  await page.evaluate(async () => {
    const task = (await window.lin!.automationRequest('list', {})).data[0]!;
    const run = (await window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'long-history' })).runs[0]!;
    const { data } = await window.lin!.agentCoreRequest('thread/turns/list', { threadId: run.threadId!, limit: 100, itemsView: 'full' });
    const template = data[0]!;
    const turns = Array.from({ length: 24 }, (_, i) => ({ ...template, id: `01930000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
      startedAt: template.startedAt + i * 100, completedAt: template.startedAt + i * 100 + 10,
      items: [{ type: 'agentMessage', id: `answer-${i}`, phase: 'final_answer', text: `Canonical result ${i}\n\n` + 'Detailed work evidence.\n\n'.repeat(8), provenance: { originThreadId: run.threadId, originTurnId: template.id, originItemId: `answer-${i}` } }] }));
    const host = (window as unknown as { __LIN_E2E__: { setMockThreadTurns: (id: string, turns: unknown[]) => void; setScheduledResult: (id: string, result: unknown) => void } }).__LIN_E2E__;
    host.setMockThreadTurns(run.threadId!, turns);
    host.setScheduledResult(run.id, { resultTurnId: turns[12]!.id, parts: [{ itemId: 'answer-12', turnId: turns[12]!.id, text: 'Canonical result 12', finalCitations: [] }] });
  });
  await task.locator('.scheduled-run-row').click();
  await expect(page.locator('.scheduled-run-conversation [data-thread-item-id="answer-12"]')).toBeInViewport();
  await expect(page.locator('.scheduled-run-conversation .thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
});

test('confirmed Run once actions use distinct requests without resaving the task', async ({ page }) => {
  await start(page); const task = await createTask(page);
  await task.getByRole('button', { name: 'Run once', exact: true }).click();
  await page.getByRole('button', { name: 'Back to task', exact: true }).click();
  await task.getByRole('button', { name: 'Run once', exact: true }).click();
  await page.getByRole('button', { name: 'Back to task', exact: true }).click();
  const calls = await commandCalls(page); const runs = calls.filter((call) => call.cmd === 'automation/startNow');
  expect(runs).toHaveLength(2); expect(runs[0]!.args.requestId).not.toBe(runs[1]!.args.requestId);
  expect(calls.filter((call) => call.cmd === 'automation/create')).toHaveLength(1);
});

test('View current run returns to the unchanged editing draft without silently saving it', async ({ page }) => {
  await start(page); const task = await createTask(page);
  await page.evaluate(async () => {
    const task = (await window.lin!.automationRequest('list', {})).data[0]!;
    const run = (await window.lin!.automationRequest('startNow', { id: task.id, expectedRevision: task.revision, requestId: 'already-running' })).runs[0]!;
    (window as unknown as { __LIN_E2E__: { setScheduledResult: (id: string, result: unknown) => void } }).__LIN_E2E__.setScheduledResult(run.id, { state: 'running' });
  });
  await task.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await edit.getByRole('textbox', { name: 'Task', exact: true }).fill('My pending draft.');
  await edit.getByRole('button', { name: 'View current run', exact: true }).click();
  await expect(page.locator('.scheduled-run-conversation')).toBeVisible();
  await page.getByRole('button', { name: 'Back to task', exact: true }).click();
  await expect(edit.getByRole('textbox', { name: 'Task', exact: true })).toHaveText('My pending draft.');
  expect((await commandCalls(page)).filter((call) => call.cmd === 'automation/update')).toHaveLength(0);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'automation/startNow')).toHaveLength(1);
});

test('archive and restore retain the task window and restore paused', async ({ page }) => {
  await start(page); const task = await createTask(page);
  await task.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(task.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await expect(task.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
  await task.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
  await expect(task.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
  await expect(task.getByText('Paused', { exact: true })).toBeVisible();
});
