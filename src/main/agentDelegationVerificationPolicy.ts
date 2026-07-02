import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { coerceString } from '../core/agentMarkdown';
import type { AgentRunScope, AgentRunSubmissionProjection } from '../core/agentEventLog';
import type {
  AgentRunFileChanges,
  AgentRunNodeChanges,
} from '../core/agentTypes';
import {
  isToolEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import {
  piToolResultTextContent,
} from './agentToolOutputSlimming';

const MAX_RECORDED_TOOL_TRACE_ENTRIES = 40;
const MAX_WORKING_SET_SNAPSHOT_FILES = 500;
const WORKING_SET_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'release']);

export interface AgentRunToolTraceEntry {
  toolName: string;
  isError: boolean;
  status?: string;
  summary?: string;
}

interface WorkingSetFileSnapshot {
  filePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface WorkingSetSnapshot {
  files: Map<string, WorkingSetFileSnapshot>;
  truncated: boolean;
}

export interface VerifiableRunState {
  id: string;
  objective?: string;
  prompt: string;
  criteria?: readonly string[];
  status: string;
  objectiveStatus?: string;
  incomplete?: boolean;
  error?: string;
  result?: string;
  nodeChanges: AgentRunNodeChanges;
  fileChanges: AgentRunFileChanges;
  toolTrace: readonly AgentRunToolTraceEntry[];
  latestSubmission?: AgentRunSubmissionProjection;
}

export function buildVerifierObjective(run: VerifiableRunState): string {
  const nodeChanges = compactNodeChanges(run.nodeChanges) ?? {};
  const fileChanges = compactFileChanges(run.fileChanges) ?? {};
  return [
    'You are an independent verifier Run. Inspect the submitted child Run result and return only compact JSON with this exact shape:',
    '{"verdict":"pass"|"fail","gap":"short reason when fail"}',
    '',
    'Rules:',
    '1. Do not accept claims without evidence in the result or inspectable state.',
    '2. Use only read-only tools when inspection is needed.',
    '3. Fail if any acceptance criterion is incomplete, ambiguous, or unverifiable.',
    '4. Your final message MUST be the JSON object and nothing else — no prose, no code fences. A passing run REQUIRES "verdict":"pass"; any other final message is read as a failure.',
    '',
    `Run id: ${run.id}`,
    `Objective:\n${run.objective ?? run.prompt}`,
    '',
    'Acceptance criteria:',
    ...(run.criteria ?? []).map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    `Execution status: ${run.status}`,
    `Objective status before verification: ${run.objectiveStatus ?? 'unknown'}`,
    run.incomplete ? 'The worker was marked incomplete.' : '',
    run.error ? `Worker error:\n${run.error}` : '',
    '',
    `Worker result:\n${latestRunSubmissionSummary(run) ?? run.result ?? 'No text result.'}`,
    '',
    `Node changes:\n${JSON.stringify(nodeChanges, null, 2)}`,
    '',
    `File changes:\n${JSON.stringify(fileChanges, null, 2)}`,
    '',
    `Tool trace:\n${JSON.stringify(run.toolTrace, null, 2)}`,
  ].filter(Boolean).join('\n');
}

export function buildControllerReplanPrompt(run: Pick<VerifiableRunState, 'objective' | 'prompt' | 'criteria'>, gap: string): string {
  return [
    'Your previous submission did not pass independent verification.',
    '',
    `Verifier gap: ${gap || 'The verifier rejected the result without a detailed gap.'}`,
    '',
    'Continue the same objective. Address the verifier gap directly, then submit a concise final result that maps to the acceptance criteria.',
    '',
    `Objective:\n${run.objective ?? run.prompt}`,
    '',
    'Acceptance criteria:',
    ...(run.criteria ?? []).map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join('\n');
}

export function buildReplacementWorkerObjective(objective: string, gap: string): string {
  return [
    objective,
    '',
    `Verifier gap from the previous worker attempt: ${gap || 'The verifier rejected the result without a detailed gap.'}`,
    'Produce a fresh result that directly closes this gap.',
  ].join('\n');
}

export function latestRunSubmissionSummary(run: Pick<VerifiableRunState, 'latestSubmission'>): string | undefined {
  return run.latestSubmission?.summary.trim() || undefined;
}

export function recordNodeToolChanges(
  changes: AgentRunNodeChanges,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  if (isError) return;
  if (toolName === 'node_delete') {
    const details = isPlainRecord(result) ? result.details : undefined;
    if (!isToolEnvelope(details) || !details.ok || details.status === 'unchanged' || !isPlainRecord(details.data)) return;
    appendUniqueNodeIds(changes, 'trashedNodeIds', stringArray(details.data.deletedNodeIds));
    appendUniqueNodeIds(changes, 'updatedNodeIds', stringArray(details.data.restoredNodeIds));
    return;
  }
  if (toolName !== 'node_create' && toolName !== 'node_edit') return;
  const details = isPlainRecord(result) ? result.details : undefined;
  if (!isToolEnvelope(details) || !details.ok || details.status === 'unchanged' || !isPlainRecord(details.data)) return;

  const created = stringArray(details.data.createdNodeIds);
  appendUniqueNodeIds(changes, 'createdNodeIds', created);

  if (toolName !== 'node_edit') return;
  if (details.data.status !== 'updated') return;
  const trashed = stringArray(details.data.trashedNodeIds);
  appendUniqueNodeIds(changes, 'trashedNodeIds', trashed);
  const changedExisting = stringArray(details.data.affectedNodeIds)
    .filter((nodeId) => !created.includes(nodeId) && !trashed.includes(nodeId));
  appendUniqueNodeIds(changes, 'updatedNodeIds', changedExisting);
}

export function recordFileToolChanges(
  changes: AgentRunFileChanges,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  if (isError) return;
  if (toolName !== 'file_edit' && toolName !== 'file_write' && toolName !== 'file_delete') return;
  const details = isPlainRecord(result) ? result.details : undefined;
  if (!isToolEnvelope(details) || !details.ok || details.status === 'unchanged' || !isPlainRecord(details.data)) return;

  const filePath = coerceString(details.data.filePath);
  if (!filePath) return;
  if (toolName === 'file_delete') {
    appendUniqueStrings(changes, 'deletedPaths', [filePath]);
    appendFilePatch(changes, {
      filePath,
      operation: 'delete',
      trashPath: coerceString(details.data.trashPath),
      kind: coerceString(details.data.kind),
    });
    return;
  }

  const operation = toolName === 'file_write' && details.data.type === 'create' ? 'create' : 'update';
  appendUniqueStrings(changes, operation === 'create' ? 'createdPaths' : 'updatedPaths', [filePath]);
  appendFilePatch(changes, {
    filePath,
    operation,
    structuredPatch: normalizeStructuredPatch(details.data.structuredPatch),
  });
}

export function recordToolTrace(
  trace: AgentRunToolTraceEntry[],
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const details = isPlainRecord(result) ? result.details : undefined;
  const entry: AgentRunToolTraceEntry = { toolName, isError };
  if (isToolEnvelope(details)) {
    entry.status = details.status;
    entry.summary = summarizeToolEnvelopeForVerifier(details);
  } else if (isPlainRecord(result) && Array.isArray(result.content)) {
    entry.summary = truncate(piToolResultTextContent(result.content as Array<TextContent | ImageContent>) ?? '', 500);
  }
  trace.push(entry);
  if (trace.length > MAX_RECORDED_TOOL_TRACE_ENTRIES) {
    trace.splice(0, trace.length - MAX_RECORDED_TOOL_TRACE_ENTRIES);
  }
}

export function compactNodeChanges(changes: AgentRunNodeChanges): AgentRunNodeChanges | undefined {
  const compacted: AgentRunNodeChanges = {};
  if (changes.createdNodeIds?.length) compacted.createdNodeIds = changes.createdNodeIds;
  if (changes.updatedNodeIds?.length) compacted.updatedNodeIds = changes.updatedNodeIds;
  if (changes.trashedNodeIds?.length) compacted.trashedNodeIds = changes.trashedNodeIds;
  return Object.keys(compacted).length ? compacted : undefined;
}

export function compactFileChanges(changes: AgentRunFileChanges): AgentRunFileChanges | undefined {
  const compacted: AgentRunFileChanges = {};
  if (changes.createdPaths?.length) compacted.createdPaths = changes.createdPaths;
  if (changes.updatedPaths?.length) compacted.updatedPaths = changes.updatedPaths;
  if (changes.deletedPaths?.length) compacted.deletedPaths = changes.deletedPaths;
  if (changes.patches?.length) compacted.patches = changes.patches;
  return Object.keys(compacted).length ? compacted : undefined;
}

export async function captureWorkingSetSnapshot(localRoot: string, scope: AgentRunScope | undefined): Promise<WorkingSetSnapshot> {
  const root = path.resolve(localRoot);
  const startPaths = scope?.resources?.paths?.length
    ? scope.resources.paths.map((entry) => resolveScopedPath(root, entry)).filter((entry): entry is string => entry !== null)
    : [root];
  const snapshot: WorkingSetSnapshot = { files: new Map(), truncated: false };
  for (const startPath of startPaths) {
    if (snapshot.truncated) break;
    await walkWorkingSetPath(root, startPath, snapshot);
  }
  return snapshot;
}

export async function recordWorkingSetDiff(
  changes: AgentRunFileChanges,
  localRoot: string,
  before: WorkingSetSnapshot,
  scope: AgentRunScope | undefined,
): Promise<void> {
  const after = await captureWorkingSetSnapshot(localRoot, scope);
  if (before.truncated || after.truncated) {
    appendFilePatch(changes, {
      filePath: '<working-set-snapshot>',
      operation: 'update',
      structuredPatch: [{
        source: 'working-set-snapshot',
        warning: 'Snapshot file limit reached; indirect file evidence may be incomplete.',
        maxFiles: MAX_WORKING_SET_SNAPSHOT_FILES,
      }],
    });
  }

  // Files the file tools already recorded carry precise structured patches; the
  // snapshot exists only to surface out-of-band edits (shell scripts, etc.).
  // Skip the tool-recorded paths so the verifier is not handed the same file
  // twice in two divergent formats. Tool paths and snapshot keys are absolute.
  const toolRecorded = new Set<string>([
    ...(changes.createdPaths ?? []),
    ...(changes.updatedPaths ?? []),
    ...(changes.deletedPaths ?? []),
  ]);

  for (const [filePath, afterFile] of after.files) {
    if (toolRecorded.has(filePath)) continue;
    const beforeFile = before.files.get(filePath);
    if (!beforeFile) {
      appendUniqueStrings(changes, 'createdPaths', [filePath]);
      appendFilePatch(changes, {
        filePath,
        operation: 'create',
        structuredPatch: [workingSetPatch('created', undefined, afterFile)],
      });
      continue;
    }
    if (workingSetFileChanged(beforeFile, afterFile)) {
      appendUniqueStrings(changes, 'updatedPaths', [filePath]);
      appendFilePatch(changes, {
        filePath,
        operation: 'update',
        structuredPatch: [workingSetPatch('updated', beforeFile, afterFile)],
      });
    }
  }

  for (const [filePath, beforeFile] of before.files) {
    if (after.files.has(filePath) || toolRecorded.has(filePath)) continue;
    appendUniqueStrings(changes, 'deletedPaths', [filePath]);
    appendFilePatch(changes, {
      filePath,
      operation: 'delete',
      structuredPatch: [workingSetPatch('deleted', beforeFile, undefined)],
    });
  }
}

export function parseVerifierVerdict(text: string): { verdict: 'pass' | 'fail'; gap: string } {
  const trimmed = text.trim();
  const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (isPlainRecord(parsed)) {
        const verdict = coerceString(parsed.verdict)?.trim().toLowerCase();
        const gap = coerceString(parsed.gap)?.trim() ?? '';
        if (verdict === 'pass') return { verdict: 'pass', gap };
        if (verdict === 'fail') return { verdict: 'fail', gap };
      }
    } catch {
      // Fall through to the text heuristic.
    }
  }
  if (/\bverdict\s*[:=]\s*pass\b/i.test(trimmed) || /"verdict"\s*:\s*"pass"/i.test(trimmed)) {
    return { verdict: 'pass', gap: '' };
  }
  const gap = trimmed || 'Verifier did not return a parseable pass verdict.';
  return { verdict: 'fail', gap: truncate(gap, 1_000) };
}

