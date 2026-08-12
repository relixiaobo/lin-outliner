# Semantic Working-State Shimmer

## Goal

Replace rotating glyphs that currently mean "work is advancing" with a quiet,
cadenced text shimmer, while preserving ordinary spinners for indeterminate
resource loading. The result should make Agent activity easier to scan:

- the icon continues to identify the tool, Skill, Plan, or Subagent;
- the action text says what is happening and carries the working motion;
- every working state remains identifiable when animation is disabled;
- waiting, terminal, recovery, and data-loading states remain visually distinct;
- one hierarchy does not animate both its summary and its expanded child for the
  same work.

This is shape **(b): a set of two independent complete features**:

1. **Thread working states:** add the shared primitive and adopt it across
   Thinking, Turn, tool/group, Subagent, and Plan surfaces. This is a complete
   Thread experience with its own specs, tests, and visual evidence.
2. **Settings working states:** adopt the landed primitive across Provider and
   managed-Skill actions, including truthful progressive copy. This is a
   complete Settings experience with its own specs, tests, and visual evidence.

The Settings feature depends only on the public renderer primitive from the
Thread feature and lands after it. Neither PR is scaffolding for a later feature,
and each is independently user-visible and verifiable. No protocol or
persistence work is required.

The reference behavior was inspected in the locally installed Codex desktop app
(`com.openai.codex`, version `26.727.51351`). This plan records the observed
behavioral and timing facts needed by Tenon; it does not reproduce the
commercial production bundle.

## Non-goals

- Do not replace every `LoaderIcon`. Spinner, skeleton, and reserved loading
  states remain correct when data or media is not ready and there is no
  meaningful action phrase.
- Do not shimmer a state that is blocked on the user, an external authorization
  step, a retry backoff, or a disconnected dependency. Motion must not claim
  progress that is not happening.
- Do not change completed, failed, interrupted, success, or error treatments.
- Do not animate streamed reasoning content after it contains readable text;
  only the empty live `Thinking` label is a working state.
- Do not change the assistant response streaming rose, Thread-list activity
  dots, search refresh, file translation, Add to Today, copy-key, or other
  icon-only progress controls.
- Do not add renderer-driven theme state, raw UI colors outside token
  declarations, a gradient page background, or a shimmer feature flag.
- Do not copy Codex component architecture. Its inspected behavior is evidence;
  Tenon keeps its own primitives, token system, and accessibility rules.

## Design

### Two meanings, two indicators

The existing single `Loading` state in the design system splits into two
observable meanings:

| State family | Meaning | Indicator | Examples |
| --- | --- | --- | --- |
| Working | Tenon is actively advancing a named action | stable identity/status cue plus cadenced `WorkingText` | Thinking, running a command, an active Subagent, installing a Skill |
| Loading | data or media is not ready and no useful action-level progress exists | reserved spinner or skeleton | initial Thread details, Skill catalog, search results, file preview |
| Waiting / blocked | progress requires a person or external event | static status text and the existing response affordance | `waitingOnUserInput`, OAuth authorization wait |
| Recovery | Tenon is retrying a failed dependency | existing retry indicator and attempt copy | provider reconnect/backoff |
| Terminal | the action settled | existing identity/status glyph and static copy | completed, failed, interrupted |

The load-bearing rules are:

- **BR-1:** `WorkingText` is used only while an action is genuinely advancing.
- **BR-2:** a working tool, Plan, Skill, or Subagent retains its semantic glyph;
  a loader never substitutes for identity.
- **BR-3:** motion is never the only in-progress cue. Most readable bases use
  progressive wording. Every in-progress tool action also uses
  `--text-strong` through the existing `thread-tool-inProgress` row class, so a
  model-authored command description remains exact but stays visually distinct
  when motion is disabled without changing glyph metrics as it settles. A
  current Plan step keeps strong text plus a neutral filled dot and
  `aria-current="step"`.
- **BR-4:** motion is cadenced: the first sweep starts after `600ms`, crosses
  the text smoothly in `1s`, then rests; a new sweep begins every `4s`.
- **BR-5:** only the most specific eligible expanded representation of one
  action shimmers. "Visible" means mounted because its disclosure is expanded,
  not merely inside the viewport. A collapsed summary may shimmer; expanding
  it either transfers ownership to an eligible live child in the same render or
  stops motion when the child has sufficient static cues. The open Plan current
  step is the explicit static exception. No `IntersectionObserver` is
  introduced. Genuinely concurrent leaf actions may each shimmer.
