# Icon Semantics

**Shape:** (a) ONE complete visual-consistency feature in one PR.

## Goal

Remove the remaining cases where one glyph communicates two different concepts
or the same registry action renders with different semantics across surfaces.
The feature changes only renderer icon aliases/mappings and the design-system
icon rules.

## Non-goals

- No icon component framework, size/stroke changes, CSS mask changes, protocol
  changes, or action behavior changes.
- No rework of tool glyphs already guarded by `threadToolIcons`.
- No interrupted/completed status-color change; that requires rendered contrast
  evidence and belongs to the final contrast pass.
- No raw Lucide import at product call sites outside the existing centralized
  mapping modules.

## Design

### Requirements

- **FR-1:** One semantic action or concept maps to the same glyph family in
  menu, launcher, picker, and attachment presentations.
- **FR-2:** Number/supertag, split/external, misc-property/Settings, and
  unknown-tool/status meanings remain pairwise distinct.
- **FR-3:** File attachment fallback glyphs are exhaustively derived from the
  shared file-kind classifier.
- **FR-4:** Product call sites import semantic aliases or centralized action
  mappings, not raw Lucide identities.

### Fixed semantic decisions

| Meaning | Final rule |
| --- | --- |
| Supertag/schema | `Hash` remains the `#` convention. |
| Number field | Use a distinct `Binary` semantic alias; never reuse the supertag `#`. |
| Open outside Tenon | `ExternalLink`/`OpenIcon` only. |
| Open beside in Tenon | Use a `Columns2` `SplitPaneIcon`, not an external-link glyph. |
| Generic configuration property | Use `SlidersHorizontal` `MiscConfigIcon`; reserve the gear for Settings. |
| Unknown tool | Keep the neutral `GenericToolIcon`; warning glyphs remain status-only. |
| Detach/dismiss versus destroy | X detaches or closes; Trash destroys persisted data. |

### Mapping ownership

Add semantic aliases only in `icons.ts`. Registry action IDs currently cross
three renderer mapping sites: `actionIcon` in `actionIcons.tsx`, `ICONS` in
`launcherIcons.tsx`, and the picker-local `actionIcon` in
`NodeValuePicker.tsx`. Update all applicable mappings together or first extract
a shared IconId-to-semantic mapping that leaves size and renderer component
selection at the surface. A change is incomplete while one action ID still has
different meaning in launcher, menu, and picker.

Route non-image `ThreadAttachmentContent` fallback glyphs through
`inlineFileIconKind` and an exhaustive archive/audio/code/database/folder/image/
presentation/spreadsheet/text/video mapping. Preview availability must not turn
an XLSX, ZIP, or video fallback into an image icon.

Document deliberate alias sharing near the central table: unchecked checkbox
and Stop may both use a square because they never compete in the same control
family; Pencil and structured-node edit remain distinct.

### Verification

Guards prove no rogue Lucide call-site imports, distinct number/supertag and
split/external aliases, exhaustive attachment mapping, and registry-map parity.
Visual evidence covers number field versus supertag, split-pane actions in menu
and launcher, unknown tool failure versus success, ZIP/XLSX/video attachments,
and a generic configuration row in light and dark.

## Acceptance Criteria

- **AC-1:** Number fields never render the supertag `Hash`, and supertags retain
  the existing `#` convention across all active surfaces.
- **AC-2:** In-app split actions use `SplitPaneIcon` everywhere while actions
  leaving Tenon alone use `OpenIcon`.
- **AC-3:** ZIP, XLSX, video, and unknown attachment fallbacks match
  `inlineFileIconKind` and never default to an image glyph.
- **AC-4:** Renderer guards prove mapping parity and no rogue imports; light/dark
  evidence shows the changed meanings remain legible at production sizes.

## Open questions

None. The semantic choices above replace the former taste-call list; status
color is explicitly outside this feature.

## Implementation checklist

- [ ] Add `Binary` number, `Columns2` split-pane, and `SlidersHorizontal`
      miscellaneous-property semantic aliases.
- [ ] Update every action-registry icon mapping or extract their shared semantic
      mapping without moving surface sizing.
- [ ] Make attachment fallback mapping exhaustive through
      `inlineFileIconKind`.
- [ ] Record icon semantics in the current design-system spec and add guards.
- [ ] Run typecheck, renderer tests, docs check, diff check, and light/dark
      visual verification.
