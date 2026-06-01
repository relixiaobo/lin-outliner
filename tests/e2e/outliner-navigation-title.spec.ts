import { expect, test } from '@playwright/test';
import {
  commandCalls,
  ids,
  nodeById,
  openMockedApp,
  row,
  rowEditor,
} from './outlinerMock';

function expectClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);
}

test.describe('outliner navigation and page title parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('clicking a node bullet drills into that node page', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
  });

  test('panel breadcrumb back returns to the previous page without undoing document edits', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');

    await page.getByRole('button', { name: 'Previous page' }).first().click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-13');
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & {
        __LIN_E2E__?: { calls: Array<{ cmd: string }> };
      }).__LIN_E2E__?.calls.filter((call) => call.cmd === 'undo' || call.cmd === 'redo').length ?? 0
    ))).toBe(0);
  });

  test('panel back button tracks history depth while keyboard navigates pages', async ({ page }) => {
    // The dissolved TopBar removed the global Back/Forward chrome buttons; page
    // history now lives on the per-pane "Previous page" button (back, with a
    // disabled state) plus the keyboard (Alt+Arrow / Cmd+[ / Cmd+]) for forward.
    const back = page.getByRole('button', { name: 'Previous page' }).first();
    await expect(back).toBeDisabled();

    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
    await expect(back).toBeEnabled();

    await page.getByRole('button', { name: 'Collapse sidebar' }).focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-13');
    await expect(back).toBeDisabled();

    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
    await expect(back).toBeEnabled();

    await back.click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-13');
    await row(page, ids.beta).getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Beta');

    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & {
        __LIN_E2E__?: { calls: Array<{ cmd: string }> };
      }).__LIN_E2E__?.calls.filter((call) => call.cmd === 'undo' || call.cmd === 'redo').length ?? 0
    ))).toBe(0);
  });

  test('keyboard back and forward navigate page history without document undo', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
    await page.getByRole('button', { name: 'Collapse sidebar' }).focus();

    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-13');

    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & {
        __LIN_E2E__?: { calls: Array<{ cmd: string }> };
      }).__LIN_E2E__?.calls.filter((call) => call.cmd === 'undo' || call.cmd === 'redo').length ?? 0
    ))).toBe(0);
  });

  test('Cmd+Shift+D opens today when there is no active row selection', async ({ page }) => {
    const todayLabel = await page.evaluate(() => {
      const date = new Date();
      const year = String(date.getFullYear()).padStart(4, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    });
    await row(page, ids.beta).click({ modifiers: ['Meta'] });
    await page.keyboard.press('Escape');

    await page.keyboard.press('Meta+Shift+D');

    await expect(page.locator('.panel-title-editor').first()).toContainText(todayLabel);
    expect((await commandCalls(page)).map((call) => call.cmd)).toContain('ensure_date_node');
  });

  test('page-history navigation keeps the tab outliner context when a debug panel shares the tab', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: 'Open agent debug' }).click();
    await expect(page.locator('.sidebar-tab.active')).toContainText('Agent System');
    await expect(page.locator('.sidebar-tab.active .sidebar-tab-segment.is-active svg')).toHaveCount(1);
    const debugIconSlot = await page.locator('.sidebar-tab.active .sidebar-tab-segment.is-active .sidebar-tab-segment-icon').evaluate((icon) => {
      const rect = icon.getBoundingClientRect();
      return {
        height: Math.round(rect.height),
        width: Math.round(rect.width),
      };
    });
    expect(debugIconSlot).toEqual({ height: 16, width: 16 });

    // The dissolved TopBar (#57) removed the global Back/Forward chrome. The
    // outliner pane keeps its "Previous page" back button even when an agent
    // debug panel shares the tab; clicking it re-activates the outliner context.
    const back = page.getByRole('button', { name: 'Previous page' }).first();
    await expect(back).toBeEnabled();
    await back.click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-13');
    await expect(page.locator('.sidebar-tab.active')).toContainText('2026-05-13');

    // Forward history survives the round trip; keyboard forward returns to the
    // drilled page (the new shell exposes forward through the keyboard only).
    await page.getByRole('button', { name: 'Collapse sidebar' }).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
  });

  test('sticky breadcrumb absorbs the current page title while the panel scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 360 });
    const projection = await page.evaluate(async (todayId) => {
      const win = window as typeof window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      let latestProjection: unknown = null;
      for (let index = 0; index < 14; index += 1) {
        const outcome = await win.lin!.invoke<{ projection: unknown }>('create_node', {
          parentId: todayId,
          index: null,
          text: `Scroll filler ${index + 1}`,
        });
        latestProjection = outcome.projection;
      }
      return latestProjection;
    }, ids.today);
    await page.evaluate((nextProjection) => {
      (window as typeof window & {
        __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
      }).__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection: nextProjection });
    }, projection);

    const firstPanel = page.locator('.outline-panel-surface').first();
    await expect(firstPanel.locator('[data-current-page-title]')).toHaveCount(0);

    await firstPanel.locator('.main-panel').evaluate((element) => {
      element.scrollTop = 240;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await expect(firstPanel.locator('[data-current-page-title]')).toHaveText('2026-05-13');
    const metrics = await firstPanel.evaluate((panel) => {
      const breadcrumb = panel.querySelector('.panel-sticky-breadcrumb')?.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      if (!breadcrumb) throw new Error('missing sticky breadcrumb');
      return {
        breadcrumbTop: breadcrumb.top,
        panelTop: panelBox.top,
      };
    });
    expect(Math.abs(metrics.breadcrumbTop - metrics.panelTop)).toBeLessThanOrEqual(1);
  });

  test('breadcrumb leading aligns to outliner columns when content fills the panel', async ({ page }) => {
    await page.setViewportSize({ width: 1900, height: 900 });
    await page.getByTitle('New tab').click();
    await expect(page.locator('.outline-panel-surface')).toHaveCount(1);

    const measure = async () => page.locator('.outline-panel-surface').first().evaluate((panel) => {
      const backControl = panel.querySelector('.panel-page-back-button')?.getBoundingClientRect();
      const origin = panel.querySelector('.panel-breadcrumb-origin')?.getBoundingClientRect();
      const rowChevron = panel.querySelector('.row-chevron-button')?.getBoundingClientRect();
      const rowBullet = panel.querySelector('.row-bullet-button')?.getBoundingClientRect();
      const title = panel.querySelector('.panel-title-row')?.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      if (!backControl || !origin || !rowChevron || !rowBullet || !title) {
        throw new Error('missing breadcrumb or outliner alignment target');
      }
      return {
        backLeft: backControl.left,
        originLeft: origin.left,
        originRight: origin.right,
        rowBulletLeft: rowBullet.left,
        rowBulletRight: rowBullet.right,
        rowChevronLeft: rowChevron.left,
        titleLeft: title.left,
        panelLeft: panelBox.left,
      };
    });

    const wide = await measure();
    expect(wide.backLeft - wide.panelLeft).toBeGreaterThanOrEqual(4);
    expect(wide.titleLeft - wide.backLeft).toBeGreaterThan(100);

    await page.setViewportSize({ width: 900, height: 700 });
    const narrow = await measure();
    // When content fills the panel (no centring inset) the outliner rows sit flush at
    // the panel's leading edge, and the breadcrumb leading is engineered to start at
    // that same edge (breadcrumb.css pulls it left by the chevron column). The 24px
    // back IconButton and the 15px row chevron therefore share a left edge — not a
    // centre, since their control sizes differ — so assert leading-edge alignment, the
    // contract the CSS actually maintains. The origin sits over the bullet column.
    expect(Math.abs(narrow.backLeft - narrow.rowChevronLeft)).toBeLessThanOrEqual(1);
    expect(narrow.originLeft).toBeLessThan(narrow.rowBulletRight);
    expect(narrow.originRight).toBeGreaterThan(narrow.rowBulletLeft);
  });

  test('disabled navigation and breadcrumb controls use design-system affordances', async ({ page }) => {
    const metrics = await page.evaluate(() => {
      // The TopBar dissolved (#57) so there are no global Back/Forward chrome
      // buttons; the per-pane "Previous page" back button carries the disabled
      // affordance at the root page, alongside the breadcrumb controls.
      const panelBack = document.querySelector('.panel-page-back-button');
      const breadcrumb = document.querySelector('.panel-breadcrumb');
      const origin = document.querySelector('.panel-breadcrumb-origin');
      const divider = document.querySelector('.panel-breadcrumb-divider');
      if (!(panelBack instanceof HTMLElement)
        || !(breadcrumb instanceof HTMLElement)
        || !(origin instanceof HTMLElement)
        || !(divider instanceof HTMLElement)) {
        throw new Error('missing navigation or breadcrumb controls');
      }
      const panelBackStyle = getComputedStyle(panelBack);
      const breadcrumbStyle = getComputedStyle(breadcrumb);
      const originBox = origin.getBoundingClientRect();
      const panelBackBox = panelBack.getBoundingClientRect();
      const disabledColorProbe = document.createElement('span');
      disabledColorProbe.style.color = 'var(--text-disabled)';
      document.body.appendChild(disabledColorProbe);
      const disabledColor = getComputedStyle(disabledColorProbe).color;
      disabledColorProbe.remove();
      return {
        breadcrumbFontSize: breadcrumbStyle.fontSize,
        breadcrumbLineHeight: breadcrumbStyle.lineHeight,
        disabledColor,
        dividerMarginLeft: getComputedStyle(divider).marginLeft,
        originHeight: originBox.height,
        originWidth: originBox.width,
        panelBackColor: panelBackStyle.color,
        panelBackHeight: panelBackBox.height,
        panelBackWidth: panelBackBox.width,
      };
    });

    expect(metrics.panelBackColor).toBe(metrics.disabledColor);
    expect(metrics.panelBackWidth).toBe(24);
    expect(metrics.panelBackHeight).toBe(24);
    expect(metrics.originWidth).toBe(18);
    expect(metrics.originHeight).toBe(18);
    expect(metrics.breadcrumbFontSize).toBe('13px');
    expect(metrics.breadcrumbLineHeight).toBe('20px');
    expect(metrics.dividerMarginLeft).toBe('6px');
  });

  test('collapsed breadcrumb more button expands hidden ancestor levels', async ({ page }) => {
    let parentId = ids.today;
    for (let index = 1; index <= 4; index += 1) {
      const nodeId = await page.evaluate(async ({ parentId: targetParentId, text }) => {
        const win = window as typeof window & {
          lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
          __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
        };
        const outcome = await win.lin!.invoke<{ projection: unknown; focus?: { nodeId: string } }>('create_node', {
          parentId: targetParentId,
          index: null,
          text,
        });
        win.__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection: outcome.projection });
        return outcome.focus!.nodeId;
      }, { parentId, text: `Ancestor ${index}` });
      await row(page, nodeId).getByRole('button', { name: 'Open' }).click();
      parentId = nodeId;
    }

    const breadcrumb = page.locator('.outline-panel-surface').first()
      .getByRole('navigation', { name: 'Panel breadcrumb' });
    await expect(breadcrumb.getByRole('button', { name: /Show 2 hidden breadcrumb levels/ })).toBeVisible();
    await expect(breadcrumb).not.toContainText('Ancestor 1');

    await breadcrumb.getByRole('button', { name: /Show 2 hidden breadcrumb levels/ }).click();

    await expect(breadcrumb).toContainText('Ancestor 1');
    await expect(breadcrumb).toContainText('2026-05-13');
    await breadcrumb.getByRole('button', { name: 'Ancestor 1' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Ancestor 1');
  });

  test('node page title is editable and writes back to the same node', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();

    const titleEditor = page.locator('.panel-title-editor .ProseMirror').first();
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Alpha renamed');
    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });

    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha renamed');
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Alpha renamed');
  });

  test('header more action stays on the title row when a node has no title tags', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();

    const metrics = await page.evaluate(() => {
      const titleRow = document.querySelector('.panel-title-row')?.getBoundingClientRect();
      const titleEditor = document.querySelector('.panel-title-editor')?.getBoundingClientRect();
      const moreButton = document.querySelector('.panel-title-more-button')?.getBoundingClientRect();
      const tagRow = document.querySelector('.panel-title-toolbar-row');
      if (!titleRow || !titleEditor || !moreButton) throw new Error('missing title row alignment target');
      return {
        moreCenterY: moreButton.top + moreButton.height / 2,
        moreRight: moreButton.right,
        tagRowExists: Boolean(tagRow),
        titleEditorCenterY: titleEditor.top + titleEditor.height / 2,
        titleRowRight: titleRow.right,
      };
    });

    expect(metrics.tagRowExists).toBe(false);
    expectClose(metrics.moreCenterY, metrics.titleEditorCenterY);
    expectClose(metrics.moreRight, metrics.titleRowRight);
  });

  test('a locked day node panel shows a humanized title and no calendar icon', async ({ page }) => {
    // Real day nodes are locked; the mock leaves today editable, so lock it here
    // to exercise the read-only humanized title path.
    await page.evaluate((todayId) => {
      const win = window as typeof window & {
        __LIN_E2E__?: {
          projection: () => { nodes: Array<{ id: string; locked?: boolean }> };
          emitDocumentEvent: (event: unknown) => void;
        };
      };
      const projection = win.__LIN_E2E__!.projection();
      const today = projection.nodes.find((node) => node.id === todayId);
      if (today) today.locked = true;
      win.__LIN_E2E__!.emitDocumentEvent({ type: 'projection_changed', projection });
    }, ids.today);

    const panel = page.locator('.outline-panel-surface').first();
    const title = panel.locator('.panel-title-editor').first();
    // The raw ISO string is replaced by the "Ddd, Mmm D" day name (May 13 2026),
    // optionally prefixed with Today/Tomorrow/Yesterday near that date.
    await expect(title).toContainText('May 13');
    await expect(title).not.toContainText('2026-05-13');
    // The date node no longer carries a header calendar icon.
    await expect(panel.locator('.panel-heading-icon-row')).toHaveCount(0);
  });

  test('day panels expose date navigation and jump through ensured day nodes', async ({ page }) => {
    await expect(page.getByRole('navigation', { name: 'Date navigation' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Date navigation' })).not.toContainText('2026/');

    await page.getByRole('button', { name: 'Next day' }).click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-14');
    await expect(page.getByRole('navigation', { name: 'Date navigation' })).toBeVisible();
    await expect.poll(async () => (await nodeById(page, ids.today))?.content.text).toBe('2026-05-13');

    await page.getByRole('button', { name: 'Open calendar' }).click();
    await expect(page.getByRole('dialog', { name: 'Calendar' })).toBeVisible();
    await expect(page.locator('.panel-date-note-dot')).toHaveCount(0);

    const countedDay = page.getByRole('button', { name: 'Go to 2026-05-13 · 3 nodes' });
    await expect(countedDay).toHaveClass(/note-density-2/);
    await expect.poll(async () => countedDay.evaluate((element) =>
      getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');

    const radii = await page.evaluate(() => {
      const selectors = [
        '.panel-date-nav-button',
        '.panel-date-nav-today',
        '.panel-date-picker-button',
        '.calendar-month-nav',
        '.panel-date-calendar-day',
      ];
      return selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);
      });
    });
    for (const radius of radii) {
      expect(radius).toBeGreaterThanOrEqual(6);
      expect(radius).toBeLessThanOrEqual(8);
    }

    await page.getByRole('button', { name: 'Go to 2026-05-20' }).click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-20');
  });

  test('trailing empty-node hints stay hidden instead of repeating placeholder text', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.setAttribute('data-testid', 'trailing-hint-fixture');
      fixture.innerHTML = `
        <div class="row-editor trailing-editor is-empty" data-placeholder="">
          <div class="ProseMirror" contenteditable="true"></div>
        </div>
        <div class="row-editor trailing-editor is-empty" data-placeholder="">
          <div class="ProseMirror" contenteditable="true"></div>
        </div>
      `;
      document.body.appendChild(fixture);
    });

    await page.locator('[data-testid="trailing-hint-fixture"] .ProseMirror').nth(1).focus();

    await expect.poll(async () => page.locator('.trailing-editor.is-empty').evaluateAll((elements) =>
      elements.filter((element) => Number(getComputedStyle(element, '::before').opacity) > 0.5).length)).toBe(0);

    await rowEditor(page, ids.alpha).click();

    await expect.poll(async () => page.locator('.trailing-editor.is-empty').evaluateAll((elements) =>
      elements.filter((element) => Number(getComputedStyle(element, '::before').opacity) > 0.5).length)).toBe(0);
  });

  test('panel scroll containers use the lightweight scrollbar contract', async ({ page }) => {
    const styles = await page.locator('.main-panel').first().evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        scrollbarGutter: computed.scrollbarGutter,
        scrollbarWidth: computed.scrollbarWidth,
      };
    });

    expect(styles.scrollbarWidth).toBe('thin');
    expect(styles.scrollbarGutter).toContain('stable');
  });

  test('Cmd+Enter in page title commits current text while cycling checkbox state', async ({ page }) => {
    const titleEditor = page.locator('.panel-title-editor .ProseMirror').first();
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Today renamed');
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => (await nodeById(page, ids.today))?.content.text).toBe('Today renamed');
    await expect.poll(async () => (await nodeById(page, ids.today))?.showCheckbox).toBe(true);
    await expect.poll(async () => Boolean((await nodeById(page, ids.today))?.completedAt)).toBe(false);

    await page.keyboard.press('Meta+Enter');
    await expect.poll(async () => (await nodeById(page, ids.today))?.showCheckbox).toBe(true);
    await expect.poll(async () => Boolean((await nodeById(page, ids.today))?.completedAt)).toBe(true);

    await page.keyboard.press('Meta+Enter');
    await expect.poll(async () => (await nodeById(page, ids.today))?.showCheckbox).toBe(false);
    await expect.poll(async () => Boolean((await nodeById(page, ids.today))?.completedAt)).toBe(false);
  });

  test('Cmd+Enter in row editor commits current text while cycling checkbox state', async ({ page }) => {
    const editor = rowEditor(page, ids.alpha);
    await editor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Alpha done');
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Alpha done');
    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);

    await editor.click();
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(false);

    await editor.click();
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);
  });

  test('mouse checkbox click only toggles undone and done states', async ({ page }) => {
    await row(page, ids.alpha).getByTitle('Mark done').click();
    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);

    await row(page, ids.alpha).getByTitle('Mark not done').click();
    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);
  });

  test('nodex-style main surface does not render an inspector side panel', async ({ page }) => {
    await expect(page.getByText('INSPECTOR')).toHaveCount(0);
    await expect(page.locator('.main-panel').first()).toBeVisible();
  });
});
