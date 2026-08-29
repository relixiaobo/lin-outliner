# Outline Source Resources And Derived Previews

**Shape:** (b) A SET with two ordered delivery units. **PR-I** is the
repository-required, human-led interface cut: it lands the complete final
URI/Source protocol, removes the special Node/command protocol, moves every
current producer and consumer to the new model, and includes a complete
content-first desktop management surface for every Source state its public
contract can create. **PR-F** then ships one independent user-visible enhancement
entirely on those merged interfaces: Tana-inspired preview-first composition,
compact toolbar switching, refined Hide/Show placement, current UI
specifications, and end-to-end evidence. PR-I is the A10 shared-interface
prerequisite and a complete truthful baseline rather than groundwork; PR-F
changes no Core command/type or public Runtime/preload schema and is not required
to explain or repair PR-I state.

## Goal

Give URLs, images, and other files one Outline model and one interaction:

```text
Node: content = editable RichText, possibly empty
|- Source field entry: ordered text values, fieldType = uri
|- other field entries
`- ordinary child Nodes

preview = derive(Source text, classification, Host resolution, local view state)
```

`Node` above is the object represented by the content row; it is not an extra
container row. `content` is the Node's own editable text, not a child. Field
entries may be represented structurally below the Node, but they are typed field
slots rather than ordinary child Nodes. A preview is presentation only and never
occupies an Outline level.

A Node with at least one Source value is informally a resource Node, but it
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
  with a new generic card. The deliberate exception is that live external
  `file:` Sources cannot offer path-only OS Open/Reveal actions under an
  exact-file grant; managed assets retain those actions, and verified-handle
  preview/read/copy remains available for external files.
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
  multi-value cardinality. Every ordinary content Node is created atomically with
  exactly one protected, permanently addressable Source entry; zero live values
  projects as no visible Source field. Users may add, replace, reorder, or remove
  values but cannot change the definition's type, entry, or cardinality.
- **FR-3:** Represent every Outline resource as an ordinary content Node whose
  authoritative source relationships are the Source field values. Delete the
  Outline `image` and `attachment` Node variants and their dedicated mutation
  paths.
- **FR-4:** Store each Source value as the exact text scalar supplied by its
  author or producer. Syntax validity, scheme support, normalization, and current
  authority are derived concerns rather than write-admission rules. Automatic
  producers may supply canonical web, managed-asset, or local-file URIs, while
  manual edits remain lossless.
- **FR-5:** Purely classify stored Source text before Host resolution. Derive
  preview kind, readable label, metadata, available actions, availability, and a
  usable failure reason from the classification plus current Host authority;
  share that boundary across list rows, Node pages, search classification, and
  preview opening.
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
- **FR-14:** Make Source creation, value identity, order, replacement, removal,
  and clearing converge under valid concurrent offline edits. Replication never
  rejects or disables a state produced by two valid Source commands.
- **FR-15:** Permit `add_source` and `replace_source` to commit any Source text.
  Classification is pure and permission-independent; authorization occurs only
  when the Host resolves a recognized supported locator. Invalid, unsupported,
  denied, missing, and temporarily unavailable values remain durable and
  editable.
- **FR-16:** Add one final `sourceValue` Node variant whose required
  `sourceText` string is the only direct value representation below
  `field:source`. It remains a tree Node so ordinary descendants retain identity,
  but it has no RichText `content`, cannot own fields or tags, and never receives
  a protected Source entry of its own.
- **FR-17:** Require every public Source update to target exactly one ordinary
  owner and every value/anchor reference to target exactly one live direct
  `SourceValueNode` under that owner. Bulk work uses explicit per-owner
  operations, never generic update fan-out or inferred anchor pairing.
- **NFR-1:** Invalid, unsupported, missing, denied, or temporarily unavailable
  committed sources degrade locally with a distinct reason and recovery where
  one exists. They never remove Source, rewrite content, or abort an otherwise
  valid Outline projection.
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

The stored shape keeps the existing `FieldEntryNode` for the protected slot but
uses one specialized direct-value variant rather than pretending Source text is
RichText content. The stable Source definition identifies the slot by ID, never
by its rendered label. A resource predicate conceptually means:

```ts
isResourceNode(node, index) = hasAnySourceValue(node.id, 'field:source')
```

It does not inspect tags, title text, file extensions in `content`, capture
sidecars, or a special Node discriminant. Adding tags never creates, removes, or
changes a preview.

Source is ordered and multi-valued because one Node may collect alternative or
related representations while showing one unambiguous preview at a time. Every
ordinary content-Node constructor creates its empty protected Source entry in the
same transaction as the owner. The entry receives one fresh ID from that creation
and is never deleted independently, even when it has no live values. Because an
owner must exist before two replicas can edit it offline, every replica therefore
targets the same causally established CRDT entry rather than independently
creating duplicate field entries. The projection hides an empty entry, so this
storage invariant does not create a visible empty field.

The final stored and projected variant is exact:

```ts
interface SourceValueNode {
  type: 'sourceValue';
  id: NodeId;
  parentId: NodeId;
  children: NodeId[];
  sourceText: string;
  createdAt: number;
  updatedAt: number;
  locked: boolean;
}

