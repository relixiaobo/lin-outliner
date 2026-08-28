# Outline Source Resources And Derived Previews

**Shape:** (b) A SET with two ordered delivery units. **PR-I** is the
repository-required, human-led interface-only prerequisite: it lands the final
URI/Source protocol, exact-file authorization contract, invariant enforcement,
and contract tests while current main remains buildable. **PR-F** then ships one
complete user-visible feature: the ordinary-Node cutover, every ingest and
preview interaction, managed-asset liveness, special-Node retirement, current
specifications, and end-to-end verification. PR-I is the explicit A10
shared-interface exception, not a partial product slice or an interim contract;
PR-F starts only from PR-I's merged final interfaces.

## Goal

Give URLs, images, and other files one Outline model and one interaction:

```text
Node: content = editable RichText, possibly empty
|- Source field entry: ordered URI values
|- other field entries
`- ordinary child Nodes

preview = derive(Source URI, resolved metadata, local view state)
```

`Node` above is the object represented by the content row; it is not an extra
container row. `content` is the Node's own editable text, not a child. Field
entries may be represented structurally below the Node, but they are typed field
slots rather than ordinary child Nodes. A preview is presentation only and never
occupies an Outline level.

A Node with at least one valid Source value is informally a resource Node, but it
remains an ordinary content Node. Adding or removing Source values changes its
derived presentation, not its Node type. This lets a user paste a URL, image, or
file; edit or clear the title; collect multiple related sources in one Node;
choose which source to preview; add tags, fields, and notes; hide and restore the
preview; or remove sources without crossing different object models.

The minimum acceptable outcome is that title, ordered sources, selected source,
preview visibility, and ordinary children become independent:

- clearing the title preserves Source and preview;
- hiding the preview preserves Source and always leaves a recovery action;
- removing the selected Source falls back to the first remaining value, while
  removing the final Source removes the preview and leaves an ordinary Node; and
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
  `field:source`, default display name `Source`, fixed type `uri`, and ordered
  multi-value cardinality. An owner has zero or one Source slot; a present slot
  has one or more direct URI value rows. Users may add, replace, reorder, or
  remove values but cannot change the definition's type or cardinality.
- **FR-3:** Represent every Outline resource as an ordinary content Node whose
  canonical source relationships are the Source field values. Delete the Outline
  `image` and `attachment` Node variants and their dedicated mutation paths.
- **FR-4:** Store one absolute canonical URI in each Source value. Support web sources,
  managed Outline assets, and explicitly linked local filesystem sources without
  treating those representations as equivalent authorities.
- **FR-5:** Derive preview kind, readable source label, metadata, available
  actions, and availability from the Source URI through one resolver shared by
  list rows, Node pages, search classification, and preview opening.
- **FR-6:** Keep preview visibility and the selected Source value in per-user
  local view state, separate from document state and child disclosure. Persist
  both across navigation and restart, and fall back deterministically when Nodes
  or Source values disappear.
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
- **FR-12:** Make dedicated Source mutations the only public operations that may
  add, replace, reorder, or remove its direct values. Reject generic field,
  content, tree, move, clone, paste/import, template, replay, and replication
  operations that would bypass Source structure or managed-asset settlement.
- **FR-13:** Authorize a live external `file:` Source only through a persistent,
  Host-private grant for the exact canonical regular file selected by the user.
  A grant never admits its containing directory, any sibling, or a URI syntax.
- **NFR-1:** Invalid, unsupported, missing, denied, or temporarily unavailable
  sources degrade locally. They never remove Source, rewrite content, or abort an
  otherwise valid Outline projection.
- **NFR-2:** Managed-asset admission and Source settlement cannot expose a Node
  referencing uncommitted bytes or collect bytes referenced by document state,
  undo history, or an in-flight transaction.
- **NFR-3:** Preview loading keeps stable geometry, does not shift sibling rows,
  and preserves native keyboard, selection, drag, and virtualization behavior.
- **NFR-4:** External-file grant persistence and mutation fail closed. A missing,
  unreadable, corrupt, revoked, or mismatched grant makes only the affected
  Source denied; it never exposes a sibling file or aborts Outline projection.

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
isResourceNode(node, index) = hasAnyUsableSourceValue(node.id, 'field:source')
```

