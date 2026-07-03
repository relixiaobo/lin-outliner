export type ImportPackFidelity = 'content' | 'clean' | 'full';
export type ImportPackDateGrouping = 'stage_headings' | 'none';
export type ImportPackFieldsMode = 'omit' | 'text_children' | 'field_rows';

export interface ImportPack {
  version: 1;
  source: {
    kind: string;
    path: string;
    sourceId?: string;
  };
  options: ImportOptions;
  stats: ImportStats;
  coverage: ImportCoverage;
  warnings: ImportWarning[];
  sections: ImportSection[];
}

export interface ImportOptions {
  fidelity: ImportPackFidelity;
  dateGrouping: ImportPackDateGrouping;
  tags: boolean;
  fields: ImportPackFieldsMode;
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

export type ImportPackValidation =
  | { ok: true; pack: ImportPack; computedStats: ImportStats }
  | { ok: false; code: string; message: string };

type ImportNodeValidation =
  | { ok: true; stats: ImportStats }
  | { ok: false; code: string; message: string };

const MAX_SECTIONS = 2_000;
const MAX_NODES = 75_000;
const MAX_DEPTH = 80;
const MAX_TEXT_CHARS = 100_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export function validateImportPack(value: unknown): ImportPackValidation {
  const pack = asRecord(value);
  if (pack.version !== 1) return invalid('invalid_version', 'Import Pack version must be 1.');
  const source = asRecord(pack.source);
  if (!nonEmptyString(source.kind)) return invalid('invalid_source', 'Import Pack source.kind is required.');
  if (!nonEmptyString(source.path)) return invalid('invalid_source', 'Import Pack source.path is required.');

  const options = asRecord(pack.options);
  if (!oneOf(options.fidelity, ['content', 'clean', 'full'])) return invalid('invalid_options', 'options.fidelity must be content, clean, or full.');
  if (!oneOf(options.dateGrouping, ['stage_headings', 'none'])) return invalid('invalid_options', 'options.dateGrouping must be stage_headings or none.');
  if (typeof options.tags !== 'boolean') return invalid('invalid_options', 'options.tags must be boolean.');
  if (!oneOf(options.fields, ['omit', 'text_children', 'field_rows'])) return invalid('invalid_options', 'options.fields must be omit, text_children, or field_rows.');
  if (typeof options.doneState !== 'boolean') return invalid('invalid_options', 'options.doneState must be boolean.');

  const warnings = pack.warnings;
  if (!Array.isArray(warnings)) return invalid('invalid_warnings', 'warnings must be an array.');
  for (const warning of warnings) {
    const candidate = asRecord(warning);
    if (!nonEmptyString(candidate.code) || !nonEmptyString(candidate.message)) {
      return invalid('invalid_warnings', 'Each warning needs code and message.');
    }
    if (candidate.count !== undefined && !nonNegativeInteger(candidate.count)) {
      return invalid('invalid_warnings', 'Warning count must be a non-negative integer.');
    }
  }

  const coverage = validateCoverage(pack.coverage);
  if (!coverage.ok) return coverage;

  const sections = pack.sections;
  if (!Array.isArray(sections)) return invalid('invalid_sections', 'sections must be an array.');
  if (sections.length === 0) return invalid('invalid_sections', 'Import Pack must contain at least one section.');
  if (sections.length > MAX_SECTIONS) return invalid('bounds_exceeded', `Import Pack has too many sections: ${sections.length}.`);

  let nodeCount = 0;
  const computed: ImportStats = {
    sourceRecords: coverage.coverage.imported + coverage.coverage.merged + coverage.coverage.dropped + coverage.coverage.unsupported + coverage.coverage.empty,
    sections: sections.length,
    nodes: 0,
    descriptions: 0,
    tags: 0,
    fields: 0,
    checked: 0,
    dropped: coverage.coverage.dropped,
  };

  for (const sectionValue of sections) {
    const section = asRecord(sectionValue);
    if (!nonEmptyString(section.id) || !nonEmptyString(section.title)) return invalid('invalid_section', 'Each section needs id and title.');
    if (!oneOf(section.kind, ['library', 'date', 'other'])) return invalid('invalid_section', 'Section kind must be library, date, or other.');
    if (section.date !== undefined && (typeof section.date !== 'string' || !DATE_RE.test(section.date))) {
      return invalid('invalid_section', 'Section date must be YYYY-MM-DD.');
    }
    if (!Array.isArray(section.nodes)) return invalid('invalid_section', 'Section nodes must be an array.');
    const result = validateNodes(section.nodes, 1);
    if (!result.ok) return result;
    nodeCount += result.stats.nodes;
    addStats(computed, result.stats);
    if (nodeCount > MAX_NODES) return invalid('bounds_exceeded', `Import Pack has too many nodes: ${nodeCount}.`);
  }

  const stats = validateStats(pack.stats);
  if (!stats.ok) return stats;
  if (stats.stats.sourceRecords !== computed.sourceRecords) {
    return invalid('coverage_mismatch', `stats.sourceRecords (${stats.stats.sourceRecords}) does not match coverage total (${computed.sourceRecords}).`);
  }
  for (const key of ['sections', 'nodes', 'descriptions', 'tags', 'fields', 'checked', 'dropped'] as const) {
    if (stats.stats[key] !== computed[key]) {
      return invalid('stats_mismatch', `stats.${key} (${stats.stats[key]}) does not match computed ${key} (${computed[key]}).`);
    }
  }

  return { ok: true, pack: value as ImportPack, computedStats: computed };
}

function validateNodes(nodes: unknown[], depth: number): ImportNodeValidation {
  if (depth > MAX_DEPTH) return invalid('bounds_exceeded', `Import Pack node depth exceeds ${MAX_DEPTH}.`);
  const stats: ImportStats = {
    sourceRecords: 0,
    sections: 0,
    nodes: 0,
    descriptions: 0,
    tags: 0,
    fields: 0,
    checked: 0,
    dropped: 0,
  };
  for (const nodeValue of nodes) {
    const node = asRecord(nodeValue);
    if (!nonEmptyString(node.title)) return invalid('invalid_node', 'Each node needs a non-empty title.');
    if (node.title.length > MAX_TEXT_CHARS) return invalid('bounds_exceeded', 'Node title is too large.');
    stats.nodes += 1;
    if (node.description !== undefined) {
      if (typeof node.description !== 'string') return invalid('invalid_node', 'Node description must be a string.');
      if (node.description.length > MAX_TEXT_CHARS) return invalid('bounds_exceeded', 'Node description is too large.');
      if (node.description.trim()) stats.descriptions += 1;
    }
    if (node.tags !== undefined) {
      if (!Array.isArray(node.tags) || !node.tags.every(nonEmptyString)) return invalid('invalid_node', 'Node tags must be non-empty strings.');
      stats.tags += node.tags.length;
    }
    if (node.checked !== undefined) {
      if (typeof node.checked !== 'boolean') return invalid('invalid_node', 'Node checked must be boolean.');
      if (node.checked) stats.checked += 1;
    }
    if (node.code !== undefined) {
      const code = asRecord(node.code);
      if (!nonEmptyString(code.text)) return invalid('invalid_node', 'Node code.text is required.');
      if (code.text.length > MAX_TEXT_CHARS) return invalid('bounds_exceeded', 'Node code text is too large.');
    }
    if (node.fields !== undefined) {
      if (!Array.isArray(node.fields)) return invalid('invalid_node', 'Node fields must be an array.');
      for (const fieldValue of node.fields) {
        const field = asRecord(fieldValue);
        if (!nonEmptyString(field.name)) return invalid('invalid_node', 'Field name is required.');
        if (!Array.isArray(field.values) || field.values.length === 0 || !field.values.every((value) => typeof value === 'string' && value.trim().length > 0)) {
          return invalid('invalid_node', 'Field values must be non-empty strings.');
        }
        stats.fields += 1;
      }
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) return invalid('invalid_node', 'Node children must be an array.');
      const child = validateNodes(node.children, depth + 1);
      if (!child.ok) return child;
      addStats(stats, child.stats);
    }
  }
  return { ok: true, stats };
}

