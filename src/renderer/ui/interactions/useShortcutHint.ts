import { useSyncExternalStore } from 'react';
import type { ConfigurableShortcutId } from '../../../core/keybindings';
import { formatConfigurableShortcutHint, subscribeShortcutRegistry } from './shortcutRegistry';

export function useShortcutHint(shortcutId: ConfigurableShortcutId): string | null {
  return useSyncExternalStore(
    subscribeShortcutRegistry,
    () => formatConfigurableShortcutHint(shortcutId),
    () => formatConfigurableShortcutHint(shortcutId),
  );
}
