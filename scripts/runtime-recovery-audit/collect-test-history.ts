import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const auditRoot = `${root}/tmp/runtime-recovery-audit`;
const printer = ts.createPrinter({ removeComments: true });
const lostParent = requiredEnvironmentValue('RUNTIME_RECOVERY_LOST_PARENT');
const lostSnapshot = requiredEnvironmentValue('RUNTIME_RECOVERY_LOST_SNAPSHOT');
const preCutover = requiredEnvironmentValue('RUNTIME_RECOVERY_PRE_CUTOVER');
const cutover = requiredEnvironmentValue('RUNTIME_RECOVERY_CUTOVER');
const snapshots = [lostSnapshot, preCutover, cutover, '5a280cbb', 'HEAD'];

const prCommits = readFileSync(`${auditRoot}/pr-commits.tsv`, 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split('\t')[0])
  .filter((commit): commit is string => Boolean(commit));

const prEvents: string[] = [];
for (const commit of prCommits) {
  const paths = gitLines(['diff-tree', '--no-commit-id', '--name-only', '-r', `${commit}^`, commit]);
  collectEvents(commit, [`${commit}^`, commit], paths, prEvents);
}
writeFileSync(`${auditRoot}/pr-test-title-events.tsv`, lines(prEvents));

const lostEvents: string[] = [];
collectEvents(
  'lost-snapshot',
  [lostParent, lostSnapshot],
  gitLines(['diff', '--name-only', `${lostParent}..${lostSnapshot}`, '--', 'tests']),
  lostEvents,
);
writeFileSync(`${auditRoot}/lost-snapshot-test-title-events.tsv`, lines(lostEvents));

const responsibilities = new Set<string>();
for (const event of [...prEvents, ...lostEvents]) {
  const [, , path, title] = event.split('\t');
  if (path && title) responsibilities.add(`${path}\t${title}`);
}
writeFileSync(
  `${auditRoot}/historical-test-responsibilities.txt`,
  lines([...responsibilities].sort()),
);

for (const revision of snapshots) {
  const rows: string[] = [];
  for (const path of gitLines(['ls-tree', '-r', '--name-only', revision, 'tests'])) {
    if (!isTestPath(path)) continue;
    const text = gitShow(revision, path);
    if (text === null) continue;
    for (const title of extractTitles(path, text)) rows.push(`${path}\t${tsv(title)}`);
  }
  writeFileSync(`${auditRoot}/test-titles-${revision}.txt`, lines(rows));
}

const currentRows: string[] = [];
for (const path of gitLines(['ls-files', '--cached', '--others', '--exclude-standard', 'tests'])) {
  if (!isTestPath(path)) continue;
  for (const title of extractTitles(path, readFileSync(`${root}/${path}`, 'utf8'))) {
    currentRows.push(`${path}\t${tsv(title)}`);
  }
}
writeFileSync(`${auditRoot}/test-titles-WORKTREE.txt`, lines(currentRows));

function collectEvents(
  event: string,
  revisions: readonly string[],
  paths: readonly string[],
  rows: string[],
): void {
  for (const path of paths) {
    if (!isTestPath(path)) continue;
    for (const revision of revisions) {
      const text = gitShow(revision, path);
      if (text === null) continue;
      for (const title of extractTitles(path, text)) {
        rows.push([event, revision, path, title].map(tsv).join('\t'));
      }
    }
  }
}

function extractTitles(path: string, text: string): string[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node.expression)) {
      const title = node.arguments[0];
      const value = title ? testTitle(title, file) : null;
      if (value !== null) titles.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return titles;
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

function gitLines(args: readonly string[]): string[] {
  const output = execFileSync('git', [...args], { cwd: root, encoding: 'utf8' }).trim();
  return output ? output.split('\n') : [];
}

function gitShow(revision: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function isTestPath(path: string): boolean {
  return /^tests\/.*\.(?:ts|tsx)$/.test(path);
}

function lines(rows: readonly string[]): string {
  return rows.length > 0 ? `${rows.join('\n')}\n` : '';
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function tsv(value: string): string {
  return value.replaceAll('\t', ' ').replaceAll('\n', ' ');
}
