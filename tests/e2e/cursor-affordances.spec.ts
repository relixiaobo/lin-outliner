import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ids, installElectronMock, openMockedApp, row } from './outlinerMock';

const STYLES_DIR = 'src/renderer/styles';
const styleFiles = readdirSync(STYLES_DIR)
  .filter((file) => file.endsWith('.css'))
  .map((file) => join(STYLES_DIR, file));

function collectPointerCursorViolations() {
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim();
      const body = match[2] ?? '';
      if (!/\bcursor\s*:\s*pointer\s*;/.test(body)) continue;
      const lineNumber = source.slice(0, match.index).split('\n').length;
      if (selector.includes('.inline-ref')) continue;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
}

function collectForcedUserSelectViolations() {
  const allowedSelectors = new Set([
    'body.drag-selecting, body.drag-selecting *',
    'body.is-resizing-layout, body.is-resizing-layout *',
  ]);
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      if (!/(?:-webkit-)?user-select\s*:\s*none\s*!important\s*;/.test(body)) continue;
      if (allowedSelectors.has(selector)) continue;
      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
}

// Strict-native cursor policy: chrome (buttons, toggles, rows, bullets) keeps the
// default arrow cursor the way a native macOS/Windows app does. The pointing-hand
// cursor is reserved for genuine content hyperlinks (inline references / links in
// rendered text). Changing the cursor on hoverable chrome is exactly what makes an
// app feel like a web page, so these assertions guard against it regressing.
test.describe('cursor affordances', () => {
  test('reserves pointer cursor declarations for inline content references', () => {
    expect(collectPointerCursorViolations()).toEqual([]);
  });

  test('keeps forced text-selection suppression limited to active gestures', () => {
    expect(collectForcedUserSelectViolations()).toEqual([]);
  });

  test('core controls keep the native arrow cursor', async ({ page }) => {
    await openMockedApp(page);

    const cursors = await page.evaluate((ids) => {
      const cursor = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).cursor;
      };

      return {
        panelMore: cursor('.panel-title-more-button'),
        rowBullet: cursor(`[data-node-id="${ids.alpha}"] .row-bullet-button`),
        composerSend: cursor('.agent-composer-action-button'),
        agentTitle: cursor('.agent-dock-title-button'),
      };
    }, ids);

    // Every chrome control uses the arrow cursor — no pointer affordance anywhere.
    expect(cursors.panelMore).toBe('default');
    expect(cursors.rowBullet).toBe('default');
    expect(cursors.composerSend).toBe('default');
    expect(cursors.agentTitle).toBe('default');
  });

  test('shared icon buttons and definition switches stay on the arrow cursor', async ({ page }) => {
    await openMockedApp(page);

    const iconButtonCursors = await page.evaluate(() => {
      const enabled = document.createElement('button');
      enabled.className = 'icon-button';
      enabled.type = 'button';
      document.body.appendChild(enabled);

      const disabled = document.createElement('button');
      disabled.className = 'icon-button';
      disabled.disabled = true;
      disabled.type = 'button';
      document.body.appendChild(disabled);

      return {
        enabled: getComputedStyle(enabled).cursor,
        disabled: getComputedStyle(disabled).cursor,
      };
    });

    expect(iconButtonCursors.enabled).toBe('default');
    expect(iconButtonCursors.disabled).toBe('default');

    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Schema', exact: true }).click();
    await row(page, ids.projectTag).getByRole('button', { name: 'Open' }).click();

    const definitionSwitchCursor = await page.locator('.definition-switch').first().evaluate((element) =>
      getComputedStyle(element).cursor);

    expect(definitionSwitchCursor).toBe('default');
  });

  test('de-pointered non-link controls never use the hand cursor (A5)', async ({ page }) => {
    await openMockedApp(page);

    // These three controls used to carry cursor: pointer even though none is a
    // content hyperlink (an approval toggle, an approval action button, a tag
    // label). PR-C removed the pointer; guard that it never comes back. These are
    // class-only probes (no ancestor context), so they catch a pointer re-added to
    // the class rule itself — not one inherited via a different selector/ancestor.
    const cursors = await page.evaluate(() => {
      const probe = (tag: string, className: string) => {
        const element = document.createElement(tag);
        element.className = className;
        document.body.appendChild(element);
        return getComputedStyle(element).cursor;
      };
      return {
        approvalToggle: probe('button', 'agent-approval-details-toggle'),
        approvalButton: probe('button', 'agent-approval-button'),
        tagLabel: probe('span', 'tag-badge-label clickable'),
      };
    });

    expect(cursors.approvalToggle).not.toBe('pointer');
    expect(cursors.approvalButton).not.toBe('pointer');
    expect(cursors.tagLabel).not.toBe('pointer');
  });

  test('settings inset rows, row menu and provider sheet keep the arrow cursor', async ({ page }) => {
    // The redesigned settings surface adds new chrome — inset grouped-list rows,
    // a per-row `⋯` actions trigger, and the provider sheet's buttons. None is a
    // content hyperlink, so every one must keep the native arrow cursor (B10).
    await installElectronMock(page);
    await page.goto('/?surface=settings');
    const settings = page.locator('.settings-window');
    await expect(settings.locator('.inset-row-main').first()).toBeVisible();

    const listCursors = await page.evaluate(() => {
      const cursor = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).cursor;
      };
      return {
        insetRow: cursor('.inset-row-main'),
        rowMenuTrigger: cursor('.settings-row-menu-trigger'),
        historyArrow: cursor('.settings-history-nav .rail-toggle'),
        configure: cursor('.settings-provider-configure'),
      };
    });
    expect(listCursors.insetRow).toBe('default');
    expect(listCursors.rowMenuTrigger).toBe('default');
    expect(listCursors.historyArrow).toBe('default');
    expect(listCursors.configure).toBe('default');

    // The per-provider config is its own native window (?surface=provider-config);
    // probe its action buttons there (clicking a row opens that window, not a modal).
    await page.goto('/?surface=provider-config&provider=anthropic&mode=configure');
    const sheet = page.locator('.provider-config-window');
    await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    const sheetCursors = await page.evaluate(() => {
      const cursor = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).cursor;
      };
      return {
        primary: cursor('.settings-sheet-actions-right .button-primary'),
        reveal: cursor('.settings-sheet-reveal'),
      };
    });
    expect(sheetCursors.primary).toBe('default');
    expect(sheetCursors.reveal).toBe('default');
  });

  test('content references show the pointer cursor on hover', async ({ page }) => {
    await openMockedApp(page);

    // Inline references behave like content hyperlinks, so hovering one is the single
    // place the pointing-hand cursor is allowed under the strict-native policy.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.className = 'inline-ref';
      link.id = 'cursor-affordance-probe';
      link.textContent = 'reference';
      document.body.appendChild(link);
    });

    const probe = page.locator('#cursor-affordance-probe');
    await probe.hover();
    const hoverCursor = await probe.evaluate((element) => getComputedStyle(element).cursor);

    expect(hoverCursor).toBe('pointer');
  });
});