type SourceValueProjection = SourceValueNode;
```

PR-I splits the current monolithic `NodeBase` into a structural base and the
existing RichText-bearing base so `content` remains required on every content
variant instead of becoming globally optional. `SourceValueNode` implements only
the structural contract shown above.

Those are the complete public fields for this variant. It has no `content`,
description, tags, fields, capture metadata, asset metadata, or separate URI
property. `parentId` must name the one permanent `FieldEntryNode` for
`field:source`; that entry's direct children must all be `sourceValue` Nodes, and
`sourceValue` cannot appear elsewhere. A Source value remains a tree Node only so
ordinary content descendants can attach through `children`, retain their normal
identity and editing semantics, and disappear/return with Source remove/undo.
Those descendant content Nodes receive their own protected Source entry normally;
the `SourceValueNode` itself is not a content or field owner and is never seeded
with another Source entry.

The Loro codec stores `type` and `sourceText` as scalar keys in the value Node's
map. It never creates a `LoroText` container or `content` key for this variant, so
concurrent replacement of `sourceText` is one atomic map-register conflict rather
than character-level text merging. Decode and non-replication admission require
the exact discriminator, a string `sourceText`, the protected parent, and absence
of `content`; projection mirrors the fields above. Runtime projection degrades
only the affected Source presentation if an impossible malformed value somehow
reaches inspection, while persistence/write admission fails closed.

The public ChangeSet adds this exact instruction union inside an `update`. Source
instructions deliberately do not inherit the generic update loop's bulk
cardinality. They use a restricted reference:

```ts
type OneTargetRef =
  | { target: TargetSpec & { cardinality: 'one'; max?: never } }
  | { binding: BindingName }; // only a statically single-result binding
```

A binding is eligible only when its producing operation is statically guaranteed
to bind exactly one Node; a binding from a many/zero-or-one result or a
multi-Node create is rejected during ChangeSet normalization. Resolution still
asserts exactly one live result so stale or malformed input cannot bypass the
declared cardinality.

The enclosing `update.targets` must be a `OneTargetRef` resolving exactly one
ordinary content owner. `value` and non-null `after` use the same restricted
shape and must each resolve exactly one live direct `SourceValueNode` under that
owner's protected Source entry:

```ts
type SourceInstruction =
  | { kind: 'source'; action: 'add'; sourceText: string;
      valueId?: NodeId; after?: OneTargetRef | null }
  | { kind: 'source'; action: 'replace'; value: OneTargetRef;
      sourceText: string }
  | { kind: 'source'; action: 'reorder'; value: OneTargetRef;
      after: OneTargetRef | null }
  | { kind: 'source'; action: 'remove'; value: OneTargetRef }
  | { kind: 'source'; action: 'clear' };
```

Omitted add `after` appends; `after: null` means first position. Reorder rejects
an anchor equal to its value. Add rejects a caller-supplied `valueId` already in
use anywhere. Any `many`, zero-result, cross-owner, non-Source, indirect
descendant, deleted, or otherwise invalid owner/value/anchor reference rejects
the whole ChangeSet before mutation. Lowering resolves this one owner/reference
set once and allocates an omitted `valueId` before creating one of the final Core
commands:

```ts
type SourceCommand =
  | { type: 'add_source'; ownerId: NodeId; valueId: NodeId;
      sourceText: string; afterValueId?: NodeId | null }
  | { type: 'replace_source'; ownerId: NodeId; valueId: NodeId;
      sourceText: string }
  | { type: 'reorder_source'; ownerId: NodeId; valueId: NodeId;
      afterValueId: NodeId | null }
  | { type: 'remove_source'; ownerId: NodeId; valueId: NodeId }
  | { type: 'clear_sources'; ownerId: NodeId;
      observedValueIds: readonly NodeId[] };
