# Subagent Customization And Identity

## Goal

Subagents stop being a black box. Users can see, rename, re-skin, create, and
edit agent definitions; every agent has a persistent visual identity (persona
name + identity-coloured mark) that renders in the conversation flow; and the shipped
speaker layout completes its mobile-IM form: a mark-gutter header,
portrait + persona + role label in the header, and a "Worked for …" duration
line that doubles as the process disclosure — with subagent results staying
signed report cards under those same headers.

Concretely, this ships:

1. Presentation fields (`persona`, `color`) on Agent Role definitions, plus a
   `presentationOverrides` layer so built-ins and the root identity are
   customizable without redefining them.
2. A default roster of generated identity marks: **Aspen** (teal, main),
   **Rena** (orange, `explore`), **Ada** (blue, `plan`), **Bruno** (amber,
   `general-purpose`).
3. The portrait/persona/layout upgrade of the shipped speaker system in the
   344px agent deck (§3).
4. An "Agents" management pane: list, create, edit, delete; built-ins editable
   in presentation only, custom Roles editable in full.

## Non-goals

- **No direct user→subagent dispatch.** Command stays single-channel: the user
  speaks only to main; main delegates; children report to their direct parent;
  main narrates. The `subagent-interaction` non-goal ("no manual spawn UI") is
  upheld, and its sole ratified exception stays as-is (a user-stopped worker is
  resumed only by the user from its detail view).
- **No model-contract changes.** The `claude-code-subagent-parity` byte-locked
  tool contract is untouched. Persona and colour never reach any model-facing
  surface — the model addresses canonical type/Role names and raw Agent IDs
  only, and never learns that "Fox" exists.
- **No durable-individual semantics.** Identity attaches to the *definition*
  (Role / agent type), not to a persistent individual with its own memory.
  Concurrent children of one type deliberately share a face and are
  disambiguated by task description, never by per-instance persona variation.
- **No image generation, no network, no per-agent artwork.** The mark is a
  deterministic inline SVG computed from configuration; there are no avatar
  assets at all.
- **No personas for Skill runs.** Isolated Skill executions keep the `SkillIcon`
  glyph treatment — agents have faces, skills are tools.
- **No migration / back-compat** (pre-release policy): config additions are
  additive and optional; no legacy reader; a format break means a dev userData
  wipe, not a compatibility path.

## Shape

(b) a SET of two independent complete features, each its own PR, ordered by
dependency:

- **PR-A — Identity presentation.** The identity model, the default roster of
  generated marks, and the conversation-flow identity layout. Complete and
  verifiable with built-in defaults alone — no editor needed to ship it.
- **PR-B — Agent editor.** The white-box editing surface over PR-A's profile
  model. Depends on PR-A's fields; independently shippable after it.

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

### Foundations (both shipped)

