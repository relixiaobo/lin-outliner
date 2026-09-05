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
import { createTagCandidateName } from '../core/actions/names';
import {
  nodeIdForFacet,
  nodeObjectForRow,
  nodeSelectionObject,
  nodeText,
  presentObject,
  type ExternalPageDescription,
} from '../core/actions/objects';
import {
  ACTION_PANEL_ORDER,
  ACTION_PARAMETER_IDS,
  declaresParameter,
} from '../core/actions/registry';
import { orderedResultObjects, systemNodeObject } from '../core/actions/surfaceObjects';
import {
  eligibleMoveToIds,
  planFor,
  resolveActionsForObjectSet,
  resolveFamily,
  tagTargetIds,
} from '../core/actions/registry';
import {
  commonTagIdsForTargets,
  contentTargetIdsForRows,
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
  AmbientContextChanged,
  AmbientContextResolution,
  AmbientRequestId,
  ExternalContextId,
  InvocationRecord,
  ObjectQueryRequest,
  ObjectQueryResult,
  RequestId,
  SurfaceItemPresentation,
  ActionExecutionResult,
  ArgumentObjectGeneration,
  ArgumentSlot,
  ConfirmationSpec,
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
  SurfaceObject,
  ViewFact,
  WorkspaceFact,
} from '../core/actions/types';
import type { ExternalContext } from '../core/launcher/context';
import type { DocumentProjection, FocusHint, NodeId, NodeProjection, SearchHit } from '../core/types';

/** How many ranked hits admission filters before the picker's own limit. */
const CANDIDATE_FETCH_LIMIT = 200;
/** How many ranked node hits the main list shows. */
const LAUNCHER_RESULT_LIMIT = 8;
const CANDIDATE_LIMIT = 10;
const INVOCATION_TTL_MS = 5 * 60_000;

export type RendererStepAck =
  | { status: 'ok' }
  | { status: 'reported'; code: string }
  | { status: 'notDelivered' }
  | { status: 'gone' }
  | { status: 'timeout' };

export interface ActionInvocationHost {
  projection(): DocumentProjection;
  /** Execute a public Outline ChangeSet intent for the invoking surface. */
  runCommand(command: string, args: Record<string, unknown>): Promise<unknown>;
  searchNodes(query: string, limit: number): Promise<SearchHit[]>;
  /** Route a renderer step to the MAIN renderer and wait for its ack. */
  executeRendererStep(step: EffectStep, invocationRef: InvocationRef): Promise<RendererStepAck>;
  activateAppSurface(surface: AppSurface): Promise<void>;
  /**
   * Raise main's OWN confirmation sheet and report the user's answer. No token
   * is minted for this flow, so nothing can be handed to a renderer and nothing
   * can be redeemed by one — which is the whole point.
   */
  confirmNatively?(spec: ConfirmationSpec): Promise<boolean>;
  writeClipboard(text: string): void;
  /** The active locale's untitled fallback — part of `copy`'s parity. */
  untitled(): string;
  now(): number;
  /**
   * The captured page main holds for an opening. The registry reads it; it
   * never crosses to a renderer, which only ever sees the presentation.
   */
  externalContext?(contextId: ExternalContextId): ExternalContext | null;
  describeExternalPage?(contextId: ExternalContextId): ExternalPageDescription | null;
  /** Nondeterministic, so main mints it rather than the registry. */
  newCaptureId?(): string;
}

/**
 * The contract's `InvocationRecord` plus the parts only main ever sees. Reusing
 * the declared type rather than restating it is what keeps the contract
 * load-bearing instead of decorative.
 */
interface Record_ extends InvocationRecord {
  ref: InvocationRef;
  /** Every object main minted for this invocation, by ref. */
  objects: Map<ObjectRef, SurfaceObject>;
  /** Main-owned monotonic counter; request ids are never trusted. */
  generation: number;
}

