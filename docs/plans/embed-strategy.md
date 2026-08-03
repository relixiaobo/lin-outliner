# Embed Strategy

The schema in `src/core/types.ts` still carries `embedType` and `embedId` for
historically representing external embeds (YouTube, Twitter). No renderer
exists. nodex ships `EmbedNodeRenderer.tsx`. Before we copy or rewrite that,
we need to decide whether embeds belong in a local-first app at all, and if
so in what form.

This plan is decision-first, implementation-second.

## Goal

Pick one of three paths and either implement it or remove the dead schema.

## Options

### A. Live iframe embed (nodex's approach)

Render embeds as iframes pointing at the source (e.g.
`youtube.com/embed/<id>`). Cheapest to build. Worst for local-first:
nothing works offline, the iframe can phone home, the embedded provider
controls what shows.

### B. Locally-cached metadata embed (recommended)

At embed time, the main process fetches OpenGraph / oEmbed metadata and a
poster image, stores the poster as an asset (see
[`asset-subsystem.md`](asset-subsystem.md)), and persists:

```ts
{
  id, type: 'embed',
  embedType: string,            // 'youtube' | 'twitter' | 'generic'
  embedUrl: string,             // canonical source URL
  embedTitle?: string,
  embedDescription?: string,
  embedPosterAssetId?: string,  // local thumbnail
  capturedAt: number,
}
```

Renderer shows a rich link card (poster + title + description + source).
Clicking opens the URL in the system browser or, optionally, expands an
iframe on-demand. Works offline (card stays), respects local-first, reuses
the asset subsystem.

### C. Remove embed schema

Drop `embedType` / `embedId` from `types.ts`, drop the `'embed'` node type.
Force users to paste a URL as text — the text becomes a regular inline
reference, perhaps decorated as a link via the existing `link` mark.

Lowest cost. Loses the "card preview of external content" affordance that
some users expect.

## Decision — Option C (PM, 2026-08-03)

**Option C.** Drop `embedType` / `embedId` and the `'embed'` node type; an external
link is text carrying a `link` mark. Removing the dead schema is its own small
change; it is not part of any other plan.

The reasoning is positional rather than technical. Tenon "is aimed at structuring
context, directing local agents, and keeping work inspectable" (`README.md`) —
captured material earns its keep by being findable and agent-readable, not by
looking rich. A metadata card is what a read-later product needs; this is not one.
The same ruling is what lets `unified-command-surface.md` keep capture to a plain
node in Today, and it lowers the priority of `launcher-provider-expansion.md`,
whose breadth pays off mainly through richer presentation.

The earlier recommendation was **Option B, deferred** — kept below as the
path not taken. It was never scheduled; the asset subsystem it depended on
(`asset-subsystem.md`, `image-rendering.md`, PR #8) stays useful regardless.
The self-imposed "~2026-07-25 auto-switch to Option C" trigger had been removed by
PM decision (2026-06-04); this ruling supersedes that open state.

## Non-goals

- Provider-specific player UIs (custom YouTube controls, Twitter card
  styles). One generic card template.
- Authenticated embeds (Notion, Figma share links behind login).
- Server-side rendering of the metadata fetch. Main process is enough.

## Open questions (if Option B)

- Should the metadata fetch be on a timer (re-fetch every N days to update
  posters) or strictly one-shot? One-shot keeps things deterministic;
  user can right-click → "refresh embed" if they need an update.
- oEmbed providers vs. raw OpenGraph: OpenGraph is universal but lower
  quality. Maintain a small per-provider override map for YouTube /
  Twitter / Vimeo.
- Privacy: the metadata fetch reveals to the source that lin is interested
  in that URL. Make this opt-in per user or document it clearly.

## Implementation sketch (Option B)

1. Add `embed` ingest IPC: `ingest_embed(url)` → main fetches metadata +
   poster → returns the populated node payload.
2. Slash command `/embed <url>` → ingest → `create_embed_node`.
3. `EmbedCard.tsx` renderer.
4. Right-click → "Refresh metadata", "Open source", "Convert to plain
   link".

## Implementation sketch (Option C)

1. Remove `embedType`, `embedId` from `Node` in `src/core/types.ts`.
2. Remove `'embed'` from `NodeType`.

**No migration.** Pre-release, a format change wipes `~/.lin-outliner-*` dev
userData and deletes the old reader rather than shipping a migration or a
compatibility branch (`AGENTS.md`). No `type: 'embed'` node has ever been
creatable — there is no renderer and no command that produces one — so there is
nothing to convert in the first place.

`src/core/types.ts` is an infrastructure-ownership file, so this lands as its own
small isolated change, not folded into a feature PR.
