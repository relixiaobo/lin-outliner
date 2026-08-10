import { join } from 'node:path';
import {
  isSafeDmgDownloadUrl,
  isSafeReleasePageUrl,
  stableVersion,
} from '../core/appUpdate';
import {
  PRIVATE_JSON_FILE_OPTIONS,
  readJsonOrDefault,
  writeJsonFile,
} from './jsonFileStore';

const APP_UPDATE_STATE_SCHEMA_VERSION = 1;
export const APP_UPDATE_MAX_RELEASE_NOTE_LENGTH = 50_000;

export interface StoredAppUpdateRelease {
  version: string;
  tag: string;
  publishedAt: string;
  releasePageUrl: string;
  downloadUrl: string | null;
  note: string | null;
}

export interface StoredAppUpdateState {
  schemaVersion: 1;
  automaticChecksEnabled: boolean;
  lastAttemptAt: number | null;
  lastSuccessfulCheckAt: number | null;
  release: StoredAppUpdateRelease | null;
}

export interface AppUpdateStoreOptions {
  onError?: (error: unknown, operation: 'load' | 'save') => void;
}

export class AppUpdateStore {
  readonly filePath: string;

  constructor(userDataDir: string, private readonly options: AppUpdateStoreOptions = {}) {
    this.filePath = join(userDataDir, 'app-update-state.json');
  }

  async load(defaultAutomaticChecksEnabled: boolean): Promise<StoredAppUpdateState> {
    const fallback = defaultState(defaultAutomaticChecksEnabled);
    try {
      return await readJsonOrDefault(this.filePath, fallback, parseStoredState);
    } catch (error) {
      this.options.onError?.(error, 'load');
      return fallback;
    }
  }

  async save(state: StoredAppUpdateState): Promise<void> {
    try {
      await writeJsonFile(this.filePath, state, PRIVATE_JSON_FILE_OPTIONS);
    } catch (error) {
      this.options.onError?.(error, 'save');
    }
  }
}

export function defaultState(automaticChecksEnabled: boolean): StoredAppUpdateState {
  return {
    schemaVersion: APP_UPDATE_STATE_SCHEMA_VERSION,
    automaticChecksEnabled,
    lastAttemptAt: null,
    lastSuccessfulCheckAt: null,
    release: null,
  };
}

export function parseStoredState(value: unknown): StoredAppUpdateState {
  if (!isRecord(value) || value.schemaVersion !== APP_UPDATE_STATE_SCHEMA_VERSION) {
    throw new Error('Unsupported app update state schema.');
  }
  if (typeof value.automaticChecksEnabled !== 'boolean') {
    throw new Error('Invalid automatic update-check preference.');
  }
  return {
    schemaVersion: APP_UPDATE_STATE_SCHEMA_VERSION,
    automaticChecksEnabled: value.automaticChecksEnabled,
    lastAttemptAt: parseTimestamp(value.lastAttemptAt, 'lastAttemptAt'),
    lastSuccessfulCheckAt: parseTimestamp(value.lastSuccessfulCheckAt, 'lastSuccessfulCheckAt'),
    release: value.release === null ? null : parseStoredRelease(value.release),
  };
}

function parseStoredRelease(value: unknown): StoredAppUpdateRelease {
  if (!isRecord(value)) throw new Error('Invalid cached app update release.');
  if (
    typeof value.version !== 'string'
    || typeof value.tag !== 'string'
    || typeof value.publishedAt !== 'string'
    || typeof value.releasePageUrl !== 'string'
  ) {
    throw new Error('Invalid cached app update release fields.');
  }
  const version = stableVersion(value.version);
  if (!version || version !== value.version || stableVersion(value.tag) !== version) {
    throw new Error('Invalid cached app update version.');
  }
  if (!isIsoDate(value.publishedAt) || !isSafeReleasePageUrl(value.releasePageUrl, value.tag)) {
    throw new Error('Invalid cached app update destination.');
  }
  const downloadUrl = value.downloadUrl;
  if (downloadUrl !== null && (typeof downloadUrl !== 'string' || !isSafeDmgDownloadUrl(downloadUrl, value.tag))) {
    throw new Error('Invalid cached app update download.');
  }
  const note = value.note;
  if (note !== null && (typeof note !== 'string' || note.length > APP_UPDATE_MAX_RELEASE_NOTE_LENGTH)) {
    throw new Error('Invalid cached app update release note.');
  }
  return {
    version,
    tag: value.tag,
    publishedAt: value.publishedAt,
    releasePageUrl: value.releasePageUrl,
    downloadUrl,
    note,
  };
}

function parseTimestamp(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name} timestamp.`);
  }
  return value;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
