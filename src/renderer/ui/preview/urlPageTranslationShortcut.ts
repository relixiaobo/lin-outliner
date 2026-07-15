import { matchesShortcutEvent } from '../interactions/shortcutRegistry';

type ShortcutListener = (webContentsId: number | null) => boolean;

const listeners = new Set<ShortcutListener>();
let bridgeUnsubscribe: (() => void) | null = null;
let listeningWindow: Window | null = null;

function dispatchShortcut(webContentsId: number | null): boolean {
  let handled = false;
  for (const listener of listeners) handled = listener(webContentsId) || handled;
  return handled;
}

function handleHostKeyDown(event: KeyboardEvent): void {
  if (event.repeat || !matchesShortcutEvent(event, 'global.toggle_page_translation')) return;
  if (!dispatchShortcut(null)) return;
  event.preventDefault();
  event.stopPropagation();
}

function installGlobalListeners(): void {
  if (typeof window === 'undefined') return;
  if (!listeningWindow) {
    listeningWindow = window;
    listeningWindow.addEventListener('keydown', handleHostKeyDown, true);
  }
  if (!bridgeUnsubscribe) {
    bridgeUnsubscribe = window.lin?.onUrlPageTranslationShortcut?.((webContentsId) => {
      dispatchShortcut(webContentsId);
    }) ?? null;
  }
}

function removeGlobalListeners(): void {
  listeningWindow?.removeEventListener('keydown', handleHostKeyDown, true);
  listeningWindow = null;
  bridgeUnsubscribe?.();
  bridgeUnsubscribe = null;
}

export function subscribeUrlPageTranslationShortcut(listener: ShortcutListener): () => void {
  listeners.add(listener);
  installGlobalListeners();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) removeGlobalListeners();
  };
}
