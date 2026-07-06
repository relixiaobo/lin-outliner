#!/usr/bin/env bun
/**
 * Measures whether the design-system contract is becoming a small set of
 * reusable rules instead of a pile of page-specific descriptions.
 *
 * This is a reporting tool by default. Use `--check` once the thresholds are
 * ratified as hard gates.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const DESIGN_SYSTEM_DIR = join(ROOT, 'docs', 'spec', 'design-system');
const DESIGN_SYSTEM_KERNEL = join(ROOT, 'docs', 'spec', 'design-system.md');
const COMPONENTS_DOC = join(DESIGN_SYSTEM_DIR, 'components.md');
const CALIBRATION_AUDIT = join(DESIGN_SYSTEM_DIR, 'calibration-audit.md');
const DECISION_AUDIT = join(DESIGN_SYSTEM_DIR, 'decision-audit.md');
const RENDERER_DIR = join(ROOT, 'src', 'renderer');
const RUNTIME_SURFACE_SPEC = join(ROOT, 'tests', 'e2e', 'design-system-runtime.spec.ts');

const SURFACE_BASELINE_LINES = 672;
const SURFACE_TARGET_LINES = Math.floor(SURFACE_BASELINE_LINES * 0.6);
const DESIGN_SYSTEM_DOC_REFERENCES_MIN = 1;
const COMPONENT_COVERAGE_TARGET = 0.8;
const COMPONENT_SOURCE_REFERENCES_MIN = 1;
const DECISION_DERIVATION_TARGET = 0.8;
const DECISION_EVIDENCE_COVERAGE_TARGET = 1;
const CALIBRATION_EVIDENCE_COVERAGE_TARGET = 1;
const DECISION_AUDIT_MIN_ROWS = 50;
const calibrationFindingClassNames = [
  'Code drift',
  'Named exception',
  'Open design decision',
  'Spec drift',
] as const;
const calibrationFindingClasses = new Set(calibrationFindingClassNames);
const RAW_HEX_PATTERN = /#(?:[0-9a-fA-F]{3,8})\b/g;
const RAW_FUNCTIONAL_COLOR_START_PATTERN = /\b(?:rgba?|hsla?)\s*\(/gi;
const rawColorTokenDeclarationFiles = new Set([
  'src/renderer/styles/a11y.css',
  'src/renderer/styles/theme-dark.css',
  'src/renderer/styles/tokens.css',
]);
const rawColorTokenNamePatterns = [
  /^--accent(?:-strong)?$/,
  /^--bg-(?:content|elevated|window)$/,
  /^--border-(?:emphasis|strong)$/,
  /^--control-on$/,
  /^--document-selection-bg$/,
  /^--fill-[1-4]$/,
  /^--focus-ring(?:-shadow)?$/,
  /^--highlight-mark$/,
  /^--identity-tint-\d+$/,
  /^--inline-code-bg$/,
  /^--link$/,
  /^--material-(?:popover|sidebar)$/,
  /^--outline-(?:emphasis|faint|muted|subtle)$/,
  /^--overlay-(?:backdrop|shadow-level-[12])$/,
  /^--preview-action-(?:bg|fg|hover-bg|outline)$/,
  /^--rail-edge$/,
  /^--scrollbar-thumb(?:-hover)?$/,
  /^--separator(?:-opaque)?$/,
  /^--shadow-(?:rail|thumb|thumb-strong)$/,
  /^--status-(?:danger|danger-muted|danger-solid-hover|success|success-strong|warning)$/,
  /^--surface-inverse(?:-strong)?$/,
  /^--text-(?:on-accent|primary|quaternary|secondary|selection-bg|tertiary)$/,
  /^--underline-focus-shadow$/,
];

const componentContracts = [
  {
    docNames: ['CheckboxMark'],
    jsxTags: ['CheckboxMark'],
    implementationFiles: ['src/renderer/ui/primitives/CheckboxMark.tsx'],
  },
  {
    docNames: ['CheckboxControl'],
    jsxTags: ['CheckboxControl'],
    implementationFiles: ['src/renderer/ui/primitives/CheckboxControl.tsx'],
  },
  {
    docNames: ['SwitchControl', 'SwitchMark'],
    jsxTags: ['SwitchControl', 'SwitchMark'],
    implementationFiles: [
      'src/renderer/ui/primitives/SwitchControl.tsx',
      'src/renderer/ui/primitives/SwitchMark.tsx',
    ],
  },
  {
    docNames: ['IconButton'],
    jsxTags: ['IconButton'],
    implementationFiles: ['src/renderer/ui/primitives/IconButton.tsx'],
  },
  {
    docNames: ['MenuSurface'],
    jsxTags: ['MenuSurface'],
    implementationFiles: ['src/renderer/ui/primitives/MenuSurface.tsx'],
  },
  {
    docNames: ['MenuItem'],
    jsxTags: ['MenuItem'],
    implementationFiles: ['src/renderer/ui/primitives/MenuItem.tsx'],
  },
  {
    docNames: ['useAnchoredOverlay', 'AnchoredActionMenu'],
    jsxTags: ['AnchoredActionMenu'],
    implementationFiles: [
      'src/renderer/ui/primitives/useAnchoredOverlay.ts',
      'src/renderer/ui/primitives/AnchoredActionMenu.tsx',
    ],
  },
  {
    docNames: ['PopoverListbox', 'PopoverListItem', 'PopoverEmpty'],
    jsxTags: ['PopoverListbox', 'PopoverListItem', 'PopoverEmpty'],
    implementationFiles: ['src/renderer/ui/outliner/PopoverList.tsx'],
  },
  {
    docNames: ['Dialog', 'ConfirmDialog'],
    jsxTags: ['Dialog', 'ConfirmDialog'],
    implementationFiles: [
      'src/renderer/ui/primitives/Dialog.tsx',
      'src/renderer/ui/primitives/ConfirmDialog.tsx',
    ],
  },
  {
    docNames: ['Button'],
    jsxTags: ['Button'],
    implementationFiles: ['src/renderer/ui/primitives/Button.tsx'],
  },
  {
    docNames: ['ButtonControl'],
    jsxTags: ['ButtonControl'],
    implementationFiles: ['src/renderer/ui/primitives/ButtonControl.tsx'],
  },
  {
    docNames: ['Input', 'Textarea', 'Field'],
    jsxTags: ['Input', 'Textarea', 'Field'],
    implementationFiles: [
      'src/renderer/ui/primitives/Input.tsx',
      'src/renderer/ui/primitives/Textarea.tsx',
      'src/renderer/ui/primitives/Field.tsx',
    ],
  },
  {
    docNames: ['SelectControl'],
    jsxTags: ['SelectControl'],
    implementationFiles: ['src/renderer/ui/primitives/SelectControl.tsx'],
  },
  {
    docNames: ['SegmentedControl'],
    jsxTags: ['SegmentedControl'],
    implementationFiles: ['src/renderer/ui/primitives/SegmentedControl.tsx'],
  },
  {
    docNames: ['FeedbackState', 'EmptyState', 'ErrorState'],
    jsxTags: ['EmptyState', 'ErrorState'],
    implementationFiles: ['src/renderer/ui/primitives/FeedbackState.tsx'],
  },
  {
    docNames: ['TextInputControl', 'NumberInputControl'],
    jsxTags: ['TextInputControl', 'NumberInputControl'],
    implementationFiles: [
      'src/renderer/ui/primitives/TextInputControl.tsx',
      'src/renderer/ui/primitives/NumberInputControl.tsx',
    ],
  },
  {
    docNames: ['InsetGroup', 'InsetRow', 'SettingsRowMenu'],
    jsxTags: ['InsetGroup', 'InsetRow', 'SettingsRowMenu'],
    implementationFiles: [
      'src/renderer/ui/agent/SettingsInsetList.tsx',
      'src/renderer/ui/agent/SettingsRowMenu.tsx',
    ],
  },
  {
    docNames: ['PanelSurface', 'WorkspacePanelSurface'],
    jsxTags: ['WorkspacePanelSurface'],
    implementationFiles: ['src/renderer/ui/WorkspacePanelSurface.tsx'],
  },
  {
    docNames: ['ResizeHandle'],
    jsxTags: ['ResizeHandle'],
    implementationFiles: ['src/renderer/ui/primitives/ResizeHandle.tsx'],
  },
  {
    docNames: ['AppliedTag'],
    jsxTags: ['AppliedTag'],
    implementationFiles: ['src/renderer/ui/tags/AppliedTag.tsx'],
  },
] as const;

// Specialized native controls that are implementation details, not new visual
// languages. Keep this list small and name the reason for each exception.
const nativeControlExceptions: Record<string, string> = {
  'src/renderer/ui/agent/AgentComposer.tsx': 'Hidden file input plus editor-owned buttons inside the composer surface.',
  'src/renderer/ui/agent/AgentComposerControls.tsx': 'Hidden file input delegated to the composer attachment flow.',
  'src/renderer/ui/agent/AgentEditor.tsx': 'Native textarea used by the agent-profile editor draft model.',
  'src/renderer/ui/agent/AgentMarkdown.tsx': 'Checkbox input inside rendered markdown/task-list content.',
  'src/renderer/ui/agent/AgentMessageRow.tsx': 'Textarea used for in-place message editing.',
  'src/renderer/ui/outliner/CodeBlockRow.tsx': 'Textarea/select pair required for the code-block editor overlay.',
  'src/renderer/ui/outliner/DateValuePicker.tsx': 'Native date/time controls inside the date picker.',
  'src/renderer/ui/outliner/NodeDescriptionSurface.tsx': 'Textarea follows the outliner description editing model.',
  'src/renderer/ui/outliner/NodeValuePicker.tsx': 'Input is an anchored filtering control with caller-owned query semantics.',
};

const rawColorExceptions: Record<string, { name: string; reason: string; sourcePattern: RegExp }> = {
  'src/renderer/ui/agent/AgentComposer.tsx:#ffffff': {
    name: 'Model-upload JPEG alpha matting may force a white canvas.',
    reason: 'Transparent image pixels are composited against white before JPEG encoding for model upload.',
    sourcePattern: /\bcontext\.fillStyle\s*=\s*['"]#ffffff['"]/,
  },
};

const localCalibrationExceptionNames = new Set([
  'Local focus-ring suppression uses a named replacement indicator.',
]);

function lineCount(file: string): number {
  return readFileSync(file, 'utf8').split('\n').length;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  }).sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  }).sort();
}

function filesByPattern(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesByPattern(path, pattern);
    return entry.isFile() && pattern.test(entry.name) ? [path] : [];
  }).sort();
}

function existingFilesByPattern(dir: string, pattern: RegExp): string[] {
  return existsSync(dir) ? filesByPattern(dir, pattern) : [];
}

function designSystemLineMetrics() {
  const detailFiles = markdownFiles(DESIGN_SYSTEM_DIR);
  const detailLineTotal = detailFiles.reduce((sum, file) => sum + lineCount(file), 0);
  const surfaceFile = join(DESIGN_SYSTEM_DIR, 'surfaces.md');
  const surfaceLines = lineCount(surfaceFile);
  return {
    kernelLines: lineCount(DESIGN_SYSTEM_KERNEL),
    detailLineTotal,
    surfaceLines,
    surfaceBaselineLines: SURFACE_BASELINE_LINES,
    surfaceTargetLines: SURFACE_TARGET_LINES,
    surfaceCompressionRatio: Number((1 - surfaceLines / SURFACE_BASELINE_LINES).toFixed(3)),
    surfaceShareOfDetail: Number((surfaceLines / detailLineTotal).toFixed(3)),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardReferenceMatches(candidates: string[], reference: string): string[] {
  const pattern = `^${reference.split('*').map(escapeRegExp).join('.*')}$`;
  const regex = new RegExp(pattern);
  return candidates.filter((file) => regex.test(file)).sort();
}

function sourceMapRows() {
  const source = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const start = source.indexOf('## Source Map');
  const end = source.indexOf('## Load-Bearing Rules', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return [...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Area' && !match[1]?.startsWith('---'))
    .map((match) => ({
      area: match[1]?.trim() ?? '',
      productSources: match[2] ?? '',
      contract: match[3] ?? '',
    }));
}

function malformedSourceMapRows(): string[] {
  const source = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const start = source.indexOf('## Source Map');
  const end = source.indexOf('## Load-Bearing Rules', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('| '))
    .filter((line) => line !== '| Area | Product Sources | Contract |' && !line.startsWith('| ---'))
    .filter((line) => !/^\| (.+?) \| (.+?) \| (.+?) \|$/.test(line))
    .sort();
}

function sourceMapRowReferenceCount(row: { productSources: string }): number {
  return [...row.productSources.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
    .length;
}

function sourceMapContractReferenceCount(row: { contract: string }): number {
  return markdownLinkTargets(row.contract).length;
}

function sourceMapReferenceMatches(reference: string): string[] {
  const rendererFiles = filesByPattern(RENDERER_DIR, /\.(css|ts|tsx)$/)
    .map((file) => relative(ROOT, file));
  const normalized = reference.startsWith('styles/') ? `src/renderer/${reference}` : reference;
  if (normalized.includes('*')) {
    return wildcardReferenceMatches(rendererFiles, normalized);
  }
  if (normalized.includes('/')) {
    return existsSync(join(ROOT, normalized)) ? [normalized] : [];
  }
  return rendererFiles.filter((file) => file.endsWith(`/${normalized}`)).sort();
}

function sourceMapMetrics() {
  const rows = sourceMapRows();
  const malformedRows = malformedSourceMapRows();
  const duplicateSourceMapAreas = duplicateValues(rows.map((row) => row.area));
  const incompleteSourceMapRows = rows
    .filter((row) => (
      !row.area
      || !row.productSources.trim()
      || !row.contract.trim()
      || sourceMapRowReferenceCount(row) === 0
      || sourceMapContractReferenceCount(row) === 0
    ))
    .map((row) => row.area || 'missing area')
    .sort();
  const brokenReferences: string[] = [];
  const ambiguousReferences: string[] = [];
  let referenceCount = 0;
  let contractReferenceCount = 0;
  for (const row of rows) {
    for (const match of row.productSources.matchAll(/`([^`]+)`/g)) {
      const reference = match[1]?.trim() ?? '';
      if (!reference) continue;
      referenceCount += 1;
      const matches = sourceMapReferenceMatches(reference);
      if (matches.length === 0) {
        brokenReferences.push(`${row.area}: ${reference}`);
      } else if (!reference.includes('*') && matches.length > 1) {
        ambiguousReferences.push(`${row.area}: ${reference} matched multiple files (${matches.join(', ')})`);
      }
    }
    for (const target of markdownLinkTargets(row.contract)) {
      contractReferenceCount += 1;
      if (!localMarkdownTargetExists(DESIGN_SYSTEM_KERNEL, target)) {
        brokenReferences.push(`${row.area} contract: ${target}`);
      }
    }
  }
  return {
    sourceMapRows: rows.length,
    sourceMapReferences: referenceCount,
    sourceMapContractReferences: contractReferenceCount,
    malformedSourceMapRows: malformedRows,
    duplicateSourceMapAreas,
    incompleteSourceMapRows,
    sourceMapBrokenReferences: brokenReferences.sort(),
    sourceMapAmbiguousReferences: ambiguousReferences.sort(),
  };
}

function documentedComponentNames(): Set<string> {
  const names = new Set<string>();
  for (const row of componentDocRows()) {
    for (const name of row.component.matchAll(/`([^`]+)`/g)) {
      names.add(name[1]);
    }
  }
  return names;
}

function componentDocRows() {
  const source = readFileSync(COMPONENTS_DOC, 'utf8');
  const start = source.indexOf('| Component | Sources | Contract |');
  const end = source.indexOf('## Contract Shape', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return [...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Component' && !match[1]?.startsWith('---'))
    .map((match) => ({
      component: match[1] ?? '',
      sources: match[2] ?? '',
      contract: match[3] ?? '',
    }));
}

function malformedComponentDocRows(): string[] {
  const source = readFileSync(COMPONENTS_DOC, 'utf8');
  const start = source.indexOf('| Component | Sources | Contract |');
  const end = source.indexOf('## Contract Shape', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('| '))
    .filter((line) => line !== '| Component | Sources | Contract |' && !line.startsWith('| ---'))
    .filter((line) => !/^\| (.+?) \| (.+?) \| (.+?) \|$/.test(line))
    .sort();
}

function componentRowNames(row: { component: string }): string[] {
  return [...row.component.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

function componentRowSourceReferenceCount(row: { sources: string }): number {
  return [...row.sources.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
    .length;
}

function componentRowContractReferenceCount(row: { contract: string }): number {
  return markdownLinkTargets(row.contract).length;
}

function componentSourceReferenceMetrics() {
  const brokenReferences: string[] = [];
  const ambiguousReferences: string[] = [];
  const contractBrokenReferences: string[] = [];
  const rows = componentDocRows();
  const duplicateDocumentedComponentNames = duplicateValues(rows.flatMap((row) => componentRowNames(row)));
  const incompleteComponentDocRows = rows
    .filter((row) => (
      componentRowNames(row).length === 0
      || componentRowSourceReferenceCount(row) === 0
      || !row.contract.trim()
      || componentRowContractReferenceCount(row) === 0
    ))
    .map((row) => row.component || 'missing component')
    .sort();
  let referenceCount = 0;
  let contractReferenceCount = 0;
  for (const row of rows) {
    for (const match of row.sources.matchAll(/`([^`]+)`/g)) {
      const reference = match[1]?.trim() ?? '';
      if (!reference) continue;
      referenceCount += 1;
      const matches = sourceMapReferenceMatches(reference);
      if (matches.length === 0) {
        brokenReferences.push(`${row.component}: ${reference}`);
      } else if (!reference.includes('*') && matches.length > 1) {
        ambiguousReferences.push(`${row.component}: ${reference} matched multiple files (${matches.join(', ')})`);
      }
    }
    for (const target of markdownLinkTargets(row.contract)) {
      contractReferenceCount += 1;
      if (!localMarkdownTargetExists(COMPONENTS_DOC, target)) {
        contractBrokenReferences.push(`${row.component}: ${target}`);
      }
    }
  }
  return {
    componentSourceReferences: referenceCount,
    componentContractReferences: contractReferenceCount,
    malformedComponentDocRows: malformedComponentDocRows(),
    duplicateDocumentedComponentNames,
    incompleteComponentDocRows,
    componentSourceBrokenReferences: brokenReferences.sort(),
    componentSourceAmbiguousReferences: ambiguousReferences.sort(),
    componentContractBrokenReferences: contractBrokenReferences.sort(),
  };
}

function markdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

function stripMarkdownCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`+[^`\n]*`+/g, (span) => span.replace(/[^\n]/g, ' '));
}

function normalizeMarkdownLinkTarget(target: string): { path: string; anchor: string | null } | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  const [pathWithQuery, rawAnchor] = unwrapped.split('#', 2);
  const pathOnly = pathWithQuery!.split('?', 1)[0]!;

  try {
    return {
      path: pathOnly ? decodeURIComponent(pathOnly) : '',
      anchor: rawAnchor ? decodeURIComponent(rawAnchor) : null,
    };
  } catch {
    return { path: pathOnly, anchor: rawAnchor ?? null };
  }
}

function markdownHeadingSlug(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const headingAnchorCache = new Map<string, Set<string>>();

function markdownHeadingAnchors(file: string): Set<string> {
  const cached = headingAnchorCache.get(file);
  if (cached) return cached;

  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const source = stripMarkdownCode(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = markdownHeadingSlug(match[0]!);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  headingAnchorCache.set(file, anchors);
  return anchors;
}

function localMarkdownTargetExists(sourceFile: string, target: string): boolean {
  const normalized = normalizeMarkdownLinkTarget(target);
  if (!normalized) return true;
  const resolved = normalized.path ? join(dirname(sourceFile), normalized.path) : sourceFile;
  if (!existsSync(resolved)) return false;
  if (normalized.anchor && resolved.endsWith('.md')) {
    return markdownHeadingAnchors(resolved).has(normalized.anchor);
  }
  return true;
}

function fileNameMatchesUnder(dir: string, fileName: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return fileNameMatchesUnder(path, fileName);
    return entry.isFile() && entry.name === fileName ? [relative(ROOT, path)] : [];
  });
}

function duplicateValues(values: string[]): string[] {
  return values
    .filter((value, index) => values.indexOf(value) !== index)
    .filter((value, index, duplicates) => duplicates.indexOf(value) === index)
    .sort();
}

function localEvidenceCodePathMatches(reference: string): string[] {
  if (existsSync(join(ROOT, reference))) return [reference];
  if (reference.includes('/')) return [];

  const matches = [
    DESIGN_SYSTEM_DIR,
    join(ROOT, 'docs', 'spec'),
    join(ROOT, 'docs', 'plans'),
    join(ROOT, 'src', 'core'),
    join(ROOT, 'src', 'renderer'),
    join(ROOT, 'tests', 'e2e'),
    join(ROOT, 'tests', 'renderer'),
  ].flatMap((dir) => fileNameMatchesUnder(dir, reference));
  return [...new Set(matches)].sort();
}

function designSystemDocReferenceFiles(): string[] {
  return [
    DESIGN_SYSTEM_KERNEL,
    join(DESIGN_SYSTEM_DIR, 'components.md'),
    join(DESIGN_SYSTEM_DIR, 'decision-audit.md'),
    join(DESIGN_SYSTEM_DIR, 'foundations.md'),
    join(DESIGN_SYSTEM_DIR, 'implementation.md'),
    join(DESIGN_SYSTEM_DIR, 'patterns.md'),
    join(DESIGN_SYSTEM_DIR, 'surfaces.md'),
  ].filter((file) => existsSync(file));
}

function repoCodePathCandidates(): string[] {
  return [
    ...markdownFiles(join(ROOT, 'docs', 'spec')),
    ...existingFilesByPattern(join(ROOT, 'docs', 'plans'), /\.md$/),
    ...existingFilesByPattern(join(ROOT, 'scripts'), /\.(ts|tsx|js|mjs|cjs)$/),
    ...existingFilesByPattern(join(ROOT, 'src'), /\.(css|ts|tsx)$/),
    ...existingFilesByPattern(join(ROOT, 'tests'), /\.(ts|tsx)$/),
  ].map((file) => relative(ROOT, file)).sort();
}

function designSystemDocCodePathMatches(reference: string, candidates: string[]): string[] {
  const normalized = reference.startsWith('styles/') ? `src/renderer/${reference}` : reference;
  if (normalized.includes('*')) {
    return wildcardReferenceMatches(candidates, normalized);
  }
  if (existsSync(join(ROOT, normalized))) return [normalized];
  if (normalized.includes('/')) return [];
  const matches = candidates.filter((file) => file.endsWith(`/${normalized}`));
  return [...new Set(matches)].sort();
}

function designSystemDocReferenceMetrics() {
  const brokenReferences: string[] = [];
  const ambiguousReferences: string[] = [];
  const candidates = repoCodePathCandidates();
  let referenceCount = 0;
  for (const file of designSystemDocReferenceFiles()) {
    const relativeFile = relative(ROOT, file);
    const source = readFileSync(file, 'utf8');
    for (const reference of evidenceCodePathReferences(source)) {
      referenceCount += 1;
      const matches = designSystemDocCodePathMatches(reference, candidates);
      const label = `${relativeFile}: ${reference}`;
      if (matches.length === 0) {
        brokenReferences.push(label);
      } else if (!reference.includes('*') && matches.length > 1) {
        ambiguousReferences.push(`${label} matched multiple files (${matches.join(', ')})`);
      }
    }
  }
  return {
    designSystemDocReferenceFiles: designSystemDocReferenceFiles().map((file) => relative(ROOT, file)),
    designSystemDocReferences: referenceCount,
    designSystemDocBrokenReferences: brokenReferences.sort(),
    designSystemDocAmbiguousReferences: ambiguousReferences.sort(),
  };
}

function repoEvidenceCodePathMatches(reference: string): string[] {
  return existsSync(join(ROOT, reference)) ? [reference] : [];
}

function evidenceCodePathReferences(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((value) => {
      if (!value || value.startsWith('--') || value.includes(' ')) return false;
      return /^(docs|scripts|src|tests)\//.test(value) || /\.(?:css|md|ts|tsx)$/.test(value);
    });
}

function brokenLocalEvidenceReferences(
  sourceFile: string,
  label: string,
  markdown: string,
  codePathMatches: (reference: string) => string[],
): string[] {
  const brokenReferences: string[] = [];
  for (const target of markdownLinkTargets(markdown)) {
    if (!localMarkdownTargetExists(sourceFile, target)) {
      brokenReferences.push(`${label}: ${target}`);
    }
  }
  for (const reference of evidenceCodePathReferences(markdown)) {
    const matches = codePathMatches(reference);
    if (matches.length === 0) {
      brokenReferences.push(`${label}: ${reference}`);
    } else if (matches.length > 1) {
      brokenReferences.push(`${label}: ${reference} matched multiple files (${matches.join(', ')})`);
    }
  }
  return brokenReferences;
}

function exceptionRegistryRows() {
  const kernel = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const start = kernel.indexOf('## Exception Registry');
  const end = kernel.indexOf('## Foundations', start);
  const section = start >= 0 && end > start ? kernel.slice(start, end) : '';
  return [...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Exception' && !match[1]?.startsWith('---'))
    .map((match) => ({
      name: match[1] ?? '',
      scope: match[2] ?? '',
      authority: match[3] ?? '',
      evidence: match[4] ?? '',
    }));
}

function malformedExceptionRegistryRows(): string[] {
  const kernel = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const start = kernel.indexOf('## Exception Registry');
  const end = kernel.indexOf('## Foundations', start);
  const section = start >= 0 && end > start ? kernel.slice(start, end) : '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('| '))
    .filter((line) => line !== '| Exception | Scope | Authority | Evidence |' && !line.startsWith('| ---'))
    .filter((line) => !/^\| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/.test(line))
    .sort();
}

function calibrationNamedExceptionRowList() {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Named Exceptions Kept');
  const end = source.indexOf('## Native-Control Exceptions', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return [...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Exception' && !match[1]?.startsWith('---'))
    .map((match) => ({
      name: match[1] ?? '',
      scope: match[2] ?? '',
      evidence: match[3] ?? '',
    }))
    .filter((row) => Boolean(row.name));
}

function calibrationNamedExceptionRows(): Map<string, { scope: string; evidence: string }> {
  return new Map(
    calibrationNamedExceptionRowList().map((row) => [
      row.name,
      {
        scope: row.scope,
        evidence: row.evidence,
      },
    ] as const),
  );
}

function malformedCalibrationNamedExceptionRows(): string[] {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Named Exceptions Kept');
  const end = source.indexOf('## Native-Control Exceptions', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('| '))
    .filter((line) => line !== '| Exception | Scope | Evidence |' && !line.startsWith('| ---'))
    .filter((line) => !/^\| (.+?) \| (.+?) \| (.+?) \|$/.test(line))
    .sort();
}

function calibrationClassificationRows() {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Classification Model');
  const end = source.indexOf('## Calibration Rule', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return [...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Class' && !match[1]?.startsWith('---'))
    .map((match) => ({
      name: match[1]?.trim() ?? '',
      meaning: match[2]?.trim() ?? '',
      requiredResponse: match[3]?.trim() ?? '',
    }))
    .filter((row) => Boolean(row.name || row.meaning || row.requiredResponse));
}

function calibrationFindingRows() {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  return [...source.matchAll(/^\| (CA\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .map((match) => ({
      id: match[1] ?? '',
      finding: match[2] ?? '',
      classification: match[3]?.trim() ?? '',
      resolution: match[4] ?? '',
      evidence: match[5] ?? '',
    }));
}

function malformedCalibrationFindingRows(): string[] {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Findings Ledger');
  const end = source.indexOf('## Named Exceptions Kept', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\| CA\d+/.test(line))
    .filter((line) => !/^\| (CA\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/.test(line))
    .sort();
}

function malformedOpenDesignDecisionRows(): string[] {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Open Design Decisions');
  const section = start >= 0 ? source.slice(start) : '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('| '))
    .filter((line) => line !== '| Area | Why it needs a decision |' && !line.startsWith('| ---'))
    .filter((line) => !/^\| (.+?) \| (.+?) \|$/.test(line))
    .sort();
}

function openDesignDecisionRows() {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Open Design Decisions');
  const section = start >= 0 ? source.slice(start) : '';
  return [...section.matchAll(/^\| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Area' && !match[1]?.startsWith('---'))
    .map((match) => ({
      area: match[1]?.trim() ?? '',
      reason: match[2]?.trim() ?? '',
    }))
    .filter((row) => Boolean(row.area || row.reason));
}

function decisionAuditRows() {
  const source = readFileSync(DECISION_AUDIT, 'utf8');
  return [...source.matchAll(/^\| (D\d{2}) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .map((match) => ({
      id: match[1] ?? '',
      decision: match[2] ?? '',
      derivesFrom: match[3] ?? '',
      evidence: match[4] ?? '',
      result: match[5]?.trim() ?? '',
    }));
}

function malformedDecisionAuditRows(): string[] {
  const source = readFileSync(DECISION_AUDIT, 'utf8');
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\| D\d{2}/.test(line))
    .filter((line) => !/^\| (D\d{2}) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/.test(line))
    .sort();
}

function exceptionEvidenceMetrics() {
  const rows = exceptionRegistryRows();
  const malformedRegistryRows = malformedExceptionRegistryRows();
  const registryNames = rows.map((row) => row.name);
  const registryNameSet = new Set(registryNames);
  const calibrationNameRows = calibrationNamedExceptionRowList();
  const calibrationNameList = calibrationNameRows.map((row) => row.name);
  const calibrationNames = calibrationNamedExceptionRows();
  const malformedNamedExceptionRows = malformedCalibrationNamedExceptionRows();
  const evidenceRows = rows.filter((row) => /\[[^\]]+\]\([^)]+\)|`[^`]+`/.test(row.evidence));
  const brokenReferences = new Set<string>();
  for (const row of rows) {
    const name = row.name || 'unknown exception';
    brokenLocalEvidenceReferences(
      DESIGN_SYSTEM_KERNEL,
      name,
      `${row.authority} ${row.evidence}`,
      repoEvidenceCodePathMatches,
    ).forEach((reference) => brokenReferences.add(reference));
  }
  const namedExceptionSummaryBrokenReferences = new Set<string>();
  for (const row of calibrationNameRows) {
    brokenLocalEvidenceReferences(
      CALIBRATION_AUDIT,
      row.name,
      row.evidence,
      localEvidenceCodePathMatches,
    ).forEach((reference) => namedExceptionSummaryBrokenReferences.add(reference));
  }
  return {
    exceptionRows: rows.length,
    malformedRegistryRows,
    duplicateRegistryExceptionNames: duplicateValues(registryNames),
    exceptionEvidenceRows: evidenceRows.length,
    exceptionEvidenceCoverage: rows.length === 0 ? 1 : Number((evidenceRows.length / rows.length).toFixed(3)),
    exceptionBrokenReferences: [...brokenReferences].sort(),
    namedExceptionSummaryBrokenReferences: [...namedExceptionSummaryBrokenReferences].sort(),
    registryExceptionsMissingFromCalibration: [...registryNameSet]
      .filter((name) => !calibrationNames.has(name))
      .sort(),
    duplicateNamedExceptionSummaryNames: duplicateValues(calibrationNameList),
    malformedNamedExceptionRows,
    calibrationExceptionsMissingFromRegistry: [...calibrationNames.keys()]
      .filter((name) => !registryNameSet.has(name) && !localCalibrationExceptionNames.has(name))
      .sort(),
    localCalibrationExceptionEntriesMissing: [...localCalibrationExceptionNames]
      .filter((name) => !calibrationNames.has(name))
      .sort(),
  };
}

function calibrationAuditMetrics() {
  const classificationRows = calibrationClassificationRows();
  const classificationNames = classificationRows.map((row) => row.name);
  const duplicateClassificationModelClasses = classificationNames
    .filter((name, index) => classificationNames.indexOf(name) !== index)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
  const missingClassificationModelClasses = calibrationFindingClassNames
    .filter((name) => !classificationNames.includes(name))
    .sort();
  const unexpectedClassificationModelClasses = classificationNames
    .filter((name) => name && !calibrationFindingClasses.has(name))
    .sort();
  const incompleteClassificationModelRows = classificationRows
    .filter((row) => !row.name || !row.meaning || !row.requiredResponse)
    .map((row) => row.name || 'missing class name')
    .sort();
  const rows = calibrationFindingRows();
  const malformedCalibrationRows = malformedCalibrationFindingRows();
  const malformedOpenDecisionRows = malformedOpenDesignDecisionRows();
  const openDecisionRows = openDesignDecisionRows();
  const duplicateOpenDesignDecisionAreas = duplicateValues(openDecisionRows.map((row) => row.area));
  const incompleteOpenDesignDecisionRows = openDecisionRows
    .filter((row) => !row.area || !row.reason)
    .map((row) => row.area || 'missing area')
    .sort();
  const rowIds = rows.map((row) => row.id);
  const duplicateCalibrationIds = rowIds
    .filter((id, index) => rowIds.indexOf(id) !== index)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort();
  const maxCalibrationId = Math.max(
    0,
    ...rowIds.map((id) => Number(id.slice(2))).filter((value) => Number.isFinite(value)),
  );
  const missingCalibrationIds = Array.from({ length: maxCalibrationId }, (_, index) => {
    const id = `CA${String(index + 1).padStart(2, '0')}`;
    return rowIds.includes(id) ? '' : id;
  }).filter(Boolean);
  const invalidCalibrationClasses = rows
    .filter((row) => !calibrationFindingClasses.has(row.classification))
    .map((row) => `${row.id} ${row.finding}: ${row.classification || 'missing classification'}`)
    .sort();
  const evidenceRows = rows.filter((row) => /\[[^\]]+\]\([^)]+\)|`[^`]+`/.test(row.evidence));
  const brokenReferences = new Set<string>();
  for (const row of rows) {
    brokenLocalEvidenceReferences(
      CALIBRATION_AUDIT,
      `${row.id} ${row.finding}`,
      row.evidence,
      localEvidenceCodePathMatches,
    ).forEach((reference) => brokenReferences.add(reference));
  }

  return {
    calibrationClassificationRows: classificationRows.length,
    duplicateClassificationModelClasses,
    missingClassificationModelClasses,
    unexpectedClassificationModelClasses,
    incompleteClassificationModelRows,
    calibrationRows: rows.length,
    malformedCalibrationRows,
    malformedOpenDecisionRows,
    openDesignDecisionRows: openDecisionRows.length,
    duplicateOpenDesignDecisionAreas,
    incompleteOpenDesignDecisionRows,
    duplicateCalibrationIds,
    missingCalibrationIds,
    invalidCalibrationClasses,
    calibrationEvidenceRows: evidenceRows.length,
    calibrationEvidenceCoverage: rows.length === 0 ? 0 : Number((evidenceRows.length / rows.length).toFixed(3)),
    calibrationBrokenReferences: [...brokenReferences].sort(),
  };
}

function decisionAuditMetrics() {
  const rows = decisionAuditRows();
  const malformedDecisionRows = malformedDecisionAuditRows();
  const rowIds = rows.map((row) => row.id);
  const duplicateDecisionIds = rowIds
    .filter((id, index) => rowIds.indexOf(id) !== index)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort();
  const duplicateDecisionTexts = duplicateValues(
    rows.map((row) => row.decision.trim()).filter(Boolean),
  );
  const incompleteDecisionRows = rows
    .filter((row) => !row.decision.trim() || !row.derivesFrom.trim() || !row.evidence.trim() || !row.result.trim())
    .map((row) => row.id || 'missing id')
    .sort();
  const maxDecisionId = Math.max(
    DECISION_AUDIT_MIN_ROWS,
    ...rowIds.map((id) => Number(id.slice(1))).filter((value) => Number.isFinite(value)),
  );
  const missingDecisionIds = Array.from({ length: maxDecisionId }, (_, index) => {
    const id = `D${String(index + 1).padStart(2, '0')}`;
    return rowIds.includes(id) ? '' : id;
  }).filter(Boolean);
  const derivedRows = rows.filter((row) => row.result === 'Derived');
  const exceptionRows = rows.filter((row) => row.result === 'Exception');
  const invalidDecisionResults = rows
    .filter((row) => row.result !== 'Derived' && row.result !== 'Exception')
    .map((row) => `${row.id} ${row.decision}: ${row.result || 'missing result'}`)
    .sort();
  const evidenceRows = rows.filter((row) => /\[[^\]]+\]\([^)]+\)|`[^`]+`/.test(row.evidence));
  const exceptionNames = exceptionRegistryRows().map((row) => row.name);
  const unnamedExceptionDecisions = exceptionRows
    .filter((row) => !exceptionNames.some((name) => row.derivesFrom.includes(name)))
    .map((row) => `${row.id} ${row.decision}`)
    .sort();
  const brokenReferences = new Set<string>();
  for (const row of rows) {
    brokenLocalEvidenceReferences(
      DECISION_AUDIT,
      `${row.id} ${row.decision}`,
      `${row.derivesFrom} ${row.evidence}`,
      repoEvidenceCodePathMatches,
    ).forEach((reference) => brokenReferences.add(reference));
  }
  return {
    decisionRows: rows.length,
    decisionRowMinimumTarget: DECISION_AUDIT_MIN_ROWS,
    malformedDecisionRows,
    duplicateDecisionIds,
    duplicateDecisionTexts,
    incompleteDecisionRows,
    missingDecisionIds,
    derivedDecisionRows: derivedRows.length,
    exceptionDecisionRows: exceptionRows.length,
    decisionEvidenceRows: evidenceRows.length,
    decisionEvidenceCoverage: rows.length === 0 ? 0 : Number((evidenceRows.length / rows.length).toFixed(3)),
    decisionBrokenReferences: [...brokenReferences].sort(),
    invalidDecisionResults,
    unnamedExceptionDecisions,
    decisionDerivationCoverage: rows.length === 0 ? 0 : Number((derivedRows.length / rows.length).toFixed(3)),
  };
}

function nativeControlExceptionAuditRowList() {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Native-Control Exceptions');
  const end = source.indexOf('## Open Design Decisions', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return [...section.matchAll(/^\| `([^`]+)` \| (\d+) \| (.+?) \|$/gm)]
    .map((match) => ({
      file: match[1] ?? '',
      count: Number(match[2] ?? 0),
      reason: match[3]?.trim() ?? '',
    }))
    .filter((row) => Boolean(row.file));
}

function nativeControlExceptionAuditRows(): Map<string, { count: number; reason: string }> {
  return new Map(
    nativeControlExceptionAuditRowList().map((row) => [row.file, { count: row.count, reason: row.reason }] as const),
  );
}

function malformedNativeControlExceptionRows(): string[] {
  const source = readFileSync(CALIBRATION_AUDIT, 'utf8');
  const start = source.indexOf('## Native-Control Exceptions');
  const end = source.indexOf('## Open Design Decisions', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('| '))
    .filter((line) => line !== '| File | Count | Reason |' && !line.startsWith('| ---'))
    .filter((line) => !/^\| `([^`]+)` \| \d+ \| (.+?) \|$/.test(line))
    .sort();
}

function componentCoverageMetrics() {
  const files = sourceFiles(RENDERER_DIR);
  const componentTags = new Set(componentContracts.flatMap((contract) => contract.jsxTags));
  const componentImplementationFiles = new Set(
    componentContracts.flatMap((contract) => contract.implementationFiles),
  );
  const documentedNames = documentedComponentNames();
  const mappedDocNames = new Set(componentContracts.flatMap((contract) => contract.docNames));
  const unmappedDocumentedContracts = [...documentedNames].filter((name) => !mappedDocNames.has(name)).sort();
  const mappedContractsMissingFromDocs = [...mappedDocNames].filter((name) => !documentedNames.has(name)).sort();
  const componentImplementationFilesMissing = [...componentImplementationFiles]
    .filter((file) => !existsSync(join(ROOT, file)))
    .sort();
  const componentSourceReferences = componentSourceReferenceMetrics();
  let primitiveUses = 0;
  let nativeUses = 0;
  let exceptedNativeUses = 0;
  let componentImplementationNativeUses = 0;
  const directNativeFiles = new Map<string, number>();
  const exceptedNativeFiles = new Map<string, { count: number; reason: string }>();
  const componentImplementationNativeFiles = new Map<string, number>();
  const nativeTags = new Set(['button', 'input', 'textarea', 'select']);

  for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    let directNativeCount = 0;
    let componentImplementationNativeCount = 0;
    const isComponentImplementation = componentImplementationFiles.has(rel) || rel.startsWith('src/renderer/ui/primitives/');

    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sourceFile);
        const baseTagName = tagName.split('.')[0];
        if (componentTags.has(tagName) || componentTags.has(baseTagName)) {
          primitiveUses += 1;
        }
        if (nativeTags.has(tagName)) {
          if (isComponentImplementation) {
            componentImplementationNativeCount += 1;
          } else {
            directNativeCount += 1;
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    if (componentImplementationNativeCount > 0) {
      componentImplementationNativeUses += componentImplementationNativeCount;
      componentImplementationNativeFiles.set(rel, componentImplementationNativeCount);
    }
    if (directNativeCount === 0) continue;
    const exceptionReason = nativeControlExceptions[rel];
    if (exceptionReason) {
      exceptedNativeUses += directNativeCount;
      exceptedNativeFiles.set(rel, {
        count: directNativeCount,
        reason: exceptionReason,
      });
    } else {
      nativeUses += directNativeCount;
      directNativeFiles.set(rel, directNativeCount);
    }
  }

  const staleNativeControlExceptions = Object.keys(nativeControlExceptions)
    .filter((file) => !exceptedNativeFiles.has(file))
    .sort();
  const auditedNativeControlExceptions = nativeControlExceptionAuditRows();
  const malformedNativeControlRows = malformedNativeControlExceptionRows();
  const duplicateNativeControlAuditFiles = duplicateValues(
    nativeControlExceptionAuditRowList().map((row) => row.file),
  );
  const nativeControlExceptionsMissingFromAudit = Object.keys(nativeControlExceptions)
    .filter((file) => !auditedNativeControlExceptions.has(file))
    .sort();
  const nativeControlAuditEntriesMissingFromMetrics = [...auditedNativeControlExceptions.keys()]
    .filter((file) => !(file in nativeControlExceptions))
    .sort();
  const nativeControlExceptionReasonMismatches = Object.entries(nativeControlExceptions)
    .filter(([file, reason]) => {
      const audit = auditedNativeControlExceptions.get(file);
      return Boolean(audit && audit.reason !== reason);
    })
    .map(([file, reason]) => `${file}: metrics="${reason}" audit="${auditedNativeControlExceptions.get(file)?.reason ?? ''}"`)
    .sort();
  const nativeControlExceptionCountMismatches = [...exceptedNativeFiles.entries()]
    .filter(([file, entry]) => {
      const audit = auditedNativeControlExceptions.get(file);
      return Boolean(audit && audit.count !== entry.count);
    })
    .map(([file, entry]) => `${file}: metrics=${entry.count} audit=${auditedNativeControlExceptions.get(file)?.count ?? 0}`)
    .sort();
  const accountableControls = primitiveUses + nativeUses;
  return {
    primitiveUses,
    directNativeUses: nativeUses,
    exceptedNativeUses,
    componentImplementationNativeUses,
    componentCoverage: accountableControls === 0 ? 1 : Number((primitiveUses / accountableControls).toFixed(3)),
    componentContractRows: componentContracts.length,
    ...componentSourceReferences,
    componentTagNames: [...componentTags].sort(),
    directNativeFiles: Object.fromEntries([...directNativeFiles.entries()].sort()),
    exceptedNativeFiles: Object.fromEntries([...exceptedNativeFiles.entries()].sort()),
    componentImplementationNativeFiles: Object.fromEntries([...componentImplementationNativeFiles.entries()].sort()),
    staleNativeControlExceptions,
    componentImplementationFilesMissing,
    mappedContractsMissingFromDocs,
    unmappedDocumentedContracts,
    nativeControlExceptionsMissingFromAudit,
    nativeControlAuditEntriesMissingFromMetrics,
    nativeControlExceptionReasonMismatches,
    nativeControlExceptionCountMismatches,
    malformedNativeControlRows,
    duplicateNativeControlAuditFiles,
  };
}

function rawFunctionalColorMatches(value: string): string[] {
  const matches: string[] = [];
  RAW_FUNCTIONAL_COLOR_START_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = RAW_FUNCTIONAL_COLOR_START_PATTERN.exec(value)) !== null) {
    const start = match.index;
    let index = RAW_FUNCTIONAL_COLOR_START_PATTERN.lastIndex - 1;
    let depth = 0;

    for (; index < value.length; index += 1) {
      const char = value[index];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }

    matches.push(value.slice(start, index));
    RAW_FUNCTIONAL_COLOR_START_PATTERN.lastIndex = Math.max(index, RAW_FUNCTIONAL_COLOR_START_PATTERN.lastIndex);
  }

  RAW_FUNCTIONAL_COLOR_START_PATTERN.lastIndex = 0;
  return matches;
}

function isRawColorTokenDeclaration(file: string, line: string): boolean {
  if (!rawColorTokenDeclarationFiles.has(relative(ROOT, file))) return false;
  const tokenName = line.trim().match(/^(--[\w-]+)\s*:/)?.[1];
  return Boolean(tokenName && rawColorTokenNamePatterns.some((pattern) => pattern.test(tokenName)));
}

function rawColorMetrics() {
  const files = filesByPattern(RENDERER_DIR, /\.(css|ts|tsx)$/);
  const hexViolations: string[] = [];
  const functionalColorViolations: string[] = [];
  const exceptionUses: string[] = [];
  const usedExceptions = new Set<string>();
  const kernel = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const undocumentedExceptions = Object.values(rawColorExceptions)
    .filter((exception) => !kernel.includes(`| ${exception.name} |`))
    .map((exception) => exception.name);

  function recordRawColorMatch(
    file: string,
    lineNumber: number,
    lineText: string,
    value: string,
    violations: string[],
  ) {
    const rel = relative(ROOT, file);
    const exceptionKey = `${rel}:${value.toLowerCase()}`;
    const exception = rawColorExceptions[exceptionKey];
    const finding = `${rel}:${lineNumber} ${value} ${lineText.trim()}`;
    if (exception && exception.sourcePattern.test(lineText)) {
      usedExceptions.add(exceptionKey);
      exceptionUses.push(`${finding} (${exception.name})`);
    } else {
      violations.push(finding);
    }
  }

  function recordFunctionalColorMatch(file: string, lineNumber: number, lineText: string, value: string) {
    recordRawColorMatch(file, lineNumber, lineText, value, functionalColorViolations);
  }

  function scanFunctionalColorText(file: string, lineNumber: number, lineText: string, value: string) {
    for (const valueMatch of rawFunctionalColorMatches(value)) {
      recordFunctionalColorMatch(file, lineNumber, lineText, valueMatch);
    }
  }

  function scanCss(file: string, text: string) {
    const uncommented = text.replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    const originalLines = text.split('\n');
    uncommented.split('\n').forEach((line, index) => {
      if (isRawColorTokenDeclaration(file, line)) return;
      for (const match of line.matchAll(RAW_HEX_PATTERN)) {
        recordRawColorMatch(file, index + 1, originalLines[index] ?? line, match[0], hexViolations);
      }
      scanFunctionalColorText(file, index + 1, originalLines[index] ?? line, line);
    });
  }

  function scanTs(file: string, text: string) {
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lines = text.split('\n');

    function scanText(node: ts.Node, value: string) {
      for (const match of value.matchAll(RAW_HEX_PATTERN)) {
        const position = node.getStart(sourceFile);
        const { line } = sourceFile.getLineAndCharacterOfPosition(position);
        recordRawColorMatch(file, line + 1, lines[line] ?? value, match[0], hexViolations);
      }
      if (rawFunctionalColorMatches(value).length === 0) return;
      const position = node.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(position);
      scanFunctionalColorText(file, line + 1, lines[line] ?? value, value);
    }

    function visit(node: ts.Node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        scanText(node, node.text);
      } else if (ts.isTemplateExpression(node)) {
        scanText(node.head, node.head.text);
        for (const span of node.templateSpans) {
          scanText(span.literal, span.literal.text);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) {
      scanCss(file, text);
    } else {
      scanTs(file, text);
    }
  }

  return {
    rawHexOutsideTokenDeclarations: hexViolations.length,
    rawHexViolations: hexViolations,
    rawFunctionalColorOutsideTokenDeclarations: functionalColorViolations.length,
    rawFunctionalColorViolations: functionalColorViolations,
    rawColorExceptionUses: exceptionUses,
    staleRawColorExceptions: Object.entries(rawColorExceptions)
      .filter(([key]) => !usedExceptions.has(key))
      .map(([key, exception]) => `${key} (${exception.name})`)
      .sort(),
    undocumentedRawColorExceptions: undocumentedExceptions,
  };
}

function runtimeSurfaceMetrics() {
  const source = readFileSync(RUNTIME_SURFACE_SPEC, 'utf8');
  const surfacesStart = source.indexOf('const surfaces: SurfaceCase[] = [');
  const surfacesEnd = source.indexOf('async function probeSurface', surfacesStart);
  const surfacesBlock = surfacesStart >= 0 && surfacesEnd > surfacesStart
    ? source.slice(surfacesStart, surfacesEnd)
    : '';
  const surfaceNames = [...surfacesBlock.matchAll(/^\s+name: '([^']+)',/gm)]
    .map((match) => match[1]!);
  const duplicateSurfaceNames = surfaceNames
    .filter((name, index) => surfaceNames.indexOf(name) !== index)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
  const themeVariantMatch = /for\s*\(\s*const\s+colorScheme\s+of\s+\[([^\]]+)\]\s+as\s+const\s*\)/.exec(source);
  const themeVariantNames = themeVariantMatch
    ? [...themeVariantMatch[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
    : [];
  const duplicateThemeVariantNames = themeVariantNames
    .filter((name, index) => themeVariantNames.indexOf(name) !== index)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();

  return {
    runtimeSurfaceMatrixFound: surfacesBlock.length > 0,
    runtimeSurfaceCases: surfaceNames.length,
    duplicateRuntimeSurfaceNames: duplicateSurfaceNames,
    runtimeThemeVariantsFound: themeVariantNames.length > 0,
    runtimeThemeVariants: themeVariantNames.length,
    runtimeThemeVariantNames: [...themeVariantNames].sort(),
    duplicateRuntimeThemeVariantNames: duplicateThemeVariantNames,
    runtimeSurfaceThemeChecks: surfaceNames.length * themeVariantNames.length,
    runtimeSurfaceNames: [...surfaceNames].sort(),
  };
}

function main() {
  if (
    !existsSync(DESIGN_SYSTEM_KERNEL)
    || !existsSync(DESIGN_SYSTEM_DIR)
    || !existsSync(CALIBRATION_AUDIT)
    || !existsSync(DECISION_AUDIT)
    || !existsSync(RUNTIME_SURFACE_SPEC)
  ) {
    throw new Error('Design-system spec files are missing.');
  }

  const metrics = {
    designSystem: designSystemLineMetrics(),
    docReferences: designSystemDocReferenceMetrics(),
    sourceMap: sourceMapMetrics(),
    calibrationAudit: calibrationAuditMetrics(),
    decisionAudit: decisionAuditMetrics(),
    exceptions: exceptionEvidenceMetrics(),
    components: componentCoverageMetrics(),
    tokens: rawColorMetrics(),
    runtimeSurfaces: runtimeSurfaceMetrics(),
    targets: {
      surfaceTargetLines: SURFACE_TARGET_LINES,
      designSystemDocReferencesMinimumTarget: DESIGN_SYSTEM_DOC_REFERENCES_MIN,
      designSystemDocBrokenReferencesTarget: 0,
      designSystemDocAmbiguousReferencesTarget: 0,
      sourceMapRowsMinimumTarget: 1,
      sourceMapReferencesMinimumTarget: 1,
      sourceMapContractReferencesMinimumTarget: 1,
      malformedSourceMapRowsTarget: 0,
      duplicateSourceMapAreasTarget: 0,
      incompleteSourceMapRowsTarget: 0,
      sourceMapBrokenReferencesTarget: 0,
      sourceMapAmbiguousReferencesTarget: 0,
      calibrationClassificationRowsTarget: calibrationFindingClassNames.length,
      duplicateClassificationModelClassesTarget: 0,
      missingClassificationModelClassesTarget: 0,
      unexpectedClassificationModelClassesTarget: 0,
      incompleteClassificationModelRowsTarget: 0,
      duplicateCalibrationIdsTarget: 0,
      malformedCalibrationRowsTarget: 0,
      malformedOpenDecisionRowsTarget: 0,
      calibrationEvidenceCoverageTarget: CALIBRATION_EVIDENCE_COVERAGE_TARGET,
      missingCalibrationIdsTarget: 0,
      invalidCalibrationClassesTarget: 0,
      calibrationBrokenReferencesTarget: 0,
      duplicateOpenDesignDecisionAreasTarget: 0,
      incompleteOpenDesignDecisionRowsTarget: 0,
      decisionRowMinimumTarget: DECISION_AUDIT_MIN_ROWS,
      decisionDerivationTarget: DECISION_DERIVATION_TARGET,
      decisionEvidenceCoverageTarget: DECISION_EVIDENCE_COVERAGE_TARGET,
      duplicateDecisionIdsTarget: 0,
      malformedDecisionRowsTarget: 0,
      duplicateDecisionTextsTarget: 0,
      incompleteDecisionRowsTarget: 0,
      missingDecisionIdsTarget: 0,
      invalidDecisionResultsTarget: 0,
      unnamedExceptionDecisionsTarget: 0,
      decisionBrokenReferencesTarget: 0,
      componentCoverageTarget: COMPONENT_COVERAGE_TARGET,
      componentSourceReferencesMinimumTarget: COMPONENT_SOURCE_REFERENCES_MIN,
      componentContractReferencesMinimumTarget: 1,
      malformedComponentDocRowsTarget: 0,
      duplicateDocumentedComponentNamesTarget: 0,
      incompleteComponentDocRowsTarget: 0,
      componentSourceBrokenReferencesTarget: 0,
      componentSourceAmbiguousReferencesTarget: 0,
      componentContractBrokenReferencesTarget: 0,
      unmappedDocumentedContractsTarget: 0,
      mappedContractsMissingFromDocsTarget: 0,
      componentImplementationFilesMissingTarget: 0,
      staleNativeControlExceptionsTarget: 0,
      nativeControlExceptionsMissingFromAuditTarget: 0,
      malformedNativeControlRowsTarget: 0,
      duplicateNativeControlAuditFilesTarget: 0,
      nativeControlAuditEntriesMissingFromMetricsTarget: 0,
      nativeControlExceptionReasonMismatchesTarget: 0,
      nativeControlExceptionCountMismatchesTarget: 0,
      exceptionEvidenceCoverageTarget: 1,
      malformedRegistryRowsTarget: 0,
      duplicateRegistryExceptionNamesTarget: 0,
      exceptionBrokenReferencesTarget: 0,
      registryExceptionsMissingFromCalibrationTarget: 0,
      malformedNamedExceptionRowsTarget: 0,
      duplicateNamedExceptionSummaryNamesTarget: 0,
      namedExceptionSummaryBrokenReferencesTarget: 0,
      calibrationExceptionsMissingFromRegistryTarget: 0,
      localCalibrationExceptionEntriesMissingTarget: 0,
      rawHexOutsideTokenDeclarationsTarget: 0,
      rawFunctionalColorOutsideTokenDeclarationsTarget: 0,
      undocumentedRawColorExceptionsTarget: 0,
      staleRawColorExceptionsTarget: 0,
      runtimeSurfaceCasesMinimumTarget: 1,
      duplicateRuntimeSurfaceNamesTarget: 0,
      runtimeThemeVariantNamesTarget: ['light', 'dark'],
      duplicateRuntimeThemeVariantNamesTarget: 0,
    },
  };

  const json = process.argv.includes('--json');
  if (json) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    console.log('design-system metrics');
    console.log(`  surface lines: ${metrics.designSystem.surfaceLines}/${SURFACE_TARGET_LINES}`);
    console.log(`  surface compression: ${(metrics.designSystem.surfaceCompressionRatio * 100).toFixed(1)}%`);
    console.log(`  design-system doc refs: ${metrics.docReferences.designSystemDocReferences}`);
    console.log(`  design-system doc broken refs: ${metrics.docReferences.designSystemDocBrokenReferences.length}`);
    console.log(`  source map rows: ${metrics.sourceMap.sourceMapRows}`);
    console.log(`  source map contract refs: ${metrics.sourceMap.sourceMapContractReferences}`);
    console.log(`  source map incomplete rows: ${metrics.sourceMap.incompleteSourceMapRows.length}`);
    console.log(`  source map broken refs: ${metrics.sourceMap.sourceMapBrokenReferences.length}`);
    console.log(`  calibration class rows: ${metrics.calibrationAudit.calibrationClassificationRows}`);
    console.log(`  incomplete calibration class rows: ${metrics.calibrationAudit.incompleteClassificationModelRows.length}`);
    console.log(`  calibration rows: ${metrics.calibrationAudit.calibrationRows}`);
    console.log(`  malformed calibration rows: ${metrics.calibrationAudit.malformedCalibrationRows.length}`);
    console.log(`  malformed open decision rows: ${metrics.calibrationAudit.malformedOpenDecisionRows.length}`);
    console.log(`  open decision row drift: ${
      metrics.calibrationAudit.duplicateOpenDesignDecisionAreas.length
      + metrics.calibrationAudit.incompleteOpenDesignDecisionRows.length
    }`);
    console.log(`  calibration evidence: ${(metrics.calibrationAudit.calibrationEvidenceCoverage * 100).toFixed(1)}%`);
    console.log(`  calibration broken refs: ${metrics.calibrationAudit.calibrationBrokenReferences.length}`);
    console.log(`  invalid calibration classes: ${metrics.calibrationAudit.invalidCalibrationClasses.length}`);
    console.log(`  decision rows: ${metrics.decisionAudit.decisionRows}/${DECISION_AUDIT_MIN_ROWS}`);
    console.log(`  malformed decision rows: ${metrics.decisionAudit.malformedDecisionRows.length}`);
    console.log(`  decision row drift: ${
      metrics.decisionAudit.duplicateDecisionTexts.length
      + metrics.decisionAudit.incompleteDecisionRows.length
    }`);
    console.log(`  decision derivation: ${(metrics.decisionAudit.decisionDerivationCoverage * 100).toFixed(1)}%`);
    console.log(`  decision evidence: ${(metrics.decisionAudit.decisionEvidenceCoverage * 100).toFixed(1)}%`);
    console.log(`  decision broken refs: ${metrics.decisionAudit.decisionBrokenReferences.length}`);
    console.log(`  invalid decision results: ${metrics.decisionAudit.invalidDecisionResults.length}`);
    console.log(`  unnamed exception decisions: ${metrics.decisionAudit.unnamedExceptionDecisions.length}`);
    console.log(`  component coverage: ${(metrics.components.componentCoverage * 100).toFixed(1)}%`);
    console.log(`  component source refs: ${metrics.components.componentSourceReferences}`);
    console.log(`  component contract refs: ${metrics.components.componentContractReferences}`);
    console.log(`  component doc drift: ${
      metrics.components.malformedComponentDocRows.length
      + metrics.components.duplicateDocumentedComponentNames.length
      + metrics.components.incompleteComponentDocRows.length
    }`);
    console.log(`  native control exceptions: ${metrics.components.exceptedNativeUses}`);
    console.log(`  native control audit drift: ${
      metrics.components.nativeControlExceptionsMissingFromAudit.length
      + metrics.components.nativeControlAuditEntriesMissingFromMetrics.length
      + metrics.components.nativeControlExceptionReasonMismatches.length
      + metrics.components.nativeControlExceptionCountMismatches.length
      + metrics.components.malformedNativeControlRows.length
      + metrics.components.duplicateNativeControlAuditFiles.length
    }`);
    console.log(`  component implementation native: ${metrics.components.componentImplementationNativeUses}`);
    console.log(`  exception evidence: ${(metrics.exceptions.exceptionEvidenceCoverage * 100).toFixed(1)}%`);
    console.log(`  malformed exception registry rows: ${metrics.exceptions.malformedRegistryRows.length}`);
    console.log(`  duplicate exception names: ${
      metrics.exceptions.duplicateRegistryExceptionNames.length
      + metrics.exceptions.duplicateNamedExceptionSummaryNames.length
    }`);
    console.log(`  exception broken refs: ${metrics.exceptions.exceptionBrokenReferences.length}`);
    console.log(`  named exception summary drift: ${
      metrics.exceptions.registryExceptionsMissingFromCalibration.length
      + metrics.exceptions.calibrationExceptionsMissingFromRegistry.length
      + metrics.exceptions.localCalibrationExceptionEntriesMissing.length
      + metrics.exceptions.namedExceptionSummaryBrokenReferences.length
      + metrics.exceptions.malformedNamedExceptionRows.length
    }`);
    console.log(`  raw hex outside tokens: ${metrics.tokens.rawHexOutsideTokenDeclarations}`);
    console.log(`  raw functional colors outside tokens: ${metrics.tokens.rawFunctionalColorOutsideTokenDeclarations}`);
    console.log(`  named raw colour exceptions: ${metrics.tokens.rawColorExceptionUses.length}`);
    console.log(`  stale raw colour exceptions: ${metrics.tokens.staleRawColorExceptions.length}`);
    console.log(`  runtime surface cases: ${metrics.runtimeSurfaces.runtimeSurfaceCases}`);
    console.log(`  runtime theme checks: ${metrics.runtimeSurfaces.runtimeSurfaceThemeChecks}`);
  }

  if (process.argv.includes('--check')) {
    const failures: string[] = [];
    if (metrics.designSystem.surfaceLines > SURFACE_TARGET_LINES) {
      failures.push(`surface lines ${metrics.designSystem.surfaceLines} > ${SURFACE_TARGET_LINES}`);
    }
    if (metrics.docReferences.designSystemDocReferences < DESIGN_SYSTEM_DOC_REFERENCES_MIN) {
      failures.push(
        `design-system doc references ${metrics.docReferences.designSystemDocReferences} < ${DESIGN_SYSTEM_DOC_REFERENCES_MIN}`,
      );
    }
    if (metrics.docReferences.designSystemDocBrokenReferences.length > 0) {
      failures.push(`design-system doc broken refs: ${metrics.docReferences.designSystemDocBrokenReferences.join(', ')}`);
    }
    if (metrics.docReferences.designSystemDocAmbiguousReferences.length > 0) {
      failures.push(`design-system doc ambiguous refs: ${metrics.docReferences.designSystemDocAmbiguousReferences.join(', ')}`);
    }
    if (
      metrics.sourceMap.sourceMapRows === 0
      || metrics.sourceMap.sourceMapReferences === 0
      || metrics.sourceMap.sourceMapContractReferences === 0
    ) {
      failures.push('source map missing or empty');
    }
    if (metrics.sourceMap.malformedSourceMapRows.length > 0) {
      failures.push(`malformed source map rows: ${metrics.sourceMap.malformedSourceMapRows.join(', ')}`);
    }
    if (metrics.sourceMap.duplicateSourceMapAreas.length > 0) {
      failures.push(`duplicate source map areas: ${metrics.sourceMap.duplicateSourceMapAreas.join(', ')}`);
    }
    if (metrics.sourceMap.incompleteSourceMapRows.length > 0) {
      failures.push(`incomplete source map rows: ${metrics.sourceMap.incompleteSourceMapRows.join(', ')}`);
    }
    if (metrics.sourceMap.sourceMapBrokenReferences.length > 0) {
      failures.push(`source map broken refs: ${metrics.sourceMap.sourceMapBrokenReferences.join(', ')}`);
    }
    if (metrics.sourceMap.sourceMapAmbiguousReferences.length > 0) {
      failures.push(`source map ambiguous refs: ${metrics.sourceMap.sourceMapAmbiguousReferences.join(', ')}`);
    }
    if (metrics.calibrationAudit.duplicateClassificationModelClasses.length > 0) {
      failures.push(`duplicate calibration classification model classes: ${metrics.calibrationAudit.duplicateClassificationModelClasses.join(', ')}`);
    }
    if (metrics.calibrationAudit.missingClassificationModelClasses.length > 0) {
      failures.push(`missing calibration classification model classes: ${metrics.calibrationAudit.missingClassificationModelClasses.join(', ')}`);
    }
    if (metrics.calibrationAudit.unexpectedClassificationModelClasses.length > 0) {
      failures.push(`unexpected calibration classification model classes: ${metrics.calibrationAudit.unexpectedClassificationModelClasses.join(', ')}`);
    }
    if (metrics.calibrationAudit.incompleteClassificationModelRows.length > 0) {
      failures.push(`incomplete calibration classification model rows: ${metrics.calibrationAudit.incompleteClassificationModelRows.join(', ')}`);
    }
    if (metrics.calibrationAudit.duplicateCalibrationIds.length > 0) {
      failures.push(`duplicate calibration ids: ${metrics.calibrationAudit.duplicateCalibrationIds.join(', ')}`);
    }
    if (metrics.calibrationAudit.malformedCalibrationRows.length > 0) {
      failures.push(`malformed calibration rows: ${metrics.calibrationAudit.malformedCalibrationRows.join(', ')}`);
    }
    if (metrics.calibrationAudit.malformedOpenDecisionRows.length > 0) {
      failures.push(`malformed open design decision rows: ${metrics.calibrationAudit.malformedOpenDecisionRows.join(', ')}`);
    }
    if (metrics.calibrationAudit.duplicateOpenDesignDecisionAreas.length > 0) {
      failures.push(`duplicate open design decision areas: ${metrics.calibrationAudit.duplicateOpenDesignDecisionAreas.join(', ')}`);
    }
    if (metrics.calibrationAudit.incompleteOpenDesignDecisionRows.length > 0) {
      failures.push(`incomplete open design decision rows: ${metrics.calibrationAudit.incompleteOpenDesignDecisionRows.join(', ')}`);
    }
    if (metrics.calibrationAudit.missingCalibrationIds.length > 0) {
      failures.push(`missing calibration ids: ${metrics.calibrationAudit.missingCalibrationIds.join(', ')}`);
    }
    if (metrics.calibrationAudit.invalidCalibrationClasses.length > 0) {
      failures.push(`invalid calibration classes: ${metrics.calibrationAudit.invalidCalibrationClasses.join(', ')}`);
    }
    if (metrics.calibrationAudit.calibrationEvidenceCoverage < CALIBRATION_EVIDENCE_COVERAGE_TARGET) {
      failures.push(
        `calibration evidence ${metrics.calibrationAudit.calibrationEvidenceCoverage} < ${CALIBRATION_EVIDENCE_COVERAGE_TARGET}`,
      );
    }
    if (metrics.calibrationAudit.calibrationBrokenReferences.length > 0) {
      failures.push(`calibration evidence broken refs: ${metrics.calibrationAudit.calibrationBrokenReferences.join(', ')}`);
    }
    if (metrics.decisionAudit.decisionDerivationCoverage < DECISION_DERIVATION_TARGET) {
      failures.push(
        `decision derivation ${metrics.decisionAudit.decisionDerivationCoverage} < ${DECISION_DERIVATION_TARGET}`,
      );
    }
    if (metrics.decisionAudit.decisionRows < DECISION_AUDIT_MIN_ROWS) {
      failures.push(`decision rows ${metrics.decisionAudit.decisionRows} < ${DECISION_AUDIT_MIN_ROWS}`);
    }
    if (metrics.decisionAudit.duplicateDecisionIds.length > 0) {
      failures.push(`duplicate decision ids: ${metrics.decisionAudit.duplicateDecisionIds.join(', ')}`);
    }
    if (metrics.decisionAudit.malformedDecisionRows.length > 0) {
      failures.push(`malformed decision rows: ${metrics.decisionAudit.malformedDecisionRows.join(', ')}`);
    }
    if (metrics.decisionAudit.duplicateDecisionTexts.length > 0) {
      failures.push(`duplicate decision texts: ${metrics.decisionAudit.duplicateDecisionTexts.join(', ')}`);
    }
    if (metrics.decisionAudit.incompleteDecisionRows.length > 0) {
      failures.push(`incomplete decision rows: ${metrics.decisionAudit.incompleteDecisionRows.join(', ')}`);
    }
    if (metrics.decisionAudit.missingDecisionIds.length > 0) {
      failures.push(`missing decision ids: ${metrics.decisionAudit.missingDecisionIds.join(', ')}`);
    }
    if (metrics.decisionAudit.invalidDecisionResults.length > 0) {
      failures.push(`invalid decision results: ${metrics.decisionAudit.invalidDecisionResults.join(', ')}`);
    }
    if (metrics.decisionAudit.unnamedExceptionDecisions.length > 0) {
      failures.push(`unnamed exception decisions: ${metrics.decisionAudit.unnamedExceptionDecisions.join(', ')}`);
    }
    if (metrics.decisionAudit.decisionEvidenceCoverage < DECISION_EVIDENCE_COVERAGE_TARGET) {
      failures.push(
        `decision evidence ${metrics.decisionAudit.decisionEvidenceCoverage} < ${DECISION_EVIDENCE_COVERAGE_TARGET}`,
      );
    }
    if (metrics.decisionAudit.decisionBrokenReferences.length > 0) {
      failures.push(`decision evidence broken refs: ${metrics.decisionAudit.decisionBrokenReferences.join(', ')}`);
    }
    if (metrics.components.componentCoverage < COMPONENT_COVERAGE_TARGET) {
      failures.push(`component coverage ${metrics.components.componentCoverage} < ${COMPONENT_COVERAGE_TARGET}`);
    }
    if (metrics.components.componentSourceReferences < COMPONENT_SOURCE_REFERENCES_MIN) {
      failures.push(
        `component source references ${metrics.components.componentSourceReferences} < ${COMPONENT_SOURCE_REFERENCES_MIN}`,
      );
    }
    if (metrics.components.componentContractReferences === 0) {
      failures.push('component contract references missing');
    }
    if (metrics.components.malformedComponentDocRows.length > 0) {
      failures.push(`malformed component doc rows: ${metrics.components.malformedComponentDocRows.join(', ')}`);
    }
    if (metrics.components.duplicateDocumentedComponentNames.length > 0) {
      failures.push(`duplicate documented component names: ${metrics.components.duplicateDocumentedComponentNames.join(', ')}`);
    }
    if (metrics.components.incompleteComponentDocRows.length > 0) {
      failures.push(`incomplete component doc rows: ${metrics.components.incompleteComponentDocRows.join(', ')}`);
    }
    if (metrics.components.componentSourceBrokenReferences.length > 0) {
      failures.push(`component source broken refs: ${metrics.components.componentSourceBrokenReferences.join(', ')}`);
    }
    if (metrics.components.componentSourceAmbiguousReferences.length > 0) {
      failures.push(`component source ambiguous refs: ${metrics.components.componentSourceAmbiguousReferences.join(', ')}`);
    }
    if (metrics.components.componentContractBrokenReferences.length > 0) {
      failures.push(`component contract broken refs: ${metrics.components.componentContractBrokenReferences.join(', ')}`);
    }
    if (metrics.components.unmappedDocumentedContracts.length > 0) {
      failures.push(`documented component contracts missing from metrics: ${metrics.components.unmappedDocumentedContracts.join(', ')}`);
    }
    if (metrics.components.mappedContractsMissingFromDocs.length > 0) {
      failures.push(`component metric contracts missing from docs: ${metrics.components.mappedContractsMissingFromDocs.join(', ')}`);
    }
    if (metrics.components.componentImplementationFilesMissing.length > 0) {
      failures.push(`component implementation files missing: ${metrics.components.componentImplementationFilesMissing.join(', ')}`);
    }
    if (metrics.components.staleNativeControlExceptions.length > 0) {
      failures.push(`stale native control exceptions: ${metrics.components.staleNativeControlExceptions.join(', ')}`);
    }
    if (metrics.components.nativeControlExceptionsMissingFromAudit.length > 0) {
      failures.push(`native control exceptions missing from audit: ${metrics.components.nativeControlExceptionsMissingFromAudit.join(', ')}`);
    }
    if (metrics.components.malformedNativeControlRows.length > 0) {
      failures.push(`malformed native control exception rows: ${metrics.components.malformedNativeControlRows.join(', ')}`);
    }
    if (metrics.components.duplicateNativeControlAuditFiles.length > 0) {
      failures.push(`duplicate native control audit files: ${metrics.components.duplicateNativeControlAuditFiles.join(', ')}`);
    }
    if (metrics.components.nativeControlAuditEntriesMissingFromMetrics.length > 0) {
      failures.push(`native control audit entries missing from metrics: ${metrics.components.nativeControlAuditEntriesMissingFromMetrics.join(', ')}`);
    }
    if (metrics.components.nativeControlExceptionReasonMismatches.length > 0) {
      failures.push(`native control exception reason mismatches: ${metrics.components.nativeControlExceptionReasonMismatches.join(', ')}`);
    }
    if (metrics.components.nativeControlExceptionCountMismatches.length > 0) {
      failures.push(`native control exception count mismatches: ${metrics.components.nativeControlExceptionCountMismatches.join(', ')}`);
    }
    if (metrics.exceptions.exceptionEvidenceCoverage < 1) {
      failures.push(`exception evidence ${metrics.exceptions.exceptionEvidenceCoverage} < 1`);
    }
    if (metrics.exceptions.malformedRegistryRows.length > 0) {
      failures.push(`malformed exception registry rows: ${metrics.exceptions.malformedRegistryRows.join(', ')}`);
    }
    if (metrics.exceptions.duplicateRegistryExceptionNames.length > 0) {
      failures.push(`duplicate registry exception names: ${metrics.exceptions.duplicateRegistryExceptionNames.join(', ')}`);
    }
    if (metrics.exceptions.exceptionBrokenReferences.length > 0) {
      failures.push(`exception evidence broken refs: ${metrics.exceptions.exceptionBrokenReferences.join(', ')}`);
    }
    if (metrics.exceptions.registryExceptionsMissingFromCalibration.length > 0) {
      failures.push(`registry exceptions missing from calibration: ${metrics.exceptions.registryExceptionsMissingFromCalibration.join(', ')}`);
    }
    if (metrics.exceptions.malformedNamedExceptionRows.length > 0) {
      failures.push(`malformed named exception rows: ${metrics.exceptions.malformedNamedExceptionRows.join(', ')}`);
    }
    if (metrics.exceptions.duplicateNamedExceptionSummaryNames.length > 0) {
      failures.push(`duplicate named exception summary names: ${metrics.exceptions.duplicateNamedExceptionSummaryNames.join(', ')}`);
    }
    if (metrics.exceptions.namedExceptionSummaryBrokenReferences.length > 0) {
      failures.push(`named exception summary broken refs: ${metrics.exceptions.namedExceptionSummaryBrokenReferences.join(', ')}`);
    }
    if (metrics.exceptions.calibrationExceptionsMissingFromRegistry.length > 0) {
      failures.push(`calibration exceptions missing from registry: ${metrics.exceptions.calibrationExceptionsMissingFromRegistry.join(', ')}`);
    }
    if (metrics.exceptions.localCalibrationExceptionEntriesMissing.length > 0) {
      failures.push(`local calibration exceptions missing: ${metrics.exceptions.localCalibrationExceptionEntriesMissing.join(', ')}`);
    }
    if (metrics.tokens.rawHexOutsideTokenDeclarations !== 0) {
      failures.push(`raw hex outside tokens ${metrics.tokens.rawHexOutsideTokenDeclarations} !== 0`);
    }
    if (metrics.tokens.rawFunctionalColorOutsideTokenDeclarations !== 0) {
      failures.push(`raw functional colors outside tokens ${metrics.tokens.rawFunctionalColorOutsideTokenDeclarations} !== 0`);
    }
    if (metrics.tokens.undocumentedRawColorExceptions.length > 0) {
      failures.push(`undocumented raw colour exceptions: ${metrics.tokens.undocumentedRawColorExceptions.join(', ')}`);
    }
    if (metrics.tokens.staleRawColorExceptions.length > 0) {
      failures.push(`stale raw colour exceptions: ${metrics.tokens.staleRawColorExceptions.join(', ')}`);
    }
    if (!metrics.runtimeSurfaces.runtimeSurfaceMatrixFound || metrics.runtimeSurfaces.runtimeSurfaceCases === 0) {
      failures.push('runtime surface matrix missing or empty');
    }
    if (metrics.runtimeSurfaces.duplicateRuntimeSurfaceNames.length > 0) {
      failures.push(`duplicate runtime surface names: ${metrics.runtimeSurfaces.duplicateRuntimeSurfaceNames.join(', ')}`);
    }
    if (
      !metrics.runtimeSurfaces.runtimeThemeVariantsFound
      || !metrics.runtimeSurfaces.runtimeThemeVariantNames.includes('light')
      || !metrics.runtimeSurfaces.runtimeThemeVariantNames.includes('dark')
    ) {
      failures.push(`runtime theme variants missing light/dark: ${metrics.runtimeSurfaces.runtimeThemeVariantNames.join(', ') || 'none'}`);
    }
    if (metrics.runtimeSurfaces.duplicateRuntimeThemeVariantNames.length > 0) {
      failures.push(`duplicate runtime theme variants: ${metrics.runtimeSurfaces.duplicateRuntimeThemeVariantNames.join(', ')}`);
    }
    if (failures.length > 0) {
      console.error(`design-system metrics FAILED:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
  }
}

main();
