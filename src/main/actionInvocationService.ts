// The main-owned admission path for the unified command surface.
//
// A renderer may NAME an action; it may never author one. Every inbound
// message names an action id, an invocation ref, a subject ref and typed
// arguments — nothing else. Main re-evaluates that tuple against the latest
// projection, proves the subject against current membership and every
// object-valued argument against its exact ready slot, and only then produces
// and executes the effect. `ActionEffectPlan` therefore only ever travels
// main -> renderer, the trusted direction.
//
// See `docs/plans/unified-command-surface.md` D1a/D1b.

import { randomUUID } from 'node:crypto';
import {
  admitsMoveToDestination,
  buildTagCandidateIndex,
  moveToEmptyQueryOrder,
  rankTagCandidates,
} from '../core/actions/candidates';
import {
  consumerPathsFor,
  isStepReference,
  readBoundValue,
  commandProducesBinding,
  type ActionEffectPlan,
  type AppSurface,
  type EffectStep,
  type StepRef,
} from '../core/actions/bindings';
import { createTagCandidateName, objectTypeLabel } from '../core/actions/names';
import {
  nodeIdForFacet,
  nodeObjectForRow,
  nodeSelectionObject,
  nodeText,
  presentObject,
} from '../core/actions/objects';
import {
  eligibleMoveToIds,
  planFor,
  resolveActionsForObjectSet,
  resolveFamily,
} from '../core/actions/registry';
import {
  commonTagIdsForTargets,
  contentTargetIdsForRows,
  nodeRowFacetsForId,
  selectionRootIds,
} from '../core/actions/rowFacets';
import type {
  ActionArguments,
  ActionId,
  ActionInvocation,
  ActionPresentation,
  ActionProjection,
  ActionRequest,
  ActionRequestResult,
  ActionResolveContext,
  ActionExecutionResult,
  ArgumentObjectGeneration,
  ArgumentSlot,
  ChallengeToken,
  InvocationEvent,
  InvocationEventResult,
  InvocationOpened,
  InvocationPhase,
  InvocationRef,
  InvocationSeed,
  ObjectPresentation,
  ObjectRef,
  ParameterObjectQueryRequest,
  ParameterObjectQueryResult,
  ReadyActionPresentation,
  SurfaceObject,
} from '../core/actions/types';
import type { DocumentProjection, FocusHint, NodeId, NodeProjection, SearchHit } from '../core/types';

/** How many ranked hits admission filters before the picker's own limit. */
const CANDIDATE_FETCH_LIMIT = 200;
const CANDIDATE_LIMIT = 10;
const INVOCATION_TTL_MS = 5 * 60_000;
const CHALLENGE_TTL_MS = 60_000;

export type RendererStepAck =
  | { status: 'ok' }
  | { status: 'reported'; code: string }
  | { status: 'notDelivered' }
  | { status: 'gone' }
  | { status: 'timeout' };

export interface ActionInvocationHost {
  projection(): DocumentProjection;
  /** `documentService.handle`, with the invoking renderer recorded as source. */
  runCommand(command: string, args: Record<string, unknown>): Promise<unknown>;
  searchNodes(query: string, limit: number): SearchHit[];
  /** Route a renderer step to the MAIN renderer and wait for its ack. */
  executeRendererStep(step: EffectStep, invocationRef: InvocationRef): Promise<RendererStepAck>;
  activateAppSurface(surface: AppSurface): Promise<void>;
  writeClipboard(text: string): void;
  /** The active locale's untitled fallback — part of `copy`'s parity. */
  untitled(): string;
  now(): number;
}

interface Challenge {
  token: ChallengeToken;
  actionId: ActionId;
  subjectRef: ObjectRef;
  argumentsHash: string;
  expiresAt: number;
}

interface Record_ {
  ref: InvocationRef;
  invocation: ActionInvocation;
  origin: 'main' | 'mainRenderer';
  attestation?: { webContentsId: number; renderGeneration: number };
  consumableBy: number;
  openSeq: number | null;
  phase: InvocationPhase;
  expiresAt: number;
  /** Every object main minted for this invocation, by ref. */
  objects: Map<ObjectRef, SurfaceObject>;
  /** Main-owned monotonic counter; request ids are never trusted. */
  generation: number;
  challenge: Challenge | null;
}

