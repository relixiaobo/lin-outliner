# Agent Execution Interaction Consistency

## Goal

Make Agent execution feedback behave as one coherent system. Plan updates are
Turn-local progress rather than conversation history, Run Details navigates in
the current workspace pane, and every ordinary tool uses the same expandable
argument/result interaction with clickable local paths.

## Non-goals

- Do not add a second durable execution projection or encode transient Plan
  state as a canonical Thread Item.
- Do not change tool permissions, trusted roots, attachment authorization, or
  local-file preview security.
- Do not redesign Run Details content, the composer, or the process timeline.
- Do not flatten content-specific affordances such as image previews or child
  Thread links when they supplement the common tool disclosure.

## Shape

This plan is shape (a): one complete feature in one PR. The implementation
settles transient Plan publication first, then updates the workspace and tool
consumers before changing the specifications and tests.

## Collision Result

- `gh pr list` found Draft PR #437, `large-local-resources`, which claims the
  Agent attachment protocol, Thread payload persistence, renderer/preload
  attachment IPC, local tools, and related consumers.
- This change deliberately avoids attachment materialization, preload IPC, and
  local-tool execution. It overlaps #437 locally in
  `src/core/agent/protocol.ts` and may overlap in `ThreadView.tsx`; the clean
  transient Plan contract takes precedence over avoiding a mechanical merge.
  This smaller interaction change should land first and #437 should rebase onto
  the resulting protocol and renderer contracts.
- `docs/TASKS.md` contains no active item for this interaction work.
- This dev PR does not edit main-owned `docs/TASKS.md` or `CHANGELOG.md`.

## Design

### Transient Plan Projection

Keep `update_plan` as a model control tool, but exclude its ordinary tool-call
Item from the persisted Turn. Remove `PlanThreadItem` and its Item-delta/history
paths, then add a structured `turn/plan/updated` notification carrying the
normalized explanation and checklist. The protocol distinguishes transient from
recorded notifications so `turn/plan/updated` cannot be passed to the rollout
writer. `ThreadService` publishes the event only for the active Turn.

The renderer stores the latest snapshot in its existing ephemeral Thread store,
separate from canonical `Turn.items`. Repeated calls replace that snapshot.
`turn/completed`, Thread deletion, and catalog reload clear it; application
restart does not reconstruct it.

The latest Plan appears as compact progress immediately above the composer. Its
hover state previews the complete checklist; activating the summary opens the
same focusable, scrollable checklist, and Escape closes it with focus restored.
A terminal Turn snapshot
contains neither the Plan nor the `update_plan` tool call, so completion,
failure, and interruption all remove the progress UI. Model history and Run
Details consume canonical Items only and therefore have no Plan branch and do
not show `update_plan`.

### Current-pane Run Details

Represent Run Details as a `WorkspaceContentPanelState` view instead of a
standalone tiled panel. Opening Details navigates the active workspace pane in
place, preserving its previous view on the pane history stack. Opening another
Turn while Run Details is active replaces the current details target rather than
adding panes or history noise. Back and close return through the existing pane
navigation contract.

The workspace layout persistence version advances with no legacy reader. Old
development layouts fall back to the default layout, consistent with the
pre-release storage policy. Run Details can no longer fail because the window is
too narrow for another pane.

### Uniform Tool Disclosure

Every ordinary tool Item uses the same expandable row and always exposes its
arguments and result. Remove the loaded-Skill compact-row exception and keep
tool-specific status text, icons, image output, and child-Thread navigation only
as metadata or supplemental content inside that common structure.

Tool argument and result code surfaces share one local-path linker. It recognizes
absolute local paths in JSON or text and relative values in path-bearing JSON
fields, resolving relative paths against the Thread working directory. Clicking
a path uses the existing inline-file preview route; modifier-click retains the
established new-pane behavior. Recognition does not grant filesystem authority:
preview resolution and trusted-file checks remain authoritative in main.

## Open Questions

None. The product behavior and landing order relative to #437 were ratified
before implementation. Private helper names and exact path-token heuristics are
reversible implementation details.

## Verification

- Core tests prove `update_plan` produces transient progress, no persisted tool
  or Plan Item, and no later model-history text.
- Renderer tests prove Run Details replaces the current view, participates in
  Back navigation, and never consumes an additional pane.
- Agent E2E tests cover live Plan progress and terminal removal, uniform Skill
  disclosure, clickable absolute and working-directory-relative tool paths, and
  current-pane Run Details at narrow widths.
- Visual verification covers Agent progress, tool details, and Run Details in
  light and dark themes.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, the
  relevant `bun run test:e2e` scope, `bun run docs:check`, and `git diff --check`.
