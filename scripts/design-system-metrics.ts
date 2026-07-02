#!/usr/bin/env bun
/**
 * Measures whether the design-system contract is becoming a small set of
 * reusable rules instead of a pile of page-specific descriptions.
 *
 * This is a reporting tool by default. Use `--check` once the thresholds are
 * ratified as hard gates.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DESIGN_SYSTEM_DIR = join(ROOT, 'docs', 'spec', 'design-system');
const DESIGN_SYSTEM_KERNEL = join(ROOT, 'docs', 'spec', 'design-system.md');
const DECISION_AUDIT = join(DESIGN_SYSTEM_DIR, 'decision-audit.md');
const STYLES_DIR = join(ROOT, 'src', 'renderer', 'styles');
const UI_DIR = join(ROOT, 'src', 'renderer', 'ui');

const SURFACE_BASELINE_LINES = 672;
const SURFACE_TARGET_LINES = Math.floor(SURFACE_BASELINE_LINES * 0.6);
const COMPONENT_COVERAGE_TARGET = 0.8;
const DECISION_DERIVATION_TARGET = 0.8;

const primitives = [
  'Button',
  'ButtonControl',
  'IconButton',
  'CheckboxControl',
  'CheckboxMark',
  'SwitchControl',
  'SwitchMark',
  'SegmentedControl',
  'Input',
  'Textarea',
  'Field',
  'SelectControl',
  'FeedbackState',
  'MenuSurface',
  'MenuItem',
  'Dialog',
  'AnchoredActionMenu',
  'PopoverList',
  'ResizeHandle',
];

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

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
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

function exceptionEvidenceMetrics() {
  const kernel = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const start = kernel.indexOf('## Exception Registry');
  const end = kernel.indexOf('## Foundations', start);
  const section = start >= 0 && end > start ? kernel.slice(start, end) : '';
  const rows = [...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Exception' && !match[1]?.startsWith('---'));
  const evidenceRows = rows.filter((match) => /\[[^\]]+\]\([^)]+\)|`[^`]+`/.test(match[4] ?? ''));
  return {
    exceptionRows: rows.length,
    exceptionEvidenceRows: evidenceRows.length,
    exceptionEvidenceCoverage: rows.length === 0 ? 1 : Number((evidenceRows.length / rows.length).toFixed(3)),
  };
}

function decisionAuditMetrics() {
  const source = readFileSync(DECISION_AUDIT, 'utf8');
  const rows = [...source.matchAll(/^\| (D\d{2}) \| (.+?) \| (.+?) \| (.+?) \| (Derived|Exception) \|$/gm)];
  const derivedRows = rows.filter((match) => match[5] === 'Derived');
  const exceptionRows = rows.filter((match) => match[5] === 'Exception');
  return {
    decisionRows: rows.length,
    derivedDecisionRows: derivedRows.length,
    exceptionDecisionRows: exceptionRows.length,
    decisionDerivationCoverage: rows.length === 0 ? 0 : Number((derivedRows.length / rows.length).toFixed(3)),
  };
}

function componentCoverageMetrics() {
  const files = sourceFiles(UI_DIR);
  let primitiveUses = 0;
  let nativeUses = 0;
  let exceptedNativeUses = 0;
  const directNativeFiles = new Map<string, number>();

  for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    for (const primitive of primitives) {
      primitiveUses += countMatches(text, new RegExp(`<${primitive}(\\s|>|\\.)`, 'g'));
    }
    if (rel.startsWith('src/renderer/ui/primitives/')) continue;

    const directNativeCount = ['button', 'input', 'textarea', 'select'].reduce(
      (sum, tag) => sum + countMatches(text, new RegExp(`<${tag}(\\s|>)`, 'g')),
      0,
    );
    if (directNativeCount === 0) continue;
    if (nativeControlExceptions[rel]) {
      exceptedNativeUses += directNativeCount;
    } else {
      nativeUses += directNativeCount;
      directNativeFiles.set(rel, directNativeCount);
    }
  }

  const accountableControls = primitiveUses + nativeUses;
  return {
    primitiveUses,
    directNativeUses: nativeUses,
    exceptedNativeUses,
    componentCoverage: accountableControls === 0 ? 1 : Number((primitiveUses / accountableControls).toFixed(3)),
    directNativeFiles: Object.fromEntries([...directNativeFiles.entries()].sort()),
  };
}

function rawHexMetrics() {
  const cssFiles = readdirSync(STYLES_DIR)
    .filter((file) => file.endsWith('.css'))
    .map((file) => join(STYLES_DIR, file));
  const violations: string[] = [];
  for (const file of cssFiles) {
    const text = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    text.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) return;
      if (!/#(?:[0-9a-fA-F]{3,8})\b/.test(line)) return;
      violations.push(`${relative(ROOT, file)}:${index + 1} ${trimmed}`);
    });
  }
  return {
    rawHexOutsideTokenDeclarations: violations.length,
    rawHexViolations: violations,
  };
}

function main() {
  if (!existsSync(DESIGN_SYSTEM_KERNEL) || !existsSync(DESIGN_SYSTEM_DIR) || !existsSync(DECISION_AUDIT)) {
    throw new Error('Design-system spec files are missing.');
  }

  const metrics = {
    designSystem: designSystemLineMetrics(),
    decisionAudit: decisionAuditMetrics(),
    exceptions: exceptionEvidenceMetrics(),
    components: componentCoverageMetrics(),
    tokens: rawHexMetrics(),
    targets: {
      surfaceTargetLines: SURFACE_TARGET_LINES,
      decisionDerivationTarget: DECISION_DERIVATION_TARGET,
      componentCoverageTarget: COMPONENT_COVERAGE_TARGET,
      exceptionEvidenceCoverageTarget: 1,
      rawHexOutsideTokenDeclarationsTarget: 0,
    },
  };

  const json = process.argv.includes('--json');
  if (json) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    console.log('design-system metrics');
    console.log(`  surface lines: ${metrics.designSystem.surfaceLines}/${SURFACE_TARGET_LINES}`);
    console.log(`  surface compression: ${(metrics.designSystem.surfaceCompressionRatio * 100).toFixed(1)}%`);
    console.log(`  decision derivation: ${(metrics.decisionAudit.decisionDerivationCoverage * 100).toFixed(1)}%`);
    console.log(`  component coverage: ${(metrics.components.componentCoverage * 100).toFixed(1)}%`);
    console.log(`  exception evidence: ${(metrics.exceptions.exceptionEvidenceCoverage * 100).toFixed(1)}%`);
    console.log(`  raw hex outside tokens: ${metrics.tokens.rawHexOutsideTokenDeclarations}`);
  }

  if (process.argv.includes('--check')) {
    const failures: string[] = [];
    if (metrics.designSystem.surfaceLines > SURFACE_TARGET_LINES) {
      failures.push(`surface lines ${metrics.designSystem.surfaceLines} > ${SURFACE_TARGET_LINES}`);
    }
    if (metrics.decisionAudit.decisionDerivationCoverage < DECISION_DERIVATION_TARGET) {
      failures.push(
        `decision derivation ${metrics.decisionAudit.decisionDerivationCoverage} < ${DECISION_DERIVATION_TARGET}`,
      );
    }
    if (metrics.components.componentCoverage < COMPONENT_COVERAGE_TARGET) {
      failures.push(`component coverage ${metrics.components.componentCoverage} < ${COMPONENT_COVERAGE_TARGET}`);
    }
    if (metrics.exceptions.exceptionEvidenceCoverage < 1) {
      failures.push(`exception evidence ${metrics.exceptions.exceptionEvidenceCoverage} < 1`);
    }
    if (metrics.tokens.rawHexOutsideTokenDeclarations !== 0) {
      failures.push(`raw hex outside tokens ${metrics.tokens.rawHexOutsideTokenDeclarations} !== 0`);
    }
    if (failures.length > 0) {
      console.error(`design-system metrics FAILED:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
  }
}

main();