- **BR-6:** `prefers-reduced-motion: reduce` and
  `prefers-contrast: more` disable the visual sweep. The static cues in BR-3
  and each surface's progressive wording remain visible.
- **BR-7:** the visual duplicate is `aria-hidden`; the base text remains the
  one accessible name and live-region payload.
- **BR-8:** the overlay is absolute and pointer-inert, so the sweep layer itself
  never changes measured width, row height, focus, or hit targets. A truncated
  visual duplicate uses the same width, white-space, overflow, and ellipsis
  rules as the base text, so the sweep cannot reveal different tail glyphs.
  Working/terminal state changes do not change action weight; row width,
  truncation, controls, and hit targets therefore stay metric-stable.

### Codex behavior evidence

The inspected production bundle contains a continuous implementation and a
cadenced implementation:

| Evidence | Observed fact | Tenon decision |
| --- | --- | --- |
| Continuous variant | a text-clipped gradient moves continuously for `2s` with `steps(48, end)`; reduced motion disables it | Reject its continuous cadence because several concurrent tools or Subagents would create constant motion |
| Cadenced timing | first activation after `600ms`, active for `1s`, repeated every `4s` | Adopt these tokenized values without a feature flag |
| Cadenced structure | normal readable text remains in place while an `aria-hidden` duplicate supplies the sweep | Adopt the accessibility and geometry split through `WorkingText` |
| Sweep shape | a `0% -> 20%-30% -> 50%` mask window crosses the label while paired layers translate in opposite directions; the observed endpoints are `-50% -> 125%` and `50% -> -125%` | Preserve the narrow crossing band, but implement it as a paint-contained, background-clipped text gradient because Tenon's translucent Agent Deck is already a composited material surface |
| Cadenced stepping | 48 stepped positions occur during the active interval | Do not copy the stepped easing: at Tenon's smaller meta text it reads as flicker. A `4s` CSS cycle moves smoothly during its first 25% and holds for the remaining `3s` |
| Consumer split | identity remains static while action metadata such as `Thinking`, running tool text, and an Agent's `is working` status carries motion | Adopt this identity/action split across the mapped Tenon consumers |

CSS owns cadence rather than a timer per React instance. Mounting and unmounting
therefore starts and stops the effect, while media queries cancel motion without
component state. The values are tokens, so later tuning is a token edit rather
than an experiment branch.

### `WorkingText` primitive

Add `src/renderer/ui/primitives/WorkingText.tsx` with a deliberately narrow
contract: one text string, an optional `truncate` mode, an optional contextual
class, and ordinary span attributes. It renders:

- one normal base text layer, which alone participates in accessibility;
- one absolute `aria-hidden` sweep layer containing a visual text copy;
- no IDs, controls, or interactive descendants in the duplicate.

Add `src/renderer/styles/working-text.css` and import it once from
`src/renderer/styles/index.css`. The root preserves the consumer's
`currentColor`. The sweep copy uses a dedicated
`--working-text-highlight` alpha-on-ink token declared in `tokens.css`
instead of relying on current-color overdraw, whose strength changes with every
consumer's base alpha. Restrict its animated resting-color range to
`--text-tertiary` through `--text-soft` and start the token at
`rgb(var(--ink) / 0.68)`. Overdraw composes those endpoints from `0.30` to
approximately `0.776` and from `0.55` to approximately `0.856`; both remain
visible without the earlier high-contrast flash, while the
`--text-strong` Plan current step is deliberately static rather than asking one
token to cover its much smaller delta. Light/dark evidence validates the two
remaining animated endpoints before the Thread PR is ready.

When `truncate` is true, both internal text layers share one truncation class:
`width: 100%`, `overflow: hidden`, `text-overflow: ellipsis`, and
`white-space: nowrap`. The absolute sweep remains clipped to the same root
width. This prevents a narrow base label ending in an ellipsis while the moving
copy exposes hard-clipped source characters.

One four-second keyframe cycle performs the one-second sweep in its first
quarter and holds the terminal background position for the remaining three
seconds. A tokenized `600ms` initial delay matches the observed behavior. The
duplicate clips a narrow gradient to its glyphs and animates only
`background-position` inside a `contain: paint` root. It uses no transform,
mask, or persistent `will-change`, so the Agent Deck's composited translucent
material cannot become the sweep's animation layer.

Retire the Thread-only spinner uses of `--motion-working-cycle` and redefine
the working motion tokens for cadence and initial delay. Timing literals outside
`tokens.css` continue to satisfy the motion-token guard. Both reduced-motion
and increased-contrast media queries hide the sweep layer rather than merely
pausing it over the start of the label.

