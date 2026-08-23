import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface NormalizedImport {
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
  dateGrouping: 'stage_headings' | 'native_daily' | 'none';
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

export interface GenericChangeSet {
  protocolVersion: 1;
  kind: 'outline.changeset';
  source: {
    kind: 'import';
    label: string;
    uri: string;
    fingerprint: string;
  };
  operations: Array<Record<string, unknown>>;
  return?: Array<Record<string, unknown>>;
}

export interface ImportVerification {
  binding: string;
  kind: 'created-tree' | 'date';
  expectedNodeCount: number;
  date?: string;
  truncated?: true;
}

export interface ImportEvidence {
  version: 1;
  source: NormalizedImport['source'];
  sourceFingerprint: string;
  changeSetFingerprint: string;
  coverage: ImportCoverage;
  warnings: ImportWarning[];
  stats: ImportStats;
  mode: 'native_daily' | 'stage';
  dates: string[];
  expectedCreatedNodes: number;
  verification: ImportVerification[];
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

export function buildImportChangeSet(
  normalized: NormalizedImport,
  options: {
    sourceFingerprint: string;
    mode?: 'native_daily' | 'stage';
    parentId?: string;
  },
): { changeSet: GenericChangeSet; evidence: ImportEvidence } {
  const validation = validateNormalizedImportShape(normalized);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (normalized.coverage.unaccounted !== 0) {
    throw new Error(`Coverage has ${normalized.coverage.unaccounted} unaccounted source record(s).`);
  }
  const mode = options.mode ?? (
    normalized.options.dateGrouping === 'native_daily' ? 'native_daily' : 'stage'
  );
  const operations: Array<Record<string, unknown>> = [];
  const tagBindings = new Map<string, string>();
  for (const tag of collectTags(normalized)) {
    const binding = `tag_${tagBindings.size + 1}`;
    tagBindings.set(tag, binding);
    operations.push({
      op: 'ensure',
      resource: 'definition',
      definitionType: 'tag',
      name: tag,
      bind: binding,
    });
  }
  const defaultParent = options.parentId
    ? targetId(options.parentId)
    : targetId('library');
  const dates: string[] = [];
  const verificationCandidates: ImportVerification[] = [];
  let bindingSequence = 0;
  let expectedCreatedNodes = 0;
  const nextBinding = (prefix: string) => `${prefix}_${++bindingSequence}`;
  const appendNode = (node: ImportNode, parent: Record<string, unknown>): { binding: string; nodeCount: number } => {
    const binding = nextBinding('node');
    const fieldChildren = (node.fields ?? []).map((field) => ({
      content: richText(`${field.name}: ${field.values.join(', ')}`),
      children: [],
    }));
    operations.push({
      op: 'create',
      parents: parent,
      nodes: [{
        content: richText(node.code?.text ?? node.title),
        children: fieldChildren,
        ...(node.description ? { description: node.description } : {}),
        ...(node.code ? { type: 'codeBlock', codeLanguage: node.code.language ?? '' } : {}),
        ...(node.checked !== undefined ? { checkbox: true, done: node.checked } : {}),
      }],
      bind: binding,
    });
    let nodeCount = 1 + fieldChildren.length;
    expectedCreatedNodes += nodeCount;
    for (const tag of node.tags ?? []) {
      const tagBinding = tagBindings.get(tag);
      if (!tagBinding) throw new Error(`Missing tag binding for normalized tag: ${tag}`);
      operations.push({
        op: 'update',
        targets: { binding },
        changes: [{ kind: 'tag', action: 'add', tag: { binding: tagBinding } }],
      });
    }
    for (const child of node.children ?? []) nodeCount += appendNode(child, { binding }).nodeCount;
    return { binding, nodeCount };
  };
  const needsStagingRoot = mode === 'stage'
    || normalized.sections.some((section) => section.kind !== 'date' || !section.date);
  const stagingBinding = needsStagingRoot ? nextBinding('staging') : undefined;
  let stagingNodeCount = 0;
  if (stagingBinding) {
    operations.push({
      op: 'create',
      parents: defaultParent,
      nodes: [{ content: richText(`Import: ${sourceLabel(normalized.source)}`), children: [] }],
      bind: stagingBinding,
    });
    expectedCreatedNodes += 1;
    stagingNodeCount = 1;
  }
  for (const section of normalized.sections) {
    if (mode === 'native_daily' && section.kind === 'date' && section.date) {
      const binding = nextBinding('date');
      dates.push(section.date);
      operations.push({ op: 'ensure', resource: 'date', date: section.date, bind: binding });
      verificationCandidates.push({ binding, kind: 'date', date: section.date, expectedNodeCount: 1 });
      for (const [nodeIndex, node] of section.nodes.entries()) {
        const created = appendNode(node, { binding });
        if (nodeIndex === 0) {
          verificationCandidates.push(verificationForTree(created.binding, created.nodeCount));
        }
      }
      continue;
    }
    const sectionBinding = nextBinding('section');
    operations.push({
      op: 'create',
      parents: { binding: stagingBinding! },
      nodes: [{ content: richText(section.title), children: [] }],
      bind: sectionBinding,
    });
    expectedCreatedNodes += 1;
    let sectionNodeCount = 1;
    for (const node of section.nodes) sectionNodeCount += appendNode(node, { binding: sectionBinding }).nodeCount;
    stagingNodeCount += sectionNodeCount;
  }
  if (stagingBinding) verificationCandidates.push(verificationForTree(stagingBinding, stagingNodeCount));
  const verification = sampleEvenly(verificationCandidates, 32);
  const changeSet: GenericChangeSet = {
    protocolVersion: 1,
    kind: 'outline.changeset',
    source: {
      kind: 'import',
      label: `${normalized.source.kind} import`,
      uri: normalized.source.path,
      fingerprint: options.sourceFingerprint,
    },
    operations,
    return: verification.map((entry) => entry.kind === 'date'
      ? {
          kind: 'summary',
          targets: { binding: entry.binding },
          page: { limit: 1 },
        }
      : {
          kind: 'outline',
          targets: { binding: entry.binding },
          depth: 1_024,
          include: ['description', 'children', 'tags', 'fields', 'references', 'media', 'view', 'trash'],
          page: { limit: Math.min(entry.expectedNodeCount, 10_000) },
        }),
  };
  return {
    changeSet,
    evidence: {
      version: 1,
      source: normalized.source,
      sourceFingerprint: options.sourceFingerprint,
      changeSetFingerprint: sha256Text(JSON.stringify(changeSet)),
      coverage: normalized.coverage,
      warnings: normalized.warnings,
      stats: normalized.stats,
      mode,
      dates,
      expectedCreatedNodes,
      verification,
    },
  };
}

export function validateImportEvidence(
  evidence: ImportEvidence,
  changeSet: unknown,
): string[] {
  const errors: string[] = [];
  if (evidence.version !== 1) errors.push('evidence.version must be 1');
  if (evidence.coverage.unaccounted !== 0) errors.push('coverage.unaccounted must be 0');
  if (!/^[a-f0-9]{64}$/u.test(evidence.sourceFingerprint)) {
    errors.push('sourceFingerprint must be a SHA-256 digest');
  }
  if (sha256Text(JSON.stringify(changeSet)) !== evidence.changeSetFingerprint) {
    errors.push('ChangeSet fingerprint does not match reviewed evidence');
  }
  if (!Array.isArray(evidence.verification) || evidence.verification.length === 0) {
    errors.push('verification must contain at least one representative binding');
  }
  return errors;
}

function verificationForTree(binding: string, nodeCount: number): ImportVerification {
  return {
    binding,
    kind: 'created-tree',
    expectedNodeCount: Math.min(nodeCount, 10_000),
    ...(nodeCount > 10_000 ? { truncated: true as const } : {}),
  };
}

function sampleEvenly<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  return Array.from({ length: limit }, (_, index) => (
    values[Math.floor(index * (values.length - 1) / (limit - 1))]!
  ));
}

function sourceLabel(source: NormalizedImport['source']): string {
  return source.sourceId?.trim() || path.basename(source.path) || source.kind;
}

function collectTags(normalized: NormalizedImport): string[] {
  const tags = new Set<string>();
  const visit = (node: ImportNode) => {
    for (const tag of node.tags ?? []) tags.add(tag);
    for (const child of node.children ?? []) visit(child);
  };
  for (const section of normalized.sections) for (const node of section.nodes) visit(node);
  return [...tags].sort();
}

function richText(text: string) {
  return { text, marks: [], inlineRefs: [] };
}

function targetId(id: string) {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
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

export function computeStats(pack: Pick<NormalizedImport, 'sections' | 'coverage'>): ImportStats {
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

export function validateNormalizedImportShape(value: unknown): { ok: true; pack: NormalizedImport } | { ok: false; errors: string[] } {
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
      if (section.kind === 'date' && !isValidIsoLocalDate(section.date)) {
        errors.push('date sections require a valid YYYY-MM-DD date');
      }
      if (section.kind === 'date' && section.title !== section.date) {
        errors.push('date section title must exactly match section.date');
      }
      if (section.kind !== 'date' && section.date !== undefined) {
        errors.push('only date sections may provide section.date');
      }
      for (const node of section.nodes ?? []) validateNodeShape(node, errors);
    }
  }
  const declared = asRecord(pack.stats);
  if (numberValue(declared.sourceRecords) !== sourceRecords) errors.push('stats.sourceRecords must match coverage total');
  for (const key of ['sections', 'nodes', 'descriptions', 'tags', 'fields', 'checked', 'dropped'] as const) {
    if (numberValue(declared[key]) !== stats[key]) errors.push(`stats.${key} must match computed ${key}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, pack: value as NormalizedImport };
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

export function isValidIsoLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
