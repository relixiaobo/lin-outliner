import { join } from 'node:path';
import { writeJsonFileSync } from '../jsonFileStore';
import { DEFAULT_FILE_PREFERENCES, type FilePreferences, type FilePreferencesLoadResult } from './filePreferences';

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
}

export function writeFilePreferencesStatus(
  userDataDir: string,
  hostSessionId: string,
  loaded: FilePreferencesLoadResult,
  options: {
    readonly effective?: FilePreferences;
    readonly applicationStatus?: FilePreferencesStatus['application']['status'];
    readonly applicationError?: string | null;
  } = {},
): FilePreferencesStatus {
  const effective = options.effective ?? DEFAULT_FILE_PREFERENCES;
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
    effective: {
      appearance: effective.appearance,
      agent: {
        memoryEnabled: effective.agent.memory.enabled,
        disabledSkills: effective.agent.skills.disabled,
        disabledTools: effective.agent.tools.disabled,
      },
    },
  });
  writeJsonFileSync(join(userDataDir, FILE_PREFERENCES_STATUS_RELATIVE_PATH), status, {
    directoryMode: 0o700,
  });
  return status;
}
