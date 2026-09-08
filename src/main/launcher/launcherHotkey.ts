import { normalizePortableChord } from '../../core/keybindings';

export interface GlobalShortcutRegistrar {
  isRegistered(accelerator: string): boolean;
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface HotkeyRegistration {
  readonly accelerators: readonly string[];
  readonly attempted: readonly string[];
  readonly error: string | null;
}

/**
 * Startup has no previous effective binding to preserve. Register every free
 * alternate and report any unavailable candidates; one free alternate keeps the
 * launcher reachable while the status surface tells the truth about the rest.
 */
export function registerLauncherHotkeys(
  toggle: () => void,
  candidates: readonly string[],
  registrar: GlobalShortcutRegistrar,
): HotkeyRegistration {
  const registered: string[] = [];
  const failed: string[] = [];
  for (const accelerator of candidates) {
    if (registrar.isRegistered(accelerator) || !safeRegister(registrar, accelerator, toggle)) {
      failed.push(accelerator);
    } else {
      registered.push(accelerator);
    }
  }
  return {
    accelerators: Object.freeze(registered),
    attempted: Object.freeze([...candidates]),
    error: failed.length > 0 ? unavailableMessage(failed) : null,
  };
}

/**
 * Change the owned launcher chords transactionally. Additions are registered
 * before removals; if any addition fails, additions from this attempt are
 * rolled back and the previous effective set remains intact.
 */
export function replaceLauncherHotkeys(
  current: readonly string[],
  candidates: readonly string[],
  toggle: () => void,
  registrar: GlobalShortcutRegistrar,
  platform: NodeJS.Platform = process.platform,
): HotkeyRegistration {
  const identity = (accelerator: string) => normalizePortableChord(accelerator)
    .replace('CommandOrControl', platform === 'darwin' ? 'Command' : 'Control');
  const currentSet = new Set(current.map(identity));
  const candidateSet = new Set(candidates.map(identity));
  const additions: string[] = [];
  const failed: string[] = [];

  for (const accelerator of candidates) {
    if (currentSet.has(identity(accelerator))) continue;
    if (registrar.isRegistered(accelerator) || !safeRegister(registrar, accelerator, toggle)) {
      failed.push(accelerator);
      break;
    }
    additions.push(accelerator);
  }

  if (failed.length > 0) {
    for (const accelerator of additions) registrar.unregister(accelerator);
    return {
      accelerators: Object.freeze([...current]),
      attempted: Object.freeze([...candidates]),
      error: unavailableMessage(failed),
    };
  }

  for (const accelerator of current) {
    if (!candidateSet.has(identity(accelerator))) registrar.unregister(accelerator);
  }
  return {
    accelerators: Object.freeze([...candidates]),
    attempted: Object.freeze([...candidates]),
    error: null,
  };
}

export function unregisterLauncherHotkeys(
  accelerators: readonly string[],
  registrar: GlobalShortcutRegistrar,
): void {
  for (const accelerator of accelerators) registrar.unregister(accelerator);
}

function safeRegister(registrar: GlobalShortcutRegistrar, accelerator: string, toggle: () => void): boolean {
  try {
    return registrar.register(accelerator, toggle);
  } catch {
    return false;
  }
}

function unavailableMessage(accelerators: readonly string[]): string {
  return `Could not register shortcut${accelerators.length === 1 ? '' : 's'}: ${accelerators.join(', ')}`;
}