### Thread and Plan surfaces

This surface belongs to the first implementation PR.

| Surface / symbol | Current | New behavior |
| --- | --- | --- |
| `ThreadProcessBlock` | A live, non-collapsible Turn shows its summary plus `thread-process-spinner`; the completed collapsible branch is already static; `blockedOnUser` already suppresses the spinner | Remove the live spinner. Shimmer the live summary only when no expanded live leaf either owns the working cue or statically suppresses it per BR-5. Give live elapsed labels a full-width slot and tabular numerals so second updates do not change visible geometry. Keep completed collapsible summaries and user-blocked summaries static; do not add motion to either branch. |
| `ReasoningDisclosure` | An empty live Item shows static `Thinking`; the Turn spinner supplies motion | Wrap only the empty live `Thinking` label in `WorkingText`. Populated reasoning stays readable and static while it streams. |
| `executionStatusNode` / `ToolItemDisclosure` | `inProgress` replaces the tool glyph with `LoaderIcon` | Always return the tool glyph. Shimmer only the neutral action segment of an in-progress row and apply `--text-strong` without changing its 400 weight; failure/interruption tallies remain static. A command with `item.description` keeps that exact sentence in every status rather than routing it through command-oriented i18n. |
| `ThreadToolActivityGroup` | A running group spins its group glyph | A collapsed running group shimmers its neutral action segment. When expanded in the DOM, its summary is static and each in-progress member shimmers instead. Finished members never inherit motion. Collapsing or expanding mid-run transfers ownership without a frame where both levels animate. |
| `SubagentActivityItem` | Running status appends a loader to the `.thread-delegation-row` | Keep the form/Agent glyph and name static; shimmer only the running status phrase. Its lifecycle line reserves the available width, the disclosure consumes the flexible slot, elapsed numerals are tabular, and Stop remains a separate fixed-size action at the stable row edge. |
| `SubagentStateItem` | An expanded collaboration tool detail shows static Agent identity and status text | Include this surface: keep `AgentIcon` and identity static and shimmer only a running status phrase. Because it is mounted only inside the expanded tool detail, the collapsed parent summary owns motion and the expanded child status owns it after transfer. |
| `ThreadPlanProgress` | The summary and current checklist step spin; the step also already has strong text while pending steps use a hollow dot | Use the existing `PlanToolIcon` as the stable summary glyph. When closed, shimmer the current-step summary. When open, freeze the summary and keep the current checklist step fully static: replace its loader with a neutral filled dot in the existing fixed status slot, retain strong text and 600 weight, and add `aria-current="step"`. Completed steps keep `CheckIcon`; pending steps keep their static hollow dot. |

The existing Turn/process projection remains authoritative. Working-state
selection is renderer presentation derived from existing `Turn.status`,
`waitingOnUserInput`, Item execution statuses, disclosure state, and Subagent
projection. It adds no state model and changes no `src/core/agent/protocol.ts`
contract.

The most-specific-expanded rule is evaluated from existing `expanded` /
`open` component state. It does not react to scrolling or clipping. An eligible
child that is mounted by an open disclosure owns the motion even when scrolled
outside the viewport; the static Plan step suppresses its parent without taking
motion ownership. Viewport observation would add invisible work and unstable
motion handoffs without improving comprehension.

### Provider and managed-Skill surfaces

This surface belongs to the second implementation PR and uses the primitive
landed by the Thread feature.

Eligible settings operations already expose a truthful progressive verb:

- `ProviderConfigForm`: `Validating...` in the cancellable result row and
  `Saving...` in the Save button.
- `ManagedSkillsSettings`: `Resolving...`, `Installing...`, and
  `Applying...`.
- managed-Skill destructive/reversal confirmations after adding explicit
  `Uninstalling...` and `Rolling back...` messages in English and Simplified
  Chinese.

These phrases use `WorkingText`, so their static base copy remains an
in-progress cue when motion is disabled. Buttons keep the icon for the command
they are performing (`AddIcon`, `RefreshIcon`, `TrashIcon`, or `UndoIcon`)
instead of changing to `LoaderIcon`. Provider validation has one animated
owner: the cancellable result row; the disabled Validate button repeats the
current label statically so the same operation does not shimmer twice.

### Explicit retained matrix

The following stay outside `WorkingText` in both PRs:

