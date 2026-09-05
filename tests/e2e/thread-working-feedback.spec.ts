import { expect, test, type Page } from '@playwright/test';
import { openMockedApp } from './outlinerMock';
import { emulateVisualMedia, resolveTokenColor } from './emulatedMedia';

async function showLiveWork(page: Page, kind: 'empty' | 'thinking' | 'tools') {
  await page.evaluate(async (kind) => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input: object) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const result = await target.lin!.agentCoreRequest<{ data: { id: string }[] }>('thread/list', {});
    const threadId = result.data[0]!.id;
    const turnId = '01910000-0000-7000-8000-00000000fe01';
    const provenance = (id: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: id });
    const command = (suffix: string, description: string, status: string) => {
      const id = `01910000-0000-7000-8000-00000000fe${suffix}`;
      return {
        id, type: 'commandExecution', provenance: provenance(id),
        command: 'sleep 30', description, cwd: '/mock/workspace', processId: null,
        status, commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
        modelCall: {
          disposition: 'replayable', identity: { namespace: null, name: 'bash' }, providerName: 'bash',
          arguments: { storage: 'inline', value: { command: 'sleep 30' } }, schemaDigest: '0'.repeat(64),
        },
      };
    };
    const thinkingId = '01910000-0000-7000-8000-00000000fe05';
    const thinking = {
      id: thinkingId, type: 'reasoning', provenance: provenance(thinkingId), summary: [], content: [],
    };
    target.__LIN_E2E__!.emitAgentCoreNotification({
      type: 'turn/started', threadId, turnId,
      turn: {
        id: turnId,
        items: kind === 'empty' ? [] : kind === 'thinking' ? [thinking] : [
          command('02', 'Inspect the workspace', 'completed'),
          command('03', 'Run earlier checks', 'inProgress'),
          command('04', 'Verify the active operation', 'inProgress'),
          thinking,
        ],
        itemsView: 'full', provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress', error: null, startedAt: Date.now(), completedAt: null, durationMs: null,
      },
    });
  }, kind);
}

