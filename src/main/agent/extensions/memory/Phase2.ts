import { decodeMemoryConsolidationOutput, type MemoryConsolidationNode, type MemoryConsolidationOutput } from '../../../../core/agent/memory';
import type { Thread } from '../../../../core/agent/protocol';
import { freshNodeId } from '../../../../core/nodeId';
import { uuidV7 } from '../../uuid';
import { MemoryControlStore, type MemoryPublicationRecord } from './MemoryControlStore';
import type { MemoryModelRunner } from './Phase1';
import { TimelineMemoryStore, timelineDigest, timelineSubtreeFingerprint } from './TimelineMemoryStore';
import {
  captureConsolidationSnapshot, dayNeedsTitle, dayReadyForTitle, selectConsolidationNodes, snapshotNodeFingerprint,
  requireSnapshotSupport, type ConsolidationSnapshot, type MemorySourceReadiness,
} from './ConsolidationSnapshot';
import { planConsolidation, planLeavesDayUnnamed, validateConsolidationChanges, type ConsolidationPlan } from './ConsolidationPlan';
import type { MemoryConsolidationRequest } from './MemoryJobs';

interface ConsolidationPublicationPayload extends Omit<ConsolidationPlan, 'hasPublication'> {
  readonly titleSubtreeFingerprints: Readonly<Record<string, string>>;
  readonly rollbackFingerprint: string;
}

export interface Phase2Options {
  readonly now?: () => number;
  readonly sourceReadiness?: () => MemorySourceReadiness;
}

export type ConsolidationOutcome = 'published' | 'unchanged' | 'disabled' | 'deferred';

export class Phase2 {
  constructor(
    private readonly control: MemoryControlStore,
    private readonly timeline: TimelineMemoryStore,
    private readonly model: MemoryModelRunner,
    private readonly internalThread: () => Thread | null,
    private readonly options: Phase2Options = {},
  ) {}

  async run(signal: AbortSignal, request: MemoryConsolidationRequest = { task: 'consolidate' }): Promise<ConsolidationOutcome> {
    const input = this.snapshot(true);
    if (input.status.featureMode !== 'enabled') return 'disabled';
    if (input.rollbacks.some((rollback) => rollback.status === 'prepared')) return 'deferred';
    const sourceDate = request.task === 'nameDay' ? request.sourceDate : undefined;
    if (sourceDate && !dayNeedsTitle(input, sourceDate)) return 'unchanged';
    const readiness = this.readiness(input);
    if (sourceDate && !dayReadyForTitle(input, readiness, sourceDate)) return 'deferred';
    const selected = selectConsolidationNodes(input, readiness, sourceDate);
    const proposals = selected.length ? await this.consolidate(selected, signal) : [];
    const titleSubtreeFingerprints = Object.fromEntries(proposals.flatMap((change) => {
      if (change.action !== 'update') return [];
      const node = selected.find((entry) => entry.nodeId === change.nodeId);
      return node?.titleSubtreeFingerprint ? [[node.nodeId, node.titleSubtreeFingerprint]] : [];
    }));
    return this.timeline.withWriteGate(async (): Promise<ConsolidationOutcome> => {
      const current = this.snapshot();
      this.validateTitles(titleSubtreeFingerprints, current);
      validateState(current, input.status, rollbackFingerprint(input), signal);
      validateFingerprints(Object.fromEntries(selected.map((node) => [node.nodeId, snapshotNodeFingerprint(input, node.nodeId)])), current);
      const temporaryIds = new Map(proposals.flatMap((change) => change.action === 'create' ? [[change.temporaryId, freshNodeId()] as const] : []));
      const plan = planConsolidation(current, selected, proposals, temporaryIds);
      const needsTitle = sourceDate && planLeavesDayUnnamed(current, plan, sourceDate);
      if (!plan.hasPublication) {
        this.control.recordSuccess(current.now);
        return plan.followUpAt !== null || needsTitle ? 'deferred' : 'unchanged';
      }
      const operationId = `memory:stage2:${uuidV7()}`;
      const generation = this.control.allocatePublicationGeneration();
      const { hasPublication: _hasPublication, ...publicationPlan } = plan;
      const payload: ConsolidationPublicationPayload = { ...publicationPlan, titleSubtreeFingerprints, rollbackFingerprint: rollbackFingerprint(current) };
      const journal: MemoryPublicationRecord<ConsolidationPublicationPayload> = {
        id: operationId, kind: 'stage2', status: 'prepared', generation,
        featureGeneration: current.status.featureModeGeneration, resetEpoch: current.status.resetEpoch,
        digest: timelineDigest({ operationId, generation, payload }), payload, createdAt: current.now,
      };
      this.control.preparePublication(journal);
      await this.timeline.applyConsolidationWithinWriteGate(journal.id, generation, journal.digest, plan.changes, () => {
        const admitted = this.snapshot();
        this.validateTitles(payload.titleSubtreeFingerprints, admitted);
        for (const node of payload.upsertedNodes) {
          if (admitted.generated.get(node.nodeId)?.subject === 'user' && node.subject !== 'user') throw new Error('Personal Memory cannot be reclassified as context');
          requireSnapshotSupport(admitted, node.subject, payload.lineage.filter((edge) => edge.nodeId === node.nodeId));
        }
        validateState(admitted, current.status, payload.rollbackFingerprint, signal);
        validateFingerprints(payload.inputFingerprints, admitted);
      });
      this.finalize(journal);
      return needsTitle ? 'deferred' : 'published';
    });
  }