```

`clear` captures the currently observed direct value IDs during lowering so an
unseen concurrent add survives replay. Replace preserves value identity,
position, descendants, and local selection. The Runtime/preload and CLI expose
the ChangeSet instruction above rather than a second Source mutation shape. Bulk
Source work requires one explicit single-owner update operation per owner inside
the same ChangeSet, each with its own value ID and owner-local anchors; there is
no implicit owner-to-value pairing or inherited generic update fan-out.

The CRDT owns deterministic order and scalar conflict resolution. Concurrent
adds retain both unique values in converged order. Concurrent add/reorder retains
the added value and converges on the CRDT move result. Remove wins over a
concurrent reorder of the same value; it never removes a concurrently added
different value. Concurrent replacements of the same value converge through the
atomic scalar register and never splice two Source strings. Replaying or
delivering any of these valid changes in either order produces identical Source
values and order.

The invariant is enforced below renderer helpers, at every public and persisted
mutation boundary:

- generic field-slot `append-text`, `append-reference`, `append-nodes`, and
  `append-field` actions reject `field:source`;
- generic content editing rejects a direct Source value row, so Source edits are
  lowered to `replace_source` rather than bypassing managed-asset settlement;
- generic create-tree, direct value duplication, move-into-slot, paste/import,
  template/default/auto-init, and field-copy paths cannot synthesize Source;
- cloning or duplicating an entire valid owner Node may reproduce its ordered
  Source relationships under the clone's newly created protected Source entry,
  but copying only a Source value must use the dedicated add operation;
- command replay, undo/redo, restore, and replication apply valid Source CRDT
  operations without post-merge rejection; persistence/change admission rejects
  only states that no valid command can produce, such as a missing/second Source
  entry, a non-`sourceValue` direct child, or a non-atomic value representation;
  and
- importers and other bulk producers create the owner first and emit the same
  dedicated Source mutation rather than constructing a privileged field tree.

The dedicated mutations are also settlement boundaries. A managed URI becomes
visible only after its asset lease is ready; replacing, removing, or clearing a
managed value releases only the affected relationships after document commit.
Every managed Source value keeps its AssetRecord live whether selected, hidden,
or off screen. After concurrent scalar writes converge, reconciliation retains
the winning managed URI and conservatively releases a losing revision only when
no live document/history/transaction relationship still names it.

Multiple direct Source values, including invalid or unsupported text, and every
merge of valid Source commands are valid; duplicate/missing Source entries,
non-`sourceValue` direct children, and generic mutations that bypass settlement
are not. Runtime projection encountering one of
those impossible structures never chooses an arbitrary entry: the Node remains
usable and Source presentation becomes unavailable. Persistence, command
decoding, and non-replication change admission reject such malformed structure
fail closed so new corruption cannot enter the store. A valid replication merge
is never classified as malformed or silently healed by discarding a user's value.

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
URI fields retain the ordinary editable value-row model with inline status and
safe link affordances. The field type describes how the product interprets the
value; it does not reject text at the document boundary. Every committed Source
keeps the exact supplied scalar across navigation, restart, replication, and
undo/redo.

`classifySource(text)` is a pure, permission-independent operation with three
outcomes:

- **supported locator:** the text matches a recognized Source family and yields
  a normalized locator for derived use without rewriting stored text;
- **unsupported URI:** the text is a syntactically valid absolute URI whose
  scheme or shape has no Source adapter; and
- **invalid text:** the text is not an absolute URI, or it names a reserved
  supported scheme such as `asset:` without that scheme's required shape.

Classification performs no filesystem access, network request, grant lookup, or
document mutation. Host resolution consumes the classification plus current
authority. A supported locator resolves to `ready`, `denied`, or `unavailable`;
the other classifications resolve directly to `unsupported` or `invalid`.
Permission therefore changes resolution, never parsing or stored Source text.
Only a ready supported family activates its full resource preview; every other
selected value shows its specific reason and available recovery instead of
silently selecting another Source.

The classifier recognizes these supported families when their syntax matches:

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

A raw local path may remain stored as Source text, but it classifies as invalid
rather than acquiring ambient filesystem meaning. File choosers and path-aware
importers produce an absolute standard `file:` URI. A syntactically valid file
URI still grants no access. Manually entered, pasted, or edited file URIs without
a matching exact-file grant resolve as denied with a Choose File recovery action;
they do not silently gain ambient access. Invalid path text instead offers Edit
or Replace Source because there is no parsed target to authorize.

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

- `add_source` and `replace_source` may commit any Source text without a grant.
  When that text classifies as a supported `file:` locator, resolution and all
  byte actions return denied until an exact matching grant exists;
- chooser-driven add/replace resolves the selected locator, requires a regular
  file, and persists the exact-file grant before committing the corresponding
  file URI. This is transaction ordering for a smooth authorized result, not a
  write-admission rule;
- a grant may be reused by another Source only when its locator again resolves to
  the same canonical file; a separately admitted exact grant for another file is
  independently reusable;
- manually editing a `file:` URI from `Documents/a.pdf` to `Documents/b.pdf`
  remains denied unless `b.pdf` already has its own exact grant, even though both
  share a directory;
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
  remains valid for a live Source. Each preview/read/copy operation opens with
  no-follow semantics, verifies the opened regular-file identity against a fresh
  canonical resolution and grant, and consumes that same handle. Copy file
  streams from the verified handle to a user-chosen destination.

Electron `shell.openPath` and `shell.showItemInFolder` consume a pathname after
validation, not the verified handle. The filesystem entry can change before the
OS resolves that path, so live external `file:` Sources do not expose **Open with
default app** or **Show in Finder**. Revalidation immediately before dispatch is
not considered sufficient. Those actions remain for Host-managed AssetRecords,
whose materialization and action authority are separate from an external
exact-file grant. A future platform mechanism may restore external Open/Reveal
only if the OS action consumes the already verified object without re-resolving
an attacker-replaceable path.

Exact-file grants are profile authorization, not revision identity. They grant
only verified-handle Source preview/read/copy operations defined by the Host
action policy. They do not grant Agent ambient filesystem access, expand an
Agent external-root capability, admit directories, weaken dangerous-open checks,
or act as ownership. Classification remains pure and side-effect free.

Resolution returns a descriptor, not a universal product object:

```ts
type ResolvedNodeSource = {
  sourceValueId: string;
  sourceText: string;
  normalizedUri?: string;
  kind?: 'web' | 'image' | 'document' | 'audio' | 'video' | 'file';
  label: string;
  previewTarget?: PreviewTarget;
  availability: 'ready' | 'invalid' | 'unavailable' | 'denied' | 'unsupported';
  reason?: SourceResolutionReason;
  actions: readonly SourceAction[];
};
```

This is a derived boundary shape, not canonical Node state. AssetRecord metadata
is authoritative for managed MIME type, filename, dimensions, page count, and
duration. Remote classification uses the same provider/URL/observed-metadata
rules as preview rendering; unsupported or unknown remote kinds remain web
sources rather than guessed files.

`loading` is transient preview-request state layered over a descriptor, not a
classification/resolution outcome. `SourceResolutionReason` supplies stable
reason codes and concise presentation copy so invalid syntax, unsupported
families, missing resources, denied authority, and load failures are not
collapsed into one generic error. Recovery is state-specific: edit/replace for
invalid text, an authorized chooser for a denied local file, retry for a
temporary unavailable result, and an allowed external-open action where an
unsupported but valid URI can still be navigated safely.

The resolver returns one descriptor per direct Source value in document order.
The presentation layer joins those descriptors with the local selected-value ID;
if that ID no longer exists it selects the first value. Resolution never writes
selection into the document or silently skips an unavailable selected value.

Source presentation remains truthful without exposing internal noise by default:
recognized web sources show a readable normalized URL, `file:` sources show the
decoded path, and managed assets show their AssetRecord filename plus a quiet
managed-copy cue. Editing or **Copy URI** exposes the exact stored value.
Presentation labels never become a second stored locator, and a user may add or
replace a Source value through paste, editing, or the appropriate chooser.

### 3. Resource Preview Interaction

PR-I ships a complete, truthful content-first baseline before the visual
enhancement begins. It keeps the preview in the current host position, but the
Source field lists every direct value in converged order and never derives the UI
from only the first value. Each row shows its readable label plus
`ready`/`invalid`/`unsupported`/`denied`/`unavailable` status and reason, and
provides keyboard-accessible Select/Preview, Edit, reorder, and Remove actions.
The field exposes Add source and Remove all; chooser-backed actions retain their
authorization rules. Selecting a row persists its value ID in final local view
state and drives the current preview host. Show/Hide preview uses the final local
visibility state and remains independent of child disclosure. A Source committed
through CLI/ChangeSet appears immediately and can be selected, edited, reordered,
removed, or cleared in the desktop without using the CLI again.

That baseline is intentionally visually conservative, not temporary or
first-value-only. PR-F may move and compact the same complete controls, but it
cannot make previously hidden state visible, add a missing management operation,
or repair state that PR-I could create but not explain.

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

The Source field renders one typed value row per committed Source scalar. The
selected row uses a neutral indicator, not an accent fill. Each non-selected row
exposes an icon action named **Preview this source**; activating it selects the
value and shows the preview if hidden. Existing field-value ordering gestures
reorder Source values. Switching, hiding, and showing remain usable from the
keyboard and do not move focus into an interactive preview body.

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
icon is present on the selected/default value; for a non-ready value it restores
the preview region with the specific reason and recovery rather than an empty
body. Other values expose **Preview this source**. This is the recovery path
missing from the observed Tana interaction.

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
  resolved source supports them; external live files deliberately support only
  actions that consume a verified handle, so their path-only Open/Reveal actions
  are absent rather than weakened;
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
| Unpreviewable file type | Compact filename/type/size summary with only the actions authorized for that source family |

Provider adapters consume classified normalized locators and build embed
targets; they never store provider-specific Node types. YouTube navigation and
playback remain inside the existing guest/sandbox and external-navigation policy.
An ordinary web summary must render a usable host/URL fallback immediately and
may enrich through the existing unprivileged preview path; this feature adds no
privileged arbitrary-URL fetcher.

Loading uses a stable aspect ratio or bounded summary height. Failure replaces
only the selected preview body with a compact reason and state-specific recovery.
Committed invalid Source text replaces the previous preview with an invalid-value
reason and remains editable; it does not retain a stale preview for the previous
text. A missing managed AssetRecord, denied file source, failed remote metadata
load, unsupported family, or embed failure never deletes or rewrites any Source
value or silently selects a different one.

### 6. Paste, Drop, Picker, And Capture Flows

#### FLOW-1: Paste A Bare Web URL

1. The editor receives exactly one bare `http:`, `https:`, or normalizable `www.`
   URL with no additional prose or files.
2. If the target content is empty, the paste command atomically writes the
   normalized URL as content and appends that producer-normalized text to Source.
   It creates the Source slot when absent and never replaces an existing value
   implicitly.
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
- Editing commits the supplied Source text losslessly, then reclassifies and
  resolves it. Invalid text shows its reason instead of preserving the old
  preview; correcting it re-resolves without replacing the value-row identity.
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

#### FLOW-5: Manage A Source Created Outside The Desktop

1. A public CLI/ChangeSet commits an additional valid, invalid, unsupported, or
   unauthorized Source against an ordinary owner while PR-I is the shipped UI.
2. The next projection update inserts that exact value in the desktop Source
   field at its converged order and derives its status/reason without rewriting
   text or selecting a different value.
3. The user may select it to preview or inspect the failure reason, edit it,
   reorder it, remove it, or clear all Sources through the same content-first
   controls used for desktop-created values.
4. Selection and visibility survive navigation/restart; removing the selected
   value follows the normal fallback rule. A transient resolution failure offers
   Retry, denied local files offer the chooser, and invalid text offers Edit or
   Replace Source.

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
lands its final `uri` registry, classification, icon, config, search, import,
launcher, and tests. It also lands the protected Source definition, dedicated
ordered Source mutations, structural admission guards, URI codecs, exact-file
grant/resolver contracts, and the complete final Node/command/Runtime shape. The
same coordinated PR-I cut removes:

- Outline `ImageNode` and `AttachmentNode` variants and their discriminants;
- the assumption that every Node variant owns RichText `content`, while adding
  only the final `sourceValue` discriminator and `sourceText` scalar;
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
ChangeSet and CLI contract. PR-I also routes every current file/image producer,
asset-liveness consumer, query/search path, and renderer input adapter through
those final operations so its head has no special protocol consumer left to
compile against.

The retained UI composition stays buildable through the complete content-first
Source surface defined above. Its renderer-local presentation adapter resolves
the locally selected value into the existing neutral `PreviewTarget`; it never
truncates the field or semantics to the first Source. Every value and failure
reason remains visible and all public mutations remain manageable before PR-I
merges. The adapter is neither a legacy Node reader nor a public compatibility
type: it reads only final `SourceValueNode` projections and resolved descriptors.
PR-F rearranges this already complete surface into the approved preview-first
composition; it does not reveal previously hidden state or alter protocol.

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

#### PR-I: Final Shared Interfaces And Truthful Baseline

This human-led interface cut owns the coordinated shared/protocol change required
by A4 and A10 plus the complete management adaptation required for a buildable,
behavior-preserving, and independently usable main:

- replace `url` with the final `uri` field contract;
- split the structural Node base from RichText-bearing variants, add the exact
  `SourceValueNode`/Projection and scalar Loro codec, and make every ordinary
  content-Node constructor seed its permanent Source entry;
- land convergent value identity/order semantics, `asset://local/...`, and
  file/web classifier/formatter contracts;