// Web Crypto rather than `node:crypto`, so this module is isomorphic: the
// e2e harness runs the REAL service in the page instead of maintaining a second
// implementation of the registry that could drift from it.
function mintRef<T extends string>(): T {
  return globalThis.crypto.randomUUID() as T;
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
      // Position selects the subject: predicates that ask where the user
      // clicked read this, never the first member of the live selection.
      anchorObjectRef: anchor.objectRef,
      argumentGenerations: [],
      draftText: '',
      view: viewFactsFor(seed, anchor, selection),
      workspace: workspaceFactsFor(seed, anchor, selection),
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
    };
    this.records.set(record.ref, record);
    this.sweep();
    return this.openingFor(record);
  }

  /**
   * The launcher opening. Main creates the record SYNCHRONOUSLY for the new
   * `openSeq`, installs the ready empty-query generation, and marks its one
   * ambient slot `pending` — so the panel accepts input immediately and the
   * stable objects are already legal subjects before the first keystroke, even
   * though external capture has not resolved.
   */
  openLauncher(params: { openSeq: number; consumerId: number }): InvocationOpened {
    const objects = new Map<ObjectRef, SurfaceObject>();
    const mint = () => mintRef<ObjectRef>();
    const resultObjects = orderedResultObjects({ query: '', nodeObjects: [], mintRef: mint });
    for (const object of resultObjects) objects.set(object.objectRef, object);

    const record: Record_ = {
      ref: mintRef<InvocationRef>(),
      invocation: {
        fixedObjects: [],
        argumentGenerations: [],
        draftText: '',
        resultGeneration: {
          generation: 1,
          requestId: 'initial' as RequestId,
          state: 'ready',
          objects: resultObjects,
        },
      },
      // Main-origin records are first-class: out of app the main renderer may
      // not even exist, and nothing here was attested by one.
      origin: 'main',
      consumableBy: params.consumerId,
      openSeq: params.openSeq,
      ambient: { requestId: mintRef<AmbientRequestId>(), revision: 0, state: 'pending' },
      phase: 'live',
      expiresAt: this.host.now() + INVOCATION_TTL_MS,
      objects,
      generation: 1,
    };
    this.records.set(record.ref, record);
    this.installResolverDestinations(record, resultObjects);
    this.sweep();
    return this.openingFor(record);
  }

  /**
   * `Today` is a BOUND DESTINATION OBJECT, not prose inside an action id. When
   * `capture(page)` or `create(draft)` is presented, main installs it in that
   * exact `destination` slot as a resolver-owned generation — which is why the
   * same Today node can hold a main-list subject ref AND a capture-destination
   * argument ref at once: same noun, different uses and lifetimes.
   */
  private installResolverDestinations(
    record: Record_,
    objects: readonly SurfaceObject[],
  ): void {
    for (const object of objects) {
      const actionId = object.kind === 'externalPage'
        ? 'capture' as const
        : object.kind === 'draft' && object.purpose === 'node'
          ? 'create' as const
          : null;
      if (!actionId) continue;
      const slot = {
        actionId,
        subjectRef: object.objectRef,
        parameterId: 'destination' as const,
      };
      // Drop the previous generation's Today object before minting another, or
      // the ref map grows by one per keystroke for the life of the invocation.
      const previous = record.invocation.argumentGenerations.find((generation) => (
        generation.slot.actionId === slot.actionId
        && generation.slot.subjectRef === slot.subjectRef
        && generation.slot.parameterId === slot.parameterId
      ));
      for (const stale of previous?.objects ?? []) record.objects.delete(stale.objectRef);
      const today = systemNodeObject('today', () => mintRef<ObjectRef>());
      record.objects.set(today.objectRef, today);
      this.replaceArgumentGeneration(record, {
        slot,
        generation: ++record.generation,
        source: { kind: 'resolver' },
        state: 'ready',
        objects: [today],
      });
    }
  }

  /**
   * Main owns this transition. External capture resolves in main; neither
   * renderer may post a finished object, and main pushes only the authoritative
   * replacement presentation.
   *
   * It preserves `draftText`, the current result generation and unrelated
   * argument generations — so typing while capture is slow loses neither the
   * text nor the results that later arrive.
   */
  resolveAmbient(params: {
    invocationRef: InvocationRef;
    openSeq: number;
    resolution: AmbientContextResolution;
  }): AmbientContextChanged {
    const record = this.records.get(params.invocationRef);
    const superseded = {
      status: 'superseded' as const,
      invocationRef: params.invocationRef,
      openSeq: params.openSeq,
      requestId: (record?.ambient?.requestId ?? '') as AmbientRequestId,
    };
    // A resolution for an old opening, or one arriving after execution claimed
    // the record, changes no membership at all.
    if (!record || record.openSeq !== params.openSeq || !record.ambient) return superseded;
    if (record.phase !== 'live' && record.phase !== 'confirming') return superseded;

    // Replacing an old ambient subject invalidates that ref and its argument
    // slots; a confirmation naming it is revoked and the phase returns to live.
    if (record.ambient.state === 'resolved') {
      this.invalidateRefsFor(record, record.ambient.objectRef);
      record.invocation = {
        ...record.invocation,
        fixedObjects: record.invocation.fixedObjects
          .filter((object) => object.objectRef !== (record.ambient as { objectRef?: ObjectRef }).objectRef),
      };
    }

    const revision = record.ambient.revision + 1;
    if (params.resolution.kind === 'none') {
      record.ambient = { requestId: record.ambient.requestId, revision, state: 'none' };
    } else if (params.resolution.kind === 'inApp') {
      // A validated seed becomes INPUT to this transition, never a second
      // invocation and never a renderer-authored membership patch: main builds
      // the node/selection objects itself, exactly as it does for a menu.
      const projection = this.actionProjection();
      const seed = params.resolution.seed;
      if (!projection.byId.has(seed.anchorNodeId)) {
        record.ambient = { requestId: record.ambient.requestId, revision, state: 'none' };
      } else {
        const mint = () => mintRef<ObjectRef>();
        const anchor = nodeObjectForRow(seed.anchorNodeId, projection.byId, mint);
        record.objects.set(anchor.objectRef, anchor);
        const selection = this.selectionObjectFor(seed, projection, mint, record.objects);
        const ambient = selection ?? anchor;
        // The facts the renderer JUST attested must land with the object, or
        // the ambient chip silently offers fewer actions than the same node
        // reached through the right-click menu (no Pin, no view families).
        record.invocation = {
          ...record.invocation,
          fixedObjects: [...record.invocation.fixedObjects, ambient],
          view: [
            ...(record.invocation.view ?? []),
            ...viewFactsFor(seed, anchor, selection),
          ],
          workspace: [
            ...(record.invocation.workspace ?? []),
            ...workspaceFactsFor(seed, anchor, selection),
          ],
        };
        record.ambient = {
          requestId: record.ambient.requestId,
          revision,
          state: 'resolved',
          objectRef: ambient.objectRef,
        };
      }
    } else if (params.resolution.kind === 'externalPage') {
      const page: SurfaceObject = {
        kind: 'externalPage',
        objectRef: mintRef<ObjectRef>(),
        contextId: params.resolution.contextId,
      };
      record.objects.set(page.objectRef, page);
      record.invocation = {
        ...record.invocation,
        fixedObjects: [...record.invocation.fixedObjects, page],
      };
      record.ambient = {
        requestId: record.ambient.requestId,
        revision,
        state: 'resolved',
        objectRef: page.objectRef,
      };
      this.installResolverDestinations(record, [page]);
    }

    const context = this.contextFor(record);
    return {
      status: 'updated',
      invocationRef: record.ref,
      openSeq: params.openSeq,
      revision,
      ambientState: record.ambient.state === 'resolved' ? 'resolved' : 'none',
      fixedItems: record.invocation.fixedObjects.map((object) => this.itemFor(context, object)),
    };
  }

  /**
   * The main list's query. Main validates the opening, sanitizes and bounds the
   * text, and atomically replaces the previous generation with an empty
   * `pending` one BEFORE retrieval begins — that first transition invalidates
   * every old result and draft ref. Fresh objects are installed only if the
   * captured generation is still current.
   */
  async queryObjects(request: ObjectQueryRequest, senderId: number): Promise<ObjectQueryResult> {
    const record = this.liveRecord(request.invocationRef, senderId);
    const superseded = {
      status: 'superseded' as const,
      invocationRef: request.invocationRef,
      openSeq: request.openSeq,
      requestId: request.requestId,
      generation: record?.generation ?? 0,
    };
    if (!record || record.openSeq !== request.openSeq) return superseded;

    // `draftText` is admitted SYNCHRONOUSLY: it is payload, not selection, and
    // type-then-immediate-Enter must see the latest text.
    //
    const query = request.query.slice(0, 512);
    const generation = ++record.generation;
    this.replaceResultGeneration(record, {
      generation,
      requestId: request.requestId,
      state: 'pending',
      objects: [],
    }, query);
    const mint = () => mintRef<ObjectRef>();
    let nodeObjects: SurfaceObject[] = [];
    try {
      nodeObjects = query.trim()
        ? (await this.host.searchNodes(query.trim(), LAUNCHER_RESULT_LIMIT))
          .map((hit) => nodeObjectForRow(hit.nodeId, this.actionProjection().byId, mint))
        : [];
    } catch {
      // A failed search leaves only the stable objects — never the previous
      // generation's rows, which this transition has already invalidated.
      nodeObjects = [];
    }
    if (record.generation !== generation) return { ...superseded, generation: record.generation };
    const resultObjects = orderedResultObjects({ query, nodeObjects, mintRef: mint });

    for (const object of resultObjects) record.objects.set(object.objectRef, object);
    this.replaceResultGeneration(record, {
      generation,
      requestId: request.requestId,
      state: 'ready',
      objects: resultObjects,
    }, query);
    this.installResolverDestinations(record, resultObjects);

    const context = this.contextFor(record);
    return {
      status: 'ready',
      invocationRef: record.ref,
      openSeq: record.openSeq!,
      requestId: request.requestId,
      generation,
      resultItems: resultObjects.map((object) => this.itemFor(context, object)),
    };
  }

  private replaceResultGeneration(
    record: Record_,
    next: NonNullable<ActionInvocation['resultGeneration']>,
    draftText: string,
  ): void {
    const previous = record.invocation.resultGeneration;
    if (previous) {
      // The transition invalidates every old result and draft ref.
      for (const object of previous.objects) record.objects.delete(object.objectRef);
      record.invocation = {
        ...record.invocation,
        argumentGenerations: record.invocation.argumentGenerations.filter((generation) => (
          !previous.objects.some((object) => object.objectRef === generation.slot.subjectRef)
        )),
      };
    }
    record.invocation = { ...record.invocation, resultGeneration: next, draftText };
  }

  private selectionObjectFor(
    seed: InvocationSeed,
    projection: ActionProjection,
    mint: () => ObjectRef,
    objects: Map<ObjectRef, SurfaceObject>,
  ): SurfaceObject | null {
    const selected = new Set(seed.selectedIds);
    // The shipped rule: a live multi-selection containing the anchored row IS
    // the batch subject, even when collapsing to roots yields ONE id. Selecting
    // a parent and its child and trashing must trash the parent's whole
    // subtree, not just the child that was right-clicked.
    if (!selected.has(seed.anchorNodeId) || selected.size <= 1) return null;
    const roots = selectionRootIds([...selected], projection.byId);
    if (roots.length === 0) return null;
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
    const generation = record.invocation.resultGeneration;
    return {
      invocationRef: record.ref,
      openSeq: record.openSeq,
      ...(record.ambient
        ? { ambient: { state: record.ambient.state, revision: record.ambient.revision } }
        : {}),
      fixedItems: record.invocation.fixedObjects.map((object) => this.itemFor(context, object)),
      resultItems: generation?.state === 'ready'
        ? generation.objects.map((object) => this.itemFor(context, object))
        : [],
      menuActions: resolveActionsForObjectSet(context, currentObjects, { surface: 'contextMenu' }),
    };
  }

  /**
   * One object row: its presentation, the action the bar names for Enter, and
   * the searchable `Actions ⌘K` list. The primary is an OBJECT CONTRACT, never
   * learned behaviour — and a selection has none, because it has no safe
   * canonical activation.
   */
  private itemFor(
    context: ActionResolveContext,
    object: SurfaceObject,
  ): SurfaceItemPresentation {
    const actions = resolveActionsForObjectSet(context, [object], {
      order: ACTION_PANEL_ORDER,
      surface: 'actionPanel',
    }).filter((action) => this.surfaceCanRun(context, object, action));
    const primaryId = primaryActionFor(object);
    const primary = primaryId
      ? actions.find((action) => (
        action.actionId === primaryId && action.evaluation.status === 'applicable'
      ))
      : undefined;
    return {
      object: presentObject(
        object,
        context.projection,
        context.untitled,
        this.host.describeExternalPage
          ? (contextId) => this.host.describeExternalPage!(contextId as ExternalContextId)
          : undefined,
      ),
      ...(primary ? { primaryAction: primary } : {}),
      actions,
    };
  }

  /**
   * An action is only offered where it can actually RUN. A searchable panel
   * that lists `Move to` with no parameter picker, or `Edit description` on a
   * surface with no reveal handler, is a dead end that reports a generic
   * failure every time — worse than not showing it, because the user cannot
   * tell it from a real error.
   */
  private surfaceCanRun(
    context: ActionResolveContext,
    object: SurfaceObject,
    action: ActionPresentation,
  ): boolean {
    // A parameter still to pick needs a picker; only the anchored menu has one.
    if (action.binding.state === 'needsParameter') return false;
    const plan = planFor(context, action.actionId, object, action.binding.arguments as never);
    if (!plan) return action.evaluation.status !== 'applicable';
    return plan.steps.every((step) => this.canExecuteStep(step));
  }

  /**
   * Whether a step can land on the SEARCHABLE surface. This is only consulted
   * by `itemFor`, which builds the launcher panel — the anchored menu goes
   * through the separate, unfiltered `menuActions`. A `reveal` needs the panel
   * that owns the row, which a launcher-originated plan does not have.
   *
   * Stated as a flat rule rather than a host capability on purpose: an
   * always-false optional callback is a trap, because the day the anchored menu
   * routes through `itemFor` it would silently lose every reveal action.
   */
  private canExecuteStep(step: EffectStep): boolean {
    if (step.on !== 'mainRenderer') return true;
    return step.kind !== 'reveal';
  }

  /** Fixed objects plus the one `ready` result generation — nothing else. */
  private currentObjects(record: Record_): SurfaceObject[] {
    const generation = record.invocation.resultGeneration;
    return [
      ...record.invocation.fixedObjects,
      ...(generation?.state === 'ready' ? generation.objects : []),
    ];
  }

  /**
   * Memoized on the projection OBJECT: every keystroke in a parameter picker
   * builds a resolve context, and rebuilding a whole-document index per call
   * makes the picker's cost scale with the document instead of the query.
   * `Core.projection()` returns a new object per revision, so identity is the
   * correct invalidation key.
   */
  private cachedProjection: { source: DocumentProjection; value: ActionProjection } | null = null;

  private actionProjection(): ActionProjection {
    const projection = this.host.projection();
    if (this.cachedProjection?.source === projection) return this.cachedProjection.value;
    const byId = new Map<NodeId, NodeProjection>();
    for (const node of projection.nodes) byId.set(node.id, node);
    const value: ActionProjection = {
      byId,
      trashId: projection.trashId,
      todayId: projection.todayId,
      libraryId: projection.libraryId,
      schemaId: projection.schemaId,
      searchesId: projection.searchesId,
    };
    this.cachedProjection = { source: projection, value };
    return value;
  }

  private contextFor(record: Record_): ActionResolveContext {
    const projection = this.actionProjection();
    return {
      projection,
      invocation: record.invocation,
      objectFor: (ref) => record.objects.get(ref) ?? null,
      untitled: this.host.untitled(),
      ...(this.host.externalContext
        ? { externalContext: (contextId) => this.host.externalContext!(contextId) }
        : {}),
      ...(this.host.newCaptureId ? { newCaptureId: () => this.host.newCaptureId!() } : {}),
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
  async queryParameterObjects(
    request: ParameterObjectQueryRequest,
    senderId: number,
  ): Promise<ParameterObjectQueryResult> {
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
    const built = await this.buildParameterCandidates(context, record, request, subject);
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

  /**
   * A request cannot create a slot by naming one. Ownership is two facts: the
   * family DECLARES this parameter, and it actually resolves for this subject.
   * Checking only "is the current binding waiting on it" would refuse capture's
   * optional tag, whose presentation is already `ready`.
   */
  private ownsParameterSlot(
    record: Record_,
    slot: ArgumentSlot,
    subject: SurfaceObject,
  ): boolean {
    if (!declaresParameter(slot)) return false;
    const context = this.contextFor(record);
    return resolveFamily(context, slot.actionId, subject).length > 0;
  }

  private async buildParameterCandidates(
    context: ActionResolveContext,
    record: Record_,
    request: ParameterObjectQueryRequest,
    subject: SurfaceObject,
  ): Promise<{ objects: SurfaceObject[]; items: ObjectPresentation[] }> {
    const objects: SurfaceObject[] = [];
    const items: ObjectPresentation[] = [];
    const mint = () => mintRef<ObjectRef>();
    const query = request.query.trim();

    if (request.slot.actionId === 'move' && request.slot.parameterId === 'destination') {
      const moving = eligibleMoveToIds(context, subject);
      const { byId, trashId } = context.projection;
      const candidateIds = query
        ? await this.rankedMoveToCandidates(query, moving, context)
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

    // Any action that owns a `tag` slot — `addTag` today, `capture` with an
    // optional tag — answers from the same candidate policy. The slot, not the
    // action id, is what the generation is keyed to.
    if (request.slot.parameterId === 'tag') {
      const projection = this.host.projection();
      const index = buildTagCandidateIndex({
        nodes: projection.nodes,
        byId: context.projection.byId,
        trashId: context.projection.trashId,
      });
      // The registry owns this derivation; a second copy here drifted, and did
      // (it KEPT ids whose facets resolve to null, the inverse of the rule).
      const targets = tagTargetIds(context, subject);
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
          items.push(presentObject(object, context.projection, context.untitled));
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
          ...presentObject(draft, context.projection, context.untitled),
          name: { source: 'localized', values: createTagCandidateName(candidate.name) },
        });
      }
      return { objects, items };
    }

    return { objects, items };
  }

  /**
   * Rank with the shared kernel WITHOUT letting it narrow the destination set.
   *
   * The kernel's `isSearchCandidate` drops system containers (Library, Schema,
   * Saved searches, Daily notes) and every node whose type is not one of a
   * small set — all of which the shipped picker offered, because it scanned the
   * projection by substring. Routing the query through the kernel alone would
   * therefore have traded one hidden-destination defect for another. So the
   * POOL stays the admitted projection (admission before limiting, D5) and the
   * kernel supplies ORDER over the nodes it has an opinion about; the rest keep
   * document order behind them.
   */
  private async rankedMoveToCandidates(
    query: string,
    moving: readonly NodeId[],
    context: ActionResolveContext,
  ): Promise<NodeId[]> {
    const { byId, trashId } = context.projection;
    const rank = new Map<NodeId, number>();
    (await this.host.searchNodes(query, CANDIDATE_FETCH_LIMIT)).forEach((hit: SearchHit, index) => {
      if (!rank.has(hit.nodeId)) rank.set(hit.nodeId, index);
    });
    const normalized = query.toLowerCase();
    const admitted: { nodeId: NodeId; rank: number; order: number }[] = [];
    this.host.projection().nodes.forEach((node, order) => {
      if (!admitsMoveToDestination({ candidateId: node.id, moving, byId, trashId })) return;
      const ranked = rank.get(node.id);
      const matches = ranked !== undefined
        || nodeText(node, context.untitled).toLowerCase().includes(normalized);
      if (!matches) return;
      admitted.push({ nodeId: node.id, rank: ranked ?? Number.MAX_SAFE_INTEGER, order });
    });
    admitted.sort((left, right) => (
      left.rank !== right.rank ? left.rank - right.rank : left.order - right.order
    ));
    return admitted.slice(0, CANDIDATE_LIMIT).map((entry) => entry.nodeId);
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
    // Declared parameters are validated BY SLOT above, so they are excluded from
    // the argument identity check: an optional tag added to an already-`ready`
    // capture must not read as "different arguments" and re-evaluate away.
    const withoutParameters = (args: unknown) => {
      const declared: readonly string[] = ACTION_PARAMETER_IDS[request.actionId];
      if (declared.length === 0 || typeof args !== 'object' || args === null) return args;
      const rest: Record<string, unknown> = { ...(args as Record<string, unknown>) };
      for (const parameterId of declared) delete rest[parameterId];
      return rest;
    };
    const requestedIdentity = hashArguments(withoutParameters(request.arguments));
    const match = presentations.find((presentation) => (
      presentation.binding.state === 'ready'
        // A direct variant matches only its own exact non-parameter arguments.
        ? hashArguments(withoutParameters(presentation.binding.arguments)) === requestedIdentity
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

    if (match.confirm) {
      // Flow B has no legs and no token. Main raises the sheet, main observes
      // the acceptance, main executes — a token would put the deciding artefact
      // back in the hands the sheet exists to bypass.
      record.phase = 'confirming';
      // No sheet host at all is a MISCONFIGURATION, not a user decision: fail
      // closed, and do not tell the user they cancelled something they never
      // saw.
      if (!this.host.confirmNatively) {
        record.phase = 'live';
        return { status: 'stale', reason: 'invocation' };
      }
      if (!await this.host.confirmNatively(match.confirm)) {
        // Back to `live`: the user declined this once, not forever.
        record.phase = 'live';
        return { status: 'cancelled' };
      }
      // Revalidate at acceptance, exactly as flow A does at redemption.
      const revalidated = resolveFamily(this.contextFor(record), request.actionId, subject)
        .find((presentation) => (
          presentation.binding.state === 'ready'
          && hashArguments(withoutParameters(presentation.binding.arguments)) === requestedIdentity
        ));
      if (!revalidated || revalidated.evaluation.status !== 'applicable') {
        record.phase = 'live';
        return { status: 'stale', reason: 'subject' };
      }
      const nativePlan = planFor(this.contextFor(record), request.actionId, subject, request.arguments as never);
      if (!nativePlan) {
        record.phase = 'live';
        return { status: 'reEvaluated', presentation: revalidated };
      }
      record.phase = 'executing';
      const nativeResult = await this.executePlan(nativePlan, record.ref);
      record.phase = settledPhase(nativeResult);
      return nativeResult;
    }

    const plan = planFor(context, request.actionId, subject, request.arguments as never);
    if (!plan) return { status: 'reEvaluated', presentation: match };

    // Claimed on ENTERING `executing`, before step 0 is dispatched — a second
    // submit against a claimed record is rejected.
    record.phase = 'executing';
    const result = await this.executePlan(plan, record.ref);
    // Only a COMPLETED action spends the invocation. The surface deliberately
    // stays open after a failure, and a `spent` record makes that still-visible
    // panel permanently inert — no search, no retry, just more generic errors.
    record.phase = settledPhase(result);
    return result;
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
    // `surfaceOwned` means the plan's own outline intents already placed the
    // selection; forwarding the command's hint there would fight them.
    return focus && plan.focus !== 'surfaceOwned'
      ? { status: 'completed', focus }
      : { status: 'completed' };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  event(event: InvocationEvent, senderId: number): InvocationEventResult {
    const record = this.records.get(event.invocationRef);
    if (!record || record.consumableBy !== senderId) return { status: 'spent' };
    switch (event.kind) {
      case 'objectRemoved': {
        if (record.phase === 'executing' || record.phase === 'spent') return { status: 'spent' };
        record.invocation = {
          ...record.invocation,
          fixedObjects: record.invocation.fixedObjects
            .filter((object) => object.objectRef !== event.objectRef),
        };
        // Removing the ambient object advances MAIN's revision and leaves the
        // slot at `none`, so an older context push cannot reattach the chip.
        if (record.ambient?.state === 'resolved' && record.ambient.objectRef === event.objectRef) {
          record.ambient = {
            requestId: record.ambient.requestId,
            revision: record.ambient.revision + 1,
            state: 'none',
          };
        }
        this.invalidateRefsFor(record, event.objectRef);
        return { status: 'updated', opening: this.openingFor(record) };
      }
      case 'selectionMemberRemoved':
        return this.removeSelectionMember(record, event.selectionRef, event.memberRef);
      case 'abandoned':
        // Reserved for closing the menu or panel; a UI lifetime event never
        // invalidates work in flight. `confirming` counts: the menu closes as
        // soon as the action is chosen, while main's native sheet is still on
        // screen deciding — releasing here would let the record be deleted out
        // from under a request the user is about to accept.
        if (record.phase !== 'executing' && record.phase !== 'confirming') {
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

  /** A removed/replaced subject takes its argument slots with it. */
  private invalidateRefsFor(record: Record_, ref: ObjectRef): void {
    record.objects.delete(ref);
    record.invocation = {
      ...record.invocation,
      argumentGenerations: record.invocation.argumentGenerations
        .filter((generation) => generation.slot.subjectRef !== ref),
    };
  }

  private liveRecord(ref: InvocationRef, senderId: number): Record_ | null {
    const record = this.records.get(ref);
    if (!record || record.consumableBy !== senderId) return null;
    if (record.expiresAt <= this.host.now()) return null;
    // Queries and membership edits are admitted only in `live` / `confirming`.
    if (record.phase !== 'live' && record.phase !== 'confirming') return null;
    return record;
  }

  /**
   * Release the invocation for an opening that is over. Every dismissal path —
   * blur, click-away, hotkey toggle-off — has to reach this, or the record
   * stays `live` and launcher-consumable for its full TTL and the refs from a
   * superseded opening remain executable.
   */
  releaseOpening(invocationRef: InvocationRef | null): void {
    if (!invocationRef) return;
    const record = this.records.get(invocationRef);
    if (!record || record.phase === 'executing') return;
    record.phase = 'spent';
    this.records.delete(invocationRef);
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

/**
 * D6's fixed primary rule. `create(draft)` and `capture(page)` are safe blind
 * Enter targets because the row reflects text the user just authored or a page
 * they explicitly summoned over; an ambient node or selection mutation is not,
 * so those objects never receive a mutating primary.
 */
function primaryActionFor(object: SurfaceObject): ActionId | null {
  switch (object.kind) {
    case 'node':
    case 'appSurface':
      return 'open';
    case 'externalPage':
      return 'capture';
    case 'draft':
      return object.purpose === 'node' ? 'create' : null;
    case 'nodeSelection':
      return null;
  }
}

/**
 * The attested facts, for EVERY object the seed produced. A selection subject
 * needs them as much as the anchor does — `outdent` and the view families
 * resolve against whichever object the family accepts, so attaching them to the
 * anchor alone silently removed those actions from a batch.
 */
function viewFactsFor(
  seed: InvocationSeed,
  anchor: SurfaceObject,
  selection: SurfaceObject | null,
): ViewFact[] {
  const fact = {
    panelId: seed.panelId,
    visualRowId: seed.visualRowId,
    rowExpanded: seed.rowExpanded,
    ...(seed.selectionRootId ? { selectionRootId: seed.selectionRootId } : {}),
  };
  const facts: ViewFact[] = [{ objectRef: anchor.objectRef, ...fact }];
  if (selection) facts.push({ objectRef: selection.objectRef, ...fact });
  return facts;
}

function workspaceFactsFor(
  seed: InvocationSeed,
  anchor: SurfaceObject,
  selection: SurfaceObject | null,
): WorkspaceFact[] {
  const facts: WorkspaceFact[] = [{ objectRef: anchor.objectRef, isPinned: seed.isPinned }];
  if (selection) facts.push({ objectRef: selection.objectRef, isPinned: seed.isPinned });
  return facts;
}

function settledPhase(result: ActionExecutionResult): InvocationPhase {
  return result.status === 'completed' ? 'spent' : 'live';
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
