import { expect, test, type Page } from '@playwright/test';
import {
  e2eProjection,
  ids,
  nodeById,
  openMockedApp,
  row,
  rowEditor,
} from './outlinerMock';

async function todayChildren(page: Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children ?? [];
}

async function placeCursor(page: Page, nodeId: string, placement: 'start' | 'end') {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element, targetPlacement) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(targetPlacement === 'start');
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, placement);
  await page.waitForTimeout(25);
}

async function placeCursorAtTextOffset(page: Page, nodeId: string, offset: number) {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element, targetOffset) => {
    const selection = window.getSelection();
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = targetOffset;
    let target: Node | null = null;
    let targetNodeOffset = 0;

    while (true) {
      const next = walker.nextNode();
      if (!next) break;
      const length = next.textContent?.length ?? 0;
      if (remaining <= length) {
        target = next;
        targetNodeOffset = remaining;
        break;
      }
      remaining -= length;
    }

    if (target) {
      range.setStart(target, targetNodeOffset);
      range.collapse(true);
    } else {
      range.selectNodeContents(element);
      range.collapse(false);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, offset);
  await page.waitForTimeout(25);
}

async function selectEditorContents(page: Page, nodeId: string) {
  const editor = rowEditor(page, nodeId);
  await editor.click();
  await editor.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.waitForTimeout(25);
}

async function pasteIntoFocusedEditor(page: Page, text: string) {
  await page.evaluate((pasteText) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasteText);
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }));
  }, text);
}

test.describe('outliner row editing parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('Enter at the end of a row creates an empty sibling and focuses it', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await todayChildren(page)).length).toBe(4);
    const children = await todayChildren(page);
    const createdId = children[1];
    expect(createdId).toBeTruthy();
    expect((await nodeById(page, createdId))?.content.text).toBe('');
    await expect(rowEditor(page, createdId)).toBeFocused();

    const placeholderStyle = await row(page, createdId).locator('.row-editor').first().evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        display: style.display,
        opacity: Number(style.opacity),
      };
    });
    expect(placeholderStyle.display).not.toBe('none');
    expect(placeholderStyle.opacity).toBe(0);
  });

  test('> converts the current empty row to a field row without moving it', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    const childrenAfterEnter = await todayChildren(page);
    const createdId = childrenAfterEnter[1];
    expect(createdId).toBeTruthy();
    await expect(rowEditor(page, createdId)).toBeFocused();

    await page.keyboard.type('>');

    await expect.poll(async () => (await nodeById(page, createdId))?.type).toBe('fieldEntry');
    expect((await todayChildren(page))[1]).toBe(createdId);
    await expect(row(page, createdId).locator('.field-name-input')).toBeVisible();

    const alphaBox = await row(page, ids.alpha).boundingBox();
    const fieldBox = await row(page, createdId).boundingBox();
    const betaBox = await row(page, ids.beta).boundingBox();
    expect(alphaBox).toBeTruthy();
    expect(fieldBox).toBeTruthy();
    expect(betaBox).toBeTruthy();
    expect(fieldBox!.y).toBeGreaterThan(alphaBox!.y);
    expect(fieldBox!.y).toBeLessThan(betaBox!.y);
  });

  test('clearing row text keeps the row height stable', async ({ page }) => {
    const rowBody = row(page, ids.alpha).locator('> .row');
    const editorShell = rowBody.locator('.row-editor').first();
    const heightBefore = (await rowBody.boundingBox())?.height ?? 0;

    await selectEditorContents(page, ids.alpha);
    await page.keyboard.press('Backspace');

    await expect(editorShell).toHaveClass(/is-empty/);
    await expect.poll(async () => (await rowBody.boundingBox())?.height ?? 0).toBeLessThanOrEqual(heightBefore + 1);
  });

  test('pending-focus empty rows suppress placeholder before DOM focus lands', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.setAttribute('data-testid', 'pending-focus-placeholder-fixture');
      fixture.innerHTML = `
        <div class="row-editor is-empty is-focus-pending" data-placeholder="Type here">
          <div class="ProseMirror" contenteditable="true"></div>
        </div>
      `;
      document.body.appendChild(fixture);
    });

    const placeholderStyle = await page.locator('[data-testid="pending-focus-placeholder-fixture"] .row-editor').evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return {
        display: style.display,
        opacity: Number(style.opacity),
      };
    });

    expect(placeholderStyle.display).not.toBe('none');
    expect(placeholderStyle.opacity).toBe(0);
  });

  test('clicking row text right-side blank space focuses the editor at the row end', async ({ page }) => {
    const contentLine = row(page, ids.alpha).locator('> .row .row-content-line').first();
    const box = await contentLine.boundingBox();
    expect(box).toBeTruthy();

    await contentLine.click({
      position: {
        x: Math.max(1, (box?.width ?? 1) - 8),
        y: Math.max(1, (box?.height ?? 1) / 2),
      },
    });

    await expect(rowEditor(page, ids.alpha)).toBeFocused();
    await page.keyboard.type('!');

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Alpha!');
  });

  test('typing in the middle of a node preserves the cursor instead of jumping to the end', async ({ page }) => {
    await placeCursorAtTextOffset(page, ids.alpha, 2);

    await page.keyboard.type('X');
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('AlXpha');
    await page.waitForTimeout(50);

    await page.keyboard.type('Y');
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('AlXYpha');
  });

  test('Backspace at the start of an empty row deletes it and returns focus upward', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('Enter');

    const createdId = (await todayChildren(page))[1];
    await expect(rowEditor(page, createdId)).toBeFocused();

    await page.keyboard.press('Backspace');

    await expect(row(page, createdId)).toHaveCount(0);
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
  });

  test('Tab and Shift+Tab while editing move the current row without losing focus', async ({ page }) => {
    await placeCursor(page, ids.beta, 'end');
    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);
    await expect(rowEditor(page, ids.beta)).toBeFocused();

    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
    await expect(rowEditor(page, ids.beta)).toBeFocused();
  });

  test('Arrow navigation at editor boundaries moves focus through visible rows', async ({ page }) => {
    await placeCursor(page, ids.alpha, 'end');
    await page.keyboard.press('ArrowDown');

    await expect(rowEditor(page, ids.beta)).toBeFocused();

    await placeCursor(page, ids.beta, 'start');
    await page.keyboard.press('ArrowUp');

    await expect(rowEditor(page, ids.alpha)).toBeFocused();
  });

  test('Escape in an editor exits to selected row mode', async ({ page }) => {
    await rowEditor(page, ids.alpha).click();
    await page.keyboard.press('Escape');

    await expect(row(page, ids.alpha).locator('> .row')).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.alpha)).not.toBeFocused();
  });

  test('multiline paste in a row updates the current row and inserts parsed child and sibling rows', async ({ page }) => {
    await selectEditorContents(page, ids.alpha);
    await pasteIntoFocusedEditor(page, 'Pasted parent\n  Pasted child\nPasted sibling');

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Pasted parent');
    const alpha = await nodeById(page, ids.alpha);
    const childId = alpha?.children[0];
    expect(childId).toBeTruthy();
    expect((await nodeById(page, childId!))?.content.text).toBe('Pasted child');

    const children = await todayChildren(page);
    const alphaIndex = children.indexOf(ids.alpha);
    const siblingId = children[alphaIndex + 1];
    expect((await nodeById(page, siblingId))?.content.text).toBe('Pasted sibling');
    expect(children[alphaIndex + 2]).toBe(ids.beta);
    await expect(rowEditor(page, siblingId)).toBeFocused();
  });

});
