// One object model and one action model for every surface that acts on
// something Tenon can present. See `docs/plans/unified-command-surface.md` D1a.
//
// The rule the types exist to enforce: **every row/chip is an OBJECT, every
// action row is an ACTION resolved for a subject object.** Neither smuggles the
// other in through a fused label. A noun/verb rule that is not represented in
// the type cannot be enforced, so it is represented here.

import type { ExternalContext } from '../launcher/context';
import type { Locale } from '../locale';
import type { FocusHint, NodeId } from '../types';
import type { ActionEffectPlan, AppSurface, ViewSection } from './bindings';

/** Every static label the surface can search or render, in BOTH locales. */
export type LocalizedNames = Record<Locale, string>;

/**
 * An opaque, generation-scoped handle to one object inside one invocation.
 * The same backing node found twice receives a new `ObjectRef`, while its
 * `NodeObjectRef` continues to identify the same document node.
 */
export type ObjectRef = string & { readonly __brand: 'ObjectRef' };
export type InvocationRef = string & { readonly __brand: 'InvocationRef' };
export type RequestId = string & { readonly __brand: 'RequestId' };
export type AmbientRequestId = string & { readonly __brand: 'AmbientRequestId' };
export type ChallengeToken = string & { readonly __brand: 'ChallengeToken' };
export type ExternalContextId = string & { readonly __brand: 'ExternalContextId' };

// ---------------------------------------------------------------------------
// 0. OBJECT
// ---------------------------------------------------------------------------

/**
 * How a node object points at a document node. System nodes are node objects
 * too; their resolver may ensure the backing node before `open`.
 */
export type NodeObjectRef =
  | { by: 'id'; nodeId: NodeId }
  | { by: 'system'; key: SystemNodeKey };

export type SystemNodeKey = 'today' | 'library' | 'schema' | 'savedSearches' | 'trash';

/**
 * The three facets preserve ONE object, not three rows. For an ordinary node
 * they are identical. For a reference occurrence `row` is the reference while
 * `content`/`canonicalSurface` resolve to its target. For a field row `row` and
 * `content` are the entry while `canonicalSurface` is the field definition.
 */
export interface NodeObject {
  kind: 'node';
  objectRef: ObjectRef;
  /** Structural occurrence: duplicate / move / remove. */
  row: NodeObjectRef;
  /** Semantic target: done / tag / description / copy / agent. */
  content: NodeObjectRef;
  /** Activation target: open / split / pin. */
  canonicalSurface: NodeObjectRef;
}

export type SurfaceObject =
  | NodeObject
  | { kind: 'nodeSelection'; objectRef: ObjectRef; nodes: readonly NodeObject[] }
  | { kind: 'externalPage'; objectRef: ObjectRef; contextId: ExternalContextId }
  | { kind: 'draft'; objectRef: ObjectRef; purpose: 'node' | 'tag'; text: string }
  | { kind: 'appSurface'; objectRef: ObjectRef; surface: AppSurface };

// There is deliberately no `command` arm in this release. `Open main window`
// and `Open Settings` are app-surface objects plus `open`; a future
// independently named tool/workflow may add a genuine command-object provider.

export type SurfaceObjectKind = SurfaceObject['kind'];

/**
 * User-authored titles are `literal`: they render exactly as captured or typed
 * and are never translated. Only app-owned labels are `localized`.
 */
export type PresentedName =
  | { source: 'literal'; value: string }
  | { source: 'localized'; values: LocalizedNames };

export type IconId =
  | 'agent'
  | 'check'
  | 'checkbox'
  | 'copy'
  | 'description'
  | 'duplicate'
  | 'field'
  | 'filter'
  | 'group'
  | 'hideToolbar'
  | 'moveDown'
  | 'moveTo'
  | 'moveUp'
  | 'node'
  | 'outline'
  | 'open'
  | 'pin'
  | 'restore'
  | 'showToolbar'
  | 'sortAsc'
  | 'supertag'
  | 'table'
  | 'trash';

