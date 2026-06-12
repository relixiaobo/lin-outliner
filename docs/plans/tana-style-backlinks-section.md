---
status: in-progress
priority: P1
owner: codex-3
created: 2026-06-12
updated: 2026-06-12
---

# Tana-Style References Experience

Bring backlink visibility in the outliner to the Tana/nodex model: if the
current page node has references or textual mentions, its `NodePanel` shows a
bottom **References** section by default. The existing `References` system field
stays available, but references are no longer hidden behind an optional field
row. This plan now targets the Tana-level surface in one pass: linked
references, unlinked mentions with a `Link` action, footer counts, and
query/related-content reuse.

Execution shape: **one complete feature in one PR**. The canonical backlink
collector, mention scanner, `NodePanel` footer UI, footer counts, existing
`References` system-field alignment, search/related-content reuse, spec sync,
and tests ship together. Landing only a data helper or only the UI would leave
the product in a split state.

## Goal

1. Add a bottom `References` section to every `NodePanel` whose root node has at
   least one linked reference or unlinked textual mention.
2. Count and render the same linked-reference classes everywhere:
   - tree reference nodes (`type === 'reference'`, target is the current node);
   - inline node references inside rich text;
   - reference field values whose value points to the current node.
3. Add Tana-style unlinked mentions: source rows whose visible text mentions the
   current node title but do not already carry an inline/tree/field reference to
   it.
4. Add a `Link` action for unlinked mentions that converts the exact text range
   into an inline reference to the current node through the normal command
   mutation path.
5. Keep counts in the `NodePanel` footer header only. The count appears in the
   Tana-like footer position and expands/collapses that section; row chrome does
   not render inline counters.
6. Keep the section navigational by default: source rows show breadcrumbs and
   click/drill navigates to the source. The only mutation in the footer is the
   explicit unlinked-mention `Link` action.
7. Route the existing `References` system field through the same backlink
   semantics so the footer, system field, sorting/filtering count, and agent
   read output stop drifting.
8. Make the same source set available to search/related-content style consumers
   so a saved search equivalent of Tana's `LINKS TO:: PARENT` can reuse the
   references logic instead of re-implementing it.

## Non-goals

- **Reference creation/deletion semantics.** Existing commands remain the only
  mutation surface. The footer may create an inline reference only through the
  explicit `Link` action for an unlinked mention; deleting an existing source
  reference still happens through the source row or field value, not from the
  backlink list.
- **General Tana related-content framework.** This PR includes backlinks/mentions
  as a reusable related-content source and search primitive. It does not build a
  full arbitrary related-content panel editor for every query type; that belongs
  to the broader view/search system if needed.
- **Unbounded fuzzy mention matching.** Initial unlinked mentions use an exact,
  normalized current-title phrase match with clear token boundaries. Aliases,
  fuzzy matches, pluralization, and semantic matches would produce false
  positives and need separate product rules.
- **Protocol reshaping without ratification.** Avoid changing
  `src/core/commands.ts` or the public `Backlink` protocol shape unless
  implementation proves the current shape cannot express the footer count. If
  that happens, stop and ratify a small interface-first change before touching
  consumers.
- **Whole-app performance rewrite.** Tana-level scope likely needs a mention
  index or cached selector, but this PR should build the smallest correct index
  for references/mentions rather than rewriting unrelated projection or search
  architecture.

## Design

### Canonical references derivation

Create a pure backlink derivation helper over a `Map<NodeId, NodeProjection>` /
core-compatible node shape, probably in `src/core/backlinks.ts` or a similarly
shared core module. It should return structured data rather than pre-rendered
text:

```ts
interface ReferenceSource {
  sourceNodeId: NodeId;
  referenceNodeId: NodeId;
  kind: 'tree' | 'inline' | 'field' | 'unlinked';
  fieldEntryId?: NodeId;
  fieldDefId?: NodeId;
  mentionRange?: { start: number; end: number };
  mentionText?: string;
}
```

Rules:

- Tree references count only when `node.type === 'reference'`, `node.targetId`
  is the target, `refRoleCountsAsBacklink(node)` is true, and the reference is
  not inside trash unless the caller explicitly includes deleted content.
- Inline references count when `inlineRefNodeId(inlineRef) === targetId`.
- Field references count as the owning content node, not the `fieldEntry` row.
  If a reference node lives under a `fieldEntry`, its display group should say
  which field supplied the reference.
- Search-result, config, enum, system, auto-init, and other non-link reference
  roles stay out of backlinks through the existing allowlist.
- Multiple references from the same source are counted in the raw count, but the
  footer display can dedupe visual rows by `(sourceNodeId, kind, fieldDefId)` so
  one source does not spam the section.
- Unlinked mentions scan visible content text and descriptions for an exact,
  normalized phrase match against the target's current title. They exclude:
  - the target node itself;
  - trashed nodes;
  - nodes that already have any linked reference to the target;
  - internal/config/search-result nodes;
  - empty or too-short target titles that would create noisy matches.
- Mention matching must be deterministic and testable. Prefer a small tokenizer
  / boundary helper over ad-hoc substring checks.
