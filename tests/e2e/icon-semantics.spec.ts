import { expect, test } from '@playwright/test';
import { installElectronMock } from './outlinerMock';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`semantic glyphs render with token sizes and coherent paint in ${colorScheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await installElectronMock(page);
    await page.goto('/');
    await page.locator('.app-icon').first().waitFor();
    const result = await page.evaluate(async () => {
      const iconsPath = '/src/renderer/ui/icons.ts';
      const reactPath = '/node_modules/.vite/deps/react.js';
      const clientPath = '/node_modules/.vite/deps/react-dom_client.js';
      const [react, client, icons] = await Promise.all([
        import(reactPath), import(clientPath), import(iconsPath),
      ]);
      const { createElement } = react.default ?? react;
      const { createRoot } = client.default ?? client;
      const host = document.createElement('section');
      host.id = 'icon-verification';
      host.style.cssText = 'position:absolute;inset:0;z-index:9999;overflow:auto;background:var(--bg-content);color:var(--text-primary);padding:24px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;align-content:start';
      document.body.append(host);
      const glyphs = Object.entries(icons).filter(([name]) => name.endsWith('Icon'));
      const roles = Object.keys(icons.ICON_SIZE);
      const fileKinds = ['archive', 'audio', 'code', 'database', 'folder', 'image', 'presentation', 'spreadsheet', 'text', 'video'];
      const cells = [
        ...glyphs.map(([name, Icon]) => createElement('div', { key: name, style: { display: 'grid', gap: 8, padding: 8, fontSize: 11, minHeight: 64 } },
          createElement(Icon, { size: 'toolbar' }), name)),
        ...roles.map(size => createElement('div', { key: size, 'data-size-role': size }, createElement(icons.SearchIcon, { size }))),
        ...fileKinds.map(kind => createElement('div', { key: `file-${kind}`, style: { fontSize: 16 } },
          createElement('span', { className: 'inline-ref-file-icon', 'data-file-icon-kind': kind }), kind)),
      ];
      createRoot(host).render(cells);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return {
        glyphCount: glyphs.length,
        glyphs: [...host.querySelectorAll('svg')].slice(0, glyphs.length).map(svg => ({
          name: svg.getAttribute('data-icon'),
          width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height,
          hidden: svg.getAttribute('aria-hidden'), focusable: svg.getAttribute('focusable'),
          geometry: svg.querySelectorAll('path,rect,circle,line,polyline,polygon,ellipse').length,
        })),
        roles: [...host.querySelectorAll('[data-size-role]')].map(cell => ({
          role: cell.getAttribute('data-size-role'), width: cell.querySelector('svg')!.getBoundingClientRect().width,
        })),
      };
    });
    expect(result.glyphCount).toBeGreaterThan(100);
    for (const glyph of result.glyphs) {
      expect(glyph.width, glyph.name ?? '').toBe(16);
      expect(glyph.height, glyph.name ?? '').toBe(16);
      expect(glyph.geometry, glyph.name ?? '').toBeGreaterThan(0);
      expect(glyph.hidden).toBe('true');
      expect(glyph.focusable).toBe('false');
    }
    expect(Object.fromEntries(result.roles.map(({ role, width }) => [role, width]))).toEqual({
      tiny: 10, tag: 11, rowGlyph: 12, compact: 13, menu: 14, rowChevron: 15,
      toolbar: 16, large: 18, panel: 20, badge: 22,
    });
    const paint = await page.locator('#icon-verification').evaluate(host => {
      const style = (name: string) => getComputedStyle(host.querySelector(`[data-icon="${name}"]`)!.querySelector('path,rect')!);
      return {
        stop: style('Stop').fill,
        checkbox: style('Checkbox').fill,
        loader: getComputedStyle(host.querySelector('[data-icon="Loader"]')!).animationName,
        toolbar: getComputedStyle(host.querySelector('[data-icon="HideToolbar"]')!).transform,
        rightPanel: getComputedStyle(host.querySelector('[data-icon="CollapseAgentPanel"]')!).transform,
      };
    });
    expect(paint.stop).not.toBe('none');
    expect(paint.checkbox).toBe('none');
    expect(paint.loader).toBe('app-icon-spin');
    expect(paint.toolbar).toBe('matrix(0, 1, -1, 0, 0, 0)');
    expect(paint.rightPanel).toBe('matrix(-1, 0, 0, 1, 0, 0)');
    const masks = await page.locator('#icon-verification [data-file-icon-kind]').evaluateAll(async elements => Promise.all(elements.map(async element => {
      const mask = getComputedStyle(element).maskImage;
      const image = new Image();
      image.src = JSON.parse(mask.slice(4, -1));
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      let painted = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
      return { kind: element.getAttribute('data-file-icon-kind'), painted };
    })));
    for (const mask of masks) expect(mask.painted, mask.kind ?? '').toBeGreaterThan(20);
    await page.locator('#icon-verification').evaluate(host => { (host as HTMLElement).style.position = 'relative'; });
    await page.locator('#icon-verification').screenshot({ path: testInfo.outputPath(`icons-${colorScheme}.png`) });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('#icon-verification [data-icon="Loader"]')).toHaveCSS('animation-name', 'none');
  });
}

test('rail controls show the next action on the correct side', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/');
  for (const [selector, collapse, expand] of [
    ['.sidebar-toggle', 'CollapseSidebar', 'ExpandSidebar'],
    ['.agent-toggle', 'CollapseAgentPanel', 'ExpandAgentPanel'],
  ]) {
    const control = page.locator(selector);
    const initiallyOpen = await control.getAttribute('aria-expanded') === 'true';
    await expect(control.locator('svg')).toHaveAttribute('data-icon', initiallyOpen ? collapse : expand);
    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', String(!initiallyOpen));
    await expect(control.locator('svg')).toHaveAttribute('data-icon', initiallyOpen ? expand : collapse);
    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', String(initiallyOpen));
    await expect(control.locator('svg')).toHaveAttribute('data-icon', initiallyOpen ? collapse : expand);
  }
});