It does not inspect tags, title text, file extensions in `content`, capture
sidecars, or a special Node discriminant. Adding tags never creates, removes, or
changes a preview.

Source is ordered and multi-valued because one Node may collect alternative or
related representations while showing one unambiguous preview at a time. Each
direct value row has stable identity. The first value is the default selected
Source; local view state may select another value without mutating the document.
Descendants of a value row keep their ordinary Node semantics but do not become
additional Source values.

The public protocol exposes final, Source-aware operations rather than treating
the built-in field as a generic append-only slot:

- `add-source` appends one value and creates the Source slot when absent;
- `replace-source` targets one direct value ID and preserves its position;
- `reorder-source` moves one direct value within the ordered slot;
- `remove-source` removes one targeted value and removes the slot when it was the
  final value; and
- `clear-sources` removes the complete slot atomically.

The invariant is enforced below renderer helpers, at every public and persisted
mutation boundary:

- generic field-slot `append-text`, `append-reference`, `append-nodes`, and
  `append-field` actions reject `field:source`;
- generic content editing rejects a direct Source value row, so URI edits are
  lowered to `replace-source` rather than bypassing managed-asset settlement;
- generic create-tree, direct value duplication, move-into-slot, paste/import,
  template/default/auto-init, and field-copy paths cannot synthesize Source;
- cloning or duplicating an entire valid owner Node may reproduce its ordered
  Source relationships, but copying only its Source slot or direct value must use
  the dedicated add operation;
- command replay, undo/redo, restore, replication/change admission, and decoded
  persisted state validate the same zero-or-one-slot/one-or-more-values shape
  before a write becomes authoritative; and
- importers and other bulk producers create the owner first and emit the same
  dedicated Source mutation rather than constructing a privileged field tree.

The dedicated mutations are also settlement boundaries. A managed URI becomes
visible only after its asset lease is ready; replacing, removing, or clearing a
managed value releases only the affected relationships after document commit.
Every managed Source value keeps its AssetRecord live whether selected, hidden,
or off screen.

Multiple direct URI values are valid; duplicate Source field slots, non-value
direct children, and generic mutations that bypass settlement are not. Runtime
projection encountering malformed structure never chooses an arbitrary slot:
the Node remains usable, Source presentation becomes unavailable, and a
dedicated Source mutation can repair it. Persistence, command decoding, and
change admission reject malformed structure fail closed so new corruption
cannot enter the store.

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
| `file:///Users/me/report.pdf` | Explicitly linked live local source | Host matches a persistent exact-file grant and revalidates canonical target, opened identity, and requested action on every use |

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
grants no access. Manually entered, pasted, or edited file URIs without a matching
exact-file grant show a permission-required state with a Choose File recovery
action; they do not silently gain ambient access.

#### Exact Local-file Authorization

Electron main owns an atomic private JSON grant store under the active profile's
`userData`, following the existing `PRIVATE_JSON_FILE_OPTIONS` store boundary.
Each record binds one selected absolute locator to the one canonical regular file
resolved by the chooser at admission time. It may retain the minimum Host-private
identity and audit metadata needed for validation, but no grant ID, canonical
path, device/inode value, or scope record enters Source, renderer state, the
Outline protocol, or Agent-visible data. In particular, a parent directory is
never recorded as an admitted root.

Grant and resolution rules are exact:

- chooser admission resolves the selected locator, requires a regular file,
  persists the exact-file grant, and only then permits `add-source` or
  `replace-source` to commit the corresponding file URI;
- a grant may be reused by another Source only when its locator again resolves to
  the same canonical file; a separately admitted exact grant for another file is
  independently reusable;
- manually editing `Documents/a.pdf` to `Documents/b.pdf` remains denied unless
  `b.pdf` already has its own exact grant, even though both share a directory;
- **Choose File** on a denied current Source is a relink action: the chosen file
  must resolve to that Source's exact canonical target, otherwise nothing changes;
- **Replace Source...** may select a different file; main persists its new grant
  before the document mutation and removes a newly orphaned grant if settlement
  fails, while preserving any pre-existing grant;
- **Forget local-file access** revokes that exact grant without deleting or
  rewriting Source. Every Node that relied on it becomes denied and can relink;
