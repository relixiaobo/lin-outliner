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

  test('passes slash commands through for runtime compact and skill handling', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.fill('/compact keep only current project decisions');
    await page.getByRole('button', { name: 'Send message' }).click();

    await input.fill('/auto-skill runtime-check');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls
        .filter((call) => call.cmd === 'agent_send_message')
        .map((call) => call.args.message);
    }).toEqual([
      '/compact keep only current project decisions',
      '/auto-skill runtime-check',
    ]);
  });

  test('shows compact progress before expandable summaries', async ({ page }) => {
    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      activeCompaction: {
        id: 'active-compact-1',
        trigger: 'manual',
        startedAt: 1_800_000_000_000,
      },
    });

    const compactStatus = page.locator('.agent-compaction-toggle.is-active');
    await expect(compactStatus).toBeVisible();
    await expect(compactStatus).toContainText('Compacting');
    await expect(compactStatus).toContainText('Manual');
    await expect(page.getByRole('button', { name: /Compacted/ })).toHaveCount(0);

    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        {
          nodeId: 'user-before-compact',
          message: {
            role: 'user',
            timestamp: 1_800_000_000_000 - 800,
            content: [{ type: 'text', text: 'Previous user request before compact.' }],
          },
        },
        {
          nodeId: 'assistant-before-compact',
          message: {
            role: 'assistant',
            timestamp: 1_800_000_000_000 - 700,
            api: 'openai-completions',
            provider: 'openai',
            model: 'gpt-5.4',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
            content: [
              { type: 'text', text: 'Previous assistant response before compact.' },
              { type: 'toolCall', id: 'compact-archive-tool-1', name: 'node_read', arguments: { nodeId: 'node-alpha' } },
            ],
          },
        },
        {
          kind: 'compaction',
          compaction: {
            id: 'compact-1',
            messageId: 'compact-root',
            summary: 'Primary Request and Intent\n\nContinue implementing the compact UI boundary.',
            compactedThroughMessageId: 'assistant-before-compact',
            trigger: 'manual',
            createdAt: 1_800_000_000_000,
          },
        },
      ],
      messages: [{
        role: 'toolResult',
        toolCallId: 'compact-archive-tool-1',
        toolName: 'node_read',
        timestamp: 1_800_000_000_000 - 650,
        content: [{ type: 'text', text: 'Previous tool result before compact.' }],
        isError: false,
      }],
    }, 2);

    await expect(compactStatus).toHaveCount(0);
    const compactToggle = page.getByRole('button', { name: /Compacted/ });
    await expect(compactToggle).toBeVisible();
    await expect(compactToggle).toContainText('Manual');
    await expect(page.locator('.agent-user-bubble', { hasText: 'Conversation compacted.' })).toHaveCount(0);
    await expect(page.getByText('Primary Request and Intent')).toHaveCount(0);
    await expect(page.getByText('Previous user request before compact.')).toBeVisible();
    await expect(page.getByText('Previous assistant response before compact.')).toBeVisible();
    await page.getByRole('button', { name: /Read node/ }).click();
    await expect(page.getByText(/Previous tool result before compact/)).toBeVisible();

    await compactToggle.click();

    await expect(page.getByText('Primary Request and Intent')).toBeVisible();
    await expect(page.getByText('Continue implementing the compact UI boundary.')).toBeVisible();
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

  test('switches the primary action between stop and steer while streaming', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Steer agent' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_steer_session')?.args;
    }).toMatchObject({
      message: 'Compare tag layout stability.',
      sessionId: 'mock-agent-session',
    });
    await expect(page.getByText('Compare tag layout stability.')).toBeVisible();
  });

  test('opens subagent details and expands nested tool calls', async ({ page }) => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };

    await emitAgentProjection(page, 'mock-agent-session', {
      sessionTitle: 'Agent System',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        {
          nodeId: 'agent-user-subagent',
          message: {
            role: 'user',
            timestamp: 1_800_000_000_500,
            content: [{ type: 'text', text: 'Use a subagent to inspect the UI.' }],
          },
          branches: null,
        },
        {
          nodeId: 'agent-assistant-subagent',
          message: {
            role: 'assistant',
            timestamp: 1_800_000_000_700,
            api: 'openai-completions',
            provider: 'openai',
            model: 'gpt-5.4',
            usage,
            stopReason: 'toolUse',
            content: [{
              type: 'toolCall',
              id: 'tool-agent-1',
              name: 'Agent',
              arguments: {
                description: 'Inspect subagent UI',
                prompt: 'Inspect the current UI.',
              },
            }],
          },
          branches: null,
        },
      ],
      subagents: [{
        id: 'subagent-1',
        description: 'Inspect subagent UI',
        prompt: 'Inspect the current UI.',
        subagentType: 'explorer',
        contextMode: 'fork',
        status: 'running',
        startedAt: 1_800_000_000_800,
        updatedAt: 1_800_000_001_200,
        transcriptPayloadId: 'subagent-transcript-1',
        transcriptMessageCount: 4,
        parentToolCallId: 'tool-agent-1',
      }],
    });

    await expect(page.getByText('Subagent · Inspect subagent UI')).toBeVisible();
    await page.getByText('Subagent · Inspect subagent UI').click();
    await expect(page.getByText('fork · explorer')).toBeVisible();

    await page.getByRole('button', { name: 'View transcript' }).click();
    const details = page.getByRole('complementary', { name: 'Subagent details' });
    await expect(details).toBeVisible();
    await expect(details.getByText('Timeline (4)')).toBeVisible();
    await expect(details.getByText('Inspect the current UI.')).toBeVisible();
    await expect(details.getByText('Read node "today"')).toBeVisible();

    await details.getByText('Read node "today"').click();
    await expect(details.getByText('Daily note content from subagent.')).toBeVisible();

    await details.getByLabel('Subagent follow-up').fill('Continue with layout risks.');
    await details.getByRole('button', { name: 'Send' }).click();
    await details.getByRole('button', { name: 'Stop' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.filter((call) => call.cmd === 'agent_subagent_send' || call.cmd === 'agent_subagent_stop')
        .map((call) => ({ cmd: call.cmd, args: call.args }));
    }).toEqual([
      {
        cmd: 'agent_subagent_send',
        args: {
          agentId: 'subagent-1',
          message: 'Continue with layout risks.',
          sessionId: 'mock-agent-session',
        },
      },
      {
        cmd: 'agent_subagent_stop',
        args: {
          agentId: 'subagent-1',
          sessionId: 'mock-agent-session',
        },
      },
    ]);
  });
});
