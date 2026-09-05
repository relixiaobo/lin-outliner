import { join } from 'node:path';
import { writeJsonFileSync } from '../jsonFileStore';
import type { FilePreferencesLoadResult } from './filePreferences';

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
  };
  readonly effective: {
    readonly appearance: FilePreferencesLoadResult['preferences']['appearance'];
    readonly agent: {
      readonly memoryEnabled: boolean;
      readonly disabledSkills: readonly string[];
      readonly disabledTools: readonly string[];
    };
  };
}

const acceptedDigests = new Map<string, string | null>();

export function writeFilePreferencesStatus(
  userDataDir: string,
  hostSessionId: string,
  loaded: FilePreferencesLoadResult,
): FilePreferencesStatus {
  if (loaded.sourceStatus === 'accepted') acceptedDigests.set(userDataDir, loaded.sourceDigest);
  const acceptedDigest = acceptedDigests.get(userDataDir) ?? null;
  const status: FilePreferencesStatus = Object.freeze({
    schemaVersion: 1,
    hostSessionId,
    observedAt: new Date().toISOString(),
    source: {
      path: loaded.path,
      status: loaded.sourceStatus,
      observedDigest: loaded.sourceDigest,
      acceptedDigest,
      error: loaded.error,
    },
    effective: {
      appearance: loaded.preferences.appearance,
      agent: {
        memoryEnabled: loaded.preferences.agent.memory.enabled,
        disabledSkills: loaded.preferences.agent.skills.disabled,
        disabledTools: loaded.preferences.agent.tools.disabled,
      },
    },
  });
  writeJsonFileSync(join(userDataDir, FILE_PREFERENCES_STATUS_RELATIVE_PATH), status, {
    directoryMode: 0o700,
  });
  return status;
}