- `ThreadProviderRetryStatus`: reconnect/backoff is recovery, not normal work.
  It stays spinner-led in the owning Turn's response footer, replacing that
  Turn's rose generating indicator rather than appearing as a second row below
  it. While recovery is visible, it also suppresses that Turn's decorative text
  sweeps so the retry spinner is the sole motion owner.
- `ProviderOAuthForm`'s fallback `Waiting for authorization...`: it is
  blocked on a browser/person. The current `flow.progress` contract does not
  distinguish active token exchange from external waiting, so the entire row
  stays on the existing treatment rather than guessing.
- `ThreadTurnDetailsPanel`, managed-Skill catalog/library initial reads,
  `OutlinerEmptyState` search loading, and preview renderers: resource loading.
- `ToolFileResult`, search refresh, API-key copy, and file-translation start:
  icon-only commands with no stable visible text target.
- Assistant response streaming, Thread-list activity dots, completed
  collapsible Turn summaries, and user-blocked Turn summaries: their existing
  surface-specific treatment remains authoritative.
- Every completed, failed, interrupted, success, and error row: terminal status
  remains static.

### Implementation boundaries

#### PR1: Thread working states

Expected product files:

- new `src/renderer/ui/primitives/WorkingText.tsx`
- new `src/renderer/styles/working-text.css`
- `src/renderer/styles/index.css`
- `src/renderer/styles/tokens.css`
- `src/renderer/styles/thread.css`
- `src/renderer/agent/components/ThreadView.tsx`
- `src/renderer/agent/components/items/ThreadItemView.tsx`

Current-intended spec updates:

- `docs/spec/design-system/patterns.md`: split Working from Loading and record
  cadence, static fallbacks, identity retention, expanded-hierarchy ownership,
  truncation parity, and motion preferences.
- `docs/spec/design-system/components.md`: update compact
  activity/disclosure rows and Plan progress from spinner-owned state to
  text-owned working state.
- `docs/spec/agent-thread-rendering.md`: replace every claim that the spinner
  is the running state; describe tool, group, Thinking, Turn, Plan, and both
  Subagent status surfaces.

No dependency, i18n, preload, main-process, IPC, command, core protocol,
persistence, or userData file changes are expected.

#### PR2: Settings working states

Expected product files:

