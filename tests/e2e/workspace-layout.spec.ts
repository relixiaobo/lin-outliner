import { expect, test } from '@playwright/test';
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  MAC_TRAFFIC_LIGHT_SIZE,
} from '../../src/core/chromeGeometry';
import {
  e2eProjection,
  emitDocumentEvent,
  ids,
  openMockedApp,
  openMockRunDetailsFromAssistantDetailsButton,
  row,
  rowBody,
} from './outlinerMock';

const WORKSPACE_LAYOUT_STORAGE_KEY = 'lin-outliner:workspace-layout:v4';
const WORKSPACE_PINNED_NODES_STORAGE_KEY = 'lin-outliner:workspace-layout:v3:pinned';
const OUTLINE_VIEW_STATE_STORAGE_KEY = 'lin-outliner:outline-view-state:v1';

test.describe('workspace layout resizing', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('sidebar and agent docks can be resized by dragging their handles', async ({ page }) => {
    const sidebar = page.locator('.sidebar-dock');
    const agent = page.locator('.agent-dock');
    const sidebarBefore = await sidebar.boundingBox();
    const agentBefore = await agent.boundingBox();
    expect(sidebarBefore).toBeTruthy();
    expect(agentBefore).toBeTruthy();

    const sidebarHandle = page.getByRole('button', { name: 'Resize sidebar' });
    await expect.poll(async () => sidebarHandle.evaluate((element) => (
      getComputedStyle(element).cursor
    ))).toBe('ew-resize');
    const sidebarHandleBox = await sidebarHandle.boundingBox();
    expect(sidebarHandleBox).toBeTruthy();
    await page.mouse.move(sidebarHandleBox!.x + sidebarHandleBox!.width / 2, sidebarHandleBox!.y + 160);
    await page.mouse.down();
    await page.mouse.move(sidebarHandleBox!.x + 56, sidebarHandleBox!.y + 160);
    await page.mouse.up();

    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(sidebarBefore!.width + 30);
    const sidebarAfterDrag = await sidebar.boundingBox();
    expect(sidebarAfterDrag).toBeTruthy();
    await sidebarHandle.press('ArrowLeft');
    await sidebarHandle.press('ArrowLeft');
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(sidebarAfterDrag!.width - 12);

    const agentHandle = page.getByRole('button', { name: 'Resize agent' });
    await expect.poll(async () => agentHandle.evaluate((element) => (
      getComputedStyle(element).cursor
    ))).toBe('ew-resize');
    const agentHandleBox = await agentHandle.boundingBox();
    expect(agentHandleBox).toBeTruthy();
    await page.mouse.move(agentHandleBox!.x + agentHandleBox!.width / 2, agentHandleBox!.y + 160);
    await page.mouse.down();
    await page.mouse.move(agentHandleBox!.x - 70, agentHandleBox!.y + 160);
    await page.mouse.up();

    await expect.poll(async () => (await agent.boundingBox())?.width ?? 0).toBeGreaterThan(agentBefore!.width + 40);
    const agentAfterDrag = await agent.boundingBox();
    expect(agentAfterDrag).toBeTruthy();
    await agentHandle.press('ArrowRight');
    await agentHandle.press('ArrowRight');
    await expect.poll(async () => (await agent.boundingBox())?.width ?? 0).toBeLessThan(agentAfterDrag!.width - 12);
  });

  test('panel split resizes by ratio and fills the canvas without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 900 });
    // The floating-rails shell dissolved the TopBar: window chrome is now two
    // corner drag zones (.window-chrome-zone-left/right), each carving out a
    // single rail toggle. There is no tab strip; page-nav back/forward are
    // keyboard-only (Cmd+[ / Cmd+]) with no chrome buttons. The default layout is
    // a single pane, so open a second pane (Cmd+M) to have a split to resize.
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(1);
    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(2);
    const leftZone = await page.locator('.window-chrome-zone-left').boundingBox();
    const rightZone = await page.locator('.window-chrome-zone-right').boundingBox();
    const sidebarToggle = await page.getByTitle('Collapse sidebar').boundingBox();
    const agentToggle = await page.getByTitle('Collapse agent').boundingBox();
    // Both corner zones are the window's title-bar drag regions (pure CSS
    // -webkit-app-region: drag — there is no DOM attribute; see WindowChrome.tsx).
    for (const zoneSelector of ['.window-chrome-zone-left', '.window-chrome-zone-right']) {
      const appRegion = await page.locator(zoneSelector).evaluate((element) => (
        getComputedStyle(element).getPropertyValue('-webkit-app-region').trim()
      ));
      expect(appRegion).toBe('drag');
    }
    // Back/Forward are keyboard-only now — there must be no chrome buttons.
    await expect(page.getByTitle('Back')).toHaveCount(0);
    await expect(page.getByTitle('Forward')).toHaveCount(0);
    const firstBefore = await panels.nth(0).boundingBox();
    const secondBefore = await panels.nth(1).boundingBox();
    expect(leftZone).toBeTruthy();
    expect(rightZone).toBeTruthy();
    expect(sidebarToggle).toBeTruthy();
    expect(agentToggle).toBeTruthy();
    expect(firstBefore).toBeTruthy();
    expect(secondBefore).toBeTruthy();
    // Each toggle sits inside its corner zone and the two share a center line.
    expect(sidebarToggle!.y).toBeGreaterThanOrEqual(leftZone!.y - 1);
    expect(agentToggle!.y).toBeGreaterThanOrEqual(rightZone!.y - 1);
    expect(Math.abs(
      (sidebarToggle!.y + sidebarToggle!.height / 2)
      - (agentToggle!.y + agentToggle!.height / 2),
    )).toBeLessThanOrEqual(1);

    const panelHandle = page.getByRole('button', { name: 'Resize panels' });
    const panelHandleBox = await panelHandle.boundingBox();
    const panelSlotBox = await page.locator('.panel-resize-slot').first().boundingBox();
    expect(panelHandleBox).toBeTruthy();
    expect(panelSlotBox).toBeTruthy();
    // Post-#57 divider model (agent-dock.css): the visible divider is the 1px
    // .panel-resize-slot; the grab affordance is a SEPARATE invisible hit strip
    // (.panel-resize-handle, a child of the slot) that straddles it,
    // --resize-hit-width (10px) wide and centered. The ew-resize cursor lives on
    // that handle — not on the 1px slot (which stays `auto`) — and there is no grab
    // pill. (Pre-#57 the slot itself was an 8px cursor-bearing bar with a pill.)
    await expect.poll(async () => panelHandle.evaluate((element) => (
      getComputedStyle(element).cursor
    ))).toBe('ew-resize');
    expect(Math.round(panelHandleBox!.width)).toBe(10);
    expect(Math.round(panelSlotBox!.width)).toBe(1);
    const gapCenterBefore = (firstBefore!.x + firstBefore!.width + secondBefore!.x) / 2;
    const handleCenterBefore = panelHandleBox!.x + panelHandleBox!.width / 2;
    const slotCenterBefore = panelSlotBox!.x + panelSlotBox!.width / 2;
    expect(Math.abs(handleCenterBefore - gapCenterBefore)).toBeLessThanOrEqual(1);
    expect(Math.abs(slotCenterBefore - gapCenterBefore)).toBeLessThanOrEqual(1);
    // No grab pill: the handle is a bare hit strip, so its ::after generates no box.
    await expect.poll(async () => panelHandle.evaluate((element) => (
      getComputedStyle(element, '::after').width
    ))).toBe('auto');

    await page.mouse.move(panelHandleBox!.x + panelHandleBox!.width / 2, panelHandleBox!.y + 240);
    await page.mouse.down();
    await page.mouse.move(panelHandleBox!.x + 90, panelHandleBox!.y + 240);
    await page.mouse.up();

    await expect.poll(async () => (await panels.nth(0).boundingBox())?.width ?? 0).toBeGreaterThan(firstBefore!.width + 45);
    await expect.poll(async () => (await panels.nth(1).boundingBox())?.width ?? 0).toBeLessThan(secondBefore!.width - 45);
    const firstAfterDrag = await panels.nth(0).boundingBox();
    expect(firstAfterDrag).toBeTruthy();
    await panelHandle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await panels.nth(0).boundingBox())?.width ?? 0).toBeLessThan(firstAfterDrag!.width - 8);

    const canvasOverflow = await page.locator('.workspace-canvas').evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(canvasOverflow.overflowX).toBe('hidden');
    expect(canvasOverflow.scrollWidth).toBeLessThanOrEqual(canvasOverflow.clientWidth + 1);

    await page.setViewportSize({ width: 980, height: 900 });
    const narrowCanvasOverflow = await page.locator('.workspace-canvas').evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(narrowCanvasOverflow.overflowX).toBe('hidden');
    expect(narrowCanvasOverflow.scrollWidth).toBeLessThanOrEqual(narrowCanvasOverflow.clientWidth + 1);
  });

  test('narrow windows re-clamp rails and gate additional panes without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });

    await expect.poll(async () => Math.round((await page.locator('.sidebar-dock').boundingBox())?.width ?? 0))
      .toBe(152);
    await expect.poll(async () => Math.round((await page.locator('.agent-dock').boundingBox())?.width ?? 0))
      .toBe(280);

    const canvasOverflow = await page.locator('.workspace-canvas').evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(canvasOverflow.overflowX).toBe('hidden');
    expect(canvasOverflow.scrollWidth).toBeLessThanOrEqual(canvasOverflow.clientWidth + 1);

    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(1);
    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(1);
  });

  test('sidebar dragging in the deficit band keeps the sidebar intent and shrinks the agent first', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 900 });
    const sidebar = page.locator('.sidebar-dock');
    const agent = page.locator('.agent-dock');
    const sidebarHandle = page.getByRole('button', { name: 'Resize sidebar' });
    const sidebarHandleBox = await sidebarHandle.boundingBox();
    expect(sidebarHandleBox).toBeTruthy();

    await page.mouse.move(
      sidebarHandleBox!.x + sidebarHandleBox!.width / 2,
      sidebarHandleBox!.y + sidebarHandleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(sidebarHandleBox!.x + 130, sidebarHandleBox!.y + sidebarHandleBox!.height / 2);
    await page.mouse.up();

    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
    await expect.poll(async () => Math.round((await agent.boundingBox())?.width ?? 0)).toBe(308);
  });

  test('rail resize preference survives narrow window reclamps', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const agent = page.locator('.agent-dock');
    const agentHandle = page.getByRole('button', { name: 'Resize agent' });
    const agentHandleBox = await agentHandle.boundingBox();
    expect(agentHandleBox).toBeTruthy();

    await page.mouse.move(
      agentHandleBox!.x + agentHandleBox!.width / 2,
      agentHandleBox!.y + agentHandleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(agentHandleBox!.x - 90, agentHandleBox!.y + agentHandleBox!.height / 2);
    await page.mouse.up();

    await expect.poll(async () => Math.round((await agent.boundingBox())?.width ?? 0)).toBeGreaterThan(400);
    const preferredWidth = Math.round((await agent.boundingBox())!.width);

    await page.setViewportSize({ width: 760, height: 900 });
    await expect.poll(async () => Math.round((await agent.boundingBox())?.width ?? 0)).toBe(280);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => Math.round((await agent.boundingBox())?.width ?? 0))
      .toBeGreaterThanOrEqual(preferredWidth - 1);
  });

  test('debug panel capacity failures show feedback instead of silently no-oping', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await openMockRunDetailsFromAssistantDetailsButton(page);

    await expect(page.locator('.outline-panel-surface')).toHaveCount(1);
    await expect(page.locator('.error')).toContainText('Window is too narrow to open another pane.');
  });

  test('page title tag bars wrap instead of overflowing in narrow windows', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await page.evaluate(async (todayId) => {
      const win = window as typeof window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
      };
      let projection: unknown = null;
      for (let index = 1; index <= 10; index += 1) {
        const tag = await win.lin!.invoke<{ update: { projection: unknown }; focus?: { nodeId: string } }>('create_tag', {
          name: `responsive-${index}`,
        });
        const applied = await win.lin!.invoke<{ update: { projection: unknown } }>('apply_tag', {
          nodeId: todayId,
          tagId: tag.focus!.nodeId,
        });
        projection = applied.update.projection;
      }
      win.__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection });
    }, ids.today);

    const tagBar = page.locator('.panel-title-toolbar-row .tag-bar');
    await expect(tagBar.locator('.tag-badge')).toHaveCount(11);
    const metrics = await tagBar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        height: rect.height,
        scrollWidth: element.scrollWidth,
      };
    });
    expect(metrics.height).toBeGreaterThan(20);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });

  test('inline row tag bars wrap without overflowing plain text rows', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await page.evaluate(async (nodeId) => {
      const win = window as typeof window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
      };
      let projection: unknown = null;
      for (let index = 1; index <= 10; index += 1) {
        const tag = await win.lin!.invoke<{ update: { projection: unknown }; focus?: { nodeId: string } }>('create_tag', {
          name: `inline-responsive-${index}`,
        });
        const applied = await win.lin!.invoke<{ update: { projection: unknown } }>('apply_tag', {
          nodeId,
          tagId: tag.focus!.nodeId,
        });
        projection = applied.update.projection;
      }
      win.__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection });
    }, ids.alpha);

    const inlineTagBar = row(page, ids.alpha).locator('.row-inline-tag-slot .tag-bar').first();
    await expect(inlineTagBar.locator('.tag-badge')).toHaveCount(10);
    const metrics = await inlineTagBar.evaluate((element, betaId) => {
      const rect = element.getBoundingClientRect();
      const nextRowRect = document.querySelector(`[data-node-id="${betaId}"] > .row`)?.getBoundingClientRect();
      const rowRect = element.closest('[data-node-id]')?.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        clientWidth: element.clientWidth,
        height: rect.height,
        nextRowTop: nextRowRect?.top ?? rect.bottom,
        right: rect.right,
        rowRight: rowRect?.right ?? rect.right,
        scrollWidth: element.scrollWidth,
      };
    }, ids.beta);
    expect(metrics.height).toBeGreaterThan(20);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.right).toBeLessThanOrEqual(metrics.rowRight + 1);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.nextRowTop + 1);
  });

  test('window chrome toggles align to the traffic lights and stay icon-only', async ({ page }) => {
    const sidebarToggle = page.getByTitle('Collapse sidebar');

    const initial = await page.evaluate(() => {
      const sidebar = document.querySelector('[title="Collapse sidebar"]');
      // The left corner drag zone hosts the sidebar toggle beside the OS traffic
      // lights; the agent toggle lives in the symmetric right zone. There is no
      // single top-chrome bar and no back/forward chrome buttons anymore.
      const zone = document.querySelector('.window-chrome-zone-left');
      if (
        !(sidebar instanceof HTMLElement)
        || !(zone instanceof HTMLElement)
      ) {
        throw new Error('missing window chrome controls');
      }
      const sidebarBox = sidebar.getBoundingClientRect();
      const zoneBox = zone.getBoundingClientRect();
      // Traffic-light geometry is published as :root custom properties (injected
      // from core/chromeGeometry.ts, with tokens.css fallbacks).
      const rootStyle = getComputedStyle(document.documentElement);
      const trafficLightSize = Number.parseFloat(rootStyle.getPropertyValue('--traffic-light-size'));
      const trafficLightX = Number.parseFloat(rootStyle.getPropertyValue('--traffic-light-x'));
      const trafficLightY = Number.parseFloat(rootStyle.getPropertyValue('--traffic-light-y'));
      return {
        controlCenterOffsetY: sidebarBox.top + sidebarBox.height / 2 - zoneBox.top,
        sidebarBg: getComputedStyle(sidebar).backgroundColor,
        sidebarIcon: sidebar.querySelector('svg')?.innerHTML ?? '',
        sidebarColor: getComputedStyle(sidebar).color,
        trafficLightCenterOffsetX: trafficLightX + trafficLightSize / 2,
        trafficLightCenterOffsetY: trafficLightY + trafficLightSize / 2,
        trafficLightSize,
        trafficLightX,
        trafficLightY,
      };
    });
    // Icon-only chrome: no fill behind the toggle (B6).
    expect(initial.sidebarBg).toBe('rgba(0, 0, 0, 0)');
    expect(initial.trafficLightSize).toBe(MAC_TRAFFIC_LIGHT_SIZE);
    expect(initial.trafficLightX).toBe(MAC_TRAFFIC_LIGHT_POSITION.x);
    expect(initial.trafficLightY).toBe(MAC_TRAFFIC_LIGHT_POSITION.y);
    expect(initial.trafficLightCenterOffsetX).toBe(initial.trafficLightCenterOffsetY);
    // Back/Forward are keyboard-only (Cmd+[ / Cmd+]); no chrome buttons exist.
    await expect(page.getByTitle('Back')).toHaveCount(0);
    await expect(page.getByTitle('Forward')).toHaveCount(0);

    await sidebarToggle.click();
    await expect(page.getByTitle('Expand sidebar')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect.poll(async () => page.getByTitle('Expand sidebar').evaluate((sidebar) => (
      getComputedStyle(sidebar).backgroundColor
    ))).toBe('rgba(0, 0, 0, 0)');
    const collapsed = await page.evaluate(() => {
      const sidebar = document.querySelector('[title="Expand sidebar"]');
      if (!(sidebar instanceof HTMLElement)) throw new Error('missing collapsed sidebar control');
      return {
        sidebarBg: getComputedStyle(sidebar).backgroundColor,
        sidebarIcon: sidebar.querySelector('svg')?.innerHTML ?? '',
        sidebarColor: getComputedStyle(sidebar).color,
      };
    });
    expect(collapsed.sidebarBg).toBe('rgba(0, 0, 0, 0)');
    // The toggle glyph is STATIC (PanelLeft) — per B6 the open/collapsed state is
    // signalled by deepening the glyph COLOUR, not by swapping the icon or adding a
    // fill. So the SVG is unchanged across the toggle and only the colour differs.
    expect(collapsed.sidebarIcon).toBe(initial.sidebarIcon);
    expect(collapsed.sidebarColor).not.toBe(initial.sidebarColor);
  });

  test('agent collapse delays the corner chrome backing until the rail slides out', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    const zone = page.locator('.window-chrome-zone-right');
    await expect.poll(async () => zone.evaluate((element) => (
      getComputedStyle(element).backgroundColor
    ))).toBe('rgba(0, 0, 0, 0)');

    await page.getByTitle('Collapse agent').click();
    await expect(page.getByTitle('Expand agent')).toBeVisible();

    await expect.poll(async () => zone.evaluate((element) => (
      getComputedStyle(element).transitionDelay
    ))).toBe('0.16s');

    await page.waitForTimeout(180);
    await expect.poll(async () => zone.evaluate((element) => (
      getComputedStyle(element).backgroundColor
    ))).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('reduced motion removes the corner chrome backing delay', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const zone = page.locator('.window-chrome-zone-right');
    await expect.poll(async () => zone.evaluate((element) => (
      getComputedStyle(element).backgroundColor
    ))).toBe('rgba(0, 0, 0, 0)');

    await page.getByTitle('Collapse agent').click();
    await expect(page.getByTitle('Expand agent')).toBeVisible();

    await expect.poll(async () => zone.evaluate((element) => (
      getComputedStyle(element).transitionDelay
    ))).toBe('0s');
    await expect.poll(async () => zone.evaluate((element) => (
      getComputedStyle(element).backgroundColor
    ))).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('single panel centers bounded content and fills when narrow', async ({ page }) => {
    await page.setViewportSize({ width: 1900, height: 900 });

    // The default layout is a single pane.
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(1);

    const centeredMetrics = await page.locator('.outline-panel-surface .panel-inner').first().evaluate((inner) => {
      const panel = inner.closest('.outline-panel-surface')!.getBoundingClientRect();
      const innerBox = inner.getBoundingClientRect();
      return {
        innerWidth: innerBox.width,
        leftGap: innerBox.left - panel.left,
        panelWidth: panel.width,
        rightGap: panel.right - innerBox.right,
      };
    });
    expect(centeredMetrics.panelWidth).toBeGreaterThan(900);
    expect(centeredMetrics.innerWidth).toBeLessThanOrEqual(721);
    expect(Math.abs(centeredMetrics.leftGap - centeredMetrics.rightGap)).toBeLessThanOrEqual(2);

    await page.setViewportSize({ width: 900, height: 900 });
    const narrowMetrics = await page.locator('.outline-panel-surface .panel-inner').first().evaluate((inner) => {
      const panel = inner.closest('.outline-panel-surface')!.getBoundingClientRect();
      const innerBox = inner.getBoundingClientRect();
      return {
        innerWidth: innerBox.width,
        leftGap: innerBox.left - panel.left,
        panelWidth: panel.width,
        rightGap: panel.right - innerBox.right,
      };
    });
    expect(narrowMetrics.innerWidth).toBeLessThanOrEqual(narrowMetrics.panelWidth + 1);
    expect(narrowMetrics.leftGap).toBeGreaterThanOrEqual(-1);
    expect(narrowMetrics.rightGap).toBeGreaterThanOrEqual(-1);
  });

  test('primary navigation opens the recents saved search', async ({ page }) => {
    const recentsButton = page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true });
    await expect(recentsButton).toBeEnabled();

    await recentsButton.click();

    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Recents');
    await expect(page.locator('.sidebar-nav-item.active')).toContainText('Recents');
    await page.mouse.move(0, 0);
    await expect.poll(async () => recentsButton.evaluate((item) => getComputedStyle(item).backgroundColor))
      .toBe('rgba(0, 0, 0, 0)');
    await recentsButton.hover();
    await expect.poll(async () => recentsButton.evaluate((item) => getComputedStyle(item).backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)');
  });

  test('workspace section renders the true root outline', async ({ page }) => {
    const rootButton = page.getByRole('button', { name: 'Open Root' });
    await expect(rootButton).toBeVisible();
    await rootButton.click();
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Root');

    const workspaceTree = page.getByLabel('Workspace root tree');
    await expect(workspaceTree).toContainText('Daily Notes');
    await expect(workspaceTree).not.toContainText('Projects');
    await expect(workspaceTree).not.toContainText('Areas');
    await expect(workspaceTree).not.toContainText('Resources');
    await expect(workspaceTree).toContainText('Library');
    await expect(workspaceTree).toContainText('Saved searches');
    await expect(workspaceTree).toContainText('Trash');
    await expect(workspaceTree).toContainText('Schema');
    await expect(workspaceTree).not.toContainText('Settings');
    const sidebarMetrics = await workspaceTree.evaluate((tree) => {
      const primaryIcon = document.querySelector('.sidebar-primary-nav .sidebar-nav-icon');
      const pinnedTitle = document.querySelector('.sidebar-section-title');
      const pinnedEmptyIcon = document.querySelector('.sidebar-empty-icon');
      const rootAvatar = document.querySelector('.sidebar-root-avatar');
      const firstRow = tree.querySelector('.workspace-tree-row');
      const firstChevron = firstRow?.querySelector('.workspace-tree-chevron-button');
      // Tree rows are text-only (no node icon), so the label text is the leading
      // content and doubles as the de-emphasis baseline the chevron compares against.
      const firstContent = firstRow?.querySelector('.workspace-tree-label-text');
      const firstLabelText = firstRow?.querySelector('.workspace-tree-label-text');
      const sidebarDock = document.querySelector('.sidebar-dock');
      const activePanel = document.querySelector('.outline-panel-surface.active-panel');
      if (!primaryIcon
        || !(pinnedTitle instanceof HTMLElement)
        || !pinnedEmptyIcon
        || !(rootAvatar instanceof HTMLElement)
        || !(firstChevron instanceof HTMLElement)
        || !firstContent
        || !(firstLabelText instanceof HTMLElement)
        || !(sidebarDock instanceof HTMLElement)
        || !(activePanel instanceof HTMLElement)
        || !(firstRow instanceof HTMLElement)) {
        throw new Error('missing sidebar root alignment nodes');
      }
      const primaryIconBox = primaryIcon.getBoundingClientRect();
      const pinnedTitleBox = pinnedTitle.getBoundingClientRect();
      const pinnedEmptyIconBox = pinnedEmptyIcon.getBoundingClientRect();
      const rootAvatarBox = rootAvatar.getBoundingClientRect();
      const firstChevronBox = firstChevron.getBoundingClientRect();
      const firstContentBox = firstContent.getBoundingClientRect();
      const sidebarDockBox = sidebarDock.getBoundingClientRect();
      const activePanelBox = activePanel.getBoundingClientRect();
      const pinnedTitleStyle = getComputedStyle(pinnedTitle);
      const rowStyle = getComputedStyle(firstRow);
      const chevronStyle = getComputedStyle(firstChevron);
      return {
        chevronColor: chevronStyle.color,
        chevronLeft: firstChevronBox.left,
        chevronRight: firstChevronBox.right,
        chevronWidth: firstChevronBox.width,
        labelTextColor: getComputedStyle(firstLabelText).color,
        contentLeft: firstContentBox.left,
        pinnedEmptyIconLeft: pinnedEmptyIconBox.left,
        pinnedTitleLeft: pinnedTitleBox.left + Number.parseFloat(pinnedTitleStyle.paddingLeft),
        panelLeft: activePanelBox.left,
        primaryIconLeft: primaryIconBox.left,
        rootAvatarLeft: rootAvatarBox.left,
        rowRight: firstRow.getBoundingClientRect().right,
        rowHeight: firstRow.getBoundingClientRect().height,
        rowRadius: rowStyle.borderRadius,
        sidebarLeft: sidebarDockBox.left,
        sidebarRight: sidebarDockBox.right,
      };
    });
    // Post-#57 floating-rails geometry. The workspace tree is Root's INDENTED
    // children: its chevron shares the leading control column with the primary-nav
    // icons, the pinned section title, the empty-state icon, and the root avatar
    // (all at --sidebar-content-start). The tree LABEL does not share that column —
    // it sits one chevron-gutter + breathing gap further right
    // (--sidebar-tree-label-gap), so the chrome aligns to the CHEVRON, not the
    // label. (Pre-#57 the label was the control column; that is the alignment this
    // guard used to assert, see sidebar.css for the current intent.)
    const controlLeft = sidebarMetrics.chevronLeft;
    expect(Math.abs(sidebarMetrics.primaryIconLeft - controlLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.pinnedTitleLeft - controlLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.pinnedEmptyIconLeft - controlLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.rootAvatarLeft - controlLeft)).toBeLessThanOrEqual(1);
    // The control column is a small inset from the rail edge: rail-pad (8) +
    // --sidebar-content-start (6).
    expect(Math.abs((controlLeft - sidebarMetrics.sidebarLeft) - 14)).toBeLessThanOrEqual(1);
    // The label clears the chevron by exactly the breathing gap
    // (--sidebar-tree-label-gap = 6): content-left = chevron-right + gap.
    expect(Math.abs(sidebarMetrics.contentLeft - (sidebarMetrics.chevronRight + 6))).toBeLessThanOrEqual(1);
    // Rows are inset from the rail's right edge by the same rail-pad (8) — the rail
    // floats, so rows are not flush with its border.
    expect(Math.abs((sidebarMetrics.sidebarRight - sidebarMetrics.rowRight) - 8)).toBeLessThanOrEqual(1);
    // The active pane floats one --layout-gap (8) right of the rail.
    expect(Math.abs((sidebarMetrics.panelLeft - sidebarMetrics.sidebarRight) - 8)).toBeLessThanOrEqual(1);
    expect(Math.round(sidebarMetrics.chevronWidth)).toBe(16);
    expect(sidebarMetrics.chevronRight).toBeLessThanOrEqual(sidebarMetrics.contentLeft);
    // The chevron is de-emphasized relative to the row's label text.
    expect(sidebarMetrics.chevronColor).not.toBe(sidebarMetrics.labelTextColor);
    expect(sidebarMetrics.rowHeight).toBe(28);
    expect(sidebarMetrics.rowRadius).toBe('6px');

    const todayNav = page.locator('.sidebar-primary-nav .sidebar-nav-item').filter({ hasText: 'Today' });
    const navBackgroundBefore = await todayNav.evaluate((item) => getComputedStyle(item).backgroundColor);
    await todayNav.hover();
    await expect.poll(async () => todayNav.evaluate((item) => getComputedStyle(item).backgroundColor))
      .not.toBe(navBackgroundBefore);

    // Post-#57: a tree row's hover affordance is a neutral fill (the same
    // --control-hover as nav items) plus a chevron brighten — NOT a row-text colour
    // shift, which is invisible under the collapsed neutral token scale. So on
    // hover the row background changes and the chevron brightens, while the row's
    // own text colour stays put. (sidebar.css `.workspace-tree-row:hover`.)
    const firstWorkspaceRow = workspaceTree.locator('.workspace-tree-row').first();
    const readRowHover = (row: Element) => {
      const chevron = row.querySelector('.workspace-tree-chevron-button');
      return {
        background: getComputedStyle(row).backgroundColor,
        chevronColor: chevron ? getComputedStyle(chevron).color : null,
      };
    };
    await page.mouse.move(0, 0);
    const treeRowBefore = await firstWorkspaceRow.evaluate(readRowHover);
    await firstWorkspaceRow.hover();
    await expect.poll(async () => firstWorkspaceRow.evaluate((row) => getComputedStyle(row).backgroundColor))
      .not.toBe(treeRowBefore.background);
    await expect.poll(async () => firstWorkspaceRow.evaluate((row) => {
      const chevron = row.querySelector('.workspace-tree-chevron-button');
      return chevron ? getComputedStyle(chevron).color : null;
    })).not.toBe(treeRowBefore.chevronColor);

    await workspaceTree.getByRole('button', { name: 'Expand Daily Notes' }).click();
    await expect(workspaceTree).toContainText('2026-05-13');
  });

  test('workspace tree rows are text-only (no node icon)', async ({ page }) => {
    const workspaceTree = page.getByLabel('Workspace root tree');
    // Tree rows intentionally omit the node icon (system fallback glyph or the
    // node's own emoji) to stay scannable; the icon still renders in the outliner.
    for (const name of ['Daily Notes', 'Library', 'Schema', 'Saved searches', 'Trash']) {
      const row = workspaceTree.locator('.workspace-tree-row', { hasText: name }).first();
      await expect(row).toBeVisible();
      await expect(row.locator('.workspace-tree-label-icon')).toHaveCount(0);
    }
  });

  test('workspace tree renders reference nodes by target title', async ({ page }) => {
    const fixture = await page.evaluate(async (ids) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      const target = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
        parentId: ids.library,
        index: null,
        text: 'Reference target',
      });
      const targetId = target?.focus?.nodeId ?? '';
      const child = await win.lin?.invoke<{ focus?: { nodeId: string } }>('create_node', {
        parentId: targetId,
        index: null,
        text: 'Target child',
      });
      const reference = await win.lin?.invoke<{ focus?: { nodeId: string } }>('add_reference', {
        parentId: ids.today,
        targetId,
        index: null,
      });
      return {
        childId: child?.focus?.nodeId ?? '',
        referenceId: reference?.focus?.nodeId ?? '',
      };
    }, ids);
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    const workspaceTree = page.getByLabel('Workspace root tree');
    await workspaceTree.getByRole('button', { name: 'Expand Daily Notes' }).click();
    await workspaceTree.getByRole('button', { name: 'Expand 2026-05-13' }).click();

    await expect(workspaceTree).toContainText('Reference target');
    await expect(workspaceTree).not.toContainText('@node:');

    const referenceRow = workspaceTree.locator('.workspace-tree-row').filter({ hasText: 'Reference target' });
    await expect(referenceRow.locator('.workspace-tree-reference-marker')).toHaveCount(0);
    await referenceRow.getByRole('button', { name: 'Expand Reference target' }).click();
    await expect(workspaceTree).toContainText('Target child');

    expect(fixture.referenceId).toBeTruthy();
    expect(fixture.childId).toBeTruthy();
  });

  test('sidebar pinned nodes persist and can be toggled from row context menus', async ({ page }) => {
    await expect(page.locator('.sidebar-pin-dropzone')).toContainText('Drag to pin nodes');

    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();

    const pinnedTree = page.getByLabel('Pinned nodes');
    await expect(pinnedTree.locator('.workspace-tree-row').filter({ hasText: 'Alpha' })).toBeVisible();
    await expect(page.locator('.sidebar-pin-dropzone')).toHaveCount(0);

    await rowBody(page, ids.alpha).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.reload();
    const restoredPinnedTree = page.getByLabel('Pinned nodes');
    const restoredAlphaPinnedRow = restoredPinnedTree.locator('.workspace-tree-row').filter({ hasText: 'Alpha' });
    await expect(restoredAlphaPinnedRow).toBeVisible();

    await page.evaluate(async ({ alphaId }) => {
      const win = window as Window & { lin?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown> } };
      await win.lin?.invoke?.('trash_node', { nodeId: alphaId });
    }, { alphaId: ids.alpha });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });
    await expect(restoredAlphaPinnedRow).toBeVisible();
    await expect(restoredAlphaPinnedRow.locator('.workspace-tree-label-text')).toHaveCSS('text-decoration-line', 'line-through');

    await restoredAlphaPinnedRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();

    await expect(page.getByLabel('Pinned nodes')).toHaveCount(0);
    await expect(page.locator('.sidebar-pin-dropzone')).toContainText('Drag to pin nodes');

    await page.getByRole('button', { name: 'Open Root' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();

    const rootPinnedTree = page.getByLabel('Pinned nodes');
    await expect(rootPinnedTree.locator('.workspace-tree-row').filter({ hasText: 'Root' })).toBeVisible();
    await rootPinnedTree.getByRole('button', { name: 'Expand Root' }).click();
    await expect(rootPinnedTree.locator('.workspace-tree-row').filter({ hasText: 'Library' })).toBeVisible();
  });

  test('dragging an outliner node onto the pinned dropzone pins it', async ({ page }) => {
    await expect(page.locator('.sidebar-pin-dropzone')).toContainText('Drag to pin nodes');

    // Outliner rows use HTML5 DnD: dragstart writes the node id into a custom
    // MIME on a shared DataTransfer; the sidebar reads it on drop. Dispatch the
    // sequence manually so the real handlers run (synthetic mouse drags don't
    // populate dataTransfer).
    await page.evaluate((nodeId) => {
      const source = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] .row-bullet-button`);
      if (!source) throw new Error(`Missing drag source ${nodeId}`);
      const dataTransfer = new DataTransfer();
      const rect = source.getBoundingClientRect();
      source.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        dataTransfer,
      }));
      const dropzone = document.querySelector<HTMLElement>('.sidebar-pin-dropzone');
      if (!dropzone) throw new Error('Missing pinned dropzone');
      const dropRect = dropzone.getBoundingClientRect();
      const eventInit: DragEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: dropRect.left + dropRect.width / 2,
        clientY: dropRect.top + dropRect.height / 2,
        dataTransfer,
      };
      dropzone.dispatchEvent(new DragEvent('dragover', eventInit));
      dropzone.dispatchEvent(new DragEvent('drop', eventInit));
    }, ids.alpha);

    const pinnedTree = page.getByLabel('Pinned nodes');
    await expect(pinnedTree.locator('.workspace-tree-row').filter({ hasText: 'Alpha' })).toBeVisible();
    await expect(page.locator('.sidebar-pin-dropzone')).toHaveCount(0);
    await expect.poll(async () => page.evaluate((key) => (
      window.localStorage.getItem(key) ?? ''
    ), WORKSPACE_PINNED_NODES_STORAGE_KEY)).toContain(`"nodeIds":["${ids.alpha}"]`);
  });

  test('sidebar pinned nodes drop stale ids on restore', async ({ page }) => {
    await page.evaluate(({ key, ids }) => {
      window.localStorage.setItem(key, JSON.stringify({
        version: 1,
        nodeIds: ['missing-node', ids.beta, ids.beta],
      }));
    }, { key: WORKSPACE_PINNED_NODES_STORAGE_KEY, ids });

    await page.reload();

    const pinnedTree = page.getByLabel('Pinned nodes');
    await expect(pinnedTree).toContainText('Beta');
    await expect(pinnedTree.locator('.workspace-tree-row')).toHaveCount(1);
    await expect.poll(async () => page.evaluate((key) => (
      window.localStorage.getItem(key) ?? ''
    ), WORKSPACE_PINNED_NODES_STORAGE_KEY)).toContain(`"nodeIds":["${ids.beta}"]`);
  });

  test('panes persist across reload and can be closed', async ({ page }) => {
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(1);

    // Open a second pane, then point the active pane at Schema.
    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(2);
    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Schema', exact: true }).click();
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Schema');

    // The layout is persisted with today's local date and restored on same-day
    // reload.
    await page.reload();
    await expect(panels).toHaveCount(2);
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Schema');

    // Closing a pane via its breadcrumb × drops back to a single pane.
    await page.locator('.outline-panel-surface.active-panel')
      .getByRole('button', { name: 'Close panel' }).click();
    await expect(panels).toHaveCount(1);
  });

  test('outline expansion state restores by root page across reload', async ({ page }) => {
    await page.evaluate(({ layoutStorageKey, rootId }) => {
      const date = new Date();
      const localDate = [
        String(date.getFullYear()).padStart(4, '0'),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ].join('-');
      window.localStorage.setItem(layoutStorageKey, JSON.stringify({
        version: 3,
        localDate,
        activePanelId: 'panel-root',
        panels: [{
          id: 'panel-root',
          type: 'workspace',
          view: { kind: 'outliner', rootId },
          size: 1,
          backStack: [],
          forwardStack: [],
        }],
      }));
    }, { layoutStorageKey: WORKSPACE_LAYOUT_STORAGE_KEY, rootId: ids.root });
    await page.reload();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Root');
    await expect(row(page, ids.daily)).toBeVisible();
    await expect(row(page, ids.today)).toHaveCount(0);

    await row(page, ids.daily).locator(':scope > .row .row-chevron-button').first().click({ force: true });
    await expect(row(page, ids.today)).toBeVisible();
    await expect.poll(async () => page.evaluate(() => (
      window.localStorage.getItem('lin-outliner:outline-view-state:v1') ?? ''
    ))).toContain(ids.daily);

    await page.reload();

    await expect(page.locator('.panel-title-editor').first()).toContainText('Root');
    await expect(row(page, ids.today)).toBeVisible();
    await expect(row(page, ids.daily)).toHaveClass(/expanded/);
  });

  test('outline expansion state restores every persisted outliner pane', async ({ page }) => {
    await page.evaluate(({ ids, layoutStorageKey, outlineStorageKey }) => {
      const date = new Date();
      const localDate = [
        String(date.getFullYear()).padStart(4, '0'),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ].join('-');
      window.localStorage.setItem(layoutStorageKey, JSON.stringify({
        version: 3,
        localDate,
        activePanelId: 'panel-daily',
        panels: [{
          id: 'panel-root',
          type: 'workspace',
          view: { kind: 'outliner', rootId: ids.root },
          size: 0.5,
          backStack: [],
          forwardStack: [],
        }, {
          id: 'panel-daily',
          type: 'workspace',
          view: { kind: 'outliner', rootId: ids.daily },
          size: 0.5,
          backStack: [],
          forwardStack: [],
        }],
      }));
      window.localStorage.setItem(outlineStorageKey, JSON.stringify({
        version: 1,
        byRootNodeId: {
          [ids.root]: {
            expandedNodeIds: [ids.daily],
            expandedHiddenFieldKeys: [],
            updatedAt: 2,
          },
          [ids.daily]: {
            expandedNodeIds: [ids.today],
            expandedHiddenFieldKeys: [],
            updatedAt: 1,
          },
        },
      }));
    }, {
      ids,
      layoutStorageKey: WORKSPACE_LAYOUT_STORAGE_KEY,
      outlineStorageKey: OUTLINE_VIEW_STATE_STORAGE_KEY,
    });

    await page.reload();

    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0).locator('.panel-title-editor')).toContainText('Root');
    await expect(panels.nth(1).locator('.panel-title-editor')).toContainText('Daily Notes');
    await expect(panels.nth(0).locator(`[data-node-id="${ids.today}"]`)).toBeVisible();
    await expect(panels.nth(1).locator(`[data-node-id="${ids.alpha}"]`)).toBeVisible();
  });

  test('stale persisted pane layout falls back to Today on a new local day', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
    await page.evaluate(() => {
      window.localStorage.setItem('lin-outliner:workspace-layout:v4', JSON.stringify({
        version: 3,
        localDate: '1999-01-01',
        activePanelId: 'panel-stale',
        panels: [{
          id: 'panel-stale',
          type: 'workspace',
          view: { kind: 'outliner', rootId: 'alpha' },
          size: 1,
          backStack: [],
          forwardStack: [],
        }],
      }));
    });

    await page.reload();

    await expect(page.locator('.panel-title-editor').first()).toContainText('May 13');
    await expect(row(page, ids.alpha)).toContainText('Alpha');
  });

  test('panes open from keyboard and sidebar option-click up to the cap', async ({ page }) => {
    await page.setViewportSize({ width: 2300, height: 900 });
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(1);

    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(2);
    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(3);

    // Alt/Option-click a sidebar entry opens it in a new pane.
    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Recents', exact: true }).click({ modifiers: ['Alt'] });
    await expect(panels).toHaveCount(4);
    await expect(panels.nth(3).locator('.panel-title-editor')).toContainText('Recents');

    // Capped at MAX_PERSISTED_PANELS (4): opening another pane replaces the
    // rightmost pane's root instead of adding a fifth.
    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Library', exact: true }).click({ modifiers: ['Alt'] });
    await expect(panels).toHaveCount(4);
    await expect(panels.nth(3).locator('.panel-title-editor')).toContainText('Library');

    // Clicking a pane activates it.
    await panels.first().click();
    await expect(panels.first()).toHaveClass(/active/);
  });
});
