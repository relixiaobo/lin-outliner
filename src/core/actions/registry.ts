// The action registry: 19 families, evaluated where the document is.
//
// A resolved presentation binds a subject OBJECT and, where needed, typed
// arguments. Several presentations may share one `actionId` without sharing an
// effect by accident — the family/argument boundary is: the same user intent
// with a different target state, direction, representation, selected parameter
// or row-policy consequence stays one family; a different interaction surface,
// provenance model, irreversible boundary or confirmation contract is a
// different action. Internal core commands do not define this product taxonomy.

import type { ExternalContext } from '../launcher/context';
import { buildContextCaptureInput, buildManualNoteInput } from '../launcher/sources';
import {
  batchIndentNodeIds,
  indentExpansionTargets,
  parentIdsEmptiedByOutdent,
} from './outlineStructure';
import { parseIsoLocalDateParts, todayIsoLocalDate } from '../localDate';
import { nodeIsInSubtree } from '../treeUtils';
import type { NodeId, NodeProjection } from '../types';
import {
  stepRef,
  type ActionEffectPlan,
  type Bound,
  type EffectStep,
  type ViewSection,
} from './bindings';
import { actionName, confirmName, localizedNames, rejectionName, withBatchPrefix } from './names';
import {
  canonicalSurfaceId,
  contentTargetId,
  nodeIdForFacet,
  nodeText,
  systemKeyForFacet,
} from './objects';
import {
  canDuplicateRow,
  contentTargetIdsForRows,
  nodeRowFacetsForId,
  readNodeViewSettings,
  selectionRootIds,
  type NodeRowFacets,
} from './rowFacets';
import type {
  ActionArguments,
  ActionId,
  ArgumentSlot,
  ObjectParameterId,
  ActionPresentation,
  ActionProjection,
  ActionRejectionCode,
  ActionResolveContext,
  ActionSurface,
  ConfirmationSpec,
  IconId,
  LocalizedNames,
  NodeObject,
  ObjectRef,
  SurfaceObject,
  ViewFact,
  WorkspaceFact,
} from './types';

/**
 * Canonical context-menu order. The menu view walks this list; separators fall
 * where `MENU_GROUP` changes, which reproduces the shipped five separators
 * without the view hard-coding an action sequence of its own.
 */
export const CONTEXT_MENU_ORDER: readonly ActionId[] = [
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
  'emptyTrash',
  'restore',
  'deleteForever',
  'remove',
];

/**
 * Canonical order for the searchable `Actions ⌘K` panel. It is a DIFFERENT list
 * from the menu's on purpose: the panel starts with activation (the thing a
 * user most often wants from a found object) and may expose families the
 * anchored menu deliberately does not.
 */
export const ACTION_PANEL_ORDER: readonly ActionId[] = [
  'open',
  'capture',
  'create',
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
  'emptyTrash',
  'restore',
  'deleteForever',
  'remove',
  'indent',
  'outdent',
];

export const MENU_GROUP: Record<ActionId, number> = {
  open: 0,
  openInSplitPane: 1,
  setPinned: 1,
  sendToAgent: 1,
  duplicate: 1,
  move: 1,
  setDone: 2,
  addTag: 2,
  setViewMode: 3,
  setViewToolbarVisible: 3,
  editViewSection: 3,
  editDescription: 4,
  copy: 5,
  emptyTrash: 6,
  restore: 6,
  deleteForever: 6,
  remove: 6,
  capture: 0,
  create: 0,
  // Never in the anchored menu; the group is unused for them.
  indent: 0,
  outdent: 0,
};

/** Surface exposure is registry metadata, never a view-owned allow-list. */
export const ACTION_SURFACES: Record<ActionId, readonly ActionSurface[]> = {
  open: ['actionPanel'],
  openInSplitPane: ['contextMenu', 'actionPanel'],
  setPinned: ['contextMenu', 'actionPanel'],
  sendToAgent: ['contextMenu', 'actionPanel'],
  duplicate: ['contextMenu', 'actionPanel'],
  move: ['contextMenu', 'actionPanel'],
  setDone: ['contextMenu', 'actionPanel'],
  addTag: ['contextMenu', 'actionPanel'],
  setViewMode: ['contextMenu', 'actionPanel'],
  setViewToolbarVisible: ['contextMenu', 'actionPanel'],
  editViewSection: ['contextMenu', 'actionPanel'],
  editDescription: ['contextMenu', 'actionPanel'],
  copy: ['contextMenu', 'actionPanel'],
  remove: ['contextMenu', 'actionPanel'],
  restore: ['contextMenu', 'actionPanel'],
  deleteForever: ['contextMenu', 'actionPanel'],
  emptyTrash: ['contextMenu', 'actionPanel'],
  capture: ['actionPanel'],
  create: ['actionPanel'],
  // THE surface-exposure rule the ratification required: searchable only.
  // Adding 'contextMenu' here would break PR 1's differential after the fact.
  indent: ['actionPanel'],
  outdent: ['actionPanel'],
};

/**
 * Which object kinds a family accepts, most specific first. The precedence is
 * conditional on what the family accepts, not a blanket hiding rule: with a
 * live multi-selection, selection-capable families resolve once against the
 * selection while node-only families keep the anchored node subject.
 */
export const ACTION_SUBJECT_KINDS: Record<ActionId, readonly SurfaceObject['kind'][]> = {
  open: ['node', 'appSurface'],
  openInSplitPane: ['node'],
  setPinned: ['node'],
  sendToAgent: ['node', 'externalPage'],
  duplicate: ['nodeSelection', 'node'],
  move: ['nodeSelection', 'node'],
  setDone: ['nodeSelection', 'node'],
  addTag: ['nodeSelection', 'node'],
  setViewMode: ['node'],
  setViewToolbarVisible: ['node'],
  editViewSection: ['node'],
  editDescription: ['node'],
  copy: ['node'],
  remove: ['nodeSelection', 'node'],
  restore: ['node'],
  deleteForever: ['nodeSelection', 'node'],
  emptyTrash: ['node'],
  capture: ['externalPage'],
  create: ['draft'],
  indent: ['nodeSelection', 'node'],
  outdent: ['nodeSelection', 'node'],
};

/**
 * The object-valued parameter slots each family OWNS. A parameter query cannot
 * create a slot merely by naming one, and an OPTIONAL parameter (capture's tag)
 * still has to be answerable even though the resolved presentation is already
 * `ready` — so ownership is declared here rather than inferred from whether the
 * current binding happens to be waiting on it.
 *
 * The value exists because types are erased and the admission check needs one
 * at runtime; the mapped type is what stops it from becoming a SECOND source of
 * truth. Each entry may only contain that family's own declared parameter ids,
 * so a family whose `ObjectParameterId` is `never` can only be `[]`.
 */
