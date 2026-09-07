import { createHash } from 'node:crypto';
import {
  MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES,
  type ContextEvidenceThreadItem,
  type JsonValue,
  type Thread,
  type ThreadId,
  type ThreadItem,
  type ThreadItemId,
  type ThreadTrajectoryAvailability,
  type ThreadTrajectoryDetailReadRequest,
  type ThreadTrajectoryDetailReadResponse,
  type ThreadTrajectoryDiagnosticsEvidence,
  type ThreadTrajectoryEvidenceRef,
  type ThreadTrajectoryItemEvidence,
  type ThreadTrajectoryModelImagePart,
  type ThreadTrajectoryModelInputPart,
  type ThreadTrajectoryModelOutputPart,
  type ThreadTrajectoryProviderCallEvidence,
  type ThreadTrajectoryReadRequest,
  type ThreadTrajectoryReadResponse,
  type ThreadTrajectoryRecordLabel,
  type ThreadTrajectoryRecordKind,
  type ThreadTrajectoryRecordSummary,
  type ThreadTrajectoryReplacementRange,
  type ThreadTrajectoryRuntimeEvidence,
  type ThreadTrajectorySummary,
  type ThreadTrajectoryTimingSummary,
  type ThreadTrajectoryTurnEvidence,
  type ThreadTrajectoryUsageSummary,
  type ThreadTrajectoryUserMessageEvidence,
  type Turn,
  type TurnId,
  type TurnDiagnosticsPayload,
  type TurnDiagnosticsPayloadReference,
  type TurnDiagnosticsSystemContextEntry,
  type UserMessageThreadItem,
} from '../../../core/agent/protocol';
import { modelCallArgumentSource } from '../../../core/agent/modelCallHistory';
import { rehydrateLargeTextArguments } from '../runtime/largeTextArguments';
import { ThreadCore } from './ThreadCore';
import type { ThreadTrajectoryTurnOverview } from '../persistence/ThreadHistoryProjectionStore';

const DEFAULT_TRAJECTORY_LIMIT = 100;
const MAX_TRAJECTORY_LIMIT = 250;
const PREVIEW_LIMIT = 240;
const MAX_TRAJECTORY_TOOL_CALL_ID_BYTES = 512;
const TRAJECTORY_TOOL_CALL_DIGEST_PREFIX = 'tenon:tool-call:sha256:';
const DIAGNOSTICS_READ_CONCURRENCY = 4;
const TRAJECTORY_ORDER_COMPONENT_WIDTH = 13;
const TRAJECTORY_TURN_SCAN_BATCH = 8;
const MAX_CACHED_TRAJECTORY_RECORDS = MAX_TRAJECTORY_LIMIT * 3;
const MAX_CACHED_TRAJECTORY_TURNS = MAX_TRAJECTORY_LIMIT * 3;

type DiagnosticsBundle = {
  readonly ref: TurnDiagnosticsPayloadReference;
  readonly payload: TurnDiagnosticsPayload;
};

type TrajectoryCursor = {
  readonly direction: 'before' | 'after';
  readonly recordId: string;
};

type TrajectoryPage = {
  readonly data: readonly ThreadTrajectoryRecordSummary[];
  readonly replacementRange: ThreadTrajectoryReplacementRange | null;
  readonly olderCursor: string | null;
  readonly newerCursor: string | null;
};

type TrajectoryToolExecution = Extract<
  TurnDiagnosticsPayload['activities'][number],
  { readonly type: 'toolExecutionBatch' }
>['executions'][number];

interface LoadedTurn {
  readonly threadId: ThreadId;
  readonly turn: Turn;
  readonly turnIndex: number;
  readonly diagnostics: DiagnosticsBundle | null;
  readonly availability: readonly ThreadTrajectoryAvailability[];
  readonly projectionCandidate: TurnProjectionCandidate | null;
}

interface BuiltTrajectory {
  readonly thread: Thread;
  readonly turns: readonly LoadedTurn[];
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly summary: ThreadTrajectorySummary;
}

interface BuiltTrajectoryWindow {
  readonly turns: readonly LoadedTurn[];
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly summary: ThreadTrajectorySummary;
  readonly replacementRange: ThreadTrajectoryReplacementRange | null;
  readonly olderCursor: string | null;
  readonly newerCursor: string | null;
}

interface TurnWindow {
  readonly end: number;
  readonly start: number;
}

interface TrajectoryProjectionState {
  stablePromptFingerprint: string | null | undefined;
  toolCatalogFingerprint: string | null | undefined;
}

interface ProjectedTrajectoryRecords {
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly state: TrajectoryProjectionState;
}

interface TurnProjectionCandidate {
  readonly availability: readonly ThreadTrajectoryAvailability[];
  readonly diagnosticsAvailable: boolean;
  readonly finalToolCatalogFingerprint: string | undefined;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly stablePromptFingerprint: string | null;
  readonly toolCatalogs: ReadonlyMap<string, {
    readonly empty: boolean;
    readonly fingerprint: string;
  }>;
}

interface CachedTurnProjection {
  readonly candidate: TurnProjectionCandidate;
  readonly key: string;
}

interface DetailReadResult {
  readonly detail: NonNullable<ThreadTrajectoryDetailReadResponse['detail']>;
  readonly availability: readonly ThreadTrajectoryAvailability[];
}

interface EvidenceReadResult<T> {
  readonly value: T;
  readonly availability: readonly ThreadTrajectoryAvailability[];
}

export class ThreadTrajectoryProjection {
  private readonly completedTurnProjectionCache = new Map<string, CachedTurnProjection>();
  private cachedTrajectoryRecordCount = 0;

  constructor(
    private readonly core: ThreadCore,
    private readonly now: () => number = Date.now,
    private readonly readActiveDiagnostics: (
      (threadId: ThreadId, turnId: TurnId) => TurnDiagnosticsPayload | null
  ) | null = null,
  ) {}

  async read(request: ThreadTrajectoryReadRequest): Promise<ThreadTrajectoryReadResponse> {
    const built = await this.buildWindow(request);
    const selectedRecordId = selectRecordId(built.records, request);
    return {
      threadId: request.threadId,
      summary: built.summary,
      records: built.records,
      replacementRange: built.replacementRange,
      olderCursor: built.olderCursor,
      newerCursor: built.newerCursor,
      hasOlder: built.olderCursor !== null,
      hasNewer: built.newerCursor !== null,
      selectedRecordId,
    };
  }

  async readDetail(request: ThreadTrajectoryDetailReadRequest): Promise<ThreadTrajectoryDetailReadResponse> {
    const built = await this.buildDetailWindow(request.threadId, request.recordId);
    if (!built) return { threadId: request.threadId, record: null, detail: null };
    const record = built.records.find((candidate) => candidate.id === request.recordId) ?? null;
    if (!record) return { threadId: request.threadId, record: null, detail: null };
    const loaded = built.turns.find((candidate) => candidate.turn.id === record.turnId) ?? null;
    if (!loaded) return { threadId: request.threadId, record, detail: null };
    const result = await this.detailForRecord(record, loaded);
    return {
      threadId: request.threadId,
      record: withAvailability(record, result.availability),
      detail: result.detail,
    };
  }

  private async buildWindow(request: ThreadTrajectoryReadRequest): Promise<BuiltTrajectoryWindow> {
    this.core.requireThread(request.threadId);
    const overview = this.core.trajectoryTurnOverview(request.threadId);
    const loadedByIndex = new Map<number, LoadedTurn>();
    let window = initialTurnWindowForTrajectoryRead(
      overview.turnCount,
      trajectoryAnchorTurnPosition(this.core, request),
    );
    let projected: ProjectedTrajectoryRecords = {
      records: [],
      state: initialProjectionState(),
    };
    let loaded: readonly LoadedTurn[] = [];
    while (window.start < window.end) {
      await this.loadMissingTurnIndexes(request.threadId, window, loadedByIndex);
      const predecessor = window.start > 0 ? loadedByIndex.get(window.start - 1) ?? null : null;
      loaded = turnRangeFromMap(loadedByIndex, window.start, window.end);
      projected = this.projectRecords(loaded, projectionStateAfter(predecessor));
      const expansion = trajectoryWindowExpansion(projected.records, request, window, overview.turnCount);
      if (!expansion) break;
      window = expansion;
    }
    const page = pageTrajectoryRecords(projected.records, request, window, overview.turnCount);
    return {
      turns: loaded,
      records: page.data,
      summary: summarizeTrajectory(request.threadId, overview, loaded),
      replacementRange: page.replacementRange,
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
    };
  }

  private async buildDetailWindow(threadId: ThreadId, recordId: string): Promise<BuiltTrajectory | null> {
    const thread = this.core.requireThread(threadId).thread;
    const turnId = turnIdFromTrajectoryRecordId(recordId);
    if (!turnId) return null;
    const turnIndex = this.core.trajectoryTurnPosition(threadId, turnId);
    if (turnIndex === null) return null;
    const overview = this.core.trajectoryTurnOverview(threadId);
    const loadedByIndex = new Map<number, LoadedTurn>();
    const window = { start: turnIndex, end: turnIndex + 1 };
    await this.loadMissingTurnIndexes(threadId, window, loadedByIndex, false);
    const materialized = turnRangeFromMap(
      loadedByIndex,
      Math.max(0, turnIndex - 1),
      turnIndex + 1,
    );
    const predecessor = turnIndex > 0 ? materialized[0] ?? null : null;
    const turns = predecessor ? materialized.slice(1) : materialized;
    const records = this.projectRecords(turns, projectionStateAfter(predecessor)).records;
    return {
      thread,
      turns,
      records,
      summary: summarizeTrajectory(threadId, overview, materialized),
    };
  }

  private async loadMissingTurnIndexes(
    threadId: ThreadId,
    window: TurnWindow,
    loadedByIndex: Map<number, LoadedTurn>,
    useProjectionCache = true,
  ): Promise<void> {
    const start = Math.max(0, window.start - 1);
    const missing: Array<{ readonly turn: Turn; readonly turnIndex: number }> = [];
    let rangeStart: number | null = null;
    for (let turnIndex = start; turnIndex <= window.end; turnIndex += 1) {
      const missingIndex = turnIndex < window.end && !loadedByIndex.has(turnIndex);
      if (missingIndex && rangeStart === null) rangeStart = turnIndex;
      if (missingIndex || rangeStart === null) continue;
      const headers = this.core.trajectoryTurnRange(threadId, rangeStart, turnIndex, 'notLoaded');
      for (const [offset, header] of headers.entries()) {
        missing.push({ turn: header, turnIndex: rangeStart + offset });
      }
      rangeStart = null;
    }
    const loaded = await this.loadTurns(threadId, missing, useProjectionCache);
    for (const turn of loaded) loadedByIndex.set(turn.turnIndex, turn);
  }

