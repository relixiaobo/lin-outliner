# Semantic Working-State Shimmer

## Goal

Replace rotating glyphs that currently mean "work is advancing" with a quiet,
cadenced text shimmer, while preserving ordinary spinners for indeterminate
resource loading. The result should make Agent activity easier to scan:

- the icon continues to identify the tool, Skill, Plan, or Subagent;
- the action text says what is happening and carries the working motion;
- waiting, terminal, recovery, and data-loading states remain visually distinct;
- one hierarchy does not animate both its summary and its visible child for the
  same work.

This is shape **(a): one complete feature in one PR**. The shared primitive,
Thread consumers, Plan consumers, eligible settings actions, specs, tests, and
light/dark visual evidence land together. No protocol or persistence work is
required.

The reference behavior was inspected in the locally installed Codex desktop app
(`com.openai.codex`, version `26.727.51351`). The relevant bundle source is
preserved below because the extracted files under
`tmp/research/chatgpt-running-state/` are intentionally gitignored and will not
exist in another clone.

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
- Do not add renderer-driven theme state, raw UI colors, a gradient page
  background, or a feature flag for the shimmer variant.
- Do not copy Codex component architecture wholesale. Its source is behavioral
  evidence; Tenon keeps its own primitives, token system, and accessibility
  rules.

## Design

### Two meanings, two indicators

The existing single `Loading` state in the design system splits into two
observable meanings:

| State family | Meaning | Indicator | Examples |
| --- | --- | --- | --- |
| Working | Tenon is actively advancing a named action | static identity glyph plus cadenced `WorkingText` | Thinking, running a command, an active Subagent, installing a Skill |
| Loading | data or media is not ready and no useful action-level progress exists | reserved spinner or skeleton | initial Thread details, Skill catalog, search results, file preview |
| Waiting / blocked | progress requires a person or external event | static status text and the existing response affordance | `waitingOnUserInput`, OAuth authorization wait |
| Recovery | Tenon is retrying a failed dependency | existing retry indicator and attempt copy | provider reconnect/backoff |
| Terminal | the action settled | existing identity/status glyph and static copy | completed, failed, interrupted |

The load-bearing rules are:

- **BR-1:** `WorkingText` is used only while an action is genuinely advancing.
- **BR-2:** a working tool, Plan, Skill, or Subagent retains its semantic glyph;
  a loader never substitutes for identity.
- **BR-3:** the base text is always present and readable. The sweep is an
  enhancement, never the only state cue.
- **BR-4:** motion is cadenced: the first sweep starts after `600ms`, crosses the
  text in `1s` with 48 stepped positions, then rests; a new sweep begins every
  `4s`.
- **BR-5:** only the most specific visible representation of one action shimmers.
  A collapsed summary may shimmer; when its active child becomes visible, the
  summary becomes static. Genuinely concurrent leaf actions may each shimmer.
- **BR-6:** `prefers-reduced-motion: reduce` and `prefers-contrast: more` render
  static high-contrast text with no sweep. Comprehension never depends on motion.
- **BR-7:** the visual duplicate is `aria-hidden`; the base text remains the one
  accessible name and live-region payload.
- **BR-8:** the overlay is absolute and pointer-inert, so entering or leaving a
  working state never changes measured width, row height, ellipsis, focus, or
  hit targets.

### Surface mapping

#### Agent Thread and Plan

| Surface / symbol | Current | New behavior |
| --- | --- | --- |
| `ThreadProcessBlock` | Turn summary followed by `thread-process-spinner` | Remove the spinner. Shimmer the summary only when no visible live leaf row already states the work. `waitingOnUserInput` remains static. |
| `ReasoningDisclosure` | empty live Item shows static `Thinking`; the Turn spinner supplies motion | Wrap only the empty live `Thinking` label in `WorkingText`. Populated reasoning stays readable and static while it streams. |
| `executionStatusNode` / `ToolItemDisclosure` | `inProgress` replaces the tool glyph with `LoaderIcon` | Always return the tool glyph. Shimmer only the neutral action segment of an in-progress row; failure/interruption tallies remain static. |
| `ThreadToolActivityGroup` | a running group spins its group glyph | A collapsed running group shimmers its neutral action segment. When expanded, its summary is static and each in-progress member shimmers instead. Finished members never inherit motion. |
| `DelegationRow` | running status appends a loader | Keep the form/Agent glyph and name static; shimmer only the running status phrase. Stop remains a separate fixed-size action. |
| `ThreadPlanProgress` | summary and current checklist step each spin | Use the existing `PlanToolIcon` as the stable Plan glyph. When closed, shimmer the current-step summary. When open, freeze the summary and shimmer only the current checklist step. Completed steps keep `CheckIcon`; pending steps stay static. |