  private snapshot(withUsage = false): ConsolidationSnapshot {
    return captureConsolidationSnapshot(this.timeline, this.control, this.options.now?.() ?? Date.now(), withUsage);
  }

  private readiness(snapshot: ConsolidationSnapshot): MemorySourceReadiness {
    if (snapshot.rollbacks.length || !snapshot.graph.containers.some((entry) => entry.sourceDate < snapshot.today)) return { kind: 'unavailable' };
    try { return this.options.sourceReadiness?.() ?? { kind: 'known', pendingDates: new Set() }; }
    catch { return { kind: 'unavailable' }; }
  }

  private validateTitles(fingerprints: Readonly<Record<string, string>>, snapshot: ConsolidationSnapshot): void {
    if (Object.keys(fingerprints).length === 0) return;
    const readiness = this.readiness(snapshot);
    for (const [id, fingerprint] of Object.entries(fingerprints)) {
      if (timelineSubtreeFingerprint(id, snapshot.projection) !== fingerprint) throw new Error(`Memory day changed during title generation: ${id}`);
      const entry = snapshot.entries.get(id);
      if (!entry || !dayReadyForTitle(snapshot, readiness, entry.sourceDate)) throw new Error('Memory day is still receiving eligible evidence');
    }
  }

  private async consolidate(selected: readonly MemoryConsolidationNode[], signal: AbortSignal): Promise<MemoryConsolidationOutput['changes']> {
    const sourceThread = this.internalThread();
    if (!sourceThread) return [];
    const raw = await this.model.run({ purpose: 'consolidate', sourceThread, systemPrompt: CONSOLIDATION_SYSTEM_PROMPT, prompt: consolidationPrompt(selected), signal });
    if (signal.aborted) throw abortError();
    return validateConsolidationChanges(decodeMemoryConsolidationOutput(parseJsonObject(raw)), selected);
  }

  async recoverPrepared(record: MemoryPublicationRecord, receiptMatches: boolean): Promise<void> {
    if (record.kind !== 'stage2' || record.status !== 'prepared' || !receiptMatches) return;
    await this.timeline.withWriteGate(async () => this.finalize(record as MemoryPublicationRecord<ConsolidationPublicationPayload>));
  }

  private finalize(journal: MemoryPublicationRecord<ConsolidationPublicationPayload>): void {
    this.control.finalizeStage2({ ...journal.payload, publicationId: journal.id,
      deletedNodeIds: journal.payload.changes.filter((change) => change.action === 'delete').map((change) => change.nodeId),
    });
  }
}

function validateFingerprints(fingerprints: Readonly<Record<string, string>>, snapshot: ConsolidationSnapshot): void {
  for (const [id, fingerprint] of Object.entries(fingerprints)) {
    if (snapshotNodeFingerprint(snapshot, id) !== fingerprint) throw new Error(`Memory Node changed during consolidation: ${id}`);
  }
}

