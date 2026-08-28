# Outline Source Resources And Derived Previews

**Shape:** (a) ONE complete feature in one PR. The URI field contract, built-in
Source field, ordinary-Node cutover, managed-asset relationship, paste and
capture behavior, derived preview interaction, special-Node retirement, current
specifications, and verification land together. The internal sections below are
build order, not independently shippable slices.

## Goal

Give URLs, images, and other files one Outline model and one interaction:

```text
Node: content = editable RichText, possibly empty
|- Source field entry: exactly one URI value
|- other field entries
`- ordinary child Nodes

preview = derive(Source URI, resolved metadata, local view state)
```

`Node` above is the object represented by the content row; it is not an extra
container row. `content` is the Node's own editable text, not a child. Field
entries may be represented structurally below the Node, but they are typed field
slots rather than ordinary child Nodes. A preview is presentation only and never
occupies an Outline level.

A Node with a valid Source value is informally a resource Node, but it remains an
ordinary content Node. Adding or removing Source changes its derived presentation,
not its Node type. This lets a user paste a URL, image, or file; edit or clear the
title; add tags, fields, and notes; hide and restore the preview; replace the
source; or remove the source without crossing different object models.

The minimum acceptable outcome is that title, source, preview visibility, and
ordinary children become independent:

- clearing the title preserves Source and preview;
- hiding the preview preserves Source and always leaves a recovery action;
- removing Source removes the preview and leaves an ordinary Node; and
- expanding or collapsing children never opens or closes the preview.

## Non-goals

- No global `Resource` object, universal resource identity, ownership transfer,
  or claim that a mutable source and an exact revision are the same file.
- No `file` field type and no separate URL/image/file built-in fields. One `uri`
  field type and one Source definition cover all supported schemes.
- No conversion of every URL-looking string into a resource Node. Inline links
  inside authored text remain rich-text links.
- No assumption that a URI grants permission. Filesystem access, managed bytes,
  web navigation, and external opening remain Host-authorized operations.
- No persistence of preview DOM, fetched page markup, player state, or remote
  metadata as Node content.
- No redesign or feature reduction of the existing file-preview renderer stack.
  This plan changes the Node/source host and disclosure contract, then rebinds
  the mature preview bodies and controls to Source. It does not replace them
  with a new generic card.
- No automatic rewrite of user-authored content when page or file metadata
  changes. Derived labels are presentation fallbacks only.
- No automatic full-page embed for every web URL. Ordinary pages use a compact
  summary; explicitly supported media providers may embed.
- No rich preview inside dense table or calendar cells. Those views keep typed
  URI field presentation and ordinary Node navigation.
- No Agent resource-reference cutover. `agent-result-and-file-lifecycle` consumes
  this plan's final Outline Source/AssetRecord relationship later.
- No migration, compatibility decoder, dual write, or legacy special-Node reader.
  Pre-release verification uses freshly reset stopped-process userData.

## Design

### Requirements

- **FR-1:** Replace the `url` field type with `uri` in one clean protocol cut.
  A field definition owns one fixed field type; a Source value's scheme never
  changes the Source field's type.
- **FR-2:** Seed one protected built-in field definition with stable ID
  `field:source`, default display name `Source`, fixed type `uri`, and exactly one
  direct value per owner Node. Users may add, replace, or remove a Node's Source
  entry but cannot change the built-in definition's type or cardinality.
- **FR-3:** Represent every Outline resource as an ordinary content Node whose
  canonical source relationship is the Source field value. Delete the Outline
  `image` and `attachment` Node variants and their dedicated mutation paths.
- **FR-4:** Store one absolute canonical URI in Source. Support web sources,
  managed Outline assets, and explicitly linked local filesystem sources without
  treating those representations as equivalent authorities.
- **FR-5:** Derive preview kind, readable source label, metadata, available
  actions, and availability from the Source URI through one resolver shared by
  list rows, Node pages, search classification, and preview opening.
- **FR-6:** Keep preview visibility in per-user local view state, separate from
  document state and child disclosure. Persist the hidden set across navigation
  and restart, and sanitize it when Nodes or Source entries disappear.
- **FR-7:** Turn a single-resource paste on an empty editor row into one atomic
  ordinary Node plus Source field operation. Preserve inline-link behavior for
  selections, non-empty prose, multi-line prose, and protected rich-text ranges.
- **FR-8:** Capture pasted, dropped, picked, and clipboard-backed files as managed
  exact revisions by default. Provide an explicit local-link action for users who
  want a live external source instead of captured bytes.
- **FR-9:** Preserve tags, fields, normal child Nodes, references, movement,
  duplication, search, undo/redo, and Node-page navigation for every resource
  Node without file-specific keyboard anchors or row identity.
- **FR-10:** Retire every producer and consumer that branches on Outline
  `image`/`attachment`, while leaving Agent message attachments, model image
  parts, preview targets, and ContentStore/AssetRecord types intact.
- **FR-11:** Preserve every existing file-preview capability that does not depend
  on the retired Outline Node discriminants or the overloaded child `expanded`
  state. A renderer or reader may change its source adapter and outer host, but
  its established content interaction, actions, security boundary, and restored
  reading state remain behaviorally equivalent.
- **NFR-1:** Invalid, unsupported, missing, denied, or temporarily unavailable
  sources degrade locally. They never remove Source, rewrite content, or abort an
  otherwise valid Outline projection.
- **NFR-2:** Managed-asset admission and Source settlement cannot expose a Node
  referencing uncommitted bytes or collect bytes referenced by document state,
  undo history, or an in-flight transaction.
- **NFR-3:** Preview loading keeps stable geometry, does not shift sibling rows,
  and preserves native keyboard, selection, drag, and virtualization behavior.

### 1. Canonical Node And Field Model

The Node's own line is its `content`:

```text
- Video title                         Node.content
  - Source:: https://youtu.be/...     typed Source field slot
  - Status:: Watching                 another field slot
  - Notes from the first minute       ordinary child Node