The existing Turn/process projection remains authoritative. Working-state
selection is renderer presentation derived from existing `Turn.status`,
`waitingOnUserInput`, Item execution statuses, disclosure state, and Subagent
projection. It adds no state model and changes no `src/core/agent/protocol.ts`
contract.

#### Provider and managed-Skill actions

Eligible settings operations already expose a truthful progressive verb:

- `ProviderConfigForm`: `Validating...` in the cancellable result row and
  `Saving...` in the Save button.
- `ManagedSkillsSettings`: `Resolving...`, `Installing...`, and `Applying...`.
- managed-Skill destructive/reversal confirmations after adding explicit
  `Uninstalling...` and `Rolling back...` messages in English and Simplified
  Chinese.

These phrases use `WorkingText`. Buttons keep the icon for the command they are
performing (`AddIcon`, `RefreshIcon`, `TrashIcon`, or `UndoIcon`) instead of
changing to `LoaderIcon`. Provider validation has one animated owner: the
cancellable result row; the disabled Validate button repeats the current label
statically so the same operation does not shimmer twice.

The following stay outside `WorkingText`:

- `ThreadProviderRetryStatus`: reconnect/backoff is recovery, not normal work.
- `ProviderOAuthForm`'s fallback `Waiting for authorization...`: it is blocked on
  a browser/person. The current `flow.progress` contract does not distinguish
  active token exchange from external waiting, so the entire row stays on the
  existing treatment rather than guessing.
- `ThreadTurnDetailsPanel`, managed-Skill catalog/library initial reads,
  `OutlinerEmptyState` search loading, and preview renderers: resource loading.
- `ToolFileResult`, search refresh, API-key copy, and file-translation start:
  icon-only commands with no stable visible text target.

### `WorkingText` primitive

Add `src/renderer/ui/primitives/WorkingText.tsx` with a deliberately narrow
contract: one text string, an optional contextual class, and ordinary span
attributes. It renders the real text once plus an `aria-hidden` duplicate used
only by the visual sweep. Restricting the payload to text prevents duplicate
IDs, controls, or interactive descendants in the overlay.

Add `src/renderer/styles/working-text.css` and import it once from
`src/renderer/styles/index.css`. The root inherits `currentColor`; the duplicate
therefore deepens the existing alpha-on-ink text briefly without introducing a
new hue or raw color. The masked overlay follows Codex's `0% -> 20-30% -> 50%`
window. Its paired transforms move in opposite directions so the highlight
crosses the full text while the mask itself remains clipped to the root.

Use a CSS-only cadence rather than per-instance React timers: one four-second
keyframe cycle performs the one-second sweep in its first quarter and holds the
terminal transform for the remaining three seconds. A `600ms` tokenized initial
delay matches the observed source. This preserves the reference timing while
letting CSS own mount/unmount and user-preference cancellation.

Retire the Thread-only spinner use of `--motion-working-cycle`; redefine the
working motion tokens for cadence and initial delay. All timing literals outside
`tokens.css` continue to satisfy the existing motion-token guard.

### Codex implementation evidence

The production bundle contains two implementations. The following excerpts are
whitespace-normalized from the installed app; hashed module names and minified
local identifiers are retained where they establish provenance.

#### Continuous variant (observed, not selected)