- grants survive restart. An unreadable or invalid grant store is treated as no
  grants for resolution, and repair/re-admission must occur through a chooser;
  Outline loading and unrelated sources continue;
- a symlink locator is bound to its chooser-time canonical target. If the symlink
  later resolves elsewhere, the grant mismatches and the Source is denied; and
- ordinary replacement of file contents at the same non-symlink canonical path
  remains valid for a live Source. Each preview/read/copy operation opens the
  current file, verifies the opened regular-file identity against a fresh
  canonical resolution, and consumes that handle; Open/Reveal revalidate at
  dispatch and receive only the Host-validated canonical path.

Exact-file grants are profile authorization, not revision identity. They grant
only Source preview/Open/Reveal/copy operations defined by the Host action
policy. They do not grant Agent ambient filesystem access, expand an Agent
external-root capability, admit directories, weaken dangerous-open checks, or
act as ownership. URI parsing remains pure and side-effect free.

Scheme parsing is pure and has no side effects. Resolution returns a descriptor,
not a universal product object:

```ts
type ResolvedNodeSource = {
  sourceValueId: string;
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

The resolver returns one descriptor per direct Source value in document order.
The presentation layer joins those descriptors with the local selected-value ID;
if that ID no longer exists it selects the first value. Resolution never writes
selection into the document or silently skips an unavailable selected value.

Source presentation remains truthful without exposing internal noise by default:
web sources show the canonical URL, `file:` sources show the decoded path, and
managed assets show their AssetRecord filename plus a quiet managed-copy cue.
Editing or **Copy URI** exposes the exact stored value. Presentation labels never
become a second stored locator, and a user may add or replace a Source value
through paste, editing, or the appropriate chooser.

### 3. Resource Preview Interaction

An expanded resource presentation follows the Tana-inspired order while keeping
Tenon's Node and field semantics:

```text
   [open selected]  [derived preview]  [source switcher]    [hide preview]
*  editable Node content  #tags
     Source   selected source value
              another source value
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
Open source action for the selected value. When more than one Source exists, the
current-source label in the preview toolbar opens a compact ordered menu;
choosing an entry selects it and swaps the preview without changing the document.
A mature file preview that already owns the appropriate Open/Expand/action HUD
delegates opening to that retained control instead of adding a duplicate
upper-left command. Interactive media and document controls retain their own
input handling.

The Source field renders one typed value row per URI. The selected row uses a
neutral indicator, not an accent fill. Each non-selected row exposes an icon
action named **Preview this source**; activating it selects the value and shows
the preview if hidden. Existing field-value ordering gestures reorder Source
values. Switching, hiding, and showing remain usable from the keyboard and do not
move focus into an interactive preview body.

When hidden, the resource returns to an ordinary content-and-fields outline:

```text
*  editable Node content  #tags
     Source   selected source value                    [show preview]
              another source value             [preview this source]
     other fields
     ordinary children
```

The Source field is always rendered while at least one value exists, even when
other optional field-display rules would hide it. A trailing **Show preview**
icon is present on the selected/default preview-capable or retryable value. Other
values expose **Preview this source**. This is the recovery path missing from the
observed Tana interaction.

Visibility rules are deterministic:

- the first newly pasted, captured, or added Source value is selected and shown
  by default;
- adding another value preserves the current selection and hidden/shown choice;
- Hide preview adds the Node ID to a per-workspace local hidden set;
- Show preview removes it;
- choosing another Source stores its value-row ID in per-workspace local view
  state and swaps only the preview target and selected-source actions;
- editing the selected value while visible reloads the preview in place; editing
  another value leaves the current preview unchanged;
- editing any value while hidden preserves the explicit hidden choice;
- removing the selected value clears its selection and falls back to the first
  remaining value; removing the final value clears selection and visibility
  state, so a later first value starts visible;
- reordering keeps an explicit selection by stable value-row ID; without an
  explicit selection, the first value remains the deterministic default; and
- navigation, references, tags, title edits, and child disclosure do not change
  source selection or preview visibility.

Four independent state axes must remain separate:

1. resource preview visibility: shown/hidden, keyed by Node in local view state;
2. selected Source: one value-row ID, keyed by Node in local view state, with the
   first direct value as fallback;