```

The stored shape uses the existing field-entry/value-node mechanism. The stable
Source definition identifies the slot by ID, never by its rendered label. A
resource predicate conceptually means:

```ts
isResourceNode(node, index) = hasOneUsableSourceValue(node.id, 'field:source')
```

It does not inspect tags, title text, file extensions in `content`, capture
sidecars, or a special Node discriminant. Adding tags never creates, removes, or
changes a preview.

Source is single-valued because one visible preview and one set of Open/Reveal
actions must have one unambiguous target. A replace operation updates that value;
it does not append another direct field value. Descendants of the value row keep
their ordinary Node semantics but do not become additional Source values.

An empty `content` remains genuinely empty and editable. The renderer may derive
a filename, host, or provider title for breadcrumbs, references, accessibility,
and unavailable-state copy, but it must not paint that fallback as authored row
text or write it into the document. Resource creation seeds useful initial text:

- pasted web URL: the normalized URL;
- managed or linked file: the original filename; and
- rich launcher capture: the provider title when present, otherwise the URL.

Later metadata never overwrites that initial or user-edited content.

### 2. URI Field And Source URI Families

`uri` is the clean replacement for `url`, not an additional field type. Generic
URI fields retain the ordinary editable value-row model with non-blocking
validation and safe link affordances. A partially typed or unsupported URI may
remain stored and editable; only a canonical supported Source URI activates a
resource preview.

The Source resolver admits these persistent families:

| Source value | Meaning | Resolution |
| --- | --- | --- |
| `https://example.com/page` | Remote mutable web source | Current URL policy; no exact bytes implied |
| `https://example.com/image.png` | Remote mutable media source | Same web authority; renderer may derive an image preview |
| `asset://local/{encodedAssetId}` | Profile-local Outline AssetRecord | Runtime verifies metadata and exact revision, then issues scoped preview/open actions |
| `file:///Users/me/report.pdf` | Explicitly linked live local source | Host revalidates admitted scope, containment, identity, and requested action on every use |

