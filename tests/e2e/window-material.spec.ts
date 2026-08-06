import { expect, test } from '@playwright/test';
import { emulateVisualMedia } from './emulatedMedia';
import { openMockedApp } from './outlinerMock';

// The renderer makes its floating rails translucent only when the main process
// reports an active OS window material (macOS vibrancy / Windows mica), signalled
// by `data-window-material` on the document element. With the floating-rails shell
// the frost lives on the rails themselves; the `.app-shell` wrapper is neutralised
// to opaque so the translucency never stacks, and content panels stay opaque for
// readability. These assertions lock that contract without a real vibrancy window.
test.describe('window material surfaces', () => {
  // getComputedStyle may report a colour as "rgb(r, g, b)", "rgba(r, g, b, a)",
  // or — when produced by color-mix — "color(srgb r g b / a)". Extract the alpha,
  // treating a missing one as fully opaque.
  const alphaOf = (color: string): number => {
    const slashAlpha = color.match(/\/\s*([0-9.]+)\s*\)$/);
    if (slashAlpha) return Number(slashAlpha[1]);
    const rgba = color.match(/^rgba?\(([^)]+)\)$/);
    if (!rgba) return 1;
    const parts = rgba[1].split(',').map((part) => part.trim());
    return parts.length >= 4 ? Number(parts[3]) : 1;
  };

  const read = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const styles = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
      const computed = getComputedStyle(element);
      return {
        background: computed.backgroundColor,
        backdropFilter: computed.backdropFilter,
      };
    };
    return {
      appShell: styles('.app-shell'),
      sidebar: styles('.sidebar-dock'),
      panel: styles('.main-panel'),
      reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
    };
  });

  const reportMaterial = (page: import('@playwright/test').Page) => page.evaluate(() => {
    document.documentElement.dataset.windowMaterial = 'vibrancy';
  });

  test('rails turn translucent only with a material when transparency is allowed', async ({ page }) => {
    await emulateVisualMedia(page, { colorScheme: 'light', reducedTransparency: 'no-preference' });
    await openMockedApp(page);

    // No material reported (the default in the browser/dev preview): every surface
    // is fully opaque, exactly as before this feature.
    const opaque = await read(page);
    expect(opaque.reducedTransparency).toBe(false);
    expect(alphaOf(opaque.appShell.background)).toBe(1);
    expect(alphaOf(opaque.sidebar.background)).toBe(1);
    expect(alphaOf(opaque.panel.background)).toBe(1);

    // Simulate the main process having applied vibrancy.
    await reportMaterial(page);

    const frosted = await read(page);
    // The floating rail carries the frost, so it becomes translucent.
    expect(alphaOf(frosted.sidebar.background)).toBeLessThan(1);
    expect(frosted.sidebar.backdropFilter).not.toBe('none');
    // The app-shell wrapper is neutralised to an opaque base so the rail's
    // translucency never stacks into a near-opaque double layer.
    expect(alphaOf(frosted.appShell.background)).toBe(1);
    // Content panels stay opaque for readability.
    expect(alphaOf(frosted.panel.background)).toBe(1);
  });

  test('rails use the opaque fallback when reduced transparency is requested', async ({ page }) => {
    await emulateVisualMedia(page, { colorScheme: 'light', reducedTransparency: 'reduce' });
    await openMockedApp(page);
    await reportMaterial(page);

    const reduced = await read(page);
    expect(reduced.reducedTransparency).toBe(true);
    expect(alphaOf(reduced.sidebar.background)).toBe(1);
    expect(reduced.sidebar.backdropFilter).toBe('none');
    expect(alphaOf(reduced.appShell.background)).toBe(1);
    expect(alphaOf(reduced.panel.background)).toBe(1);
  });
});
