import { decodeVerificationConfiguration, type VerificationConfiguration, type VerificationCheckDefinition } from '../../../core/agent/verification';
import type { ThreadContextPayloadReference } from '../../../core/agent/protocol';
import { decodeThreadContextPayloadReference } from '../../../core/agent/codec';
import { executionDigest } from '../tasks/ExecutionContext';

export interface VerificationCheckEvidence {
  readonly checkId: string;
  readonly toolTaskId: string;
  readonly beforeRef: ThreadContextPayloadReference;
  readonly afterRef: ThreadContextPayloadReference | null;
  readonly terminalDigest: string | null;
  readonly fingerprint: string | null;
}
export interface VerificationAttempt {
  readonly revision: number;
  readonly baselineRef: ThreadContextPayloadReference;
  readonly definitionDigest: string;
  readonly definitions: readonly VerificationCheckDefinition[];
  readonly checks: readonly VerificationCheckEvidence[];
  readonly changedPaths: readonly string[];
  readonly parentFailureTaskIds: readonly string[];
  readonly tokensAtStart: number;
  readonly startedAt: number;
}
export interface VerificationInvalidation {
  readonly revision: number;
  readonly reason: string;
  readonly taskId: string | null;
  readonly at: number;
}
export interface VerificationState {
  readonly verificationRunId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly configuration: VerificationConfiguration;
  readonly attempts: readonly VerificationAttempt[];
  readonly invalidations: readonly VerificationInvalidation[];
  readonly resumptions: readonly { readonly turnId: string; readonly afterRevision: number; readonly at: number; readonly stopReason: string }[];
  readonly stopped: { readonly reason: string; readonly at: number } | null;
}

/** Storage metadata links to canonical evidence; it never stores a second process outcome. */
export function validateVerificationState(value: VerificationState): VerificationState {
  fields(value, ['verificationRunId', 'threadId', 'generation', 'configuration', 'attempts', 'invalidations', 'resumptions', 'stopped']);
  decodeVerificationConfiguration(value.configuration);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.verificationRunId) || !validText(value.threadId) || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !Array.isArray(value.attempts) || value.attempts.length > value.configuration.maxAttempts
    || !Array.isArray(value.invalidations) || value.invalidations.length > value.attempts.length
    || !Array.isArray(value.resumptions) || value.resumptions.length > 20) throw new Error('Invalid verification workflow metadata.');
  if (value.stopped !== null) {
    fields(value.stopped, ['reason', 'at']);
    if (!validText(value.stopped.reason) || !natural(value.stopped.at)) throw new Error('Invalid verification stop.');
  }
  const invalidations = new Set<number>();
  for (const entry of value.invalidations) {
    fields(entry, ['revision', 'reason', 'taskId', 'at']);
    if (!natural(entry.revision) || entry.revision >= value.attempts.length || invalidations.has(entry.revision)
      || !validText(entry.reason) || !natural(entry.at) || (entry.taskId !== null && !validText(entry.taskId))) throw new Error('Invalid verification invalidation.');
    invalidations.add(entry.revision);
  }
  const resumptions = new Set<string>();
  for (const entry of value.resumptions) {
    fields(entry, ['turnId', 'afterRevision', 'at', 'stopReason']);
    if (!validText(entry.turnId) || resumptions.has(entry.turnId) || !natural(entry.at) || !validText(entry.stopReason)
      || !Number.isSafeInteger(entry.afterRevision) || entry.afterRevision < -1 || entry.afterRevision >= value.attempts.length) throw new Error('Invalid verification resumption.');
    resumptions.add(entry.turnId);
  }
  const tasks = new Set<string>();
  value.attempts.forEach((attempt, index) => {
    fields(attempt, ['revision', 'baselineRef', 'definitionDigest', 'definitions', 'checks', 'changedPaths', 'parentFailureTaskIds', 'tokensAtStart', 'startedAt']);
    if (attempt.revision !== index || !Number.isSafeInteger(attempt.startedAt) || attempt.startedAt < 0
      || !Number.isSafeInteger(attempt.tokensAtStart) || attempt.tokensAtStart < 0
      || !/^[a-f0-9]{64}$/u.test(attempt.definitionDigest)
      || !Array.isArray(attempt.checks) || !Array.isArray(attempt.definitions)
      || attempt.definitions.length > 64 || attempt.checks.length > attempt.definitions.length
      || attempt.baselineRef.kind !== 'verificationSource') throw new Error('Invalid verification attempt metadata.');
    sourceRef(attempt.baselineRef);
    if (!Array.isArray(attempt.changedPaths) || attempt.changedPaths.length > 20_000 || !attempt.changedPaths.every(validText)
      || !Array.isArray(attempt.parentFailureTaskIds) || attempt.parentFailureTaskIds.length > 64 || !attempt.parentFailureTaskIds.every((id: string) => tasks.has(id))) throw new Error('Invalid verification attempt lineage.');
    const keys = new Set<string>();
    for (const definition of attempt.definitions) {
      fields(definition, ['id', 'key', 'command', 'required', 'inputs', 'exclude', 'source', 'scope']);
      if (!validText(definition.id) || !validText(definition.command) || !validText(definition.source) || !validText(definition.scope)
        || typeof definition.required !== 'boolean' || keys.has(definition.key)
        || definition.key !== executionDigest([definition.source, definition.id])
        || !Array.isArray(definition.inputs) || definition.inputs.length > 64 || !definition.inputs.every(validText)
        || !Array.isArray(definition.exclude) || definition.exclude.length > 64 || !definition.exclude.every(validText)) throw new Error('Invalid verification definition.');
      keys.add(definition.key);
    }
    if (executionDigest(attempt.definitions) !== attempt.definitionDigest || !attempt.definitions.some((definition: VerificationCheckDefinition) => definition.required)) throw new Error('Invalid verification definition digest.');
    const checks = new Set<string>();
    for (const check of attempt.checks) {
      fields(check, ['checkId', 'toolTaskId', 'beforeRef', 'afterRef', 'terminalDigest', 'fingerprint']);
      if (!attempt.definitions.some((definition: VerificationCheckDefinition) => definition.key === check.checkId)
        || !validText(check.toolTaskId) || tasks.has(check.toolTaskId) || checks.has(check.checkId)
        || check.beforeRef.kind !== 'verificationSource'
        || (check.afterRef !== null && check.afterRef.kind !== 'verificationSource')) throw new Error('Invalid verification check evidence.');
      sourceRef(check.beforeRef);
      if (check.afterRef !== null) sourceRef(check.afterRef);
      if ((check.afterRef === null) !== (check.terminalDigest === null) || !nullableDigest(check.terminalDigest) || !nullableDigest(check.fingerprint)) throw new Error('Invalid verification terminal binding.');
      tasks.add(check.toolTaskId);
      checks.add(check.checkId);
    }
  });
  return structuredClone(value);
}

