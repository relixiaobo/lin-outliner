import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ImportPack {
  version: 1;
  source: { kind: string; path: string; sourceId?: string };
  options: ImportOptions;
  stats: ImportStats;
  coverage: ImportCoverage;
  warnings: ImportWarning[];
  sections: ImportSection[];
}

export interface ImportOptions {
  fidelity: 'content' | 'clean' | 'full';
  dateGrouping: 'stage_headings' | 'none';
  tags: boolean;
  fields: 'omit' | 'text_children' | 'field_rows';
  doneState: boolean;
}

export interface ImportStats {
  sourceRecords: number;
  sections: number;
  nodes: number;
  descriptions: number;
  tags: number;
  fields: number;
  checked: number;
  dropped: number;
}

export interface ImportCoverage {
  imported: number;
  merged: number;
  dropped: number;
  unsupported: number;
  empty: number;
  unaccounted: number;
  entriesFile?: string;
}

export interface ImportWarning {
  code: string;
  message: string;
  sourceId?: string;
  count?: number;
}

export interface ImportSection {
  id: string;
  title: string;
  kind: 'library' | 'date' | 'other';
  date?: string;
  nodes: ImportNode[];
}

export interface ImportNode {
  title: string;
  description?: string;
  tags?: string[];
  checked?: boolean;
  code?: { language?: string; text: string };
  fields?: { name: string; values: string[] }[];
  children?: ImportNode[];
  sourceId?: string;
}

export interface CoverageEntry {
  sourceId: string;
  status: 'imported' | 'merged' | 'dropped' | 'unsupported' | 'empty';
  reason?: string;
  target?: string;
}

export interface SourceProfile {
  ok: boolean;
  source: string;
  kind: 'tana' | 'roam-edn' | 'directory' | 'unknown';
  bytes?: number;
  confidence: number;
  stats: Record<string, unknown>;
  warnings: string[];
  samples?: unknown[];
}

export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

export async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readText(filePath));
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function htmlToText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return decodeHtml(value
    .replace(/<span\b[^>]*data-inlineref-date="([^"]+)"[^>]*><\/span>/giu, (_match, encoded) => {
      const decoded = decodeHtml(encoded);
      const date = decoded.match(/"dateTimeString"\s*:\s*"([^"]+)"/u)?.[1];
      return date ? `[date: ${date}]` : '[date reference]';
    })
    .replace(/<span\b[^>]*data-inlineref-node="([^"]+)"[^>]*><\/span>/giu, (_match, id) => `[node: ${id}]`)
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/giu, '\n')
    .replace(/<[^>]+>/gu, ''))
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&nbsp;/gu, ' ');
}

export function normalizeTagName(value: string): string {
  return value
    .replace(/^#+/u, '')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
}

export function extractInlineTags(title: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const next = title.replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, (match, prefix, rawTag) => {
    const tag = normalizeTagName(rawTag);
    if (tag) tags.push(tag);
    return prefix;
  }).replace(/\s{2,}/gu, ' ').trim();
  return { title: next || title.trim(), tags: [...new Set(tags)] };
}

export function createEmptyStats(): ImportStats {
  return {
    sourceRecords: 0,
    sections: 0,
    nodes: 0,
    descriptions: 0,
    tags: 0,
    fields: 0,
    checked: 0,
    dropped: 0,
  };
}

export function computeStats(pack: Pick<ImportPack, 'sections' | 'coverage'>): ImportStats {
  const stats = createEmptyStats();
  stats.sourceRecords = pack.coverage.imported + pack.coverage.merged + pack.coverage.dropped + pack.coverage.unsupported + pack.coverage.empty;
  stats.sections = pack.sections.length;
  stats.dropped = pack.coverage.dropped;
  for (const section of pack.sections) {
    for (const node of section.nodes) addNodeStats(stats, node);
  }
  return stats;
}

function addNodeStats(stats: ImportStats, node: ImportNode): void {
  stats.nodes += 1;
  if (node.description?.trim()) stats.descriptions += 1;
  stats.tags += node.tags?.length ?? 0;
  stats.fields += node.fields?.length ?? 0;
  if (node.checked === true) stats.checked += 1;
  for (const child of node.children ?? []) addNodeStats(stats, child);
}

export function coverageFromEntries(entries: readonly CoverageEntry[], entriesFile?: string): ImportCoverage {
  const coverage: ImportCoverage = {
    imported: 0,
    merged: 0,
    dropped: 0,
    unsupported: 0,
    empty: 0,
    unaccounted: 0,
    ...(entriesFile ? { entriesFile } : {}),
  };
  for (const entry of entries) coverage[entry.status] += 1;
  return coverage;
}

export function summarizeWarnings(entries: readonly CoverageEntry[]): ImportWarning[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.status !== 'dropped' && entry.status !== 'unsupported') continue;
    const reason = entry.reason ?? entry.status;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => ({
      code: reason,
      message: `${count} source record(s) were ${reason.replace(/_/gu, ' ')}.`,
      count,
    }));
}

export function validateImportPackShape(value: unknown): { ok: true; pack: ImportPack } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const pack = asRecord(value);
  if (pack.version !== 1) errors.push('version must be 1');
  if (!asRecord(pack.source).kind) errors.push('source.kind is required');
  if (!Array.isArray(pack.sections) || pack.sections.length === 0) errors.push('sections must be a non-empty array');
  const coverage = asRecord(pack.coverage);
  const sourceRecords = ['imported', 'merged', 'dropped', 'unsupported', 'empty', 'unaccounted']
    .reduce((sum, key) => sum + numberValue(coverage[key]), 0);
  if (numberValue(coverage.unaccounted) !== 0) errors.push('coverage.unaccounted must be 0');
  const stats = computeStats({
    sections: Array.isArray(pack.sections) ? pack.sections as ImportSection[] : [],
    coverage: coverage as unknown as ImportCoverage,
  });
  if (Array.isArray(pack.sections)) {
    for (const section of pack.sections as ImportSection[]) {
      for (const node of section.nodes ?? []) validateNodeShape(node, errors);
    }
  }
  const declared = asRecord(pack.stats);
  if (numberValue(declared.sourceRecords) !== sourceRecords) errors.push('stats.sourceRecords must match coverage total');
  for (const key of ['sections', 'nodes', 'descriptions', 'tags', 'fields', 'checked', 'dropped'] as const) {
    if (numberValue(declared[key]) !== stats[key]) errors.push(`stats.${key} must match computed ${key}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, pack: value as ImportPack };
}

function validateNodeShape(node: ImportNode, errors: string[]): void {
  for (const field of node.fields ?? []) {
    if (!field.name?.trim()) errors.push('field.name must be non-empty');
    if (!Array.isArray(field.values) || field.values.length === 0 || !field.values.every((value) => value.trim().length > 0)) {
      errors.push('field.values must be non-empty strings');
    }
  }
  for (const child of node.children ?? []) validateNodeShape(child, errors);
}

export function requiredArg(args: string[], index: number, usage: string): string {
  const value = args[index];
  if (!value) throw new Error(usage);
  return value;
}

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function optionFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