3. retained preview-body state: summary/full, local height, page/section/media
   state, keyed by resolved source identity; and
4. ordinary child disclosure: collapsed/expanded, keyed by Node in the Outliner.

Hide/Show changes only axis 1. The source switcher and **Preview this source**
change only axis 2, except that the latter also restores axis 1 when hidden.
Existing document **Expand/Collapse**, page jumps, and reader restoration change
axis 3. The Node chevron changes only axis 4.

Deleting the selected Source value falls back to the first remaining value;
deleting the final value removes the preview immediately and leaves the Node,
its content, tags, other fields, and children untouched. Deleting the Node removes
all Source relationships through ordinary subtree deletion. Clearing content
never removes Source. Selecting or hiding a preview never affects managed-asset
liveness.

The same resolver and preview body serve the drilled Node page. Node-page
navigation chrome may keep its established placement, but Hide/Show, source
selection/replacement, availability, and Open semantics remain identical. Dense
table and calendar projections render the ordered URI field values without
mounting the rich inline preview.

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

One ordered renderer registry selects presentation from the currently selected
resolved descriptor. Other Source values resolve independently for their labels,
availability, actions, and switcher state without mounting preview bodies:

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
only the selected preview body with compact unavailable/retry actions. Invalid
Source text shows that value row's non-blocking validation hint and no preview.
A missing managed AssetRecord, denied file source, failed remote metadata load,
or embed failure never deletes or rewrites any Source value or silently selects a
different one.

### 6. Paste, Drop, Picker, And Capture Flows

#### FLOW-1: Paste A Bare Web URL

1. The editor receives exactly one bare `http:`, `https:`, or normalizable `www.`
   URL with no additional prose or files.
2. If the target content is empty, the paste command atomically writes the
   normalized URL as content and appends the canonical URL to Source. It creates
   the Source slot when absent and never replaces an existing value implicitly.
3. The Node keeps its existing ID, tags, other fields, and children. A draft row
   materializes through the normal stable-draft path.
4. The preview appears by default when this is the first Source. Otherwise the
   existing selected Source and hidden/shown choice remain unchanged.

If content is non-empty, text is selected, the URL occurs within prose or
multi-line content, or an HTML anchor/code range is authoritative, preserve the
existing rich-text link behavior. Typing a URL does not auto-convert the Node.

#### FLOW-2: Paste, Drop, Or Pick Files

1. Snapshot clipboard/drop `File` objects during the event and begin bounded
   managed admission through the Runtime.
2. For each successfully admitted file, create an ordinary Node whose content is
   the filename and whose first Source is its canonical `asset://local/...` URI.
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
exact-file grant, and creates an ordinary Node with filename content plus a
`file:` Source. Invoking **Add source** on an existing Source field uses the same
chooser and appends another value instead. It captures no exact revision. Moving,
replacing, denying, or deleting the external file changes only that value's
availability honestly; Tenon never deletes it. The default paste/drop/picker flow
remains managed capture so ordinary attachments are replayable.

#### FLOW-4: Select, Edit, Reorder, Or Remove Sources

- Selecting a Source updates only local view state and the derived preview/actions.
- Replacing a web value re-runs its provider/renderer selection; if it is not
  selected, the visible preview does not change.
- Replacing a managed value or local link settles the new relationship before
  releasing that value's old managed relationship.
- Editing a `file:` URI never carries admission from a different path by string
  similarity; the resolver revalidates the resulting locator.
- Reordering preserves an explicit selection by stable value-row ID; the first
  value becomes the default only when no explicit selection exists.
- Removing a value releases only its managed relationship after document commit.
  Removing the selected value falls back to the first remaining value; removing
  the final value clears Source preview state. Undo retains or restores every
  affected AssetRecord through the Runtime's protected-history contract.

### 7. Managed Asset Liveness And Derived Classification

AssetRecord remains Outline's canonical exact-revision metadata record. The
Source field becomes the document relationship that keeps it live. Runtime
maintenance parses only canonical managed Source URIs plus the existing banner
and icon asset relationships; it no longer scans `node.assetId` or
`thumbnailAssetId` on special Nodes.