export interface ObjectPresentation {
  objectRef: ObjectRef;
  kind: SurfaceObjectKind;
  name: PresentedName;
  subtitle?: PresentedName;
  iconId: IconId;
  typeLabel: LocalizedNames;
}

/** `mainList` is deliberately not a value: an action is never a main-list row. */
export type ActionSurface = 'contextMenu' | 'actionPanel';

// ---------------------------------------------------------------------------
// 1. ACTION CATALOG
// ---------------------------------------------------------------------------

export const ACTION_IDS = [
  'open',
  'openInSplitPane',
  'setPinned',
  'sendToAgent',
  'duplicate',
  'move',
  'setDone',
  'addTag',
  'setViewMode',
  'setViewToolbarVisible',
  'editViewSection',
  'editDescription',
  'copy',
  'remove',
  'restore',
  'deleteForever',
  'emptyTrash',
  'capture',
  'create',
] as const;

export type ActionId = typeof ACTION_IDS[number];

/**
 * Typed arguments per family. Desired states, directions and representations
 * are arguments — never separate action ids, and never a runtime toggle.
 */
export interface ActionArguments {
  open: Record<string, never>;
  openInSplitPane: Record<string, never>;
  setPinned: { pinned: boolean };
  sendToAgent: Record<string, never>;
  duplicate: Record<string, never>;
  move:
    | { relative: 'up' | 'down'; destination?: undefined }
    | { relative?: undefined; destination: ObjectRef };
  setDone: { done: boolean };
  addTag: { tag: ObjectRef };
  setViewMode: { mode: 'outline' | 'table' };
  setViewToolbarVisible: { visible: boolean };
  editViewSection: { section: ViewSection };
  editDescription: Record<string, never>;
  copy: { representation: 'text' | 'nodeId' };
  remove: Record<string, never>;
  restore: Record<string, never>;
  deleteForever: Record<string, never>;
  emptyTrash: Record<string, never>;
  capture: { destination: ObjectRef; tag?: ObjectRef };
  create: { destination: ObjectRef };
}

/** Which object-valued parameter slots a family owns (`never` = none). */
export interface ObjectParameterId {
  open: never;
  openInSplitPane: never;
  setPinned: never;
  sendToAgent: never;
  duplicate: never;
  move: 'destination';
  setDone: never;
  addTag: 'tag';
  setViewMode: never;
  setViewToolbarVisible: never;
  editViewSection: never;
  editDescription: never;
  copy: never;
  remove: never;
  restore: never;
  deleteForever: never;
  emptyTrash: never;
  capture: 'destination' | 'tag';
  create: 'destination';
}

/** Arguments already known when a parameter still has to be picked. */
export interface ActionArgumentSeed {
  open: Record<string, never>;
  openInSplitPane: Record<string, never>;
  setPinned: Record<string, never>;
  sendToAgent: Record<string, never>;
  duplicate: Record<string, never>;
  move: Record<string, never>;
  setDone: Record<string, never>;
  addTag: Record<string, never>;
  setViewMode: Record<string, never>;
  setViewToolbarVisible: Record<string, never>;
  editViewSection: Record<string, never>;
  editDescription: Record<string, never>;
  copy: Record<string, never>;
  remove: Record<string, never>;
  restore: Record<string, never>;
  deleteForever: Record<string, never>;
  emptyTrash: Record<string, never>;
  capture: { destination: ObjectRef };
  create: { destination: ObjectRef };
}

/**
 * A static spec cannot express query-dependent candidate policy, and the
 * locked-down launcher has no projection to compute it locally — so the spec
 * names the slot and main answers `ParameterObjectQueryRequest` for it.
 */
export interface ParameterSpec<K extends ActionId> {
  parameterId: ObjectParameterId[K];
  /** Candidate object kinds the slot admits. */
  objectKinds: readonly SurfaceObjectKind[];
  title: LocalizedNames;
  inputLabel: LocalizedNames;
  placeholder: LocalizedNames;
}

