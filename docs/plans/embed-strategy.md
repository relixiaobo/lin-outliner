# Embed Schema Removal

`src/core/types.ts` still carries `embedType` and `embedId`, and `NodeType` still
carries `'embed'`, from an early plan to render external links (YouTube, Twitter)
as rich cards. **No renderer was ever built, and no command produces such a node.**
The schema is dead weight in the protocol surface.

Remove it.

## Goal

Delete `embedType`, `embedId`, and the `'embed'` node type, so an external link is
what it already is everywhere in practice: text carrying a `link` mark.

## Non-goals

- No rich link card, metadata fetch, poster asset, or provider override map.
- No live iframe embed.
- No migration (see below).

## Why removal rather than a card

Positional, not technical. Tenon "uses an outliner-shaped interface, but the
product is aimed at structuring context, directing local agents, and keeping work
inspectable" (`README.md`). Captured material earns its keep by being **findable
and agent-readable**, not by looking rich. A metadata card is what a read-later
product needs, and this is not one.

The same ruling is what lets `unified-command-surface.md` keep capture to a plain
node in Today, and it lowers the priority of `launcher-provider-expansion.md`,
whose breadth pays off mainly through richer presentation.

## Design

1. Remove `embedType` and `embedId` from `Node` in `src/core/types.ts`.
2. Remove `'embed'` from `NodeType`.
3. Delete the codec/validation branches that read them.

**No migration, and nothing to migrate.** Pre-release, a format change wipes
`~/.lin-outliner-*` dev userData and deletes the old reader rather than shipping a
migration or compatibility branch (`AGENTS.md`). Independently, no `type: 'embed'`
node has ever been creatable — there is no renderer and no command that produces
one — so no document contains one to convert.

## Shape

**(a) One complete change in one PR**, and a small one. `src/core/types.ts` is an
infrastructure-ownership file, so it lands **isolated** rather than folded into a
feature PR, and siblings rebase once after it merges.

## Verification

`typecheck` (the compiler finds every reader of the removed fields), `test:core`,
and a grep proving no `embedType` / `embedId` / `'embed'` reference survives
outside this change.

## Path not taken

A locally-cached metadata card — fetch OpenGraph/oEmbed at capture time, store a
poster as an asset, render title/description/source offline — was the standing
recommendation until 2026-08-03. It was never scheduled, and it lost on
positioning rather than cost. Recorded here so the decision is not silently
re-opened; the reasoning and the alternatives it beat are in git history.
