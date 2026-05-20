import { expect, test } from '@playwright/test';
import { commandCalls, emitAgentProjection, openMockedApp } from './outlinerMock';

async function waitForAgentSession(page: import('@playwright/test').Page) {
  await expect.poll(async () => {
    const calls = await commandCalls(page);
    return calls.some((call) => call.cmd === 'agent_restore_latest_session');
  }).toBe(true);
}

test.describe('agent composer controls', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await waitForAgentSession(page);
  });

  test('sends from the primary action and keeps attachment chips removable', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.fill('Summarize current outline.');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_send_message')?.args;
    }).toMatchObject({
      message: 'Summarize current outline.',
      sessionId: 'mock-agent-session',
    });

    await page.locator('.agent-composer-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from test'),
    });
    await expect(page.getByText('notes.txt')).toBeVisible();

    await page.getByRole('button', { name: 'Remove notes.txt' }).click();
    await expect(page.getByText('notes.txt')).toHaveCount(0);
  });

  test('uses shared menu semantics for model and reasoning controls', async ({ page }) => {
    const modelButton = page.getByRole('button', { name: 'Select model' });
    await expect(modelButton).toHaveAttribute('aria-expanded', 'false');
    await modelButton.click();
    await expect(modelButton).toHaveAttribute('aria-expanded', 'true');

    const menu = page.getByRole('menu', { name: 'Model and reasoning settings' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('border-top-width', '0px');
    await expect(menu.getByRole('menuitem', { name: 'GPT-5.4', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Claude Sonnet 4.5', exact: true })).toHaveCount(0);
    const thinkingSwitch = menu.getByRole('switch', { name: 'Thinking' });
    const thinkingSwitchMark = thinkingSwitch.locator('.switch-mark');
    await expect(thinkingSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(thinkingSwitchMark).toHaveClass(/checked/);
    await expect(thinkingSwitchMark).toHaveCSS('width', '30px');
    await expect(thinkingSwitchMark).toHaveCSS('height', '18px');
    await expect(thinkingSwitch.locator('.switch-mark-thumb')).toHaveCSS('width', '14px');

    await menu.getByRole('menuitem', { name: 'GPT-5.4 Mini', exact: true }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => (
        call.cmd === 'agent_upsert_provider_config'
        && call.args.provider
        && typeof call.args.provider === 'object'
        && 'modelId' in call.args.provider
        && call.args.provider.modelId === 'gpt-5.4-mini'
      ));
    }).toBe(true);

    await modelButton.click();
    await page.getByRole('button', { name: 'Thinking level' }).click();
    const thinkingLevels = page.getByRole('menu', { name: 'Thinking levels' });
    await expect(thinkingLevels).toHaveCSS('border-top-width', '0px');
    await expect(thinkingLevels.getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    await thinkingLevels.getByRole('menuitemradio', { name: 'High' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => (
        call.cmd === 'agent_upsert_provider_config'
        && call.args.provider
        && typeof call.args.provider === 'object'
        && 'reasoningLevel' in call.args.provider
        && call.args.provider.reasoningLevel === 'high'
      ));
    }).toBe(true);
  });

  test('keeps provider settings in the top chrome more menu', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Agent settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open settings' })).toHaveCount(0);

    await page.locator('.top-chrome-right').getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Provider settings' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Select model' }).click();
    await expect(page.getByRole('menuitem', { name: 'API Settings' })).toHaveCount(0);
  });

  test('keeps the composer surface unified with neutral focus', async ({ page }) => {
    await expect(page.locator('.agent-composer-toolbar')).toHaveCSS('border-top-width', '0px');

    const input = page.locator('.agent-composer-input');
    await input.click();
    await expect(input).toBeFocused();
    const focusState = await input.evaluate((element) => {
      const surface = element.closest('.agent-composer-surface');
      if (!(surface instanceof HTMLElement)) {
        return null;
      }

      return {
        focusWithin: surface.matches(':focus-within'),
        shadow: getComputedStyle(surface).boxShadow,
      };
    });

    expect(focusState).not.toBeNull();
    expect(focusState!.focusWithin).toBe(true);
    expect(focusState!.shadow).not.toContain('244, 63, 94');
  });

  test('keeps the composer bottom-aligned with the shared dock inset', async ({ page }) => {
    const metrics = await page.locator('.agent-chat-panel').evaluate((panel) => {
      const dock = document.querySelector('.agent-dock');
      const header = document.querySelector('.agent-dock-header');
      const outlinePanel = document.querySelector('.outline-panel-surface');
      const sidebar = document.querySelector('.sidebar-dock');
      const scroll = document.querySelector('.agent-chat-scroll');
      const composer = document.querySelector('.agent-composer');
      const surface = document.querySelector('.agent-composer-surface');
      if (
        !(dock instanceof HTMLElement)
        || !(header instanceof HTMLElement)
        || !(outlinePanel instanceof HTMLElement)
        || !(sidebar instanceof HTMLElement)
        || !(scroll instanceof HTMLElement)
        || !(composer instanceof HTMLElement)
        || !(surface instanceof HTMLElement)
        || !(panel instanceof HTMLElement)
      ) {
        return null;
      }

      const dockBox = dock.getBoundingClientRect();
      const outlinePanelBox = outlinePanel.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      const composerStyle = getComputedStyle(composer);
      const outlinePanelStyle = getComputedStyle(outlinePanel);
      const sidebarStyle = getComputedStyle(sidebar);
      const scrollStyle = getComputedStyle(scroll);
      const headerStyle = getComputedStyle(header);
      const surfaceStyle = getComputedStyle(surface);
      const actionButton = surface.querySelector('.agent-composer-action-button');
      const attachmentButton = surface.querySelector('.agent-composer-tool-button');
      const modelButton = surface.querySelector('.agent-composer-model-button');
      const actionStyle = actionButton instanceof HTMLElement ? getComputedStyle(actionButton) : null;
      const attachmentStyle = attachmentButton instanceof HTMLElement ? getComputedStyle(attachmentButton) : null;
      const modelStyle = modelButton instanceof HTMLElement ? getComputedStyle(modelButton) : null;
      const actionBox = actionButton instanceof HTMLElement ? actionButton.getBoundingClientRect() : null;
      const attachmentBox = attachmentButton instanceof HTMLElement ? attachmentButton.getBoundingClientRect() : null;
      const rootStyle = getComputedStyle(document.documentElement);

      return {
        actionBottomInset: actionBox ? surfaceBox.bottom - actionBox.bottom : null,
        actionRadius: actionStyle ? Number.parseFloat(actionStyle.borderTopLeftRadius) : null,
        actionRightInset: actionBox ? surfaceBox.right - actionBox.right : null,
        actionSize: actionBox ? actionBox.width : null,
        attachmentBottomInset: attachmentBox ? surfaceBox.bottom - attachmentBox.bottom : null,
        attachmentLeftInset: attachmentBox ? attachmentBox.left - surfaceBox.left : null,
        attachmentRadius: attachmentStyle ? Number.parseFloat(attachmentStyle.borderTopLeftRadius) : null,
        attachmentSize: attachmentBox ? attachmentBox.width : null,
        expectedSurfaceRadius: Number.parseFloat(rootStyle.getPropertyValue('--agent-composer-radius')),
        modelRadius: modelStyle ? Number.parseFloat(modelStyle.borderTopLeftRadius) : null,
        composerBottomDelta: Math.abs(panelBox.bottom - composerBox.bottom),
        composerPaddingBottom: Number.parseFloat(composerStyle.paddingBottom),
        composerPaddingLeft: Number.parseFloat(composerStyle.paddingLeft),
        composerPaddingRight: Number.parseFloat(composerStyle.paddingRight),
        headerPaddingLeft: Number.parseFloat(headerStyle.paddingLeft),
        headerPaddingRight: Number.parseFloat(headerStyle.paddingRight),
        panelRadius: Number.parseFloat(outlinePanelStyle.borderTopLeftRadius),
        sidebarPaddingRight: Number.parseFloat(sidebarStyle.paddingRight),
        scrollPaddingLeft: Number.parseFloat(scrollStyle.paddingLeft),
        scrollPaddingRight: Number.parseFloat(scrollStyle.paddingRight),
        surfaceBottomToPanelBottom: Math.abs(outlinePanelBox.bottom - surfaceBox.bottom),
        surfaceLeftInset: surfaceBox.left - dockBox.left,
        surfacePaddingBottom: Number.parseFloat(surfaceStyle.paddingBottom),
        surfacePaddingLeft: Number.parseFloat(surfaceStyle.paddingLeft),
        surfacePaddingRight: Number.parseFloat(surfaceStyle.paddingRight),
        surfaceRadius: Number.parseFloat(surfaceStyle.borderTopLeftRadius),
        surfaceRightInset: dockBox.right - surfaceBox.right,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.composerBottomDelta).toBeLessThanOrEqual(1);
    expect(metrics!.composerPaddingBottom).toBe(0);
    expect(metrics!.composerPaddingLeft).toBe(0);
    expect(metrics!.composerPaddingRight).toBe(0);
    expect(metrics!.headerPaddingLeft).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.headerPaddingRight).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.scrollPaddingLeft).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.scrollPaddingRight).toBe(metrics!.sidebarPaddingRight);
    expect(metrics!.surfaceBottomToPanelBottom).toBeLessThanOrEqual(1);
    expect(metrics!.surfacePaddingLeft).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.surfacePaddingBottom).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.surfaceRadius).toBe(metrics!.expectedSurfaceRadius);
    expect(metrics!.surfaceRadius).toBe(metrics!.panelRadius);
    expect(metrics!.actionRadius).toBe(metrics!.surfaceRadius - metrics!.surfacePaddingRight);
    expect(metrics!.attachmentRadius).toBe(metrics!.surfaceRadius - metrics!.surfacePaddingLeft);
    expect(metrics!.modelRadius).toBe(metrics!.actionRadius);
    expect(metrics!.actionSize).toBe(metrics!.attachmentSize);
    expect(Math.abs(metrics!.attachmentLeftInset! - metrics!.surfacePaddingLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentBottomInset! - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset! - metrics!.surfacePaddingRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionBottomInset! - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentLeftInset! - metrics!.attachmentBottomInset!)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset! - metrics!.actionBottomInset!)).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceLeftInset).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceRightInset).toBeLessThanOrEqual(1);
  });

  test('conversation menu stays anchored inside narrow agent surfaces', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 620 });

    await page.getByRole('button', { name: 'Show conversations' }).click();
    const menu = page.getByRole('dialog', { name: 'Conversations' });
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(752);
  });

  test('keeps the header title compact and free of decorative status dots', async ({ page }) => {
    const metrics = await page.locator('.agent-dock-header').evaluate((header) => {
      const titleButton = header.querySelector('.agent-dock-title-button');
      const title = header.querySelector('.agent-dock-title');
      const chevron = header.querySelector('.agent-title-chevron');
      const actions = header.querySelector('.agent-dock-actions');
      if (
        !(header instanceof HTMLElement)
        || !(titleButton instanceof HTMLElement)
        || !(title instanceof HTMLElement)
        || !(chevron instanceof SVGElement)
        || !(actions instanceof HTMLElement)
      ) {
        return null;
      }

      const titleButtonBox = titleButton.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const chevronBox = chevron.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      const titleStyle = getComputedStyle(titleButton);
      const firstAction = actions.querySelector('.agent-menu-button');
      const actionStyle = firstAction instanceof HTMLElement ? getComputedStyle(firstAction) : null;
      const rootStyle = getComputedStyle(document.documentElement);

      function computedTokenColor(token: string) {
        const swatch = document.createElement('span');
        swatch.style.color = token;
        document.body.appendChild(swatch);
        const color = getComputedStyle(swatch).color;
        swatch.remove();
        return color;
      }

      return {
        actionColor: actionStyle?.color ?? null,
        buttonBackground: titleStyle.backgroundColor,
        buttonExtraWidth: titleButtonBox.width - titleBox.width - chevronBox.width,
        buttonPaddingLeft: Number.parseFloat(titleStyle.paddingLeft),
        chevronOpacity: getComputedStyle(chevron).opacity,
        gapToActions: actionsBox.left - titleButtonBox.right,
        textFaint: computedTokenColor(rootStyle.getPropertyValue('--text-faint').trim()),
        textSoft: computedTokenColor(rootStyle.getPropertyValue('--text-soft').trim()),
        textStrong: computedTokenColor(rootStyle.getPropertyValue('--text-strong').trim()),
        titleColor: getComputedStyle(title).color,
        titleText: title.textContent?.trim() ?? '',
        statusDotCount: header.querySelectorAll('.agent-status-dot').length,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.statusDotCount).toBe(0);
    expect(metrics!.titleText.startsWith('#')).toBe(false);
    expect(metrics!.buttonBackground).toBe('rgba(0, 0, 0, 0)');
    expect(metrics!.titleColor).toBe(metrics!.textSoft);
    expect(metrics!.actionColor).toBe(metrics!.textFaint);
    expect(metrics!.chevronOpacity).toBe('0');
    expect(metrics!.buttonPaddingLeft).toBe(4);
    expect(metrics!.buttonExtraWidth).toBeLessThanOrEqual(24);
    expect(metrics!.gapToActions).toBeGreaterThanOrEqual(8);

    await page.locator('.agent-dock-title-button').hover();
    await expect.poll(async () => page.locator('.agent-dock-header').evaluate((header) => {
      const titleButton = header.querySelector('.agent-dock-title-button');
      const title = header.querySelector('.agent-dock-title');
      const chevron = header.querySelector('.agent-title-chevron');
      if (
        !(titleButton instanceof HTMLElement)
        || !(title instanceof HTMLElement)
        || !(chevron instanceof SVGElement)
      ) {
        return null;
      }

      return {
        buttonBackground: getComputedStyle(titleButton).backgroundColor,
        chevronOpacity: getComputedStyle(chevron).opacity,
        titleColor: getComputedStyle(title).color,
      };
    })).toEqual({
      buttonBackground: 'rgba(0, 0, 0, 0)',
      chevronOpacity: '0.72',
      titleColor: metrics!.textStrong,
    });
  });

  test('keeps conversation rename geometry stable', async ({ page }) => {
    await page.getByRole('button', { name: 'Show conversations' }).click();
    const menu = page.getByRole('dialog', { name: 'Conversations' });
    await expect(menu).toBeVisible();

    const row = menu.locator('.agent-session-row').nth(1);
    await expect(row).toBeVisible();
    const before = await row.boundingBox();
    expect(before).toBeTruthy();

    await row.hover();
    await row.getByRole('button', { name: 'Rename conversation' }).click();
    await expect(row.getByLabel('Conversation title')).toBeVisible();

    const after = await row.boundingBox();
    expect(after).toBeTruthy();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  });

  test('switches the primary action between stop and queued follow-up while streaming', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [],
      conversation: [],
      streamingMessage: null,
      isStreaming: true,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    const stopIcon = await page.getByRole('button', { name: 'Stop agent' }).locator('svg').evaluate((icon) => {
      const style = getComputedStyle(icon);
      return {
        fill: style.fill,
        strokeWidth: style.strokeWidth,
      };
    });
    expect(stopIcon.fill).not.toBe('none');
    expect(Number.parseFloat(stopIcon.strokeWidth)).toBe(0);

    await page.getByRole('button', { name: 'Stop agent' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'agent_stop_session');
    }).toBe(true);

    await page.getByLabel('Agent message').fill('Compare tag layout stability.');
    await page.getByRole('button', { name: 'Queue follow-up' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_queue_follow_up')?.args;
    }).toMatchObject({
      message: 'Compare tag layout stability.',
      sessionId: 'mock-agent-session',
    });
    await expect(page.getByText('Compare tag layout stability.')).toBeVisible();
  });
});