function fields(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new Error('Invalid verification metadata fields.');
}
function validText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !value.includes('\0'); }
function natural(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function nullableDigest(value: unknown): boolean { return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)); }
function sourceRef(value: unknown): void {
  if (decodeThreadContextPayloadReference(value).kind !== 'verificationSource') throw new Error('Expected verification source evidence.');
}

/** Existing evidence is immutable; settlement may fill one previously empty terminal binding. */
export function assertVerificationTransition(previous: VerificationState, next: VerificationState): void {
  const equal = (left: unknown, right: unknown) => executionDigest(left) === executionDigest(right);
  const prefix = (before: readonly unknown[], after: readonly unknown[]) => before.length <= after.length && before.every((value, index) => equal(value, after[index]));
  if (previous.verificationRunId !== next.verificationRunId || previous.generation !== next.generation || previous.threadId !== next.threadId
    || !equal(previous.configuration, next.configuration) || !prefix(previous.invalidations, next.invalidations)
    || !prefix(previous.resumptions, next.resumptions) || previous.attempts.length > next.attempts.length
    || next.attempts.length > previous.attempts.length + 1
    || (previous.stopped && !equal(previous.stopped, next.stopped) && !(next.stopped === null && next.resumptions.length === previous.resumptions.length + 1))) {
    throw new Error('Verification history is immutable.');
  }
  for (const attempt of previous.attempts) {
    const updated = next.attempts[attempt.revision]!;
    const { checks: oldChecks, ...oldMetadata } = attempt;
    const { checks: newChecks, ...newMetadata } = updated;
    if (!equal(oldMetadata, newMetadata) || oldChecks.length > newChecks.length || newChecks.length > oldChecks.length + 1) throw new Error('Verification attempt history is immutable.');
    oldChecks.forEach((check, index) => {
      const settled = newChecks[index]!;
      const allowedSettlement = check.terminalDigest === null && settled.terminalDigest !== null
        && equal({ ...settled, afterRef: null, terminalDigest: null, fingerprint: null }, check);
      if (!equal(check, settled) && !allowedSettlement) throw new Error('Verification check binding is immutable.');
    });
  }
}