// ---------------------------------------------------------------------------
// 2. INVOCATION
// ---------------------------------------------------------------------------

export type ObjectResultGeneration = {
  /** Main-owned monotonic counter; request ids are not trusted. */
  generation: number;
  requestId: RequestId;
} & (
  | { state: 'pending'; objects: readonly [] }
  | { state: 'ready'; objects: readonly SurfaceObject[] }
);

export type ArgumentSlot = {
  [K in ActionId]: ObjectParameterId[K] extends never ? never : {
    actionId: K;
    subjectRef: ObjectRef;
    parameterId: ObjectParameterId[K];
  }
}[ActionId];

export type ArgumentObjectGeneration = {
  slot: ArgumentSlot;
  /** From the same main-owned monotonic counter. */
  generation: number;
} & (
  | { source: { kind: 'resolver' }; state: 'ready'; objects: readonly SurfaceObject[] }
  | {
    source: { kind: 'query'; requestId: RequestId };
    state: 'pending';
    objects: readonly [];
  }
  | {
    source: { kind: 'query'; requestId: RequestId };
    state: 'ready';
    objects: readonly SurfaceObject[];
  }
);

/** Panel identity qualifies WHICH PRESENTATION of a node the user acts from. */
export interface ViewFact {
  objectRef: ObjectRef;
  panelId: string;
  visualRowId: NodeId;
  rowExpanded: boolean;
}

export interface WorkspaceFact {
  objectRef: ObjectRef;
  isPinned: boolean;
}

export interface ActionInvocation {
  /** Menu anchors + resolved ambient chip. */
  fixedObjects: readonly SurfaceObject[];
  /** Node/system/app/draft results (launcher main list). */
  resultGeneration?: ObjectResultGeneration;
  argumentGenerations: readonly ArgumentObjectGeneration[];
  /** Sanitized input payload; never an implicit subject choice. */
  draftText: string;
  // ATTESTED by the main renderer only (sender-checked). Never suppliable by
  // the launcher. Facts are tied to the object they qualify.
  view?: readonly ViewFact[];
  workspace?: readonly WorkspaceFact[];
}

export type AmbientSlot = {
  requestId: AmbientRequestId;
  revision: number;
} & (
  | { state: 'pending' | 'none' }
  | { state: 'resolved'; objectRef: ObjectRef }
);

export type InvocationPhase = 'live' | 'confirming' | 'executing' | 'spent';

export type RendererId = number;

export interface InvocationRecord {
  invocation: ActionInvocation;
  /** Main-origin records are first-class, not a fiction. */
  origin: 'main' | 'mainRenderer';
  /**
   * Present IFF the invocation carries `view` or `workspace` facts — the only
   * parts a renderer can attest. A reload invalidates it rather than leaving a
   * stale bit admissible.
   */
  attestation?: { webContentsId: number; renderGeneration: number };
  consumableBy: RendererId;
  /** Null when not bound to a launcher opening. */
  openSeq: number | null;
  ambient?: AmbientSlot;
  phase: InvocationPhase;
  expiresAt: number;
}

/**
 * Raw renderer FACTS, never a finished `ActionInvocation`: main validates ids,
 * constructs objects, derives facets, and mints refs, origin, attestation,
 * lifetime and consumer. There is deliberately NO pane root — the only
 * predicate that reads one belongs to an action outside the migrated set.
 */
export interface InvocationSeed {
  from: 'mainRenderer';
  anchorNodeId: NodeId;
  visualRowId: NodeId;
  selectedIds: readonly NodeId[];
  panelId: string;
  isPinned: boolean;
  rowExpanded: boolean;
}

// ---------------------------------------------------------------------------
// 3. EVALUATION AND PRESENTATION
// ---------------------------------------------------------------------------

/**
 * A predicate refused an existing subject. The reason is shown in the
 * searchable action panel; the context-menu projection maps it back to the
 * shipped disabled row.
 */
export interface ActionRejection {
  code: ActionRejectionCode;
  names: LocalizedNames;
}