function mintRef<T extends string>(): T {
  return randomUUID() as T;
}

function hashArguments(args: unknown): string {
  return JSON.stringify(args ?? null);
}

export class ActionInvocationService {
  private readonly records = new Map<InvocationRef, Record_>();

  constructor(private readonly host: ActionInvocationHost) {}

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  /**
   * A SENDER-CHECKED main-renderer seed carries raw FACTS only. Main validates
   * the ids, derives each node's row/content/canonical-surface facets plus
   * selection roots, constructs the object set, and mints the ref, origin,
   * attestation, lifetime and consumer.
   */
  openFromSeed(
    seed: InvocationSeed,
    sender: { webContentsId: number; renderGeneration: number },
  ): InvocationOpened | null {
    const projection = this.actionProjection();
    if (!projection.byId.has(seed.anchorNodeId)) return null;

    const objects = new Map<ObjectRef, SurfaceObject>();
    const mint = () => {
      const ref = mintRef<ObjectRef>();
      return ref;
    };

    // The anchored row keeps the shipped chain-resolved content target.
    const anchor = nodeObjectForRow(seed.anchorNodeId, projection.byId, mint);
    objects.set(anchor.objectRef, anchor);

    const fixedObjects: SurfaceObject[] = [anchor];
    const selection = this.selectionObjectFor(seed, projection, mint, objects);
    if (selection) fixedObjects.push(selection);

    const invocation: ActionInvocation = {
      fixedObjects,
      argumentGenerations: [],
      draftText: '',
      view: [{
        objectRef: anchor.objectRef,
        panelId: seed.panelId,
        visualRowId: seed.visualRowId,
        rowExpanded: seed.rowExpanded,
      }],
      workspace: [{ objectRef: anchor.objectRef, isPinned: seed.isPinned }],
    };

    const record: Record_ = {
      ref: mintRef<InvocationRef>(),
      invocation,
      origin: 'mainRenderer',
      attestation: {
        webContentsId: sender.webContentsId,
        renderGeneration: sender.renderGeneration,
      },
      consumableBy: sender.webContentsId,
      openSeq: null,
      phase: 'live',
      expiresAt: this.host.now() + INVOCATION_TTL_MS,
      objects,
      generation: 0,
      challenge: null,
    };
    this.records.set(record.ref, record);
    this.sweep();
    return this.openingFor(record);
  }

