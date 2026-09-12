import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NodeProjection } from '../../src/core/types';
import type { Change, Diff, Operation } from '../../src/outline/contract';
import { readCompleteDocumentProjection } from '../../src/outline/client/documentProjection';
import { TimelineMemoryStore } from '../../src/main/agent/extensions/memory/TimelineMemoryStore';
import type { OutlineMutationOptions } from '../../src/main/outlineDocumentService';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

test('Memory publication keeps normal folds, editing selection and scroll in both themes', async ({}, testInfo) => {
  const userDataDir = await mkdtemp('/tmp/tenon-memory-quality-');
  await mkdir(join(userDataDir, 'config'));
  await writeFile(join(userDataDir, 'config/settings.jsonc'), '{"appearance":{"language":"en"}}');
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    const page = smoke.window;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready' });
    const request = async <T,>(command: string, input: unknown): Promise<T> => page.evaluate(async ({ command, input }) => {
      const result = await window.lin!.outline.request({ requestId: crypto.randomUUID(), command, input });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data;
    }, { command, input }) as Promise<T>;
    let snapshot = await readCompleteDocumentProjection<NodeProjection>(request);
    const apply = async (operations: readonly Change[], options: OutlineMutationOptions = {}) => {
      const diff = await request<Diff>('preview', { changeSet: {
        protocolVersion: 1, kind: 'outline.changeset', operations,
        idempotencyKey: options.idempotencyKey ?? randomUUID(), ...(options.source ? { source: options.source } : {}),
      } });
      await request<Operation>('apply', { diff });
      snapshot = await readCompleteDocumentProjection<NodeProjection>(request);
    };
    // Use the actual Memory publication builder through real preload/Host/Runtime
    // transport. Only conversation extraction is absent from this UI-specific test.
    const timeline = new TimelineMemoryStore({
      getProjection: () => snapshot.projection,
      runChanges: apply,
      runPlannedChanges: async (build, options) => {
        snapshot = await readCompleteDocumentProjection<NodeProjection>(request);
        const changes = await build(snapshot.projection);
        if (changes) await apply(changes, options);
      },
      log: async () => [],
    });
    const parent = snapshot.projection.todayId;
    const editorId = `node:${randomUUID()}`;
    await apply([{ op: 'create', placement: { kind: 'last', parent: { target: { selector: { by: 'id', id: parent }, cardinality: 'one' } } },
      nodes: [
        { id: editorId, content: { text: 'Keep my editing selection', marks: [], inlineRefs: [] }, children: [] },
        ...Array.from({ length: 35 }, (_, i) => ({ content: { text: `Ordinary note ${i}`, marks: [], inlineRefs: [] }, children: [] })),
      ],
    }]);
    const sourceDate = snapshot.projection.nodes.find((node) => node.id === parent)!.content.text;
    const containerId = `node:${randomUUID()}`;
    const firstId = `node:${randomUUID()}`;
    const publish = async (nodeId: string, text: string, generation: number) => timeline.publish({
      operationId: `memory:stage1:${randomUUID()}`, generation, digest: `quality-${generation}`,
      dates: [{ sourceDate, containerId, records: [{ nodeId, text, category: 'belief', parentId: containerId }] }],
    });
    await publish(firstId, 'A useful direct record', 1);
    const container = page.locator(`[data-node-id="${containerId}"]`).first();
    await container.scrollIntoViewIfNeeded();
    await expect(container.locator('.row-chevron-shell')).not.toHaveClass(/expanded/);
    await expect(container.locator('.ProseMirror').first()).toHaveText(/^Memory\s*#mem-day$/);
    await expect(container).toContainText('mem-day');
    await expect(page.locator(`[data-node-id="${firstId}"]`)).toHaveCount(0);
    await container.locator('> .row').hover();
    await container.locator('.row-chevron-button').click();
    await expect(page.locator(`[data-node-id="${firstId}"]`)).toBeVisible();
    const editor = page.locator(`[data-node-id="${editorId}"] .ProseMirror`).first();
    for (const [i, theme] of ['light', 'dark'].entries()) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme as 'light' | 'dark'; }, theme);
      await page.emulateMedia({ colorScheme: theme as 'light' | 'dark', reducedMotion: 'reduce' });
      expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
      await editor.click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+ArrowRight');
      // Settle the preceding keyboard selection's ProseMirror scroll request.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const before = await editor.evaluate((element) => ({
        selected: getSelection()?.toString(), focused: element.contains(document.activeElement),
        top: element.getBoundingClientRect().top,
      }));
      expect(before.focused).toBe(true);
      expect(before.selected?.length).toBeGreaterThan(0);
      await publish(`node:${randomUUID()}`, `Additional useful record ${i}`, i + 2);
      await expect(container.locator('.row-chevron-shell')).toHaveClass(/expanded/);
      const after = await editor.evaluate((element) => ({
        selected: getSelection()?.toString(), focused: element.contains(document.activeElement),
        top: element.getBoundingClientRect().top,
      }));
      expect(after).toEqual(before);
      await container.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`memory-node-${theme}.png`) });
    }
    await container.locator('> .row').hover();
    await container.locator('.row-chevron-button').click();
    await publish(`node:${randomUUID()}`, 'Another retained record', 4);
    await expect(container.locator('.row-chevron-shell')).not.toHaveClass(/expanded/);
    // The core tests exercise midnight, pending evidence and title admission.
    // This UI test applies an admitted completed-day title through real transport.
    await editor.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const beforeTitle = await editor.evaluate((element) => ({
      selected: getSelection()?.toString(), focused: element.contains(document.activeElement), top: element.getBoundingClientRect().top,
    }));
    await timeline.applyConsolidation(`memory:stage2:${randomUUID()}`, 5, 'completed-day-title', [{
      nodeId: containerId, action: 'update', text: 'A compass for clearer reports',
    }]);
    expect(snapshot.projection.nodes.find((node) => node.id === containerId)?.content.text).toBe('A compass for clearer reports');
    await expect(container.locator('.ProseMirror').first()).toHaveText(/^A compass for clearer reports\s*#mem-day$/);
    expect(await editor.evaluate((element) => ({
      selected: getSelection()?.toString(), focused: element.contains(document.activeElement), top: element.getBoundingClientRect().top,
    }))).toEqual(beforeTitle);
    await expect(container.locator('.row-chevron-shell')).not.toHaveClass(/expanded/);
    await container.locator('> .row').hover();
    await container.locator('.row-chevron-button').click();
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await container.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`memory-title-${theme}.png`) });
    }

  } finally {
    await closeSmokeApp(smoke);
  }
});