export type ActionRejectionCode =
  | 'noEligibleRows'
  | 'immutable'
  | 'inTrash'
  | 'notInTrash'
  | 'trashEmpty'
  | 'alreadyInState';

export type ActionEvaluation =
  | { status: 'applicable' }
  | { status: 'rejected'; reason: ActionRejection }
  /** No subject object at all -> hidden. */
  | { status: 'absent' };

export type PresentableEvaluation = Exclude<ActionEvaluation, { status: 'absent' }>;

export type ActionArgumentBinding<K extends ActionId> =
  | { state: 'ready'; arguments: ActionArguments[K] }
  | { state: 'needsParameter'; seed: ActionArgumentSeed[K]; parameter: ParameterSpec<K> };

export interface ConfirmationSpec {
  style: 'rendererDialog' | 'native';
  title: LocalizedNames;
  message: LocalizedNames;
  confirmLabel: LocalizedNames;
  danger: boolean;
}

export type ActionPresentationFor<
  K extends ActionId,
  B extends ActionArgumentBinding<K> = ActionArgumentBinding<K>,
> = {
  actionId: K;
  subjectRef: ObjectRef;
  names: LocalizedNames;
  /** Locale-independent search terms; never action ids. */
  aliases: readonly string[];
  iconId: IconId;
  surfaces: readonly ActionSurface[];
  evaluation: PresentableEvaluation;
  binding: B;
  confirm?: ConfirmationSpec;
};

export type ActionPresentation = {
  [K in ActionId]: ActionPresentationFor<K>
}[ActionId];

export type ReadyActionPresentation = {
  [K in ActionId]: ActionPresentationFor<K, {
    state: 'ready';
    arguments: ActionArguments[K];
  }>
}[ActionId];

export interface SurfaceItemPresentation {
  object: ObjectPresentation;
  /** Selections may have no safe blind-Enter action. */
  primaryAction?: ActionPresentation;
  actions: readonly ActionPresentation[];
}

// ---------------------------------------------------------------------------
// 4. THE SEAM
// ---------------------------------------------------------------------------

/** The only EXECUTION request a renderer may send. */
export type ActionRequest = {
  [K in ActionId]: {
    actionId: K;
    invocationRef: InvocationRef;
    subjectRef: ObjectRef;
    arguments: ActionArguments[K];
    /** Minted by main; single-use. */
    challenge?: ChallengeToken;
  }
}[ActionId];

export interface InvocationOpened {
  invocationRef: InvocationRef;
  openSeq: number | null;
  ambient?: { state: 'pending' | 'resolved' | 'none'; revision: number };
  /** Chips / anchored objects. */
  fixedItems: readonly SurfaceItemPresentation[];
  /** Current ready generation. */
  resultItems: readonly SurfaceItemPresentation[];
  menuActions: readonly ActionPresentation[];
}

/** Argument rows use the same object shape but a slot-scoped generation. */
export interface ParameterObjectQueryRequest {
  invocationRef: InvocationRef;
  openSeq: number | null;
  slot: ArgumentSlot;
  requestId: RequestId;
  query: string;
}

export type ParameterObjectQueryResult =
  | {
    status: 'ready';
    invocationRef: InvocationRef;
    slot: ArgumentSlot;
    requestId: RequestId;
    generation: number;
    items: readonly ObjectPresentation[];
  }
  | {
    status: 'superseded';
    invocationRef: InvocationRef;
    slot: ArgumentSlot;
    requestId: RequestId;
    generation: number;
  };

/**
 * Like `ActionRequest`, a lifecycle event can only NAME a transition; main
 * decides whether it is legal in the current phase.
 */
export type InvocationEvent =
  | { kind: 'confirmationCancelled'; invocationRef: InvocationRef; challenge: ChallengeToken }
  | { kind: 'objectRemoved'; invocationRef: InvocationRef; objectRef: ObjectRef }
  | {
    kind: 'selectionMemberRemoved';
    invocationRef: InvocationRef;
    selectionRef: ObjectRef;
    memberRef: ObjectRef;
  }
  /** Menu/panel closed. */
  | { kind: 'abandoned'; invocationRef: InvocationRef };