export function verifierGapSignature(gap: string): string {
  return gap.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 240) || 'unknown-gap';
}

export function sameTailCount(values: readonly string[], value: string): number {
  let count = 0;
  for (let index = values.length - 1; index >= 0 && values[index] === value; index -= 1) {
    count += 1;
  }
  return count;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function normalizeStructuredPatch(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 50).map((entry) => isPlainRecord(entry) ? { ...entry } : entry);
}

async function walkWorkingSetPath(root: string, targetPath: string, snapshot: WorkingSetSnapshot): Promise<void> {
  if (snapshot.truncated || !isInsidePath(root, targetPath)) return;
  let entryStat;
  try {
    entryStat = await stat(targetPath);
  } catch {
    return;
  }
  if (entryStat.isDirectory()) {
    if (WORKING_SET_EXCLUDED_DIRS.has(path.basename(targetPath))) return;
    let entries;
    try {
      entries = await readdir(targetPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.truncated) return;
      if (entry.isDirectory() && WORKING_SET_EXCLUDED_DIRS.has(entry.name)) continue;
      await walkWorkingSetPath(root, path.join(targetPath, entry.name), snapshot);
    }
    return;
  }
  if (!entryStat.isFile()) return;
  if (snapshot.files.size >= MAX_WORKING_SET_SNAPSHOT_FILES) {
    snapshot.truncated = true;
    return;
  }
  const relativePath = path.relative(root, targetPath) || path.basename(targetPath);
  // Stat only - no content hashing. Hashing every file in the tree twice (before
  // and after each verified run) was the dominant snapshot cost; size + mtime is
  // a cheap, reliable change signal for the out-of-band edits this snapshot is
  // meant to catch (tool edits already carry precise patches and are deduped out).
  snapshot.files.set(targetPath, {
    filePath: targetPath,
    relativePath,
    size: entryStat.size,
    mtimeMs: Math.trunc(entryStat.mtimeMs),
  });
}

