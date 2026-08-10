# Media Search Alignment

Search's media model is aimed at a node type that does not exist, and blind to the
one that does.

`src/core/types.ts` still carries `EmbedNode` (`embedType` / `embedId` /
`sourceUrl`) and `'embed'` in `NodeType`, from an early plan to render external
links as rich cards. **No renderer was ever built and no command produces such a
node.** On top of that dead type, `searchEngine.ts` builds live semantics:
`HAS_AUDIO` and `HAS_VIDEO` resolve a media kind from `embedType` or a media URL,
and `IS_TYPE embed` matches the type directly — so all three can only ever return
nothing. Nobody can reach them from the UI either; the sole consumer is the agent,
which `agentNodeToolGuidance.ts:53` explicitly tells that these facets are
available.

Meanwhile `AttachmentNode` — the real carrier of every audio file, video, and PDF
since `file-attachments` (#204/#206) and `file-as-node` (#241) — is absent from
`isSearchCandidate`'s type allowlist (`searchEngine.ts:2084`:
`tagDef|fieldDef|search|codeBlock|image|embed`). An attachment cannot be found by
text, by type, or by any facet, while its sibling `image` type can.

This plan removes the model built on the type that never existed, and rebuilds it
on the type that does.

## Goal

The node types search knows about are exactly the node types that carry media: the
dead embed schema and its unreachable facets are gone, attachments are findable,
and `HAS_AUDIO` / `HAS_VIDEO` / `HAS_MEDIA` answer from `AttachmentNode`'s own
metadata.

## Non-goals

- **No rich link card, metadata fetch, poster asset, provider override map, or
  live iframe embed** — the path not taken below stays not taken.
- No preview, player, or viewer work; this is retrieval only.
- No migration. Pre-release, a format change wipes `~/.lin-outliner-*` dev
  userData rather than shipping a reader (`AGENTS.md`), and independently no
  `type: 'embed'` node has ever been creatable, so no document contains one.
- No change to text ranking beyond admitting a node type that was excluded.

## Design

Shape **(b): a set of independent complete features**, two PRs, ordered by a
genuine dependency — PR 1 is a protocol-surface change that lands isolated so
siblings rebase once, and PR 2 rebuilds on the ground it clears. Each is
independently shippable and independently useful.

### PR 1 — Remove the dead type and its unreachable facets

- Delete `EmbedNode` (`embedType`, `embedId`, `sourceUrl`), `'embed'` from
  `NodeType`, and the Loro key registrations and codec/validation branches that
  read them.
- Delete `HAS_AUDIO` and `HAS_VIDEO` from `QueryOp` and their implementations;
  `nodeEmbedFields` and `mediaKindFromNode` collapse with them. Delete
  `IS_TYPE embed`.
- `HAS_IMAGE` stays as-is — `ImageNode` is real and produced. `HAS_MEDIA`
  degenerates into an alias of `HAS_IMAGE`; keeping it as the superset PR 2 grows
  or folding it into `HAS_IMAGE` is the dev's call, recorded in the PR.
- Strike the media clause from `agentNodeToolGuidance.ts:53` in the same change.
  **A facet that silently matches nothing is worse than an absent one**: the agent
  is instructed that it exists, uses it, gets an empty result, and reports absence
  as evidence. That is the reason this deletion is not merely cleanup.
- Rewrite `tests/core/searchEngine.test.ts`'s media test against what survives
  rather than deleting it — it currently encodes the embed-era model in its own
  comments.

`src/core/types.ts` is an infrastructure-ownership file, so this lands isolated and
siblings rebase once after it merges. Verification: `typecheck` (the compiler finds
every reader of the removed fields), `test:core`, and a grep proving no
`embedType` / `embedId` / `'embed'` reference survives outside the change.

### PR 2 — Admit attachments to search, rebuild the facets on them

- **First, confirm the omission was an oversight rather than a decision.** Check
  `isSearchCandidate`'s allowlist against the `file-attachments` (#204/#206) and
  `file-as-node` (#241) PRs before treating it as a bug; the asymmetry with `image`
  suggests attachments simply arrived later and the allowlist was never revisited,
  but that is a hypothesis, not a finding.
- Add `attachment` to the allowlist so attachment nodes are retrievable at all, and
  add `IS_TYPE attachment`.
- Reintroduce `HAS_AUDIO` / `HAS_VIDEO` reading `AttachmentNode.mimeType` as the
  authority, with `audioDurationMs` / `videoDurationMs` available as corroboration;
  extend `HAS_IMAGE` to image-mime attachments; `HAS_MEDIA` becomes the real
  superset (image nodes plus media attachments) rather than an alias.
- Restore the guidance clause in `agentNodeToolGuidance.ts` with the accurate
  operand list, so the model regains the capability only once it answers truthfully.
- User-visible: attachment rows begin appearing in ordinary text results. Their
  title is the filename, which is what a user searching for "tax return 2025"
  is looking for — but it is a result-set change and belongs in the CHANGELOG
  entry.

## Open questions

- Was `attachment`'s absence from `isSearchCandidate` deliberate? Settle this
  before PR 2's shape is fixed; if it was deliberate, PR 2 becomes facets-only over
  a narrower candidate rule.
- `HAS_MEDIA` through PR 1: keep as an image alias, or remove and reintroduce in
  PR 2? Keeping it avoids a second `QueryOp` churn; removing it keeps PR 1's rule
  ("delete every predicate that cannot answer") uniform.
- Does PDF deserve its own facet, given `pdfPageCount` already exists, or is the
  mime family enough?
- Does admitting attachments change the results of any saved search enough to
  warrant more than a CHANGELOG line?

## Path not taken

A locally-cached metadata card — fetch OpenGraph/oEmbed at capture time, store a
poster as an asset, render title/description/source offline — was the standing
recommendation for embeds until 2026-08-03. It was never scheduled, and it lost on
**positioning rather than cost**: Tenon "uses an outliner-shaped interface, but the
product is aimed at structuring context, directing local agents, and keeping work
inspectable" (`README.md`). Captured material earns its keep by being findable and
agent-readable, not by looking rich; a metadata card is what a read-later product
needs, and this is not one. The same ruling is what lets `unified-command-surface`
keep capture to a plain node in Today, and it lowers the priority of
`launcher-provider-expansion`, whose breadth pays off mainly through richer
presentation. Recorded here so the decision is not silently re-opened; the
alternatives it beat are in git history (absorbed from `embed-strategy.md`,
2026-08-10).
