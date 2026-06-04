---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-04
---

# Unified Command Surface

## Goal

Collapse the two overlapping command/search surfaces — the in-app `Cmd+K`
`CommandPalette` and the global launcher — into **one** context-aware command
surface. Not "one absorbs the other": there is only **one** surface, summoned the
same way everywhere, with the same UI and the same logic. The **only** difference
between contexts is the **ambient context auto-attached at summon time** — context
is a passive attachment, never a mode the user picks.

This plan records the **design decisions ratified by the PM** (a co-design pass,
2026-06-04, grounded in a product survey of launchers, PKM/outliner apps, and AI
products — see "Research basis"). It is the *what + how direction*. The
**implementation one-pager** (phase sequencing, file scope, tests) is left for a
dev agent to draft when the work is scheduled (after `search-retrieval-stack`
Phase 2), with the PM ratifying that build plan before code.

## Non-goals

- **No in-editor `/` rewrite.** The in-editor triggers (`/` block insertion,
  `@` references, `#`/supertags) stay separate and fixed — they are *positional*
  (insert at the caret), a job a global modal cannot do. They are NOT unified into
  this surface (decision #5).
- **No new AI runtime.** "Ask AI" is an *entry point* into the existing agent
  (`AgentChatPanel`), not a new AI surface (decision #3).
- **No search-backend work here.** The shared node retrieval kernel is
  `search-retrieval-stack`'s territory (codex, #107). This plan consumes it.
- **No arbitrary-app Accessibility reading in v1** (decision #4) — deferred,
  fragile, and a heavy A3 surface.

## Model baseline

- **One surface, one global hotkey `Cmd+Shift+Space`, everywhere** — in-app AND
  when Tenon is not focused. `Cmd+K` retires (a plain `Cmd+K` cannot be a
  system-global accelerator without hijacking it in every app).
- **Context is the ambient attachment**: in-app = the currently **focused node**
  or the **selected nodes**; out-of-app = the foreground app (e.g. the active
  browser tab).
- **Action model = `Target × Verb`.** A small, universal verb set —
  **Go to · Capture · Reference · Tag · Ask AI · Run command** — where the
  attached context decides which verbs are available and which is the default.

## Design (ratified decisions)

### D1 — The Enter contract (spine: WYSIWYG)

**Enter always fires the highlighted row's primary action**, and every row shows
its primary verb inline (`↵ Go to`, `↵ Capture to Today`, `↵ Tag #x`). Context
only changes *which rows appear*, *which is pre-highlighted*, and *each row's
primary verb* — it never changes the rule "Enter = the highlighted row." This is
the predictability spine (Raycast/Superhuman): what you see highlighted is what
Enter does, even as you type (typing moves the highlight to the top match).

### D2 — Default-highlight policy (context-forward + habit-adaptive)

On summon (empty query) the surface **auto-highlights the ambient/contextual
default action**, and **learns from habit**: the verb the user most often picks in
a given context is promoted to the default. Cold-start uses a seed default per
context; habit then overrides it.

- **Learning granularity:** v1 = per-context-type (foreground-tab / focused-node /
  selection); supertag-level (per node type) is a v2 extension. *(provisional)*
- **Predictability guard:** adaptation is slow, explainable, and
  inspectable/resettable; never jumpy. The D1 WYSIWYG label is what keeps an
  adaptive default safe — even if the default verb changed, you see it before
  pressing Enter.

### D3 — Reversibility tier (B): what may be a blind-Enter default

- **Additive / instantly-undoable** verbs — Capture, Go to, Tag, Reference,
  Ask AI — **may** be the auto-highlighted blind-Enter default (with an undo
  toast where they mutate).
- **Lossy / irreversible / external** — Move, Delete, anything that loses data or
  sends outward — **never** auto-default; they require an explicit pick or a
  confirm step.

(We are event-sourced + undoable per A4, so the additive/undoable set is safe to
fire on Enter; the tier only fences the genuinely destructive verbs.)

### D4 — Context chip model (chip rail)

The attached context renders as a **chip rail**: ambient context pre-filled as
chip(s); the user can `@`-add more targets (nodes, tabs, saved views) into **one
namespace**; each chip is removable. Chips are **named, type-iconed, and always
visible** (never silent). Removing all chips falls back to global/no-target search.

The highlighted verb **consumes the chip set per its arity**:

- **Go to** — single target (the highlighted node), ignores extra chips.
- **Capture** — content comes from the query/context; the **destination** is a
  separate single target (default Today; picker ties `launcher-capture-destinations`).
- **Tag / Reference / Ask AI** — operate on the **whole chip set**.

**Rollout (provisional):** the rail is architected for multiple targets from day
one; v1 ships ambient pre-fill + removal; `@`-add turns on as the verbs that need
it (Ask AI, Reference) land.

### D5 — "Ask AI" routes to the agent panel; continues the session

"Ask AI" hands off to the existing `AgentChatPanel`: the **chip set becomes the
session context**, the typed query becomes the first message. AI has one home —
full power (tools, multi-turn, streaming), no duplicate AI UI.

- **Session:** continue the **current/last session** (the one currently loaded in
  the panel), appending the chips + query as a **new turn** — the chips attach to
  *that turn* and are visible, so history-vs-new-context stays legible (the
  Cursor/Claude/Dia model). A one-key **"new conversation"** escape (the panel's
  existing New Session) gives clean context on demand.
- **Conventions:** AI-written nodes carry **provenance** (visually distinct until
  accepted); the no-usable-provider guard **reuses #109** (Ask AI guides to
  Settings › Providers instead of failing at runtime).
- **Known trade-off:** routing everything to chat risks the "dead-end chat"
  pitfall. Mitigation is on the agent side — the agent has write tools (A4), so a
  conversation can produce nodes back into the outline; this becomes an
  *agent-behavior* concern (reliably turning answers into nodes), not a surface
  dead-end.

### D6 — Out-of-app context fidelity + fallback (phased)

- **Now:** active browser tab **URL + title** (the existing #103 path: read-only
  AX addon + `osascript` front-tab fallback) + **clipboard** as the fallback when
  the foreground isn't a supported browser.
- **Later (as `browser-extension-integration` lands):** rich **page content +
  selection** via the extension, plus **screenshot-as-context** as a deeper
  fallback (esp. for Ask AI on an unreadable foreground).
- **v1 excludes** arbitrary-app Accessibility reading (fragile; heavy A3 surface).
- **Conventions:** *visible-or-it-didn't-happen* — the out-of-app chip names the
  tier (`⧉ Safari — <title>` / `Clipboard` / `Screenshot`); read nothing → no
  context chip, degrade to plain capture. Reading foreground content is A3-locked
  (#103); any expansion needs a security-review gate. The fallback is an **ordered
  chain**: structured read → URL+title → clipboard → screenshot → manual.

### D7 — In-editor `/` stays separate (disjoint, not unified)

The in-editor `/` (and `@`/`#`) command set is **fixed and separate** from this
surface — they are the *at-caret* versions (insert here). The surface holds the
*operate-on-target* versions (Reference/Tag the focused/selected node). **Guard:
keep the two sets disjoint** — no command reachable from both — so there is never
a "which surface holds this?" confusion (the Logseq pitfall). Same concept, two
mechanics, independently implemented.

### D8 — Architecture invariant: one engine, context-as-pure-function

There is **one command/verb engine** everywhere. **Verb availability is a pure
function of `(attached context, query)`** — never a per-surface hardcoded reduced
set. Out-of-app shows fewer verbs *only because* its context (a browser tab, not a
node) makes fewer verbs applicable, not because the out-of-app surface is a
crippled build. This is the invariant that makes "one surface" true rather than
aspirational, and it generalizes the already-shared `search_nodes` path to the
whole verb engine. (Avoids the Tana failure mode, where the Global Clipper dropped
the command line and fields and broke the "same logic everywhere" promise.)

## Research basis

Decisions were grounded in a 2026-06-04 product survey across three categories:

- **Launchers / command surfaces:** Raycast (Action Panel = `Target × Verb`;
  AI Commands + Quick AI = AI as one launcher verb; `@`-context attachments),
  Alfred Universal Actions (content-type → verb set), macOS 26 Spotlight (actions +
  Quick Keys + clipboard-as-context), Linear `⌘K` (selection-scoped verbs),
  Superhuman (reorder-don't-hide; predictable ranking), Slack (cost of splitting
  navigate/search/act), VS Code (sigil scopes), Arc `⌘T`/Little Arc (same surface
  in-app and unfocused) **and the Arc→Dia warning** (don't let AI chat swallow the
  command bar — Ask AI stays one verb, not the center).
- **PKM / outliner:** Tana (Global Clipper on `Cmd+Shift+Space`, supertag/field
  commands — **and its retreat from parity**, the D8 anti-lesson), Notion
  (positional slash vs modal `Cmd+K`, the D7 reason), Obsidian/Logseq (divergent
  command sets = the D7 pitfall; no native global capture = the differentiator),
  **Things Quick Entry + Autofill** (ambient context auto-attached since 2017 —
  the D6 precedent), Capacities (2025 search+command merge), Mem (also
  `Cmd+Shift+Space`, unified global modal).
- **AI products:** Cursor (context chips, auto + `@`-added in one namespace — D4),
  ChatGPT "Work with Apps" (frontmost-app banner = "visible-or-it-didn't-happen",
  D6), Raycast AI (AI verb in the unified launcher — D5 validation), Apple Writing
  Tools (implicit selection-as-context), Notion AI (result routing: Replace /
  Insert / Discard), Dia (`@tab` context chips).

## Open questions (for the build one-pager)

1. **Cold-start seed defaults** per context — especially in-app *focused-node +
   empty query*: what seed verb before habit kicks in (Ask AI? New child?)? D2.
2. **Habit-learning granularity** — confirm v1 per-context-type; spec the
   supertag-level v2 trigger.
3. **Per-verb arity rules** — precise consumption of the chip set per verb (D4),
   and the Capture **destination** picker (default Today; ties
   `launcher-capture-destinations`).
4. **AI provenance** — how AI-written nodes are visually marked until accepted
   (ties agent event-log rendering).
5. **"New conversation" affordance** from the surface into the panel (key + UX).
6. **Screenshot-as-context** handling for Ask AI (vision) when the fallback lands.
7. **Hotkey migration** — `Cmd+K` retirement; does `Cmd+Shift+Space` cover the
   in-app summon cleanly, or keep `Cmd+K` as a temporary in-app alias to the same
   surface?

## Dependencies & sequencing

- **Sequence after `search-retrieval-stack` Phase 2** (the shared node retrieval
  path) — otherwise this is built against an interim search interface (A7).
- **Coordinates with the launcher follow-ups** (cc-2): `launcher-ai-actions`
  (the Ask AI verb), `launcher-capture-destinations` (Capture destination picker),
  `browser-extension-integration` (D6 rich content). This plan is the umbrella
  vision those slices feed; it does not own those plan files.
- **Reuses #109** (`agent-empty-state-onboarding`) for the no-provider guard on
  Ask AI.

## Collision self-check (2026-06-04)

Open PRs: none. The eventual build will touch `CommandPalette.tsx`, the launcher
(`src/main/launcher/*`, `src/renderer/launcher/*`), the agent panel, and the
command/verb engine — overlapping with the launcher follow-ups (cc-2) and the
verb/retrieval engine (`search-retrieval-stack`, codex). Because build is
**deferred** (after `search-retrieval-stack` Phase 2), there is no active
collision now; the build one-pager must re-run this check and coordinate
sequencing with whatever launcher/retrieval branches are then in flight.

## Checklist (design phase)

- [x] Ratify the model baseline (one surface / one hotkey / context-as-attachment
  / `Target × Verb`).
- [x] Ratify D1–D8 (Enter contract, default-highlight, reversibility tier, chip
  model, Ask AI routing, out-of-app fidelity, slash boundary, engine invariant).
- [ ] Dev agent drafts the implementation one-pager (phases, file scope, tests),
  PM ratifies — **after `search-retrieval-stack` Phase 2**.