  private selectionObjectFor(
    seed: InvocationSeed,
    projection: ActionProjection,
    mint: () => ObjectRef,
    objects: Map<ObjectRef, SurfaceObject>,
  ): SurfaceObject | null {
    const selected = new Set(seed.selectedIds);
    if (!selected.has(seed.anchorNodeId) || selected.size <= 1) return null;
    const roots = selectionRootIds([...selected], projection.byId);
    if (roots.length <= 1) return null;
    // Selection members keep the shipped SINGLE-HOP content target; only the
    // anchored row resolves a reference chain. Preserving that asymmetry is
    // what makes the differential proof pass rather than "look close".
    const nodes = roots.map((rowId) => {
      const node = nodeObjectForRow(rowId, projection.byId, mint);
      const singleHop = contentTargetIdsForRows([rowId], projection.byId)[0] ?? rowId;
      const withSingleHop = { ...node, content: { by: 'id' as const, nodeId: singleHop } };
      objects.set(withSingleHop.objectRef, withSingleHop);
      return withSingleHop;
    });
    const selection = nodeSelectionObject(nodes, mint);
    objects.set(selection.objectRef, selection);
    return selection;
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  private openingFor(record: Record_): InvocationOpened {
    const context = this.contextFor(record);
    const currentObjects = this.currentObjects(record);
    return {
      invocationRef: record.ref,
      openSeq: record.openSeq,
      fixedItems: record.invocation.fixedObjects.map((object) => ({
        object: presentObject(object, context.projection, context.untitled),
        actions: [],
      })),
      resultItems: [],
      menuActions: resolveActionsForObjectSet(context, currentObjects, { surface: 'contextMenu' }),
    };
  }

  /** Fixed objects plus the one `ready` result generation — nothing else. */
  private currentObjects(record: Record_): SurfaceObject[] {
    const generation = record.invocation.resultGeneration;
    return [
      ...record.invocation.fixedObjects,
      ...(generation?.state === 'ready' ? generation.objects : []),
    ];
  }

  private actionProjection(): ActionProjection {
    const projection = this.host.projection();
    const byId = new Map<NodeId, NodeProjection>();
    for (const node of projection.nodes) byId.set(node.id, node);
    return {
      byId,
      trashId: projection.trashId,
      todayId: projection.todayId,
      libraryId: projection.libraryId,
      schemaId: projection.schemaId,
      searchesId: projection.searchesId,
    };
  }

  private contextFor(record: Record_): ActionResolveContext {
    const projection = this.actionProjection();
    return {
      projection,
      invocation: record.invocation,
      objectFor: (ref) => record.objects.get(ref) ?? null,
      untitled: this.host.untitled(),
    };
  }

  // -------------------------------------------------------------------------
  // Parameter object queries
  // -------------------------------------------------------------------------

  /**
   * A request cannot create a slot merely by naming one: main first proves the
   * current presentation owns it, then installs an empty `pending` generation,
   * then installs fresh objects only if its private generation is still
   * current.
   */
  queryParameterObjects(
    request: ParameterObjectQueryRequest,
    senderId: number,
  ): ParameterObjectQueryResult {
    const record = this.liveRecord(request.invocationRef, senderId);
    const superseded = {
      status: 'superseded' as const,
      invocationRef: request.invocationRef,
      slot: request.slot,
      requestId: request.requestId,
      generation: record?.generation ?? 0,
    };
    if (!record) return superseded;
    const subject = record.objects.get(request.slot.subjectRef);
    if (!subject || !this.isAdmissibleSubject(record, request.slot.subjectRef)) return superseded;
    if (!this.ownsParameterSlot(record, request.slot, subject)) return superseded;

    const generation = ++record.generation;
    this.replaceArgumentGeneration(record, {
      slot: request.slot,
      generation,
      source: { kind: 'query', requestId: request.requestId },
      state: 'pending',
      objects: [],
    });

    const context = this.contextFor(record);
    const built = this.buildParameterCandidates(context, record, request, subject);
    if (record.generation !== generation) return { ...superseded, generation: record.generation };

    this.replaceArgumentGeneration(record, {
      slot: request.slot,
      generation,
      source: { kind: 'query', requestId: request.requestId },
      state: 'ready',
      objects: built.objects,
    });
    return {
      status: 'ready',
      invocationRef: record.ref,
      slot: request.slot,
      requestId: request.requestId,
      generation,
      items: built.items,
    };
  }

  private ownsParameterSlot(
    record: Record_,
    slot: ArgumentSlot,
    subject: SurfaceObject,
  ): boolean {
    const context = this.contextFor(record);
    return resolveFamily(context, slot.actionId, subject).some((presentation) => (
      presentation.binding.state === 'needsParameter'
      && presentation.binding.parameter.parameterId === slot.parameterId
    ));
  }

  private buildParameterCandidates(
    context: ActionResolveContext,
    record: Record_,
    request: ParameterObjectQueryRequest,
    subject: SurfaceObject,
  ): { objects: SurfaceObject[]; items: ObjectPresentation[] } {
    const objects: SurfaceObject[] = [];
    const items: ObjectPresentation[] = [];
    const mint = () => mintRef<ObjectRef>();
    const query = request.query.trim();

    if (request.slot.actionId === 'move' && request.slot.parameterId === 'destination') {
      const moving = eligibleMoveToIds(context, subject);
      const { byId, trashId } = context.projection;
      const candidateIds = query
        // Admission runs BEFORE the limit: the ranked kernel is asked for a
        // generous set, admission filters it, and only then is it limited.
        ? this.host.searchNodes(query, CANDIDATE_FETCH_LIMIT)
          .map((hit: SearchHit) => hit.nodeId)
          .filter((id) => admitsMoveToDestination({ candidateId: id, moving, byId, trashId }))
          .slice(0, CANDIDATE_LIMIT)
        : moveToEmptyQueryOrder({
          nodes: this.host.projection().nodes,
          moving,
          byId,
          trashId,
          limit: CANDIDATE_LIMIT,
        });
      for (const nodeId of candidateIds) {
        const object = nodeObjectForRow(nodeId, byId, mint);
        objects.push(object);
        record.objects.set(object.objectRef, object);
        items.push(presentObject(object, context.projection, context.untitled));
      }
      return { objects, items };
    }

    if (request.slot.actionId === 'addTag' && request.slot.parameterId === 'tag') {
      const projection = this.host.projection();
      const index = buildTagCandidateIndex({
        nodes: projection.nodes,
        byId: context.projection.byId,
        trashId: context.projection.trashId,
      });
      const targets = this.tagTargetsFor(context, subject);
      const candidates = rankTagCandidates({
        index,
        query: request.query,
        existingTagIds: commonTagIdsForTargets(targets, context.projection.byId),
        limit: 8,
      });
      for (const candidate of candidates) {
        if (candidate.type === 'existing') {
          const object = nodeObjectForRow(candidate.tag.id, context.projection.byId, mint);
          objects.push(object);
          record.objects.set(object.objectRef, object);
          items.push({
            objectRef: object.objectRef,
            kind: 'node',
            name: {
              source: 'literal',
              value: nodeText(candidate.tag, context.untitled),
            },
            iconId: 'supertag',
            typeLabel: objectTypeLabel('node'),
          });
          continue;
        }
        const draft: SurfaceObject = {
          kind: 'draft',
          objectRef: mint(),
          purpose: 'tag',
          text: candidate.name,
        };
        objects.push(draft);
        record.objects.set(draft.objectRef, draft);
        items.push({
          objectRef: draft.objectRef,
          kind: 'draft',
          name: { source: 'localized', values: createTagCandidateName(candidate.name) },
          iconId: 'supertag',
          typeLabel: objectTypeLabel('draftTag'),
        });
      }
      return { objects, items };
    }

    return { objects, items };
  }

  private tagTargetsFor(context: ActionResolveContext, subject: SurfaceObject): NodeId[] {
    if (subject.kind === 'node') {
      return [nodeIdForFacet(subject.content, context.projection)];
    }
    if (subject.kind !== 'nodeSelection') return [];
    const rowIds = subject.nodes
      .map((node) => (node.row.by === 'id' ? node.row.nodeId : null))
      .filter((id): id is NodeId => id !== null)
      .filter((id) => nodeRowFacetsForId(id, context.projection.byId)?.actionPolicy.tag !== 'disabled');
    return contentTargetIdsForRows(rowIds, context.projection.byId);
  }

  private replaceArgumentGeneration(record: Record_, next: ArgumentObjectGeneration): void {
    const previous = record.invocation.argumentGenerations.filter((generation) => !(
      generation.slot.actionId === next.slot.actionId
      && generation.slot.subjectRef === next.slot.subjectRef
      && generation.slot.parameterId === next.slot.parameterId
    ));
    record.invocation = {
      ...record.invocation,
      argumentGenerations: [...previous, next],
    };
    // A challenge naming the replaced generation dies with it.
    if (record.phase === 'confirming' && record.challenge?.actionId === next.slot.actionId) {
      record.challenge = null;
      record.phase = 'live';
    }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async request(request: ActionRequest, senderId: number): Promise<ActionRequestResult> {
    const record = this.records.get(request.invocationRef);
    if (!record || record.consumableBy !== senderId || record.expiresAt <= this.host.now()) {
      return { status: 'stale', reason: 'invocation' };
    }
    if (record.phase === 'spent' || record.phase === 'executing') {
      return { status: 'stale', reason: 'invocation' };
    }
    const subject = record.objects.get(request.subjectRef);
    if (!subject || !this.isAdmissibleSubject(record, request.subjectRef)) {
      return { status: 'stale', reason: 'subject' };
    }
    const argumentCheck = this.validateArguments(record, request);
    if (argumentCheck) return argumentCheck;

    const context = this.contextFor(record);
    const presentations = resolveFamily(context, request.actionId, subject);
    const suppliedParameters = new Set(
      objectValuedArguments(request.actionId, request.arguments).map(([parameterId]) => parameterId),
    );
    const match = presentations.find((presentation) => (
      presentation.binding.state === 'ready'
        // A direct variant matches only its own exact arguments.
        ? hashArguments(presentation.binding.arguments) === hashArguments(request.arguments)
        // A parameterized variant is named by filling its declared slot; the
        // ref itself was already proved against that slot's ready generation.
        : suppliedParameters.has(presentation.binding.parameter.parameterId)
    ));
    if (!match) {
      const fallback = presentations[0];
      return fallback
        ? { status: 'reEvaluated', presentation: fallback }
        : { status: 'stale', reason: 'subject' };
    }
    if (match.evaluation.status !== 'applicable') {
      return { status: 'reEvaluated', presentation: match };
    }

    if (match.confirm && !request.challenge) {
      // Leg 1 is a RESPONSE, not a side effect: the token comes back with the
      // authoritative copy, subject and arguments the dialog must show, so the
      // dialog cannot describe one thing while the token authorises another.
      const challenge: Challenge = {
        token: mintRef<ChallengeToken>(),
        actionId: request.actionId,
        subjectRef: request.subjectRef,
        argumentsHash: hashArguments(request.arguments),
        expiresAt: this.host.now() + CHALLENGE_TTL_MS,
      };
      record.challenge = challenge;
      record.phase = 'confirming';
      return {
        status: 'confirmationRequired',
        challenge: challenge.token,
        confirm: match.confirm,
        presentation: match as ReadyActionPresentation,
      };
    }

    if (match.confirm) {
      // The challenge-bearing request IS the acceptance, and it commits
      // atomically after token + subject + argument revalidation.
      const challenge = record.challenge;
      const valid = challenge
        && record.phase === 'confirming'
        && challenge.token === request.challenge
        && challenge.expiresAt > this.host.now()
        && challenge.actionId === request.actionId
        && challenge.subjectRef === request.subjectRef
        && challenge.argumentsHash === hashArguments(request.arguments);
      record.challenge = null;
      if (!valid) {
        // A revoked, expired or cross-action token is dead: the record returns
        // to `live` and NOTHING runs. Redeeming after cancel lands here.
        record.phase = 'live';
        return { status: 'stale', reason: 'invocation' };
      }
    }

    const plan = planFor(context, request.actionId, subject, request.arguments as never);
    if (!plan) return { status: 'reEvaluated', presentation: match };

    // Claimed on ENTERING `executing`, before step 0 is dispatched — a second
    // submit against a claimed record is rejected.
    record.phase = 'executing';
    try {
      return await this.executePlan(plan, record.ref);
    } finally {
      record.phase = 'spent';
    }
  }

  private validateArguments(record: Record_, request: ActionRequest): ActionRequestResult | null {
    const refs = objectValuedArguments(request.actionId, request.arguments);
    for (const [parameterId, ref] of refs) {
      const generation = record.invocation.argumentGenerations.find((candidate) => (
        candidate.state === 'ready'
        && candidate.slot.actionId === request.actionId
        && candidate.slot.subjectRef === request.subjectRef
        && candidate.slot.parameterId === parameterId
      ));
      if (!generation || !generation.objects.some((object) => object.objectRef === ref)) {
        // Rejected by SLOT, never by backing identity: a main-list subject ref
        // for the same node is not a destination ref.
        return { status: 'stale', reason: 'argument' };
      }
    }
    return null;
  }

  private isAdmissibleSubject(record: Record_, ref: ObjectRef): boolean {
    return this.currentObjects(record).some((object) => object.objectRef === ref);
  }

  async executePlan(
    plan: ActionEffectPlan,
    invocationRef: InvocationRef,
  ): Promise<ActionExecutionResult> {
    const bindings = new Map<StepRef, NodeId>();
    let focus: FocusHint | undefined;
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]!;
      if (step.on === 'main' && step.kind === 'command') {
        const args = resolveBoundArgs(step.command, step.args, bindings);
        if (!args) {
          return { status: 'failed', atStep: index, reason: { kind: 'bindingUnresolved', step: index } };
        }
        let result: unknown;
        try {
          result = await this.host.runCommand(step.command, args);
        } catch (error) {
          return {
            status: 'failed',
            atStep: index,
            reason: { kind: 'commandRejected', code: errorCode(error) },
          };
        }
        if (step.bindAs && commandProducesBinding(step.command)) {
          const value = readBoundValue(step.command, 'focusNodeId', result);
          if (value) bindings.set(step.bindAs, value);
        }
        focus = (result as { focus?: FocusHint } | undefined)?.focus ?? focus;
        continue;
      }
      if (step.on === 'main' && step.kind === 'clipboard') {
        this.host.writeClipboard(step.text);
        continue;
      }
      if (step.on === 'main' && step.kind === 'activateAppSurface') {
        try {
          await this.host.activateAppSurface(step.surface);
        } catch (error) {
          return {
            status: 'failed',
            atStep: index,
            reason: { kind: 'rendererReported', code: errorCode(error) },
          };
        }
        continue;
      }
      const resolved = resolveRendererStep(step, bindings);
      if (!resolved) {
        return { status: 'failed', atStep: index, reason: { kind: 'bindingUnresolved', step: index } };
      }
      // Renderer steps are emitted only AFTER the preceding main step
      // succeeded, and main waits for the ack before emitting the next one.
      const ack = await this.host.executeRendererStep(resolved, invocationRef);
      if (ack.status === 'ok') continue;
      if (ack.status === 'notDelivered') {
        return { status: 'failed', atStep: index, reason: { kind: 'notDelivered' } };
      }
      if (ack.status === 'reported') {
        return {
          status: 'failed',
          atStep: index,
          reason: { kind: 'rendererReported', code: ack.code },
        };
      }
      // A missing ack does NOT prove the step did not run.
      return {
        status: 'indeterminate',
        atStep: index,
        reason: ack.status === 'gone' ? 'rendererGone' : 'ackTimeout',
      };
    }
    return focus ? { status: 'completed', focus } : { status: 'completed' };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  event(event: InvocationEvent, senderId: number): InvocationEventResult {
    const record = this.records.get(event.invocationRef);
    if (!record || record.consumableBy !== senderId) return { status: 'spent' };
    switch (event.kind) {
      case 'confirmationCancelled':
        if (record.phase === 'confirming' && record.challenge?.token === event.challenge) {
          record.challenge = null;
          record.phase = 'live';
        }
        return { status: 'updated', opening: this.openingFor(record) };
      case 'objectRemoved': {
        if (record.phase === 'executing' || record.phase === 'spent') return { status: 'spent' };
        record.invocation = {
          ...record.invocation,
          fixedObjects: record.invocation.fixedObjects
            .filter((object) => object.objectRef !== event.objectRef),
        };
        this.invalidateRefsFor(record, event.objectRef);
        return { status: 'updated', opening: this.openingFor(record) };
      }
      case 'selectionMemberRemoved':
        return this.removeSelectionMember(record, event.selectionRef, event.memberRef);
      case 'abandoned':
        // Reserved for closing the menu or panel; a UI lifetime event never
        // invalidates an in-flight plan.
        if (record.phase !== 'executing') {
          record.phase = 'spent';
          this.records.delete(record.ref);
        }
        return { status: 'spent' };
    }
  }

  private removeSelectionMember(
    record: Record_,
    selectionRef: ObjectRef,
    memberRef: ObjectRef,
  ): InvocationEventResult {
    if (record.phase === 'executing' || record.phase === 'spent') return { status: 'spent' };
    const selection = record.objects.get(selectionRef);
    if (!selection || selection.kind !== 'nodeSelection') return { status: 'spent' };
    const remaining = selection.nodes.filter((node) => node.objectRef !== memberRef);
    if (remaining.length === selection.nodes.length) return { status: 'spent' };

    // The aggregate is atomically REPLACED with a freshly referenced one (or a
    // single node / no chip), so replaying the prior ref cannot address the old
    // set.
    const withoutOld = record.invocation.fixedObjects
      .filter((object) => object.objectRef !== selectionRef);
    this.invalidateRefsFor(record, selectionRef);
    if (remaining.length <= 1) {
      record.invocation = { ...record.invocation, fixedObjects: withoutOld };
    } else {
      const replacement = nodeSelectionObject(remaining, () => mintRef<ObjectRef>());
      record.objects.set(replacement.objectRef, replacement);
      record.invocation = {
        ...record.invocation,
        fixedObjects: [...withoutOld, replacement],
      };
    }
    return { status: 'updated', opening: this.openingFor(record) };
  }

  /** A removed/replaced subject takes its argument slots and challenge with it. */
  private invalidateRefsFor(record: Record_, ref: ObjectRef): void {
    record.objects.delete(ref);
    record.invocation = {
      ...record.invocation,
      argumentGenerations: record.invocation.argumentGenerations
        .filter((generation) => generation.slot.subjectRef !== ref),
    };
    if (record.challenge?.subjectRef === ref) {
      record.challenge = null;
      if (record.phase === 'confirming') record.phase = 'live';
    }
  }

  private liveRecord(ref: InvocationRef, senderId: number): Record_ | null {
    const record = this.records.get(ref);
    if (!record || record.consumableBy !== senderId) return null;
    if (record.expiresAt <= this.host.now()) return null;
    // Queries and membership edits are admitted only in `live` / `confirming`.
    if (record.phase !== 'live' && record.phase !== 'confirming') return null;
    return record;
  }

  /** A reload invalidates an attestation rather than leaving a stale bit live. */
  invalidateRenderer(webContentsId: number): void {
    for (const [ref, record] of this.records) {
      if (record.attestation?.webContentsId !== webContentsId) continue;
      if (record.phase === 'executing') continue;
      this.records.delete(ref);
    }
  }

  private sweep(): void {
    const now = this.host.now();
    for (const [ref, record] of this.records) {
      if (record.phase === 'executing') continue;
      if (record.expiresAt <= now) this.records.delete(ref);
    }
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The object-valued arguments a request carries, by parameter id. */
function objectValuedArguments(
  actionId: ActionId,
  args: ActionArguments[ActionId],
): [string, ObjectRef][] {
  const result: [string, ObjectRef][] = [];
  if (actionId === 'move' && 'destination' in args && args.destination) {
    result.push(['destination', args.destination as ObjectRef]);
  }
  if (actionId === 'addTag' && 'tag' in args && args.tag) {
    result.push(['tag', args.tag as ObjectRef]);
  }
  if (actionId === 'capture' || actionId === 'create') {
    if ('destination' in args && args.destination) {
      result.push(['destination', args.destination as ObjectRef]);
    }
    if ('tag' in args && args.tag) result.push(['tag', args.tag as ObjectRef]);
  }
  return result;
}

/** Replace step references at the descriptor's exact paths — nowhere else. */
function resolveBoundArgs(
  command: string,
  args: unknown,
  bindings: ReadonlyMap<StepRef, NodeId>,
): Record<string, unknown> | null {
  const clone = structuredClone(args) as Record<string, unknown>;
  for (const path of consumerPathsFor(command)) {
    let cursor: Record<string, unknown> = clone;
    for (let index = 0; index < path.length - 1; index += 1) {
      const next = cursor[path[index]!];
      if (typeof next !== 'object' || next === null) { cursor = clone; break; }
      cursor = next as Record<string, unknown>;
    }
    const leaf = path[path.length - 1]!;
    const value = cursor[leaf];
    if (!isStepReference(value)) continue;
    const resolved = bindings.get(value.fromStep as StepRef);
    if (!resolved) return null;
    cursor[leaf] = resolved;
  }
  return clone;
}

function resolveRendererStep(
  step: EffectStep,
  bindings: ReadonlyMap<StepRef, NodeId>,
): EffectStep | null {
  if (step.on !== 'mainRenderer') return step;
  if (step.kind === 'navigate' || step.kind === 'workspace') {
    if (!isStepReference(step.nodeId)) return step;
    const resolved = bindings.get(step.nodeId.fromStep as StepRef);
    return resolved ? { ...step, nodeId: resolved } : null;
  }
  return step;
}

export type { ActionPresentation };
