import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ThreadResourceReference } from '../../../core/agent/protocol';
import type { JsonValue } from '../../../core/agent/protocol';
import {
  MAX_TOOL_ARTIFACT_BYTES,
  type ToolArtifactSink,
} from '../runtime/ToolArtifactSink';

export interface AgentShellOutputRoot {
  readonly id: string;
  readonly skillId: string;
  readonly path: string;
  readonly label: string;
}

export interface DeclaredOutputArtifactObservation {
  readonly ref: ThreadResourceReference;
  readonly readablePath: string | null;
  readonly label: string;
}

interface OutputEntrySnapshot {
  readonly path: string;
  readonly relativePath: string;
  readonly signature: string;
  readonly kind: 'file' | 'symlink' | 'other';
  readonly hidden: boolean;
  readonly size: number;
}

interface OutputRootScan {
  readonly entries: OutputEntrySnapshot[];
  readonly truncated: boolean;
}

export interface DeclaredOutputSnapshot {
  readonly entries: ReadonlyMap<string, string>;
  readonly unavailableRoots: ReadonlyMap<string, string>;
}

export interface CollectedDeclaredOutputArtifacts {
  readonly artifacts: readonly DeclaredOutputArtifactObservation[];
  readonly warnings: readonly string[];
}

export interface DeclaredOutputArtifactPlan {
  readonly roots: readonly AgentShellOutputRoot[];
  readonly snapshot: DeclaredOutputSnapshot;
}

const MAX_SKILL_OUTPUT_FILES = 16;
const MAX_SKILL_OUTPUT_ENTRIES = 512;

export function encodeDeclaredOutputArtifactPlan(
  roots: readonly AgentShellOutputRoot[],
  snapshot: DeclaredOutputSnapshot,
): JsonValue {
  return {
    version: 1,
    kind: 'declared-output-artifacts',
    roots: roots.map((root) => ({ ...root })),
    entries: [...snapshot.entries],
    unavailableRoots: [...snapshot.unavailableRoots],
  };
}

export function decodeDeclaredOutputArtifactPlan(value: unknown): DeclaredOutputArtifactPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.kind !== 'declared-output-artifacts'
    || !Array.isArray(record.roots) || !Array.isArray(record.entries)
    || !Array.isArray(record.unavailableRoots) || record.roots.length > 32
    || record.entries.length > MAX_SKILL_OUTPUT_ENTRIES * 32
    || record.unavailableRoots.length > 32) return null;
  const roots: AgentShellOutputRoot[] = [];
  for (const candidate of record.roots) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const root = candidate as Record<string, unknown>;
    if (Object.keys(root).some((key) => !['id', 'skillId', 'path', 'label'].includes(key))
      || !boundedString(root.id, 512) || !boundedString(root.skillId, 512)
      || !boundedString(root.path, 32_768) || !boundedString(root.label, 1_000)) return null;
    roots.push({ id: root.id, skillId: root.skillId, path: root.path, label: root.label });
  }
  const entries = decodeStringPairs(record.entries, MAX_SKILL_OUTPUT_ENTRIES * 32);
  const unavailableRoots = decodeStringPairs(record.unavailableRoots, 32);
  if (!entries || !unavailableRoots) return null;
  return {
    roots,
    snapshot: {
      entries: new Map(entries),
      unavailableRoots: new Map(unavailableRoots),
    },
  };
}

function decodeStringPairs(value: readonly unknown[], limit: number): Array<[string, string]> | null {
  if (value.length > limit) return null;
  const result: Array<[string, string]> = [];
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length !== 2
      || !boundedString(candidate[0], 32_768) || !boundedString(candidate[1], 32_768)) return null;
    result.push([candidate[0], candidate[1]]);
  }
  return result;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export async function snapshotDeclaredOutputRoots(
  roots: readonly AgentShellOutputRoot[],
): Promise<DeclaredOutputSnapshot> {
  const entries = new Map<string, string>();
  const unavailableRoots = new Map<string, string>();
  for (const root of roots) {
    try {
      const scanned = await scanOutputRoot(root);
      if (scanned.truncated) {
        unavailableRoots.set(
          outputRootKey(root),
          `${root.label} baseline stopped after ${MAX_SKILL_OUTPUT_ENTRIES} filesystem entries; artifact collection was skipped.`,
        );
        continue;
      }
      for (const entry of scanned.entries) entries.set(entry.path, entry.signature);
    } catch (error) {
      unavailableRoots.set(
        outputRootKey(root),
        `${root.label} baseline could not be scanned; artifact collection was skipped: ${errorMessage(error)}`,
      );
    }
  }
  return { entries, unavailableRoots };
}