Duplicating or referencing a resource Node does not copy bytes. A duplicated
Node carries the same ordered Source values and adds relationships to their
AssetRecords. Collection occurs only after no live document Source value,
protected operation-history state, staged transaction, icon/banner relationship,
or other canonical anchor needs the record. Thumbnail relationships remain
AssetRecord metadata and are expanded by the asset store rather than duplicated
onto Nodes.

Search and query behavior aggregates derived classification across every Source
value, independently of the locally selected preview. `HAS_MEDIA`, `HAS_IMAGE`,
`HAS_AUDIO`, and `HAS_VIDEO` match when any value has the corresponding
authoritative managed metadata or deterministic supported-remote classification.
They never inspect content text, local selection, or the retired Node type.
Type-oriented UI that previously treated `image` as an Outline Node type routes
to the aggregate derived media predicate or is removed when it exposed only the
retired implementation detail.

A single derived source index joins field slots to Runtime AssetRecord metadata
for projection/search without copying that metadata into each Node. Missing
metadata yields unknown/unavailable classification rather than a false type or a
projection failure.

### 8. Clean Protocol And Product Cut

The two ordered delivery units converge on one clean target with no migration,
legacy reader, alias, or dual writer. PR-I removes `FieldType` value `url` and
lands its final `uri` registry, validation, icon, config, search, import,
launcher, and tests. It also lands the protected Source definition, dedicated
ordered Source mutations, structural admission guards, URI codecs, and exact-file
grant/resolver contracts.

PR-F then removes the product surfaces that require the complete consumer
cutover:

- Outline `ImageNode` and `AttachmentNode` variants and their discriminants;
- `assetId`, `mediaUrl`, `mediaAlt`, file metadata, and thumbnail fields from the
  Node union;
- image/attachment create, set, paste-tree, ChangeSet, CLI, and renderer command
  variants;
- file-node keyboard-anchor, row-title, type-icon-as-bullet, and
  preview-via-child-expanded special cases; and
- special-node reference-candidate and search branches.

Generic field-slot and tree commands do not become a compatibility path for
Source. PR-I rejects those commands when they target the built-in slot and proves
the dedicated add/replace/reorder/remove/clear operations through the public
ChangeSet and CLI contract. PR-F routes every renderer, paste, import, clone, and
automatic producer through those final operations.

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

### 9. Delivery Units, Dependencies, Risks, And Implementation Surface

The implementation baseline is the final #592 Outliner Runtime, field, asset,
preview, UI-state, and quit/recovery architecture. Each delivery unit starts from
current main and regenerates its exact file queue from repository searches; no
consumer is written against an interim protocol.

#### PR-I: Final Shared Interfaces

This human-led interface-only prerequisite owns the coordinated shared/protocol
change required by A4 and A10:

- replace `url` with the final `uri` field contract and mechanically update only
  the existing generic field consumers needed to keep main buildable;
- seed protected `field:source` and land final URI value identity/order schemas,
  `asset://local/...` and file/web parser/formatter contracts;
- land public `add-source`, `replace-source`, `reorder-source`, `remove-source`,
  and `clear-sources` commands plus Core/Runtime structural and settlement guards;
- land the Host-private exact-file grant store, grant/revoke/relink resolver, safe
  action boundary, and final preload/Runtime DTOs without starting renderer
  resource composition; and
- prove protocol encoding, CLI/ChangeSet admission, replay, clone-owner behavior,
  malformed-state rejection/degradation, grant persistence, and exact-file
  denial through contract tests.

PR-I retains the current special Node consumers until PR-F and creates no dual
Source writer or compatibility decoder. Its interfaces are final and build/test
green, but it intentionally does not expose the new resource UI. This is the
repository's explicit shared-interface-first exception, not a standalone partial
MVP and not a basis for parallel consumer work before merge.

#### PR-F: Complete Resource Cutover

After PR-I merges, one complete user-visible PR:

- routes URL, file, image, import, launcher, clone, and capture producers to
  ordinary Nodes plus ordered Source values;
- moves all managed-asset liveness, history, classification, and search behavior
  to every Source relationship;
- composes preview-first rows, selected-source switching, recoverable Hide/Show,
  Source editing/order controls, and all failure states in Outliner and Node page;