for (const theme of ['light', 'dark'] as const) {
  test(`focuses live feedback without blinking the composer in ${theme}`, async ({ page }, testInfo) => {
    await emulateVisualMedia(page, { colorScheme: theme, reducedTransparency: 'no-preference' });
    await openMockedApp(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread' }).click();
    await showLiveWork(page, 'tools');
    const turn = page.locator('.thread-turn-inProgress');
    const summary = turn.locator('.thread-process-toggle');
    const group = turn.locator('.thread-tool-activity-toggle');
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(turn.locator('.working-text')).toHaveCount(1);
    await expect(group.locator('.working-text')).toHaveCount(1);
    await expect(turn.locator('.thread-streaming-indicator')).toHaveCount(0);
    await expect(turn.locator('.thread-response-footer')).toHaveCount(0);
    const disclosure = group.locator('.thread-disclosure-indicator');
    await expect(disclosure).toHaveCSS('width', '14px');
    await expect(disclosure.locator('.thread-disclosure-status svg')).toHaveCSS('width', '14px');
    await expect(disclosure.locator('.thread-disclosure-chevron svg')).toHaveCSS('width', '15px');
    const labelLeft = await group.locator('.thread-tool-activity-summary').evaluate((element) => element.getBoundingClientRect().left);
    await group.hover();
    await expect(disclosure.locator('.thread-disclosure-chevron')).toHaveCSS('opacity', '1');
    expect(await group.locator('.thread-tool-activity-summary').evaluate((element) => element.getBoundingClientRect().left)).toBe(labelLeft);

    await composer.focus();
    await expect(page.locator('.thread-composer-surface')).toHaveCSS(
      'background-color', await resolveTokenColor(page, '--fill-2'),
    );
    await composer.evaluate((element) => {
      element.dataset.blurCount = '0';
      element.addEventListener('blur', () => {
        element.dataset.blurCount = String(Number(element.dataset.blurCount) + 1);
      });
    });
    const before = await page.locator('.thread-composer-surface').evaluate((element) => ({
      color: getComputedStyle(element).backgroundColor, top: element.getBoundingClientRect().top,
    }));
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await group.click();
      await expect(group).toHaveAttribute('aria-expanded', 'true');
      await expect(turn.locator('.working-text')).toHaveCount(1);
      await expect(turn.locator('.working-text')).toHaveText('Verify the active operation');
      if (cycle === 0) {
        const tool = turn.locator('.thread-tool-toggle').last();
        await tool.hover();
        await expect(tool.locator('.thread-disclosure-chevron svg')).toHaveCSS('width', '15px');
        await expect(tool.locator('.thread-disclosure-chevron')).toHaveCSS('opacity', '1');
        await tool.screenshot({ path: testInfo.outputPath(`disclosure-${theme}.png`) });
      }
      await group.click();
      await summary.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expect(summary.locator('.working-text')).toHaveCount(1);
      await expect(turn.locator('.thread-process-timeline')).toHaveCount(0);
      await summary.click();
      await expect(summary.locator('.working-text')).toHaveCount(0);
      await expect(group.locator('.working-text')).toHaveCount(1);
    }
    await expect(composer).toBeFocused();
    await expect(composer).toHaveAttribute('data-blur-count', '0');
    const frames = await page.locator('.thread-composer-surface').evaluate(async (element) => {
      const samples = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise(requestAnimationFrame);
        samples.push({ color: getComputedStyle(element).backgroundColor, top: element.getBoundingClientRect().top });
      }
      return samples;
    });
    expect(frames.every((frame) => frame.color === before.color && Math.abs(frame.top - before.top) < 1)).toBe(true);
    const stop = page.getByRole('button', { name: 'Interrupt Turn', exact: true });
    await expect(stop.locator('svg')).toHaveAttribute('data-icon', 'Stop');
    expect(await stop.locator('svg').evaluate((element) => element.getBoundingClientRect().width)).toBe(12);
    const sweep = group.locator('.working-text-base');
    await sweep.evaluate((element) => {
      const animation = element.getAnimations()[0]!;
      animation.pause();
      animation.currentTime = 300;
    });
    const resting = await sweep.screenshot({ path: testInfo.outputPath(`sweep-start-${theme}.png`) });
    await sweep.evaluate((element) => { element.getAnimations()[0]!.currentTime = 1_000; });
    const passing = await sweep.screenshot({ path: testInfo.outputPath(`sweep-mid-${theme}.png`) });
    expect(resting.equals(passing)).toBe(false);
    await sweep.evaluate((element) => element.getAnimations()[0]!.play());
    await page.screenshot({ path: testInfo.outputPath(`working-${theme}.png`) });

    await summary.focus();
    await summary.press('Enter');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await summary.press('Space');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
  });
}

test('hands empty startup and thinking feedback to the visible level', async ({ page }) => {
  await openMockedApp(page);
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: 'New Thread' }).click();
  await showLiveWork(page, 'empty');
  const turn = page.locator('.thread-turn-inProgress');
  await expect(turn.locator('.working-text')).toHaveCount(1);
  await expect(turn.locator('.thread-speaker-meta .working-text')).toContainText('Working');
  await showLiveWork(page, 'thinking');
  await expect(turn.locator('.working-text')).toHaveText('Thinking');
  const summary = turn.locator('.thread-process-toggle');
  await summary.click();
  await expect(turn.locator('.working-text')).toHaveCount(1);
  await expect(summary.locator('.working-text')).toContainText('Working');
  await summary.click();
  await expect(turn.locator('.working-text')).toHaveText('Thinking');
  await expect(turn.locator('.working-text-base')).toHaveCSS('background-image', /110deg/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(turn.locator('.working-text-base')).toHaveCSS('animation-name', 'none');
  await expect(turn.locator('.thread-streaming-indicator')).toHaveCount(0);
});
