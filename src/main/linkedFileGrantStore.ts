import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TrustedLocalFileReference } from './localFileReferenceSecurity';
import {
  PRIVATE_JSON_FILE_OPTIONS,
  readJsonOrDefault,
  updateJsonFile,
} from './jsonFileStore';

interface LinkedFileGrantRecord {
  sourceText: string;
  canonicalPath: string;
  authorizedAt: number;
}

interface LinkedFileGrantState {
  schemaVersion: 1;
  grants: LinkedFileGrantRecord[];
}

export type LinkedFileGrantResolution =
  | { status: 'ready'; file: TrustedLocalFileReference }
  | { status: 'denied' | 'unavailable' };

export type LinkedFileGrantAuthorization =
  | { authorized: true }
  | { authorized: false; reason: 'different-file' | 'invalid-source' | 'unavailable' };

const EMPTY_STATE: LinkedFileGrantState = { schemaVersion: 1, grants: [] };
const OPEN_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const MAX_GRANTS = 10_000;

export class LinkedFileGrantStore {
  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(sourceText: string): Promise<LinkedFileGrantResolution> {
    const locatorPath = linkedFilePath(sourceText);
    if (!locatorPath) return { status: 'denied' };
    let state: LinkedFileGrantState;
    try {
      state = await this.read();
    } catch {
      return { status: 'denied' };
    }
    const grant = state.grants.find((candidate) => candidate.sourceText === sourceText);
    if (!grant) return { status: 'denied' };

    const canonicalPath = await realpath(locatorPath).catch(() => null);
    if (!canonicalPath) return { status: 'unavailable' };
    if (canonicalPath !== grant.canonicalPath) return { status: 'denied' };

    const handle = await open(canonicalPath, OPEN_NOFOLLOW).catch(() => null);
    if (!handle) return { status: 'unavailable' };
    try {
      const [openedStats, freshStats, freshCanonicalPath] = await Promise.all([
        handle.stat(),
        stat(canonicalPath).catch(() => null),
        realpath(locatorPath).catch(() => null),
      ]);
      if (
        !openedStats.isFile()
        || !freshStats?.isFile()
        || freshCanonicalPath !== grant.canonicalPath
        || !sameFileIdentity(openedStats, freshStats)
      ) return { status: 'unavailable' };
      return {
        status: 'ready',
        file: { entryKind: 'file', path: canonicalPath, stats: openedStats },
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async authorize(sourceText: string, selectedPath: string): Promise<LinkedFileGrantAuthorization> {
    const locatorPath = linkedFilePath(sourceText);
    if (!locatorPath) return { authorized: false, reason: 'invalid-source' };
    const [locatorCanonicalPath, selectedCanonicalPath] = await Promise.all([
      realpath(locatorPath).catch(() => null),
      realpath(selectedPath).catch(() => null),
    ]);
    if (!locatorCanonicalPath || !selectedCanonicalPath) {
      return { authorized: false, reason: 'unavailable' };
    }
    if (locatorCanonicalPath !== selectedCanonicalPath) {
      return { authorized: false, reason: 'different-file' };
    }

    const handle = await open(selectedCanonicalPath, OPEN_NOFOLLOW).catch(() => null);
    if (!handle) return { authorized: false, reason: 'unavailable' };
    try {
      const [openedStats, freshStats, freshLocatorPath] = await Promise.all([
        handle.stat(),
        stat(selectedCanonicalPath).catch(() => null),
        realpath(locatorPath).catch(() => null),
      ]);
      if (
        !openedStats.isFile()
        || !freshStats?.isFile()
        || freshLocatorPath !== selectedCanonicalPath
        || !sameFileIdentity(openedStats, freshStats)
      ) return { authorized: false, reason: 'unavailable' };
    } finally {
      await handle.close().catch(() => undefined);
    }

    await updateJsonFile(
      this.filePath,
      EMPTY_STATE,
      parseLinkedFileGrantState,
      (state) => {
        const grants = state.grants.filter((grant) => grant.sourceText !== sourceText);
        grants.push({ sourceText, canonicalPath: selectedCanonicalPath, authorizedAt: this.now() });
        grants.sort((left, right) => left.sourceText.localeCompare(right.sourceText));
        if (grants.length > MAX_GRANTS) grants.splice(0, grants.length - MAX_GRANTS);
        return { schemaVersion: 1 as const, grants };
      },
      PRIVATE_JSON_FILE_OPTIONS,
    );
    return { authorized: true };
  }

  async revoke(sourceText: string): Promise<boolean> {
    let revoked = false;
    await updateJsonFile(
      this.filePath,
      EMPTY_STATE,
      parseLinkedFileGrantState,
      (current) => {
        const grants = current.grants.filter((grant) => grant.sourceText !== sourceText);
        revoked = grants.length !== current.grants.length;
        return { schemaVersion: 1 as const, grants };
      },
      PRIVATE_JSON_FILE_OPTIONS,
    );
    return revoked;
  }

  private read(): Promise<LinkedFileGrantState> {
    return readJsonOrDefault(this.filePath, EMPTY_STATE, parseLinkedFileGrantState);
  }
}

export function linkedFilePath(sourceText: string): string | null {
  let url: URL;
  try {
    url = new URL(sourceText);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'file:'
    || url.username
    || url.password
    || url.port
    || (url.hostname && url.hostname !== 'localhost')
  ) return null;
  try {
    const filePath = fileURLToPath(url);
    return filePath.includes('\0') ? null : filePath;
  } catch {
    return null;
  }
}

function parseLinkedFileGrantState(value: unknown): LinkedFileGrantState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.grants)) {
    throw new Error('Invalid linked-file grant store.');
  }
  if (value.grants.length > MAX_GRANTS) throw new Error('Linked-file grant store exceeds its limit.');
  const grants = value.grants.map((candidate) => {
    if (
      !isRecord(candidate)
      || typeof candidate.sourceText !== 'string'
      || !linkedFilePath(candidate.sourceText)
      || typeof candidate.canonicalPath !== 'string'
      || !candidate.canonicalPath
      || typeof candidate.authorizedAt !== 'number'
      || !Number.isFinite(candidate.authorizedAt)
      || candidate.authorizedAt < 0
    ) throw new Error('Invalid linked-file grant record.');
    return {
      sourceText: candidate.sourceText,
      canonicalPath: candidate.canonicalPath,
      authorizedAt: candidate.authorizedAt,
    };
  });
  if (new Set(grants.map((grant) => grant.sourceText)).size !== grants.length) {
    throw new Error('Duplicate linked-file grant locator.');
  }
  return { schemaVersion: 1, grants };
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