- land the public `SourceInstruction` union and five final `SourceCommand`
  variants plus Core/Runtime structural and settlement guards;
- land the Host-private exact-file grant store, grant/revoke/relink resolver, safe
  verified-handle action boundary, and final preload/Runtime DTOs;
- remove special Outline Node types and commands from Core and every public
  Runtime/ChangeSet/CLI schema in this same interface cut;
- mechanically route all current producers, managed-asset liveness/history,
  classification/query/search, and preview inputs to final Source APIs;
- ship the content-first desktop Source field with every value/status visible,
  persistent selection and visibility, all five management operations, and the
  selected descriptor bound to the retained preview host; and
- prove protocol encoding, public CLI/ChangeSet admission, two-replica
  convergence, clone-owner behavior, impossible-state degradation, grant
  persistence, external action narrowing, exact-file denial, and CLI-created
  secondary/invalid Source management through tests.

PR-I creates no dual Source writer, special-Node reader, deprecated protocol
alias, interim DTO, first-value-only adapter, or unreachable mutation. Its
content-first presentation consumes final Source descriptors and is complete for
all public state even if PR-F never ships. This is the required
shared-interface-first claim; no later consumer begins before it merges.

#### PR-F: Complete Preview-first Enhancement

After PR-I merges, one complete user-visible PR:

- adds bare-URL resource paste and context-menu Source-entry commands on the
  already manageable final data model;
- moves the retained preview before content, adds the compact toolbar switcher,
  and refines recoverable Hide/Show placement in Outliner and Node page;
- re-composes PR-I's complete Source controls and failure states without changing
  their semantics, while reusing the complete existing preview/reader
  responsibility inventory; and
- folds the final interaction into current UI/design/preview specs and provides
  renderer, E2E, clean-userData, accessibility, and light/dark visual evidence.

PR-F does not modify `src/core/types.ts`, `src/core/commands.ts`, public Runtime
schemas, Source URI/command semantics, exact-file grants, or special-Node
retirement. Discovering that a shared interface is missing stops PR-F and sends a
human-led correction through the interface owner; it is not filled in as a
feature-PR drive-by.

After PR-I lands, `agent-result-and-file-lifecycle` may build its Outline
consumer once its Agent-side prerequisites are satisfied. PR-F has no dependency
edge to that consumer and is independently orderable after PR-I. The later Agent
plan may share or clone exact revisions into Outline AssetRecords, but it must
create ordinary Nodes with ordered managed Source values rather than special
attachment/image Nodes.

Expected implementation areas are re-derived per unit rather than treated as a
fixed file checklist. PR-I owns shared Core commands/types, field and Runtime
schemas, Source codecs/admission, special-protocol retirement, every mechanical
producer/non-visual consumer cutover, Host grant persistence/resolution, the
content-first Source controls/selection/view state/current preview adapter,
current architecture/protocol specs, and contract plus baseline renderer/E2E
tests. PR-F owns preview-first composition, compact toolbar placement,
preview-host layout replacement, current UI/design/preview specs, and enhancement
verification.