`asset://local/{encodedAssetId}` promotes the post-#592 canonical `assetUrl` /
`assetIdFromUrl` format from a generated transport detail to the persistent
managed Source URI. The encoded path round-trips the complete AssetRecord ID;
callers never parse it ad hoc. This does not admit `asset:` inside `[[...]]`
reference markers, make it externally openable, or turn syntax into permission.
The Runtime still verifies the AssetRecord before serving bytes or issuing an
action. Source values never expose a ContentStore path, digest, anchor, lease, or
Host-private source-scope ID.

This promotion deliberately makes the `asset:` formatter/parser a protocol
surface. It can no longer change independently without a document-format cut.
That coupling is preferable to inventing a second managed-asset URI which would
resolve to the same AssetRecord and transport.

A raw local path is never a Source value. File choosers and path-aware importers
encode an absolute standard `file:` URI. A syntactically valid file URI still
grants no access: an explicit Link File action records or reuses the appropriate
profile-local external-root admission. Manually entered or pasted file URIs
without current admission show a permission-required state with a Choose File
recovery action; they do not silently gain ambient access.

Scheme parsing is pure and has no side effects. Resolution returns a descriptor,
not a universal product object:

```ts
type ResolvedNodeSource = {
  uri: string;
  kind: 'web' | 'image' | 'document' | 'audio' | 'video' | 'file';
  label: string;
  previewTarget?: PreviewTarget;
  availability: 'ready' | 'loading' | 'unavailable' | 'denied' | 'unsupported';
  actions: readonly SourceAction[];
};
```

This is a derived boundary shape, not canonical Node state. AssetRecord metadata
is authoritative for managed MIME type, filename, dimensions, page count, and
duration. Remote classification uses the same provider/URL/observed-metadata
rules as preview rendering; unsupported or unknown remote kinds remain web
sources rather than guessed files.

Source presentation remains truthful without exposing internal noise by default:
web sources show the canonical URL, `file:` sources show the decoded path, and
managed assets show their AssetRecord filename plus a quiet managed-copy cue.
Editing or **Copy URI** exposes the exact stored value. Presentation labels never
become a second stored locator, and a user may replace any Source through paste,
editing, or the appropriate chooser.

### 3. Resource Preview Interaction

An expanded resource presentation follows the Tana-inspired order while keeping
Tenon's Node and field semantics:

```text
   [open source]  [derived preview]                         [hide preview]
*  editable Node content  #tags
     Source   readable source value
     other fields
     ordinary children
```

The leading bullet belongs to the content Node. The preview appears before the
content line inside the same visual Node scope; it is not a parent, child, or
card containing another card. The Node chevron continues to control only
ordinary child disclosure, including the normal trailing draft for a leaf.

Preview controls use familiar icons with tooltips and no rounded-square hover
box. The upper-right close icon is named **Hide preview** and changes only local
visibility. URL summaries and provider embeds expose the Tana-style upper-left
Open source action. A mature file preview that already owns the appropriate
Open/Expand/action HUD delegates opening to that retained control instead of
adding a duplicate upper-left command. Interactive media and document controls
retain their own input handling.

When hidden, the resource returns to an ordinary content-and-fields outline:

```text
*  editable Node content  #tags
     Source   readable source value                    [show preview]
     other fields
     ordinary children
```

The Source row is always rendered while Source exists, even when other optional
field-display rules would hide it. A trailing **Show preview** icon is present
for every preview-capable resolved or retryable source. This is the recovery path
missing from the observed Tana interaction.

Visibility rules are deterministic:

- newly pasted, captured, or newly added Source values show preview by default;
- Hide preview adds the Node ID to a per-workspace local hidden set;
- Show preview removes it;
- editing Source while visible reloads the preview in place;
- editing Source while hidden preserves the explicit hidden choice;
- removing Source clears stale local visibility state; a later newly added Source
  therefore starts visible; and
- navigation, references, tags, title edits, and child disclosure do not change
  preview visibility.

Three independent state axes must remain separate:

1. resource preview visibility: shown/hidden, keyed by Node in local view state;
2. retained preview-body state: summary/full, local height, page/section/media
   state, keyed by resolved source identity; and
