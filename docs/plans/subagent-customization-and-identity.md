# Subagent Customization And Identity

**Shape:** (b) a SET of two independent complete features, each its own PR,
ordered by dependency:

- **PR-A — Identity presentation.** The profile model, the default roster and
  avatar assets, and the conversation-flow identity layout. Complete and
  verifiable with built-in defaults alone — no editor needed to ship it.
- **PR-B — Agent editor.** The white-box editing surface over PR-A's profile
  model. Depends on PR-A's fields; independently shippable after it.

## Goal

Subagents stop being a black box. Users can see, rename, re-skin, create, and
edit agent definitions; every agent has a persistent visual identity (persona
name + avatar) that renders in the conversation flow; and the flow itself adopts
a mobile-IM identity layout: an avatar-gutter hanging indent, a two-line
identity header per speaker block, a "Worked for …" duration line that doubles
as the process disclosure, and subagent results delivered as signed report
cards.

Concretely, this ships:

1. Presentation fields (`persona`, `avatar`) on Agent Role definitions, plus a
   presentation-override layer so built-ins and the main agent are customizable
   without redefining them.
2. A default roster with bundled avatar art: **Tenon** (beaver, main), **Fox**
   (fox, `explore`), **Owl** (owl, `plan`), **Bear** (bear, `general-purpose`).
3. The identity-header transcript layout in the 344px agent deck.
4. An "Agents" management pane: list, create, edit, delete; built-ins editable
   in presentation only, custom Roles editable in full.

## Non-goals

- **No direct user→subagent dispatch.** Command stays single-channel: the user
  speaks only to main; main delegates; children report to their direct parent;
  main narrates. The `subagent-interaction` non-goal ("no manual spawn UI") is
  upheld, and its sole ratified exception stays as-is (a user-stopped worker is
  resumed only by the user from its detail view).
- **No model-contract changes.** The `claude-code-subagent-parity` byte-locked
  tool contract is untouched. Persona and avatar never reach any model-facing
  surface — the model addresses canonical type/Role names and raw Agent IDs
  only, and never learns that "Fox" exists.
- **No durable-individual semantics.** Identity attaches to the *definition*
  (Role / agent type), not to a persistent individual with its own memory.
  Concurrent children of one type deliberately share a face and are
  disambiguated by task description, never by per-instance persona variation.
- **No runtime avatar generation.** Assets are bundled, committed, and frozen;
  no image-gen calls, no network.
- **No personas for Skill runs.** Isolated Skill executions keep the `SkillIcon`
  glyph treatment — agents have faces, skills are tools.
- **No migration / back-compat** (pre-release policy): config additions are
  additive and optional; no legacy reader; a format break means a dev userData
  wipe, not a compatibility path.

## Design

### Product thesis (context for the executing dev)

The ratified interaction model separates **command** from **visibility**.
Command is single-channel: one conversation with main. Visibility is fully
open: the flow shows who produced what, the detail view shows depth, and — with
this plan — the definition layer becomes user-authored. Identity is meaningful
here because the user owns it: they wrote the instructions, picked the tools,
chose the name and the face. That is *authorship*, not personhood — this plan
deliberately does not import the "agents as human-like colleagues" framing;
transparency features (durations, tool activity, usage) stay first-class.

### Foundations and sequencing

- **Builds on `claude-code-subagent-parity`** (its dynamic Role/agent-type
  catalog — `general-purpose`, `explore`, `plan`, user/project Roles — its
  Agent execution record persisted with Thread metadata, and its byte-locked
  tool contract). PR-A lands only after that implementation; building identity
  on the retiring `spawn_agent`-era nickname path
  (`input.nickname ?? role.nicknameCandidates`) would be work on a mechanism
  scheduled for replacement.
- **Coordinates with `subagent-interaction`.** That plan owns lifecycle-anchor
  *semantics* (where anchors appear in the conversation, click pushes the
  full-deck detail stack, the work strip, notification policy). This plan owns
  anchor *visual form* (the signed report card) and the identity-header system.
  The one seam is amended in that plan file in the same change (see Spec And
  Plan Amendments).

### 1. Profile model

`AgentRole` (`src/core/agent/configuration.ts`) gains one optional grouped
field:

