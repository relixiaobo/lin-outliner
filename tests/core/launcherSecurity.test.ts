import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A3 (security defaults are non-negotiable; never regress) guard for the launcher
// window. The launcher is a separate BrowserWindow on the same process seam as the
// main window; this scans its source so a future edit can't silently weaken the
// hardening. It's a source guard (the window needs Electron to construct), mirroring
// the repo's CSS/token guards that pin the real shape rather than a past one.

const SRC = readFileSync(
  join(import.meta.dir, '../../src/main/launcher/launcherWindow.ts'),
  'utf8',
);

describe('launcher window security posture (A3)', () => {
  test('webPreferences keep the non-negotiable defaults', () => {
    expect(SRC).toContain('contextIsolation: true');
    expect(SRC).toContain('sandbox: true');
    expect(SRC).toContain('nodeIntegration: false');
  });

  test('the webContents is hardened (popup deny + navigation fence)', () => {
    // deps.harden(win.webContents) wires setWindowOpenHandler deny + will-navigate fence.
    expect(SRC).toMatch(/deps\.harden\(\s*win\.webContents\s*\)/);
  });

  test('no insecure-default regressions appear anywhere in the source', () => {
    expect(SRC).not.toContain('contextIsolation: false');
    expect(SRC).not.toContain('sandbox: false');
    expect(SRC).not.toContain('nodeIntegration: true');
    expect(SRC).not.toContain('webSecurity: false');
    // The launcher must not gain its own nodeIntegrationInWorker / preload bypass.
    expect(SRC).not.toContain('nodeIntegrationInWorker: true');
  });
});
