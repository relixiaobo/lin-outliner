import type { PreferencesApplicationState } from '../../core/settingsDefinitions';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { KeybindingsView } from '../../core/keybindings';
import { writeJsonFileSync } from '../jsonFileStore';
import {
  DEFAULT_FILE_PREFERENCES,
  loadFilePreferences,
  type FilePreferences,
  type FilePreferencesLoadResult,
} from './filePreferences';

export const FILE_PREFERENCES_STATUS_RELATIVE_PATH = join('config', 'status.json');

export interface FilePreferencesStatus {
  readonly schemaVersion: 1;
  readonly hostSessionId: string;
  readonly observedAt: string;
  readonly source: {
    readonly path: string;
    readonly status: FilePreferencesLoadResult['sourceStatus'];
    readonly observedDigest: string | null;
    readonly acceptedDigest: string | null;
    readonly error: string | null;
    readonly recoveryError: string | null;
  };
  readonly application: {
    readonly status: 'pending' | 'applied' | 'failed';
    readonly error: string | null;
  };
  readonly effective: {
    readonly appearance: FilePreferencesLoadResult['preferences']['appearance'];
    readonly agent: {
      readonly memoryEnabled: boolean;
      readonly disabledSkills: readonly string[];
      readonly disabledTools: readonly string[];
    };
  };
  readonly preferences: FilePreferences;
  readonly domains: PreferencesApplicationState;
  readonly keybindings?: KeybindingsView;
}

const liveStatuses = new Map<string, FilePreferencesStatus>();

/** Generated disk output is not the authority for the running Settings window. */
export function currentFilePreferencesStatus(userDataDir: string, hostSessionId: string): FilePreferencesStatus | null {
  const status = liveStatuses.get(userDataDir);
  return status?.hostSessionId === hostSessionId ? status : null;
}

export function writeFilePreferencesStatus(
  userDataDir: string,
  hostSessionId: string,
  loaded: FilePreferencesLoadResult,
  options: {
    readonly effective?: FilePreferences;
    readonly applicationStatus?: FilePreferencesStatus['application']['status'];
    readonly applicationError?: string | null;
    readonly domains?: PreferencesApplicationState;
  } = {},
): FilePreferencesStatus {
  const effective = options.effective ?? DEFAULT_FILE_PREFERENCES;
  const previous = readStatus(userDataDir);
  const status: FilePreferencesStatus = Object.freeze({
    schemaVersion: 1,
    hostSessionId,
    observedAt: new Date().toISOString(),
    source: {
      path: loaded.path,
      status: loaded.sourceStatus,
      observedDigest: loaded.sourceDigest,
      acceptedDigest: loaded.acceptedDigest,
      error: loaded.error,
      recoveryError: loaded.recoveryError,
    },
    application: {
      status: options.applicationStatus ?? (loaded.sourceStatus === 'rejected' ? 'failed' : 'pending'),
      error: options.applicationError ?? (loaded.sourceStatus === 'rejected' ? loaded.error : null),
    },
    preferences: effective,
    domains: options.domains ?? {},
    effective: {
      appearance: effective.appearance,
      agent: {
        memoryEnabled: effective.agent.memory.enabled,
        disabledSkills: effective.agent.skills.disabled,
        disabledTools: effective.agent.tools.disabled,
      },
    },
    ...(previous?.hostSessionId === hostSessionId && previous.keybindings
      ? { keybindings: previous.keybindings as KeybindingsView }
      : {}),
  });
  liveStatuses.set(userDataDir, status);
  writeJsonFileSync(join(userDataDir, FILE_PREFERENCES_STATUS_RELATIVE_PATH), status, {
    directoryMode: 0o700,
  });
  return status;
}

export function writeKeybindingsStatus(
  userDataDir: string,
  hostSessionId: string,
  view: KeybindingsView,
): void {
  const previous = readStatus(userDataDir);
  const base = previous?.hostSessionId === hostSessionId
    ? previous
    : writeFilePreferencesStatus(userDataDir, hostSessionId, loadFilePreferences(userDataDir));
  writeJsonFileSync(join(userDataDir, FILE_PREFERENCES_STATUS_RELATIVE_PATH), {
    ...base,
    hostSessionId,
    observedAt: new Date().toISOString(),
    keybindings: view,
  }, { directoryMode: 0o700 });
}

function readStatus(userDataDir: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(join(userDataDir, FILE_PREFERENCES_STATUS_RELATIVE_PATH), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