```ts
readonly presentation?: {
  readonly persona?: string; // display name, e.g. "Fox" — a proper noun, never translated
  readonly avatar?: string;  // key into the bundled avatar set, e.g. "fox"
};
```

- Parsed in `AgentConfigurationLoader` beside `nicknameCandidates`: extend the
  role-record key allowlist, add strict-shape parsing in the loader's existing
  style, and validate persona like a nickname (single line, trimmed, length
  cap ≈ 40 chars) and avatar against the bundled key list (unknown key → config
  error at the write boundary, letter fallback at the read boundary).
- **Built-in presentation overlay.** Built-in definitions
  (`BUILT_IN_AGENT_ROLE_DEFINITIONS`) stay frozen code constants; users
  customize their *look* via a new optional config section, valid in both
  layers:

  ```jsonc
  // <userData>/agent/config.json (user) and <cwd>/.tenon/agent.json (project)
  { "presentationOverrides": { "explore": { "persona": "Scout" },
                               "main":    { "avatar": "otter" } } }
  ```

  Precedence mirrors `loadMerged`: project over user over the definition's own
  `presentation`. The pseudo-key `main` addresses the root agent, which has no
  Role.
- **Main agent profile.** A frozen constant in `configuration.ts` —
  `MAIN_AGENT_PROFILE = { persona: 'Tenon', avatar: 'beaver' }` — overlayable
  through `presentationOverrides.main`.
- **Default roster.** Built-in Roles carry default presentation in their
  definitions:

  | identity | agent type | persona | avatar key |
  |---|---|---|---|
  | root | main | Tenon | `beaver` |
  | built-in | `explore` | Fox | `fox` |
  | built-in | `plan` | Owl | `owl` |
  | built-in | `general-purpose` | Bear | `bear` |

  **Naming principle (binding for future additions):** the persona IS the
  avatar animal — one English word, capitalized, matching the picture. What you
  see is what it's called; no human names, no learning cost.
- **Model-surface isolation (hard rule).** `presentation` must not change any
  model-facing byte: `RoleCatalogContextPayload` / `RoleCatalogEntry` entries
  and hashes (`buildRoleCatalogSnapshot`), stable-prompt blocks, tool
  descriptions and results. A unit test locks this (see Tests).
- **Renderer delivery.** A new request/notification pair on the agent protocol
  (`src/core/agent/protocol.ts` + `src/core/agent/codec.ts` — a coordinated
  protocol-surface change per A4): a `profiles/get` request returning the
  resolved catalog
  `{ main: Presentation, roles: Record<name, Presentation & { source }> }`
  for a cwd, and a transient (never recorded — presentation is not history)
  `profiles/changed` notification on configuration reload. The renderer caches
  the catalog in `threadStore` (new `profileCatalog` field on
  `ThreadStoreSnapshot`), fetched at dock mount. Exact request names are
  reversible locals.
- **Identity resolution at render.** One shared helper (`resolveAgentIdentity`)
  applies the fallback chain; it degrades and never throws (A12):
  1. main-thread rows → `main` profile (overlay-resolved);
  2. child rows/cards → the child's recorded agent type / Role name (today
     `Thread.agentRole`; post-parity, the execution record's selected
     definition) → profile catalog;
  3. persona missing → the Role/type name verbatim;
  4. avatar missing or Role unknown/deleted → letter fallback below.

### 2. Avatar assets

- Bundled set under `public/agent-avatars/`: square PNGs at 48px and 96px
  (`<key>.png`, `<key>@2x.png`), displayed at 24px (flow) and 40px (detail
  view), circle-cropped by CSS (`border-radius: 50%`).
- Twelve keys initially: `beaver`, `fox`, `owl`, `bear`, `panda`, `otter`,
  `lynx`, `raccoon`, `hedgehog`, `capybara`, `heron`, `badger`. Four are the
  defaults; the rest exist so custom Roles can pick without colliding.
- One consistent illustration style across the set; must stay readable at 24px
  and hold up on both light and dark surfaces.
- **Produced once, committed, frozen.** A regenerated avatar is a different
  face; identity requires stability. Re-render an asset only on a deliberate,
  PM-ratified art-direction change — never as a side effect.