export const ACTION_PARAMETER_IDS: {
  [K in ActionId]: readonly ObjectParameterId[K][];
} = {
  open: [],
  openInSplitPane: [],
  setPinned: [],
  sendToAgent: [],
  duplicate: [],
  move: ['destination'],
  setDone: [],
  addTag: ['tag'],
  setViewMode: [],
  setViewToolbarVisible: [],
  editViewSection: [],
  editDescription: [],
  copy: [],
  remove: [],
  restore: [],
  deleteForever: [],
  emptyTrash: [],
  capture: ['destination', 'tag'],
  create: ['destination'],
  indent: [],
  outdent: [],
};

/**
 * Whether a family declares the slot a request is naming. The widening to
 * `readonly string[]` happens HERE, once: indexing the mapped type by a union
 * of action ids collapses its element type, and the correlation that matters is
 * on the authoring side, where the table is written.
 */
export function declaresParameter(slot: ArgumentSlot): boolean {
  const declared: readonly string[] = ACTION_PARAMETER_IDS[slot.actionId];
  return declared.includes(slot.parameterId);
}

/** Locale-independent search terms. Never action ids. */
export const ACTION_ALIASES: Record<ActionId, readonly string[]> = {
  open: ['go', 'navigate', 'jump'],
  openInSplitPane: ['split', 'pane'],
  setPinned: ['pin', 'unpin', 'favorite'],
  sendToAgent: ['agent', 'composer', 'chat'],
  duplicate: ['copy row', 'clone'],
  move: ['reorder', 'reparent'],
  setDone: ['done', 'complete', 'todo', 'check'],
  addTag: ['tag', 'label', 'supertag'],
  setViewMode: ['view', 'table', 'outline'],
  setViewToolbarVisible: ['toolbar', 'view'],
  editViewSection: ['filter', 'sort', 'group', 'display'],
  editDescription: ['description', 'note'],
  copy: ['clipboard', 'id'],
  remove: ['delete', 'trash', 'remove'],
  restore: ['untrash', 'undelete'],
  deleteForever: ['purge', 'permanent'],
  emptyTrash: ['purge', 'clear trash'],
  capture: ['save', 'clip'],
  create: ['new', 'add'],
  indent: ['nest', 'demote', 'tab'],
  outdent: ['unnest', 'promote', 'untab'],
};

const ICONS: Record<string, IconId> = {
  openInSplitPane: 'open',
  setPinned: 'pin',
  sendToAgent: 'agent',
  duplicate: 'duplicate',
  moveUp: 'moveUp',
  moveDown: 'moveDown',
  moveTo: 'moveTo',
  setDone: 'checkbox',
  addTag: 'supertag',
  editDescription: 'description',
  copy: 'copy',
  trash: 'trash',
  restore: 'restore',
};

// ---------------------------------------------------------------------------
// Subject rows
// ---------------------------------------------------------------------------

/**
 * The structural occurrences a subject carries, plus the cardinality the
 * shipped batch prefix counts (selection roots, not the eligible subset).
 */
interface SubjectRows {
  rowIds: readonly NodeId[];
  cardinality: number;
  /** The single anchored node, for node-only families. */
  anchor: NodeObject | null;
}

function subjectRows(subject: SurfaceObject): SubjectRows | null {
  if (subject.kind === 'node') {
    const rowId = subject.row.by === 'id' ? subject.row.nodeId : null;
    return rowId === null
      ? { rowIds: [], cardinality: 1, anchor: subject }
      : { rowIds: [rowId], cardinality: 1, anchor: subject };
  }
  if (subject.kind === 'nodeSelection') {
    const rowIds = subject.nodes
      .map((node) => (node.row.by === 'id' ? node.row.nodeId : null))
      .filter((id): id is NodeId => id !== null);
    return { rowIds, cardinality: subject.nodes.length, anchor: null };
  }
  return null;
}

