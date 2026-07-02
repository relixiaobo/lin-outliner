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
import * as ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const DESIGN_SYSTEM_DIR = join(ROOT, 'docs', 'spec', 'design-system');
const DESIGN_SYSTEM_KERNEL = join(ROOT, 'docs', 'spec', 'design-system.md');
const COMPONENTS_DOC = join(DESIGN_SYSTEM_DIR, 'components.md');
const DECISION_AUDIT = join(DESIGN_SYSTEM_DIR, 'decision-audit.md');
const RENDERER_DIR = join(ROOT, 'src', 'renderer');
const UI_DIR = join(ROOT, 'src', 'renderer', 'ui');

const SURFACE_BASELINE_LINES = 672;
const SURFACE_TARGET_LINES = Math.floor(SURFACE_BASELINE_LINES * 0.6);
const COMPONENT_COVERAGE_TARGET = 0.8;
const DECISION_DERIVATION_TARGET = 0.8;
const RAW_HEX_PATTERN = /#(?:[0-9a-fA-F]{3,8})\b/g;

const componentContracts = [
  { docNames: ['CheckboxMark'], jsxTags: ['CheckboxMark'] },
  { docNames: ['CheckboxControl'], jsxTags: ['CheckboxControl'] },
  { docNames: ['SwitchControl', 'SwitchMark'], jsxTags: ['SwitchControl', 'SwitchMark'] },
  { docNames: ['IconButton'], jsxTags: ['IconButton'] },
  { docNames: ['MenuSurface'], jsxTags: ['MenuSurface'] },
  { docNames: ['MenuItem'], jsxTags: ['MenuItem'] },
  { docNames: ['useAnchoredOverlay', 'AnchoredActionMenu'], jsxTags: ['AnchoredActionMenu'] },
  {
    docNames: ['PopoverListbox', 'PopoverListItem', 'PopoverEmpty'],
    jsxTags: ['PopoverListbox', 'PopoverListItem', 'PopoverEmpty'],
  },
  { docNames: ['Dialog', 'ConfirmDialog'], jsxTags: ['Dialog', 'ConfirmDialog'] },
  { docNames: ['Button'], jsxTags: ['Button'] },
  { docNames: ['ButtonControl'], jsxTags: ['ButtonControl'] },
  { docNames: ['Input', 'Textarea', 'Field'], jsxTags: ['Input', 'Textarea', 'Field'] },
  { docNames: ['SelectControl'], jsxTags: ['SelectControl'] },
  { docNames: ['FeedbackState', 'EmptyState', 'ErrorState'], jsxTags: ['EmptyState', 'ErrorState'] },
  { docNames: ['TextInputControl', 'NumberInputControl'], jsxTags: ['TextInputControl', 'NumberInputControl'] },
  { docNames: ['PanelSurface', 'WorkspacePanelSurface'], jsxTags: ['WorkspacePanelSurface'] },
  { docNames: ['ResizeHandle'], jsxTags: ['ResizeHandle'] },
  { docNames: ['AppliedTag'], jsxTags: ['AppliedTag'] },
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

const rawHexExceptions: Record<string, { name: string; reason: string }> = {
  'src/renderer/ui/agent/AgentComposer.tsx:#ffffff': {
    name: 'Model-upload JPEG alpha matting may force a white canvas.',
    reason: 'Transparent image pixels are composited against white before JPEG encoding for model upload.',
  },
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

function filesByPattern(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesByPattern(path, pattern);
    return entry.isFile() && pattern.test(entry.name) ? [path] : [];
  }).sort();
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

function documentedComponentNames(): Set<string> {
  const source = readFileSync(COMPONENTS_DOC, 'utf8');
  const start = source.indexOf('| Component | Sources | Contract |');
  const end = source.indexOf('## Contract Shape', start);
  const section = start >= 0 && end > start ? source.slice(start, end) : '';
  const names = new Set<string>();
  for (const match of section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \|$/gm)) {
    if (match[1] === 'Component' || match[1]?.startsWith('---')) continue;
    for (const name of match[1].matchAll(/`([^`]+)`/g)) {
      names.add(name[1]);
    }
  }
  return names;
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
  const componentTags = new Set(componentContracts.flatMap((contract) => contract.jsxTags));
  const documentedNames = documentedComponentNames();
  const mappedDocNames = new Set(componentContracts.flatMap((contract) => contract.docNames));
  const unmappedDocumentedContracts = [...documentedNames].filter((name) => !mappedDocNames.has(name)).sort();
  const mappedContractsMissingFromDocs = [...mappedDocNames].filter((name) => !documentedNames.has(name)).sort();
  let primitiveUses = 0;
  let nativeUses = 0;
  let exceptedNativeUses = 0;
  const directNativeFiles = new Map<string, number>();
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

    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sourceFile);
        const baseTagName = tagName.split('.')[0];
        if (componentTags.has(tagName) || componentTags.has(baseTagName)) {
          primitiveUses += 1;
        }
        if (!rel.startsWith('src/renderer/ui/primitives/') && nativeTags.has(tagName)) {
          directNativeCount += 1;
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
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
    componentContractRows: componentContracts.length,
    componentTagNames: [...componentTags].sort(),
    directNativeFiles: Object.fromEntries([...directNativeFiles.entries()].sort()),
    mappedContractsMissingFromDocs,
    unmappedDocumentedContracts,
  };
}

function rawHexMetrics() {
  const files = filesByPattern(RENDERER_DIR, /\.(css|ts|tsx)$/);
  const violations: string[] = [];
  const exceptionUses: string[] = [];
  const kernel = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const undocumentedExceptions = Object.values(rawHexExceptions)
    .filter((exception) => !kernel.includes(`| ${exception.name} |`))
    .map((exception) => exception.name);

  function recordMatch(file: string, lineNumber: number, lineText: string, value: string) {
    const rel = relative(ROOT, file);
    const exception = rawHexExceptions[`${rel}:${value.toLowerCase()}`];
    const finding = `${rel}:${lineNumber} ${value} ${lineText.trim()}`;
    if (exception) {
      exceptionUses.push(`${finding} (${exception.name})`);
    } else {
      violations.push(finding);
    }
  }

  function scanCss(file: string, text: string) {
    const uncommented = text.replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    const originalLines = text.split('\n');
    uncommented.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) return;
      for (const match of line.matchAll(RAW_HEX_PATTERN)) {
        recordMatch(file, index + 1, originalLines[index] ?? line, match[0]);
      }
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
        recordMatch(file, line + 1, lines[line] ?? value, match[0]);
      }
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
    rawHexOutsideTokenDeclarations: violations.length,
    rawHexViolations: violations,
    rawHexExceptionUses: exceptionUses,
    undocumentedRawHexExceptions: undocumentedExceptions,
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
    console.log(`  named raw hex exceptions: ${metrics.tokens.rawHexExceptionUses.length}`);
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
    if (metrics.components.unmappedDocumentedContracts.length > 0) {
      failures.push(`documented component contracts missing from metrics: ${metrics.components.unmappedDocumentedContracts.join(', ')}`);
    }
    if (metrics.components.mappedContractsMissingFromDocs.length > 0) {
      failures.push(`component metric contracts missing from docs: ${metrics.components.mappedContractsMissingFromDocs.join(', ')}`);
    }
    if (metrics.exceptions.exceptionEvidenceCoverage < 1) {
      failures.push(`exception evidence ${metrics.exceptions.exceptionEvidenceCoverage} < 1`);
    }
    if (metrics.tokens.rawHexOutsideTokenDeclarations !== 0) {
      failures.push(`raw hex outside tokens ${metrics.tokens.rawHexOutsideTokenDeclarations} !== 0`);
    }
    if (metrics.tokens.undocumentedRawHexExceptions.length > 0) {
      failures.push(`undocumented raw hex exceptions: ${metrics.tokens.undocumentedRawHexExceptions.join(', ')}`);
    }
    if (failures.length > 0) {
      console.error(`design-system metrics FAILED:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
  }
}

main();
