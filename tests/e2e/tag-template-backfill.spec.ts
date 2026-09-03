import { expect, test, type Page } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  ids,
  nodeById,
  openMockedApp,
  ordinaryChildIds,
  row,
} from './outlinerMock';

async function invokeDocumentCommand(page: Page, cmd: string, args: Record<string, unknown>) {
  await page.evaluate(async ({ cmd, args }) => {
    const win = window as typeof window & {
      lin?: { invoke: <T>(command: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
    };
    const outcome = await win.lin!.invoke<{ update: { projection: unknown } }>(cmd, args);
    win.__LIN_E2E__?.emitDocumentEvent({
      type: 'projection_changed',
      origin: 'user',
      projection: outcome.update.projection,
      timestamp: Date.now(),
    });
  }, { cmd, args });
}

async function templateRuntimeCalls(page: Page) {
  const calls = await commandCalls(page);
  const carriesTemplateChange = (value: unknown) => {
    const input = value as {
      changeSet?: { operations?: Array<{ op?: string; action?: string }> };
      diff?: { normalizedChangeSet?: { operations?: Array<{ op?: string; action?: string }> } };
    };
    const operations = input.changeSet?.operations ?? input.diff?.normalizedChangeSet?.operations ?? [];
    return operations.some((operation) => operation.op === 'template' && operation.action === 'apply');
  };
  return {
    diffs: calls.filter((call) => call.cmd === 'outline/preview' && carriesTemplateChange(call.args)),
    applies: calls.filter((call) => (
      call.cmd === 'outline/apply' || call.cmd === 'outline/transact'
    ) && carriesTemplateChange(call.args)),
  };
}

test.describe('tag template seed backfill', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('previews exact counts, confirms writes, and skips zero-addition apply', async ({ page }) => {
    await invokeDocumentCommand(page, 'apply_tag', { nodeId: ids.alpha, tagId: ids.projectTag });
    await invokeDocumentCommand(page, 'apply_tag', { nodeId: ids.beta, tagId: ids.projectTag });
    await invokeDocumentCommand(page, 'create_node', {
      parentId: ids.projectTag,
      index: null,
      text: 'Kickoff notes',
    });
    await invokeDocumentCommand(page, 'create_node', {
      parentId: ids.projectTag,
      index: null,
      text: 'Success criteria',
    });

    const tag = row(page, ids.alpha).locator('.tag-badge', { hasText: 'project' }).first();
    await tag.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'project tag actions' });
    await menu.getByRole('menuitem', { name: 'Apply template to tagged nodes' }).click();

    const dialog = page.getByRole('dialog', { name: 'Apply #project template?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('This adds 4 template children to 2 tagged nodes.');
    expect(ordinaryChildIds(await nodeById(page, ids.alpha))).toEqual([]);
    expect(ordinaryChildIds(await nodeById(page, ids.beta))).toEqual([]);
    expect((await templateRuntimeCalls(page)).applies).toHaveLength(0);

    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(row(page, ids.alpha).getByRole('button', { name: 'Open project tag' })).toBeFocused();
    await expect.poll(async () => ordinaryChildIds(await nodeById(page, ids.alpha)).length).toBe(2);
    await expect.poll(async () => ordinaryChildIds(await nodeById(page, ids.beta)).length).toBe(2);
    const alpha = await nodeById(page, ids.alpha);
    const beta = await nodeById(page, ids.beta);
    expect(ordinaryChildIds(alpha)).toHaveLength(2);
    expect(ordinaryChildIds(beta)).toHaveLength(2);
    expect((await templateRuntimeCalls(page)).diffs).toHaveLength(1);
    expect((await templateRuntimeCalls(page)).applies).toHaveLength(1);

    const projection = await e2eProjection(page);
    const byId = new Map(projection.nodes.map((node) => [node.id, node]));
    const templateIds = projection.nodes
      .filter((node) => node.parentId === ids.projectTag && (
        node.content.text === 'Kickoff notes' || node.content.text === 'Success criteria'
      ))
      .map((node) => node.id);
    const instanceTemplateIds = [alpha, beta].map((node) => (
      ordinaryChildIds(node).map((childId) => byId.get(childId)?.templateId)
    ));
    expect(instanceTemplateIds).toEqual([
      templateIds,
      templateIds,
    ]);

    await tag.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Apply template to tagged nodes' }).click();
    await expect.poll(async () => (
      (await templateRuntimeCalls(page)).diffs.length
    )).toBe(2);
    await expect(dialog).toHaveCount(0);
    expect((await templateRuntimeCalls(page)).applies).toHaveLength(1);
    await expect(row(page, ids.alpha).getByRole('button', { name: 'Open project tag' })).toBeFocused();
  });
});
