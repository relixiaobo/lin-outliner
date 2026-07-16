import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPersistenceId, isPersistenceId } from '../core/persistenceIdentity';
import { PRIVATE_JSON_FILE_OPTIONS, updateJsonFile } from './jsonFileStore';

export const INSTALLATION_IDENTITY_FILE = 'installation.json';

interface InstallationIdentityFile {
  kind: 'tenon-installation';
  schemaVersion: 1;
  installationId: string;
}

export async function loadOrCreateInstallationId(userDataRoot: string): Promise<string> {
  const identityPath = path.join(userDataRoot, INSTALLATION_IDENTITY_FILE);
  try {
    return parseInstallationIdentity(JSON.parse(await readFile(identityPath, 'utf8'))).installationId;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const fallback: InstallationIdentityFile = {
    kind: 'tenon-installation',
    schemaVersion: 1,
    installationId: createPersistenceId(),
  };
  const identity = await updateJsonFile(
    identityPath,
    fallback,
    parseInstallationIdentity,
    (current) => current,
    { ...PRIVATE_JSON_FILE_OPTIONS, pretty: false, trailingNewline: false },
  );
  return identity.installationId;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function parseInstallationIdentity(value: unknown): InstallationIdentityFile {
  if (!value || typeof value !== 'object') throw new Error('Invalid Tenon installation identity');
  const candidate = value as Partial<InstallationIdentityFile>;
  if (
    candidate.kind !== 'tenon-installation'
    || candidate.schemaVersion !== 1
    || !isPersistenceId(candidate.installationId)
  ) {
    throw new Error('Invalid Tenon installation identity');
  }
  return candidate as InstallationIdentityFile;
}
