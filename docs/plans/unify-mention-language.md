---
status: in-progress
owner: cc
branch: cc/unify-mention-language
---

# Unify the inline mention language (node = text, file = monochrome icon + text)

## Goal

One inline-mention language across the whole app:

- **Node reference** → plain accent-colored text, **no icon**.
- **Local file / directory / image reference** → a leading **monochrome** icon +
  text.

The same rule and the same icon mechanism are used by all three render sites:

1. outliner row editor (`pmSchema.ts` — the canonical mention),
2. agent composer editor (`AgentComposerEditor.tsx`),
3. agent message render (`AgentInlineReferenceText.tsx`).

Today these diverge: the outliner renders a local-file reference as **iconless**
`.inline-ref` text (identical to a node), while the agent composer/message
invented a *second* species — `.agent-composer-inline-file` /
`.agent-message-inline-file` — an `inline-flex` chip with an icon, neutral-gray
text, and a hand-tuned `translateY(2px)` baseline fudge. The composer's icon also
has **three divergent render paths** (`is-native-icon` = the full-color macOS
system raster, `is-thumbnail-icon`, `is-fallback-icon`), so a folder picked via
the native picker shows a bright blue macOS folder that clashes with the
monochrome, rose-accented surroundings and does not theme in dark mode
(violates design-system B1 "no raw color outside tokens" / B6 "mono chrome").

## Non-goals

- No change to reference parsing / markup (`src/core/referenceMarkup.ts`),
  attachment data model, or `attachmentId` binding.
- No change to the `@`-mention **picker dropdown** — its per-type file icons are a
  picker affordance, not the inline mention language, and stay.
- No new dependency.

## Design

### Shared icon mechanism (A7 — settle the mechanism before the consumers)

The icon must render identically from React (message) and from two ProseMirror
`toDOM` callbacks (outliner + composer). The robust single mechanism that all
three can emit trivially is a **CSS `mask-image` icon**:

- New shared module `src/renderer/ui/editor/inlineFileIcon.ts`:
  - `inlineFileIconKind(entryKind, mimeType, name): InlineFileIconKind` —
    promoted from the composer-local `localFileIconKind` so all sites agree.
  - a tiny emit helper for the icon `<span>` (class + `data-file-icon-kind`).
- CSS in `inline-ref.css`: `.inline-ref-file-icon { background-color:
  currentColor; mask: center/contain no-repeat; ... }` plus one
  `[data-file-icon-kind="<kind>"] { mask-image: url("data:image/svg+xml,...") }`
  per kind. Glyphs are the Lucide shapes (extracted programmatically, not
  hand-copied) so the inline set matches the icon set used elsewhere.
  Monochrome-by-construction: `currentColor` → themes automatically and matches
  the mention's text color (B1/B8).

Each render site emits, for a file reference:
`<span class="inline-ref-file-icon" data-file-icon-kind="folder" aria-hidden="true"></span>`
followed by the display name — inside the existing `.inline-ref` span.

### Wiring

1. `pmSchema.ts` `inlineReference.toDOM` (`targetKind === 'local-file'`) →
   prepend the icon span; node refs unchanged.
2. `AgentComposerEditor.tsx` `fileReference.toDOM` → use the shared icon; delete
   `fileReferenceIconDom` (its only caller) and the `is-native-icon` /
   thumbnail / fallback branches.
3. `AgentInlineReferenceText.tsx` → file segment renders the shared icon; delete
   `iconForInlineFile`.

### Color + baseline

- File mention text uses the shared `.inline-ref` color (default rose
  `--inline-ref-default`), same as the outliner — the **icon**, not a different
  color, distinguishes a file from a node. (Drop the agent chips' neutral
  `--text-secondary`.)
- Icon sized to ~1em on the text baseline; remove the `inline-flex` +
  `align-items: center` + `translateY` baseline hack. Node mention metrics
  unchanged.

### CSS convergence

- `inline-ref.css`: add `.inline-ref-file-icon` + per-kind masks.
- Delete `.agent-composer-inline-file*` (`agent-composer.css`) and
  `.agent-message-inline-file*` (`agent-message.css`).

### Images

Per the ratified rule "files all get an icon": an image reference shows the
image-type monochrome icon inline (no inline color thumbnail). Thumbnails remain
for the attachment preview surface, not for an inline mention.

## Risks

- Touches the outliner row-editor schema (`pmSchema.ts`) — central, though not on
  the infra-ownership list. Coordinated: no open PR overlaps.
- Guard/e2e tests asserting the old chip DOM (`agent-composer-inline-file`, the
  file icon paths) or asserting that outliner file refs are iconless will go red
  and are updated in the same change (A6).
- Dark mode / `prefers-contrast`: satisfied by `currentColor`.

## Collision

`gh pr list` → no open PRs. `agent-empty-state-onboarding` (backlog, unclaimed)
touches the composer only for empty-state/send-guard; `agent-generative-ui` (P3)
is assistant-output widgets. Neither touches inline mention rendering. No file on
the infra-ownership list is changed. **No overlap.**

## Gate

Shared UI surface → `/code-review` (medium) + light/dark visual verification.

## Subtasks

- [ ] `inlineFileIcon.ts` shared module (kind resolver + icon emit) + CSS masks.
- [ ] Wire `pmSchema.ts` (outliner).
- [ ] Wire `AgentComposerEditor.tsx` (delete `fileReferenceIconDom` + divergent paths).
- [ ] Wire `AgentInlineReferenceText.tsx` (delete `iconForInlineFile`).
- [ ] Delete `.agent-composer-inline-file*` / `.agent-message-inline-file*` CSS.
- [ ] Update guard/e2e/renderer tests for the new DOM shape.
- [ ] Update `docs/spec/` inline-reference / composer docs.
- [ ] typecheck + tests green; visual verify light + dark.
