import { expect, test } from '@playwright/test';
import { ids, openMockedApp, row, rowBody } from './outlinerMock';

// A long checkbox-row content must wrap BESIDE the checkbox (a hanging indent),
// never drop to its own line under the checkbox. Regression guard for the bug
// where `.row-editor` (inline-block, max-width:100%) could not share the first
// line with the 16px checkbox + 5px gap and fell to the next line entirely.
test.describe('outliner checkbox row wrapping', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('long text after a checkbox wraps beside it, not below', async ({ page }) => {
    const longText =
      'This is a deliberately long todo line that must wrap across several ' +
      'visual lines so we can prove the wrapped text stays in a column to the ' +
      'right of the checkbox instead of dropping onto its own line underneath it.';

    await page.evaluate(async ({ parentId, text }) => {
      const win = window as unknown as {
        lin?: {
          invoke: (cmd: string, args?: Record<string, unknown>) =>
            Promise<{ focus?: { nodeId: string }; update?: { projection?: unknown } }>;
        };
        __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
      };
      const emit = (projection: unknown) => {
        if (!projection) return;
        win.__LIN_E2E__?.emitDocumentEvent({
          type: 'projection_changed',
          origin: 'user',
          projection,
          timestamp: Date.now(),
        });
      };
      const created = await win.lin!.invoke('create_node', {
        parentId,
        index: null,
        text,
        id: 'cbx-long',
      });
      emit(created.update?.projection);
      // Attach the built-in Done system field so the node's own row shows a
      // checkbox (derived from the same completedAt the field reads).
      const field = await win.lin!.invoke('create_inline_field', {
        parentId: 'cbx-long',
        index: null,
        name: 'Done',
        fieldType: 'plain',
      });
      const entryId = field.focus!.nodeId;
      const reused = await win.lin!.invoke('reuse_field_definition', {
        entryId,
        targetDefId: 'sys:done',
      });
      emit(reused.update?.projection ?? field.update?.projection);
    }, { parentId: ids.today, text: longText });

    const body = rowBody(page, 'cbx-long');
    const checkbox = body.locator('.done-checkbox');
    const editor = body.locator('.row-content-line > .row-editor').first();
    await expect(checkbox).toHaveCount(1);
    await expect(editor).toBeVisible();

    const checkboxBox = await checkbox.boundingBox();
    const editorBox = await editor.boundingBox();
    expect(checkboxBox).toBeTruthy();
    expect(editorBox).toBeTruthy();

    // The editor must start to the right of the checkbox (beside it)…
    expect(editorBox!.x).toBeGreaterThanOrEqual(checkboxBox!.x + checkboxBox!.width - 1);
    // …and its first line must share the checkbox's line, not sit a row below it.
    expect(Math.abs(editorBox!.y - checkboxBox!.y)).toBeLessThan(checkboxBox!.height);
    // The content must actually wrap (proving the hanging indent holds for >1 line).
    expect(editorBox!.height).toBeGreaterThan(checkboxBox!.height * 1.5);
  });
});