function validateCoverage(value: unknown): { ok: true; coverage: ImportCoverage } | { ok: false; code: string; message: string } {
  const coverage = asRecord(value);
  for (const key of ['imported', 'merged', 'dropped', 'unsupported', 'empty', 'unaccounted'] as const) {
    if (!nonNegativeInteger(coverage[key])) return invalid('invalid_coverage', `coverage.${key} must be a non-negative integer.`);
  }
  if (coverage.unaccounted !== 0) return invalid('coverage_unaccounted', 'coverage.unaccounted must be 0 before import.');
  if (coverage.entriesFile !== undefined && typeof coverage.entriesFile !== 'string') {
    return invalid('invalid_coverage', 'coverage.entriesFile must be a string.');
  }
  return { ok: true, coverage: coverage as unknown as ImportCoverage };
}

function validateStats(value: unknown): { ok: true; stats: ImportStats } | { ok: false; code: string; message: string } {
  const stats = asRecord(value);
  for (const key of ['sourceRecords', 'sections', 'nodes', 'descriptions', 'tags', 'fields', 'checked', 'dropped'] as const) {
    if (!nonNegativeInteger(stats[key])) return invalid('invalid_stats', `stats.${key} must be a non-negative integer.`);
  }
  return { ok: true, stats: stats as unknown as ImportStats };
}

function addStats(target: ImportStats, source: ImportStats): void {
  target.nodes += source.nodes;
  target.descriptions += source.descriptions;
  target.tags += source.tags;
  target.fields += source.fields;
  target.checked += source.checked;
}

function invalid(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
