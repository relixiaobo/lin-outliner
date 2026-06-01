import { expect, test } from '@playwright/test';
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

  test('rails turn translucent only with a material; wrappers and panels stay opaque', async ({ page }) => {
    await openMockedApp(page);

    const read = () => page.evaluate(() => {
      const bg = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).backgroundColor;
      };
      return {
        appShell: bg('.app-shell'),
        sidebar: bg('.sidebar-dock'),
        panel: bg('.main-panel'),
      };
    });

    // No material reported (the default in the browser/dev preview): every surface
    // is fully opaque, exactly as before this feature.
    const opaque = await read();
    expect(alphaOf(opaque.appShell)).toBe(1);
    expect(alphaOf(opaque.sidebar)).toBe(1);
    expect(alphaOf(opaque.panel)).toBe(1);

    // Simulate the main process having applied vibrancy.
    await page.evaluate(() => {
      document.documentElement.dataset.windowMaterial = 'vibrancy';
    });

    const frosted = await read();
    // The floating rail carries the frost, so it becomes translucent.
    expect(alphaOf(frosted.sidebar)).toBeLessThan(1);
    // The app-shell wrapper is neutralised to an opaque base so the rail's
    // translucency never stacks into a near-opaque double layer.
    expect(alphaOf(frosted.appShell)).toBe(1);
    // Content panels stay opaque for readability.
    expect(alphaOf(frosted.panel)).toBe(1);
  });
});