export type InvocationEventResult =
  | { status: 'updated'; opening: InvocationOpened }
  | { status: 'spent' };

export type ExecutionFailure =
  /** Main knows it did not run. */
  | { kind: 'commandRejected'; code: string }
  /** The renderer said so. */
  | { kind: 'rendererReported'; code: string }
  /** Never left main; provably did not run. */
  | { kind: 'notDelivered' }
  /** A bound result was missing at use. */
  | { kind: 'bindingUnresolved'; step: number }
  | { kind: 'invocationStale' };

export type ActionExecutionResult =
  /**
   * `focus` is the last executed command's focus hint. Commands still return
   * `CommandResult.focus` and the caret still lands where they say; the only
   * change is that main now forwards it instead of the renderer reading its own
   * command reply.
   */
  | { status: 'completed'; focus?: FocusHint }
  | { status: 'failed'; atStep: number; reason: ExecutionFailure }
  /** A missing ack does NOT prove the step did not run. */
  | { status: 'indeterminate'; atStep: number; reason: 'ackTimeout' | 'rendererGone' };

export type ActionRequestResult =
  | {
    status: 'confirmationRequired';
    challenge: ChallengeToken;
    confirm: ConfirmationSpec;
    /** Authoritative copy + subject + args for the dialog. */
    presentation: ReadyActionPresentation;
  }
  /** Current subject, changed args/state. */
  | { status: 'reEvaluated'; presentation: ActionPresentation }
  | {
    status: 'stale';
    reason: 'invocation' | 'subject' | 'subjectGeneration' | 'argument' | 'argumentGeneration';
  }
  | ActionExecutionResult;

// ---------------------------------------------------------------------------
// 5. REGISTRY DEFINITION (main/core side only — never crosses the seam)
// ---------------------------------------------------------------------------

/** Which object kinds a family accepts as its subject, and in what order. */
export type SubjectKindPrecedence = readonly SurfaceObjectKind[];

export interface ActionDefinition<K extends ActionId = ActionId> {
  actionId: K;
  subjectKinds: SubjectKindPrecedence;
  surfaces: readonly ActionSurface[];
  aliases: readonly string[];
  /**
   * Resolve zero or more presentations for one subject object. Returning an
   * empty array means `absent`: no row at all.
   */
  resolve(context: ActionResolveContext, subject: SurfaceObject): readonly ActionPresentation[];
  /**
   * Build the ordered effect plan for a re-validated request. Returning null
   * means the action no longer applies and the request is `reEvaluated`.
   */
  plan(context: ActionResolveContext, subject: SurfaceObject, args: ActionArguments[K]): ActionEffectPlan | null;
}

/** Everything an action may read: the document plus main-owned invocation facts. */
export interface ActionResolveContext {
  projection: ActionProjection;
  invocation: ActionInvocation;
  /** Resolve an object ref that is currently admissible in this invocation. */
  objectFor(ref: ObjectRef): SurfaceObject | null;
  /** The untitled fallback, part of the differential proof for `copy`. */
  untitled: string;
  /**
   * Main-owned, present only where a captured page exists. The registry never
   * fetches; it reads the context main already holds.
   */
  externalContext?(contextId: ExternalContextId): ExternalContext | null;
  /** Nondeterministic, so main mints it at plan time rather than the registry. */
  newCaptureId?(): string;
}

/**
 * The read model the registry evaluates against. Main builds it from the
 * authoritative `DocumentProjection`; the renderer builds the identical shape
 * from its own index for presentation-only paths.
 */
export interface ActionProjection {
  byId: ReadonlyMap<NodeId, import('../types').NodeProjection>;
  trashId: NodeId;
  todayId: NodeId;
  libraryId: NodeId;
  schemaId: NodeId;
  searchesId: NodeId;
}