- rebinds the complete existing preview/reader responsibility inventory;
- deletes the Outline `image`/`attachment` Node protocol and every special
  producer/consumer; and
- folds the final behavior into current specs and provides core, renderer, E2E,
  clean-userData, accessibility, and light/dark visual evidence.

Only after PR-F lands may `agent-result-and-file-lifecycle` build its Outline
consumer. That later plan may share or clone exact revisions into Outline
AssetRecords, but it must create ordinary Nodes with ordered managed Source
values rather than special attachment/image Nodes.

Expected implementation areas are re-derived per unit rather than treated as a
fixed file checklist. PR-I owns shared Core commands/types, field and Runtime
schemas, Source codecs/admission, Host grant persistence/resolution, and contract
tests. PR-F owns the Node-union retirement, Runtime liveness/index consumers,
renderer ingest/composition/view state, preview reuse, current specifications,
and user-visible verification.

Primary risks are a managed asset being collected while any non-selected Source
still references it; source selection leaking into document or child disclosure;
async work from an old selection replacing the current preview; a file chooser
grant widening to a sibling or surviving revocation; malformed generic mutations
bypassing Source settlement; field values being counted as ordinary children;
metadata destabilizing projection/search; and accidental retirement of Agent
attachment/image types. Each risk has an explicit guard or acceptance criterion
below.

### Acceptance Criteria

- **AC-1:** When a bare URL is pasted into an empty row, one atomic operation
  keeps/materializes that Node, writes URL content, adds one Source URI value, and
  shows it when it is the first Source. Existing Source values are never replaced
  implicitly; an additional value preserves the current selection and visibility.
- **AC-2:** When a URL is pasted into selected or non-empty prose, the editor
  creates or inserts an inline rich-text link and does not add Source.
- **AC-3:** When an image or other file is pasted, dropped, or picked, the result
  is an ordinary content Node plus a first managed Source value; no `image` or
  `attachment` Node exists in state, command payloads, or projection.
- **AC-4:** When content is cleared, every Source value, selection, tags, other
  fields, children, managed liveness, and preview remain unchanged.
- **AC-5:** When Hide preview is activated, only local visibility changes and the
  selected/default Source row immediately exposes Show preview; every other row
  exposes Preview this source.
- **AC-6:** When a user selects another Source and then navigates or restarts,
  that stable value-row selection returns without a document mutation. Show
  preview resolves that selection; a missing selection falls back to the first
  value.
- **AC-7:** When the Node chevron is activated, only ordinary children/trailing
  draft disclosure changes; Source selection and preview visibility are unchanged.
- **AC-8:** When the selected value is removed, preview falls back to the first
  remaining value. When the final value is removed, preview disappears and the
  Node remains ordinary with all unrelated content and descendants intact.
- **AC-9:** When a visible Source is selected or edited, async work from the old
  selection/value cannot overwrite the new preview. When hidden, replacement and
  reordering remain hidden.
- **AC-10:** If a selected Source is invalid, unsupported, missing, denied, or
  fails to load, that value stays editable and selected with usable recovery; the
  product does not silently choose another value or abort projection/editing.
- **AC-11:** A managed Source resolves only through its AssetRecord and scoped
  transport. A `file:` Source resolves only through an exact-file grant; editing
  an admitted `Documents/a.pdf` URI to an unadmitted sibling remains denied. Raw
  paths and non-canonical `asset:` forms fail Source resolution.
- **AC-12:** Removing, replacing, clearing, or cloning managed Source values
  updates each relationship only after commit; every selected and non-selected
  live value plus undo/redo and crash recovery retains bytes needed by a
  recoverable document state.
- **AC-13:** Tags and ordinary fields can be added before or after Source without
  changing Source order, selection, renderer choice, or preview visibility.
- **AC-14:** The selected YouTube value uses the supported inline player; a
  selected ordinary page uses a compact summary; selected image/document/media/
  unsupported file values choose their corresponding shared renderer and retain
  selected-source Open behavior.
- **AC-15:** A resource Node referenced elsewhere remains a normal Node reference.
  Its authored content is the label when non-empty; an empty content label may
  use the selected/default Source's readable fallback without changing stored
  content.