- **`claude-code-subagent-parity` shipped** (#535, 2026-08-14; plan archived).
  The dynamic Role/agent-type catalog (`general-purpose`, `explore`, `plan`,
  user/project Roles), the Agent execution record persisted with Thread
  metadata, and the byte-locked tool contract are current reality, specified in
  `docs/spec/agent-subagent-threads.md`. No sequencing gate remains; PR-A can
  start immediately.
- **`subagent-interaction` shipped** (#544, 2026-08-16; plan archived). The
  surfaces this plan upgrades are live: the worker-registry projection
  (`projectSubagentConversation`, `SubagentRegistryEntry`,
  `subagentSpeakerName` in `subagentPresentation.ts`) feeds `SubagentChip`
  (`.thread-agent-chip`, placed by `ThreadItemView.tsx`), the work strip, the
  pushed detail view (`SubagentDetailView`), the `SubagentReport` result card,
  and the `ThreadSpeakerGroup` identity headers. Anchor *semantics*
  (placement, one-gesture open, notification policy) are contracted in
  `docs/spec/agent-thread-rendering.md` §Agent Anchors And The Work Strip and
  stay unchanged; this plan upgrades the speaker system's *presentation* —
  portraits, personas, layout, the duration-line disclosure (§3) — amending
  the spec's speaker section in the same change (see Spec Amendments).

### 1. Identity model

`AgentRole` (`src/core/agent/configuration.ts`) gains one optional grouped
field:

```ts
readonly presentation?: {
  readonly persona?: string; // display name, e.g. "Rena" — a proper noun, never translated
  readonly color?: string;   // identity-palette name, e.g. "orange"
};
```

- Parsed in `AgentConfigurationLoader`: extend the role-record key allowlist,
  add strict-shape parsing in the loader's existing style, and validate persona
  like a nickname (single line, trimmed, length cap ≈ 40 chars) and colour
  against the identity palette (unknown name → config error at the write
  boundary; a stale stored colour degrades to derivation at the read
  boundary).
- **Persona supersedes nickname (ruling).** The shipped parity feature kept
  nicknames for UI labels; this plan replaces that display path so the agent
  has exactly one name system:
  - `presentation.persona` is the **only** renderer display name. The three
    surfaces that show `agentNickname` today convert to `resolveAgentIdentity`:
    the `ThreadList.tsx` row label (`nickname [role]` becomes persona + role
    label), the `ThreadDetailsDialog.tsx` title fallback, and the name/
    description fallbacks in `subagentPresentation.ts`
    (`subagentSpeakerName` and the registry-entry description chain).
  - `nicknameCandidates` retires from `AgentRole` — superseded by
    `presentation.persona`. The loader allowlist drops it, and the spawn-time
    fallback `role.nicknameCandidates?.[0]` in `SubagentCollaboration` is
    removed with it (pre-release: no migration; stale config keys are a parse
    error like any other unknown key).
  - `Thread.agentNickname` stays recorded at the data layer — it is a spawn
    fact and may feed model-facing collaboration payloads, which this plan must
    not touch (see Non-goals). No renderer surface reads it as a display name
    after PR-A; retiring the field itself is a separate cleanup if later proven
    dead.
- **Built-in presentation overlay.** Built-in definitions
  (`BUILT_IN_AGENT_ROLE_DEFINITIONS`) stay frozen code constants; users
  customize their *look* via a new optional config section, valid in both
  layers:

  ```jsonc
  // <userData>/agent/config.json (user) and <cwd>/.tenon/agent.json (project)
  { "presentationOverrides": { "explore": { "persona": "Scout" },
                               "main":    { "color": "violet" } } }
  ```

  Precedence mirrors `loadMerged`: project over user over the definition's own
  `presentation`. The pseudo-key `main` addresses the root agent, which has no
  Role.
- **The root identity.** A frozen constant in `configuration.ts` —
  `DEFAULT_AGENT_PRESENTATIONS.main = { persona: 'Aspen', color: 'teal' }` —
  overlayable through `presentationOverrides.main`.
- **Default roster.** Built-in Roles carry default presentation in their
  definitions:

  | identity | agent type | persona | colour |
  |---|---|---|---|
  | root | main | Aspen | `teal` |
  | built-in | `explore` | Rena | `orange` |
  | built-in | `plan` | Ada | `blue` |
  | built-in | `general-purpose` | Bruno | `amber` |

  **Naming principle (binding for future additions):** the persona is a short
  proper name with a hook worth remembering — Rena from Reynard the fox, Ada
  from Ada Lovelace (who wrote the first plan a machine could run), Bruno from
  the brown of a bear, Aspen from the tree a beaver builds with. The
  conversation's own agent is named like the rest and does NOT carry the
  product's name: a transcript names the participants in it, not the
  application they run inside.

### 2. Identity marks

- **One soft form for every participant; identity is the colour.** The mark
  (`AgentMark.tsx`) is a generated inline SVG: the shared squircle-ish form
  filled with `var(--identity-tint-<n>)`, with two round-capped eye strokes cut
  through the mask — the eyes are holes showing the panel behind, so a mark has
  exactly one colour and the eyes can never be mis-paired against a theme. No
  ground, no crop, no frame: the form is its own edge, which retires the whole
  tile/hairline treatment raster portraits needed. (This supersedes the three
  portrait-art cuts tried during review — full figures shrank to nothing at
  28px, painted heads lost their detail to the downscale, and flat faces still
  needed framing; the mark needs nobody to draw anything, ever.)
- **Colours: pinned for the roster, derived for everyone else.** The default
  four wear hand-picked, well-separated hues — hashing four names into seven
  buckets collides about half the time, and it did. Every other identity
  derives its hue from its type name (core `deriveIdentityColor`, FNV-1a) over
  the hues the roster did not take, so a fresh Role cannot walk in wearing
  Aspen's teal; the danger-adjacent red (`--identity-tint-0`) is outside the
  identity palette entirely, continuing the shipped letter-disc rule. An
  explicit `presentation.color` may choose any palette hue.
- **The marks blink.** Mostly both eyes, now and then just one, occasionally a
  quick double — each mark on its own clock (shared beats read as a
  screensaver), with a fast shut (55ms) and a relaxed open (150ms), because
  equal speeds read as a machine. Scheduled by ref-driven class toggles, never
  React state (A9: a transcript of marks must not re-render to blink);
  `prefers-reduced-motion` stills them entirely.
- **Deferred, deliberately:** the demo's expression system (mood-parameterised
  eye strokes) and spherical gaze pose. Both are proven in
  `tmp/agent-marks/demo.html` and belong to surfaces large enough to read them
  — the detail view and the PR-B editor — not to a 28px transcript mark.

### 3. Conversation-flow identity layout (PR-A)

Rendering authority: `docs/spec/agent-thread-rendering.md` — its speaker
section already contracts most of this surface. Components: `ThreadView.tsx`,
`ThreadSpeaker.tsx`, `agentAvatarColor.ts`, `items/ThreadItemView.tsx`,
`SubagentChip.tsx`, `SubagentReport.tsx`; styles: `styles/thread.css`,
`styles/tokens.css`.

**Baseline — the shipped speaker system (#544).** The transcript already
renders every non-reader block under a one-line identity header:
`ThreadSpeakerGroup` (a 16px letter-disc avatar from `agentAvatarColor`, the
speaker name, and a `meta` slot carrying the Turn's work summary or a
delivered child's own "Worked for …"), with consecutive same-participant merge
keyed by `ThreadSpeaker.participantId`, avatar hue keyed by agent type
(`avatarKey`; `MAIN_AVATAR_IDENTITY` for main), the reader's right-hand bubble
excepted, and `SubagentReport` delivering a child's result as an outlined,
clamped, whole-card-clickable card under that child's header. PR-A does not
rebuild any of this. It upgrades four things:

**Upgrade 1 — generated marks.** The letter disc and its `agentAvatarColor`
module retire together with the raster-portrait pipeline; `ThreadSpeakerGroup`
renders `AgentMark` for every participant. `--speaker-avatar-size` stays 28px.
`avatarKey` semantics (one type, one mark, everywhere) are unchanged.

**Upgrade 2 — persona names, on their own line.** The header becomes a
portrait beside two stacked lines — persona + type, then the work line — as the
ratified prototype draws it. It is still one header and one control.

The speaker name becomes the persona: "Rena"
where `subagentSpeakerName` shows the raw type `explore` today; "Aspen"
(untranslated) for main. A Role/type label joins the header line in
`--text-secondary` (the type ladder is
`--text-primary/secondary/tertiary/quaternary`; there is no numeric
`--text-N`): built-in types use i18n labels, a custom Role's name appears
verbatim; the persona is a literal proper noun and is never translated.
`SubagentChip`, the work strip, and the detail-view title adopt the same names
through the shared resolver; their visual form is otherwise unchanged.

**Upgrade 3 — full-width message body (superseded the hanging indent).**
Ratified 2026-08-18 after seeing a three-column table in the deck: the portrait
and identity lines form a header row, and the message keeps the whole column.
An avatar lane is a chat-app trade for short bubbles; Tenon's messages are
documents in the app's narrowest column, where the lane costs 13% of the
measure. The paragraph below records the reasoning that first argued for the
lane, because the trade it describes is real and only loses to what the content
turned out to be.

**Superseded rationale — hanging indent.**
The shipped header keeps the body at full column width, and the
`ThreadSpeaker.tsx` comment argues the position: a ~34px avatar lane in a
344px deck spends a tenth of the reading measure repeating what the header
already says. The PM weighed exactly that trade against the mobile-IM
convention and ratified the IM layout: the avatar forms a gutter, and all
*text* content of a block — header and body — shares one left edge (24px
avatar + one spacing-ladder gap ≈ 34px, leaving a ≈ 276px column, inside the
line-length range mobile IM has proven at exactly this width). Two things make
the lane earn its cost now: it carries a *portrait* — an identity signal in
itself, not a repeat of the name — and the shared left edge makes speaker
switches a pure scanning operation. Break-out rules: media
(`ThreadImageGallery`, image items) extends left to the avatar edge (the IM
wide-media convention); code blocks keep the column and their existing
`pre-wrap` behavior. Update the `ThreadSpeaker.tsx` rationale comment and the
spec's speaker section in the same change — the old argument must not survive
as text once the code stops embodying it.

**Upgrade 4 — the duration line is already the process disclosure.** Verified
against the shipped tree: the main speaker's `meta` is a `ButtonControl`
(`.thread-speaker-meta.thread-process-toggle`) carrying
`threadProcessSummary` — "Worked for …" once settled, ticking live through
`useTurnElapsedMs` — and toggling the Turn's process detail in place, while a
delivered report's meta stays a plain span because its disclosure surface is
the card itself. #544 landed exactly the behaviour this plan specifies, so
there is nothing to build here; it is listed to keep the contract complete and
to stop a later reader from "restoring" a separate process header.

**Unchanged by design (stated so the executing dev does not "fix" them):**

- `SubagentReport` card semantics and chrome: outlined, not filled — the
  outline says "a self-contained thing brought back from elsewhere" — task
  title over a clamped, faded body, the whole card one click opening the
  detail view per `agent-thread-rendering.md` §Agent Anchors And The Work
  Strip. **The mockup's violet border does not land** (B3/B4: card chrome
  stays neutral); identity color belongs to the avatar alone.
- Consecutive-speaker merge: shipped, participant-keyed (so a child and a
  same-typed parent never merge under one header); unchanged.
- User messages: `.thread-user-message` right-hand `--fill-3` bubble, no
  avatar — position is the reader's identity signal, and there is no user
  profile to draw a face from.
- Skill runs keep the `SkillIcon` treatment — no persona, no portrait.
- Concurrency: children of one type share a face by design; the report card's
  task title is the only disambiguator.
- Depth: the pushed detail view (`SubagentDetailView`) renders its transcript
  through the same speaker system; hierarchy is conveyed by the containing
  surface, never by the avatar.

**Virtualization.** `estimateTurnHeight` and `TRANSCRIPT_ROW_ESTIMATE_PX`
(`ThreadView.tsx`) must account for the taller header and the indent-narrowed
column; measured heights still win.

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
  validator. `main` is reserved: it is the presentation pseudo-key for the
  root agent, and the loader rejects it as a custom Role name (editor and
  parser both).
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

### 5. Spec amendments (same change as the code)

- `docs/spec/agent-thread-rendering.md` — the speaker section: portrait
  avatars over the letter disc (24px), persona + role-label header, the
  hanging-indent layout replacing the full-column rationale (the reversal in
  §3 Upgrade 3), the duration-line disclosure. §Agent Anchors And The Work
  Strip is untouched — anchor semantics do not change. (PR-A)
- `docs/spec/design-system/patterns.md` §Agent Thread Flow — add the
  portrait/persona identity rule (identity color lives on the avatar; card
  chrome stays neutral). (PR-A)
- `docs/spec/agent-subagent-threads.md` §Roles And Configuration —
  presentation fields, overlay precedence, the `main` pseudo-key reservation,
  the main profile, the naming principle, and the `nicknameCandidates`
  retirement. (PR-A; the editor contract joins in PR-B)
- Design guards (B11): the token/hex guards cover the new CSS; identity color
  stays on the shipped `--identity-tint-*` palette — no new color tokens.

### 6. Tests

Unit (core / main):

- "presentation parses and merges with project-over-user precedence"
- "presentationOverrides apply to built-in roles and main"
- "persona configuration leaves role catalog entries and hashes unchanged"
  (model-surface isolation)
- "identity resolution falls back persona → role name → letter avatar and never
  throws on an unknown role"

Renderer:

- speaker headers render persona + portrait through `resolveAgentIdentity`;
  an unknown/custom type falls back to the `agentAvatarColor` letter disc
- no renderer surface displays `agentNickname` (ThreadList, details dialog,
  registry-fed surfaces all go through the resolver)
- the duration line toggles the process block; live vs completed copy
- the hanging indent holds one text edge for header and body; media breaks out
  to the avatar edge (guard-style DOM/CSS assertions)
- "a custom Role named `main` is rejected" (loader)

PR-B: editor write → reload round-trip; duplicate-as-custom seeds correctly;
post-deletion transcripts render through the fallback chain.

Gate: visual verification in light and dark (the UI row of the gate table).

## Open Questions

- Art direction of the four portraits (flat illustration vs painterly) — a
  one-shot decision at production, PM-ratified at the PR-A gate, frozen
  afterward.
- Whether the editor should also surface Configuration Profiles (root
  execution defaults) — out of scope here; candidate for a future plan.