Primary risks are a managed asset being collected while any non-selected Source
still references it; source selection leaking into document or child disclosure;
async work from an old selection replacing the current preview; a file chooser
grant widening to a sibling or surviving revocation; malformed generic mutations
bypassing Source settlement; valid offline commands being rejected after merge;
path-only actions racing after validation; classification being conflated with
Host authority; `sourceValue` being decoded as RichText or recursively receiving
another Source entry; field values being counted as ordinary children; metadata
destabilizing projection/search; and accidental retirement of Agent
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
- **AC-10:** When any Source text is committed, including syntactically invalid
  text, its exact scalar remains editable, selected, and durable across restart.
  Classification and resolution show `invalid`, `unsupported`, `denied`, or
  `unavailable` with a distinct reason and usable recovery; the product neither
  restores the prior text/preview nor silently chooses another value.
- **AC-11:** A managed Source resolves only through its AssetRecord and scoped
  transport. A `file:` Source resolves only through an exact-file grant; editing
  an admitted `Documents/a.pdf` URI to an unadmitted sibling remains denied. Raw
  paths and malformed reserved `asset:` forms remain stored but classify as
  invalid, expose no managed/file authority, and recover through edit or replace.
- **AC-12:** Removing, replacing, clearing, or cloning managed Source values
  updates each relationship only after commit; every selected and non-selected
  live value plus undo/redo and crash recovery retains bytes needed by a
  recoverable document state.
