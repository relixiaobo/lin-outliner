---
status: done
priority: P1
owner: codex-3
created: 2026-06-12
updated: 2026-06-12
---

# Security Settings IA Redesign — one honest trust model

**Shape: (a) ONE complete feature in one PR.** The core decision-model
extraction, the renderer rebuild, the i18n, the spec sync, and the tests ship
together. Landing only the extracted model, or only the UI, would leave the
security surface in a split state — and the load-bearing reason for the change
is a correctness defect, which a half-slice cannot honestly fix.

This redesigns the **Settings → Security** page. It does **not** change the
runtime permission *decision* (that is already correct); it makes the page tell
the truth about that decision and gives the three overlapping controls one
coherent model.

## Background — why this exists

The shipped Security page (from the `agent-permission-safety-modes` plan, #193)
presents three controls that all govern overlapping actions but are drawn as
unrelated blocks, with no expressed precedence:

1. **Trust Level** — a 3-way segmented control writing `agent.safetyMode`
   (`AgentSettingsView.tsx:1111`): `ask_first` / `balanced` / `full_access`.
2. **Granted Trust** — a list of accumulated `allow` rules
   (`actionTrustGrants`), revocable back to `ask` (`AgentSettingsView.tsx:606`).
3. **Advanced** — a fixed list of per-action dropdowns (`COMMON_PERMISSION_RULES`,
   `AgentSettingsView.tsx:202-217`) whose displayed value comes from
   `permissionDecision()` (`AgentSettingsView.tsx:590-595`).

Two defects fall out of this:

- **The page displays a value that contradicts the effective runtime decision
  (correctness bug, the load-bearing reason).** `permissionDecision()` reads
  only the explicit `permissions.allow/deny` overrides and otherwise returns the
  literal string `'ask'` — it never consults `safetyMode`. But the runtime
  (`agentPermissions.ts` `evaluateAgentToolPermission` →
  `safetyModeDecisionForDescriptor:449-460`) resolves an unset action under
  **Full Access** to `allow` for every kind in `FULL_ACCESS_ALLOW_ACTIONS`
  (`agentPermissions.ts:410-422` — includes `web.fetch`,
  `file.delete.allowed_file_area`, `shell.project_script`,
  `shell.dependency_install`, `git.publish_remote`, …). So with Full Access
  selected, the page shows "Fetch web pages / Delete local files / Run project
  scripts → **Ask first**" while the agent will actually run them **without
  asking**. On a security surface, displayed ≠ effective is the worst failure.

- **The implicit custom level is unrepresented (the IA incoherence the PM
  flagged).** The Advanced overrides are an independent layer that, in the
  runtime, takes precedence *over* the mode (`agentPermissions.ts:308-359`:
  configured allow/ask/deny resolve before the safety-mode fallback). The moment
  a user edits one row, the real posture is "preset **plus** arbitrary
  per-action deltas" — a de-facto custom level — yet the segmented control still
  shows a pristine preset and nothing names or surfaces the deviation.

The runtime precedence is already sound: **platform hard redline > explicit
exception (grant/override) > mode default**. The fix is therefore almost
entirely presentation + a shared model so the page mirrors that order instead of
inventing a contradictory one.

## Goal

One coherent mental model on the Security page: **a global mode is the living
default; explicit exceptions are visible deltas layered on it; any deviation is
a named "Custom" state.** Concretely:

1. **The page never shows a decision that differs from what the runtime will
   do.** Every per-action row shows its *effective* decision = `explicit
   override ?? mode-default-for-this-action`.
2. **The 3-way mode stays the primary control and a *living* default** — newly
   added action kinds inherit the current mode automatically (not frozen into a
   snapshot table).
3. **Editing any action surfaces an explicit, revertible exception** shown as a
   delta against the mode, and flips the header to **"Custom · based on
   `<mode>` · N changed"** with a one-click **Reset to `<mode>`**.
4. **Granted Trust and manual Advanced overrides become one concept** — a single
   "Exceptions to `<mode>`" list (union of `permissions.allow/deny`), each item
   showing the action, its decision, and its source (you set it / granted from a
   prompt), each revertible.
5. **One shared decision model** in `src/core/` is the single source for both the
   runtime evaluator and the settings display, so they can never drift again
   (A4/A7).

## Non-goals

- **No change to the runtime decision or its precedence.** Hard redlines,
  `configured_deny` wins, restricted-delegation sandbox, platform hard blocks —
  all unchanged. We mirror the existing order, we do not re-rank it.
- **No relaxing of Electron/process security** (A3): CSP, navigation policy,
  OS-permission allow-lists, `userData` isolation, secret storage all untouched.
- **No new persisted "Custom" enum.** "Custom" is *derived* (any override
  deviates from the mode), never a fourth stored mode value. The persisted shape
  stays `safetyMode` + `permissions.allow/deny` exactly as today.
- **No per-workspace trust storage** — the product still has no user-visible
  folder handoff (carried from #193's non-goals).
- **No migration / back-compat.** Pre-release: settings normalize-or-default at
  read; if the persisted shape needs adjusting, wipe `~/.lin-outliner-*` dev
  userData rather than ship a reader.
- **Not a redesign of the interrupt approval card itself.** This plan only makes
  the *settings page* honest and coherent; the card is referenced as the place
  most exceptions are *born* but its own UI is out of scope.

## Design

### Foundation first (A7): one pure decision model in core

Extract the pure decision tables out of `src/main/agentPermissions.ts` into a new
**`src/core/agentPermissionModel.ts`** (no `node:*`, no main-only imports — the
path-classification and skill-target resolution stay in main):

- the per-action-kind routine `defaultDecision` table,
- `ASK_FIRST_ASK_ACTIONS` / `FULL_ACCESS_ALLOW_ACTIONS`,
- a single pure function:

  ```ts
  // The ONE place mode + overrides → decision is computed.
  // Used by BOTH the runtime evaluator and the settings page.
  function effectiveActionDecision(
    actionKind: AgentToolActionKind,
    mode: AgentSafetyMode,
    overrides: { allow: string[]; ask?: string[]; deny: string[] },
    actionDefault?: 'allow' | 'ask' | 'deny',
  ): 'allow' | 'ask' | 'deny'
  ```

The runtime's `safetyModeDecisionForDescriptor` is refactored to call this same
function (it already lives one layer below `evaluateAgentToolPermission`, which
keeps owning hard-redline / restricted / configured-deny precedence). The
renderer imports the pure model directly (core is import-safe from the renderer),
so the page computes *exactly* what the runtime will compute. This is the
structural fix that makes the correctness bug unrepresentable, not just patched.

> Note: `effectiveActionDecision` answers the *mode+override* layer only. The
> page should label its rows as the default-posture decision and keep the
> existing hard-redline copy where a redline can still override at call time
> (e.g. deleting outside an obvious project path), so the page never implies a
> redline can be waived from settings.

### The page model

**Trust Level (unchanged control, clarified copy).** Still the 3-way
`ask_first` / `balanced` / `full_access`; still the primary control 90% of users
ever touch. Header gains the derived state: when no override deviates, it reads
the plain mode; when any does, it reads **"Custom · based on `<mode>` · N
changed"** with **Reset to `<mode>`** (clears all `permissions.allow/deny`).

**Exceptions to `<mode>` (replaces today's split "Granted Trust" + "Advanced").**
One list = the union of `permissions.allow` and `permissions.deny`, rendered as
rows that each show: the action label, its **effective** decision, a **"modified"
marker** when it deviates from the mode default, and a source tag (manually set
vs granted from a prompt — derivable from rule provenance if available, else
omit the tag rather than guess). Each row reverts to the mode default. A
collapsed **"Add an exception"** affordance exposes the full
`COMMON_PERMISSION_RULES` catalog for power users who want to pre-set an
exception without waiting to be prompted; an action at its mode default is not a
stored override (so the list stays the *deltas*, not the whole matrix).

**Effective-value rendering (the bug fix).** Every action row's displayed
decision is `effectiveActionDecision(kind, mode, overrides)`. Switching the mode
re-derives every non-overridden row live; overridden rows keep their explicit
value and stay marked "modified". This single change removes the
"Full Access but shows Ask first" contradiction.

### Precedence, shown the way the runtime ranks it

The page states the order once, matching the runtime
(`agentPermissions.ts:293-359`): **hard redline (never waivable) → your
exceptions → the `<mode>` default.** No control implies it can override a hard
redline; the redline copy stays attached to the relevant rows.

### Persistence & derivation (no new state)

- Stored: `agent.safetyMode` + `permissions: { allow: string[]; deny: string[] }`
  — unchanged shape.
- Derived (never stored): a row's effective decision; the "modified" marker; the
  "Custom" header state; the exceptions list (= overrides whose decision differs
  from the mode default for that action).
- "Reset to `<mode>`" = clear `allow`/`deny`. "Revert this exception" = remove
  that one rule.

## Files

Expected touch set:

- `src/core/agentPermissionModel.ts` (new) — pure decision tables +
  `effectiveActionDecision`, the single source.
- `src/core/types.ts` — only if an action-kind/list type needs to move to core
  alongside the model (coordinate; it is a protocol-surface file).
- `src/main/agentPermissions.ts` — refactor `safetyModeDecisionForDescriptor` and
  the action-set constants to delegate to the core model; behavior identical
  (guarded by existing permission tests).
- `src/renderer/ui/agent/AgentSettingsView.tsx` — rebuild the Security section:
  effective-value rows, merged Exceptions list, Custom header + Reset, replace
  `permissionDecision()` (`:590-595`) with the core `effectiveActionDecision`.
- `src/core/i18n/messages/en.ts` + `zh-Hans.ts` — `settings.permissions.*` copy:
  Custom/based-on/reset/modified/exception/source labels; clarified Trust Level
  hint; the precedence one-liner.
- `docs/spec/agent-tool-permissions.md` — sync the page model, the precedence
  order, and the "effective decision = override ?? mode default" rule (A6).
- `tests/core/*` — `effectiveActionDecision` truth table across the 3 modes ×
  every action kind, incl. the regression cases (Full Access → web.fetch/delete/
  project-script resolve `allow`; the page must show `allow`); runtime parity
  test that the refactored evaluator returns identical decisions to before.
- `tests/renderer/*` — Security view shows effective values per mode, Custom
  header appears on deviation, Reset clears, exceptions list unifies grants +
  manual overrides, revert works.

## Risks

- **Refactor changing a real decision.** Moving the tables to core must be
  behavior-preserving. Mitigation: a parity test asserting
  `evaluateAgentToolPermission` returns byte-identical decisions for a matrix of
  (tool, args, mode, overrides) before/after; keep the extraction a pure move.
- **Renderer importing the wrong layer.** Only the *pure* model goes to core;
  path classification, sensitive-path detection, and skill-target resolution
  stay in main (they use `node:path`/`os`). Mitigation: the new core file has no
  `node:*` import; a lint/test guards it.
- **"Source" tag over-claiming.** If rule provenance (manual vs prompt-granted)
  isn't reliably stored, do not fabricate it — omit the tag rather than mislabel
  on a security surface.
- **Scope creep into the interrupt card.** The card is where exceptions are
  born; it is explicitly out of scope. Keep the PR to the settings page + shared
  model.
- **Copy that implies redlines are waivable.** The precedence line and per-row
  redline copy must make clear a hard redline is never settable here.

## Collision Check

- `gh pr list` (2026-06-12): only **#214** (`codex-2/skillify-built-in-path`)
  open; its files do not touch `agentPermissions.ts`, `AgentSettingsView.tsx`,
  the i18n bundles, or `types.ts`. No overlap.
- `docs/TASKS.md` shows no active claim on the Security settings surface; the
  `agent-permission-safety-modes` plan that built it is archived `done`.
- `src/core/types.ts` is a protocol-surface / infrastructure-ownership file —
  if the action-kind type must move to core, land that as a coordinated change
  (interface-first) rather than a drive-by; most of the work needs no
  `types.ts` edit.

## Validation

- `bun run typecheck`.
- `bun run test:core` (incl. the new `effectiveActionDecision` truth table + the
  evaluator parity test) and `bun run test:renderer`.
- **Review gate: `/security-review`** in addition to the standard gate — this
  diff touches agent permission semantics (per AGENTS.md review-gate table).
- **Visual verification (light + dark)** of the rebuilt Security page (B-series),
  per the headless emulateMedia technique, including the Custom header state.

## Open Questions

- **Switching mode while exceptions exist:** keep the exceptions as deltas (the
  recommended, honest behavior — they stay visible and marked), or prompt
  "keep / reset to `<mode>`" on switch? Default: keep + mark, with Reset always
  one click away.
- **Does "Add an exception" expose the full action catalog, or only the
  high-consequence subset?** Default: the existing `COMMON_PERMISSION_RULES`
  catalog (it is already the curated, user-legible subset), behind a disclosure.
- **Source tags (manual vs prompt-granted):** ship them only if provenance is
  already stored; otherwise defer the tag to a follow-up rather than guess.
- **Rename "Trust Level / Global trust / Granted Trust":** the word "trust"
  currently means three different scopes. Worth collapsing to "Mode" +
  "Exceptions"? Directional — for PM.
