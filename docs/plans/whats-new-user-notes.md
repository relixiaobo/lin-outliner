# What's New in User Language

Settings' What's New currently renders a release's entire changelog section —
hundreds of engineering-register entries no user can read, most describing work
irrelevant to their experience. The changelog serves two audiences from one
file; this plan gives each release **two altitudes in the same section** instead
of two files that would drift.

## Goal

- The What's New pane shows a short, user-register note per release ("you can
  now…", "fixed … you may have hit"), never the categorized engineering detail.
- `[0.1.0]`'s note is a product welcome — what Tenon is and does — not a change
  record; a first release has no "previous version" to diff against.
- The GitHub Release body leads with the same note, so both user surfaces read
  from one source.

## Non-goals

- No separate release-notes file — a second description of one release drifts
  (see `docs/lessons.md`); the note lives inside `CHANGELOG.md`.
- No i18n of note content for now: notes are English, like the changelog. If
  real demand appears, routing notes through the i18n message system is a
  separate decision.
- No change to the engineering categories (`### Added` … `### Internal`) — they
  remain the project ledger, read on GitHub.
- No in-app rendering of category detail, not even collapsed.

## Design

**Authoring convention (the contract).** Each `## [x.y.z]` section opens with a
user-register note block — everything between the version heading and the first
`###` heading. At release freeze, the main agent drafts the note from the
section's entries and the PM ratifies it as part of the release; the rule lives
in `AGENTS.md`. The note contains **only** user language; provenance or
engineering framing moves under `### Internal`.

**Renderer.** The release body already parsed by `src/core/changelog.ts` is
split at the first depth-3 heading: the pane (`SettingsAboutSection.tsx`)
renders only the note, followed by a single external "Full changelog" link to
the version's section on GitHub (pinned to the tag, e.g.
`blob/vX.Y.Z/CHANGELOG.md`). The existing Internal-stripping stays correct but
no longer determines what users see. A build resolving to `[Unreleased]` keeps
today's fallback and shows that section's (short) stub as its note.

**Release body.** `scripts/release-notes.ts` lifts the note block plus the
Installing footer instead of the whole section. A missing or empty note block
exits non-zero — a release without a user note is a mistake worth stopping for,
same as a missing section today. The oversized-body counted-summary fallback
retires with the cause (a note cannot approach GitHub's 125k limit).

**Robustness.** The pane and the script must both degrade sanely for a version
section that predates the convention (no note block): the pane falls back to
the "Full changelog" link alone rather than dumping categories; the script
fails loudly (releases are cut going forward, so the strict side belongs
there).

## Out of scope for the dev PR (main-agent-owned, landing separately)

The `[0.1.0]` welcome note text, the `AGENTS.md` freeze rule, and the
`package.json` dial to `0.2.0` are `CHANGELOG.md`/`AGENTS.md`/infrastructure
edits owned by the main agent. The dev PR must not assume the welcome text has
already landed (see Robustness).

## Shape

**(a) One complete feature in one PR**: renderer + `release-notes.ts` + spec
(`docs/spec/design-system/surfaces.md` owns the About pane; adjust where the
What's New behavior is specced) + tests.

## Verification

- Renderer tests: note-only rendering; no category headings in the DOM; the
  external link targets the tag-pinned changelog anchor; missing-note fallback.
- Script smoke: note extraction; non-zero exit on a missing/empty note.
- `bun run typecheck`, `test:renderer`, `docs:check`; light/dark visual pass on
  the About pane.

## Collision

`SettingsAboutSection.tsx` / `src/core/changelog.ts` were last reshaped by
settings-redesign (#488, merged) — stable now. `scripts/release-notes.ts` is
main-owned but small and single-purpose; coordinate via this plan's PR. No open
PR (#492, #493) touches these files.