- Unlinked mention ranges must be stable enough to patch: if a source row changes
  before the user clicks `Link`, revalidate the range against current content
  before writing. If it no longer matches, refresh the source set and do not
  mutate.
- Repeated unlinked text matches in the same source node are one source row and
  one count for a target; keep the first content match as the linkable range.

This helper becomes the source for:

- `OutlinerCore.backlinks` / document command response;
- `agentNodeToolProjection.backlinks`;
- `systemFieldDisplay` / `systemFieldValues` for `sys:refCount`;
- renderer footer section data;
- footer count data;
- `LINKS_TO` / related-content search paths.

If full sharing across main and renderer creates import-boundary friction, keep
the shared helper pure in `src/core/` and adapt projection/core node maps at the
edges.

### NodePanel footer

Add `BacklinksSection` under the main outliner in `src/renderer/ui/NodePanel.tsx`.
Use nodex's interaction shape as the starting point, extended to Tana-level
mentions:

- hidden when there are zero linked references and zero unlinked mentions;
- collapsed by default per root node;
- header: `N Reference(s)` plus disclosure chevron, with linked and unlinked
  counts available for the expanded body;
- expanded body:
  - `Mentioned in...` for tree + inline references;
  - `Appears as <Field> in...` for field-value references, grouped by field name
    if grouping remains visually clean;
  - `Unlinked mentions...` for exact text mentions that are not real references;
  - each item uses the shared read-only outliner preview row: breadcrumb context,
    normal row shell/leading geometry, the source's full wrapping title, the
    source description when present, a trailing action slot, and a reference
    frame with a heavier left quote rule matching the normal selected-row range
    around the bullet plus content;
  - click navigates to the source node through the existing `onRoot` path;
  - unlinked mention rows include a secondary `Link` action that converts the
    exact mention text into an inline reference; the action uses the row's
    trailing slot and stays text-like with a transparent hit area in its default
    state;
  - modifier/open-in-new-pane behavior should match existing reference links if
    feasible without extra protocol.

Use existing primitives and design-system rules:

- no nested cards;
- neutral hover/focus states;
- no hand cursor except where the row is a genuine navigational link;
- no raw hex;
- labels go through i18n.

### Footer count

The reference count lives in the `NodePanel` footer header, matching the Tana
placement the user expects for page-level reference context:

- default: visible only when the footer has at least one linked reference or
  unlinked mention; no zero-count placeholder;
- label/title exposes the linked/unlinked counts for accessibility;
- click expands/collapses the footer in place;
- row chrome, inline node rows, and reference rows do not render separate count
  badges or numeric affordances;
- no hand cursor on non-link row chrome beyond actual links/buttons.

### Link unlinked mentions

The `Link` action is the one intentional mutation in the footer. It should reuse
the same rich-text command path that row editors use to insert inline references:

- re-read the source node before mutating;
- verify the stored `mentionRange` still points at the same normalized text;
- replace only that range with an inline node reference to the target;
- keep the source row's existing marks outside the range intact;
- after success, the source moves from `Unlinked mentions...` to `Mentioned
  in...` because it now carries a real inline reference;
- undo should reverse the conversion as one normal user operation.

If the source row is locked or the range can no longer be verified, disable or
no-op the `Link` action and refresh the footer.

### Existing References system field

The `References` system field remains useful for explicit field layouts and
view sorting/filtering. It should stop being a separate backlink definition:

- display value uses the canonical helper and renders deduped source nodes as
  the same read-only synthetic reference rows it uses today;
- `systemFieldValues(..., REF_COUNT_FIELD)` returns the canonical linked-reference
  count, including inline refs and field references. Unlinked mentions are
  exposed in the footer but do not change field sort semantics unless the
  PM explicitly wants "References" sorting to include unlinked text hits too;
- tests cover multiple references from one source, inline-only refs, field refs,
  filtered internal refs, and unlinked mentions.

### Search / related content reuse

Add or route a search primitive equivalent to Tana's `LINKS TO:: <target>` /
`LINKS TO:: PARENT` through the same helper:

- linked references and unlinked mentions can be requested as one source set;
- callers can filter to linked-only when they need graph-pure semantics;
- saved search / related-content consumers should not duplicate backlink or
  mention matching logic.

If Lin's current query grammar cannot express `PARENT` cleanly for related
content, implement the reusable engine path and document the UI gap rather than
inventing a half-shaped query editor.

### Specs

Update:

- `docs/spec/ui-behavior.md` — document the default `NodePanel` bottom
  `References` section, its relationship to the `References` system field, the
  footer count behavior, click navigation, and collapsed-by-default behavior.

Do not edit `docs/TASKS.md` or `CHANGELOG.md`; those are main-agent-owned and
updated at merge.

## Files

Expected touch set:

- `src/core/backlinks.ts` (new) or equivalent pure helper.
- `src/core/referenceMarkup.ts` / rich-text patch helpers if the `Link` action
  needs a small shared range-to-inline-reference helper.