- **Letter fallback.** Identities without an avatar render a circle with the
  identity's first grapheme on a deterministic background:
  `--avatar-fallback-1` … `--avatar-fallback-8` tokens declared in
  `src/renderer/styles/tokens.css` for both themes (B1 — no raw hex outside
  token declarations); index = a stable string hash of the identity key mod 8.

### 3. Conversation-flow identity layout (PR-A)

Rendering authority: `docs/spec/agent-thread-rendering.md`. Components:
`ThreadView.tsx`, `items/ThreadItemView.tsx`; styles: `styles/thread.css`.

**Identity header.** Each headed block opens with a two-line header:

- line 1 — 24px avatar in the gutter, persona at the content register
  (semibold), role label beside it in the secondary register (`--text-3`
  color). The role label is UI copy: i18n keys for the built-in types
  (`main`, `explore`, `plan`, `general-purpose`), the custom Role's name
  verbatim otherwise. The persona is a literal proper noun and is never
  translated.
- line 2 — the duration line (below).

**Hanging indent (mobile-IM layout — ratified over a header-only indent).** The
avatar forms a gutter; all *text* content of a block — both header lines and
body — shares one left edge at avatar width + one spacing-ladder gap
(24px + `--space-4`-class gap ≈ 34px). Inside the 344px deck
(`--agent-width`) this leaves a ≈ 276px content column — deliberately inside
the mobile-IM line-length range, where this layout is proven at exactly this
width. Two break-out rules:

- **media break out** — `ThreadImageGallery` and image items extend left to the
  avatar edge (full width minus deck padding), the IM wide-media convention;
- **code keeps the column** — code blocks keep the indent and their existing
  wrap behavior (`.thread-tool pre` is `white-space: pre-wrap` today; no new
  overflow mode).

**The duration line IS the process disclosure.** The collapsed process block's
header (today built from `threadProcessSummary` and
`t.agent.thread.workedFor` with `formatProcessDuration`) moves into header
line 2: a live turn ticks via `useTurnElapsedMs` with the existing live
phrasing; a completed turn reads "Worked for {duration}". The line is a real
button (visible `:focus-visible` ring, B8) that toggles the turn's process
detail — reasoning disclosures and `ThreadToolActivityGroup` content — in
place. No separate process header remains; the prototype's clean flow and the
existing process visibility are the same surface.

**Consecutive-speaker merge.** A block renders headerless (body only, same
indent) when the previous rendered block has the same resolved identity and no
interrupting block (user message, subagent report card, lifecycle anchor, error
banner) sits between; any interruption re-triggers the header. Rationale:
vertical economy — the prototype shows a header on every block only because its
speakers happen to alternate.

**User messages: unchanged.** `.thread-user-message` (right-aligned,
`--fill-3` bubble, `min(88%, 520px)`) already matches the target design.

**Subagent report card (signed).** The delegation anchor (today
`SubagentActivityItem` → `.thread-delegation-row`; after
`subagent-interaction`, the completion anchor) becomes a card under the child
identity's header:

- header — child avatar + persona + Role/type label + "Worked for {child run
  duration}" (`SubagentPresentation.durationMs` / the worker registry);
- card chrome — neutral only (B3/B4): `--fill-2` surface, hairline edge
  (`--inset-hairline`), `--radius-md`. **No purple, no accent borders**; the
  prototype's violet card must land neutral. Status meaning stays in the
  existing status/error text styling, never in card chrome;
- content — a single-line title (ellipsis) plus a result excerpt clamped to
  3 lines (`-webkit-line-clamp`), so card height is bounded;
- interaction — click pushes the subagent detail view exactly per
  `subagent-interaction` (semantics owned there); no inline expansion; hover
  must not shift layout (B7); no `cursor: pointer` (B10);
- running children — the header slot shows live elapsed
  (`useSubagentElapsedMs`) and the Stop affordance as today; the card body
  appears when a result exists.

**Concurrency and disambiguation.** Children of one type share a face by
design; the card title / task description is the only disambiguator.

**Depth.** Grandchildren inside the child transcript (`SubagentRunDetail` /
the detail stack) use the same identity system; hierarchy is conveyed by the
containing surface, never by the avatar.

