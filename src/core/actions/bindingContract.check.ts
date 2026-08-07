// AC-07 — the COMPILE-TIME negative fixture. This file exists to fail.
//
// "The compiler decides whether the contracts hold" is decoration unless
// something proves the compiler actually rejects the shapes the contract
// forbids. Each `@ts-expect-error` below is an assertion in both directions:
// if the error disappears, `tsc --noEmit` fails on the unused suppression.
//
// The counterexamples are chosen deliberately. `create_tag.name` has the SAME
// underlying type as `apply_tag.tagId` (`NodeId` is `string`), and
// `create_capture.input.title` is a sibling of the one permitted nested path —
// a fixture using an unrelated numeric field would have proved nothing.
//
// Not imported by product code; it is checked, not run.

import { stepRef, type CommandStep, type EffectStep } from './bindings';

const REF = stepRef('producer');

// --- POSITIVE: the permitted shapes must compile --------------------------

export const permitted: CommandStep[] = [
  // A bindable command may name its result.
  {
    on: 'main',
    kind: 'command',
    command: 'ensure_date_node',
    args: { year: 2026, month: 8, day: 7 },
    bindAs: REF,
  },
  // Both declared `apply_tag` paths accept a step reference.
  {
    on: 'main',
    kind: 'command',
    command: 'apply_tag',
    args: {
      nodeId: { fromStep: REF, field: 'focusNodeId' },
      tagId: { fromStep: REF, field: 'focusNodeId' },
    },
  },
  // …and so does the NESTED capture destination.
  {
    on: 'main',
    kind: 'command',
    command: 'create_capture',
    args: {
      input: {
        destinationParentId: { fromStep: REF, field: 'focusNodeId' },
        title: { text: 'Note', marks: [], inlineRefs: [] },
      },
    },
  },
];

export const permittedRendererStep: EffectStep = {
  on: 'mainRenderer',
  kind: 'navigate',
  nodeId: { fromStep: REF, field: 'focusNodeId' },
  inPlace: true,
};

// --- NEGATIVE: each of these must FAIL to type-check -----------------------

export const wrongArgsForCommand: CommandStep = {
  on: 'main',
  kind: 'command',
  command: 'batch_trash_nodes',
  // @ts-expect-error — args are correlated WITH the command name; `move_node`'s
  // shape cannot pair with `batch_trash_nodes`.
  args: { nodeId: 'node:1', parentId: 'node:2', index: null },
};

// @ts-expect-error — only commands that declare a bindable result may name one;
// the mismatch surfaces on the whole step because `bindAs?: never` narrows it.
export const bindAsOnNonBindableCommand: CommandStep = {
  on: 'main',
  kind: 'command',
  command: 'batch_trash_nodes',
  args: { nodeIds: ['node:1'] },
  bindAs: REF,
};

export const stepRefInUndeclaredPath: CommandStep = {
  on: 'main',
  kind: 'command',
  command: 'create_tag',
  // @ts-expect-error — `create_tag.name` is a string, not a bindable path.
  args: { name: { fromStep: REF, field: 'focusNodeId' } },
};

export const stepRefInNestedUndeclaredPath: CommandStep = {
  on: 'main',
  kind: 'command',
  command: 'create_capture',
  args: {
    input: {
      destinationParentId: 'node:1',
      // @ts-expect-error — a SIBLING of the one permitted nested path is still
      // not bindable.
      title: { fromStep: REF, field: 'focusNodeId' },
    },
  },
};

export const bindAsOnClipboardStep: EffectStep = {
  on: 'main',
  kind: 'clipboard',
  text: 'hello',
  // @ts-expect-error — a clipboard step cannot pretend to produce a focus node.
  bindAs: REF,
};