- **AC-13:** Tags and ordinary fields can be added before or after Source without
  changing Source order, selection, renderer choice, or preview visibility.
- **AC-14:** The selected YouTube value uses the supported inline player; a
  selected ordinary page uses a compact summary; selected image/document/media/
  unsupported file values choose their corresponding shared renderer and expose
  only actions authorized for that family. Managed assets retain Open/Reveal;
  live external files retain verified-handle preview/read/copy but never path-only
  Open/Reveal.
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
  each ordinary Node's one permanent Source entry with ordered direct
  `SourceValueNode` values, while generic `append-text`, `append-reference`,
  `append-nodes`, `append-field`, and direct content mutation cannot target Source
  or bypass asset settlement.
- **AC-21:** Create, move, direct-value clone, paste/import, template/default,
  restore, undo/redo, and non-replication change admission reject Source
  structures no valid command can produce. Cloning a complete owner creates one
  new permanent entry and preserves ordered values; a `sourceValue` outside the
  protected entry or any other direct-child type inside it is invalid. Runtime
  projection of an impossible missing/duplicate entry degrades Source only and
  chooses none.
- **AC-22:** After an exact-file chooser grant and restart, the same Source
  remains usable; Forget local-file access revokes only that exact grant, leaves
  its committed URI intact, and makes every dependent value denied without
  affecting sibling or managed/web sources.
- **AC-23:** Relink accepts a chosen file only when it resolves to the denied
  Source's exact target. Replace Source may choose a different file and persists
  its grant before the document update; a failed settlement removes a newly
  orphaned grant and leaves the previous Source/grant unchanged.
- **AC-24:** A symlink retarget makes its Source denied, while ordinary content
  replacement at the same non-symlink path remains a valid live source after
  opened-file identity checks. Adversarial replacement after validation but
  before consumption fails a preview/read/copy operation because it consumes the
  already verified handle; no external Source Open/Reveal path reaches Electron
  shell dispatch. A missing, unreadable, or corrupt grant store denies external
  file Sources without aborting Outline or authorizing any path.
- **AC-25:** Two replicas that share an owner and concurrently perform the first
  `add_source` converge on its pre-existing Source entry with both unique values
  in the same order regardless of update delivery order; neither update is
  rejected and Source never becomes unavailable.
- **AC-26:** Two-replica tests deliver concurrent add/reorder, add/remove,
  clear/add, and replace/replace updates in both orders. They converge on the
  documented CRDT order, targeted/observed-remove, and atomic-scalar rules while
  asset settlement retains exactly the managed values present after convergence.
- **AC-27:** PR-I source guards prove no Outline `ImageNode`, `AttachmentNode`,
  special create/set command, or public ChangeSet/CLI variant remains and current
  producers/preview compile against only final Source interfaces. PR-F's guard
  proves it changes none of the named shared protocol files or public schemas.
