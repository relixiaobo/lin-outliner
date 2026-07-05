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
const DECISION_AUDIT = join(DESIGN_SYSTEM_DIR, 'decision-audit.md');
const RENDERER_DIR = join(ROOT, 'src', 'renderer');
const RUNTIME_SURFACE_SPEC = join(ROOT, 'tests', 'e2e', 'design-system-runtime.spec.ts');

const SURFACE_BASELINE_LINES = 672;
const SURFACE_TARGET_LINES = Math.floor(SURFACE_BASELINE_LINES * 0.6);
const COMPONENT_COVERAGE_TARGET = 0.8;
const DECISION_DERIVATION_TARGET = 0.8;
const RUNTIME_THEME_VARIANTS = 2;
const RAW_HEX_PATTERN = /#(?:[0-9a-fA-F]{3,8})\b/g;
const RAW_FUNCTIONAL_COLOR_START_PATTERN = /\b(?:rgba?|hsla?)\s*\(/gi;
const rawColorTokenDeclarationFiles = new Set([
  'src/renderer/styles/a11y.css',
  'src/renderer/styles/theme-dark.css',
  'src/renderer/styles/tokens.css',
]);

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

const rawColorExceptions: Record<string, { name: string; reason: string }> = {
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

function markdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

function localMarkdownTargetExists(sourceFile: string, target: string): boolean {
  if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return true;
  const path = target.split('#')[0]?.trim();
  if (!path) return true;
  return existsSync(join(dirname(sourceFile), path));
}

function evidenceCodePathReferences(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((value) => {
      if (!value || value.startsWith('--') || value.includes(' ')) return false;
      return /^(docs|scripts|src|tests)\//.test(value) || /\.(?:css|md|ts|tsx)$/.test(value);
    });
}

function exceptionEvidenceMetrics() {
  const kernel = readFileSync(DESIGN_SYSTEM_KERNEL, 'utf8');
  const start = kernel.indexOf('## Exception Registry');
  const end = kernel.indexOf('## Foundations', start);
  const section = start >= 0 && end > start ? kernel.slice(start, end) : '';
  const rows = [...section.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .filter((match) => match[1] !== 'Exception' && !match[1]?.startsWith('---'));
  const evidenceRows = rows.filter((match) => /\[[^\]]+\]\([^)]+\)|`[^`]+`/.test(match[4] ?? ''));
  const brokenReferences = new Set<string>();
  for (const match of rows) {
    const name = match[1] ?? 'unknown exception';
    for (const target of markdownLinkTargets(`${match[3] ?? ''} ${match[4] ?? ''}`)) {
      if (!localMarkdownTargetExists(DESIGN_SYSTEM_KERNEL, target)) {
        brokenReferences.add(`${name}: ${target}`);
      }
    }
    for (const reference of evidenceCodePathReferences(match[4] ?? '')) {
      if (!existsSync(join(ROOT, reference))) {
        brokenReferences.add(`${name}: ${reference}`);
      }
    }
  }
  return {
    exceptionRows: rows.length,
    exceptionEvidenceRows: evidenceRows.length,
    exceptionEvidenceCoverage: rows.length === 0 ? 1 : Number((evidenceRows.length / rows.length).toFixed(3)),
    exceptionBrokenReferences: [...brokenReferences].sort(),
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
  const accountableControls = primitiveUses + nativeUses;
  return {
    primitiveUses,
    directNativeUses: nativeUses,
    exceptedNativeUses,
    componentImplementationNativeUses,
    componentCoverage: accountableControls === 0 ? 1 : Number((primitiveUses / accountableControls).toFixed(3)),
    componentContractRows: componentContracts.length,
    componentTagNames: [...componentTags].sort(),
    directNativeFiles: Object.fromEntries([...directNativeFiles.entries()].sort()),
    exceptedNativeFiles: Object.fromEntries([...exceptedNativeFiles.entries()].sort()),
    componentImplementationNativeFiles: Object.fromEntries([...componentImplementationNativeFiles.entries()].sort()),
    staleNativeControlExceptions,
    componentImplementationFilesMissing,
    mappedContractsMissingFromDocs,
    unmappedDocumentedContracts,
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
  return line.trim().startsWith('--') && rawColorTokenDeclarationFiles.has(relative(ROOT, file));
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
    if (exception) {
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
    .map((match) => match[1])
    .sort();

  return {
    runtimeSurfaceMatrixFound: surfacesBlock.length > 0,
    runtimeSurfaceCases: surfaceNames.length,
    runtimeThemeVariants: RUNTIME_THEME_VARIANTS,
    runtimeSurfaceThemeChecks: surfaceNames.length * RUNTIME_THEME_VARIANTS,
    runtimeSurfaceNames: surfaceNames,
  };
}

function main() {
  if (
    !existsSync(DESIGN_SYSTEM_KERNEL)
    || !existsSync(DESIGN_SYSTEM_DIR)
    || !existsSync(DECISION_AUDIT)
    || !existsSync(RUNTIME_SURFACE_SPEC)
  ) {
    throw new Error('Design-system spec files are missing.');
  }

  const metrics = {
    designSystem: designSystemLineMetrics(),
    decisionAudit: decisionAuditMetrics(),
    exceptions: exceptionEvidenceMetrics(),
    components: componentCoverageMetrics(),
    tokens: rawColorMetrics(),
    runtimeSurfaces: runtimeSurfaceMetrics(),
    targets: {
      surfaceTargetLines: SURFACE_TARGET_LINES,
      decisionDerivationTarget: DECISION_DERIVATION_TARGET,
      componentCoverageTarget: COMPONENT_COVERAGE_TARGET,
      exceptionEvidenceCoverageTarget: 1,
      rawHexOutsideTokenDeclarationsTarget: 0,
      rawFunctionalColorOutsideTokenDeclarationsTarget: 0,
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
    console.log(`  native control exceptions: ${metrics.components.exceptedNativeUses}`);
    console.log(`  component implementation native: ${metrics.components.componentImplementationNativeUses}`);
    console.log(`  exception evidence: ${(metrics.exceptions.exceptionEvidenceCoverage * 100).toFixed(1)}%`);
    console.log(`  exception broken refs: ${metrics.exceptions.exceptionBrokenReferences.length}`);
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
    if (metrics.components.componentImplementationFilesMissing.length > 0) {
      failures.push(`component implementation files missing: ${metrics.components.componentImplementationFilesMissing.join(', ')}`);
    }
    if (metrics.components.staleNativeControlExceptions.length > 0) {
      failures.push(`stale native control exceptions: ${metrics.components.staleNativeControlExceptions.join(', ')}`);
    }
    if (metrics.exceptions.exceptionEvidenceCoverage < 1) {
      failures.push(`exception evidence ${metrics.exceptions.exceptionEvidenceCoverage} < 1`);
    }
    if (metrics.exceptions.exceptionBrokenReferences.length > 0) {
      failures.push(`exception evidence broken refs: ${metrics.exceptions.exceptionBrokenReferences.join(', ')}`);
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
    if (failures.length > 0) {
      console.error(`design-system metrics FAILED:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
  }
}

main();