**Skill runs.** Isolated Skill rows keep the `SkillIcon` treatment — no header,
no avatar.

**Virtualization.** `estimateTurnHeight` and `TRANSCRIPT_ROW_ESTIMATE_PX`
(`ThreadView.tsx`) must account for header lines and clamped card heights;
measured heights still win.

### 4. Agent editor (PR-B)

Surface: an "Agents" management pane in the settings family
(`src/renderer/ui/agent/`, beside `ProviderConfigWindow`), opened from the dock
header menu. Exact placement is a reversible local decision; the contract below
is not.

- **List.** Main first, then built-ins, then custom Roles; each row shows
  avatar + persona + type + source badge (`built-in` / `user` / `project`).
- **Built-ins and main: presentation editable, behavior locked.** Persona
  (text field) and avatar (picker over the bundled set, plus the letter
  fallback) write to `presentationOverrides` in the chosen layer. Description,
  instructions, and tool policy are displayed read-only. A **"Duplicate as
  custom Role"** action seeds a new editable Role from the built-in's visible
  configuration.
- **Custom Roles: fully editable.** Canonical name (loader validation via
  `normalizeSelectedName`; renaming = create + delete), persona, avatar,
  description, `developerInstructions`, and `overrides` (model,
  reasoningEffort, tools). Validation reuses the loader's existing validators
  and parity's Role tool-admission semantics — do **not** build a second
  validator.
- **Scope.** Create-time choice of layer: user
  (`<userData>/agent/config.json`) or project (`<cwd>/.tenon/agent.json`,
  git-shareable); shown on the row.
- **Write path.** New protocol requests (suggested `roles/write`,
  `roles/delete`, `profiles/updatePresentation`) handled in the main process —
  config file IO stays behind the process seam (A2). Whole-file
  read-modify-write on the JSON layer; a malformed existing file fails the
  write with the loader's error surfaced (a write boundary may throw, A12).
  Every successful write re-reads and broadcasts the refreshed profile catalog.
- **Deletion semantics.** Deleting a Role affects future spawns only: running
  children keep their resolved configuration; historical transcripts degrade
  through the identity fallback chain (§1). Confirmation dialog; no cascade.

### 5. Spec and plan amendments (same change as the code)

- `docs/spec/agent-thread-rendering.md` — identity-header contract, hanging
  indent + break-out rules, merge rule, duration-line disclosure, signed card.
  (PR-A)
- `docs/spec/design-system/patterns.md` §Agent Thread Flow — replace the
  "identity via compact title, no avatars" doctrine with the identity-header
  system; record the neutral-card rule. (PR-A)
- `docs/spec/agent-subagent-threads.md` §Roles And Configuration —
  presentation fields, overlay precedence, main profile, naming principle.
  (PR-A; the editor contract joins in PR-B)
- `docs/plans/subagent-interaction.md` — one surgical edit: the completion
  anchor's visual form becomes the signed report card; all semantics unchanged.
  (PR-A)
- Design guards (B11): the token/hex guards cover the new CSS; the
  avatar-fallback tokens are declared in `tokens.css`, not inline.

### 6. Tests

Unit (core / main):

- "presentation parses and merges with project-over-user precedence"
- "presentationOverrides apply to built-in roles and main"
- "persona configuration leaves role catalog entries and hashes unchanged"
  (model-surface isolation)
- "identity resolution falls back persona → role name → letter avatar and never
  throws on an unknown role"

Renderer:

- header presence/absence per the merge rule (same-speaker continuation;
  interruption resets)
- the duration line toggles the process block; live vs completed copy
- card clamps to bounded height and uses neutral tokens (guard-style DOM/CSS
  assertions)

PR-B: editor write → reload round-trip; duplicate-as-custom seeds correctly;
post-deletion transcripts render through the fallback chain.

Gate: visual verification in light and dark (the UI row of the gate table).

## Open Questions

- The final animal pool beyond the four defaults — PM taste at
  asset-production time; the twelve keys above are earnest placeholders.
- Art direction of the avatar set (flat illustration vs painterly) — a one-shot
  decision at production, frozen afterward.
- Whether the editor should also surface Configuration Profiles (root
  execution defaults) — out of scope here; candidate for a future plan.
