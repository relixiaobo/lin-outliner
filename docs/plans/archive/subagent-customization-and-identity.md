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
- **Expressions and gaze (PM-ratified into PR-A).** The demo's full rig ships:
  moods as parameter sets over one stroke rig (`agentMarkGeometry`, pure and
  invariant-tested — silhouette containment swept over every mood × pose),
  morphing transitions, spherical pose with limb foreshortening, header-hover
  gaze pursuit with inertia, and the working line-scan. Moods wire to state
  the transcript already knows: the Turn's status for the conversation's own
  agent (working / needs-you / failed / interrupted→stopped / idle), the
  registry entry's outcome for a delivered report (done / failed / stopped).
  Expressions RESTATE the adjacent status text; they never carry information
  of their own. Blinking is a rig parameter rather than a CSS transform, so the
  stylesheet carries no motion literal and no scale — both are product-wide
  design guards. One module-wide rAF loop, ref-driven, animating only marks in
  motion and only while on screen (A9), re-entry-guarded against synchronous
  schedulers; `prefers-reduced-motion` keeps static mood shapes with nothing
  moving.

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

Surface: an **Agents page under the Agent settings category**, beside Model
services and Skills. `SettingsAgentSection.tsx` already states the rule — a
collection the user installs or connects, unbounded and carrying its own
lifecycle, earns a page — and identities are exactly that. (This supersedes the
earlier guess of a pane beside `ProviderConfigWindow`, which would have been a
second window for something that is neither modal nor credential-bearing.)
Exact placement was the reversible local decision; the contract below is not.

- **List.** The user's own Roles first, then the built-ins; each row shows the
  generated mark + persona + what it is. A Role appears in exactly one group,
  even though it is also an Agent type in the catalog — two groups would mean
  two editors for one identity, one of which could not delete it.
- **Built-ins and main: presentation editable, behavior locked.** Persona (text
  field) and colour (a picker whose swatches are the mark itself, drawn in each
  identity-palette hue) write to `presentationOverrides` in the chosen layer.
  Behaviour is stated as locked rather than shown read-only: the built-in
  instructions are code, not configuration, so displaying them would invite an
  edit the surface cannot accept. **"Duplicate as custom Role"** ships (see §4b):
  `listBuiltInDefinitions` exports the frozen definitions as seed data, so the
  copy starts from the real thing rather than a blank form.
- **Custom Roles: fully editable.** Canonical name (loader validation via
  `normalizeSelectedName`; renaming = create + delete), persona, colour,
  description, `developerInstructions`, and `overrides` (model,
  reasoningEffort, tools). Validation reuses the loader's existing validators
  and parity's Role tool-admission semantics — do **not** build a second
  validator. `main` is reserved: it is the presentation pseudo-key for the
  root agent, and the loader rejects it as a custom Role name (editor and
  parser both).
- **Scope.** Create-time choice of layer: user
  (`<userData>/agent/config.json`) or project (`<cwd>/.tenon/agent.json`,
  git-shareable); shown on the row.
- **Write path.** Four commands — `agent_identity_catalog`, `agent_write_role`,
  `agent_delete_role`, `agent_write_presentation` — handled in the main process,
  so config file IO stays behind the process seam (A2), and decoded at that
  boundary rather than cast through it. Whole-file read-modify-write on the JSON
  layer, with the candidate validated **in memory** by the loader's own decoder
  and only then written atomically: nothing reaches disk until it is known to be
  readable, so there is no write-then-rollback window (a write boundary fails
  closed, A12). Only the layer being written is validated. A malformed existing
  file is reported, never replaced. A Role's `overrides` are merged rather than
  replaced — the editor shows no field for them and must not destroy them — and
  the write carries a create/update intent so create cannot silently replace an
  existing definition. Every successful write answers with the refreshed
  editable view and broadcasts the settings-changed notification the settings
  window already uses, scoped away from its own sender — which is where the
  deferred `profiles/changed` earns its keep, without a second notification
  channel meaning the same thing.
- **Deletion semantics.** Deleting a Role affects future spawns only: running
  children keep their resolved configuration; historical transcripts degrade
  through the identity fallback chain (§1). Confirmation dialog; no cascade.

### 4b. The rest of the configuration surface (folded into PR-B)

Four gaps closed in the same PR, at the PM's direction:

- **The persona is the agent's own name.** It reaches the L2 identity block and
  `replyIdentity` for the conversation agent AND its children, resolved per Turn
  rather than recorded at spawn. `Neva` retires; `Aspen` is the shipped default,
  anchored to `DEFAULT_AGENT_PRESENTATIONS.main`. Dispatch is untouched — the
  Role catalog and its `contentHash` still exclude presentation, so the model
  hands work to `explore` and `Rena` answers.
- **The conversation agent's Configuration Profile is editable** from its own row
  on the Agents page: standing instructions plus the capability ceiling. The word
  "Profile" never appears in the UI, and multiple named Profiles stay unexposed —
  they would need a per-conversation switcher that does not exist
  (`configurationProfile` is never set by the renderer).
- **Capabilities** (tools, Skills) are checkbox lists on both the Profile and a
  Role, all checked by default, written as absence when nothing is unchecked.
- **Duplicate** seeds a new Role from a built-in's real definition, which is what
  makes "built-ins are not editable" a livable rule rather than a dead end.

Deliberately still out: `plugins` / `mcpServers` have no field (merged, never
destroyed), and the app-level subagent depth/concurrency/budget knobs stay
JSON-only — they are tuning, not identity.

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

PR-B (`agentConfigurationWriter.test.ts`, `agentsSettings.test.tsx`): a written
Role comes back as an Agent type; `main` is refused as a Role name; an unknown
colour and a loader-rejected candidate both leave the file byte-identical; an
unparseable layer is reported rather than rewritten; the last Role's deletion
removes the section rather than leaving `roles: {}`; clearing a presentation
removes the override so the built-in default shows through; project beats user
for one type. In the editor: a Role appears in one group only; a built-in offers
no Delete and no definition fields; re-skinning writes a presentation and never
a Role; saving carries the WHOLE definition, not just the edited fields; an
existing Role's type is fixed; a refused write reports the boundary's own
sentence and leaves the dialog standing.

Note on the harness: React's synthetic `onChange` is not deliverable under
linkedom (only `onInput` is), so these judges assert what a save CARRIES rather
than simulating keystrokes. `DateValuePicker` wires both handlers for the same
reason.

Gate: visual verification in light and dark (the UI row of the gate table).

## Open Questions

- Art direction of the four portraits (flat illustration vs painterly) — a
  one-shot decision at production, PM-ratified at the PR-A gate, frozen
  afterward.
- Whether the editor should also surface Configuration Profiles (root
  execution defaults) — out of scope here; candidate for a future plan.