function facetsFor(
  rowIds: readonly NodeId[],
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeRowFacets[] {
  return rowIds
    .map((id) => nodeRowFacetsForId(id, byId))
    .filter((row): row is NodeRowFacets => row !== null);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const REJECTIONS: Record<ActionRejectionCode, LocalizedNames> = {
  noEligibleRows: rejectionName('noEligibleRows'),
  immutable: rejectionName('immutable'),
  inTrash: rejectionName('inTrash'),
  notInTrash: rejectionName('notInTrash'),
  trashEmpty: rejectionName('trashEmpty'),
  alreadyInState: rejectionName('alreadyInState'),
};

function rejected(code: ActionRejectionCode) {
  return { status: 'rejected' as const, reason: { code, names: REJECTIONS[code] } };
}

const APPLICABLE = { status: 'applicable' as const };

function present<K extends ActionId>(params: {
  actionId: K;
  subjectRef: ObjectRef;
  names: LocalizedNames;
  iconId: IconId;
  eligible: boolean;
  rejection?: ActionRejectionCode;
  arguments: ActionArguments[K];
  confirm?: ConfirmationSpec;
}): ActionPresentation {
  return {
    actionId: params.actionId,
    subjectRef: params.subjectRef,
    names: params.names,
    aliases: ACTION_ALIASES[params.actionId],
    iconId: params.iconId,
    surfaces: ACTION_SURFACES[params.actionId],
    evaluation: params.eligible ? APPLICABLE : rejected(params.rejection ?? 'noEligibleRows'),
    binding: { state: 'ready', arguments: params.arguments },
    ...(params.confirm ? { confirm: params.confirm } : {}),
  } as ActionPresentation;
}

function parameterLabel(
  slot: 'moveDestination' | 'tag',
  key: 'title' | 'inputLabel' | 'placeholder',
): LocalizedNames {
  return localizedNames((messages) => messages.parameters[slot][key]);
}

const MOVE_PARAMETER = {
  parameterId: 'destination' as const,
  objectKinds: ['node'] as const,
  title: parameterLabel('moveDestination', 'title'),
  inputLabel: parameterLabel('moveDestination', 'inputLabel'),
  placeholder: parameterLabel('moveDestination', 'placeholder'),
};

const TAG_PARAMETER = {
  parameterId: 'tag' as const,
  objectKinds: ['node', 'draft'] as const,
  title: parameterLabel('tag', 'title'),
  inputLabel: parameterLabel('tag', 'inputLabel'),
  placeholder: parameterLabel('tag', 'placeholder'),
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

function viewFactFor(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ViewFact | undefined {
  return context.invocation.view?.find((fact) => fact.objectRef === subject.objectRef);
}

function workspaceFactFor(
  context: ActionResolveContext,
  subject: SurfaceObject,
): WorkspaceFact | undefined {
  return context.invocation.workspace?.find((fact) => fact.objectRef === subject.objectRef);
}

function anchorContentNode(
  context: ActionResolveContext,
  anchor: NodeObject,
): NodeProjection | undefined {
  return context.projection.byId.get(nodeIdForFacet(anchor.content, context.projection));
}

/** Resolve every family for one subject, in canonical order. */
export function resolveActionsForSubject(
  context: ActionResolveContext,
  subject: SurfaceObject,
  order: readonly ActionId[] = CONTEXT_MENU_ORDER,
): ActionPresentation[] {
  const result: ActionPresentation[] = [];
  for (const actionId of order) result.push(...resolveFamily(context, actionId, subject));
  return result;
}

/**
 * D2's two-layer filter: main constructs the object set, then the registry
 * walks canonical order and resolves ONE subject per family from that set. A
 * naive object flat-map would duplicate rows and change their subjects.
 */
export function resolveActionsForObjectSet(
  context: ActionResolveContext,
  objects: readonly SurfaceObject[],
  options: { order?: readonly ActionId[]; surface?: ActionSurface } = {},
): ActionPresentation[] {
  const order = options.order ?? CONTEXT_MENU_ORDER;
  const surface = options.surface ?? 'contextMenu';
  const result: ActionPresentation[] = [];
  for (const actionId of order) {
    if (!ACTION_SURFACES[actionId].includes(surface)) continue;
    const subject = subjectForFamily(actionId, objects);
    if (!subject) continue;
    result.push(...resolveFamily(context, actionId, subject));
  }
  return result;
}

function subjectForFamily(
  actionId: ActionId,
  objects: readonly SurfaceObject[],
): SurfaceObject | null {
  for (const kind of ACTION_SUBJECT_KINDS[actionId]) {
    const match = objects.find((object) => object.kind === kind);
    if (match) return match;
  }
  return null;
}

export function resolveFamily(
  context: ActionResolveContext,
  actionId: ActionId,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (!ACTION_SUBJECT_KINDS[actionId].includes(subject.kind)) return [];
  switch (actionId) {
    case 'open': return resolveOpen(context, subject);
    case 'openInSplitPane': return resolveOpenInSplitPane(context, subject);
    case 'setPinned': return resolveSetPinned(context, subject);
    case 'sendToAgent': return resolveSendToAgent(context, subject);
    case 'duplicate': return resolveDuplicate(context, subject);
    case 'move': return resolveMove(context, subject);
    case 'setDone': return resolveSetDone(context, subject);
    case 'addTag': return resolveAddTag(context, subject);
    case 'setViewMode': return resolveSetViewMode(context, subject);
    case 'setViewToolbarVisible': return resolveSetViewToolbarVisible(context, subject);
    case 'editViewSection': return resolveEditViewSection(context, subject);
    case 'editDescription': return resolveEditDescription(context, subject);
    case 'copy': return resolveCopy(context, subject);
    case 'remove': return resolveRemove(context, subject);
    case 'restore': return resolveRestore(context, subject);
    case 'deleteForever': return resolveDeleteForever(context, subject);
    case 'emptyTrash': return resolveEmptyTrash(context, subject);
    case 'capture': return resolveCapture(context, subject);
    case 'create': return resolveCreate(context, subject);
    case 'indent': return resolveIndent(context, subject);
    case 'outdent': return resolveOutdent(context, subject);
  }
}

// --- open -------------------------------------------------------------------

function resolveOpen(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind === 'appSurface' || subject.kind === 'node') {
    return [present({
      actionId: 'open',
      subjectRef: subject.objectRef,
      names: actionName('open'),
      iconId: 'open',
      eligible: true,
      arguments: {},
    })];
  }
  return [];
}

// --- openInSplitPane --------------------------------------------------------

function resolveOpenInSplitPane(
  _context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  return [present({
    actionId: 'openInSplitPane',
    subjectRef: subject.objectRef,
    names: actionName('openInSplitPane'),
    iconId: ICONS.openInSplitPane!,
    eligible: true,
    arguments: {},
  })];
}

// --- setPinned --------------------------------------------------------------

function resolveSetPinned(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  const fact = workspaceFactFor(context, subject);
  // Pin reads `workspace.isPinned`, which lives in the MAIN renderer's state:
  // without an attested fact the action is defined relative to a workspace that
  // is not there, so it is absent rather than rejected.
  if (!fact) return [];
  return [present({
    actionId: 'setPinned',
    subjectRef: subject.objectRef,
    names: actionName(fact.isPinned ? 'unpin' : 'pin'),
    iconId: ICONS.setPinned!,
    eligible: true,
    arguments: { pinned: !fact.isPinned },
  })];
}

// --- sendToAgent ------------------------------------------------------------

function resolveSendToAgent(
  _context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  // Deliberately does NOT accept a node selection in this release: the shipped
  // action sends the anchored content node even with several rows selected.
  if (subject.kind !== 'node' && subject.kind !== 'externalPage') return [];
  return [present({
    actionId: 'sendToAgent',
    subjectRef: subject.objectRef,
    names: actionName('sendToAgent'),
    iconId: ICONS.sendToAgent!,
    eligible: true,
    arguments: {},
  })];
}

// --- duplicate --------------------------------------------------------------

function eligibleDuplicateIds(
  context: ActionResolveContext,
  rows: SubjectRows,
): NodeId[] {
  const byId = context.projection.byId;
  return facetsFor(rows.rowIds, byId)
    .filter((row) => row.actionPolicy.duplicate === 'node-clone' && canDuplicateRow(row, byId))
    .map((row) => row.id);
}

function resolveDuplicate(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  const eligible = eligibleDuplicateIds(context, rows);
  return [present({
    actionId: 'duplicate',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(actionName('duplicate'), rows.cardinality),
    iconId: ICONS.duplicate!,
    eligible: eligible.length > 0,
    arguments: {},
  })];
}

// --- move -------------------------------------------------------------------

function eligibleMoveIds(context: ActionResolveContext, rows: SubjectRows): NodeId[] {
  return facetsFor(rows.rowIds, context.projection.byId)
    .filter((row) => row.actionPolicy.move !== 'disabled')
    .map((row) => row.id);
}

export function eligibleMoveToIds(context: ActionResolveContext, subject: SurfaceObject): NodeId[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  return facetsFor(rows.rowIds, context.projection.byId)
    .filter((row) => row.mutable && row.kind !== 'fieldValue')
    .map((row) => row.id);
}

function resolveMove(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  const relativeIds = eligibleMoveIds(context, rows);
  const destinationIds = eligibleMoveToIds(context, subject);
  const relative = (direction: 'up' | 'down'): ActionPresentation => present({
    actionId: 'move',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(actionName(direction === 'up' ? 'moveUp' : 'moveDown'), rows.cardinality),
    iconId: direction === 'up' ? ICONS.moveUp! : ICONS.moveDown!,
    eligible: relativeIds.length > 0,
    arguments: { relative: direction },
  });
  const destination: ActionPresentation = {
    actionId: 'move',
    subjectRef: subject.objectRef,
    names: actionName('moveTo'),
    aliases: ACTION_ALIASES.move,
    iconId: ICONS.moveTo!,
    surfaces: ACTION_SURFACES.move,
    evaluation: destinationIds.length > 0 ? APPLICABLE : rejected('noEligibleRows'),
    binding: { state: 'needsParameter', seed: {}, parameter: MOVE_PARAMETER },
  };
  return [relative('up'), relative('down'), destination];
}

// --- setDone ----------------------------------------------------------------

function checkboxTargetIds(context: ActionResolveContext, subject: SurfaceObject): NodeId[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  const eligibleRows = facetsFor(rows.rowIds, context.projection.byId)
    .filter((row) => row.actionPolicy.checkbox !== 'disabled')
    .map((row) => row.id);
  if (eligibleRows.length === 0) return [];
  if (subject.kind === 'node') {
    // The single anchored row keeps the shipped chain-resolved content target.
    return [nodeIdForFacet(subject.content, context.projection)];
  }
  return contentTargetIdsForRows(eligibleRows, context.projection.byId);
}

function resolveSetDone(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  const targets = checkboxTargetIds(context, subject);
  const byId = context.projection.byId;
  const done = targets.filter((id) => Boolean(byId.get(id)?.completedAt));
  const notDone = targets.filter((id) => !byId.get(id)?.completedAt);

  const variant = (value: boolean, eligible: boolean): ActionPresentation => present({
    actionId: 'setDone',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(actionName(value ? 'markDone' : 'markNotDone'), rows.cardinality),
    iconId: ICONS.setDone!,
    eligible,
    arguments: { done: value },
  });

  if (targets.length === 0) {
    // No eligible row: keep ONE disabled row, labelled from the anchored node's
    // state exactly as the shipped menu does.
    const anchorDone = rows.anchor
      ? Boolean(anchorContentNode(context, rows.anchor)?.completedAt)
      : false;
    return [variant(!anchorDone, false)];
  }
  // A mixed selection presents both convergent setters; a homogeneous one
  // presents only the state-changing variant. There is no runtime toggle.
  if (done.length > 0 && notDone.length > 0) return [variant(true, true), variant(false, true)];
  return [variant(notDone.length > 0, true)];
}

// --- addTag -----------------------------------------------------------------

export function tagTargetIds(context: ActionResolveContext, subject: SurfaceObject): NodeId[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  const eligibleRows = facetsFor(rows.rowIds, context.projection.byId)
    .filter((row) => row.actionPolicy.tag !== 'disabled')
    .map((row) => row.id);
  if (eligibleRows.length === 0) return [];
  if (subject.kind === 'node') return [nodeIdForFacet(subject.content, context.projection)];
  return contentTargetIdsForRows(eligibleRows, context.projection.byId);
}

function resolveAddTag(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  const targets = tagTargetIds(context, subject);
  return [{
    actionId: 'addTag',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(actionName('addTag'), rows.cardinality),
    aliases: ACTION_ALIASES.addTag,
    iconId: ICONS.addTag!,
    surfaces: ACTION_SURFACES.addTag,
    evaluation: targets.length > 0 ? APPLICABLE : rejected('noEligibleRows'),
    binding: { state: 'needsParameter', seed: {}, parameter: TAG_PARAMETER },
  }];
}

// --- view families ----------------------------------------------------------

function resolveSetViewMode(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  void context;
  const variant = (mode: 'outline' | 'table'): ActionPresentation => present({
    actionId: 'setViewMode',
    subjectRef: subject.objectRef,
    names: actionName(mode === 'table' ? 'viewTable' : 'viewOutline'),
    iconId: mode === 'table' ? 'table' : 'outline',
    eligible: true,
    arguments: { mode },
  });
  return [variant('outline'), variant('table')];
}

/**
 * The one place a renderer fact must reach a command, admitted by name: rows 1
 * and 2 of D1's table differ ONLY by `rowExpanded`, so deriving the argument
 * from main-owned state alone would change behaviour.
 */
function resolveSetViewToolbarVisible(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  const fact = viewFactFor(context, subject);
  if (!fact) return [];
  const node = anchorContentNode(context, subject);
  if (node?.type === 'search') return [];
  const view = readNodeViewSettings(node, context.projection.byId);
  const visibleInRow = view.toolbarVisible && fact.rowExpanded;
  return [present({
    actionId: 'setViewToolbarVisible',
    subjectRef: subject.objectRef,
    names: actionName(visibleInRow ? 'hideViewToolbar' : 'showViewToolbar'),
    iconId: visibleInRow ? 'hideToolbar' : 'showToolbar',
    eligible: true,
    arguments: { visible: !visibleInRow },
  })];
}

const VIEW_SECTION_NAMES: Record<ViewSection, LocalizedNames> = {
  filter: actionName('editFilters'),
  sort: actionName('editSorting'),
  group: actionName('editGrouping'),
  display: actionName('editDisplayedFields'),
};

const VIEW_SECTION_ICONS: Record<ViewSection, IconId> = {
  filter: 'filter',
  sort: 'sortAsc',
  group: 'group',
  display: 'field',
};

function resolveEditViewSection(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  const fact = viewFactFor(context, subject);
  if (!fact) return [];
  const node = anchorContentNode(context, subject);
  const view = readNodeViewSettings(node, context.projection.byId);
  const sections: ViewSection[] = view.viewMode === 'table'
    ? ['filter', 'sort', 'display']
    : ['filter', 'sort', 'group', 'display'];
  return sections.map((section) => present({
    actionId: 'editViewSection',
    subjectRef: subject.objectRef,
    names: VIEW_SECTION_NAMES[section],
    iconId: VIEW_SECTION_ICONS[section],
    eligible: true,
    arguments: { section },
  }));
}

function resolveEditDescription(
  _context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  // An empty description is still EDITED, not a second `addDescription` action.
  return [present({
    actionId: 'editDescription',
    subjectRef: subject.objectRef,
    names: actionName('editDescription'),
    iconId: ICONS.editDescription!,
    eligible: true,
    arguments: {},
  })];
}

// --- copy -------------------------------------------------------------------

function resolveCopy(
  _context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  const variant = (representation: 'text' | 'nodeId'): ActionPresentation => present({
    actionId: 'copy',
    subjectRef: subject.objectRef,
    names: actionName(representation === 'text' ? 'copyText' : 'copyNodeId'),
    iconId: ICONS.copy!,
    eligible: true,
    arguments: { representation },
  });
  return [variant('text'), variant('nodeId')];
}

// --- remove / restore / deleteForever / emptyTrash ---------------------------

export interface RemovePartition {
  trashIds: NodeId[];
  fieldValueIds: NodeId[];
}

export function removePartition(
  context: ActionResolveContext,
  subject: SurfaceObject,
): RemovePartition {
  const rows = subjectRows(subject);
  const trashIds: NodeId[] = [];
  const fieldValueIds: NodeId[] = [];
  if (!rows) return { trashIds, fieldValueIds };
  for (const row of facetsFor(rows.rowIds, context.projection.byId)) {
    if (row.actionPolicy.delete === 'field-value-remove') fieldValueIds.push(row.id);
    else if (row.actionPolicy.delete === 'node-trash') trashIds.push(row.id);
  }
  return { trashIds, fieldValueIds };
}

function resolveRemove(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  if (isInTrash(context, subject) || isTrashRoot(context, subject)) return [];
  const { trashIds, fieldValueIds } = removePartition(context, subject);
  // `remove` names the intent; row policy chooses the effect, so the LABEL is
  // row-policy true rather than a generic "Trash" that is false for part of
  // its accepted subject set.
  const names = trashIds.length > 0 && fieldValueIds.length > 0
    ? actionName('removeSelectedItems')
    : fieldValueIds.length > 0
      ? actionName(fieldValueIds.length > 1 ? 'removeFieldValues' : 'removeFieldValue')
      : actionName('moveToTrash');
  return [present({
    actionId: 'remove',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(names, rows.cardinality),
    iconId: ICONS.trash!,
    eligible: trashIds.length + fieldValueIds.length > 0,
    arguments: {},
  })];
}

function resolveRestore(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node') return [];
  if (!isInTrash(context, subject) || isTrashRoot(context, subject)) return [];
  return [present({
    actionId: 'restore',
    subjectRef: subject.objectRef,
    names: actionName('restore'),
    iconId: ICONS.restore!,
    eligible: true,
    arguments: {},
  })];
}

export function permanentDeleteIds(
  context: ActionResolveContext,
  ids: readonly NodeId[],
): NodeId[] {
  const { byId, trashId } = context.projection;
  const filtered = ids.filter((nodeId) => nodeId !== trashId);
  return selectionRootIds(filtered, byId).filter((nodeId) => {
    const node = byId.get(nodeId);
    return Boolean(node && !node.locked) && nodeIsInSubtree(byId, nodeId, trashId);
  });
}

function deleteForeverConfirmation(count: number): ConfirmationSpec {
  return {
    title: count > 1
      ? confirmName((messages) => messages.deleteForeverTitleMultiple({ count }))
      : confirmName((messages) => messages.deleteForeverTitle),
    message: count > 1
      ? confirmName((messages) => messages.deleteForeverMessageMultiple)
      : confirmName((messages) => messages.deleteForeverMessage),
    confirmLabel: confirmName((messages) => messages.deleteForeverConfirm),
    danger: true,
  };
}

function resolveDeleteForever(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  if (!isInTrash(context, subject) || isTrashRoot(context, subject)) return [];
  const ids = permanentDeleteIds(context, rows.rowIds);
  return [present({
    actionId: 'deleteForever',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(actionName('deleteForever'), rows.cardinality),
    iconId: ICONS.trash!,
    eligible: ids.length > 0,
    arguments: {},
    confirm: deleteForeverConfirmation(ids.length),
  })];
}

function resolveEmptyTrash(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'node' || !isTrashRoot(context, subject)) return [];
  const ids = emptyTrashIds(context);
  return [present({
    actionId: 'emptyTrash',
    subjectRef: subject.objectRef,
    names: actionName('emptyTrash'),
    iconId: ICONS.trash!,
    eligible: ids.length > 0,
    rejection: 'trashEmpty',
    arguments: {},
    confirm: {
      title: confirmName((messages) => messages.emptyTrashTitle),
      message: confirmName((messages) => messages.emptyTrashMessage),
      confirmLabel: confirmName((messages) => messages.emptyTrashConfirm),
      danger: true,
    },
  })];
}

export function emptyTrashIds(context: ActionResolveContext): NodeId[] {
  const { byId, trashId } = context.projection;
  return permanentDeleteIds(context, byId.get(trashId)?.children ?? []);
}

// --- capture / create -------------------------------------------------------

/**
 * The Today destination is a BOUND object, not prose inside an action id: the
 * row is *Today* and the verb is *Capture* / *Create node*.
 */
function destinationBinding(
  context: ActionResolveContext,
  destinationRef: ObjectRef,
): { steps: EffectStep[]; parentId: Bound<NodeId> } | null {
  const destination = context.objectFor(destinationRef);
  if (!destination || destination.kind !== 'node') return null;
  if (systemKeyForFacet(destination.canonicalSurface) === 'today') {
    const steps = ensureTodaySteps();
    if (steps.length === 0) return null;
    return { steps, parentId: { fromStep: TODAY_STEP_REF, field: 'focusNodeId' } };
  }
  return { steps: [], parentId: nodeIdForFacet(destination.canonicalSurface, context.projection) };
}

function resolveCapture(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'externalPage') return [];
  // Absent, not rejected, when no captured page backs this object: the subject
  // it is defined relative to genuinely is not there.
  if (!context.externalContext?.(subject.contextId)) return [];
  const destination = resolverArgumentRef(context, 'capture', subject.objectRef, 'destination');
  if (!destination) return [];
  return [present({
    actionId: 'capture',
    subjectRef: subject.objectRef,
    names: actionName('capture'),
    iconId: 'open',
    eligible: true,
    arguments: { destination },
  })];
}

/**
 * The ref of an object main installed into one exact argument slot. The same
 * Today node may hold a main-list subject ref AND a capture-destination
 * argument ref: the noun is the same, the two refs grant different uses.
 */
function resolverArgumentRef(
  context: ActionResolveContext,
  actionId: ActionId,
  subjectRef: ObjectRef,
  parameterId: string,
): ObjectRef | null {
  for (const generation of context.invocation.argumentGenerations) {
    if (generation.state !== 'ready') continue;
    if (generation.slot.actionId !== actionId) continue;
    if (generation.slot.subjectRef !== subjectRef) continue;
    if (generation.slot.parameterId !== parameterId) continue;
    const first = generation.objects[0];
    if (first) return first.objectRef;
  }
  return null;
}

function resolveCreate(
  _context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  if (subject.kind !== 'draft' || subject.purpose !== 'node') return [];
  const destination = resolverArgumentRef(_context, 'create', subject.objectRef, 'destination');
  if (!destination) return [];
  return [present({
    actionId: 'create',
    subjectRef: subject.objectRef,
    names: actionName('createNode'),
    iconId: 'node',
    eligible: subject.text.trim().length > 0,
    arguments: { destination },
  })];
}

/**
 * What the composer shows for a staged page, and what the model actually sees.
 * Deliberately basic-info only: title, where it came from, and the canonical
 * link. Page BODY extraction is a separate, explicitly-invoked reader — the
 * ambient hotkey path never fetches.
 */
export function externalPageLabel(context: ExternalContext): string {
  return context.source?.title || context.browser?.tabTitle || context.app.name || 'Page';
}

function externalPageContextValue(context: ExternalContext): string {
  const url = context.source?.canonicalUrl ?? context.source?.url ?? context.browser?.url;
  return [
    `Title: ${externalPageLabel(context)}`,
    context.browser?.hostname ? `Site: ${context.browser.hostname}` : null,
    url ? `URL: ${url}` : null,
    `App: ${context.app.name}`,
  ].filter(Boolean).join('\n');
}

// --- indent / outdent -------------------------------------------------------

/**
 * The rows a structural indent/outdent may act on. Both need MUTABLE, non-field
 * rows; `outdent` additionally needs the pane root, because "can this row move
 * out one level" is a question about the pane the user is looking at.
 */
function structuralRowIds(context: ActionResolveContext, subject: SurfaceObject): NodeId[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  return facetsFor(rows.rowIds, context.projection.byId)
    .filter((row) => row.mutable && row.kind !== 'fieldValue')
    .map((row) => row.id);
}

/** The attested pane root for this subject, or null when none was supplied. */
function selectionRootFor(
  context: ActionResolveContext,
  subject: SurfaceObject,
): NodeId | null {
  return viewFactFor(context, subject)?.selectionRootId ?? null;
}

function resolveIndent(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  const eligible = batchIndentNodeIds(structuralRowIds(context, subject), context.projection.byId);
  return [present({
    actionId: 'indent',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(actionName('indent'), rows.cardinality),
    iconId: 'moveTo',
    eligible: eligible.length > 0,
    arguments: {},
  })];
}

function resolveOutdent(
  context: ActionResolveContext,
  subject: SurfaceObject,
): ActionPresentation[] {
  const rows = subjectRows(subject);
  if (!rows) return [];
  // ABSENT without an attested pane root: outdent is defined relative to a view
  // that is not there, and main cannot recover which root the user chose — the
  // same node can appear under several.
  const selectionRootId = selectionRootFor(context, subject);
  if (selectionRootId === null) return [];
  const eligible = outdentRowIds(context, subject, selectionRootId);
  return [present({
    actionId: 'outdent',
    subjectRef: subject.objectRef,
    names: withBatchPrefix(actionName('outdent'), rows.cardinality),
    iconId: 'moveTo',
    eligible: eligible.length > 0,
    arguments: {},
  })];
}

function outdentRowIds(
  context: ActionResolveContext,
  subject: SurfaceObject,
  selectionRootId: NodeId,
): NodeId[] {
  return structuralRowIds(context, subject).filter((id) => (
    context.projection.byId.get(id)?.parentId !== selectionRootId
  ));
}

// --- shared predicates ------------------------------------------------------

function rowIdOf(subject: SurfaceObject): NodeId | null {
  if (subject.kind !== 'node') return null;
  return subject.row.by === 'id' ? subject.row.nodeId : null;
}

/**
 * Trash-ness is a fact about WHERE THE USER CLICKED, not about whichever row
 * happens to sort first in the live selection. The shipped menu read the
 * anchored row, and it has to stay that way: a selection whose first root is
 * trashed would otherwise hide *Move to Trash* and offer *Delete forever* —
 * permanent, unrecoverable — for a node the user did not right-click.
 */
function anchorRowId(
  context: ActionResolveContext,
  subject: SurfaceObject,
): NodeId | null {
  const anchorRef = context.invocation.anchorObjectRef;
  const anchor = anchorRef ? context.objectFor(anchorRef) : null;
  if (anchor && anchor.kind === 'node') return rowIdOf(anchor);
  // No anchored opening (the launcher): fall back to the subject's own row.
  return rowIdOf(subject) ?? subjectRows(subject)?.rowIds[0] ?? null;
}

function isTrashRoot(context: ActionResolveContext, subject: SurfaceObject): boolean {
  const rowId = anchorRowId(context, subject);
  if (rowId !== null) return rowId === context.projection.trashId;
  const anchorRef = context.invocation.anchorObjectRef;
  const anchor = anchorRef ? context.objectFor(anchorRef) : subject;
  return anchor?.kind === 'node' && systemKeyForFacet(anchor.row) === 'trash';
}

function isInTrash(context: ActionResolveContext, subject: SurfaceObject): boolean {
  const rowId = anchorRowId(context, subject);
  if (rowId === null) return false;
  return nodeIsInSubtree(context.projection.byId, rowId, context.projection.trashId);
}

// ---------------------------------------------------------------------------
// Effect plans
// ---------------------------------------------------------------------------

export function planFor<K extends ActionId>(
  context: ActionResolveContext,
  actionId: K,
  subject: SurfaceObject,
  args: ActionArguments[K],
): ActionEffectPlan | null {
  const build = PLANNERS[actionId] as
    | ((c: ActionResolveContext, s: SurfaceObject, a: ActionArguments[K]) => ActionEffectPlan | null)
    | undefined;
  return build ? build(context, subject, args) : null;
}

type Planner<K extends ActionId> = (
  context: ActionResolveContext,
  subject: SurfaceObject,
  args: ActionArguments[K],
) => ActionEffectPlan | null;

const restoreInvoker = (steps: readonly EffectStep[]): ActionEffectPlan => ({
  steps,
  completion: 'restoreInvoker',
});

const stayAtDestination = (steps: readonly EffectStep[]): ActionEffectPlan => ({
  steps,
  completion: 'stayAtDestination',
});

const TODAY_STEP_REF = stepRef('today');

/** `open` on Today must ENSURE the day's node and navigate to what it returns. */
function ensureTodaySteps(): EffectStep[] {
  const parts = parseIsoLocalDateParts(todayIsoLocalDate());
  if (!parts) return [];
  return [{
    on: 'main',
    kind: 'command',
    command: 'ensure_date_node',
    args: { year: parts.year, month: parts.month, day: parts.day },
    bindAs: TODAY_STEP_REF,
  }];
}

const PLANNERS: { [K in ActionId]?: Planner<K> } = {
  open: (context, subject) => {
    if (subject.kind === 'appSurface') {
      return stayAtDestination([
        { on: 'main', kind: 'activateAppSurface', surface: subject.surface },
      ]);
    }
    if (subject.kind !== 'node') return null;
    if (systemKeyForFacet(subject.canonicalSurface) === 'today') {
      const ensure = ensureTodaySteps();
      if (ensure.length === 0) return null;
      return stayAtDestination([
        ...ensure,
        {
          on: 'mainRenderer',
          kind: 'navigate',
          nodeId: { fromStep: TODAY_STEP_REF, field: 'focusNodeId' },
          inPlace: true,
        },
      ]);
    }
    return stayAtDestination([{
      on: 'mainRenderer',
      kind: 'navigate',
      nodeId: nodeIdForFacet(subject.canonicalSurface, context.projection),
      inPlace: true,
    }]);
  },

  openInSplitPane: (context, subject) => {
    if (subject.kind !== 'node') return null;
    return stayAtDestination([{
      on: 'mainRenderer',
      kind: 'workspace',
      op: 'openSplitPane',
      nodeId: nodeIdForFacet(subject.canonicalSurface, context.projection),
    }]);
  },

  setPinned: (context, subject, args) => {
    if (subject.kind !== 'node') return null;
    return restoreInvoker([{
      on: 'mainRenderer',
      kind: 'workspace',
      op: args.pinned ? 'pin' : 'unpin',
      nodeId: nodeIdForFacet(subject.canonicalSurface, context.projection),
    }]);
  },

  sendToAgent: (context, subject) => {
    if (subject.kind === 'externalPage') {
      const external = context.externalContext?.(subject.contextId);
      if (!external) return null;
      return stayAtDestination([{
        on: 'mainRenderer',
        kind: 'composerHandoff',
        object: {
          kind: 'externalPage',
          contextId: subject.contextId,
          label: externalPageLabel(external),
          value: externalPageContextValue(external),
        },
        draftText: context.invocation.draftText,
      }]);
    }
    if (subject.kind !== 'node') return null;
    const nodeId = nodeIdForFacet(subject.content, context.projection);
    return stayAtDestination([{
      on: 'mainRenderer',
      kind: 'composerHandoff',
      object: {
        kind: 'node',
        nodeId,
        title: nodeText(context.projection.byId.get(nodeId), context.untitled),
      },
      draftText: context.invocation.draftText,
    }]);
  },

  duplicate: (context, subject) => {
    const rows = subjectRows(subject);
    if (!rows) return null;
    const ids = eligibleDuplicateIds(context, rows);
    if (ids.length === 0) return null;
    return restoreInvoker([
      { on: 'main', kind: 'command', command: 'batch_duplicate_nodes', args: { nodeIds: ids } },
    ]);
  },

  move: (context, subject, args) => {
    const rows = subjectRows(subject);
    if (!rows) return null;
    if (args.relative) {
      const ids = eligibleMoveIds(context, rows);
      if (ids.length === 0) return null;
      return restoreInvoker([{
        on: 'main',
        kind: 'command',
        command: args.relative === 'up' ? 'batch_move_nodes_up' : 'batch_move_nodes_down',
        args: { nodeIds: ids },
      }]);
    }
    const destination = context.objectFor(args.destination);
    if (!destination || destination.kind !== 'node') return null;
    const parentId = nodeIdForFacet(destination.canonicalSurface, context.projection);
    const ids = eligibleMoveToIds(context, subject);
    if (ids.length === 0) return null;
    return restoreInvoker(ids.map((nodeId): EffectStep => ({
      on: 'main',
      kind: 'command',
      command: 'move_node',
      args: { nodeId, parentId, index: null },
    })));
  },

  setDone: (context, subject, args) => {
    const targets = checkboxTargetIds(context, subject);
    const byId = context.projection.byId;
    // Only nodes not already in the requested state change; a mixed selection
    // therefore CONVERGES instead of becoming a different mixed selection.
    const changing = targets.filter((id) => Boolean(byId.get(id)?.completedAt) !== args.done);
    if (changing.length === 0) return null;
    return restoreInvoker([changing.length > 1
      ? { on: 'main', kind: 'command', command: 'batch_toggle_done', args: { nodeIds: changing } }
      : { on: 'main', kind: 'command', command: 'toggle_done', args: { nodeId: changing[0]! } }]);
  },

  addTag: (context, subject, args) => {
    const targets = tagTargetIds(context, subject);
    if (targets.length === 0) return null;
    const tagObject = context.objectFor(args.tag);
    if (!tagObject) return null;

    const applySteps = (tagId: NodeId | { fromStep: typeof TAG_STEP_REF; field: 'focusNodeId' }): EffectStep[] => (
      targets.length > 1
        ? [{
          on: 'main',
          kind: 'command',
          command: 'batch_apply_tag',
          args: { nodeIds: targets, tagId },
        }]
        : [{
          on: 'main',
          kind: 'command',
          command: 'apply_tag',
          args: { nodeId: targets[0]!, tagId },
        }]
    );

    if (tagObject.kind === 'draft' && tagObject.purpose === 'tag') {
      // Create-then-apply through a BOUND reference: no compound command is
      // added to the mutation protocol to serve exactly one action.
      return restoreInvoker([
        {
          on: 'main',
          kind: 'command',
          command: 'create_tag',
          args: { name: tagObject.text },
          bindAs: TAG_STEP_REF,
        },
        ...applySteps({ fromStep: TAG_STEP_REF, field: 'focusNodeId' }),
      ]);
    }
    if (tagObject.kind !== 'node') return null;
    return restoreInvoker(applySteps(nodeIdForFacet(tagObject.content, context.projection)));
  },

  setViewMode: (context, subject, args) => {
    if (subject.kind !== 'node') return null;
    return restoreInvoker([{
      on: 'main',
      kind: 'command',
      command: 'set_view_mode',
      args: {
        nodeId: nodeIdForFacet(subject.content, context.projection),
        mode: args.mode === 'table' ? 'table' : 'list',
      },
    }]);
  },

  setViewToolbarVisible: (context, subject, args) => {
    if (subject.kind !== 'node') return null;
    const fact = viewFactFor(context, subject);
    if (!fact) return null;
    const nodeId = nodeIdForFacet(subject.content, context.projection);
    const steps: EffectStep[] = [{
      on: 'main',
      kind: 'command',
      command: 'set_view_toolbar_visible',
      args: { nodeId, visible: args.visible },
    }];
    // A renderer step runs only AFTER the preceding main step succeeds.
    if (args.visible) {
      steps.push({
        on: 'mainRenderer',
        kind: 'reveal',
        target: { surface: 'viewToolbar', nodeId, visualRowId: fact.visualRowId },
      });
    }
    return restoreInvoker(steps);
  },

  editViewSection: (context, subject, args) => {
    if (subject.kind !== 'node') return null;
    const fact = viewFactFor(context, subject);
    if (!fact) return null;
    const nodeId = nodeIdForFacet(subject.content, context.projection);
    const steps: EffectStep[] = [];
    if (anchorContentNode(context, subject)?.type !== 'search') {
      steps.push({
        on: 'main',
        kind: 'command',
        command: 'set_view_toolbar_visible',
        args: { nodeId, visible: true },
      });
    }
    steps.push(
      {
        on: 'mainRenderer',
        kind: 'reveal',
        target: { surface: 'viewToolbar', nodeId, visualRowId: fact.visualRowId },
      },
      {
        on: 'mainRenderer',
        kind: 'reveal',
        target: { surface: 'viewSection', nodeId, section: args.section },
      },
    );
    return restoreInvoker(steps);
  },

  editDescription: (context, subject) => {
    if (subject.kind !== 'node') return null;
    return stayAtDestination([{
      on: 'mainRenderer',
      kind: 'reveal',
      target: {
        surface: 'description',
        nodeId: nodeIdForFacet(subject.content, context.projection),
      },
    }]);
  },

  copy: (context, subject, args) => {
    if (subject.kind !== 'node') return null;
    const nodeId = nodeIdForFacet(subject.content, context.projection);
    const text = args.representation === 'nodeId'
      ? nodeId
      : nodeText(context.projection.byId.get(nodeId), context.untitled);
    return restoreInvoker([{ on: 'main', kind: 'clipboard', text }]);
  },

  remove: (context, subject) => {
    const { trashIds, fieldValueIds } = removePartition(context, subject);
    if (trashIds.length + fieldValueIds.length === 0) return null;
    const steps: EffectStep[] = [];
    if (trashIds.length > 0) {
      steps.push({
        on: 'main',
        kind: 'command',
        command: 'batch_trash_nodes',
        args: { nodeIds: trashIds },
      });
    }
    for (const valueId of fieldValueIds) {
      steps.push({ on: 'main', kind: 'command', command: 'remove_field_value', args: { valueId } });
    }
    return restoreInvoker(steps);
  },

  restore: (context, subject) => {
    const rowId = rowIdOf(subject);
    if (rowId === null) return null;
    void context;
    return restoreInvoker([
      { on: 'main', kind: 'command', command: 'restore_node', args: { nodeId: rowId } },
    ]);
  },

  deleteForever: (context, subject) => {
    const rows = subjectRows(subject);
    if (!rows) return null;
    const ids = permanentDeleteIds(context, rows.rowIds);
    if (ids.length === 0) return null;
    return restoreInvoker(ids.map((nodeId): EffectStep => ({
      on: 'main',
      kind: 'command',
      command: 'delete_node',
      args: { nodeId },
    })));
  },

  emptyTrash: (context) => {
    const ids = emptyTrashIds(context);
    if (ids.length === 0) return null;
    return restoreInvoker(ids.map((nodeId): EffectStep => ({
      on: 'main',
      kind: 'command',
      command: 'delete_node',
      args: { nodeId },
    })));
  },

  indent: (context, subject) => {
    const rows = subjectRows(subject);
    const selectionRootId = selectionRootFor(context, subject);
    if (!rows || selectionRootId === null) return null;
    const byId = context.projection.byId;
    const nodeIds = batchIndentNodeIds(structuralRowIds(context, subject), byId);
    if (nodeIds.length === 0) return null;
    // Expansion FIRST: the target is about to gain children, so expanding it
    // early moves nothing on screen. Doing it after would hide the moved rows
    // for a frame behind a collapsed parent.
    const steps: EffectStep[] = [
      { on: 'mainRenderer', kind: 'outlineIntent', intent: { kind: 'animateRowMovement' } },
      {
        on: 'mainRenderer',
        kind: 'outlineIntent',
        intent: { kind: 'expand', nodeIds: indentExpansionTargets(nodeIds, byId) },
      },
      {
        on: 'mainRenderer',
        kind: 'outlineIntent',
        intent: {
          kind: 'restoreSelection',
          anchorId: rows.rowIds[0]!,
          selectedIds: rows.rowIds,
          selectionRootId,
        },
      },
      { on: 'main', kind: 'command', command: 'batch_indent_nodes', args: { nodeIds } },
    ];
    return { steps, completion: 'restoreInvoker', focus: 'surfaceOwned' };
  },

  outdent: (context, subject) => {
    const rows = subjectRows(subject);
    const selectionRootId = selectionRootFor(context, subject);
    if (!rows || selectionRootId === null) return null;
    const byId = context.projection.byId;
    const nodeIds = outdentRowIds(context, subject, selectionRootId);
    if (nodeIds.length === 0) return null;
    // Emptied parents are computed from the PRE-command tree but collapsed
    // AFTER: collapsing one that still holds the rows would hide them for a
    // frame and then show them again one level out.
    const emptied = parentIdsEmptiedByOutdent(nodeIds, byId, selectionRootId);
    const steps: EffectStep[] = [
      { on: 'mainRenderer', kind: 'outlineIntent', intent: { kind: 'animateRowMovement' } },
      {
        on: 'mainRenderer',
        kind: 'outlineIntent',
        intent: {
          kind: 'restoreSelection',
          anchorId: rows.rowIds[0]!,
          selectedIds: rows.rowIds,
          selectionRootId,
        },
      },
      { on: 'main', kind: 'command', command: 'batch_outdent_nodes', args: { nodeIds } },
    ];
    if (emptied.length > 0) {
      steps.push({
        on: 'mainRenderer',
        kind: 'outlineIntent',
        intent: { kind: 'collapse', nodeIds: emptied },
      });
    }
    return { steps, completion: 'restoreInvoker', focus: 'surfaceOwned' };
  },

  capture: (context, subject, args) => {
    if (subject.kind !== 'externalPage') return null;
    const external = context.externalContext?.(subject.contextId);
    const captureId = context.newCaptureId?.();
    if (!external || !captureId) return null;
    const destination = destinationBinding(context, args.destination);
    if (!destination) return null;
    const input = buildContextCaptureInput({
      context: external,
      destinationParentId: '',
      captureId,
      ...(context.invocation.draftText.trim() ? { note: context.invocation.draftText } : {}),
    });
    const steps: EffectStep[] = [
      ...destination.steps,
      {
        on: 'main',
        kind: 'command',
        command: 'create_capture',
        args: { input: { ...input, destinationParentId: destination.parentId } },
        bindAs: CAPTURE_STEP_REF,
      },
    ];
    if (args.tag) {
      const tagObject = context.objectFor(args.tag);
      if (tagObject?.kind === 'draft' && tagObject.purpose === 'tag') {
        steps.push({
          on: 'main',
          kind: 'command',
          command: 'create_tag',
          args: { name: tagObject.text },
          bindAs: TAG_STEP_REF,
        });
        steps.push({
          on: 'main',
          kind: 'command',
          command: 'apply_tag',
          args: {
            nodeId: { fromStep: CAPTURE_STEP_REF, field: 'focusNodeId' },
            tagId: { fromStep: TAG_STEP_REF, field: 'focusNodeId' },
          },
        });
      } else if (tagObject?.kind === 'node') {
        steps.push({
          on: 'main',
          kind: 'command',
          command: 'apply_tag',
          args: {
            nodeId: { fromStep: CAPTURE_STEP_REF, field: 'focusNodeId' },
            tagId: nodeIdForFacet(tagObject.content, context.projection),
          },
        });
      }
    }
    return restoreInvoker(steps);
  },

  create: (context, subject, args) => {
    if (subject.kind !== 'draft' || subject.purpose !== 'node') return null;
    const title = subject.text.trim();
    if (!title) return null;
    const destination = destinationBinding(context, args.destination);
    if (!destination) return null;
    // A plain node with no capture provenance — the shipped manual-note path.
    const input = buildManualNoteInput({ destinationParentId: '', title });
    return restoreInvoker([
      ...destination.steps,
      {
        on: 'main',
        kind: 'command',
        command: 'create_capture',
        args: { input: { ...input, destinationParentId: destination.parentId } },
      },
    ]);
  },
};

const CAPTURE_STEP_REF = stepRef('capture');

const TAG_STEP_REF = stepRef('tag');

export { canonicalSurfaceId, contentTargetId };
