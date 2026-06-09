import { BrowserWindow, screen } from 'electron';
import { LAUNCHER_SHOWN_CHANNEL } from '../../core/launcher/commands';
import { applyMacWindowCorner, setLauncherSpaceBehavior } from '../nativeWindowCorner';

// Prewarmed launcher window: created hidden at startup and shown/hidden on the
// global hotkey — never recreated, so the hotkey-to-visible path is just a
// native show() (see docs/plans/lazy-like-global-launcher.md). It loads the
// dedicated lightweight launcher renderer entry (launcher.html), not the editor
// bundle. Security defaults (contextIsolation/sandbox/nodeIntegration) match the
// main window and must not regress (A3).

export interface LauncherWindowDeps {
  preloadPath: string;
  /** Full dev URL for launcher.html, or null when packaged (loadFile instead). */
  devUrl: string | null;
  /** Absolute path to the packaged launcher.html. */
  packagedHtmlPath: string;
  harden: (contents: Electron.WebContents) => void;
  /**
   * Called when the window hides because it lost focus (clicked away). The owner
   * uses this to dismiss + forget the captured context through the SAME path as an
   * explicit hide, so blur-dismiss can't leave stale page metadata behind. When
   * omitted, the window just hides itself.
   */
  onBlurHide?: () => void;
}

const LAUNCHER_WIDTH = 760;
// A fixed golden rectangle (landscape): height = width / φ — the most comfortable
// proportion. A stable size reads as more intentional than a window that resizes
// to its result count (Raycast keeps a consistent height); the body scrolls once
// the list exceeds the window.
const GOLDEN_RATIO = 1.618;
const LAUNCHER_HEIGHT = Math.round(LAUNCHER_WIDTH / GOLDEN_RATIO); // ≈ 470
// Top-anchored placement (Spotlight/Raycast): the panel's TOP sits this far down
// the work area and grows DOWNWARD, so it never jumps as the height changes.
const LAUNCHER_TOP_BIAS = 0.18;
// A floating command palette reads tighter than the full app window (24). This is
// the native NSWindow corner applied via the window_corner addon — keep it in
// sync with the CSS surface so content clips to the same curve. (No exported
// geometry constant: the launcher is the only surface at this radius.)
const LAUNCHER_CORNER_RADIUS = 16;
// Dev escape hatch: opening devtools blurs the window; set this to keep it open.
const blurHideDisabled = process.env.LIN_LAUNCHER_NO_BLUR_HIDE === '1';

let launcherWindow: BrowserWindow | null = null;

export function getLauncherWindow(): BrowserWindow | null {
  return launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : null;
}

export function createLauncherWindow(deps: LauncherWindowDeps): BrowserWindow {
  if (getLauncherWindow()) return launcherWindow!;

  const win = new BrowserWindow({
    title: 'Tenon Launcher',
    width: LAUNCHER_WIDTH,
    height: LAUNCHER_HEIGHT,
    show: false,
    frame: false,
    // macOS NSPanel: a non-activating floating overlay (Spotlight/Raycast model).
    // It can become key for typing WITHOUT activating the app — so showing it
    // doesn't disrupt the app the user was in, and it stays put (inert) while a
    // system overlay like the screenshot tool is up, instead of behaving like a
    // normal app window that grabs activation.
    type: 'panel',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Liquid-glass system overlay (the Spotlight/Raycast idiom): a transparent
    // window over an OS vibrancy material. The global launcher floats above other
    // apps/the desktop, so — unlike the in-app opaque command palette — glass IS
    // the native look (design-system.md → Materials, "System launcher"). The
    // renderer keeps the surface transparent; functional fills tint the glass.
    // `hud` (HUDWindow) adapts light/dark; the a11y layer drops to an opaque
    // fallback under Reduce Transparency.
    backgroundColor: '#00000000',
    vibrancy: 'hud',
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the hidden renderer scheduled so the first show paints immediately.
      backgroundThrottling: false,
    },
  });
  launcherWindow = win;

  deps.harden(win.webContents);
  // Float above normal windows, including other apps' full-screen spaces.
  win.setAlwaysOnTop(true, 'pop-up-menu');
  // NOTE: the all-Spaces / over-fullscreen float is set NATIVELY (collectionBehavior
  // canJoinAllSpaces | fullScreenAuxiliary, see setLauncherSpaceBehavior), not via
  // Electron's setVisibleOnAllWorkspaces({visibleOnFullScreen:true}) — that Electron
  // path hides the macOS dock icon (electron#26350) and never restores it. The
  // behavior is also deliberately NOT set here at creation: a window that
  // permanently joins all Spaces makes macOS swallow the first ⌘Q (AppKit skips
  // applicationShouldTerminate: / our before-quit flush). Since this prewarmed
  // window lives hidden almost all the time, we toggle the behavior on show and
  // clear it on hide instead (see show/hide).
  // Custom native corner (matches the CSS surface curve). No-op off macOS / if the
  // addon is unbuilt — the window just keeps the OS-default corner.
  applyMacWindowCorner(win, LAUNCHER_CORNER_RADIUS);

  win.on('blur', () => {
    if (blurHideDisabled) return;
    // Route through the owner so the captured context is forgotten too; fall back
    // to a plain hide if no handler was supplied.
    if (deps.onBlurHide) deps.onBlurHide();
    else hideLauncherWindow();
  });
  win.on('closed', () => {
    launcherWindow = null;
  });

  if (deps.devUrl) void win.loadURL(deps.devUrl);
  else void win.loadFile(deps.packagedHtmlPath);

  return win;
}