function rollbackFingerprint(snapshot: ConsolidationSnapshot): string { return timelineDigest(snapshot.rollbacks); }

function validateState(snapshot: ConsolidationSnapshot, expected: ConsolidationSnapshot['status'], rollbacks: string, signal: AbortSignal): void {
  if (signal.aborted || snapshot.status.featureMode !== 'enabled' || snapshot.status.featureModeGeneration !== expected.featureModeGeneration
    || snapshot.status.resetEpoch !== expected.resetEpoch) throw abortError();
  if (rollbackFingerprint(snapshot) !== rollbacks) throw new Error('Memory rollback state changed during consolidation');
}

function consolidationPrompt(nodes: readonly MemoryConsolidationNode[]): string {
  return JSON.stringify({
    task: 'Reconcile the selected Daily Timeline Memory graph.',
    rules: [
      'Keep user-authored or user-edited Nodes unchanged, including manually edited day titles.',
      'Every create/update declares subject:user for personal preferences or background, or subject:context otherwise. A personal Node cannot be downgraded to context. Day titles remain context.',
      'Use supportingSources to inspect actual origin kinds and reader-text availability. Personal creates and updates require current reader-authored text; web/MCP/attachment/Host/assistant sources alone cannot establish or replace them. Preserve the actual attribution and scope of external knowledge.',
      'A generated memory container starts as Memory. titleSourceNodeIds is provided only after that source day ends and its eligible evidence has finished processing, with the complete same-day record set selected.',
      'Then give that finished day a short, vivid and memorable title grounded in its records, using their language and at most 160 characters. A concrete image or gentle wordplay is welcome when it fits; never invent events, exaggerate, or force humor.',
      'A day title is navigation, not new evidence or a daily narrative. Summarize the resulting retained records without repeating Memory or the date. Keep it when it still describes the content.',
      'For a title update, cite records from its titleSourceNodeIds only. Without that complete-day view, keep the existing title. Never replace it from only the newest batch or another day.',
      'Keep existing supported content unless there is concrete future benefit from a correction or duplicate merge; no routine rewriting or new wrappers.',
      'Update concise generated beliefs, questions, guidance, and optional episodes only when evidence supports it.',
      'Delete unsupported generated Nodes only when every descendant is also supplied as a generated delete.',
      'Merge duplicate generated episodes by updating the retained episode and deleting the complete duplicate subtree.',
      'Create an episode beneath a memory container, or a category beneath a memory container or episode.',
      'For every create or update, cite supplied sourceNodeIds that carry current evidence.',
      'Use temporary IDs in the form new:<name> for created Nodes. Return one change per supplied or temporary ID.',
    ],
    nodes,
    output: {
      changes: [
        {
          nodeId: 'exact supplied id',
          action: 'update',
          text: 'updated Memory text',
          subject: 'user | context',
          sourceNodeIds: ['supplied nodeId carrying evidence'],
        },
        { nodeId: 'exact supplied id', action: 'keep | delete' },
        {
          temporaryId: 'new:short-name',
          action: 'create',
          parentId: 'supplied nodeId or earlier temporaryId',
          category: 'episode | belief | question | guidance',
          text: 'new Memory text',
          subject: 'user | context',
          sourceNodeIds: ['supplied nodeId carrying evidence'],
        },
      ],
    },
  });
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Memory consolidation did not return a JSON object');
  return JSON.parse(fenced.slice(start, end + 1));
}

function abortError(): Error {
  const error = new Error('Memory consolidation was interrupted');
  error.name = 'AbortError';
  return error;
}

const CONSOLIDATION_SYSTEM_PROMPT = `You consolidate canonical Memory Nodes on a daily timeline.
Return exact JSON and nothing else. Treat user-authored or user-edited Nodes as authoritative.
Never invent evidence. Preserve useful uncertainty. Keep guidance actionable and concise.
Use only supplied Node IDs and obey every mutation restriction in the input.`;

export type { ConsolidationPublicationPayload };