  private async loadTurns(
    threadId: ThreadId,
    turns: readonly { readonly turn: Turn; readonly turnIndex: number }[],
    useProjectionCache = true,
  ): Promise<readonly LoadedTurn[]> {
    return await mapWithConcurrency(turns, DIAGNOSTICS_READ_CONCURRENCY, async ({ turn, turnIndex }) => {
      const cacheKey = completedTurnProjectionCacheKey(threadId, turn);
      const cached = useProjectionCache && cacheKey
        ? this.completedTurnProjectionCache.get(cacheKey) ?? null
        : null;
      if (cacheKey && cached) {
        this.completedTurnProjectionCache.delete(cacheKey);
        this.completedTurnProjectionCache.set(cacheKey, cached);
        return {
          threadId,
          turn,
          turnIndex,
          diagnostics: null,
          availability: cached.candidate.availability,
          projectionCandidate: cached.candidate,
        };
      }
      const materializedTurn = this.core.readTurn(threadId, turn.id) ?? turn;
      const diagnostics = await this.readDiagnostics(threadId, materializedTurn);
      const loaded = {
        threadId,
        turn: materializedTurn,
        turnIndex,
        diagnostics: diagnostics.bundle,
        availability: diagnostics.availability,
        projectionCandidate: null,
      };
      if (cacheKey && diagnostics.bundle) {
        const candidate = turnProjectionCandidate(loaded);
        this.cacheCompletedTurnProjection({ key: cacheKey, candidate });
        return { ...loaded, projectionCandidate: candidate };
      }
      return {
        ...loaded,
        projectionCandidate: null,
      };
    });
  }

  private projectRecords(
    turns: readonly LoadedTurn[],
    initialState: TrajectoryProjectionState,
  ): ProjectedTrajectoryRecords {
    const records: ThreadTrajectoryRecordSummary[] = [];
    let state = initialState;
    for (const loaded of turns) {
      const candidate = loaded.projectionCandidate ?? turnProjectionCandidate(loaded);
      const projected = projectTurnCandidate(candidate, state);
      records.push(...projected.records);
      state = projected.state;
    }
    return {
      records: assignTrajectoryStepIndices(records),
      state,
    };
  }

  private cacheCompletedTurnProjection(entry: CachedTurnProjection): void {
    if (entry.candidate.records.length > MAX_CACHED_TRAJECTORY_RECORDS) return;
    const previous = this.completedTurnProjectionCache.get(entry.key);
    if (previous) {
      this.completedTurnProjectionCache.delete(entry.key);
      this.cachedTrajectoryRecordCount -= previous.candidate.records.length;
    }
    this.completedTurnProjectionCache.set(entry.key, entry);
    this.cachedTrajectoryRecordCount += entry.candidate.records.length;
    while (
      this.cachedTrajectoryRecordCount > MAX_CACHED_TRAJECTORY_RECORDS
      || this.completedTurnProjectionCache.size > MAX_CACHED_TRAJECTORY_TURNS
    ) {
      const oldestKey = this.completedTurnProjectionCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.completedTurnProjectionCache.get(oldestKey);
      this.completedTurnProjectionCache.delete(oldestKey);
      this.cachedTrajectoryRecordCount -= oldest?.candidate.records.length ?? 0;
    }
  }

  private async readDiagnostics(
    threadId: ThreadId,
    turn: Turn,
  ): Promise<{
    readonly bundle: DiagnosticsBundle | null;
    readonly availability: readonly ThreadTrajectoryAvailability[];
  }> {
    const ref = turn.execution.diagnosticsRef;
    if (!ref) {
      const activePayload = turn.status === 'inProgress'
        ? this.readActiveDiagnostics?.(threadId, turn.id) ?? null
        : null;
      if (activePayload) {
        const activeBundle = activeDiagnosticsBundle(activePayload);
        if (activeBundle) return { bundle: activeBundle, availability: [] };
        return {
          bundle: null,
          availability: [availability('diagnosticsUnavailable')],
        };
      }
      return {
        bundle: null,
        availability: turn.status === 'inProgress'
          ? []
          : [availability('diagnosticsUnavailable')],
      };
    }
    try {
      const payload = await this.core.payloads.readTurnDiagnostics(threadId, ref);
      if (!payload) {
        return {
          bundle: null,
          availability: [availability('diagnosticsUnavailable')],
        };
      }
      return { bundle: { ref, payload }, availability: [] };
    } catch {
      return {
        bundle: null,
        availability: [availability('diagnosticsCorrupt')],
      };
    }
  }

  private async detailForRecord(
    record: ThreadTrajectoryRecordSummary,
    loaded: LoadedTurn,
  ): Promise<DetailReadResult> {
    const diagnostics = loaded.diagnostics;
    if (record.kind === 'input') {
      const message = userMessageForEvidence(loaded.turn, record.primaryEvidence);
      const activityIndex = relatedDiagnosticActivityIndex(record, 'acceptedInput');
      const providerCallIndex = relatedProviderCallIndex(record);
      const modelInputParts = message
        ? modelInputPartsForItem(diagnostics?.payload ?? null, message.id, providerCallIndex)
        : null;
      const messageEvidence = message ? userMessageEvidence(message) : null;
      const diagnosticEvidence = diagnosticsEvidence(diagnostics, activityIndex, providerCallIndex);
      return detailRead({
        kind: 'input',
        turn: turnEvidence(loaded.turn),
        modelInputParts,
        message: messageEvidence,
        diagnostics: diagnosticEvidence,
        activityIndex,
      });
    }
    if (record.kind === 'context') {
      const item = itemForEvidence(loaded.turn, record.primaryEvidence);
      const modelContextText = modelContextTextForContextRecord(
        loaded.diagnostics?.payload ?? null,
        record,
      );
      const payload = record.primaryEvidence.type === 'stablePrompt'
        ? stablePromptEvidence(loaded.diagnostics)
        : record.primaryEvidence.type === 'toolCatalog'
          ? toolCatalogEvidence(loaded.diagnostics?.payload ?? null, record.primaryEvidence.callIndex)
          : null;
      return detailRead({
        kind: 'context',
        turn: turnEvidence(loaded.turn),
        item: item ? itemEvidence(item) : null,
        modelContextText,
        payload,
      });
    }
    if (record.kind === 'assistant') {
      const providerCallIndex = providerCallIndexForEvidence(record.primaryEvidence);
      const call = providerCallIndex === null
        ? null
        : diagnostics?.payload.providerCalls[providerCallIndex] ?? null;
      const modelOutputParts = modelOutputPartsForResponse(call?.response?.value ?? null);
      const diagnosticEvidence = diagnosticsEvidence(diagnostics, null, providerCallIndex ?? 0);
      const relatedItems = evidenceForItems(loaded.turn, relatedItemIds(record));
      return detailRead({
        kind: 'assistant',
        turn: turnEvidence(loaded.turn),
        modelOutputParts,
        diagnostics: diagnosticEvidence,
        providerCallIndex: providerCallIndex ?? 0,
        relatedItems,
      });
    }
    if (record.kind === 'tool') {
      const item = itemForToolRecord(loaded.turn, record);
      const execution = toolExecutionForRecord(loaded.diagnostics?.payload ?? null, record);
      const [input, output] = await Promise.all([
        this.readToolInput(
          record.threadId,
          loaded.diagnostics?.payload ?? null,
          diagnosticActivityIndex(record.primaryEvidence),
          execution,
          item,
        ),
        this.readToolOutput(record.threadId, item),
      ]);
      const schema = toolSchemaEvidence(loaded.diagnostics?.payload ?? null, execution?.toolName ?? null);
      return detailRead({
        kind: 'tool',
        turn: turnEvidence(loaded.turn),
        item: item ? itemEvidence(item) : null,
        diagnostics: diagnosticsEvidence(
          diagnostics,
          diagnosticActivityIndex(record.primaryEvidence),
          null,
        ),
        activityIndex: diagnosticActivityIndex(record.primaryEvidence),
        executionCallId: execution?.callId ?? null,
        input: input.value,
        outputText: output.value,
        schema,
      }, [...input.availability, ...output.availability]);
    }
    if (record.kind === 'retry') {
      return detailRead({
        kind: 'retry',
        turn: turnEvidence(loaded.turn),
        diagnostics: diagnosticsEvidence(
          diagnostics,
          diagnosticActivityIndex(record.primaryEvidence),
          null,
        ),
        activityIndex: diagnosticActivityIndex(record.primaryEvidence),
      });
    }
    if (record.kind === 'compaction') {
      const item = itemForEvidence(loaded.turn, record.primaryEvidence)
        ?? itemForRelatedEvidence(loaded.turn, record);
      const summary = await this.readCompactionSummary(record.threadId, item);
      return detailRead({
        kind: 'compaction',
        turn: turnEvidence(loaded.turn),
        item: item ? itemEvidence(item) : null,
        diagnostics: diagnosticsEvidence(
          diagnostics,
          diagnosticActivityIndex(record.primaryEvidence),
          null,
        ),
        activityIndex: diagnosticActivityIndex(record.primaryEvidence),
        summaryText: summary.value,
      }, summary.availability);
    }
    throw new Error(`Unsupported Trajectory record kind: ${record.kind}`);
  }

  private async readToolInput(
    threadId: ThreadId,
    diagnostics: TurnDiagnosticsPayload | null,
    activityIndex: number | null,
    execution: TrajectoryToolExecution | null,
    item: ThreadItem | null,
  ): Promise<EvidenceReadResult<JsonValue | null>> {
    if (diagnostics) {
      if (activityIndex === null || !execution) return unavailableEvidence('evidenceUnavailable');
      return providerToolInputEvidence(diagnostics, activityIndex, execution);
    }
    if (!item || !('modelCall' in item)) return retainedEvidence(null);
    if (item.modelCall.disposition !== 'replayable') return unavailableEvidence('evidenceUnavailable');
    const source = modelCallArgumentSource(item.modelCall);
    if (source.storage === 'inline') {
      return retainedEvidence(structuredClone(source.value));
    }
    try {
      const payload = await this.core.payloads.readContext(threadId, source.ref);
      if (payload?.kind !== 'toolCallArguments') return unavailableEvidence('payloadUnavailable');
      const rehydrated = await rehydrateLargeTextArguments(
        payload,
        source.internalTextRefs,
        (ref) => this.core.payloads.readInternalText(threadId, ref),
      );
      return rehydrated === null
        ? unavailableEvidence('payloadUnavailable')
        : retainedEvidence(rehydrated);
    } catch {
      return unavailableEvidence('payloadUnavailable');
    }
  }

