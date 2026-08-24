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
          outline: {
            request: (request: { requestId: string; command: string; input: unknown }) => Promise<{
              ok: boolean;
              data?: unknown;
              error?: { message?: string };
            }>;
          };
        };
      };
      const request = async (command: string, input: unknown) => {
        const response = await win.lin!.outline.request({
          requestId: `checkbox-wrap-${command}`,
          command,
          input,
        });
        if (!response.ok) throw new Error(response.error?.message ?? `Outline ${command} failed`);
        return response.data;
      };
      const diff = await request('diff', {
        changeSet: {
          protocolVersion: 1,
          kind: 'outline.changeset',
          operations: [{
            op: 'create',
            parents: {
              target: { selector: { by: 'id', id: parentId }, cardinality: 'one' },
            },
            index: null,
            nodes: [{
              id: 'cbx-long',
              content: { text, marks: [], inlineRefs: [] },
              checkbox: true,
              children: [],
            }],
          }],
        },
      });
      await request('apply', {
        diff,
        acknowledgeDestructive: false,
      });
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
