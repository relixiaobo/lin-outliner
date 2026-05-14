import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

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
    const sidebarHandleBox = await sidebarHandle.boundingBox();
    expect(sidebarHandleBox).toBeTruthy();
    await page.mouse.move(sidebarHandleBox!.x + sidebarHandleBox!.width / 2, sidebarHandleBox!.y + 160);
    await page.mouse.down();
    await page.mouse.move(sidebarHandleBox!.x + 56, sidebarHandleBox!.y + 160);
    await page.mouse.up();

    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(sidebarBefore!.width + 30);

    const agentHandle = page.getByRole('button', { name: 'Resize agent' });
    const agentHandleBox = await agentHandle.boundingBox();
    expect(agentHandleBox).toBeTruthy();
    await page.mouse.move(agentHandleBox!.x + agentHandleBox!.width / 2, agentHandleBox!.y + 160);
    await page.mouse.down();
    await page.mouse.move(agentHandleBox!.x - 70, agentHandleBox!.y + 160);
    await page.mouse.up();

    await expect.poll(async () => (await agent.boundingBox())?.width ?? 0).toBeGreaterThan(agentBefore!.width + 40);
  });

  test('panel split resizes by ratio and canvas does not horizontally scroll', async ({ page }) => {
    const chrome = await page.locator('.top-chrome').boundingBox();
    const activeTab = await page.locator('.workspace-tab.active').boundingBox();
    const sidebarToggle = await page.getByTitle('Collapse sidebar').boundingBox();
    const backButton = await page.getByTitle('Back').boundingBox();
    const forwardButton = await page.getByTitle('Forward').boundingBox();
    const addTabButton = await page.getByTitle('New tab').boundingBox();
    const agentToggle = await page.getByTitle('Collapse agent').boundingBox();
    const accountButton = await page.getByTitle('Account').boundingBox();
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(2);
    await expect(page.locator('.top-chrome')).toHaveAttribute('data-electron-drag-region', 'deep');
    const firstBefore = await panels.nth(0).boundingBox();
    const secondBefore = await panels.nth(1).boundingBox();
    expect(chrome).toBeTruthy();
    expect(activeTab).toBeTruthy();
    expect(sidebarToggle).toBeTruthy();
    expect(backButton).toBeTruthy();
    expect(forwardButton).toBeTruthy();
    expect(addTabButton).toBeTruthy();
    expect(agentToggle).toBeTruthy();
    expect(accountButton).toBeTruthy();
    expect(firstBefore).toBeTruthy();
    expect(secondBefore).toBeTruthy();
    expect(Math.round(activeTab!.y - chrome!.y)).toBe(8);
    expect(Math.round(sidebarToggle!.y - chrome!.y)).toBe(8);
    expect(Math.round(firstBefore!.y - (chrome!.y + chrome!.height))).toBe(8);
    const chromeCenterY = activeTab!.y + activeTab!.height / 2;
    for (const controlBox of [sidebarToggle, backButton, forwardButton, addTabButton, agentToggle, accountButton]) {
      expect(Math.abs(chromeCenterY - (controlBox!.y + controlBox!.height / 2))).toBeLessThanOrEqual(1);
    }

    const panelHandle = page.getByRole('button', { name: 'Resize panels' });
    const panelHandleBox = await panelHandle.boundingBox();
    const panelSlotBox = await page.locator('.panel-resize-slot').first().boundingBox();
    expect(panelHandleBox).toBeTruthy();
    expect(panelSlotBox).toBeTruthy();
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

    const canvasOverflow = await page.locator('.workspace-canvas').evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(canvasOverflow.overflowX).toBe('hidden');
    expect(canvasOverflow.scrollWidth).toBeLessThanOrEqual(canvasOverflow.clientWidth + 1);
  });

  test('workspace section renders the root node as an expandable tree', async ({ page }) => {
    const workspaceTree = page.getByLabel('Workspace tree');
    await expect(workspaceTree).not.toContainText('Root');
    await expect(workspaceTree).toContainText('Daily Notes');
    await expect(workspaceTree).toContainText('Schema');

    await workspaceTree.getByRole('button', { name: 'Expand Daily Notes' }).click();
    await expect(workspaceTree).toContainText('2026-05-13');
  });

  test('workspace tabs can be closed and restore persisted active roots', async ({ page }) => {
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.locator('.workspace-tab')).toHaveCount(2);

    await page.getByRole('button', { name: 'Supertags' }).click();
    await expect(page.locator('.panel-title-editor').first()).toContainText('Schema');

    await page.reload();
    await expect(page.locator('.workspace-tab')).toHaveCount(2);
    await expect(page.locator('.panel-title-editor').first()).toContainText('Schema');

    await page.locator('.workspace-tab.active .workspace-tab-close').click();
    await expect(page.locator('.workspace-tab')).toHaveCount(1);
  });

  test('current tab can open additional panels from keyboard and sidebar option click', async ({ page }) => {
    const panels = page.locator('.outline-panel-surface');
    await expect(panels).toHaveCount(2);

    await page.keyboard.press('Meta+M');
    await expect(panels).toHaveCount(3);

    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Search', exact: true }).click({ modifiers: ['Alt'] });
    await expect(panels).toHaveCount(4);
    await expect(page.locator('.workspace-tab.active .workspace-tab-count')).toHaveText('4');
    await expect(panels.nth(3).locator('.panel-title-editor')).toContainText('Searches');
  });
});