export async function collectDeclaredOutputArtifacts(
  roots: readonly AgentShellOutputRoot[],
  before: DeclaredOutputSnapshot,
  artifactSink: ToolArtifactSink | undefined,
  options: { readonly maxTotalBytes?: number } = {},
): Promise<CollectedDeclaredOutputArtifacts> {
  const artifacts: DeclaredOutputArtifactObservation[] = [];
  const warnings: string[] = [];
  let admittedBytes = 0;
  for (const root of roots) {
    const unavailable = before.unavailableRoots.get(outputRootKey(root));
    if (unavailable) {
      warnings.push(unavailable);
      continue;
    }
    let scan: OutputRootScan;
    try {
      scan = await scanOutputRoot(root);
    } catch (error) {
      warnings.push(`${root.label} could not be scanned: ${errorMessage(error)}`);
      continue;
    }
    if (scan.truncated) {
      warnings.push(`${root.label} scan stopped after ${MAX_SKILL_OUTPUT_ENTRIES} filesystem entries.`);
    }
    const changed = scan.entries.filter((entry) => before.entries.get(entry.path) !== entry.signature);
    for (const entry of changed) {
      if (entry.hidden) {
        warnings.push(`${root.label}/${entry.relativePath} was skipped because hidden control files are not admitted.`);
        continue;
      }
      if (entry.kind !== 'file') {
        warnings.push(`${root.label}/${entry.relativePath} was skipped because it is not a regular file.`);
        continue;
      }
      if (entry.size > MAX_TOOL_ARTIFACT_BYTES) {
        warnings.push(`${root.label}/${entry.relativePath} exceeds the artifact byte limit.`);
        continue;
      }
      if (entry.size > (options.maxTotalBytes ?? Number.POSITIVE_INFINITY) - admittedBytes) {
        warnings.push(`${root.label}/${entry.relativePath} exceeds the remaining task detail budget.`);
        continue;
      }
      if (artifacts.length >= MAX_SKILL_OUTPUT_FILES) {
        warnings.push(`Additional files under ${root.label} were skipped after ${MAX_SKILL_OUTPUT_FILES} artifacts.`);
        break;
      }
      try {
        if (!artifactSink) throw new Error('Tool artifact storage is unavailable.');
        const canonicalPath = await realpath(entry.path);
        if (canonicalPath !== entry.path || !isPathWithin(root.path, canonicalPath)) {
          throw new Error('output path is not a physical file under its declared root');
        }
        const persisted = await artifactSink.persistFile({
          path: canonicalPath,
          mimeType: outputFileMimeType(entry.path),
          fileName: path.basename(entry.path),
        });
        artifacts.push({
          ref: persisted.ref,
          readablePath: persisted.readablePath,
          label: `${root.label}/${entry.relativePath}`,
        });
        admittedBytes += persisted.ref.byteLength;
        if (!persisted.readablePath) {
          warnings.push(`${root.label}/${entry.relativePath} is stored but has no current readable path.`);
        }
      } catch (error) {
        warnings.push(`${root.label}/${entry.relativePath} was not admitted: ${errorMessage(error)}`);
      }
    }
  }
  return {
    artifacts,
    warnings: [...new Set(warnings)].slice(0, MAX_SKILL_OUTPUT_FILES * 2),
  };
}

async function scanOutputRoot(root: AgentShellOutputRoot): Promise<OutputRootScan> {
  const [rootEntry, canonicalRoot] = await Promise.all([lstat(root.path), realpath(root.path)]);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || canonicalRoot !== root.path) {
    throw new Error('declared output root is no longer a canonical physical directory');
  }
  const entries: OutputEntrySnapshot[] = [];
  let observed = 0;
  let truncated = false;
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (truncated) return;
      observed += 1;
      if (observed > MAX_SKILL_OUTPUT_ENTRIES) {
        truncated = true;
        return;
      }
      const entryPath = path.join(directory, child.name);
      const relativePath = path.relative(root.path, entryPath);
      const entry = await lstat(entryPath);
      const hidden = relativePath.split(path.sep).some((segment) => segment.startsWith('.'));
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(entryPath);
        continue;
      }
      const kind = entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'other';
      entries.push({
        path: entryPath,
        relativePath,
        signature: [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs, kind].join(':'),
        kind,
        hidden,
        size: entry.size,
      });
    }
  };
  await walk(root.path);
  return { entries, truncated };
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function outputRootKey(root: AgentShellOutputRoot): string {
  return `${root.skillId}\0${root.id}\0${root.path}`;
}

function outputFileMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.json': return 'application/json';
    case '.html': return 'text/html';
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