  private async readToolOutput(
    threadId: ThreadId,
    item: ThreadItem | null,
  ): Promise<EvidenceReadResult<string | null>> {
    if (!item || !('outputRef' in item) || !item.outputRef) return retainedEvidence(null);
    try {
      const text = await this.core.payloads.readTextReference(threadId, item.outputRef);
      return text === null
        ? unavailableEvidence('evidenceUnavailable')
        : retainedEvidence(text);
    } catch {
      return unavailableEvidence('evidenceUnavailable');
    }
  }

  private async readCompactionSummary(
    threadId: ThreadId,
    item: ThreadItem | null,
  ): Promise<EvidenceReadResult<string | null>> {
    if (item?.type !== 'contextCompaction') return retainedEvidence(null);
    try {
      const payload = await this.core.payloads.readContext(threadId, item.summaryRef);
      return payload?.kind === 'compactionSummary'
        ? retainedEvidence(payload.text)
        : unavailableEvidence('payloadUnavailable');
    } catch {
      return unavailableEvidence('payloadUnavailable');
    }
  }
}

function detailRead(
  detail: NonNullable<ThreadTrajectoryDetailReadResponse['detail']>,
  availability: readonly ThreadTrajectoryAvailability[] = [],
): DetailReadResult {
  return { detail, availability };
}

function retainedEvidence<T>(value: T): EvidenceReadResult<T> {
  return { value, availability: [] };
}

function unavailableEvidence(
  reason: ThreadTrajectoryAvailability['reason'],
): EvidenceReadResult<null> {
  return { value: null, availability: [availability(reason)] };
}

function withAvailability(
  record: ThreadTrajectoryRecordSummary,
  additional: readonly ThreadTrajectoryAvailability[],
): ThreadTrajectoryRecordSummary {
  if (additional.length === 0) return record;
  const reasons = new Set(record.availability.map((entry) => entry.reason));
  return {
    ...record,
    availability: [
      ...record.availability,
      ...additional.filter((entry) => {
        if (reasons.has(entry.reason)) return false;
        reasons.add(entry.reason);
        return true;
      }),
    ],
  };
}

function initialProjectionState(): TrajectoryProjectionState {
  return {
    stablePromptFingerprint: null,
    toolCatalogFingerprint: null,
  };
}

function projectionStateAfter(predecessor: LoadedTurn | null): TrajectoryProjectionState {
  if (!predecessor) return initialProjectionState();
  if (predecessor.projectionCandidate) {
    return projectionBoundaryState(predecessor.projectionCandidate);
  }
  const payload = predecessor.diagnostics?.payload;
  if (!payload) {
    return {
      stablePromptFingerprint: undefined,
      toolCatalogFingerprint: undefined,
    };
  }
  const finalCall = payload.providerCalls.at(-1) ?? null;
  const finalCatalog = finalCall ? toolCatalogRecord(payload, finalCall.index) : null;
  return {
    stablePromptFingerprint: payload.stablePrompt?.fingerprints.complete ?? null,
    toolCatalogFingerprint: finalCatalog?.fingerprint,
  };
}

function completedTurnProjectionCacheKey(
  threadId: ThreadId,
  turn: Turn,
): string | null {
  const ref = turn.execution.diagnosticsRef;
  return turn.status === 'inProgress' || !ref ? null : `${threadId}:${turn.id}:${ref.id}`;
}

function turnProjectionCandidate(loaded: LoadedTurn): TurnProjectionCandidate {
  const records: ThreadTrajectoryRecordSummary[] = [];
  appendStablePromptRecord(records, loaded);
  appendToolCatalogRecords(records, loaded);
  appendTurnRecords(records, loaded);
  const payload = loaded.diagnostics?.payload ?? null;
  const finalCall = payload?.providerCalls.at(-1) ?? null;
  const finalToolCatalog = payload && finalCall
    ? toolCatalogRecord(payload, finalCall.index)
    : null;
  const toolCatalogs = new Map<string, { readonly empty: boolean; readonly fingerprint: string }>();
  if (payload) {
    for (const record of records) {
      if (record.primaryEvidence.type !== 'toolCatalog') continue;
      const catalog = toolCatalogRecord(payload, record.primaryEvidence.callIndex);
      if (catalog) {
        toolCatalogs.set(record.id, {
          empty: catalog.toolNames.length === 0,
          fingerprint: catalog.fingerprint,
        });
      }
    }
  }
  return {
    availability: loaded.availability,
    diagnosticsAvailable: loaded.diagnostics !== null,
    finalToolCatalogFingerprint: finalToolCatalog?.fingerprint,
    records,
    stablePromptFingerprint: payload?.stablePrompt?.fingerprints.complete ?? null,
    toolCatalogs,
  };
}

function projectTurnCandidate(
  candidate: TurnProjectionCandidate,
  initialState: TrajectoryProjectionState,
): ProjectedTrajectoryRecords {
  const records: ThreadTrajectoryRecordSummary[] = [];
  let stablePromptFingerprint = initialState.stablePromptFingerprint;
  let toolCatalogFingerprint = initialState.toolCatalogFingerprint;
  const nextFingerprint = candidate.stablePromptFingerprint;
  if (nextFingerprint !== null && nextFingerprint !== stablePromptFingerprint) {
    const stablePromptRecord = candidate.records.find((record) => (
      record.primaryEvidence.type === 'stablePrompt'
    ));
    if (stablePromptRecord && stablePromptFingerprint !== undefined) {
      records.push({
        ...stablePromptRecord,
        label: {
          type: 'systemPrompt',
          change: stablePromptFingerprint === null ? 'initial' : 'updated',
        },
      });
    }
    stablePromptFingerprint = nextFingerprint;
  }
  for (const record of candidate.records) {
    if (record.primaryEvidence.type === 'stablePrompt') continue;
    if (record.primaryEvidence.type !== 'toolCatalog') {
      records.push(record);
      continue;
    }
    const catalog = candidate.toolCatalogs.get(record.id);
    if (!catalog || catalog.fingerprint === toolCatalogFingerprint) continue;
    const stateKnown = toolCatalogFingerprint !== undefined;
    const initial = toolCatalogFingerprint === null;
    toolCatalogFingerprint = catalog.fingerprint;
    if (initial && catalog.empty) continue;
    if (stateKnown && record.label.type === 'toolCatalog') {
      records.push({
        ...record,
        label: { ...record.label, change: initial ? 'initial' : 'updated' },
      });
    }
  }
  if (candidate.finalToolCatalogFingerprint !== undefined) {
    toolCatalogFingerprint = candidate.finalToolCatalogFingerprint;
  }
  if (!candidate.diagnosticsAvailable) {
    stablePromptFingerprint = undefined;
    toolCatalogFingerprint = undefined;
  }
  return {
    records,
    state: { stablePromptFingerprint, toolCatalogFingerprint },
  };
}

function projectionBoundaryState(candidate: TurnProjectionCandidate): TrajectoryProjectionState {
  if (!candidate.diagnosticsAvailable) {
    return { stablePromptFingerprint: undefined, toolCatalogFingerprint: undefined };
  }
  return {
    stablePromptFingerprint: candidate.stablePromptFingerprint,
    toolCatalogFingerprint: candidate.finalToolCatalogFingerprint,
  };
}

function assignTrajectoryStepIndices(
  records: readonly ThreadTrajectoryRecordSummary[],
): readonly ThreadTrajectoryRecordSummary[] {
  const stepsByTurn = new Map<TurnId, number>();
  return [...records]
    .sort(compareTrajectoryRecords)
    .map((record) => {
      const stepIndex = stepsByTurn.get(record.turnId) ?? 0;
      stepsByTurn.set(record.turnId, stepIndex + 1);
      return { ...record, stepIndex };
    });
}

function compareTrajectoryRecords(
  left: ThreadTrajectoryRecordSummary,
  right: ThreadTrajectoryRecordSummary,
): number {
  if (left.orderKey < right.orderKey) return -1;
  if (left.orderKey > right.orderKey) return 1;
  return left.id.localeCompare(right.id);
}

function trajectoryOrderKey(order: readonly [number, number, number, number, number, number]): string {
  return order.map((component) => {
    const normalized = Number.isSafeInteger(component) && component >= 0
      ? component
      : Number.MAX_SAFE_INTEGER;
    return normalized.toString(36).padStart(TRAJECTORY_ORDER_COMPONENT_WIDTH, '0');
  }).join(':');
}

function activeDiagnosticsBundle(payload: TurnDiagnosticsPayload): DiagnosticsBundle | null {
  const encoded = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES) return null;
  return {
    ref: {
      id: createHash('sha256').update(encoded).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
      byteLength,
      schemaVersion: 1,
    },
    payload,
  };
}

function diagnosticsEvidence(
  bundle: DiagnosticsBundle | null,
  activityIndex: number | null,
  providerCallIndex: number | null,
): ThreadTrajectoryDiagnosticsEvidence | null {
  if (!bundle) return null;
  const activity = activityIndex === null ? null : bundle.payload.activities[activityIndex] ?? null;
  return {
    ref: bundle.ref,
    runtime: runtimeEvidence(bundle.payload.runtime),
    activity: activity === null ? null : exactJsonValue(activity),
    providerCall: providerCallIndex === null
      ? null
      : providerCallDiagnosticsEvidence(
        bundle.payload,
        bundle.payload.providerCalls[providerCallIndex] ?? null,
      ),
  };
}

function runtimeEvidence(runtime: TurnDiagnosticsPayload['runtime']): ThreadTrajectoryRuntimeEvidence {
  return {
    provider: runtime.provider,
    model: runtime.model,
    api: runtime.api,
    configuredBaseUrl: runtime.configuredBaseUrl,
    transportSelection: runtime.transportSelection,
    contextWindow: runtime.contextWindow,
    maxOutputTokens: runtime.maxOutputTokens,
    thinkingLevel: runtime.thinkingLevel,
    timeoutMs: runtime.timeoutMs,
    maxRetries: runtime.maxRetries,
    maxRetryDelayMs: runtime.maxRetryDelayMs,
    cacheRetention: runtime.cacheRetention,
    toolExecution: runtime.toolExecution,
    steeringMode: runtime.steeringMode,
  };
}

function providerCallDiagnosticsEvidence(
  payload: TurnDiagnosticsPayload,
  call: TurnDiagnosticsPayload['providerCalls'][number] | null,
): ThreadTrajectoryProviderCallEvidence | null {
  if (!call) return null;
  return {
    index: call.index,
    requestedAt: call.requestedAt,
    estimatedInputTokens: call.estimatedInputTokens,
    inputTokenLimit: call.inputTokenLimit,
    reservedOutputTokens: call.reservedOutputTokens,
    commonPrefixMessageCount: call.commonPrefixMessageCount,
    requestFingerprint: call.requestFingerprint,
    cacheBreakpoints: call.cacheBreakpoints,
    request: structuredClone(materializeProviderRequest(payload, call)),
    response: call.response ? exactJsonValue(call.response) : null,
    transportResponse: call.transportResponse,
  };
}