```css
@keyframes loading-shimmer {
  0% { background-position: -100% 0; }
  100% { background-position: 250% 0; }
}

.loading-shimmer-pure-text,
.loading-shimmer {
  background: var(--shimmer-text-secondary)
    linear-gradient(
      to right,
      transparent 0%,
      var(--shimmer-contrast) 40%,
      var(--shimmer-contrast) 60%,
      transparent 100%
    );
  -webkit-text-fill-color: transparent;
  background-position: -100% 0;
  background-repeat: no-repeat;
  background-size: 50% 200%;
  -webkit-background-clip: text;
  background-clip: text;
  animation: loading-shimmer 2s steps(48, end) infinite;
  display: inline-block;
}

@media (prefers-reduced-motion: reduce) {
  .loading-shimmer-pure-text,
  .loading-shimmer {
    animation: none;
  }
}
```

This is rejected for Tenon because every active row moves continuously. Several
parallel tools or Subagents would recreate the visual noise the change is meant
to remove.

#### Cadenced variant (selected reference)

The bundle gates this path behind `shimmer_variant = "cadenced_legacy"` and uses
these exact timing constants:

```js
const activeDurationMs = 1_000;
const cadenceMs = 4_000;
const initialDelayMs = 600;
const experimentVariant = 'cadenced_legacy';
```

Its minified React control flow, expanded without changing behavior, is:

```tsx
useEffect(() => {
  if (!cadenced || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  const element = ref.current;
  if (element == null) return;

  let removeActiveTimeout: number | undefined;
  let cadenceInterval: number | undefined;

  const sweep = () => {
    if (removeActiveTimeout !== undefined) window.clearTimeout(removeActiveTimeout);
    element.classList.remove(styles.cadencedShimmerActive);
    element.classList.add(styles.cadencedShimmerActive);
    removeActiveTimeout = window.setTimeout(() => {
      element.classList.remove(styles.cadencedShimmerActive);
      removeActiveTimeout = undefined;
    }, activeDurationMs);
  };

  const initialTimeout = window.setTimeout(() => {
    sweep();
    cadenceInterval = window.setInterval(sweep, cadenceMs);
  }, initialDelayMs);

  return () => {
    if (removeActiveTimeout !== undefined) window.clearTimeout(removeActiveTimeout);
    window.clearTimeout(initialTimeout);
    if (cadenceInterval !== undefined) window.clearInterval(cadenceInterval);
    element.classList.remove(styles.cadencedShimmerActive);
  };
}, [cadenced]);
```

The component keeps normal text in the accessibility tree and overlays one
visual-only copy. This excerpt uses the bundle's `jsx` call shape rather than
reconstructing authored JSX:

```tsx
jsx('span', {
  ref: cadenced ? ref : undefined,
  className: rootClassName,
  ...props,
  children: [
    children,
    cadenced
      ? jsx('span', {
          'aria-hidden': true,
          className: styles.cadencedShimmerSweep,
          children: jsx('span', {
            className: styles.cadencedShimmerHighlight,
            children,
          }),
        })
      : null,
  ],
});
```

The corresponding production CSS is:

```css
._cadencedShimmer_1q6es_1 {
  -webkit-text-fill-color: currentColor;
  background: none;
  background-clip: border-box;
  animation: none;
  position: relative;
}

._cadencedShimmerSweep_1q6es_23 {
  pointer-events: none;
  width: 100%;
  position: absolute;
  inset: 0 auto 0 0;
  overflow: hidden;
  transform: translate(-50%);
  mask-image: linear-gradient(
    90deg,
    #0000 0%,
    #000 20% 30%,
    #0000 50% 100%
  );
}

._cadencedShimmerHighlight_1q6es_17 {
  -webkit-text-fill-color: currentColor;
  width: 100%;
  display: block;
  transform: translate(50%);
}

._cadencedShimmerActive_1q6es_56 ._cadencedShimmerSweep_1q6es_23,
._cadencedShimmerActive_1q6es_56 ._cadencedShimmerHighlight_1q6es_17 {
  animation-duration: 1s;
  animation-timing-function: steps(48, end);
  animation-iteration-count: 1;
}

@keyframes _cadencedLoadingShimmerSweep_1q6es_1 {
  0% { transform: translate(-50%); }
  100% { transform: translate(125%); }
}

@keyframes _cadencedLoadingShimmerHighlight_1q6es_1 {
  0% { transform: translate(50%); }
  100% { transform: translate(-125%); }
}

@media (prefers-reduced-motion: reduce) {
  ._cadencedShimmerActive_1q6es_56 ._cadencedShimmerSweep_1q6es_23,
  ._cadencedShimmerActive_1q6es_56 ._cadencedShimmerHighlight_1q6es_17 {
    animation: none;
  }
}
```