- `src/renderer/ui/agent/ManagedSkillsSettings.tsx`
- `src/renderer/ui/agent/ProviderConfigForm.tsx`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`

Current-intended spec updates:

- `docs/spec/design-system/surfaces.md`: record provider validation's
  text-led working state and single animated owner.
- `docs/spec/agent-skills.md`: record stable action icons plus progressive
  working copy for managed mutations.

The PR consumes `WorkingText` without changing its contract or shared CSS.
No dependency, Thread, preload, main-process, IPC, command, core protocol,
persistence, or userData file changes are expected.

`LoaderIcon` remains exported and used by Loading and Recovery consumers
outside both PRs.

### Acceptance and verification

#### PR1 acceptance

- **AC-1:** While a tool is in progress, its original tool glyph remains
  visible and only its neutral action phrase uses `WorkingText`.
- **AC-2:** A command with a caller description renders that exact sentence in
  every status. While it is running, its neutral action uses `--text-strong`
  without changing weight; reduced motion and increased contrast remove the
  sweep without removing that static cue or shifting text metrics.
- **AC-3:** While empty reasoning is streaming, `Thinking` shimmers; when the
  first readable reasoning text arrives, that text renders normally without a
  geometry swap on the container.
- **AC-4:** `SubagentActivityItem` and `SubagentStateItem` keep identity
  static and mark only a running status phrase as working. Stop remains
  available on the lifecycle row and does not move when elapsed copy crosses a
  digit or unit boundary.
- **AC-5:** A collapsed running group shimmers only its summary. Expanding it
  mid-run freezes the summary and starts only its running members; collapsing
  reverses ownership without simultaneous parent/child motion.
- **AC-6:** A closed Plan shimmers only its summary. Opening it mid-run stops
  all Plan motion; the current step remains identifiable by its neutral filled
  dot, strong text, 600 weight, and `aria-current="step"`. Collapsing resumes
  only the summary shimmer, and completion removes it.
- **AC-7:** If a Turn is waiting on user input, failed, interrupted, complete,
  or represented by its completed collapsible summary, it contains no
  `WorkingText` and announces its existing static status.
- **AC-8:** A `WorkingText` instance exposes its text once to accessibility
  APIs; the visual duplicate is `aria-hidden` and pointer-inert.
- **AC-9:** Under reduced motion or increased contrast, the overlay is absent
  and every mapped row remains distinguishable as working through progressive
  copy, the in-progress tool-action colour, or the Plan's static current-step
  cues.
- **AC-10:** With a narrow long English or Chinese label, the base and visual
  copy have the same rendered width, white-space, overflow, ellipsis, and final
  visible glyph. Row height, controls, and hit targets do not move when the
  sweep starts or stops. Tool action weight remains 400 across running and
  terminal states, and a live elapsed title occupies a stable full-width slot
  with tabular numerals, so neither transition moves adjacent geometry.
- **AC-11:** In light and dark mode, the tokenized highlight is visible at both
  remaining animated resting-color endpoints, `--text-tertiary` and
  `--text-soft`, without a raw consumer color, brand accent, background fill,
  or loss of the underlying text. The `--text-strong` Plan step has no overlay.
- **AC-12:** Initial data loads, reconnect, OAuth wait, icon-only operations,
  and every terminal surface retain their existing indicator and never receive
  `WorkingText` accidentally. Reconnect renders in its owning Turn's response
  footer and replaces, rather than stacks below, the rose generating indicator;
  any existing decorative text sweep in that Turn pauses until recovery clears.

Focused automated coverage should update or add these test titles:

- `WorkingText renders one accessible text layer and an aria-hidden sweep copy`
- `WorkingText mirrors truncation geometry and ellipsis onto its visual copy`
- `WorkingText uses a cadenced tokenized sweep and becomes static for motion and contrast preferences`
- `WorkingText confines its animation to a paint-contained glyph layer`
- `keeps the tool own glyph in every status and shimmers only the running action`
- `keeps described command copy exact while the running action stays metric-stable`
- `reserves stable live elapsed geometry and one Turn motion owner`
- `projects live and settled Turn process before the final response`
- `hands running group motion between its summary and expanded members`
- `reads Subagent identity statically and marks only live status as working`
- `pins the Subagent Stop action while its elapsed status changes`
- `stops Plan motion when its static current step is expanded and resumes only the collapsed summary`
- `shows Turn-local Plan progress only while the Turn is active`
- `stops working motion while the Turn is blocked on user input`

Run `bun run typecheck`, `bun run test:renderer`, focused
`bun run test:e2e -- tests/e2e/agent-thread.spec.ts`,
`bun run docs:check`, `bun scripts/design-system-metrics.ts --check`, and
`git diff --check` before marking PR1 ready.

Visual verification uses `bun run dev:codex-4` and records PR-comment evidence
for light and dark Thread/Plan states, a narrow pane, at least two concurrent
Subagents, group and Plan expansion/collapse during active work, reduced motion,
and increased contrast. Evidence must include the `--text-tertiary` and
`--text-soft` animated endpoints, the static open Plan step, a truncated label
during the active sweep, and a tool settling from in-progress to completed on
both a short row and a truncated one.

#### PR2 acceptance

- **AC-13:** Managed-Skill install/update/uninstall/rollback and provider
  validation/save show progressive base copy, retain their action glyph where
  one exists, and settle to the existing success/error state.
- **AC-14:** Provider validation has exactly one animated owner in its result
  row; the disabled Validate button repeats the progressive label statically.
- **AC-15:** Reduced motion and increased contrast leave every progressive
  Settings phrase readable and static.
- **AC-16:** OAuth wait, Provider recovery, initial catalog/library loading, and
  icon-only Settings operations retain their existing non-working treatment.

Focused automated coverage should update or add these test titles:

- `validates a key asynchronously with one working owner and never saves on validate`
- `keeps managed Skill action glyphs stable while progress copy is working`
- `uses progressive uninstall and rollback copy while the mutation is pending`
- `keeps waiting recovery and resource loading outside WorkingText`

Run `bun run typecheck`, `bun run test:renderer`, focused
`bun run test:e2e -- tests/e2e/agent-settings.spec.ts`,
`bun run docs:check`, `bun scripts/design-system-metrics.ts --check`, and
`git diff --check` before marking PR2 ready.

Visual verification uses the landed PR1 primitive and records light/dark
Provider and managed-Skill operations, reduced motion, increased contrast, long
English and Chinese copy, success, and error settlement. Evidence uploads for
both PRs use GitHub's comment CDN rather than a side-branch asset URL.

### Collision check

- The initial GitHub and `docs/TASKS.md` check found no pre-existing PR claim
  or active plan for shimmer or semantic working-state motion. Draft PR #529 is
  now the plan-surface claim.
- Draft PR #530 owns the typing hot path, main-process document service, and
  Memory extension/index modules. It does not overlap either implementation
  unit in this plan.
- `icon-semantics` may later edit glyph mappings, but this plan adds no icon
  alias and reuses the existing `PlanToolIcon`, tool glyph resolver, and
  managed action glyphs. There is no shared implementation decision.
- PR1 owns renderer Thread components, shared working-text styles, and Thread
  specs. PR2 owns Settings components, progressive i18n copy, and Settings
  specs. Their only dependency is the landed `WorkingText` contract, so their
  implementation file scopes do not overlap.
- No infrastructure-ownership file is touched. Re-run `gh pr list`, the board
  scan, and each intended file-scope comparison immediately before opening its
  Draft implementation PR.

### Risks

- **Motion multiplies under concurrency.** Cadence alone is not sufficient if a
  parent and child both animate the same fact. BR-5 makes DOM expansion the
  deterministic handoff and permits multiple motion only for genuinely
  concurrent leaf actions.
- **The duplicate can disagree with truncated text.** `truncate` gives the
  accessible base and visual copy the same width and ellipsis contract. Focused
  DOM and narrow-pane sweep evidence verify glyph parity as well as geometry.
- **Accessible text can be announced twice.** The base string is the only normal
  text layer; the entire sweep subtree is `aria-hidden`. Live regions continue
  to announce state changes through the base string.
- **Continuous animation would look busy and consume more paint.** The selected
  cadence moves for one quarter of each cycle, confines background paint to the
  text bounds, and creates no React interval per row. Transform and mask
  animation is deliberately excluded because it can invalidate the translucent
  Agent Deck's compositor surface.
- **Sweep strength can drift across base text alphas.** A dedicated
  alpha-on-ink highlight token replaces current-color doubling, and the
  `--text-strong` Plan step is excluded rather than forcing one token across the
  full alpha ladder. The remaining `--text-tertiary` and `--text-soft`
  endpoints are required visual evidence in both themes; increased contrast
  removes the overlay.
- **Settings copy can lie during destructive work.** PR2 adds explicit
  progressive English and Chinese labels before applying shimmer; imperative
  `Uninstall` / `Roll back` never animate as if they were status.
- **Spinner semantics can regress during consumer conversion.** Completion is
  derived from the explicit retained matrix and focused `rg` output, not a
  global `LoaderIcon` replacement. AC-12 and AC-16 freeze the retained
  families.
- **The dependent PRs can drift.** PR2 starts only after PR1 lands and consumes
  the final primitive unchanged; a requested primitive contract change returns
  to PR1 rather than being introduced from Settings.

## Open questions

None. The implementation uses two complete PRs, DOM disclosure expansion as the
parent-motion suppression boundary, a static expanded Plan step, and the
observed `600ms / 1s / 4s` cadence without a feature flag.

## Checklist

### PR1: Thread working states

- [ ] Add the text-only `WorkingText` primitive, truncation mode, shared
      cadenced CSS, highlight token, and preference fallbacks.
- [ ] Replace Thread, Thinking, tool/group, both Subagent surfaces, and Plan
      working spinners according to the most-specific-expanded rule.
- [ ] Preserve command descriptions exactly; add metric-stable in-progress
      tool colour and static current Plan-step cues.
- [ ] Leave every Loading, Waiting, Recovery, terminal, and icon-only Thread
      consumer in the explicit retained matrix unchanged.
- [ ] Update the three Thread and design-system spec documents.
- [ ] Add renderer and E2E coverage under the PR1 test titles.
- [ ] Run typecheck, renderer tests, focused Thread E2E, docs check, design
      metrics, and diff checks.
- [ ] Verify all PR1 visual states and attach evidence to the PR by comment
      upload.

### PR2: Settings working states

- [ ] Convert eligible Provider and managed-Skill progressive actions while
      preserving their identity/action glyphs.
- [ ] Add English and Simplified Chinese progressive uninstall/rollback copy.
- [ ] Leave every Loading, Waiting, Recovery, terminal, and icon-only Settings
      consumer in the explicit retained matrix unchanged.
- [ ] Update the two Settings and Skill spec documents.
- [ ] Add renderer and E2E coverage under the PR2 test titles.
- [ ] Run typecheck, renderer tests, focused Settings E2E, docs check, design
      metrics, and diff checks.
- [ ] Verify all PR2 visual states and attach evidence to the PR by comment
      upload.