- **AC-16:** `HAS_MEDIA` and media-kind queries match when any Source value has
  the derived classification, regardless of which value is locally selected.
- **AC-17:** Full-tree source guards find no retired Outline special-Node or `url`
  field protocol authority while continuing to admit the named Agent, Markdown,
  and preview concepts.
- **AC-18:** Light and dark E2E evidence covers shown, hidden/recoverable, empty
  title, multi-Source switching/reordering/removal, unavailable selected value,
  YouTube, ordinary URL, image, document, and ordinary-child states without
  overlap, reflow-on-hover, or broken keyboard navigation.
- **AC-19:** The post-#592 preview responsibility inventory is empty only after
  every retained file reader, media control, action, reader-state restoration,
  translation path, security boundary, and accessibility behavior has equivalent
  Source-backed evidence; absence from the new Node scalar shape is not a valid
  retirement reason.
- **AC-20:** Public CLI/ChangeSet tests prove dedicated Source operations preserve
  one field slot with ordered direct URI values, while generic `append-text`,
  `append-reference`, `append-nodes`, `append-field`, and direct content mutation
  cannot target Source or bypass asset settlement.
- **AC-21:** Create, move, direct-value clone, paste/import, template/default,
  restore, undo/redo, and replication/change admission reject malformed Source
  structure. Cloning a complete valid owner preserves its ordered values; runtime
  projection of impossible duplicate slots degrades Source only and chooses none.
- **AC-22:** After an exact-file chooser grant and restart, the same Source
  remains usable; Forget local-file access revokes only that exact grant, leaves
  Source text intact, and makes every dependent value denied without affecting
  sibling or managed/web sources.
- **AC-23:** Relink accepts a chosen file only when it resolves to the denied
  Source's exact target. Replace Source may choose a different file and persists
  its grant before the document update; a failed settlement removes a newly
  orphaned grant and leaves the previous Source/grant unchanged.
- **AC-24:** A symlink retarget makes its Source denied, while ordinary content
  replacement at the same non-symlink path remains a valid live source after
  opened-file identity checks. A missing, unreadable, or corrupt grant store
  denies external file Sources without aborting Outline or authorizing any path.

## Open questions

None. `Source`, `field:source`, fixed ordered multi-value `uri`, first-value
default with local source selection, the post-#592 canonical
`asset://local/{encodedAssetId}` form, managed capture by default, exact-file
local linking, preview-first resource layout, recoverable local Hide/Show state,
and clean removal of Outline `image`/`attachment` are coordinated design
decisions. A redirect on any of them changes the protocol or product behavior
and must happen during plan review rather than being guessed during build.

## Build Checklist

- [ ] PR-I: claim the shared interface from current main after repeating the open
      PR/file collision check; coordinate ownership of Core protocol files.
- [ ] PR-I: cut `url` to `uri`; land protected ordered multi-value Source, final
      Source mutations/codecs, structural and settlement guards, and public
      CLI/ChangeSet contract tests.
- [ ] PR-I: land exact-file grant persistence, revoke/relink/replace semantics,
      Host action validation, corruption degradation, and restart/security tests.
- [ ] PR-I: keep current main buildable without adding renderer Source consumers;
      run typecheck, core/contract tests, source guards, and docs checks.
- [ ] PR-F: regenerate the special-Node, asset-liveness, preview, paste, query,
      selection-view-state, and specification queues from the merged interfaces.
- [ ] PR-F: generate and disposition the current file-preview responsibility
      inventory; preserve all renderer/control/reader behavior except the
      explicitly replaced special-Node host assumptions.
- [ ] PR-F: move every ingest/capture/import, managed-asset relationship, derived
      classification, query, history, and recovery path to ordered Source values.
- [ ] PR-F: implement preview-first composition, persistent Source selection,
      recoverable Hide/Show, switching/reordering/editing, renderer selection,
      and failure recovery.
- [ ] PR-F: remove Outline special Node/command/projection/search/reference
      branches and make the generated retirement work queue empty.
- [ ] PR-F: fold design into current specs; run `bun run typecheck`,
      `bun run test:core`, `bun run test:renderer`, relevant E2E, light/dark
      visual verification, `bun run docs:check`, and clean-userData verification.
