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
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(2);
    const firstBefore = await panels.nth(0).boundingBox();
    const secondBefore = await panels.nth(1).boundingBox();
    expect(firstBefore).toBeTruthy();
    expect(secondBefore).toBeTruthy();

    const panelHandle = page.getByRole('button', { name: 'Resize panels' });
    const panelHandleBox = await panelHandle.boundingBox();
    const panelSlotBox = await page.locator('.panel-resize-slot').first().boundingBox();
    expect(panelHandleBox).toBeTruthy();
    expect(panelSlotBox).toBeTruthy();
    // Floating-rails shell (#57): the divider is a 1px hairline slot, and the resize
    // handle is an invisible hit strip straddling it (no grab pill). The ew-resize
    // cursor lives on the handle; the slot just draws the line.
    await expect.poll(async () => panelHandle.evaluate((element) => (
      getComputedStyle(element).cursor
    ))).toBe('ew-resize');
    expect(panelSlotBox!.width).toBe(1);
    const gapCenterBefore = (firstBefore!.x + firstBefore!.width + secondBefore!.x) / 2;
    const handleCenterBefore = panelHandleBox!.x + panelHandleBox!.width / 2;
    const slotCenterBefore = panelSlotBox!.x + panelSlotBox!.width / 2;
    expect(Math.abs(handleCenterBefore - gapCenterBefore)).toBeLessThanOrEqual(1);
    expect(Math.abs(slotCenterBefore - gapCenterBefore)).toBeLessThanOrEqual(1);

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

  test('window chrome aligns the sidebar toggle to the traffic lights and stays icon-only', async ({ page }) => {
    // The floating-rails shell (#57) dissolved the top chrome: page-nav back/forward
    // moved to Cmd+[ / Cmd+] + the per-pane breadcrumb, and the only window-anchored
    // controls left are the rail toggles. They sit in corner drag zones, centred on
    // the traffic-light centreline; the traffic-light geometry now lives on :root.
    const sidebarToggle = page.getByTitle('Collapse sidebar');
    await page.mouse.move(0, 0);

    const initial = await page.evaluate(() => {
      const sidebar = document.querySelector('[title="Collapse sidebar"]');
      if (!(sidebar instanceof HTMLElement)) {
        throw new Error('missing sidebar toggle');
      }
      const sidebarBox = sidebar.getBoundingClientRect();
      const rootStyle = getComputedStyle(document.documentElement);
      const trafficLightSize = Number.parseFloat(rootStyle.getPropertyValue('--traffic-light-size'));
      const trafficLightX = Number.parseFloat(rootStyle.getPropertyValue('--traffic-light-x'));
      const trafficLightY = Number.parseFloat(rootStyle.getPropertyValue('--traffic-light-y'));
      return {
        sidebarBg: getComputedStyle(sidebar).backgroundColor,
        sidebarCenterY: sidebarBox.top + sidebarBox.height / 2,
        sidebarIcon: sidebar.querySelector('svg')?.innerHTML ?? '',
        trafficLightCenterY: trafficLightY + trafficLightSize / 2,
        trafficLightSize,
        trafficLightX,
        trafficLightY,
      };
    });
    expect(initial.sidebarBg).toBe('rgba(0, 0, 0, 0)');
    expect(initial.trafficLightSize).toBe(MAC_TRAFFIC_LIGHT_SIZE);
    expect(initial.trafficLightX).toBe(MAC_TRAFFIC_LIGHT_POSITION.x);
    expect(initial.trafficLightY).toBe(MAC_TRAFFIC_LIGHT_POSITION.y);
    // The corner is symmetric (traffic-light-x == traffic-light-y), and the toggle's
    // vertical centre sits on the traffic-light centreline.
    expect(initial.trafficLightX).toBe(initial.trafficLightY);
    expect(Math.abs(initial.sidebarCenterY - initial.trafficLightCenterY)).toBeLessThanOrEqual(1);

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
      };
    });
    expect(collapsed.sidebarBg).toBe('rgba(0, 0, 0, 0)');
    expect(collapsed.sidebarIcon).not.toBe(initial.sidebarIcon);
  });

  test('single panel centers bounded content and fills when narrow', async ({ page }) => {
    await page.setViewportSize({ width: 1900, height: 900 });
    await page.getByTitle('New tab').click();

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
    await expect(workspaceTree).not.toContainText('Schema');
    await expect(workspaceTree).not.toContainText('Settings');
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
        railPad: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-pad')),
      };
    });
    // New sidebar model (#57): the nav icons, root avatar, pinned section title, and
    // the workspace-tree chevron all share one content-start line; the tree LABEL
    // sits one indent further right, off the chevron (--sidebar-tree-label-gap), so
    // the tree reads as indented children rather than a sibling of the nav group.
    const contentStart = sidebarMetrics.primaryIconLeft;
    expect(Math.abs(sidebarMetrics.pinnedTitleLeft - contentStart)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.pinnedEmptyIconLeft - contentStart)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.rootAvatarLeft - contentStart)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarMetrics.chevronLeft - contentStart)).toBeLessThanOrEqual(1);
    expect(sidebarMetrics.contentLeft).toBeGreaterThan(sidebarMetrics.chevronRight);
    // The row hover-block is inset from the dock's right edge by the rail pad (the
    // rail content is concentric with its rounded corner), not full-bleed.
    expect(Math.abs((sidebarMetrics.sidebarRight - sidebarMetrics.rowRight) - sidebarMetrics.railPad)).toBeLessThanOrEqual(1);
    expect(Math.abs((sidebarMetrics.panelLeft - sidebarMetrics.sidebarRight) - 8)).toBeLessThanOrEqual(1);
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
    // Tree rows take the same neutral hover fill as the other sidebar rows (#57);
    // the row text stays at full strength, so the affordance is the background.
    await expect.poll(async () => firstWorkspaceRow.evaluate((row) => getComputedStyle(row).backgroundColor))
      .not.toBe(treeRowBefore.background);

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

  test('workspace tabs can be closed and restore persisted active roots', async ({ page }) => {
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.locator('.sidebar-tab')).toHaveCount(2);
    const tabWidths = await page.locator('.sidebar-tab').evaluateAll((tabs) => (
      tabs.map((tab) => Math.round(tab.getBoundingClientRect().width))
    ));
    expect(new Set(tabWidths).size).toBe(1);
    await expect.poll(async () => {
      const backgrounds = await page.locator('.sidebar-tab').evaluateAll((tabs) => (
        tabs.map((tab) => getComputedStyle(tab).backgroundColor)
      ));
      return new Set(backgrounds).size;
    }).toBeGreaterThan(1);
    const tabBackgrounds = await page.locator('.sidebar-tab').evaluateAll((tabs) => (
      tabs.map((tab) => getComputedStyle(tab).backgroundColor)
    ));
    // New sidebar model (#57): only the active tab carries a fill (--control-active);
    // inactive tabs stay transparent until hover, so the active vs inactive states
    // read as distinct rather than every tab carrying its own background.
    const activeTabBackground = await page.locator('.sidebar-tab.active')
      .evaluate((tab) => getComputedStyle(tab).backgroundColor);
    expect(activeTabBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(new Set(tabBackgrounds).size).toBeGreaterThan(1);
    const activeTabChrome = await page.locator('.sidebar-tab.active').evaluate((tab) => {
      const style = getComputedStyle(tab);
      const close = tab.querySelector('.sidebar-tab-close');
      if (!(close instanceof HTMLElement)) throw new Error('missing active tab close control');
      const tabRect = tab.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return {
        borderRadius: style.borderRadius,
        closeHeight: Math.round(closeRect.height),
        closeRightInset: Math.round(tabRect.right - closeRect.right),
        closeTopInset: Math.round(closeRect.top - tabRect.top),
        closeWidth: Math.round(closeRect.width),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    });
    // The tab is now a layout container (#57): the text style lives on its segments,
    // so the tab element itself inherits the root font (16px / normal). The close
    // control keeps its 20px box, inset 4px into the top-right corner.
    expect(activeTabChrome).toEqual({
      borderRadius: '6px',
      closeHeight: 20,
      closeRightInset: 4,
      closeTopInset: 4,
      closeWidth: 20,
      fontSize: '16px',
      lineHeight: 'normal',
    });
    const inactiveActiveSegment = page.locator('.sidebar-tab:not(.active) .sidebar-tab-segment.is-active').first();
    const inactiveSegmentWeightBeforeHover = await inactiveActiveSegment.evaluate((segment) => (
      getComputedStyle(segment).fontWeight
    ));
    await page.locator('.sidebar-tab:not(.active)').first().hover();
    const inactiveSegmentWeightAfterHover = await inactiveActiveSegment.evaluate((segment) => (
      getComputedStyle(segment).fontWeight
    ));
    expect(inactiveSegmentWeightAfterHover).toBe(inactiveSegmentWeightBeforeHover);

    await page.getByRole('button', { name: 'Schema' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Schema');

    await page.reload();
    await expect(page.locator('.sidebar-tab')).toHaveCount(2);
    await expect(page.locator('.panel-title-editor').first()).toContainText('Schema');

    await page.locator('.sidebar-tab.active .sidebar-tab-close').click();
    await expect(page.locator('.sidebar-tab')).toHaveCount(1);
  });

  test('current tab can open additional panels from keyboard and sidebar option click', async ({ page }) => {
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(2);

    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(3);

    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Recents', exact: true }).click({ modifiers: ['Alt'] });
    await expect(panels).toHaveCount(4);
    const activeTabSegments = page.locator('.sidebar-tab.active .sidebar-tab-segment');
    await expect(activeTabSegments).toHaveCount(4);
    await expect(page.locator('.sidebar-tab.active .sidebar-tab-count')).toHaveCount(0);
    await expect(activeTabSegments.nth(3)).toContainText('Recents');
    const iconSlots = await activeTabSegments.evaluateAll((segments) => (
      segments.map((segment) => {
        const icon = segment.querySelector('.sidebar-tab-segment-icon');
        if (!(icon instanceof HTMLElement)) throw new Error('missing tab segment icon');
        const rect = icon.getBoundingClientRect();
        return {
          height: Math.round(rect.height),
          width: Math.round(rect.width),
        };
      })
    ));
    expect(new Set(iconSlots.map((slot) => slot.width)).size).toBe(1);
    expect(new Set(iconSlots.map((slot) => slot.height)).size).toBe(1);
    expect(iconSlots[0]).toEqual({ height: 16, width: 16 });
    const segmentDivider = await activeTabSegments.nth(1).evaluate((segment) => {
      const divider = getComputedStyle(segment, '::before');
      return {
        backgroundColor: divider.backgroundColor,
        height: divider.height,
        marginLeft: divider.marginLeft,
        marginRight: divider.marginRight,
        width: divider.width,
      };
    });
    expect(segmentDivider).toEqual({
      // The segment divider now uses the neutral --separator token (#57): ink at 10%.
      backgroundColor: 'rgba(0, 0, 0, 0.1)',
      height: '12px',
      marginLeft: '4px',
      marginRight: '4px',
      width: '1px',
    });
    await expect(panels.nth(3).locator('.panel-title-editor')).toContainText('Recents');

    await activeTabSegments.first().click();
    await expect(panels.first()).toHaveClass(/active/);
  });
});