3. ordinary child disclosure: collapsed/expanded, keyed by Node in the Outliner.

Hide/Show changes only axis 1. Existing document **Expand/Collapse**, page jumps,
and reader restoration change axis 2. The Node chevron changes only axis 3.

Deleting Source removes the preview immediately and leaves the Node, its content,
tags, other fields, and children untouched. Deleting the Node removes its Source
relationship through ordinary subtree deletion. Clearing content never removes
Source. Hiding preview never affects managed-asset liveness.

The same resolver and preview body serve the drilled Node page. Node-page
navigation chrome may keep its established placement, but Hide/Show, source
replacement, availability, and Open semantics remain identical. Dense table and
calendar projections render the URI field/link without mounting the rich inline
preview.

### 4. File Preview Preservation Boundary

The current shared preview system is an asset of this refactor, not legacy to be
discarded. `PreviewTarget`, source-aware Host resolution, `FilePreviewShell`, the
renderer registry, and the dedicated reader pane remain the preview foundation.
The Source resolver becomes one more canonical producer of those targets.

The implementation starts from a generated responsibility inventory over the
current preview specifications and tests after #592. At minimum it preserves:

- PDF summary strips, every-page navigation, one-shot page jumps, full vertical
  reader mode, content insets, local height resizing, and restored reader
  position;
- EPUB and HTML readers, lazy content mounting, document outlines, restored
  position, bilingual translation controls, preferences, caches, failure
  recovery, and keyboard routing;
- Markdown, code, plain-text, delimited-table, directory, image, and metadata
  fallback renderers with their bounded/unsupported states;
- themed audio and video Media Chrome, playback, seek, volume, mute, keyboard
  shortcuts, fullscreen, and its same-layer action menu;
- document summary/full modes, per-source resized height and reader-state
  isolation, and the existing stable inner-inset/scrollbar geometry;
- **Open in split pane**, **Open with default app**, **Show in Finder**, **Copy
  file**, Expand/Collapse, Maximize, Retry, and unavailable actions wherever the
  resolved source supports them;
- private Runtime-verified materialization and scoped `asset://`/preview streams,
  never a renderer-visible ContentStore path; and
- reduced motion/transparency/contrast behavior, light/dark tokens, focus rings,
  selection, and the existing preview security boundaries.

The active `file-preview` extension plan remains valid: Office and optional
static URL readers register against the same preview target/renderer foundation
and automatically become available to Source-backed Nodes when they land.

Only the old host assumptions are intentionally replaced:

- read-only filename content and a hidden file-only keyboard anchor become the
  ordinary editable Node content editor;
- file-type icon bullets and image-as-Node-identity presentation become normal
  Node leading/selection geometry plus a Source-derived preview;
- the Node chevron stops doubling as preview disclosure and controls only
  ordinary children; and
- `fileNodeTarget`/metadata branches over Node scalar fields resolve from Source
  and AssetRecord instead.

If a retained preview behavior conflicts with the new host, the implementation
adapts the host boundary rather than silently dropping the behavior. Any proposed
feature removal requires a separate product decision and cannot be treated as a
mechanical consequence of this refactor.

### 5. Renderer Selection And Failure Recovery

One ordered renderer registry selects presentation from the resolved descriptor:

| Source kind | Inline presentation |
| --- | --- |
| Supported provider such as YouTube | Sandboxed fixed-aspect inline player |
| Ordinary web URL | Compact favicon/title/description/host summary; activation opens the existing full URL reader |
| Image | Bounded inline image using known aspect metadata when available |
| PDF/document | Existing compact document summary; activation enters the full reader |
| Audio/video file | Existing themed player controls |
| Unsupported file | Compact filename/type/size summary with Open action |

Provider adapters parse canonical IDs and build embed targets; they never store
provider-specific Node types. YouTube navigation and playback remain inside the
existing guest/sandbox and external-navigation policy. An ordinary web summary
must render a usable host/URL fallback immediately and may enrich through the
existing unprivileged preview path; this feature adds no privileged arbitrary-URL
fetcher.

