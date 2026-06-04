---
status: draft
priority: low
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-13
---

# Outline syntax: one canonical token grammar in `core`, not three copies

A proposal for how the outline parsers should relate. Two of them are full
parsers — `src/main/agentOutlineParser.ts` (agent serialization) and
`src/renderer/ui/interactions/pasteParser.ts` (clipboard import) — and a third,
lighter consumer, `src/renderer/ui/interactions/rowInteractions.ts` (the live
`#`-trigger as you type), also decides *"what is a tag."* The paste-parity work
it once waited on has since merged (**PR #113**), so the paste-side token regexes
are in their final shape; this proposal refactors on top of what landed.

This plan started as the question *"do we really need two parsers?"* The honest
answer, after analysis, is **"two parsers — but they (and the live-edit trigger)
must not own three different definitions of the same token."** What follows is the
evidence and the recommended shape, with the maximal "merge everything" option
spelled out and deliberately rejected so the path-not-taken is on record.

## Goal

- Settle the **architecture relationship** between the parsers so none of them
  silently redefines a shared concept (the live example: `#tag` recognition is
  Unicode + bracket-aware on the agent side, ASCII-only on the paste side, and a
  third character class again in the live `#`-trigger).
- Establish a **single source of truth** for the token-level grammar every
  consumer agrees on: what is a tag (and, secondarily, what is a checkbox marker).
- Do this at the **right size** — extract what is genuinely shared at the *token*
  level, and leave genuinely divergent *structure* (indent rules, list markers,
  field models) where it lives. Not a rewrite.

## Non-goals

- **Merging the parsers into one.** Rejected below (Option A) — the field models
  and the formatting models genuinely differ; a forced merge either bloats the
  agent-facing format or drops paste's rich formatting.
- **Unifying *structure*** — indent rules, list-marker sets, field models. Those
  are legitimately divergent (the agent's strict `- ` round-trip format vs paste's
  permissive `-*+` / numbered / glyph list). Only *token*-level grammar is shared.
- Changing any consumer's *behavior* beyond the tag-consistency fix. This is a
  structural refactor, not a feature.
- Touching the `node_*` tool materialization path (`agentNodeTools.ts`) — it does
  not go through either parser for create, and is out of scope.

## Background — why there are two parsers (and three tag definitions)

| | `agentOutlineParser.ts` (main) | `pasteParser.ts` (renderer) |
|---|---|---|
| Direction | **Bidirectional** — parse *and* serialize (`agentNodeToolRead.ts`) | **Import only** — clipboard → nodes |
| Consumers | `documentService`, `agentNodeTools`, `agentNodeToolSearch` | `RichTextEditor.tsx` |
| Output | `OutlineNode` — **plain-string** `title`, `fields[]`, `tags[]`, `checked` | `CreateNodeTree` — **RichText** content (marks), `codeLanguage`, images |
| On malformed input | **Throws** (tabs, odd indent, non-`- ` lines) — the LLM must round-trip cleanly | **Lenient** — best-effort, never throws; a human paste must always land *something* |
| Identity / refs | `%%node:id%%` markers, `[[node:id]]` references, `%%search/view%%` directives | none |
| Field model | field is a **child line** (`- name:: value`) | field is **inline trailing** (`title name:: value`) |
| Rich formatting | **none** — title is plain text | marks, code fences → `codeBlock`, bare URL → link, `<br>` split, HTML/DOM |

A third, lighter consumer also answers *"what is a tag"*: the live `#`-trigger in
`rowInteractions.ts:22` (`/#([^\s#@]*)$/u`) that fires the tag autocomplete as you
type. It is not a full parser, but it carries its own tag character class — a
third copy of the definition.

The reason there are two *parsers* is not "human input is messy, agent input is
clean" (the shallow framing). The real reasons are structural and each is
load-bearing:

1. **The agent parser is a serializer too.** `node_read` serializes the document
   to this grammar, `node_edit` does exact `old_string`/`new_string` replacement,
   and `%%node:id%%` is stable identity across the round-trip
   (`docs/spec/agent-tool-design.md`). Paste has no reverse direction and no
   identity — it is a one-way lossy importer.
2. **The agent grammar deliberately omits rich formatting.** Its title is a plain
   string by design — the LLM should not have to read or emit bold/italic/code-fence
   syntax to edit a node, and str-replace gets more fragile if it does. Paste's
   entire value-add is the opposite: turn `**bold**`, ` ```ts `, `[text](url)`,
   `<br>`, and HTML into structured rich content.
3. **The field models are different shapes**, not different strictness — child
   line vs inline trailing. Neither is reducible to the other for free.

So the parsers are *legitimately* two. What is **not** legitimate is that the
token-level grammar has been copied into three places and the copies have
**already drifted**:

- `#tag` — three answers in one product:
  - **agent** (`agentOutlineParser.ts:234`): Unicode body `[\p{L}\p{N}_-]` + two
    bracket forms (`[[#tag]]`, `#[[tag]]`), and it **excludes hex-color literals**
    via the shared `isCssHexColorToken` (`core/textSyntax.ts`).
  - **live edit** (`rowInteractions.ts:22`): any non-space / non-`#` / non-`@` run
    (so Unicode is accepted), and it **also excludes hex** via the same
    `isCssHexColorToken`.
  - **paste** (`pasteParser.ts:148`): ASCII only (`[A-Za-z][\w-]*`), no bracket
    forms, and **no hex guard** — so a pasted `#fff` becomes a spurious `fff` tag
    while a typed `#fff` does not.

  The hex predicate is *already* extracted to `core/textSyntax.ts` and shared by
  two of the three consumers; paste is the lone holdout. The tag *matcher* itself
  is still copied three times.
- checkbox — agent (`agentOutlineParser.ts:150`) and paste (`pasteParser.ts:210`)
  both read `[x]`/`[X]` as checked and `[ ]` as unchecked — the same meaning, two
  regexes.

That drift is the actual defect. The fix is not "one parser" — it is **one
definition of each shared token in `core`, imported by every consumer.**

## Design — the recommended shape (Option B)

The shared home **already exists**. `src/core/textSyntax.ts` is a pure module (no
DocumentState, no DOM, no Node) that today exports `isCssHexColorToken` and is
imported by `agentOutlineParser.ts` (main) and `rowInteractions.ts` (renderer) —
proving `core` is importable from both process seams. **Extend it** with the rest
of the canonical token grammar rather than adding a new file:

```
src/core/textSyntax.ts   (existing pure module — extend, don't replace)
    isCssHexColorToken(value)                              // already here
  + TAG_TOKEN                                              // the one canonical tag matcher
  + extractTags(line): { tags: string[]; rest: string }
  + formatTag(name): string                                // so serialize ⇄ parse agree
  + parseCheckboxMarker(line): { checked: boolean; rest: string } | null   // `[x]`/`[ ]`
```

`TAG_TOKEN` is the reconciled union of today's three copies: Unicode body
(`[\p{L}\p{N}_-]`) + the two bracket forms (`[[#tag]]`, `#[[tag]]`) + the
`isCssHexColorToken` exclusion already living in the same module.

Then:

- **`agentOutlineParser.ts`** imports `TAG_TOKEN`/`extractTags` instead of its
  private `TAG_TOKEN_PATTERN` (it already imports `isCssHexColorToken` from this
  module). Its strict structure layer (2-space indent, `- ` requirement,
  error-on-malformed at `:79-86`), identity markers, references, directives, and
  **field-as-child-line** parsing all **stay** — agent-only and correct.
- **`pasteParser.ts`** imports the same `TAG_TOKEN`/`extractTags` and
  `parseCheckboxMarker`. Its lenient structure layer (tab *or* 2-space,
  list-marker-derived depth, HTML/DOM walk, `<br>` split, markdown-vs-flat-HTML
  routing), its **inline-trailing field** harvesting with the conservative `:: `
  guard, and all rich formatting (marks, codeBlock, link, image) **stay** —
  paste-only and correct. **List markers stay here too** — the agent deliberately
  accepts only `- `, so a shared permissive `LIST_MARKER` would have exactly one
  consumer and does not belong in `core`.
- **`rowInteractions.ts`** (live `#`-trigger) adopts the canonical tag character
  class so "what counts as a tag character" agrees whether you type or paste. Its
  incremental at-cursor shape stays; only the character class is shared.
- The serializer (`agentNodeToolRead.ts`) routes its tag formatting through
  `formatTag` so parse and serialize can never disagree on tag syntax.

**What this buys:** one answer to "what is a tag," enforced by the type system
(every consumer imports the same symbol). The Unicode + bracket inconsistency is
fixed as a side effect — paste begins to recognize `#中文` and `[[#tag]]`, and
stops treating `#fff` as a tag, matching the agent and live-edit paths.

**What this explicitly does not touch:** structure rules, list markers, field
models, rich formatting, identity, error policy. Those are the
legitimately-divergent part.

### The tag-consistency decisions embedded here (PM-ratified 2026-06-04)

Adopting the canonical `TAG_TOKEN` on the paste side is a small **behavior
change**, and it is the point of the exercise. Two decisions, both confirmed:

1. **Exclude hex-color literals — bring paste in line.** The agent and live-edit
   paths *already* exclude them (`isCssHexColorToken`); paste does not, so this is
   new behavior for **paste only**. Definition: `#` followed by *exactly* 3, 4, 6,
   or 8 hex digits with a trailing word boundary is a color literal, not a tag.
   Excluded: `#fff`, `#ffff`, `#ffffff`, `#deadbeef`, `#cafe` (4 hex digits). Still
   tags: `#office` (the `i` is not a hex digit), `#fffff` (5 digits, not a valid
   color length), `#fff-bug` (extends past the boundary). Sharing `TAG_TOKEN`
   (built on the existing `isCssHexColorToken`) makes all three consumers agree.
2. **Recognize the bracket forms in paste.** paste begins to accept `[[#tag]]`
   and `#[[tag]]` (today agent-only). Harmless for human paste, explicitly wanted
   for consistency.

paste also gains Unicode tags (`#中文`) from the canonical matcher. The
conservative field `:: ` guard is **paste-only** and stays — the agent side has
no inline fields, so there is nothing to reconcile there.

## Options considered

### Option A — full unification (one canonical grammar + thin ends) — REJECTED

The maximal version of the original instinct: paste *normalizes* its input into
the agent's canonical grammar text, and a single parser handles both. Rejected,
for two concrete reasons, not taste:

1. **Formatting.** The canonical grammar has no marks / codeBlock / image. To
   route paste through it, we either (a) drop paste's rich formatting — a
   regression, the whole point of paste parity — or (b) extend the canonical
   grammar to model marks/fences/images. (b) bloats the **agent-facing** format:
   the LLM would then see and have to preserve bold/italic/fence syntax inside
   str-replace edits, making `node_edit` more fragile for zero agent benefit.
2. **Field model.** Paste's inline `title name:: value` would have to be
   normalized into the agent's child-line `- name:: value` *before* a single
   parser sees it — which means paste needs a structural pass anyway. The "single
   parser" never actually becomes single; it just moves the seam and hides it.

Full merge trades a real regression (or real agent-format bloat) for the
appearance of one parser. False economy. Recorded here so we do not relitigate.

### Option B — shared token module (extend `core/textSyntax.ts`) — RECOMMENDED

Above. Extend the existing shared module with the genuinely token-level grammar
(tag, checkbox); keep each parser's structure/format layer. Small, type-enforced,
fixes the real drift, and continues the consolidation `isCssHexColorToken` already
began.

### Option C — status quo — BASELINE

Do nothing; accept that `#tag` means three different things in three files.
Cheapest now, but the drift compounds: the next shared token (mention syntax, date
tokens, `==highlight==`) gets defined three times again, and they disagree the
first time one side changes.

## Migration cost assessment

| | Option A (full merge) | **Option B (shared tokens)** | Option C (status quo) |
|---|---|---|---|
| New code | a canonical-grammar normalizer + grammar extension for marks/fences | extend `core/textSyntax.ts` with `TAG_TOKEN`/`extractTags`/`formatTag`/`parseCheckboxMarker` (~60–100 LOC, mostly moved) | 0 |
| Files touched | both parsers (rewrite), `agentNodeToolRead`, agent format spec, every agent tool test | `core/textSyntax.ts` + both parsers + `rowInteractions.ts` (import swaps) + `agentNodeToolRead` (optional `formatTag`); `core/types` (none) | 0 |
| Behavior change | paste loses rich formatting **or** agent format gains formatting syntax | paste tag recognition widens to Unicode + bracket forms and gains the hex-color exclusion the other two already have | none |
| Risk | **high** — agent round-trip + str-replace contract is load-bearing; any regression there breaks the agent | **low** — pure functions, covered by existing `pasteParser.test.ts` + agent parser tests; no protocol/command change | none |
| Coordination | touches the agent format spec → cross-agent, plan-track | no protocol file → single PR | none |
| Payoff | none over B (and a regression) | single source of truth for shared tokens; three-way drift fixed | drift persists and compounds |

Option B is **not** a protocol change (`core/types.ts`, `core/commands.ts`
untouched) — the shared module is pure helper code. That keeps it a normal
single-PR refactor rather than a coordinated interface-first change.

## Recommendation

Do **Option B**. The `cc/outliner-paste-parity` work it waited on has **merged
(PR #113)**, so the paste-side regexes are in their final shape and the plan is
unblocked. Reject Option A. The first draft's "revisit only if a third consumer of
the grammar appears" caveat is already moot — the live-edit trigger *is* that
third consumer, which raises (not lowers) the payoff.

## Resolved decisions

- **Hex-color exclusion (PM, 2026-06-04): exclude everywhere.** *(Premise
  corrected 2026-06-13.)* The first draft asserted "neither parser excludes hex
  today"; in fact the agent and live-edit paths already exclude via
  `core/textSyntax.ts → isCssHexColorToken` — paste is the lone holdout. The
  canonical `TAG_TOKEN` (built on that same predicate) closes the gap. New
  behavior for **paste only**.
- **Bracket tag forms in paste (PM, 2026-06-04): allow.** paste adopts the
  canonical matcher's `[[#tag]]` / `#[[tag]]` forms. Folded in above.
- **Shared module home (2026-06-13): extend `core/textSyntax.ts`, do not add a
  new file.** The module already exists and is already imported across both
  process seams; the tag grammar belongs next to the hex predicate it depends on.
- **List markers stay per-parser (2026-06-13).** The agent accepts only `- `; a
  permissive shared `LIST_MARKER` would have exactly one consumer. It is
  structure, not token grammar — out of the shared surface.

## Open questions

- **Build graph — resolved.** `core/textSyntax.ts` is already imported by
  `agentOutlineParser.ts` (main) and `rowInteractions.ts` (renderer), so core is
  proven importable from both seams. No process-seam risk for the extension.
- **How far does the live-edit trigger adopt the canonical matcher?** The minimal
  fix shares only the tag *character class* (so type vs paste agree on Unicode and
  hex). Whether the at-cursor trigger should also honor the bracket forms is a
  smaller UX call to settle during implementation — bracket forms mid-type are
  unusual, so the default is "character class only."

## Checklist (only if ratified to build)

- [ ] Extend `src/core/textSyntax.ts` with canonical `TAG_TOKEN` / `extractTags` /
      `formatTag` / `parseCheckboxMarker` (alongside the existing
      `isCssHexColorToken`).
- [ ] Reconcile the three tag definitions into one matcher (Unicode + brackets +
      hex exclusion); add a unit test pinning each accept/reject case
      (`#中文`, `[[#tag]]`, `#fff`, `#fffff`, `#fff-bug`, `#office`).
- [ ] Swap `agentOutlineParser.ts` to import the shared tag helper (it already
      imports `isCssHexColorToken`); keep structure/identity/refs/fields/errors
      local. Re-run agent parser tests.
- [ ] Swap `pasteParser.ts` to import the shared tag + checkbox helpers; keep
      structure / list-markers / HTML / marks / inline-fields local. Re-run
      `pasteParser.test.ts`.
- [ ] Point `rowInteractions.ts` at the shared tag character class. Re-run
      `rowInteractions.test.ts`.
- [ ] Route the serializer's tag formatting through `formatTag`
      (`agentNodeToolRead.ts`).
- [ ] `bun run typecheck` + `bun test tests/core tests/renderer` + the paste e2e.