function materializeProviderRequest(
  payload: TurnDiagnosticsPayload,
  call: TurnDiagnosticsPayload['providerCalls'][number],
): JsonValue | null {
  const request = call.request;
  if (request.kind === 'value') return request.value;
  const fragments = new Map(payload.requestFragments.map((fragment) => [fragment.id, fragment.value]));
  const result: Record<string, JsonValue> = {};
  for (const field of request.fields) {
    if (field.representation === 'inline') {
      result[field.name] = field.value;
      continue;
    }
    const values: JsonValue[] = [];
    for (const id of field.fragmentIds) {
      const value = fragments.get(id);
      if (value === undefined) return null;
      values.push(value);
    }
    if (field.container === 'array') {
      result[field.name] = values;
    } else {
      const value = values[0];
      if (value === undefined) return null;
      result[field.name] = value;
    }
  }
  return result;
}

function modelContextTextForContextRecord(
  payload: TurnDiagnosticsPayload | null,
  record: ThreadTrajectoryRecordSummary,
): string | null {
  if (!payload) return null;
  if (record.primaryEvidence.type === 'stablePrompt') return stablePromptModelText(payload);
  if (record.primaryEvidence.type === 'preparedContextPart') {
    return modelContextTextForPreparedContextPart(payload, record.primaryEvidence);
  }
  return null;
}

function stablePromptModelText(payload: TurnDiagnosticsPayload): string | null {
  for (const call of payload.providerCalls) {
    const fragment = payload.requestFragments.find((candidate) => (
      candidate.id === call.preparedContext.systemPromptFragmentId
    ));
    const text = semanticText(fragment?.value ?? null);
    if (text) return text;
  }
  return null;
}

type PreparedContextPartEvidenceRef = Extract<ThreadTrajectoryEvidenceRef, { readonly type: 'preparedContextPart' }>;
interface PreparedContextPartRecord {
  readonly callIndex: number;
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly entries: readonly TurnDiagnosticsSystemContextEntry[];
  readonly text: string;
  readonly requestedAt: number;
}

interface ToolCatalogRecord {
  readonly callIndex: number;
  readonly toolNames: readonly string[];
  readonly tools: readonly JsonValue[];
  readonly fingerprint: string;
  readonly requestedAt: number;
}

function modelContextTextForPreparedContextPart(
  payload: TurnDiagnosticsPayload,
  ref: PreparedContextPartEvidenceRef,
): string | null {
  return preparedContextPartRecord(payload, ref)?.text ?? null;
}

function preparedContextPartRecord(
  payload: TurnDiagnosticsPayload,
  ref: PreparedContextPartEvidenceRef,
): PreparedContextPartRecord | null {
  const messagesById = new Map(payload.canonicalMessages.map((message) => [message.id, message.value]));
  const call = payload.providerCalls[ref.callIndex] ?? null;
  if (!call) return null;
  const messageId = call.preparedContext.messageIds[ref.messageIndex];
  if (!messageId) return null;
  const provenance = call.preparedContext.messagePartProvenance[ref.messageIndex]?.[ref.partIndex] ?? null;
  if (provenance?.source !== 'systemContext') return null;
  const partText = textForMessagePart(messagesById.get(messageId) ?? null, ref.partIndex);
  if (!partText) return null;
  return {
    callIndex: ref.callIndex,
    messageIndex: ref.messageIndex,
    partIndex: ref.partIndex,
    entries: provenance.entries,
    text: partText,
    requestedAt: call.requestedAt,
  };
}

function preparedContextPartRecords(
  payload: TurnDiagnosticsPayload,
  callIndex: number | null,
): readonly PreparedContextPartRecord[] {
  const call = callIndex === null ? payload.providerCalls[0] ?? null : payload.providerCalls[callIndex] ?? null;
  if (!call) return [];
  const messagesById = new Map(payload.canonicalMessages.map((message) => [message.id, message.value]));
  const records: PreparedContextPartRecord[] = [];
  for (
    let messageIndex = call.protectedFromMessageIndex;
    messageIndex < call.preparedContext.messageIds.length;
    messageIndex += 1
  ) {
    const messageId = call.preparedContext.messageIds[messageIndex];
    if (!messageId) continue;
    const message = messagesById.get(messageId) ?? null;
    const parts = call.preparedContext.messagePartProvenance[messageIndex] ?? [];
    parts.forEach((provenance, partIndex) => {
      if (provenance.source !== 'systemContext') return;
      const partText = textForMessagePart(message, partIndex);
      if (!partText) return;
      records.push({
        callIndex: call.index,
        messageIndex,
        partIndex,
        entries: provenance.entries,
        text: partText,
        requestedAt: call.requestedAt,
      });
    });
  }
  return records;
}

function preparedContextFingerprint(context: PreparedContextPartRecord): string {
  return JSON.stringify({
    entries: context.entries,
    text: context.text,
  });
}

function toolCatalogRecord(
  payload: TurnDiagnosticsPayload,
  callIndex: number,
): ToolCatalogRecord | null {
  const call = payload.providerCalls[callIndex] ?? null;
  if (!call) return null;
  const schemasByName = new Map(payload.toolSchemas.map((schema) => [schema.name, schema]));
  const tools = call.preparedContext.toolNames.map((name): JsonValue => {
    const schema = schemasByName.get(name);
    return schema ? exactJsonValue(schema) : { name, schemaUnavailable: true };
  });
  return {
    callIndex: call.index,
    toolNames: call.preparedContext.toolNames,
    tools,
    fingerprint: JSON.stringify(tools),
    requestedAt: call.requestedAt,
  };
}

function toolCatalogEvidence(
  payload: TurnDiagnosticsPayload | null,
  callIndex: number,
): JsonValue | null {
  if (!payload) return null;
  const catalog = toolCatalogRecord(payload, callIndex);
  if (!catalog) return null;
  return {
    kind: 'toolCatalog',
    requestIndex: catalog.callIndex,
    toolNames: [...catalog.toolNames],
    tools: structuredClone(catalog.tools),
  };
}

function toolCatalogLabel(catalog: ToolCatalogRecord, update: boolean): ThreadTrajectoryRecordLabel {
  return {
    type: 'toolCatalog',
    change: update ? 'updated' : 'initial',
    requestIndex: catalog.callIndex,
    toolCount: catalog.toolNames.length,
  };
}

function toolCatalogPreview(catalog: ToolCatalogRecord): string | null {
  return catalog.toolNames.length > 0 ? catalog.toolNames.join(', ') : null;
}

function textForMessagePart(message: JsonValue | null, partIndex: number): string | null {
  return semanticText(messagePart(message, partIndex));
}

function messagePart(message: JsonValue | null, partIndex: number): JsonValue | null {
  if (message === null) return null;
  if (typeof message === 'string') return partIndex === 0 ? message : null;
  if (typeof message !== 'object' || Array.isArray(message)) return null;
  const record = message as Readonly<Record<string, JsonValue>>;
  const content = record.content ?? record.parts;
  if (Array.isArray(content)) return content[partIndex] ?? null;
  return partIndex === 0 ? content ?? message : null;
}

function modelInputPartsForItem(
  payload: TurnDiagnosticsPayload | null,
  itemId: ThreadItemId,
  callIndex: number | null,
): readonly ThreadTrajectoryModelInputPart[] | null {
  if (!payload) return null;
  const calls = callIndex === null
    ? payload.providerCalls
    : payload.providerCalls[callIndex] ? [payload.providerCalls[callIndex]!] : [];
  const messagesById = new Map(payload.canonicalMessages.map((message) => [message.id, message.value]));
  for (const call of calls) {
    const modelInputParts: ThreadTrajectoryModelInputPart[] = [];
    call.preparedContext.messageIds.forEach((messageId, messageIndex) => {
      const message = messagesById.get(messageId) ?? null;
      call.preparedContext.messagePartProvenance[messageIndex]?.forEach((provenance, partIndex) => {
        if (provenance.source !== 'userInput' || provenance.itemId !== itemId) return;
        const part = messagePart(message, partIndex);
        if (part !== null) modelInputParts.push(modelInputPartEvidence(part));
      });
    });
    if (modelInputParts.length > 0) return modelInputParts;
  }
  return null;
}

function modelInputPartEvidence(part: JsonValue): ThreadTrajectoryModelInputPart {
  const text = semanticText(part);
  if (text !== null) return { type: 'text', text };
  const image = modelImagePartEvidence(part);
  if (image) return image;
  return { type: 'other', value: structuredClone(part) };
}

function modelInputPartsPreview(parts: readonly ThreadTrajectoryModelInputPart[] | null): string | null {
  if (!parts) return null;
  const preview = parts.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'other') return jsonPreview(part.value) ?? '';
    return [
      'IMAGE',
      part.mimeType,
      part.byteLength === null ? null : `${part.byteLength} B`,
      part.sha256 === null ? null : `sha256 ${part.sha256}`,
    ].filter((value): value is string => value !== null).join(' · ');
  }).filter(Boolean).join('\n\n');
  return preview || null;
}

function modelOutputPartsForResponse(value: JsonValue | null): readonly ThreadTrajectoryModelOutputPart[] | null {
  const content = modelResponseContent(value);
  if (content === null) return null;
  const parts = content.map(modelOutputPartEvidence);
  return parts.length > 0 ? parts : null;
}

function modelResponseContent(value: JsonValue | null): readonly JsonValue[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [value];
  const record = value as Readonly<Record<string, JsonValue>>;
  const content = record.content ?? record.parts;
  if (Array.isArray(content)) return content;
  if (content !== undefined && content !== null) return [content];
  return [value];
}

function providerToolInputEvidence(
  payload: TurnDiagnosticsPayload,
  activityIndex: number,
  execution: TrajectoryToolExecution,
): EvidenceReadResult<JsonValue | null> {
  const batch = payload.activities[activityIndex] ?? null;
  if (batch?.type !== 'toolExecutionBatch') return unavailableEvidence('evidenceUnavailable');
  const response = payload.providerCalls[batch.sourceCallIndex]?.response?.value ?? null;
  const part = modelResponseContent(response)?.[execution.providerResponsePartIndex] ?? null;
  if (typeof part !== 'object' || part === null || Array.isArray(part)) {
    return unavailableEvidence('evidenceUnavailable');
  }
  const record = part as Readonly<Record<string, JsonValue>>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase().replace(/[_-]/g, '') : '';
  if (type !== 'toolcall' && type !== 'functioncall') return unavailableEvidence('evidenceUnavailable');
  for (const key of ['arguments', 'args', 'input'] as const) {
    if (Object.hasOwn(record, key)) return retainedEvidence(structuredClone(record[key] ?? null));
  }
  return unavailableEvidence('evidenceUnavailable');
}