Loading uses a stable aspect ratio or bounded summary height. Failure replaces
only the preview body with compact unavailable/retry actions. Invalid Source text
shows the URI field's non-blocking validation hint and no preview. A missing
managed AssetRecord, denied file source, failed remote metadata load, or embed
failure never deletes or rewrites Source.

### 6. Paste, Drop, Picker, And Capture Flows

#### FLOW-1: Paste A Bare Web URL

1. The editor receives exactly one bare `http:`, `https:`, or normalizable `www.`
   URL with no additional prose or files.
2. If the target content is empty, the paste command atomically writes the
   normalized URL as content and creates/replaces Source with the canonical URL.
3. The Node keeps its existing ID, tags, other fields, and children. A draft row
   materializes through the normal stable-draft path.
4. The preview appears by default and resolves asynchronously without blocking
   the document mutation.

If content is non-empty, text is selected, the URL occurs within prose or
multi-line content, or an HTML anchor/code range is authoritative, preserve the
existing rich-text link behavior. Typing a URL does not auto-convert the Node.

#### FLOW-2: Paste, Drop, Or Pick Files

1. Snapshot clipboard/drop `File` objects during the event and begin bounded
   managed admission through the Runtime.
2. For each successfully admitted file, create an ordinary Node whose content is
   the filename and whose Source is its canonical `asset://local/...` URI.
3. An empty target row becomes the first resource without changing its identity;
   remaining files become ordered siblings. A non-empty paste inserts siblings
   after the row; drop keeps the normal before/inside/after placement contract.
4. Each source selects its derived renderer. Images use the same Node shape as
   every other file rather than a special inline-image Node.

Multiple files settle independently in source order. A failed admission creates
no dangling Node; successful siblings remain and one concise notice identifies
the failures. If asset admission succeeds but document settlement fails, the
existing lease/reconciliation boundary releases the uncommitted relationship.

`/attachment`, `/image`, file picker, clipboard image, external file drop, loose
preview **Add to outline**, launcher capture, and import all converge on these
ordinary-Node constructors. Surface names may remain task-oriented; they no
longer select a Node type.

#### FLOW-3: Link A Live Local File

An explicit **Link file...** action opens the native chooser, records/reuses the
Host admission, and creates an ordinary Node with filename content plus a `file:`
Source. It captures no exact revision. Moving, replacing, denying, or deleting
the external file changes availability honestly; Tenon never deletes it. The
default paste/drop/picker flow remains managed capture so ordinary attachments
are replayable.

#### FLOW-4: Edit Or Remove Source

- Replacing a web Source re-runs provider/renderer selection.
- Replacing a managed Source or local link settles the new relationship before
  releasing the old managed relationship.
- Editing a `file:` URI never carries admission from a different path by string
  similarity; the resolver revalidates the resulting locator.
- Removing Source releases its managed relationship after document commit and
  clears preview state. Undo retains or restores the AssetRecord through the
  Runtime's protected-history contract.

### 7. Managed Asset Liveness And Derived Classification

AssetRecord remains Outline's canonical exact-revision metadata record. The
Source field becomes the document relationship that keeps it live. Runtime
maintenance parses only canonical managed Source URIs plus the existing banner
and icon asset relationships; it no longer scans `node.assetId` or
`thumbnailAssetId` on special Nodes.

Duplicating or referencing a resource Node does not copy bytes. A duplicated
Node carries another Source value to the same AssetRecord. Collection occurs
only after no live document Source, protected operation-history state, staged
transaction, icon/banner relationship, or other canonical anchor needs the
record. Thumbnail relationships remain AssetRecord metadata and are expanded by
the asset store rather than duplicated onto Nodes.

Search and query behavior must consume the same derived source classification as
the renderer. `HAS_MEDIA`, `HAS_IMAGE`, `HAS_AUDIO`, and `HAS_VIDEO` use
authoritative managed metadata and deterministic supported-remote classification.
They never inspect content text or the retired Node type. Type-oriented UI that
previously treated `image` as an Outline Node type routes to the derived media
predicate or is removed when it exposed only the retired implementation detail.