- **AC-28:** Given the same stored supported `file:` Source text, classification
  is identical with or without an exact-file grant. Host resolution is `denied`
  without the grant and becomes `ready` after chooser authorization without a
  Source document mutation; malformed URI text remains `invalid` regardless of
  grants.
- **AC-29:** Codec, command, persistence, and Projection tests round-trip
  `SourceValueNode` with exactly `type`, `id`, `parentId`, `children`,
  `sourceText`, timestamps, and `locked`; no `content`/`LoroText` exists. Only
  the Source payload lives in the atomic `sourceText` Loro map register;
  concurrent replace converges on one whole scalar, the value receives no Source
  entry, and its ordinary content descendants do receive their own entries.
- **AC-30:** On the PR-I merge candidate, an E2E fixture creates a second valid
  Source and one invalid Source through the public CLI/ChangeSet. The desktop
  immediately lists every value in order with truthful status/reason, persists
  selection, previews or explains each value, and can edit, reorder, remove, and
  clear them without another CLI operation; no first-value-only adapter is
  present.
- **AC-31:** Public schema/normalization/lowering tests accept Source owner,
  value, and non-null anchor references only through `OneTargetRef` with exactly
  one resolved result. They reject declared or bound many/zero-or-one results,
  zero results, reused add IDs, self-anchors, cross-owner anchors, indirect
  descendants, and non-Source targets before any mutation. A multi-owner request
  succeeds only as explicit per-owner operations with independently paired IDs
  and anchors in one atomic ChangeSet.

## Open questions

None. `Source`, `field:source`, fixed ordered multi-value `uri`, the exact
content-free `SourceValueNode`/`sourceText` protocol, pure permission-independent
classification, Host-authorized resolution with distinct reasons, first-value
default with local source selection, one causally seeded permanent entry per
ordinary content Node, single-owner `OneTargetRef` Source instructions,
atomic/convergent Source values, the producer-generated post-#592 canonical
`asset://local/{encodedAssetId}` form, managed capture by default,
denied-but-durable file locators, exact-file verified-handle actions, omission of
unsafe external Open/Reveal, a complete content-first PR-I surface, independently
orderable preview-first PR-F enhancement, recoverable local Hide/Show, and PR-I
retirement of Outline `image`/`attachment` are coordinated design decisions. A
redirect on any of them changes protocol, security, or product behavior and must
happen during plan review rather than being guessed during build.

## Build Checklist

- [ ] PR-I: claim the shared interface from current main after repeating the open
      PR/file collision check; coordinate ownership of Core protocol files.
- [ ] PR-I: cut `url` to `uri`; land protected ordered multi-value Source, final
      structural/RichText base split, exact `SourceValueNode`/Projection,
      scalar-map codec, single-owner `OneTargetRef` command/ChangeSet payloads,
      permanent-entry/convergence semantics, lossless write admission, pure
      classification, Host resolution, settlement guards, and public
      CLI/ChangeSet contract tests.
- [ ] PR-I: land exact-file grant persistence, revoke/relink/replace semantics,
      verified-handle preview/read/copy, external Open/Reveal omission, corruption
      degradation, and adversarial replacement/restart/security tests.
- [ ] PR-I: retire special Node/command/Runtime protocol; mechanically cut every
      current producer, liveness/history/query/search consumer, and preview input
      to Source and generate/disposition the file-preview responsibility inventory.
- [ ] PR-I: ship the complete content-first Source field, selected preview host,
      local selection/visibility, status/recovery, and all management actions;
      prove CLI-created secondary/invalid values are manageable in desktop.
- [ ] PR-I: keep current behavior buildable without dual protocol; run typecheck,
      core/renderer/contract/E2E and two-replica tests, source guards, current
      architecture/protocol/UI spec checks, light/dark evidence, and docs checks.
- [ ] PR-F: regenerate only preview-first composition, paste-URL convenience,
      compact-toolbar, and UI-specification queues from the complete merged
      baseline.
- [ ] PR-F: implement preview-first placement, compact switching, and refined
      recoverable Hide/Show while preserving PR-I management, renderer selection,
      failure recovery, and the complete preview responsibility inventory.
- [ ] PR-F: enforce the no-shared-protocol diff guard; fold interaction into
      current UI/design/preview specs; run `bun run typecheck`,
      `bun run test:core`, `bun run test:renderer`, relevant E2E, light/dark
      visual verification, `bun run docs:check`, and clean-userData verification.