function resolveScopedPath(root: string, input: string): string | null {
  const resolved = path.resolve(path.isAbsolute(input) ? input : path.join(root, input));
  return isInsidePath(root, resolved) ? resolved : null;
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function workingSetFileChanged(before: WorkingSetFileSnapshot, after: WorkingSetFileSnapshot): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function workingSetPatch(
  change: 'created' | 'updated' | 'deleted',
  before: WorkingSetFileSnapshot | undefined,
  after: WorkingSetFileSnapshot | undefined,
): Record<string, unknown> {
  return {
    source: 'working-set-snapshot',
    change,
    relativePath: after?.relativePath ?? before?.relativePath,
    before: before ? { size: before.size } : undefined,
    after: after ? { size: after.size } : undefined,
  };
}

function summarizeToolEnvelopeForVerifier(details: ToolEnvelope): string | undefined {
  if (details.error) return truncate(`${details.error.code}: ${details.error.message}`, 500);
  if (!isPlainRecord(details.data)) return undefined;
  const summary: Record<string, unknown> = {};
  for (const key of ['filePath', 'trashPath', 'type', 'kind', 'status', 'nodeId', 'createdNodeIds', 'affectedNodeIds', 'deletedNodeIds', 'restoredNodeIds']) {
    if (details.data[key] !== undefined) summary[key] = details.data[key];
  }
  if (Array.isArray(details.data.structuredPatch)) summary.structuredPatch = details.data.structuredPatch.slice(0, 10);
  return Object.keys(summary).length ? truncate(JSON.stringify(summary), 1_000) : undefined;
}

function appendUniqueStrings(
  changes: AgentRunFileChanges,
  key: 'createdPaths' | 'updatedPaths' | 'deletedPaths',
  values: readonly string[],
): void {
  if (values.length === 0) return;
  const current = changes[key] ?? [];
  const existing = new Set(current);
  const next = [...current];
  for (const value of values) {
    if (existing.has(value)) continue;
    existing.add(value);
    next.push(value);
  }
  changes[key] = next;
}

function appendFilePatch(
  changes: AgentRunFileChanges,
  patch: NonNullable<AgentRunFileChanges['patches']>[number],
): void {
  changes.patches ??= [];
  changes.patches.push(patch);
  if (changes.patches.length > 50) changes.patches.splice(0, changes.patches.length - 50);
}

function appendUniqueNodeIds(
  changes: AgentRunNodeChanges,
  key: keyof AgentRunNodeChanges,
  nodeIds: readonly string[],
): void {
  if (nodeIds.length === 0) return;
  const current = changes[key] ?? [];
  const existing = new Set(current);
  const next = [...current];
  for (const nodeId of nodeIds) {
    if (existing.has(nodeId)) continue;
    existing.add(nodeId);
    next.push(nodeId);
  }
  changes[key] = next;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