A single derived source index joins field slots to Runtime AssetRecord metadata
for projection/search without copying that metadata into each Node. Missing
metadata yields unknown/unavailable classification rather than a false type or a
projection failure.

### 8. Clean Protocol Cut

The implementation removes, in the same complete feature:

- `FieldType` value `url`, replacing its registry, validation, icon, config,
  search, import, launcher, and tests with `uri`;
- Outline `ImageNode` and `AttachmentNode` variants and their discriminants;
- `assetId`, `mediaUrl`, `mediaAlt`, file metadata, and thumbnail fields from the
  Node union;
- image/attachment create, set, paste-tree, ChangeSet, CLI, and renderer command
  variants;
- file-node keyboard-anchor, row-title, type-icon-as-bullet, and
  preview-via-child-expanded special cases; and
- special-node reference-candidate and search branches.

The cut does not remove:

- `AssetRecord`, its exact revision, metadata, thumbnail relationships, leases,
  reconciliation, or ContentStore anchors;
- `PreviewTarget` asset/local-file/URL variants or the scoped `asset://` transport;
- Agent `attachment` content parts, model `image` parts, generated images, or
  Thread resource records; or
- rich-text image/link syntax that is not an Outline Node discriminant.

A source guard distinguishes these namespaces so a broad text replacement cannot
retire Agent or preview concepts accidentally. No old Node decoder or `url` field
alias remains after the pre-release userData reset.

### 9. Dependencies, Risks, And Implementation Surface

Implementation begins only after #592 lands and the branch rebases on its final
Outliner Runtime, field, asset, preview, UI-state, and quit/recovery architecture.
#592 currently overlaps the future implementation in `OutlinerItem`, preview
components, Outliner CSS, Runtime asset liveness, and `ui-behavior`; writing
against its pre-merge shape would be knowingly disposable work.

This feature then lands before the Outline-consumer portion of
`agent-result-and-file-lifecycle`. That later plan may share or clone exact
revisions into Outline AssetRecords, but it must create ordinary Nodes with a
managed Source field rather than special attachment/image Nodes.

Expected implementation areas, re-derived after #592 rather than treated as a
fixed file checklist:

- protocol and Core: `FieldType`, Node union, built-in definitions, commands,
  field resolution, search, paste/import tree shapes, launcher capture;
- Outliner Runtime: schemas, ChangeSet/CLI operations, asset settlement,
  projection, derived source index, history protection, and liveness scanning;
- desktop Host/preload: Source resolution, explicit local-file admission, safe
  Open/Reveal, and managed preview targets;
- renderer: URI field presentation, paste/drop/picker ingest, Outliner and Node
  page composition, local preview-visibility persistence, renderer registry,
  errors, and accessible controls;
- specifications: UI behavior, commands/protocol, architecture, launcher,
  search grammar, preview/design-system contracts, and the Agent file-lifecycle
  dependency; and
- tests: protocol/codec, commands, liveness/recovery, search, paste, row
  interaction, UI state, preview selection, E2E keyboard/drag, and light/dark
  visual evidence.

Primary risks are a managed asset being collected after its relationship moves
from a scalar Node field into a Source field tree; field values being counted as
ordinary children; preview state leaking back into child disclosure; async
metadata destabilizing projection/search; and accidental retirement of Agent
attachment/image types. Each risk has an explicit guard or acceptance criterion
below.

### Acceptance Criteria

- **AC-1:** When a bare URL is pasted into an empty row, one atomic operation
  keeps/materializes that Node, writes URL content, adds one Source URI value, and
  shows the derived preview.
- **AC-2:** When a URL is pasted into selected or non-empty prose, the editor
  creates or inserts an inline rich-text link and does not add Source.
- **AC-3:** When an image or other file is pasted, dropped, or picked, the result
  is an ordinary content Node plus managed Source; no `image` or `attachment`
  Node exists in state, command payloads, or projection.
- **AC-4:** When content is cleared, Source, tags, other fields, children, managed
  liveness, and preview remain unchanged.
