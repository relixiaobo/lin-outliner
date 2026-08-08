// The effect layer of the unified command surface: an action resolves to an
// ORDERED PLAN of steps, because real actions cross executors (a core command,
// then a renderer reveal, then a clipboard write). See
// `docs/plans/unified-command-surface.md` D1a.
//
// `ACTION_BINDINGS` is a `const` VALUE, not an interface, and that is
// load-bearing: TypeScript erases interfaces, so a codec or an executor cannot
// read one, and a second value-level copy would recreate the drift this exists
// to prevent. The types below derive from `typeof ACTION_BINDINGS`, and the
// runtime codec/executor read the same object.

import type { DocumentCommand } from '../commands';
import type { CreateCaptureInput } from '../launcher/sources';
import type { NodeId, ViewMode } from '../types';

/**
 * Argument shapes for exactly the commands the registry emits. `documentService`
 * accepts `Record<string, unknown>`, so there is no existing correlation to
 * inherit — it is created here, as a type-level map over EXISTING command names.
 * `src/core/commands.ts` is untouched by this plan.
 */
export interface CommandArgs {
  batch_apply_tag: { nodeIds: readonly NodeId[]; tagId: NodeId };
  batch_duplicate_nodes: { nodeIds: readonly NodeId[] };
  batch_move_nodes_down: { nodeIds: readonly NodeId[] };
  batch_move_nodes_up: { nodeIds: readonly NodeId[] };
  batch_toggle_done: { nodeIds: readonly NodeId[] };
  batch_trash_nodes: { nodeIds: readonly NodeId[] };
  create_capture: { input: CreateCaptureInput };
  create_tag: { name: string };
  delete_node: { nodeId: NodeId };
  ensure_date_node: { year: number; month: number; day: number };
  apply_tag: { nodeId: NodeId; tagId: NodeId };
  move_node: { nodeId: NodeId; parentId: NodeId; index: number | null };
  remove_field_value: { valueId: NodeId };
  restore_node: { nodeId: NodeId };
  set_view_mode: { nodeId: NodeId; mode: ViewMode };
  set_view_toolbar_visible: { nodeId: NodeId; visible: boolean };
  toggle_done: { nodeId: NodeId };
}

export type CommandName = keyof CommandArgs;

// Every modelled name really is a document command. A typo or a rename in
// `commands.ts` fails here rather than at runtime inside `documentService`.
type AssertCommandNames = CommandName extends DocumentCommand ? true : never;
const _assertCommandNames: AssertCommandNames = true;
void _assertCommandNames;

export const ACTION_BINDINGS = {
  // PRODUCERS: which commands yield a bindable value, and WHERE it lives in the
  // real `CommandResult`. Commands return `focus?: FocusHint` (`core/types.ts`)
  // — there is no `result.focusNodeId` anywhere, so the extraction path is
  // stated rather than assumed.
  produces: {
    ensure_date_node: { focusNodeId: ['focus', 'nodeId'] },
    create_tag: { focusNodeId: ['focus', 'nodeId'] },
    create_capture: { focusNodeId: ['focus', 'nodeId'] },
  },
  // CONSUMERS: exact arg paths that may hold a step reference. Paths, rather
  // than top-level field names, express the real
  // `create_capture.input.destinationParentId` shape. They stay explicit
  // because `NodeId` IS `string`: a structural "every NodeId is bindable" rule
  // would also open `create_tag.name`.
  consumes: {
    create_capture: [['input', 'destinationParentId']],
    apply_tag: [['nodeId'], ['tagId']],
    batch_apply_tag: [['tagId']],
  },
} as const;

export type BindableCommand = keyof typeof ACTION_BINDINGS.produces;
export type BindableField = 'focusNodeId';

/** A name a step gives its own result so a later step can reference it. */
export type StepRef = string & { readonly __brand: 'StepRef' };

export function stepRef(name: string): StepRef {
  return name as StepRef;
}

export type StepReference = { fromStep: StepRef; field: BindableField };
export type Bound<T> = T | StepReference;

export function isStepReference(value: unknown): value is StepReference {
  return typeof value === 'object'
    && value !== null
    && typeof (value as StepReference).fromStep === 'string'
    && (value as StepReference).field === 'focusNodeId';
}

type BindAtPath<T, P extends readonly PropertyKey[]> =
  P extends readonly [infer Head, ...infer Tail extends readonly PropertyKey[]]
    ? Head extends keyof T
      ? { [K in keyof T]: K extends Head
        ? Tail extends readonly [] ? Bound<T[K]> : BindAtPath<T[K], Tail>
        : T[K] }
      : never
    : T;

