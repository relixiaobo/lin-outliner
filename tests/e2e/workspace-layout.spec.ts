import { expect, test } from '@playwright/test';
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  MAC_TRAFFIC_LIGHT_SIZE,
} from '../../src/core/chromeGeometry';
import { e2eProjection, emitDocumentEvent, ids, openMockedApp } from './outlinerMock';

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
    await expect.poll(async () => panelHandle.evaluate((element) => (
      getComputedStyle(element).cursor
    ))).toBe('ew-resize');
    await expect.poll(async () => page.locator('.panel-resize-slot').first().evaluate((element) => (
      getComputedStyle(element).cursor
    ))).toBe('ew-resize');
    expect(panelSlotBox!.width).toBe(8);
    const gapCenterBefore = (firstBefore!.x + firstBefore!.width + secondBefore!.x) / 2;
    const handleCenterBefore = panelHandleBox!.x + panelHandleBox!.width / 2;
    const slotCenterBefore = panelSlotBox!.x + panelSlotBox!.width / 2;
    expect(Math.abs(handleCenterBefore - gapCenterBefore)).toBeLessThanOrEqual(1);
    expect(Math.abs(slotCenterBefore - gapCenterBefore)).toBeLessThanOrEqual(1);
    await expect.poll(async () => panelHandle.evaluate((element) => (
      getComputedStyle(element, '::after').width
    ))).toBe('4px');
    await expect.poll(async () => panelHandle.evaluate((element) => (
      getComputedStyle(element, '::after').height
    ))).toBe('32px');

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

    const closingStart = await zone.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        transitionDelay: style.transitionDelay,
      };
    });
    expect(closingStart.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(closingStart.transitionDelay).toBe('0.16s');

    await page.waitForTimeout(180);
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
    // T3: all root sections show in the tree now — including Schema and Settings.
    await expect(workspaceTree).toContainText('Schema');
    await expect(workspaceTree).toContainText('Settings');
    const sidebarMetrics = await workspaceTree.evaluate((tree) => {
      const primaryIcon = document.querySelector('.sidebar-primary-nav .sidebar-nav-icon');
      const pinnedTitle = document.querySelector('.sidebar-section-title');
      const pinnedEmptyIcon = document.querySelector('.sidebar-empty-icon');
      const rootAvatar = document.querySelector('.sidebar-root-avatar');
      const firstRow = tree.querySelector('.workspace-tree-row');
      const firstChevron = firstRow?.querySelector('.workspace-tree-chevron-button');
      const firstContent = firstRow?.querySelector('.workspace-tree-label-icon, .workspace-tree-label-text');
      const sidebarDock = document.querySelector('.sidebar-dock');
      const activePanel = document.querySelector('.outline-panel-surface.active-panel');
      if (!primaryIcon
        || !(pinnedTitle instanceof HTMLElement)
        || !pinnedEmptyIcon
        || !(rootAvatar instanceof HTMLElement)
        || !(firstChevron instanceof HTMLElement)
        || !firstContent
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
      const contentStyle = getComputedStyle(firstContent);
      return {
        chevronColor: chevronStyle.color,
        chevronLeft: firstChevronBox.left,
        chevronRight: firstChevronBox.right,
        chevronWidth: firstChevronBox.width,
        contentColor: contentStyle.color,
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
    const expectedLeft = sidebarMetrics.contentLeft;
    expect(Math.abs(sidebarMetrics.primaryIconLeft - expectedLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.pinnedTitleLeft - expectedLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.pinnedEmptyIconLeft - expectedLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.rootAvatarLeft - expectedLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs((sidebarMetrics.contentLeft - sidebarMetrics.sidebarLeft) - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.sidebarRight - sidebarMetrics.rowRight)).toBeLessThanOrEqual(1);
    expect(Math.abs((sidebarMetrics.panelLeft - sidebarMetrics.sidebarRight) - 8)).toBeLessThanOrEqual(1);
    expect(Math.abs((sidebarMetrics.chevronLeft - sidebarMetrics.sidebarLeft) - 4)).toBeLessThanOrEqual(1);
    expect(Math.round(sidebarMetrics.chevronWidth)).toBe(16);
    expect(sidebarMetrics.chevronRight).toBeLessThanOrEqual(sidebarMetrics.contentLeft);
    expect(sidebarMetrics.chevronColor).not.toBe(sidebarMetrics.contentColor);
    expect(sidebarMetrics.rowHeight).toBe(28);
    expect(sidebarMetrics.rowRadius).toBe('6px');

    const todayNav = page.locator('.sidebar-primary-nav .sidebar-nav-item').filter({ hasText: 'Today' });
    const navBackgroundBefore = await todayNav.evaluate((item) => getComputedStyle(item).backgroundColor);
    await todayNav.hover();
    await expect.poll(async () => todayNav.evaluate((item) => getComputedStyle(item).backgroundColor))
      .not.toBe(navBackgroundBefore);

    const firstWorkspaceRow = workspaceTree.locator('.workspace-tree-row').first();
    const treeRowBefore = await firstWorkspaceRow.evaluate((row) => {
      const style = getComputedStyle(row);
      return {
        background: style.backgroundColor,
        color: style.color,
      };
    });
    await firstWorkspaceRow.hover();
    await expect.poll(async () => firstWorkspaceRow.evaluate((row) => getComputedStyle(row).backgroundColor))
      .toBe(treeRowBefore.background);
    await expect.poll(async () => firstWorkspaceRow.evaluate((row) => getComputedStyle(row).color))
      .not.toBe(treeRowBefore.color);

    await workspaceTree.getByRole('button', { name: 'Expand Daily Notes' }).click();
    await expect(workspaceTree).toContainText('2026-05-13');
  });

  test('system workspace nodes render without a hardcoded fallback icon', async ({ page }) => {
    const workspaceTree = page.getByLabel('Workspace root tree');
    // System nodes carry no icon of their own, so their tree rows show none
    // (no calendar on Daily Notes, no library / search / trash glyphs).
    for (const name of ['Daily Notes', 'Library', 'Saved searches', 'Trash']) {
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

  test('panes persist across reload and can be closed', async ({ page }) => {
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(1);

    // Open a second pane, then point the active pane at Schema.
    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(2);
    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Schema', exact: true }).click();
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Schema');

    // The layout is persisted (localStorage workspace-layout:v2) and restored on
    // reload.
    await page.reload();
    await expect(panels).toHaveCount(2);
    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Schema');

    // Closing a pane via its breadcrumb × drops back to a single pane.
    await page.locator('.outline-panel-surface.active-panel')
      .getByRole('button', { name: 'Close panel' }).click();
    await expect(panels).toHaveCount(1);
  });

  test('panes open from keyboard and sidebar option-click up to the cap', async ({ page }) => {
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