function modelOutputPartEvidence(part: JsonValue): ThreadTrajectoryModelOutputPart {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (typeof part !== 'object' || part === null || Array.isArray(part)) {
    return { type: 'other', value: structuredClone(part) };
  }
  const record = part as Readonly<Record<string, JsonValue>>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase().replace(/[_-]/g, '') : '';
  if (type === 'text' || type === 'outputtext') {
    const text = typeof record.text === 'string'
      ? record.text
      : typeof record.output_text === 'string' ? record.output_text : null;
    if (text !== null) return { type: 'text', text };
  }
  if (type === 'thinking' || type === 'reasoning') {
    const text = typeof record.thinking === 'string'
      ? record.thinking
      : typeof record.text === 'string' ? record.text : null;
    if (text !== null) return { type: 'thinking', text };
  }
  if (type === 'toolcall' || type === 'functioncall') {
    const argumentsValue = record.arguments ?? record.args ?? record.input ?? null;
    return {
      type: 'toolCall',
      callId: toolCallIdentityEvidence(record.id ?? record.callId ?? null),
      name: stringEvidence(record.name ?? record.toolName ?? null),
      arguments: argumentsValue === null ? null : structuredClone(argumentsValue),
    };
  }
  const image = modelImagePartEvidence(part);
  if (image) return image;
  return { type: 'other', value: structuredClone(part) };
}

function modelImagePartEvidence(part: JsonValue): ThreadTrajectoryModelImagePart | null {
  if (typeof part !== 'object' || part === null || Array.isArray(part)) return null;
  const record = part as Readonly<Record<string, JsonValue>>;
  const partType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  const mimeType = firstString(record.mimeType, record.media_type, nestedImageValue(record, 'mimeType'));
  if (!partType.includes('image') && !mimeType?.toLowerCase().startsWith('image/')) return null;
  const byteLength = firstNonNegativeInteger(
    record.byteLength,
    nestedImageValue(record, 'byteLength'),
  );
  const digest = firstString(record.sha256, nestedImageValue(record, 'sha256'));
  return {
    type: 'image',
    mimeType,
    byteLength,
    sha256: digest !== null && /^[a-f0-9]{64}$/.test(digest) ? digest : null,
  };
}

function nestedImageValue(record: Readonly<Record<string, JsonValue>>, key: string): JsonValue | null {
  for (const containerKey of ['data', 'image', 'inlineData', 'inline_data']) {
    const container = record[containerKey];
    if (typeof container !== 'object' || container === null || Array.isArray(container)) continue;
    const value = (container as Readonly<Record<string, JsonValue>>)[key];
    if (value !== undefined) return value;
  }
  return null;
}

function firstString(...values: readonly (JsonValue | undefined)[]): string | null {
  return values.find((value): value is string => typeof value === 'string') ?? null;
}

function firstNonNegativeInteger(...values: readonly (JsonValue | undefined)[]): number | null {
  return values.find((value): value is number => (
    typeof value === 'number' && Number.isInteger(value) && value >= 0
  )) ?? null;
}

function stringEvidence(value: JsonValue | null): string | null {
  return typeof value === 'string' ? value : null;
}

function toolCallIdentityEvidence(value: JsonValue | null): string | null {
  return typeof value === 'string' ? value : null;
}

function trajectoryToolCallIdentity(value: string): string {
  if (
    Buffer.byteLength(value, 'utf8') <= MAX_TRAJECTORY_TOOL_CALL_ID_BYTES
    && !value.startsWith(TRAJECTORY_TOOL_CALL_DIGEST_PREFIX)
  ) {
    return value;
  }
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  return `${TRAJECTORY_TOOL_CALL_DIGEST_PREFIX}${digest}`;
}

function modelOutputPartsPreview(parts: readonly ThreadTrajectoryModelOutputPart[] | null): string | null {
  if (!parts) return null;
  const preview = parts.map((part) => {
    if (part.type === 'text' || part.type === 'thinking') return part.text;
    if (part.type === 'toolCall') {
      return [part.name, jsonPreview(part.arguments)].filter(Boolean).join(' ');
    }
    if (part.type === 'other') return jsonPreview(part.value) ?? '';
    return [
      'IMAGE',
      part.mimeType,
      part.byteLength === null ? null : `${part.byteLength} B`,
      part.sha256 === null ? null : `sha256 ${part.sha256}`,
    ].filter((value): value is string => value !== null).join(' · ');
  }).filter(Boolean).join('\n\n');
  return preview || null;
}

function appendStablePromptRecord(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
): void {
  const diagnostics = loaded.diagnostics;
  const stablePrompt = diagnostics?.payload.stablePrompt;
  if (!diagnostics || !stablePrompt) return;
  records.push(record({
    kind: 'context',
    lane: 'input',
    threadId: loaded.threadId,
    turn: loaded.turn,
    order: [loaded.turnIndex, 0, 0, 0, 0, 0],
    label: { type: 'systemPrompt', change: 'initial' },
    meta: null,
    preview: compact(stablePromptModelText(diagnostics.payload)),
    state: 'completed',
    timing: timing(loaded.turn.startedAt, null, loaded.turn.startedAt),
    primaryEvidence: stablePromptEvidenceRef(loaded.threadId, loaded.turn),
    relatedEvidence: [],
    availability: loaded.availability,
    usage: null,
  }));
}

function stablePromptEvidence(bundle: DiagnosticsBundle | null): JsonValue | null {
  if (!bundle) return null;
  return { stablePrompt: exactJsonValue(bundle.payload.stablePrompt) };
}

function appendTurnRecords(records: ThreadTrajectoryRecordSummary[], loaded: LoadedTurn): void {
  const { diagnostics, turn } = loaded;
  const itemsById = new Map(turn.items.map((item) => [item.id, item]));
  const coveredCompactionItemIds = new Set<string>();
  const insertedPreparedContexts = new Set<string>();

  if (diagnostics) {
    diagnostics.payload.activities.forEach((activity, activityIndex) => {
      if (activity.type === 'acceptedInput') {
        const activityRef = diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type);
        const providerCallRef = activity.consumedByCallIndex === null
          ? null
          : providerCallEvidence(loaded.threadId, turn, activity.consumedByCallIndex);
        activity.itemIds.forEach((itemId, itemIndex) => {
          const item = itemsById.get(itemId);
          if (item?.type !== 'userMessage') return;
          records.push(record({
            kind: 'input',
            lane: 'input',
            threadId: loaded.threadId,
            turn,
            order: [loaded.turnIndex, 1, activityIndex, 0, itemIndex, 0],
            label: { type: 'input', source: activity.source },
            meta: null,
            preview: compact(
              modelInputPartsPreview(modelInputPartsForItem(
                diagnostics.payload,
                item.id,
                activity.consumedByCallIndex,
              )),
            ),
            state: 'completed',
            timing: timing(item.acceptedAt, null, item.acceptedAt),
            primaryEvidence: itemEvidenceRef(loaded.threadId, turn, item.id),
            relatedEvidence: [
              activityRef,
              ...(providerCallRef ? [providerCallRef] : []),
            ],
            availability: loaded.availability,
            usage: null,
          }));
        });
        if (activity.consumedByCallIndex !== null) {
          appendPreparedContextRecords(
            records,
            loaded,
            activity.consumedByCallIndex,
            insertedPreparedContexts,
            activityIndex,
            1,
          );
        }
        return;
      }
      if (activity.type === 'modelCall') {
        const call = diagnostics.payload.providerCalls[activity.callIndex];
        if (!call) return;
        appendPreparedContextRecords(records, loaded, call.index, insertedPreparedContexts, activityIndex, 0);
        records.push(record({
          kind: 'assistant',
          lane: 'assistant',
          threadId: loaded.threadId,
          turn,
          order: [loaded.turnIndex, 1, activityIndex, 1, 0, 0],
          label: { type: 'assistantCall', callIndex: call.index },
          meta: `${diagnostics.payload.runtime.provider} · ${diagnostics.payload.runtime.model}`,
          preview: compact(modelOutputPartsPreview(
            modelOutputPartsForResponse(call.response?.value ?? null),
          )),
          state: providerCallState(call, turn),
          timing: timing(call.requestedAt, null, call.response?.receivedAt ?? null),
          primaryEvidence: providerCallEvidence(loaded.threadId, turn, call.index),
          relatedEvidence: relatedAssistantItems(turn, diagnostics.payload)
            .map((item) => itemEvidenceRef(loaded.threadId, turn, item.id)),
          availability: loaded.availability,
          usage: call.response ? providerUsageSummary(call.response.usage) : null,
        }));
        return;
      }
      if (activity.type === 'toolExecutionBatch') {
        activity.executions.forEach((execution, executionIndex) => {
          const item = execution.itemId ? itemsById.get(execution.itemId) ?? null : null;
          records.push(record({
            kind: 'tool',
            lane: 'tools',
            threadId: loaded.threadId,
            turn,
            order: [loaded.turnIndex, 1, activityIndex, 0, executionIndex, 0],
            label: { type: 'tool', name: toolName(item, execution.toolName) },
            meta: execution.canonicalIdentity
              ? [execution.canonicalIdentity.namespace, execution.canonicalIdentity.name].filter(Boolean).join('.')
              : execution.toolName,
            preview: compact(toolInputPreview(item)),
            state: execution.status === 'inProgress' ? 'running' : execution.status,
            timing: timing(execution.startedAt, null, execution.completedAt),
            primaryEvidence: toolExecutionEvidence(
              loaded.threadId,
              turn,
              activityIndex,
              execution.callId,
            ),
            relatedEvidence: execution.itemId ? [itemEvidenceRef(loaded.threadId, turn, execution.itemId)] : [],
            availability: loaded.availability,
            usage: null,
            parentRecordId: assistantRecordId(turn.id, activity.sourceCallIndex),
          }));
        });
        return;
      }
      if (activity.type === 'providerRetry') {
        records.push(record({
          kind: 'retry',
          lane: 'assistant',
          threadId: loaded.threadId,
          turn,
          order: [loaded.turnIndex, 1, activityIndex, 0, 0, 0],
          label: {
            type: 'providerRetry',
            retryKind: activity.retryKind,
            attempt: activity.attempt,
            maxRetries: activity.maxRetries,
            sourceCallIndex: activity.sourceCallIndex,
          },
          meta: null,
          preview: null,
          state: activity.nextCallIndex === null && turn.status === 'failed' ? 'failed' : 'completed',
          timing: timing(activity.occurredAt, null, activity.occurredAt),
          primaryEvidence: diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type),
          relatedEvidence: [
            providerCallEvidence(loaded.threadId, turn, activity.sourceCallIndex),
            ...(activity.nextCallIndex === null ? [] : [
              providerCallEvidence(loaded.threadId, turn, activity.nextCallIndex),
            ]),
          ],
          availability: loaded.availability,
          usage: null,
          parentRecordId: assistantRecordId(turn.id, activity.sourceCallIndex),
        }));
        return;
      }
      coveredCompactionItemIds.add(activity.itemId);
      records.push(record({
        kind: 'compaction',
        lane: 'input',
        threadId: loaded.threadId,
        turn,
        order: [loaded.turnIndex, 1, activityIndex, 0, 0, 0],
        label: { type: 'contextCompaction', trigger: activity.trigger },
        meta: activity.trigger,
        preview: null,
        state: 'completed',
        timing: timing(activity.completedAt, null, activity.completedAt),
        primaryEvidence: diagnosticEvidence(loaded.threadId, turn, activityIndex, activity.type),
        relatedEvidence: [itemEvidenceRef(loaded.threadId, turn, activity.itemId)],
        availability: loaded.availability,
        usage: null,
      }));
    });
    for (const call of diagnostics.payload.providerCalls) {
      const activityIndex = diagnostics.payload.activities.findIndex((activity) => (
        activity.type === 'modelCall' && activity.callIndex === call.index
      ));
      appendPreparedContextRecords(
        records,
        loaded,
        call.index,
        insertedPreparedContexts,
        activityIndex >= 0 ? activityIndex : diagnostics.payload.activities.length + call.index,
        0,
      );
    }
    appendManualCompactionRecords(records, loaded, coveredCompactionItemIds);
    return;
  }

  appendFallbackTurnRecords(records, loaded);
}

