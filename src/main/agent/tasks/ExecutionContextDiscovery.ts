import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExecutionContextFact,
  ExecutionContextSnapshot,
  TaskExecutionContext,
} from '../../../core/agent/executionContext';
import { validateExecutionContext } from './ExecutionContext';

const MAX_SOURCE_BYTES = 128 * 1024;
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'AGENT.md'] as const;
const PROFILE_FILES = ['.tenon/agent.json'] as const;

export interface ExecutionContextDiscoveryOptions {
  readonly maxSourceBytes?: number;
  readonly readFile?: (filePath: string) => Promise<Buffer>;
}

export interface ExecutionContextDiscoveryResult {
  readonly context: TaskExecutionContext;
  readonly readFiles: readonly string[];
}

/**
 * Capture repository facts after task admission without changing the admitted
 * address or the snapshot that the task receipt references. Missing optional
 * files are an explicit empty observation; other read failures degrade the
 * successor and never turn execution into a failure.
 */
export async function discoverExecutionContext(
  input: TaskExecutionContext,
  options: ExecutionContextDiscoveryOptions = {},
): Promise<ExecutionContextDiscoveryResult> {
  const admitted = validateExecutionContext(input);
  const maxSourceBytes = Math.max(1, options.maxSourceBytes ?? MAX_SOURCE_BYTES);
  const read = options.readFile ?? ((filePath: string) => readFile(filePath));
  const facts: ExecutionContextFact[] = [];
  const readFiles: string[] = [];
  const degradationReasons: string[] = [];

  for (const scope of admitted.address.scopes) {
    for (const directory of ancestorDirectories(scope.directory)) {
      for (const name of INSTRUCTION_FILES) {
        await captureSource({
          filePath: path.join(directory, name),
          kind: 'instruction',
          scope: directory,
          sourceLabel: `repository:${name}`,
          read,
          maxSourceBytes,
          facts,
          readFiles,
          degradationReasons,
        });
      }
      for (const name of PROFILE_FILES) {
        await captureSource({
          filePath: path.join(directory, name),
          kind: 'profile',
          scope: directory,
          sourceLabel: 'repository:.tenon/agent.json',
          read,
          maxSourceBytes,
          facts,
          readFiles,
          degradationReasons,
        });
      }
    }
    facts.push({
      source: 'host:git',
      kind: 'git',
      authority: 'host',
      purpose: 'observation',
      scope: scope.directory,
      version: scope.worktree ?? scope.key,
      text: scope.worktree
        ? `Git worktree: ${scope.worktree}`
        : 'No Git worktree was detected for this scope.',
      invalidated: false,
    });
  }

  const snapshot: ExecutionContextSnapshot = {
    generation: admitted.snapshot.generation + 1,
    predecessorRef: admitted.snapshotRef,
    discovery: degradationReasons.length === 0 ? 'complete' : 'unavailable',
    degradation: degradationReasons.length === 0 ? null : degradationReasons.join(' '),
    facts: deduplicateFacts(facts),
  };
  const context = validateExecutionContext({
    addressRef: admitted.addressRef,
    policyRef: admitted.policyRef,
    snapshotRef: digest(snapshot),
    address: admitted.address,
    policy: admitted.policy,
    snapshot,
  });
  return { context, readFiles: readFiles.sort() };
}

async function captureSource(input: {
  readonly filePath: string;
  readonly kind: 'instruction' | 'profile';
  readonly scope: string;
  readonly sourceLabel: string;
  readonly read: (filePath: string) => Promise<Buffer>;
  readonly maxSourceBytes: number;
  readonly facts: ExecutionContextFact[];
  readonly readFiles: string[];
  readonly degradationReasons: string[];
}): Promise<void> {
  let bytes: Buffer;
  try {
    const metadata = await stat(input.filePath);
    if (!metadata.isFile()) return;
    bytes = await input.read(input.filePath);
  } catch (error) {
    if (isMissing(error)) return;
    input.degradationReasons.push(`Could not read ${input.filePath}: ${errorMessage(error)}.`);
    return;
  }
  input.readFiles.push(input.filePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const truncated = bytes.byteLength > input.maxSourceBytes;
  const text = bytes.subarray(0, input.maxSourceBytes).toString('utf8');
  input.facts.push({
    source: input.sourceLabel,
    kind: input.kind,
    authority: 'repository',
    purpose: 'guidance',
    scope: input.scope,
    version: digest,
    text: truncated ? `${text}\n[Source truncated at the Host discovery limit.]` : text,
    invalidated: false,
  });
  if (truncated) input.degradationReasons.push(`${input.filePath} exceeded the discovery byte limit.`);
}

function ancestorDirectories(directory: string): readonly string[] {
  const ancestors: string[] = [];
  let current = directory;
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors.reverse();
}

function deduplicateFacts(facts: readonly ExecutionContextFact[]): readonly ExecutionContextFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = JSON.stringify([fact.source, fact.kind, fact.scope, fact.version]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
