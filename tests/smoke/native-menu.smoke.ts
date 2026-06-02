import { expect, test } from '@playwright/test';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

// Stage 4 native application menu (A2b): a real OS menu bar owns the app's
// commands and accelerators. We introspect the live application menu in the main
// process rather than asserting a DOM menu, because the whole point is that this
// is the native menu, not web chrome. The menu *shape* (App/Edit/View/Window/
// Help with Preferences in the app menu) is macOS-specific, and macOS is the
// only target of this stage, so the whole group skips off-darwin.
interface MenuNode {
  label: string;
  role: string | null;
  accelerator: string | null;
  enabled: boolean;
  submenu: MenuNode[];
}

test.describe('native application menu', () => {
  test.skip(process.platform !== 'darwin', 'native menu shape is macOS-specific');

  let smoke: SmokeApp;
  let tree: MenuNode[];

  test.beforeAll(async () => {
    smoke = await launchSmokeApp();
    tree = await smoke.app.evaluate(({ Menu }) => {
      const serialize = (items: Electron.MenuItem[]): MenuNode[] =>
        items.map((item) => ({
          label: item.label,
          role: item.role ?? null,
          accelerator: item.accelerator ?? null,
          enabled: item.enabled,
          submenu: item.submenu ? serialize(item.submenu.items) : [],
        }));
      const menu = Menu.getApplicationMenu();
      if (!menu) throw new Error('no application menu installed');
      return serialize(menu.items);
    });
  });

  test.afterAll(async () => {
    await closeSmokeApp(smoke);
  });

  test('the conventional macOS menu bar is installed', () => {
    // App, Edit, View, Window, Help.
    expect(tree.length).toBeGreaterThanOrEqual(5);
    const roles = tree.map((node) => node.role);
    // Role-based menus normalise to lowercase role strings.
    expect(roles).toContain('editmenu');
    expect(roles).toContain('windowmenu');
    expect(roles).toContain('help');
  });

  test('Preferences is bound to Cmd+,', () => {
    const flatten = (nodes: MenuNode[]): MenuNode[] =>
      nodes.flatMap((node) => [node, ...flatten(node.submenu)]);
    const prefs = flatten(tree).find((node) => /Preferences|Settings/i.test(node.label));
    expect(prefs, 'a Preferences/Settings menu item exists').toBeTruthy();
    expect(prefs?.accelerator).toBe('CmdOrCtrl+,');
    expect(prefs?.enabled).toBe(true);
  });

  test('Help offers Learn More', () => {
    const help = tree.find((node) => node.role === 'help' || /help/i.test(node.label));
    expect(help?.submenu.some((node) => /Learn More/i.test(node.label))).toBe(true);
  });
});