function appendFallbackTurnRecords(records: ThreadTrajectoryRecordSummary[], loaded: LoadedTurn): void {
  loaded.turn.items.forEach((item, itemIndex) => {
    if (item.type !== 'userMessage') return;
    records.push(record({
      kind: 'input',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      order: [loaded.turnIndex, 1, itemIndex, 0, 0, 0],
      label: { type: 'input', source: 'initial' },
      meta: null,
      preview: null,
      state: loaded.turn.status === 'inProgress' ? 'running' : 'partial',
      timing: timing(item.acceptedAt, null, null),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, item.id),
      relatedEvidence: [],
      availability: loaded.availability,
      usage: null,
    }));
  });
  appendManualCompactionRecords(records, loaded, new Set());
  loaded.turn.items.forEach((item, itemIndex) => {
    if (!isToolItem(item)) return;
    records.push(record({
      kind: 'tool',
      lane: 'tools',
      threadId: loaded.threadId,
      turn: loaded.turn,
      order: [loaded.turnIndex, 1, itemIndex, 1, 0, 0],
      label: { type: 'tool', name: toolName(item, item.type) },
      meta: item.type,
      preview: compact(toolInputPreview(item)),
      state: item.status === 'inProgress' ? 'running' : item.status,
      timing: timing(loaded.turn.startedAt, null, itemCompletedAt(item, loaded.turn)),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, item.id),
      relatedEvidence: [],
      availability: loaded.availability,
      usage: null,
    }));
  });
}

function appendPreparedContextRecords(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  callIndex: number | null,
  inserted: Set<string>,
  activityIndex: number,
  slot: number,
): void {
  const payload = loaded.diagnostics?.payload ?? null;
  if (!payload) return;
  preparedContextPartRecords(payload, callIndex).forEach((context) => {
    const fingerprint = preparedContextFingerprint(context);
    if (inserted.has(fingerprint)) return;
    inserted.add(fingerprint);
    records.push(record({
      kind: 'context',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      order: [loaded.turnIndex, 1, activityIndex, slot, context.messageIndex, context.partIndex],
      label: { type: 'context', kinds: context.entries.map((entry) => entry.kind) },
      meta: contextPartMeta(context.entries),
      preview: compact(context.text),
      state: 'completed',
      timing: timing(context.requestedAt, null, context.requestedAt),
      primaryEvidence: preparedContextPartEvidence(loaded.threadId, loaded.turn, context),
      relatedEvidence: [providerCallEvidence(loaded.threadId, loaded.turn, context.callIndex)],
      availability: loaded.availability,
      usage: null,
    }));
  });
}

function appendToolCatalogRecords(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
): void {
  const state = { fingerprint: null as string | null };
  const calls = loaded.diagnostics?.payload.providerCalls ?? [];
  for (const call of calls) {
    appendToolCatalogRecordIfChanged(records, loaded, call.index, state);
  }
}

function appendToolCatalogRecordIfChanged(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  callIndex: number,
  state: { fingerprint: string | null },
): void {
  const payload = loaded.diagnostics?.payload ?? null;
  if (!payload) return;
  const catalog = toolCatalogRecord(payload, callIndex);
  if (!catalog) return;
  if (catalog.fingerprint === state.fingerprint) return;
  const initial = state.fingerprint === null;
  state.fingerprint = catalog.fingerprint;
  if (initial && catalog.toolNames.length === 0) return;
  records.push(record({
    kind: 'context',
    lane: 'input',
    threadId: loaded.threadId,
    turn: loaded.turn,
    order: [loaded.turnIndex, 0, 1, callIndex, 0, 0],
    label: toolCatalogLabel(catalog, !initial),
    meta: null,
    preview: compact(toolCatalogPreview(catalog)),
    state: 'completed',
    timing: timing(catalog.requestedAt, null, catalog.requestedAt),
    primaryEvidence: toolCatalogEvidenceRef(loaded.threadId, loaded.turn, catalog.callIndex),
    relatedEvidence: [providerCallEvidence(loaded.threadId, loaded.turn, catalog.callIndex)],
    availability: loaded.availability,
    usage: null,
  }));
}

function appendManualCompactionRecords(
  records: ThreadTrajectoryRecordSummary[],
  loaded: LoadedTurn,
  coveredItemIds: ReadonlySet<string>,
): void {
  loaded.turn.items.forEach((item, itemIndex) => {
    if (item.type !== 'contextCompaction' || coveredItemIds.has(item.id)) return;
    records.push(record({
      kind: 'compaction',
      lane: 'input',
      threadId: loaded.threadId,
      turn: loaded.turn,
      order: [loaded.turnIndex, 2, itemIndex, 0, 0, 0],
      label: { type: 'contextCompaction', trigger: item.trigger },
      meta: item.trigger,
      preview: null,
      state: 'completed',
      timing: timing(loaded.turn.startedAt, null, loaded.turn.startedAt),
      primaryEvidence: itemEvidenceRef(loaded.threadId, loaded.turn, item.id),
      relatedEvidence: [],
      availability: loaded.availability,
      usage: null,
    }));
  });
}

function record(input: {
  readonly kind: ThreadTrajectoryRecordKind;
  readonly lane: ThreadTrajectoryRecordSummary['lane'];
  readonly threadId: ThreadId;
  readonly turn: Turn;
  readonly order: readonly [number, number, number, number, number, number];
  readonly label: ThreadTrajectoryRecordLabel;
  readonly meta: string | null;
  readonly preview: string | null;
  readonly state: ThreadTrajectoryRecordSummary['state'];
  readonly timing: ThreadTrajectoryTimingSummary;
  readonly primaryEvidence: ThreadTrajectoryEvidenceRef;
  readonly relatedEvidence: readonly ThreadTrajectoryEvidenceRef[];
  readonly availability: readonly ThreadTrajectoryAvailability[];
  readonly usage: ThreadTrajectoryUsageSummary | null;
  readonly parentRecordId?: string | null;
}): ThreadTrajectoryRecordSummary {
  return {
    id: trajectoryRecordId(input.turn.id, input.kind, input.primaryEvidence),
    kind: input.kind,
    lane: input.lane,
    threadId: input.threadId,
    turnId: input.turn.id,
    orderKey: trajectoryOrderKey(input.order),
    turnIndex: input.order[0],
    stepIndex: 0,
    parentRecordId: input.parentRecordId ?? null,
    label: input.label.type === 'context'
      ? { ...input.label, kinds: [...input.label.kinds] }
      : { ...input.label },
    meta: input.meta,
    preview: input.preview,
    state: input.availability.length > 0 && input.state === 'completed' ? 'partial' : input.state,
    timing: input.timing,
    usage: input.usage,
    primaryEvidence: input.primaryEvidence,
    relatedEvidence: input.relatedEvidence,
    availability: input.availability,
  };
}

function summarizeTrajectory(
  threadId: ThreadId,
  overview: ThreadTrajectoryTurnOverview,
  loadedTurns: readonly LoadedTurn[],
): ThreadTrajectorySummary {
  const { completedAt, startedAt } = overview;
  return {
    threadId,
    turnCount: overview.turnCount,
    startedAt,
    completedAt,
    durationMs: startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt),
    usage: overview.usage,
    availability: canonicalTrajectoryAvailability(overview.diagnosticsUnavailable, loadedTurns),
  };
}

function canonicalTrajectoryAvailability(
  diagnosticsUnavailable: boolean,
  loadedTurns: readonly LoadedTurn[],
): readonly ThreadTrajectoryAvailability[] {
  const entries: ThreadTrajectoryAvailability[] = [];
  const seen = new Set<string>();
  const push = (entry: ThreadTrajectoryAvailability) => {
    const key = entry.reason;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  if (diagnosticsUnavailable) push(availability('diagnosticsUnavailable'));
  for (const loaded of loadedTurns) {
    for (const entry of loaded.availability) push(entry);
  }
  return entries;
}

function pageTrajectoryRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
  turnWindow: TurnWindow | null = null,
  turnCount: number | null = null,
): TrajectoryPage {
  const limit = trajectoryLimit(request.limit);
  const cursor = decodeTrajectoryCursor(request.cursor ?? null);
  const page = (() => {
    if (cursor?.direction === 'before') {
      const boundary = records.findIndex((entry) => entry.id === cursor.recordId);
      const end = boundary < 0 ? records.length : boundary;
      return trajectoryPage(records, Math.max(0, end - limit), end);
    }
    if (cursor?.direction === 'after') {
      const boundary = records.findIndex((entry) => entry.id === cursor.recordId);
      const start = boundary < 0 ? 0 : boundary + 1;
      return trajectoryPage(records, start, Math.min(records.length, start + limit));
    }
    const focusIndex = focusIndexForRecords(records, request);
    if (focusIndex >= 0) {
      const recordsAfterFocus = Math.floor((limit - 1) / 3);
      const end = Math.min(records.length, focusIndex + recordsAfterFocus + 1);
      const start = Math.max(0, end - limit);
      return trajectoryPage(records, start, end);
    }
    return trajectoryPage(records, Math.max(0, records.length - limit), records.length);
  })();
  if (!turnWindow || turnCount === null) return page;
  const first = page.data[0] ?? null;
  const last = page.data.at(-1) ?? null;
  return {
    ...page,
    olderCursor: page.olderCursor ?? (first && turnWindow.start > 0
      ? encodeTrajectoryCursor('before', first.id)
      : null),
    newerCursor: page.newerCursor ?? (last && turnWindow.end < turnCount
      ? encodeTrajectoryCursor('after', last.id)
      : null),
  };
}

