import { expect, test } from '@playwright/test';
import { ids, openMockedApp, row } from './outlinerMock';

test.describe('cursor affordances', () => {
  test('core controls expose interaction-specific cursors', async ({ page }) => {
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
        trailingBullet: cursor(`[data-trailing-parent-id="${ids.today}"] .row-bullet-button`),
        composerSend: cursor('.agent-composer-action-button'),
        composerModel: cursor('.agent-composer-model-button'),
        agentTitle: cursor('.agent-dock-title-button'),
      };
    }, ids);

    expect(cursors.panelMore).toBe('pointer');
    expect(cursors.rowBullet).toBe('pointer');
    expect(cursors.trailingBullet).toBe('default');
    expect(cursors.composerSend).toBe('default');
    expect(cursors.composerModel).toBe('pointer');
    expect(cursors.agentTitle).toBe('pointer');
  });

  test('shared icon buttons and definition switches own pointer semantics', async ({ page }) => {
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

    expect(iconButtonCursors.enabled).toBe('pointer');
    expect(iconButtonCursors.disabled).toBe('default');

    await page.getByRole('button', { name: 'Supertags' }).click();
    await row(page, ids.projectTag).getByRole('button', { name: 'Open' }).click();

    const definitionSwitchCursor = await page.locator('.definition-switch').first().evaluate((element) =>
      getComputedStyle(element).cursor);

    expect(definitionSwitchCursor).toBe('pointer');
  });
});