Codex applies the text class to `Thinking`, starting/running command and file
activity, web activity, active multi-agent work, and browser activity. Its
background-Agent row keeps the identicon and name static and applies shimmer
only to the `is working` metadata. That identity/action split is the product
behavior this plan adopts.

### Implementation boundaries

Expected product files:

- new `src/renderer/ui/primitives/WorkingText.tsx`
- new `src/renderer/styles/working-text.css`
- `src/renderer/styles/index.css`
- `src/renderer/styles/tokens.css`
- `src/renderer/styles/thread.css`
- `src/renderer/agent/components/ThreadView.tsx`
- `src/renderer/agent/components/items/ThreadItemView.tsx`
- `src/renderer/ui/agent/ManagedSkillsSettings.tsx`
- `src/renderer/ui/agent/ProviderConfigForm.tsx`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`

No dependency, preload, main-process, IPC, command, core protocol, persistence,
or userData file changes are expected. `LoaderIcon` remains exported and used by
the loading/recovery consumers outside this plan.

### Spec sync

The implementation PR updates current-intended behavior in the same change:

- `docs/spec/design-system/patterns.md`: split Working from Loading and record
  cadence, identity retention, hierarchy suppression, and motion preferences.
- `docs/spec/design-system/components.md`: update compact activity/disclosure
  rows and Plan progress from spinner-owned state to text-owned working state.
- `docs/spec/design-system/surfaces.md`: record provider validation's text-led
  working state.
- `docs/spec/agent-thread-rendering.md`: replace every claim that the spinner is
  the running state; describe tool, group, Thinking, Turn, Plan, and Subagent
  ownership.
- `docs/spec/agent-skills.md`: record stable action icons plus progressive
  working copy for managed mutations.

### Acceptance and verification

- **AC-1:** While a tool is in progress, its original tool glyph remains visible
  and only its neutral action phrase uses `WorkingText`.
- **AC-2:** While empty reasoning is streaming, `Thinking` shimmers; when the
  first readable reasoning text arrives, that text is rendered normally without
  a class or geometry swap on the container.
- **AC-3:** While a Subagent is running, its name and form glyph remain static,
  only its status phrase shimmers, and Stop remains available.
- **AC-4:** While a Plan disclosure is closed, only its summary shimmers; while
  open, only the current step shimmers. Completion removes all working motion.
- **AC-5:** If a Turn is waiting on user input, failed, interrupted, or complete,
  it contains no `WorkingText` and announces its existing static status.
- **AC-6:** A `WorkingText` instance exposes its text once to accessibility APIs;
  the visual duplicate is `aria-hidden` and pointer-inert.
- **AC-7:** Under reduced motion or increased contrast, the base text remains
  visible and the overlay does not animate.
- **AC-8:** In light and dark mode, the sweep deepens `currentColor` without a
  raw color, brand accent, background fill, or loss of the underlying text.
- **AC-9:** At narrow Agent-pane widths and with long English and Chinese labels,
  ellipsis, pinned failure tallies, row height, controls, and neighboring text do
  not move when the working state starts or stops.
- **AC-10:** Initial data loads, reconnect, OAuth wait, and icon-only operations
  retain their existing loading/recovery indicator and never receive
  `WorkingText` accidentally.
- **AC-11:** Managed-Skill install/update/uninstall/rollback and provider
  validation/save show progressive copy, retain their action glyph where one
  exists, and settle to the existing success/error state.

Focused automated coverage should update or add these test titles:

- `WorkingText renders one accessible text node and an aria-hidden sweep copy`
- `WorkingText uses a cadenced tokenized sweep and becomes static for motion and contrast preferences`
- `keeps the tool own glyph in every status and shimmers only the running action`
- `shimmers only a collapsed running group or its visible running members`
- `reads Subagent identity statically and marks only live status as working`
- `shows Turn-local Plan progress only while the Turn is active`
- `stops working motion while the Turn is blocked on user input`
- `validates a key asynchronously and never saves on validate`
- `keeps managed Skill action glyphs stable while progress copy is working`
- `uses progressive uninstall and rollback copy while the mutation is pending`

Run `bun run typecheck`, `bun run test:renderer`, focused
`bun run test:e2e -- tests/e2e/agent-thread.spec.ts tests/e2e/agent-settings.spec.ts`,
`bun run docs:check`, `bun scripts/design-system-metrics.ts --check`, and
`git diff --check` before marking the implementation ready.

Visual verification uses `bun run dev:codex-4` and records PR-comment evidence
for light and dark Thread/Plan/Settings states, a narrow pane, at least two
concurrent Subagents, reduced motion, and increased contrast. Evidence uploads
use GitHub's comment CDN rather than a side-branch asset URL.

### Collision check

- Refreshed against GitHub and `docs/TASKS.md` on 2026-08-11: there are no open
  PR claims and no active plan for shimmer or semantic working-state motion.
- `icon-semantics` may later edit glyph mappings, but this plan adds no icon
  alias and reuses the existing `PlanToolIcon`, tool glyph resolver, and managed
  action glyphs. There is no shared implementation decision.
- The likely files are renderer components, renderer styles, i18n messages, and
  current specs. No infrastructure-ownership file is touched.
- Result: **no overlap**. Re-run `gh pr list`, the board scan, and the intended
  file-scope comparison immediately before opening the Draft implementation PR.

### Risks

- **Motion multiplies under concurrency.** Cadence alone is not sufficient if a
  parent and child both animate the same fact. BR-5 makes the leaf the owner and
  permits multiple motion only for genuinely concurrent leaf actions.
- **The duplicate can break truncation or wrapping.** `WorkingText` replaces the
  existing text span rather than nesting another layout-owning box. Focused DOM
  and narrow-pane tests freeze ellipsis, pinned tallies, and row geometry.
- **Accessible text can be announced twice.** The base string is the only normal
  child; the entire sweep subtree is `aria-hidden`. Live regions continue to
  announce state changes through the base string.
- **Continuous animation would look busy and consume more paint.** The selected
  cadence moves for one quarter of each cycle, uses transforms/masks only, and
  creates no React interval per row.
- **Current-color doubling can become too strong in high contrast.** The overlay
  is disabled for `prefers-contrast: more`; the load-bearing base text already
  inherits the strengthened token.
- **Settings copy can lie during destructive work.** The implementation adds
  explicit progressive English and Chinese labels before applying shimmer;
  imperative `Uninstall` / `Roll back` never animate as if they were status.
- **Spinner semantics can regress elsewhere during a sweep.** Completion is
  derived from an explicit consumer matrix and focused `rg` output, not a global
  `LoaderIcon` replacement. AC-10 freezes the retained family.

## Open questions

No product question blocks implementation. Main review should explicitly
challenge three chosen boundaries before approval: settings consumers land in
the same complete feature, the most-specific-visible-text rule suppresses
duplicate parent motion, and the observed `600ms / 1s / 4s` cadence is adopted
without a feature flag. Any redirect should update this plan before code starts.

## Checklist

- [ ] Add the text-only `WorkingText` primitive and shared cadenced CSS.
- [ ] Replace Thread, Thinking, tool/group, Subagent, and Plan working spinners
      according to the most-specific-visible-text rule.
- [ ] Convert eligible Provider and managed-Skill progressive actions while
      preserving their identity/action glyphs.
- [ ] Add English and Simplified Chinese progressive uninstall/rollback copy.
- [ ] Leave every Loading, Waiting, Recovery, terminal, and icon-only consumer
      in the explicit retained matrix unchanged.
- [ ] Update the five current-intended spec documents.
- [ ] Update renderer and E2E coverage under the test titles above.
- [ ] Run typecheck, renderer tests, focused E2E, docs check, design metrics, and
      diff checks.
- [ ] Verify light, dark, narrow, concurrent, reduced-motion, and
      increased-contrast states; attach evidence to the PR by comment upload.
