#!/usr/bin/env bun
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { optionValue, readJson, readText, requiredArg, type SourceProfile, writeJson } from './import-pack-lib';

const USAGE = 'Usage: bun inspect-source.ts <file-or-directory> [--out <profile.json>]';

async function main() {
  const args = process.argv.slice(2);
  const source = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  const profile = await inspectSource(source);
  if (out) await writeJson(out, profile);
  console.log(JSON.stringify(profile, null, 2));
}

export async function inspectSource(source: string): Promise<SourceProfile> {
  const info = await stat(source);
  if (info.isDirectory()) return inspectDirectory(source);
  const ext = path.extname(source).toLowerCase();
  if (ext === '.json') return inspectJson(source, info.size);
  if (ext === '.edn') return inspectRoamEdn(source, info.size);
  return {
    ok: true,
    source: path.resolve(source),
    kind: 'unknown',
    bytes: info.size,
    confidence: 0.1,
    stats: { extension: ext || '(none)' },
    warnings: ['unsupported_file_type'],
  };
}

async function inspectDirectory(source: string): Promise<SourceProfile> {
  const entries = await readdir(source, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .slice(0, 500)
    .map(async (entry) => {
      const filePath = path.join(source, entry.name);
      const info = await stat(filePath);
      return { name: entry.name, bytes: info.size, extension: path.extname(entry.name).toLowerCase() };
    }));
  const extensionCounts = countBy(files.map((file) => file.extension || '(none)'));
  const roamBackups = files.filter((file) => file.extension === '.edn' && /^backup-/u.test(file.name));
  return {
    ok: true,
    source: path.resolve(source),
    kind: roamBackups.length ? 'roam-edn' : 'directory',
    confidence: roamBackups.length ? 0.75 : 0.4,
    stats: {
      files: files.length,
      extensionCounts,
      roamBackupFiles: roamBackups.length,
      largestFiles: [...files].sort((left, right) => right.bytes - left.bytes).slice(0, 10),
    },
    warnings: roamBackups.length ? ['directory_profile_only_choose_one_edn_for_import'] : [],
    samples: files.slice(0, 20),
  };
}

async function inspectJson(source: string, bytes: number): Promise<SourceProfile> {
  const data = await readJson(source);
  if (isTanaExport(data)) {
    const docs = data.docs as Array<{ id?: unknown; props?: Record<string, unknown> }>;
    const typeCounts = countBy(docs.map((doc) => typeof doc.props?._docType === 'string' ? doc.props._docType : '(none)'));
    const propCounts = new Map<string, number>();
    for (const doc of docs) {
      for (const key of Object.keys(doc.props ?? {})) propCounts.set(key, (propCounts.get(key) ?? 0) + 1);
    }
    return {
      ok: true,
      source: path.resolve(source),
      kind: 'tana',
      bytes,
      confidence: 0.95,
      stats: {
        docs: docs.length,
        currentWorkspaceId: data.currentWorkspaceId,
        formatVersion: data.formatVersion,
        typeCounts,
        topProps: Object.fromEntries([...propCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30)),
      },
      warnings: [],
      samples: docs.filter((doc) => doc.id && doc.props?.name).slice(0, 10).map((doc) => ({
        id: doc.id,
        name: doc.props?.name,
        type: doc.props?._docType,
      })),
    };
  }
  return {
    ok: true,
    source: path.resolve(source),
    kind: 'unknown',
    bytes,
    confidence: 0.3,
    stats: { topLevelKeys: data && typeof data === 'object' ? Object.keys(data as Record<string, unknown>) : [] },
    warnings: ['json_not_recognized_as_tana_export'],
  };
}

async function inspectRoamEdn(source: string, bytes: number): Promise<SourceProfile> {
  const text = await readText(source);
  const attrCounts = countBy([...text.matchAll(/:([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/gu)].map((match) => match[1] ?? 'unknown'));
  const pages = [...text.matchAll(/\[\d+\s+:node\/title\s+"((?:\\.|[^"\\])*)"/gu)].map((match) => unescapeEdnString(match[1] ?? ''));
  const blocks = [...text.matchAll(/\[\d+\s+:block\/string\s+"((?:\\.|[^"\\])*)"/gu)].map((match) => unescapeEdnString(match[1] ?? ''));
  return {
    ok: true,
    source: path.resolve(source),
    kind: 'roam-edn',
    bytes,
    confidence: pages.length || blocks.length ? 0.8 : 0.3,
    stats: {
      pages: pages.length,
      blocks: blocks.length,
      attrCounts,
    },
    warnings: ['roam_edn_profile_only_in_this_release'],
    samples: [
      ...pages.slice(0, 5).map((title) => ({ type: 'page', title })),
      ...blocks.slice(0, 5).map((text) => ({ type: 'block', text: text.slice(0, 240) })),
    ],
  };
}

function isTanaExport(value: unknown): value is { docs: unknown[]; currentWorkspaceId?: unknown; formatVersion?: unknown } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { docs?: unknown }).docs));
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function unescapeEdnString(value: string): string {
  return value.replace(/\\"/gu, '"').replace(/\\\\/gu, '\\').replace(/\\n/gu, '\n');
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
