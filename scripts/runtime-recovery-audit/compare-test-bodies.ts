import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

interface TestBody {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly assertions: readonly string[];
  readonly source: string;
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const auditRoot = `${root}/tmp/runtime-recovery-audit`;
const printer = ts.createPrinter({ removeComments: true });
const current = new Map<string, TestBody[]>();

for (const path of execFileSync('rg', ['--files', 'tests'], { cwd: root, encoding: 'utf8' }).trim().split('\n')) {
  if (!/\.(?:ts|tsx)$/.test(path)) continue;
  for (const test of extractTests(path, readFileSync(`${root}/${path}`, 'utf8'), 'WORKTREE')) {
    const entries = current.get(test.title) ?? [];
    entries.push(test);
    current.set(test.title, entries);
  }
}

const historical = new Map<string, TestBody>();
const parsedHistoricalFiles = new Set<string>();
const historicalCache = new Map<string, TestBody[]>();
const prLines = readFileSync(`${auditRoot}/pr-test-title-events.tsv`, 'utf8').trim().split('\n');
const lostLines = readFileSync(`${auditRoot}/lost-snapshot-test-title-events.tsv`, 'utf8').trim().split('\n');
for (const line of [...prLines, ...lostLines]) {
  if (!line) continue;
  const [event, source, path] = line.split('\t');
  if (!event || !source || !path) continue;
  const key = `${source}\t${path}`;
  if (parsedHistoricalFiles.has(key)) continue;
  parsedHistoricalFiles.add(key);
  let text: string;
  try {
    text = execFileSync('git', ['show', `${source}:${path}`], { cwd: root, encoding: 'utf8' });
  } catch {
    continue;
  }
  for (const test of extractTests(path, text, source)) {
    historical.set(`${source}\t${path}\t${test.title}\t${test.body}`, test);
  }
}

const baselines = new Map<string, TestBody>();
collectLatest('pr', prLines);
collectLatest('lost-snapshot', lostLines);

const rows: string[] = ['status\thistorical_source\thistorical_path\ttitle\tcurrent_paths'];
const changed: TestBody[] = [];
let identical = 0;
let missing = 0;
for (const test of historical.values()) {
  const candidates = current.get(test.title) ?? [];
  if (candidates.some((candidate) => candidate.body === test.body)) {
    identical += 1;
    continue;
  }
  const status = candidates.length > 0 ? 'changed-body' : 'missing-title';
  if (status === 'changed-body') changed.push(test);
  else missing += 1;
  rows.push([
    status,
    test.source,
    test.path,
    test.title,
    [...new Set(candidates.map((candidate) => candidate.path))].join(','),
  ].map(tsv).join('\t'));
}

writeFileSync(`${auditRoot}/test-body-disposition.tsv`, `${rows.join('\n')}\n`);
writeFileSync(`${auditRoot}/test-body-changed-details.txt`, changed.map((test) => {
  const candidates = current.get(test.title) ?? [];
  return [
    `TITLE: ${test.title}`,
    `HISTORICAL: ${test.source}:${test.path}`,
    test.body,
    ...candidates.map((candidate) => `CURRENT: ${candidate.path}\n${candidate.body}`),
  ].join('\n');
}).join('\n\n---\n\n'));

const historicalAssertions = new Map<string, TestBody>();
for (const test of historical.values()) {
  for (const assertion of test.assertions) {
    historicalAssertions.set(`${test.path}\t${test.title}\t${assertion}`, test);
  }
}
const assertionRows: string[] = [
  'status\thistorical_source\thistorical_path\ttitle\tassertion\tcurrent_paths',
];
const missingAssertionGroups = new Map<string, { test: TestBody; assertions: string[] }>();
let identicalAssertions = 0;
let missingAssertions = 0;
for (const [key, test] of historicalAssertions) {
  const assertion = key.slice(key.lastIndexOf('\t') + 1);
  const candidates = current.get(test.title) ?? [];
  const matching = candidates.filter((candidate) => candidate.assertions.includes(assertion));
  if (matching.length > 0) {
    identicalAssertions += 1;
  } else {
    missingAssertions += 1;
    if (candidates.length > 0) {
      const groupKey = `${test.path}\t${test.title}`;
      const group = missingAssertionGroups.get(groupKey) ?? { test, assertions: [] };
      group.assertions.push(assertion);
      missingAssertionGroups.set(groupKey, group);
    }
  }
  assertionRows.push([
    matching.length > 0 ? 'exact-current-assertion' : 'missing-current-assertion',
    test.source,
    test.path,
    test.title,
    assertion,
    [...new Set(candidates.map((candidate) => candidate.path))].join(','),
  ].map(tsv).join('\t'));
}
writeFileSync(`${auditRoot}/historical-assertion-disposition.tsv`, `${assertionRows.join('\n')}\n`);
writeFileSync(
  `${auditRoot}/same-title-missing-assertion-groups.tsv`,
  [
    'historical_path\ttitle\tmissing_assertions\tcurrent_paths',
    ...[...missingAssertionGroups.values()].map(({ test, assertions }) => {
      const candidates = current.get(test.title) ?? [];
      return [
        test.path,
        test.title,
        String(assertions.length),
        [...new Set(candidates.map((candidate) => candidate.path))].join(','),
      ].map(tsv).join('\t');
    }),
  ].join('\n') + '\n',
);
writeFileSync(
  `${auditRoot}/same-title-missing-assertion-details.txt`,
  [...missingAssertionGroups.values()].map(({ test, assertions }) => {
    const candidates = current.get(test.title) ?? [];
    return [
      `TITLE: ${test.title}`,
      `HISTORICAL PATH: ${test.path}`,
      `HISTORICAL SOURCE: ${test.source}`,
      'MISSING HISTORICAL ASSERTIONS:',
      ...assertions,
      ...candidates.flatMap((candidate) => [
        `CURRENT: ${candidate.path}`,
        'CURRENT ASSERTIONS:',
        ...candidate.assertions,
      ]),
    ].join('\n');
  }).join('\n\n---\n\n'),
);

const assertionCountRows: string[] = [
  'historical_path\ttitle\thistorical_max_assertions\tcurrent_max_assertions\tcurrent_paths',
];
const historicalAssertionCounts = new Map<string, { max: number; test: TestBody }>();
for (const test of historical.values()) {
  const key = `${test.path}\t${test.title}`;
  const previous = historicalAssertionCounts.get(key);
  if (!previous || test.assertions.length > previous.max) {
    historicalAssertionCounts.set(key, { max: test.assertions.length, test });
  }
}
for (const { max, test } of historicalAssertionCounts.values()) {
  const candidates = current.get(test.title) ?? [];
  const currentMax = Math.max(0, ...candidates.map((candidate) => candidate.assertions.length));
  if (currentMax >= max) continue;
  assertionCountRows.push([
    test.path,
    test.title,
    String(max),
    String(currentMax),
    [...new Set(candidates.map((candidate) => candidate.path))].join(','),
  ].map(tsv).join('\t'));
}
writeFileSync(`${auditRoot}/test-assertion-count-review.tsv`, `${assertionCountRows.join('\n')}\n`);

const baselineRows: string[] = ['baseline\tstatus\thistorical_source\thistorical_path\ttitle\tcurrent_paths'];
const baselineChanged: TestBody[] = [];
let baselineIdentical = 0;
let baselineMissing = 0;
for (const [key, test] of baselines) {
  const baseline = key.slice(0, key.indexOf('\t'));
  const candidates = current.get(test.title) ?? [];
  if (candidates.some((candidate) => candidate.body === test.body)) {
    baselineIdentical += 1;
    continue;
  }
  const status = candidates.length > 0 ? 'changed-body' : 'missing-title';
  if (status === 'changed-body') baselineChanged.push(test);
  else baselineMissing += 1;
  baselineRows.push([
    baseline,
    status,
    test.source,
    test.path,
    test.title,
    [...new Set(candidates.map((candidate) => candidate.path))].join(','),
  ].map(tsv).join('\t'));
}
writeFileSync(`${auditRoot}/test-body-baseline-disposition.tsv`, `${baselineRows.join('\n')}\n`);
writeFileSync(`${auditRoot}/test-body-baseline-changed-details.txt`, baselineChanged.map((test) => {
  const candidates = current.get(test.title) ?? [];
  return [
    `TITLE: ${test.title}`,
    `HISTORICAL: ${test.source}:${test.path}`,
    test.body,
    ...candidates.map((candidate) => `CURRENT: ${candidate.path}\n${candidate.body}`),
  ].join('\n');
}).join('\n\n---\n\n'));
writeFileSync(`${auditRoot}/test-body-baseline-assertion-deltas.txt`, baselineChanged.map((test) => {
  const candidates = current.get(test.title) ?? [];
  return [
    `TITLE: ${test.title}`,
    `HISTORICAL: ${test.source}:${test.path}`,
    'HISTORICAL ASSERTIONS:',
    ...test.assertions,
    ...candidates.flatMap((candidate) => [
      `CURRENT: ${candidate.path}`,
      'CURRENT ASSERTIONS:',
      ...candidate.assertions,
    ]),
  ].join('\n');
}).join('\n\n---\n\n'));

console.log(`historical unique bodies: ${historical.size}`);
console.log(`identical current bodies: ${identical}`);
console.log(`changed bodies: ${changed.length}`);
console.log(`missing titles: ${missing}`);
console.log(`historical unique assertions: ${historicalAssertions.size}`);
console.log(`identical current assertions: ${identicalAssertions}`);
console.log(`missing current assertions: ${missingAssertions}`);
console.log(`baseline responsibilities: ${baselines.size}`);
console.log(`baseline identical bodies: ${baselineIdentical}`);
console.log(`baseline changed bodies: ${baselineChanged.length}`);
console.log(`baseline missing titles: ${baselineMissing}`);

function extractTests(path: string, text: string, source: string): TestBody[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const tests: TestBody[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node.expression)) {
      const title = node.arguments[0];
      if (title && testTitle(title, file) !== null) {
        tests.push({
          path,
          title: testTitle(title, file)!,
          body: printer.printNode(ts.EmitHint.Unspecified, node, file),
          assertions: extractAssertions(node, file),
          source,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return tests;
}

function extractAssertions(test: ts.CallExpression, file: ts.SourceFile): string[] {
  const assertions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && containsExpect(node.expression)) {
      assertions.push(printer.printNode(ts.EmitHint.Unspecified, node, file));
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const argument of test.arguments.slice(1)) visit(argument);
  return assertions;
}

function containsExpect(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') return true;
  return node.getChildren().some(containsExpect);
}

function collectLatest(baseline: string, lines: readonly string[]): void {
  for (const line of lines) {
    if (!line) continue;
    const [, source, path, title] = line.split('\t');
    if (!source || !path || !title) continue;
    const cacheKey = `${source}\t${path}`;
    let tests = historicalCache.get(cacheKey);
    if (!tests) {
      try {
        const text = execFileSync('git', ['show', `${source}:${path}`], { cwd: root, encoding: 'utf8' });
        tests = extractTests(path, text, source);
      } catch {
        tests = [];
      }
      historicalCache.set(cacheKey, tests);
    }
    const test = tests.find((candidate) => candidate.title === title);
    if (test) baselines.set(`${baseline}\t${path}\t${title}`, test);
  }
}

function isTestCall(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'test' || expression.text === 'it';
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression)
      && (expression.expression.text === 'test' || expression.expression.text === 'it')
      && ['skip', 'todo', 'only', 'concurrent'].includes(expression.name.text);
  }
  return ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && (expression.expression.expression.text === 'test' || expression.expression.expression.text === 'it')
    && expression.expression.name.text === 'each';
}

function testTitle(node: ts.Expression, file: ts.SourceFile): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return printer.printNode(ts.EmitHint.Unspecified, node, file);
  return null;
}

function tsv(value: string): string {
  return value.replaceAll('\t', ' ').replaceAll('\n', ' ');
}
