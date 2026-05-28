import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

// The renderer makes its chrome surfaces translucent only when the main process
// reports an active OS window material (macOS vibrancy / Windows mica), signalled
// by `data-window-material` on the document element. Content panels must stay
// opaque for readability, and the translucent regions must not stack. These
// assertions lock that contract without needing a real vibrancy-backed window.
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

  test('chrome turns translucent only with a material; panels stay opaque', async ({ page }) => {
    await openMockedApp(page);

    const read = () => page.evaluate(() => {
      const bg = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).backgroundColor;
      };
      return {
        topChrome: bg('.top-chrome'),
        appShell: bg('.app-shell'),
        sidebar: bg('.sidebar-dock'),
        panel: bg('.main-panel'),
      };
    });

    // No material reported (the default in the browser/dev preview): every chrome
    // surface is fully opaque, exactly as before this feature.
    const opaque = await read();
    expect(alphaOf(opaque.topChrome)).toBe(1);
    expect(alphaOf(opaque.appShell)).toBe(1);
    expect(alphaOf(opaque.sidebar)).toBe(1);
    expect(alphaOf(opaque.panel)).toBe(1);

    // Simulate the main process having applied vibrancy.
    await page.evaluate(() => {
      document.documentElement.dataset.windowMaterial = 'vibrancy';
    });

    const frosted = await read();
    // The two frost-bearing regions become translucent so the material shows.
    expect(alphaOf(frosted.topChrome)).toBeLessThan(1);
    expect(alphaOf(frosted.appShell)).toBeLessThan(1);
    // The sidebar dock goes fully transparent (it inherits the deck frost behind
    // it) rather than adding a second translucent layer on top.
    expect(alphaOf(frosted.sidebar)).toBe(0);
    // Content panels stay opaque for readability.
    expect(alphaOf(frosted.panel)).toBe(1);
  });
});