/**
 * Re-centre on the display under the cursor and reveal the launcher.
 *
 * The window is first shown *inactive* so the previously-frontmost app keeps
 * focus; the optional `beforeFocus` hook runs in that window (used to read the
 * frontmost app for context capture — once we steal focus, the frontmost app is
 * us). We then activate + focus and tell the renderer it is shown. `beforeFocus`
 * is awaited but never allowed to fail the show.
 */
export async function showLauncherWindow(beforeFocus?: () => Promise<void> | void): Promise<void> {
  const win = getLauncherWindow();
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const originX = Math.round(workArea.x + (workArea.width - LAUNCHER_WIDTH) / 2);
  const originY = Math.round(workArea.y + workArea.height * LAUNCHER_TOP_BIAS);
  win.setBounds({ x: originX, y: originY, width: LAUNCHER_WIDTH, height: LAUNCHER_HEIGHT });
  // Re-assert the native corner: setBounds / re-show can drop the custom radius.
  applyMacWindowCorner(win, LAUNCHER_CORNER_RADIUS);
  // Join all Spaces (incl. other apps' full-screen) only while visible, natively so
  // the dock icon survives (electron#26350). Clearing this on hide keeps the common
  // ⌘Q path (launcher hidden) free of the AppKit first-quit-swallow bug — see the
  // note in createLauncherWindow + hide below.
  setLauncherSpaceBehavior(win, true);
  // Visible immediately, but do NOT steal focus yet — keep the old app frontmost
  // so beforeFocus can read it.
  win.showInactive();
  if (beforeFocus) {
    try {
      await beforeFocus();
    } catch {
      // Context capture is best-effort; never block the launcher on it.
    }
  }
  if (win.isDestroyed() || !win.isVisible()) return;
  win.show();
  win.focus();
  // Tell the renderer to (re)focus its input on every open, not just first mount.
  win.webContents.send(LAUNCHER_SHOWN_CHANNEL);
}

export function hideLauncherWindow(): void {
  const win = getLauncherWindow();
  if (!win?.isVisible()) return;
  win.hide();
  // Drop the all-Spaces collection behavior while hidden so the prewarmed window
  // doesn't make macOS swallow the first ⌘Q (set again on the next show).
  setLauncherSpaceBehavior(win, false);
}

export async function toggleLauncherWindow(beforeFocus?: () => Promise<void> | void): Promise<void> {
  const win = getLauncherWindow();
  if (!win) return;
  if (win.isVisible()) hideLauncherWindow();
  else await showLauncherWindow(beforeFocus);
}

export function destroyLauncherWindow(): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.destroy();
  launcherWindow = null;
}