- `src/core/searchEngine.ts` / query helpers if `LINKS_TO` reuse needs alignment.
- `src/core/core.ts`.
- `src/core/systemFields.ts`.
- `src/main/agentNodeToolProjection.ts`.
- `src/renderer/ui/NodePanel.tsx`.
- `src/renderer/ui/BacklinksSection.tsx` (new).
- `src/renderer/ui/outliner/OutlinerItem.tsx` only if row-leading or shared
  outliner chrome reuse requires it; counters stay out of row chrome.
- `src/renderer/styles/outliner.css` or the appropriate existing panel/outliner
  stylesheet.
- i18n message files.
- `tests/core/*` and `tests/renderer/*`; add e2e only for browser-visible
  expand/click behavior if renderer tests cannot cover it.
- `docs/spec/ui-behavior.md`.
- `docs/spec/outliner-parity-matrix.md`.

## Risks

- **Drift between backlink paths.** Today core, agent projection, and system
  fields compute similar but not identical backlink data. The main risk is
  preserving that drift accidentally. Mitigation: one pure helper, then adapters.
- **Mention false positives.** Exact title matching can still be noisy for short
  titles. Mitigation: require a minimum normalized title length, token boundaries,
  and no internal/config nodes; add tests for punctuation and self-mentions.
- **Stale mention ranges.** A source row can change after the footer computed an
  unlinked mention. Mitigation: revalidate the range immediately before applying
  `Link`; never patch by stale offsets.
- **Performance on every keystroke.** The current `References` system field can
  already scan `byId`; adding unlinked mentions and footer counts raises the
  cost. The implementation must memoize by projection revision / `byId`, and it
  should build a per-target count map once per projection frame rather than
  scanning the document per row.
- **Visual noise.** Tana's footer is useful because it is quiet and collapsible.
  Default-collapsed behavior plus no-zero-state rendering keeps empty pages clean;
  the footer count must stay visually secondary and row chrome must remain clean.
- **Synthetic row semantics.** Footer rows are navigational summaries, not real
  document rows. They should not enter selectable-row batch actions unless the
  implementation deliberately renders them as existing read-only `sysref:*` rows
  and preserves the synthetic-row no-op delete policy.
- **Field-reference attribution.** A reference under a `fieldEntry` should point
  the user to the owner node and name the field. If the owner walk is ambiguous,
  prefer omitting the row over showing a misleading source.

## Collision Check

- `gh pr list` currently shows only PR #207
  (`codex/agent-conversation-entry-identity-ux-a`), whose scope is agent
  conversation runtime/UI, i18n, and agent docs. No overlap with `NodePanel`,
  `systemFields`, outliner styles, or backlink logic.
- `docs/TASKS.md` records prior completed reference-field work and a performance
  note that `References` display still scans `byId`. There is no active open
  claim on this footer behavior.
- Existing untracked file in this clone: `docs/plans/liquid-glass-ui-refinement.md`.
  This plan does not touch it.

## Validation

- `bun run typecheck`.
- `bun run test:core`.
- `bun run test:renderer`.
- Focused tests:
  - core backlink helper covers tree / inline / field / internal-role exclusion;
  - mention helper covers exact match, boundaries, self-exclusion, existing-link
    exclusion, trash/internal exclusion, and short-title noise guards;
  - `systemFieldDisplay` and `systemFieldValues` use canonical count/display;
  - renderer footer hides at zero, shows count, expands, displays source
    breadcrumb/title, separates unlinked mentions, and navigates via `onRoot`;
  - unlinked mention `Link` converts the exact source range into an inline
    reference, reclassifies it as linked, and is undoable;
  - stale/locked source rows do not mutate on `Link`;
  - footer count appears only when count > 0, expands/collapses the references
    section, and row chrome does not render counters.
- If CSS/layout changes are non-trivial, run a focused Playwright visual check in
  light and dark.

## Open Questions

- Should field references be visually separated under `Appears as <Field> in...`
  from the first PR, or should all sources start in one compact `References`
  list with a small field label? Default: keep nodex's grouping if it stays
  visually quiet.
- Should clicking a footer item open the source in the current pane, while
  Cmd/Ctrl-click opens a new pane? Default: match existing reference navigation
  behavior where the event plumbing is already available.
- Should definition nodes show the footer? Default: no in the first PR, matching
  nodex's `!isDefinitionNode` guard and keeping schema/config pages quieter.
- Should the `References` system field's numeric value include unlinked mentions?
  Default: no. The footer is "all reference context"; the system field
  remains graph-linked count for sorting/filtering unless PM says otherwise.
- What minimum normalized title length should qualify for unlinked mentions?
  Default: 3 non-space characters, with token-boundary matching.

## References

- Tana docs: `Nodes and references` describes the built-in references section,
  unlinked mentions, and page-level count placement.
- Tana docs: `Related content` describes configurable related-content sections,
  which this plan covers only for the backlinks/mentions source set.
- nodex implementation references:
  - `/Users/lixiaobo/Coding/nodex/src/lib/backlinks.ts`
  - `/Users/lixiaobo/Coding/nodex/src/hooks/use-backlinks.ts`
  - `/Users/lixiaobo/Coding/nodex/src/components/panel/BacklinksSection.tsx`
  - `/Users/lixiaobo/Coding/nodex/src/components/panel/NodePanel.tsx`