- **AC-5:** When Hide preview is activated, only local visibility changes and the
  Source row immediately exposes Show preview.
- **AC-6:** When Show preview is activated after navigation or restart, the same
  Source resolves and the preview returns without a document mutation.
- **AC-7:** When the Node chevron is activated, only ordinary children/trailing
  draft disclosure changes; preview visibility is unchanged.
- **AC-8:** When Source is removed, the preview disappears and the Node remains
  ordinary with all unrelated content and descendants intact.
- **AC-9:** When a visible Source changes, the old preview cannot overwrite the
  new one after asynchronous completion. When hidden, replacement remains hidden.
- **AC-10:** If Source is invalid, unsupported, missing, denied, or fails to load,
  the value stays editable and the Node action remains usable; no projection or
  editor action aborts.
- **AC-11:** A managed Source resolves only through its AssetRecord and scoped
  transport. A `file:` Source resolves only through current Host admission. Raw
  paths and non-canonical `asset:` forms fail the Source codec.
- **AC-12:** Removing or replacing the last managed Source releases collection
  eligibility only after commit; undo/redo and crash recovery never lose bytes
  needed by a recoverable document state.
- **AC-13:** Tags and ordinary fields can be added before or after Source without
  changing renderer selection or preview visibility.
- **AC-14:** YouTube uses the supported inline player; an ordinary page uses a
  compact summary; image/document/media/unsupported file sources choose their
  corresponding shared renderer and retain Open behavior.
- **AC-15:** A resource Node referenced elsewhere remains a normal Node reference.
  Its authored content is the label when non-empty; an empty content label may
  use a derived readable fallback without changing stored content.
- **AC-16:** `HAS_MEDIA` and media-kind queries agree with the preview resolver for
  managed assets and deterministically classified remote sources.
- **AC-17:** Full-tree source guards find no retired Outline special-Node or `url`
  field protocol authority while continuing to admit the named Agent, Markdown,
  and preview concepts.
- **AC-18:** Light and dark E2E evidence covers shown, hidden/recoverable, empty
  title, unavailable, YouTube, ordinary URL, image, document, and ordinary-child
  states without overlap, reflow-on-hover, or broken keyboard navigation.
- **AC-19:** The post-#592 preview responsibility inventory is empty only after
  every retained file reader, media control, action, reader-state restoration,
  translation path, security boundary, and accessibility behavior has equivalent
  Source-backed evidence; absence from the new Node scalar shape is not a valid
  retirement reason.

## Open questions

None. `Source`, `field:source`, fixed single-value `uri`, the post-#592 canonical
`asset://local/{encodedAssetId}` form, managed capture by default, explicit local
linking, preview-first resource layout, recoverable local Hide/Show state, and
the clean removal of Outline `image`/`attachment` are coordinated design
decisions. A redirect on any of them changes the protocol or product behavior
and must happen during plan review rather than being guessed during build.

## Build Checklist

- [ ] Rebase after #592 and regenerate the exact special-Node, URL-field,
      asset-liveness, preview, paste, query, and specification work queue from
      repository searches.
- [ ] Generate and disposition the current file-preview responsibility inventory;
      preserve all renderer/control/reader behavior except the explicitly replaced
      special-Node host assumptions.
- [ ] Cut `url` to `uri`; add protected single-value Source and the pure Source
      URI codec/resolver contract.
- [ ] Move managed-asset liveness and derived classification to Source field
      relationships; add transaction/history/recovery coverage.
- [ ] Cut every ingest/capture/import path to ordinary Nodes plus Source.
- [ ] Implement preview-first resource composition, persistent recoverable
      Hide/Show state, renderer selection, Source editing, and failure recovery.
- [ ] Remove Outline special Node/command/projection/search/reference branches
      and make the generated retirement work queue empty.
- [ ] Fold the design into current specs; run `bun run typecheck`,
      `bun run test:core`, `bun run test:renderer`, relevant E2E, light/dark
      visual verification, `bun run docs:check`, and clean-userData verification.
