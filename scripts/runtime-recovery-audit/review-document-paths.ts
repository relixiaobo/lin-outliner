import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface Review {
  readonly disposition: 'relocated-current' | 'stronger-current';
  readonly currentPath: string;
  readonly evidenceLabel: string;
  readonly rationale: string;
}

const auditRoot = `${process.cwd()}/tmp/runtime-recovery-audit`;
const reviews = new Map<string, Review>([
  ['docs/plans/outliner-runtime-cli.md', {
    disposition: 'relocated-current',
    currentPath: 'docs/plans/archive/outliner-runtime-cli.md',
    evidenceLabel: 'The renderer has one input-settlement mechanism',
    rationale: 'The shipped #584 design moved to the plan archive and was extended with the recovered editor settlement and Runtime lifecycle design.',
  }],
  ['docs/plans/reference/nodex-parity-decisions.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/plans/reference/nodex-parity-decisions.md',
    evidenceLabel: '../archive/outliner-runtime-cli.md',
    rationale: 'The standing decision remains and now points at the archived shipped Runtime design.',
  }],
  ['docs/spec/architecture.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/spec/architecture.md',
    evidenceLabel: 'Runtime owns one live Core.',
    rationale: 'The current architecture spec replaces the cutover snapshot with accepted/durable settlement, read-model, persistence, asset, ranking, and lifecycle recovery details.',
  }],
  ['docs/spec/agent-memory.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/spec/agent-memory.md',
    evidenceLabel: 'Citation ranking records only a bounded set',
    rationale: 'The current Memory spec adds protected-definition repair, exact public-show citation accounting, and main-process planning serialization over the recovered Runtime boundary.',
  }],
  ['docs/spec/agent-thread-rendering.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/spec/agent-thread-rendering.md',
    evidenceLabel: 'Automatic creation is asynchronous',
    rationale: 'The current rendering spec preserves the existing composer focus contract and records the recovered cross-frame protection for focus established while Thread creation is pending.',
  }],
  ['docs/spec/commands.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/spec/commands.md',
    evidenceLabel: 'An accepted desktop receipt contains',
    rationale: 'The current command spec retains the public contract and adds the recovered private desktop accepted-settlement boundary.',
  }],
  ['docs/spec/outliner-parity-matrix.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/spec/outliner-parity-matrix.md',
    evidenceLabel: 'OutlinerFlatView',
    rationale: 'The parity matrix retains the keyboard and trailing-row responsibilities while naming the recovered flat renderer.',
  }],
  ['docs/spec/search-query-grammar.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/spec/search-query-grammar.md',
    evidenceLabel: 'synchronizes a bounded, non-persistent mirror into Runtime',
    rationale: 'The current search spec retains personal access ranking while making the restored startup, reconnect, incremental sync, and private ownership boundary explicit.',
  }],
  ['docs/spec/ui-behavior.md', {
    disposition: 'stronger-current',
    currentPath: 'docs/spec/ui-behavior.md',
    evidenceLabel: 'Body, field-value, and Table-hosted node editing',
    rationale: 'The current UI spec records the unified optimistic structure, field, focus, IME, and keyboard settlement behavior.',
  }],
]);

const paths = readFileSync(`${auditRoot}/pr-path-disposition.tsv`, 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split('\t'))
  .filter(([status, path]) => (
    status !== 'identical-now'
    && !path?.startsWith('src/')
    && !path?.startsWith('tests/')
  ));
const output = ['historical_status\thistorical_path\tdisposition\tcurrent_path\tevidence_label\trationale'];
const unreviewed: string[] = [];
for (const [status, historicalPath] of paths) {
  if (!status || !historicalPath) continue;
  const review = reviews.get(historicalPath);
  if (!review) {
    unreviewed.push(`${status}\t${historicalPath}`);
    continue;
  }
  if (!existsSync(review.currentPath)
    || !readFileSync(review.currentPath, 'utf8').includes(review.evidenceLabel)) {
    unreviewed.push(`missing-current-evidence\t${historicalPath}\t${review.currentPath}`);
    continue;
  }
  output.push([
    status,
    historicalPath,
    review.disposition,
    review.currentPath,
    review.evidenceLabel,
    review.rationale,
  ].map(tsv).join('\t'));
  reviews.delete(historicalPath);
}
for (const path of reviews.keys()) unreviewed.push(`stale-review\t${path}`);
writeFileSync(`${auditRoot}/document-path-review.tsv`, `${output.join('\n')}\n`);
writeFileSync(`${auditRoot}/unreviewed-document-paths.txt`, unreviewed.length ? `${unreviewed.join('\n')}\n` : '');
if (unreviewed.length > 0) {
  console.error(`Document path review is incomplete (${output.length - 1}/${paths.length}).`);
  console.error(unreviewed.join('\n'));
  process.exit(1);
}

function tsv(value: string): string {
  return value.replaceAll('\t', ' ').replaceAll('\n', ' ');
}