function initialTurnWindowForTrajectoryRead(turnCount: number, requestedAnchor: number | null): TurnWindow {
  if (turnCount === 0) return { start: 0, end: 0 };
  const anchor = requestedAnchor === null ? turnCount - 1 : requestedAnchor;
  return { start: anchor, end: anchor + 1 };
}

function trajectoryAnchorTurnPosition(
  core: ThreadCore,
  request: ThreadTrajectoryReadRequest,
): number | null {
  const cursor = decodeTrajectoryCursor(request.cursor ?? null);
  const focus = request.focus ?? null;
  const turnId = cursor
    ? turnIdFromTrajectoryRecordId(cursor.recordId)
    : focus?.turnId ?? (focus?.recordId ? turnIdFromTrajectoryRecordId(focus.recordId) : null);
  return turnId ? core.trajectoryTurnPosition(request.threadId, turnId) : null;
}

function trajectoryWindowExpansion(
  records: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
  window: TurnWindow,
  turnCount: number,
): TurnWindow | null {
  const limit = trajectoryLimit(request.limit);
  const cursor = decodeTrajectoryCursor(request.cursor ?? null);
  if (cursor?.direction === 'before') {
    const boundary = records.findIndex((record) => record.id === cursor.recordId);
    return boundary >= limit || window.start === 0
      ? null
      : expandTrajectoryTurnWindow(window, turnCount, true, false);
  }
  if (cursor?.direction === 'after') {
    const boundary = records.findIndex((record) => record.id === cursor.recordId);
    const recordsAfter = boundary < 0 ? 0 : records.length - boundary - 1;
    return recordsAfter >= limit || window.end === turnCount
      ? null
      : expandTrajectoryTurnWindow(window, turnCount, false, true);
  }
  const focusIndex = focusIndexForRecords(records, request);
  if (request.focus && (request.focus.recordId || request.focus.turnId)) {
    const desiredAfter = Math.floor((limit - 1) / 3);
    const desiredBefore = limit - desiredAfter - 1;
    let expandBefore = window.start > 0 && (focusIndex < 0 || focusIndex < desiredBefore);
    let expandAfter = window.end < turnCount && (
      focusIndex < 0 || records.length - focusIndex - 1 < desiredAfter
    );
    if (!expandBefore && !expandAfter && records.length < limit) {
      expandBefore = window.start > 0;
      expandAfter = window.end < turnCount;
    }
    return expandBefore || expandAfter
      ? expandTrajectoryTurnWindow(window, turnCount, expandBefore, expandAfter)
      : null;
  }
  return records.length >= limit || window.start === 0
    ? null
    : expandTrajectoryTurnWindow(window, turnCount, true, false);
}

function expandTrajectoryTurnWindow(
  window: TurnWindow,
  turnCount: number,
  before: boolean,
  after: boolean,
): TurnWindow {
  return {
    start: before ? Math.max(0, window.start - TRAJECTORY_TURN_SCAN_BATCH) : window.start,
    end: after ? Math.min(turnCount, window.end + TRAJECTORY_TURN_SCAN_BATCH) : window.end,
  };
}

function turnRangeFromMap(
  loadedByIndex: ReadonlyMap<number, LoadedTurn>,
  start: number,
  end: number,
): readonly LoadedTurn[] {
  const turns: LoadedTurn[] = [];
  for (let index = start; index < end; index += 1) {
    const loaded = loadedByIndex.get(index);
    if (loaded) turns.push(loaded);
  }
  return turns;
}

function trajectoryPage(
  records: readonly ThreadTrajectoryRecordSummary[],
  start: number,
  end: number,
): TrajectoryPage {
  const coveredRecords = records.slice(start, end);
  const data = expandStructuralRecords(records, start, end);
  const first = coveredRecords[0] ?? null;
  const last = coveredRecords.at(-1) ?? null;
  const firstIndex = first ? records.findIndex((record) => record.id === first.id) : -1;
  const lastIndex = last ? records.findIndex((record) => record.id === last.id) : -1;
  const replacementRange = trajectoryReplacementRange(coveredRecords);
  return {
    data,
    replacementRange,
    olderCursor: first && firstIndex > 0 ? encodeTrajectoryCursor('before', first.id) : null,
    newerCursor: last && (lastIndex >= 0 && lastIndex < records.length - 1)
      ? encodeTrajectoryCursor('after', last.id)
      : null,
  };
}

function trajectoryReplacementRange(
  records: readonly ThreadTrajectoryRecordSummary[],
): ThreadTrajectoryReplacementRange | null {
  const first = records[0] ?? null;
  const last = records.at(-1) ?? null;
  return first && last
    ? { startOrderKey: first.orderKey, endOrderKey: last.orderKey }
    : null;
}

function expandStructuralRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
  start: number,
  end: number,
): readonly ThreadTrajectoryRecordSummary[] {
  const coveredRecords = records.slice(start, end);
  const included = new Set(coveredRecords.map((record) => record.id));
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of coveredRecords) {
    const visited = new Set<string>();
    let parentId = record.parentRecordId;
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      included.add(parent.id);
      parentId = parent.parentRecordId;
    }
  }
  return records.filter((record) => included.has(record.id));
}

function selectRecordId(
  page: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
): string | null {
  const focus = request.focus ?? null;
  if (focus?.recordId && page.some((entry) => entry.id === focus.recordId)) return focus.recordId;
  if (focus?.turnId) return focusRecordForTurn(page, focus.turnId)?.id ?? null;
  return null;
}

function focusRecordForTurn(
  records: readonly ThreadTrajectoryRecordSummary[],
  turnId: string,
): ThreadTrajectoryRecordSummary | null {
  const candidates = records.filter((entry) => entry.turnId === turnId);
  if (candidates.length === 0) return null;
  for (const kind of ['assistant', 'tool', 'compaction', 'context', 'input'] as const) {
    const match = candidates.find((entry) => entry.kind === kind);
    if (match) return match;
  }
  return candidates[0] ?? null;
}

function focusIndexForRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
  request: ThreadTrajectoryReadRequest,
): number {
  const focus = request.focus ?? null;
  if (!focus) return -1;
  if (focus.recordId) return records.findIndex((entry) => entry.id === focus.recordId);
  if (focus.turnId) return records.findIndex((entry) => entry.turnId === focus.turnId);
  return -1;
}

function trajectoryLimit(value: number | null | undefined): number {
  if (!value || !Number.isSafeInteger(value) || value <= 0) return DEFAULT_TRAJECTORY_LIMIT;
  return Math.min(value, MAX_TRAJECTORY_LIMIT);
}

function encodeTrajectoryCursor(direction: TrajectoryCursor['direction'], recordId: string): string {
  return `${direction}:${encodeURIComponent(recordId)}`;
}

function decodeTrajectoryCursor(value: string | null): TrajectoryCursor | null {
  if (!value) return null;
  const match = /^(before|after):(.+)$/.exec(value);
  if (!match) return null;
  const direction = match[1];
  const encoded = match[2];
  if ((direction !== 'before' && direction !== 'after') || !encoded) return null;
  try {
    return { direction, recordId: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

function trajectoryRecordId(
  turnId: string,
  kind: ThreadTrajectoryRecordKind,
  evidence: ThreadTrajectoryEvidenceRef,
): string {
  if (kind === 'assistant' && evidence.type === 'providerCall') return `turn:${turnId}:assistant:${evidence.callIndex}`;
  if (evidence.type === 'toolExecution') {
    return `turn:${turnId}:${kind}:${evidence.activityIndex}:${encodeURIComponent(evidence.callId)}`;
  }
  if (evidence.type === 'diagnosticActivity') {
    return `turn:${turnId}:${kind}:${evidence.activityIndex}`;
  }
  if (evidence.type === 'preparedContextPart') {
    return [
      `turn:${turnId}:${kind}:prepared`,
      evidence.callIndex,
      evidence.messageIndex,
      evidence.partIndex,
    ].join(':');
  }
  if (evidence.type === 'toolCatalog') return `turn:${turnId}:${kind}:tools:${evidence.callIndex}`;
  if (evidence.type === 'threadItem') return `turn:${turnId}:${kind}:item:${evidence.itemId}`;
  return `turn:${turnId}:${kind}`;
}

function assistantRecordId(turnId: string, callIndex: number): string {
  return `turn:${turnId}:assistant:${callIndex}`;
}

function providerCallEvidence(threadId: ThreadId, turn: Turn, callIndex: number): ThreadTrajectoryEvidenceRef {
  return { type: 'providerCall', threadId, turnId: turn.id, callIndex };
}

function stablePromptEvidenceRef(threadId: ThreadId, turn: Turn): ThreadTrajectoryEvidenceRef {
  return { type: 'stablePrompt', threadId, turnId: turn.id };
}

function toolCatalogEvidenceRef(threadId: ThreadId, turn: Turn, callIndex: number): ThreadTrajectoryEvidenceRef {
  return { type: 'toolCatalog', threadId, turnId: turn.id, callIndex };
}

function preparedContextPartEvidence(
  threadId: ThreadId,
  turn: Turn,
  context: Pick<PreparedContextPartRecord, 'callIndex' | 'messageIndex' | 'partIndex'>,
): ThreadTrajectoryEvidenceRef {
  return {
    type: 'preparedContextPart',
    threadId,
    turnId: turn.id,
    callIndex: context.callIndex,
    messageIndex: context.messageIndex,
    partIndex: context.partIndex,
  };
}

function itemEvidenceRef(threadId: ThreadId, turn: Turn, itemId: string): ThreadTrajectoryEvidenceRef {
  return { type: 'threadItem', threadId, turnId: turn.id, itemId };
}

function diagnosticEvidence(
  threadId: ThreadId,
  turn: Turn,
  activityIndex: number,
  activityType: TurnDiagnosticsPayload['activities'][number]['type'],
): ThreadTrajectoryEvidenceRef {
  return {
    type: 'diagnosticActivity',
    threadId,
    turnId: turn.id,
    activityIndex,
    activityType,
  };
}

function toolExecutionEvidence(
  threadId: ThreadId,
  turn: Turn,
  activityIndex: number,
  callId: string,
): ThreadTrajectoryEvidenceRef {
  return {
    type: 'toolExecution',
    threadId,
    turnId: turn.id,
    activityIndex,
    callId: trajectoryToolCallIdentity(callId),
  };
}

function timing(
  startedAt: number | null,
  firstTokenAt: number | null,
  completedAt: number | null,
): ThreadTrajectoryTimingSummary {
  return {
    startedAt,
    firstTokenAt,
    completedAt,
    durationMs: startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt),
  };
}

function providerUsageSummary(
  usage: NonNullable<TurnDiagnosticsPayload['providerCalls'][number]['response']>['usage'],
): ThreadTrajectoryUsageSummary {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost.total,
  };
}

function addUsage(
  left: ThreadTrajectoryUsageSummary | null,
  right: ThreadTrajectoryUsageSummary,
): ThreadTrajectoryUsageSummary {
  if (!left) return right;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning === null || right.reasoning === null ? null : left.reasoning + right.reasoning,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd === null || right.costUsd === null ? null : left.costUsd + right.costUsd,
  };
}

function minNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.min(...present);
}

function maxNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const limit = Math.max(1, Math.min(concurrency, values.length || 1));
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!, index);
    }
  }));
  return results;
}

function turnIdFromTrajectoryRecordId(recordId: string): TurnId | null {
  const match = /^turn:([^:]+):/.exec(recordId);
  return match?.[1] ?? null;
}

function availability(reason: ThreadTrajectoryAvailability['reason']): ThreadTrajectoryAvailability {
  return { reason };
}

function turnEvidence(turn: Turn): ThreadTrajectoryTurnEvidence {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error ? structuredClone(turn.error) : null,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    modelProvider: turn.execution.modelProvider,
    model: turn.execution.model,
    reasoningEffort: turn.execution.reasoningEffort,
  };
}

function itemEvidence(item: ThreadItem): ThreadTrajectoryItemEvidence {
  return {
    itemId: item.id,
    type: item.type,
    title: itemTitle(item),
    preview: compact(itemSummary(item)),
    status: isToolItem(item) ? item.status : null,
  };
}

function userMessageEvidence(
  item: UserMessageThreadItem,
): ThreadTrajectoryUserMessageEvidence {
  return {
    itemId: item.id,
    acceptedAt: item.acceptedAt,
    content: structuredClone(item.content),
  };
}

function evidenceForItems(
  turn: Turn,
  itemIds: readonly string[],
): readonly ThreadTrajectoryItemEvidence[] {
  const byId = new Map(turn.items.map((item) => [item.id, item]));
  return itemIds.flatMap((itemId) => {
    const item = byId.get(itemId);
    return item ? [itemEvidence(item)] : [];
  });
}

function userMessageForEvidence(turn: Turn, evidence: ThreadTrajectoryEvidenceRef): UserMessageThreadItem | null {
  const item = itemForEvidence(turn, evidence);
  return item?.type === 'userMessage' ? item : null;
}

function itemForEvidence(turn: Turn, evidence: ThreadTrajectoryEvidenceRef): ThreadItem | null {
  return evidence.type === 'threadItem'
    ? turn.items.find((item) => item.id === evidence.itemId) ?? null
    : null;
}

function itemForRelatedEvidence(turn: Turn, record: ThreadTrajectoryRecordSummary): ThreadItem | null {
  for (const evidence of record.relatedEvidence) {
    const item = itemForEvidence(turn, evidence);
    if (item) return item;
  }
  return null;
}

function itemForToolRecord(turn: Turn, record: ThreadTrajectoryRecordSummary): ThreadItem | null {
  return itemForEvidence(turn, record.primaryEvidence) ?? itemForRelatedEvidence(turn, record);
}

function diagnosticActivityIndex(evidence: ThreadTrajectoryEvidenceRef): number | null {
  return evidence.type === 'diagnosticActivity' || evidence.type === 'toolExecution'
    ? evidence.activityIndex
    : null;
}

function providerCallIndexForEvidence(evidence: ThreadTrajectoryEvidenceRef): number | null {
  return evidence.type === 'providerCall' ? evidence.callIndex : null;
}

function relatedDiagnosticActivityIndex(
  record: ThreadTrajectoryRecordSummary,
  activityType: TurnDiagnosticsPayload['activities'][number]['type'],
): number | null {
  for (const evidence of record.relatedEvidence) {
    if (evidence.type === 'diagnosticActivity' && evidence.activityType === activityType) {
      return evidence.activityIndex;
    }
  }
  return diagnosticActivityIndex(record.primaryEvidence);
}

function relatedProviderCallIndex(record: ThreadTrajectoryRecordSummary): number | null {
  const primary = providerCallIndexForEvidence(record.primaryEvidence);
  if (primary !== null) return primary;
  for (const evidence of record.relatedEvidence) {
    const callIndex = providerCallIndexForEvidence(evidence);
    if (callIndex !== null) return callIndex;
  }
  return null;
}

function relatedItemIds(record: ThreadTrajectoryRecordSummary): readonly string[] {
  return record.relatedEvidence.flatMap((evidence) => (
    evidence.type === 'threadItem' ? [evidence.itemId] : []
  ));
}

function toolExecutionCallId(record: ThreadTrajectoryRecordSummary): string | null {
  return record.primaryEvidence.type === 'toolExecution'
    ? record.primaryEvidence.callId
    : null;
}

function toolExecutionForRecord(
  payload: TurnDiagnosticsPayload | null,
  record: ThreadTrajectoryRecordSummary,
): TrajectoryToolExecution | null {
  if (!payload) return null;
  const activityIndex = diagnosticActivityIndex(record.primaryEvidence);
  const activity = activityIndex === null ? null : payload.activities[activityIndex] ?? null;
  if (activity?.type !== 'toolExecutionBatch') return null;
  const callId = toolExecutionCallId(record);
  if (!callId) return activity.executions.length === 1 ? activity.executions[0] ?? null : null;
  return activity.executions.find((execution) => trajectoryToolCallIdentity(execution.callId) === callId) ?? null;
}

function toolSchemaEvidence(
  payload: TurnDiagnosticsPayload | null,
  toolName: string | null,
): JsonValue | null {
  if (!payload || !toolName) return null;
  const schema = payload.toolSchemas.find((candidate) => candidate.name === toolName) ?? null;
  return schema ? exactJsonValue(schema) : null;
}

function providerCallState(
  call: TurnDiagnosticsPayload['providerCalls'][number],
  turn: Turn,
): ThreadTrajectoryRecordSummary['state'] {
  if (!call.response) return turn.status === 'inProgress' ? 'running' : 'partial';
  if (call.response.stopReason === 'error') return 'failed';
  if (call.response.stopReason === 'aborted') return 'interrupted';
  return 'completed';
}

function relatedAssistantItems(turn: Turn, payload: TurnDiagnosticsPayload): readonly ThreadItem[] {
  if (payload.providerCalls.length !== 1) return [];
  return turn.items.filter((item) => item.type === 'agentMessage' || item.type === 'reasoning');
}

function isToolItem(item: ThreadItem): item is Extract<ThreadItem, { readonly status: string }> {
  return 'status' in item;
}

function itemCompletedAt(item: ThreadItem, turn: Turn): number | null {
  if (!isToolItem(item)) return null;
  if (item.status === 'inProgress') return null;
  if ('durationMs' in item && typeof item.durationMs === 'number') return turn.startedAt + item.durationMs;
  return turn.completedAt;
}

function contextEvidenceTitle(item: ContextEvidenceThreadItem): string {
  return contextKindTitle(item.kind);
}

function contextPartMeta(entries: readonly TurnDiagnosticsSystemContextEntry[]): string | null {
  if (entries.length === 1) {
    const entry = entries[0]!;
    return `${entry.authority} · ${entry.purpose}`;
  }
  return null;
}

function contextKindTitle(kind: string): string {
  return kind.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
}

function toolName(item: ThreadItem | null, fallback: string): string {
  if (!item) return fallback;
  if (item.type === 'commandExecution') return item.description ?? fallback;
  if (item.type === 'mcpToolCall') return `${item.server}.${item.tool}`;
  if (item.type === 'dynamicToolCall') return [item.namespace, item.tool].filter(Boolean).join('.') || item.tool;
  return fallback;
}

function itemTitle(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage': return 'User message';
    case 'agentMessage': return 'Assistant message';
    case 'reasoning': return 'Reasoning';
    case 'commandExecution': return item.description ?? 'Shell command';
    case 'fileChange': return 'File changes';
    case 'mcpToolCall': return `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return [item.namespace, item.tool].filter(Boolean).join('.') || item.tool;
    case 'webSearch': return 'Web search';
    case 'imageView': return 'Image view';
    case 'contextEvidence': return contextEvidenceTitle(item);
    case 'contextReset': return 'Context reset';
    case 'contextCompaction': return 'Context compaction';
  }
}

function itemSummary(item: ThreadItem | null | undefined): string | null {
  if (!item) return null;
  switch (item.type) {
    case 'userMessage':
      return item.content.map((content) => {
        if (content.type === 'text') return content.text;
        if (content.type === 'attachment') return content.name;
        if (content.type === 'nodeReference') return content.note ?? content.nodeId;
        return content.threadId;
      }).join(' ');
    case 'agentMessage': return item.text;
    case 'reasoning': return [...item.summary, ...item.content].find(Boolean) ?? null;
    case 'commandExecution': return item.description ?? item.command;
    case 'fileChange': return item.changes.map((change) => change.path).join(', ');
    case 'mcpToolCall': return item.error ?? jsonPreview(item.result) ?? `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return item.contentItems?.map((content) => {
      if (content.type === 'text') return content.text;
      if (content.type === 'json') return jsonPreview(content.value);
      return content.alt ?? 'image';
    }).filter(Boolean).join(' ') ?? null;
    case 'webSearch': return item.query;
    case 'imageView': return 'Image viewed';
    case 'contextEvidence': return item.summary;
    case 'contextReset': return 'Context cleared';
    case 'contextCompaction': return `${item.trigger} compaction`;
  }
}

function toolInputPreview(item: ThreadItem | null): string | null {
  if (!item || !isToolItem(item)) return null;
  if (item.modelCall.disposition === 'evidenceOnly') {
    return jsonPreview(item.modelCall.redactedArgumentsSummary);
  }
  const source = modelCallArgumentSource(item.modelCall);
  return source.storage === 'inline'
    ? jsonPreview(source.value)
    : null;
}

function semanticText(value: JsonValue | null): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, JsonValue>>;
  for (const key of ['text', 'input_text', 'output_text', 'content']) {
    const text = record[key];
    if (typeof text === 'string' && text.length > 0) return text;
  }
  const content = record.content ?? record.parts;
  if (Array.isArray(content)) {
    return content.map(semanticText).filter(Boolean).join(' ');
  }
  return null;
}

function jsonPreview(value: JsonValue | null): string | null {
  if (value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function exactJsonValue(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

function compact(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > PREVIEW_LIMIT ? `${normalized.slice(0, PREVIEW_LIMIT - 1)}…` : normalized;
}
