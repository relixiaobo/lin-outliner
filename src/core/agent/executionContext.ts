export interface ExecutionScope {
  readonly key: string;
  readonly directory: string;
  readonly worktree: string | null;
  readonly gitDirectory: string | null;
}

export interface ExecutionAddress {
  readonly requestedCwd: string | null;
  readonly cwd: string;
  readonly targets: readonly string[];
  readonly targetMode: 'follow' | 'entry';
  readonly coverage: 'cwd-only' | 'known-targets';
  readonly scopes: readonly ExecutionScope[];
}

export interface ExecutionPolicy {
  readonly capability: 'full-access' | 'read-only';
  readonly isolation: 'unsandboxed' | 'macos-write-sandbox' | 'host-write-boundary';
  readonly writablePaths: readonly string[];
  readonly mutation: boolean;
}

export interface ExecutionContextFact {
  readonly source: string;
  readonly kind: 'discovery' | 'instruction' | 'profile' | 'git' | 'check' | 'process';
  readonly authority: 'host' | 'repository';
  readonly purpose: 'guidance' | 'observation';
  readonly scope: string;
  readonly version: string;
  readonly text: string;
  readonly invalidated: boolean;
  readonly observedAt?: number;
}

export interface ExecutionContextSnapshot {
  readonly seriesId: string;
  readonly capturedAt: number;
  readonly generation: number;
  readonly predecessorRef: string | null;
  readonly discovery: 'pending' | 'complete' | 'unavailable';
  readonly degradation: string | null;
  readonly facts: readonly ExecutionContextFact[];
}

export interface ExecutionContextSource {
  readonly path: string;
  readonly canonicalPath: string | null;
  readonly digest: string | null;
  readonly state: 'present' | 'missing' | 'unavailable';
}

export interface ExecutionContextScopeObservation {
  readonly directory: string;
  readonly sources: readonly string[];
  readonly complete: boolean;
}

export interface ProjectCheckDeclaration {
  readonly id: string;
  readonly command: string;
  readonly required: boolean;
  readonly inputs: readonly string[];
  readonly exclude: readonly string[];
  readonly source: string;
  readonly scope: string;
}

/** Self-contained evidence; references identify immutable values in this receipt. */
export interface TaskExecutionContext {
  readonly addressRef: string;
  readonly policyRef: string;
  readonly snapshotRef: string;
  readonly address: ExecutionAddress;
  readonly policy: ExecutionPolicy;
  readonly snapshot: ExecutionContextSnapshot;
}

export function decodeTaskExecutionContext(value: unknown): TaskExecutionContext {
  const context = object(value, ['addressRef', 'policyRef', 'snapshotRef', 'address', 'policy', 'snapshot']);
  for (const key of ['addressRef', 'policyRef', 'snapshotRef']) {
    if (!/^[a-f0-9]{64}$/u.test(text(context[key]))) throw new Error(`Invalid execution context ${key}`);
  }
  const address = object(context.address, ['requestedCwd', 'cwd', 'targets', 'targetMode', 'coverage', 'scopes']);
  if (address.requestedCwd !== null) text(address.requestedCwd);
  absolutePath(address.cwd);
  array(address.targets).forEach(absolutePath);
  member(address.targetMode, ['follow', 'entry']);
  member(address.coverage, ['cwd-only', 'known-targets']);
  const scopes = array(address.scopes);
  if (scopes.length === 0) throw new Error('Execution address requires an applicability scope');
  const keys = new Set<string>();
  for (const value of scopes) {
    const scope = object(value, ['key', 'directory', 'worktree', 'gitDirectory']);
    const key = JSON.stringify([text(scope.key), scope.directory]);
    if (keys.has(key)) throw new Error('Duplicate execution scope');
    keys.add(key);
    absolutePath(scope.directory);
    if (scope.worktree !== null) absolutePath(scope.worktree);
    if (scope.gitDirectory !== null) absolutePath(scope.gitDirectory);
    if ((scope.worktree === null) !== (scope.gitDirectory === null)) throw new Error('Incomplete Git identity');
  }
  const policy = object(context.policy, ['capability', 'isolation', 'writablePaths', 'mutation']);
  member(policy.capability, ['full-access', 'read-only']);
  member(policy.isolation, ['unsandboxed', 'macos-write-sandbox', 'host-write-boundary']);
  array(policy.writablePaths).forEach(absolutePath);
  if (typeof policy.mutation !== 'boolean' || (policy.capability === 'read-only' && policy.mutation)) {
    throw new Error('Invalid execution mutation authority');
  }
  const snapshot = object(context.snapshot, ['seriesId', 'capturedAt', 'generation', 'predecessorRef', 'discovery', 'degradation', 'facts']);
  text(snapshot.seriesId);
  if (!Number.isSafeInteger(snapshot.capturedAt) || (snapshot.capturedAt as number) < 0) throw new Error('Invalid snapshot capture time');
  if (!Number.isSafeInteger(snapshot.generation) || (snapshot.generation as number) < 0) {
    throw new Error('Invalid execution snapshot generation');
  }
  if (snapshot.predecessorRef !== null && !/^[a-f0-9]{64}$/u.test(text(snapshot.predecessorRef))) {
    throw new Error('Invalid execution snapshot predecessor');
  }
  if ((snapshot.generation === 0) !== (snapshot.predecessorRef === null)) {
    throw new Error('Execution snapshot generation requires its predecessor');
  }
  member(snapshot.discovery, ['pending', 'complete', 'unavailable']);
  if (snapshot.degradation !== null) text(snapshot.degradation);
  array(snapshot.facts).forEach(decodeExecutionContextFact);
  return value as TaskExecutionContext;
}

export function decodeExecutionContextFact(value: unknown): ExecutionContextFact {
  const fact = object(value, ['source', 'kind', 'authority', 'purpose', 'scope', 'version', 'text', 'invalidated'], ['observedAt']);
  if (fact.observedAt !== undefined && (!Number.isSafeInteger(fact.observedAt) || (fact.observedAt as number) < 0)) throw new Error('Invalid fact capture time');
  for (const key of ['source', 'scope', 'version', 'text']) text(fact[key]);
  member(fact.kind, ['discovery', 'instruction', 'profile', 'git', 'check', 'process']);
  member(fact.authority, ['host', 'repository']);
  member(fact.purpose, ['guidance', 'observation']);
  if (typeof fact.invalidated !== 'boolean') throw new Error('Invalid execution fact invalidation');
  return value as ExecutionContextFact;
}

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected execution context object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error('Invalid execution context fields');
  }
  return record;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected execution context array');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid execution context text');
  return value;
}

function absolutePath(value: unknown): void {
  if (!/^(?:\/|[A-Za-z]:[\\/])/u.test(text(value))) throw new Error('Execution path must be absolute');
}

function member(value: unknown, values: readonly string[]): void {
  if (!values.includes(text(value))) throw new Error('Invalid execution context discriminator');
}
