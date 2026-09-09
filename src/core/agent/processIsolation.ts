import type { ExecutionPolicy } from './executionContext';

export type ProcessIsolationState = 'sandboxed' | 'unsandboxed' | 'unavailable' | 'rejected';

/** A requested policy is not proof that the OS applied it. Null means pending. */
export interface ProcessIsolationEvidence {
  readonly requested: ExecutionPolicy['isolation'];
  readonly state: ProcessIsolationState | null;
  readonly platform: string;
  readonly backend: 'macos-sandbox-exec' | null;
  readonly dependency: 'not-required' | 'unchecked' | 'available' | 'unavailable';
  readonly network: 'unrestricted';
  readonly writablePaths: readonly string[];
  readonly protectedGitObjectStores: readonly string[];
  readonly profileDigest: string | null;
  readonly reason: string | null;
}

export function pendingProcessIsolation(policy: ExecutionPolicy, platform: string): ProcessIsolationEvidence {
  return { requested: policy.isolation, state: null, platform,
    backend: policy.isolation === 'macos-write-sandbox' ? 'macos-sandbox-exec' : null,
    dependency: policy.isolation === 'macos-write-sandbox' ? 'unchecked' : 'not-required',
    network: 'unrestricted', writablePaths: [...policy.writablePaths], protectedGitObjectStores: [],
    profileDigest: null, reason: null };
}

export function decodeProcessIsolationEvidence(value: unknown): ProcessIsolationEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid process isolation evidence');
  const record = value as Record<string, unknown>;
  if (JSON.stringify(record).length > 24_000) throw new Error('Process isolation evidence exceeds its budget');
  const keys = ['requested', 'state', 'platform', 'backend', 'dependency', 'network', 'writablePaths', 'protectedGitObjectStores', 'profileDigest', 'reason'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error('Invalid process isolation fields');
  const member = (value: unknown, choices: readonly unknown[]) => { if (!choices.includes(value)) throw new Error('Invalid process isolation discriminator'); };
  member(record.requested, ['unsandboxed', 'macos-write-sandbox', 'host-write-boundary']);
  member(record.state, [null, 'sandboxed', 'unsandboxed', 'unavailable', 'rejected']);
  member(record.backend, [null, 'macos-sandbox-exec']);
  member(record.dependency, ['not-required', 'unchecked', 'available', 'unavailable']);
  member(record.network, ['unrestricted']);
  if (typeof record.platform !== 'string' || !/^[a-z0-9-]{1,32}$/u.test(record.platform)) throw new Error('Invalid isolation platform');
  for (const field of ['writablePaths', 'protectedGitObjectStores']) {
    const paths = record[field];
    if (!Array.isArray(paths) || paths.length > 64 || paths.some((entry) => typeof entry !== 'string'
      || entry.length > 4096 || entry.includes('\0') || !/^(?:\/|[A-Za-z]:[\\/])/u.test(entry))) throw new Error('Invalid isolation roots');
    if (new Set(paths).size !== paths.length) throw new Error('Duplicate isolation roots');
  }
  if (record.profileDigest !== null && (typeof record.profileDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.profileDigest))) throw new Error('Invalid isolation profile digest');
  if (record.reason !== null && (typeof record.reason !== 'string' || !record.reason || record.reason.length > 1024 || record.reason.includes('\0'))) throw new Error('Invalid isolation reason');
  if (record.state === 'sandboxed' && (record.requested !== 'macos-write-sandbox' || record.platform !== 'darwin'
    || record.backend !== 'macos-sandbox-exec' || record.dependency !== 'available' || record.profileDigest === null)) throw new Error('Sandbox enforcement requires activation evidence');
  if (record.state === 'unsandboxed' && (record.requested === 'macos-write-sandbox' || record.backend !== null || record.profileDigest !== null)) throw new Error('Required isolation cannot fall back');
  return value as ProcessIsolationEvidence;
}

export function sameIsolationRequest(a: ProcessIsolationEvidence, b: ProcessIsolationEvidence): boolean {
  const request = (value: ProcessIsolationEvidence) => [
    value.requested, value.platform, value.backend, value.dependency, value.network,
    value.writablePaths, value.protectedGitObjectStores, value.profileDigest,
  ];
  return JSON.stringify(request(a)) === JSON.stringify(request(b));
}

export function unstartedProcessIsolation(evidence: ProcessIsolationEvidence): ProcessIsolationEvidence {
  if (evidence.state !== null) return evidence;
  return { ...evidence, state: evidence.requested === 'macos-write-sandbox' ? 'unavailable' : 'unsandboxed',
    reason: 'No command activation was observed.' };
}
