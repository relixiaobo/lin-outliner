import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Persist the main window's size/position (and maximized state) across launches,
// so the app reopens where the user left it instead of always at the default
// geometry. Stored in userData, which is already per-clone isolated.

interface PersistedWindowState {
  bounds: Rectangle;
  maximized: boolean;
}

interface RestoredWindowState {
  bounds?: Rectangle;
  maximized: boolean;
}

const SAVE_DEBOUNCE_MS = 400;

function stateFilePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

export function loadWindowState(): RestoredWindowState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as PersistedWindowState;
    if (isVisibleOnSomeDisplay(parsed.bounds)) {
      return { bounds: parsed.bounds, maximized: Boolean(parsed.maximized) };
    }
  } catch {
    // No prior state, or it's unreadable/invalid — fall back to defaults.
  }
  return { maximized: false };
}

export function trackWindowState(window: BrowserWindow): void {
  const save = () => {
    if (window.isDestroyed()) return;
    const state: PersistedWindowState = {
      // getNormalBounds() is the un-maximized geometry, so a window closed while
      // maximized still restores to a sensible size when un-maximized later.
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    };
    try {
      writeFileSync(stateFilePath(), JSON.stringify(state));
    } catch {
      // Best effort — losing window geometry is not worth surfacing an error.
    }
  };
  const saveSoon = debounce(save, SAVE_DEBOUNCE_MS);
  window.on('resize', saveSoon);
  window.on('move', saveSoon);
  window.on('close', save);
}

// Guard against restoring onto a monitor that's no longer connected: the saved
// bounds must still overlap some display's work area, or the window could open
// fully off-screen.
function isVisibleOnSomeDisplay(bounds: Rectangle | undefined): bounds is Rectangle {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.width !== 'number') return false;
  return screen.getAllDisplays().some((display) => intersects(display.workArea, bounds));
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
