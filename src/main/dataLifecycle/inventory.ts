import { lstat, readdir, readlink } from 'node:fs/promises';
import { DataStoreRegistry } from './storeRegistry';
import { assertOwnedPath, missing } from './durableFiles';

/** These are replaceable data roots, never Runtime descriptors or lifecycle control. */
export const MANAGED_DATA_ROOTS = [
  'outline-runtime/workspace', 'content', 'agent', 'config', 'thread-records', 'thread-transcripts',
  'managed-skills', 'managed-skill-content', 'installation.json', 'node-access-stats.json',
  'app-preferences.json', 'window-state.json', 'linked-file-grants.json', 'agent-model-state.json',
  'agent-secrets.json', 'agent-model-catalogs.json', 'agent-capabilities.json', 'agent-skill-provenance.json',
] as const;

export const DISPOSABLE_DATA_ROOTS = [
  'data-lifecycle', 'data-manifest.json', 'diagnostics', 'outline-asset-exports', 'preview-translation-cache',
  'app-update-state.json', 'browser-pilot',
] as const;

export interface ManagedRoot { readonly path: string; readonly kind: 'directory' | 'file' | 'missing' }
export interface ManagedFile { readonly path: string; readonly kind: 'sqlite' | 'file' | 'link'; readonly bytes: number }
export interface ManagedInventory { readonly roots: readonly ManagedRoot[]; readonly files: readonly ManagedFile[]; readonly excluded: readonly string[]; readonly estimatedBytes: number }
export const MAX_BACKUP_FILES = 200_000;

export async function inspectManagedFiles(root: string, registry: DataStoreRegistry, retainRaw = false): Promise<ManagedInventory> {
  const files: ManagedFile[] = [];
  const roots: ManagedRoot[] = [];
  const excluded: string[] = [];
  let estimatedBytes = 0;
  const visit = async (name: string): Promise<void> => {
    const path = await assertOwnedPath(root, name, isWorkingMaterialLink(name));
    const info = await lstat(path);
    if (info.isSocket() && name.endsWith('.sock')) { excluded.push(name); return; }
    if (info.isSymbolicLink()) {
      if (!isWorkingMaterialLink(name)) throw new Error('An authoritative data path is a symbolic link; retain its external source separately.');
      const bytes = Buffer.byteLength(await readlink(path));
      files.push({ path: name, kind: 'link', bytes }); estimatedBytes += bytes;
      if (files.length > MAX_BACKUP_FILES) throw new Error('Managed data inventory exceeds the supported file limit');
      return;
    }
    if (info.isDirectory()) {
      const entries = (await readdir(path)).sort();
      for (const entry of entries) await visit(`${name}/${entry}`);
      return;
    }
    if (!info.isFile()) throw new Error('Managed data includes an unsupported file type');
    estimatedBytes += info.size;
    const sidecar = name.match(/^(.*\.sqlite)(?:-wal|-shm|-journal)$/);
    if (!retainRaw && sidecar && registry.forPath(sidecar[1]!)) { excluded.push(name); return; }
    // User working material can itself contain databases. Only application-owned
    // database locations participate in the schema registry; preserve other bytes.
    const userMaterial = isWorkingMaterialLink(name) || name.startsWith('agent/scratch/') || name.startsWith('agent/tool-tasks/');
    const applicationDatabase = name.startsWith('content/') || name.startsWith('agent/') && !userMaterial;
    if (!retainRaw && name.endsWith('.sqlite') && applicationDatabase && !registry.forPath(name)) throw new Error(`Unregistered database owner: ${name}`);
    files.push({ path: name, kind: !retainRaw && registry.forPath(name) ? 'sqlite' : 'file', bytes: info.size });
    if (files.length > MAX_BACKUP_FILES) throw new Error('Managed data inventory exceeds the supported file limit');
  };
  for (const name of MANAGED_DATA_ROOTS) {
    const path = await assertOwnedPath(root, name);
    const info = await lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    roots.push({ path: name, kind: !info ? 'missing' : info.isDirectory() ? 'directory' : 'file' });
    if (info) await visit(name);
  }
  return { roots, files, excluded, estimatedBytes };
}

export function isManagedDataPath(path: string): boolean {
  return MANAGED_DATA_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

export function isWorkingMaterialLink(path: string): boolean {
  return ['agent/workspaces/', 'agent/delegation-worktrees/', 'agent/automation-worktrees/', 'agent/automation-worktree-snapshots/']
    .some((prefix) => path.startsWith(prefix));
}