type BindAtPaths<
  T,
  Paths extends readonly (readonly PropertyKey[])[],
> = Paths extends readonly [
  infer Head extends readonly PropertyKey[],
  ...infer Tail extends readonly (readonly PropertyKey[])[],
]
  ? BindAtPaths<BindAtPath<T, Head>, Tail>
  : T;

type ConsumerPaths<K extends CommandName> =
  K extends keyof typeof ACTION_BINDINGS.consumes
    ? typeof ACTION_BINDINGS.consumes[K]
    : readonly [];

/** Only descriptor leaves become `Bound<T>`; everything else stays literal. */
export type BoundCommandArgs<K extends CommandName> = BindAtPaths<
  CommandArgs[K],
  ConsumerPaths<K>
>;

/**
 * Mapped union: args are correlated WITH the command name, and `bindAs` exists
 * ONLY where a result exists to bind. A `command: CommandName` beside a loose
 * `args` would let the wrong args pair with a command and still compile.
 */
export type CommandStep = {
  [K in CommandName]: {
    on: 'main';
    kind: 'command';
    command: K;
    args: BoundCommandArgs<K>;
  } & (K extends BindableCommand ? { bindAs?: StepRef } : { bindAs?: never })
}[CommandName];

/** A UI surface a renderer step reveals. Carries the ids the surface needs. */
export type RevealTarget =
  | { surface: 'description'; nodeId: NodeId }
  | { surface: 'viewToolbar'; nodeId: NodeId; visualRowId: NodeId }
  | { surface: 'viewSection'; nodeId: NodeId; section: ViewSection };

export type ViewSection = 'filter' | 'sort' | 'group' | 'display';

export type AppSurface = 'mainWindow' | 'settings';

/** The object staged into the agent composer by `sendToAgent`. */
export type ComposerObject =
  | { kind: 'node'; nodeId: NodeId; title: string }
  // A page is not a document node, so it is staged as one UNTRUSTED context
  // entry — the only kind a renderer may author — rather than a reference.
  // Main resolves the value; the renderer never reads the captured context.
  | { kind: 'externalPage'; contextId: string; label: string; value: string };

export type EffectStep =
  | CommandStep
  // `Bound<NodeId>` wherever a consumer legitimately reads a previous step's
  // result — including `navigate.nodeId`, without which `open` on the Today
  // object is inexpressible.
  | { on: 'mainRenderer'; kind: 'navigate'; nodeId: Bound<NodeId>; inPlace: boolean }
  | { on: 'mainRenderer'; kind: 'reveal'; target: RevealTarget }
  | {
    on: 'mainRenderer';
    kind: 'workspace';
    op: 'pin' | 'unpin' | 'openSplitPane';
    nodeId: Bound<NodeId>;
  }
  // BrowserWindow lifecycle belongs to the native host and still works when the
  // main renderer does not exist.
  | { on: 'main'; kind: 'activateAppSurface'; surface: AppSurface }
  // Main already owns the projection, so it resolves the bounded string and
  // writes it itself: the locked-down launcher cannot read the document, and no
  // read-back IPC is added for something main already has.
  | { on: 'main'; kind: 'clipboard'; text: string }
  | {
    on: 'mainRenderer';
    kind: 'composerHandoff';
    object: ComposerObject;
    draftText: string;
  };

export interface ActionEffectPlan {
  /** In order; a failed step stops the plan. */
  steps: readonly EffectStep[];
  /** D9 focus policy, per action. */
  completion: 'restoreInvoker' | 'stayAtDestination';
}

/**
 * Read a producer's bindable value out of a real `CommandResult` by following
 * the descriptor path, so no executor hand-writes a `focus.nodeId` special case.
 */
export function readBoundValue(
  command: BindableCommand,
  field: BindableField,
  result: unknown,
): NodeId | null {
  const path = ACTION_BINDINGS.produces[command][field] as readonly string[];
  let current: unknown = result;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current ? current : null;
}

export function commandProducesBinding(command: string): command is BindableCommand {
  return Object.prototype.hasOwnProperty.call(ACTION_BINDINGS.produces, command);
}

/** The exact arg paths of `command` that may hold a step reference. */
export function consumerPathsFor(command: string): readonly (readonly string[])[] {
  const consumes = ACTION_BINDINGS.consumes as Record<string, readonly (readonly string[])[]>;
  return Object.prototype.hasOwnProperty.call(consumes, command) ? consumes[command]! : [];
}
