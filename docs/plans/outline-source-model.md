# Outline Source Model And Desktop Baseline

**Shape:** ONE coordinated interface feature in one PR.

## Goal

Give URLs, images, and files one final Outline representation and a complete
desktop management baseline without introducing a protected Source subsystem:

```text
ordinary content Node
|- editable RichText content
|- optional ordinary URI field entry
|  `- ordinary editable value Nodes containing locator text
|- other fields
`- ordinary child Nodes

preview = derived presentation of one selected URI value
```

A Node never becomes a special resource object. Adding, editing, moving, or
removing URI values uses normal field and Node behavior; preview is only a
consumer of values under the built-in URI definition. Content, URI values,
selected preview value, preview visibility, and child disclosure remain
independent.

This PR is intentionally a large coordinated cut. It changes the Core document
protocol and must move every producer and consumer to the final model in the
same merge. A smaller protocol-only PR would leave an unusable or dishonest
desktop state and violate A4, A7, and A10.

## Non-goals

- No global `Resource` object, universal file identity, or ownership transfer.
- No separate URL, image, attachment, or file Node/field families.
- No claim that a URI grants filesystem or network authority.
- No persistence of preview DOM, fetched markup, player state, or remote
  metadata as Node content.
- No redesign of the mature preview bodies; this PR rebinds their host and
  preserves their behavior.
- No Agent resource-reference cutover. That plan consumes this final Outline
  model later.
- No migration, compatibility decoder, dual writer, or legacy special-Node
  reader. Pre-release verification uses reset userData with Tenon stopped.

## Design

### Canonical document model

- Replace field type `url` with `uri` in one protocol cut.
- Define one built-in field definition with stable internal ID `field:source`,
  user-visible name `URI`, fixed type `uri`, and ordered multi-value cardinality.
  The system definition remains locked so its identity and type cannot drift;
  this lock does not apply to field entries or values. Labels are not identity,
  so users may create unrelated fields named `Source` or `URI`.
- Create no field entry for a new Node. The first producer or ordinary field
  mutation creates a normal unlocked `fieldEntry` lazily. The user may delete
  the complete entry, and removing or clearing its final value removes the empty
  entry. Concurrent first writes may converge as multiple ordinary entries;
  consumers aggregate all direct entries with the same definition ID.
- Represent every URI as an ordinary RichText-bearing content Node under that
  entry. It can be edited, described, copied, moved, nested, duplicated, and
  deleted through the same operations as any other field value. There is no
  `sourceValue` Node type, `sourceText` storage key, deterministic entry ID, or
  Source-only codec/admission invariant.
- Store author-supplied URI text losslessly in `content.text`. Syntax, scheme support,
  normalization, classification, availability, and authority are derived at
  read/use time. Editing a working YouTube URL into another syntactically valid
  URL previews the new address; an invalid or unavailable address keeps the
  exact text and shows a local failure while remaining editable.
- Delete Outline `image` and `attachment` Node variants, their scalar fields
  (`assetId`, `mediaUrl`, `mediaAlt`, file metadata, and thumbnail fields), and
  their dedicated mutation, ChangeSet, CLI, import, search, and renderer paths.
- Preserve ordinary tags, fields, children, references, movement, duplication,
  search, undo/redo, and Node-page navigation without file-specific keyboard
  anchors, row identity, or type-icon bullets.
- Keep Agent attachment/image content, model image parts, `AssetRecord`,
  `PreviewTarget`, ContentStore, and rich-text links outside this retirement.

The built-in URI definition is semantically special only to opt-in consumers.
Preview resolution, media search, managed-asset reachability, and linked-file
authorization recognize `fieldDefId === 'field:source'`; they never recognize a
label and never grant that identity to another field named `Source` or `URI`.
This derived interpretation adds no mutation restriction. A value's scheme
never changes its field type or stored Node shape.

### Commands, convergence, and settlement

The public ChangeSet keeps a Source instruction family as a task-oriented
convenience adapter for preview and capture workflows:

```ts
type OneTargetRef =
  | { target: TargetSpec & { cardinality: 'one'; max?: never } }
  | { binding: BindingName }; // statically guaranteed to return one Node

type SourceInstruction =
  | { kind: 'source'; action: 'add'; sourceText: string;
      valueId?: NodeId; after?: OneTargetRef | null }
  | { kind: 'source'; action: 'replace'; value: OneTargetRef;
      sourceText: string }
  | { kind: 'source'; action: 'reorder'; value: OneTargetRef;
      after: OneTargetRef | null }
  | { kind: 'source'; action: 'remove'; value: OneTargetRef }
  | { kind: 'source'; action: 'clear' };

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

Lowering resolves exactly one owner and one owner-local direct URI value or
anchor where required, then emits `add_source`, `replace_source`,
`reorder_source`, `remove_source`, or `clear_sources`. Omitted `after` appends;
`after: null` means first position. `clear_sources` captures the value IDs the
caller observed. Replacing preserves value identity, position, descendants, and
local selection.

Normalization rejects declared or bound many/zero-or-one references, zero live
results, a reused caller-supplied `valueId`, a self-anchor, cross-owner or
indirect descendant anchors, and values outside a direct built-in URI entry.
Multi-owner work uses explicit independently paired owner operations inside one
atomic ChangeSet.

These commands do not own the mutation boundary. Generic field-slot operations
may create and edit `field:source`; generic text patches may change URI values;
ordinary tree operations may move, clone, or delete values and whole entries.
The convenience `add` path creates an entry only when none exists, `remove` and
observed `clear` remove an entry once it has no remaining values, and clone uses
ordinary subtree cloning. Generic and convenience paths must project the same
result.

Concurrent unique first adds retain both values even when they create two field
entries; add/reorder, add/remove, clear/add, and ordinary RichText editing inherit
the normal Loro tree convergence rules. Deleting the final value deletes its
entry, so a concurrent add targeting that same deleted entry does not resurrect
the parent; an add in an independent concurrent entry survives. Runtime
inspection skips malformed relationships and degrades only URI presentation
instead of aborting the user path.

Managed-asset publication settles bytes before document state can reference
them. Replace, remove, clear, clone, undo/redo, transaction, and history paths
release liveness only after document settlement and only when no value under a
direct built-in URI entry still names the exact revision. Coincidental
`asset://` text elsewhere in the document does not retain an asset. Selection
and preview visibility never participate in liveness.

### Classification and Host authority

Pure classification derives kind, label, metadata expectations, and supported
actions from stored text without consulting permission. Host resolution then
applies current profile, exact-file grant, AssetRecord, navigation, and network
authority. Invalid, unsupported, denied, missing, and temporarily unavailable
values remain durable and editable with distinct local reasons.

The supported locator families are final and non-overlapping:

| Stored Source | Meaning | Resolution authority |
| --- | --- | --- |
| `https://...` | mutable remote page or media | current URL/network policy |
| `asset://local/{encodedAssetId}` | managed exact Outline revision | verified `AssetRecord` and scoped transport |
| `file:///...` | explicitly linked live local file | persistent exact-file grant and verified handle |

The `asset://local/{encodedAssetId}` formatter/parser round-trips the complete
AssetRecord ID and is a document-protocol surface; callers never parse it ad
hoc. It does not make `asset:` an external link/reference-marker family or
expose a digest, anchor, lease, ContentStore path, or Host-private scope ID.

Raw paths and malformed reserved forms remain exact text but classify as
invalid. A valid ungranted `file:` locator classifies identically with or without
permission and resolves as denied until the chooser admits that exact file.

Resolution returns one derived descriptor per ordinary value under a direct
built-in URI entry, in document order, not another canonical product object.
The adapter property names retain `sourceValueId` and `sourceText`; they do not
describe a stored Node variant:

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

`loading` is transient request state layered over this descriptor. AssetRecord
metadata remains authoritative for managed files; labels, normalized locators,
and reason copy are derived and never become stored Source. Recovery is state-
specific: edit/replace invalid text, chooser-authorize a denied local file,
retry temporary unavailability, or navigate a safely openable unsupported URI.
Resolution never skips an explicitly selected unavailable value. Editing and
**Copy URI** expose the exact stored scalar rather than its derived label or
normalized locator.

An external `file:` Source is admitted only through a persistent Host-private
grant for the exact canonical regular file selected by the user. The grant does
not admit its directory or siblings. Every read/copy/preview action uses a
verified handle; path-only Open/Reveal actions remain unavailable where they
cannot preserve that boundary.

Electron main stores grants atomically in private JSON under the active
profile's `userData`, using the existing `PRIVATE_JSON_FILE_OPTIONS` boundary.
Each record keeps only the locator, canonical regular-file identity, and minimum
audit facts required for revalidation. No grant ID, canonical path, device/inode,
scope record, or admitted parent root enters Source, renderer state, Outline
protocol, or Agent-visible data. Another Source may reuse a grant only when its
locator again proves the same canonical file; editing to a sibling remains
denied unless that sibling was admitted independently.

The grant is profile authorization, not revision identity or ownership. It does
not grant Agent ambient filesystem access, expand external roots, admit a
directory, weaken dangerous-open checks, or authorize a URI by syntax alone.

Grants survive restart and fail closed when missing, corrupt, revoked, or
mismatched after a symlink retarget. **Choose File** relinks only when the chosen
file proves the denied Source's exact target. **Replace Source** may choose a
different file, persists its grant before document mutation, and removes a newly
orphaned grant if settlement fails. **Forget local-file access** revokes only the
grant, leaves every committed Source unchanged, and degrades its dependents to
denied. Ordinary file replacement at the same non-symlink path remains live only
after each operation opens with no-follow semantics, verifies the opened regular-
file identity against fresh canonical resolution and the grant, and consumes
that same handle.

### Complete desktop baseline

Before this PR merges, the existing preview host consumes the final selected URI
descriptor and the desktop can manage every state public CLI/ChangeSet
operations can create:

- list every built-in URI value in converged order with readable status and reason;
- select/preview, edit, reorder, remove, add, and clear values;
- persist selected value and preview visibility in local workspace view state;
- fall back to the first value when the selection disappears;
- leave an ordinary Node when the final value is removed; and
- keep preview visibility independent from ordinary child disclosure.

The baseline treats document content, selected URI value, preview visibility,
preview-body reader state, and ordinary child disclosure as independent axes.
Selection is keyed by stable owner/value identity, survives reorder, never skips
an explicitly selected unavailable value, and cannot be overwritten by stale
async work from a previous selection.

The baseline is content-first and visually conservative, but complete. The
later `outline-source-preview` plan may rearrange and compact these controls; it
cannot reveal hidden state or repair an operation this PR failed to expose.

### Preview preservation boundary

The Source cut rebinds the current preview foundation; it does not retire it.
`PreviewTarget`, Host resolution, `FilePreviewShell`, the ordered renderer
registry, dedicated reader pane, and scoped transports remain authoritative.
Generate a responsibility queue from the merged preview specs, tests, and
symbols before editing, and reach zero only after equivalent Source-backed
evidence exists for all of these capabilities:

- PDF summary and full-reader modes, page navigation/jumps, resizing, insets,
  scroll geometry, and restored position;
- EPUB and HTML readers, lazy mounting, outlines, translation controls,
  preferences, caches, recovery, keyboard routing, and restored position;
- Markdown, code, plain text, delimited table, directory, image, and metadata
  fallback renderers with their bounded and unsupported states;
- audio/video Media Chrome, playback, seek, volume, mute, shortcuts,
  fullscreen, and same-layer actions;
- per-source summary/full state, height, page/section/media state, and cleanup;
- Open in split pane, managed Open/Reveal, verified-handle Copy, Expand,
  Maximize, Retry, and unavailable actions only where the resolved Source
  authorizes them;
- Runtime-verified materialization and scoped preview streams without exposing a
  ContentStore path to renderer; and
- reduced motion/transparency/contrast, light/dark tokens, focus, selection,
  accessibility, and the existing navigation/security boundaries.

Only special-Node host assumptions retire: read-only filename rows become
ordinary editable content, file-type bullets become normal Node geometry, the
Node chevron controls only children, and Node-scalar preview adapters resolve
from Source plus AssetRecord. A conflict is adapted at the host boundary rather
than treated as permission to remove a mature behavior.

One ordered registry selects the selected descriptor's presentation: supported
providers keep their sandboxed player, ordinary web URLs keep their summary,
images keep bounded aspect-aware display, documents keep summary/full readers,
audio/video keep Media Chrome, and unpreviewable files keep bounded metadata plus
authorized actions. Failure replaces only the selected body with its reason and
recovery; it never keeps stale content, deletes Source, or selects another value.

### Producer and consumer cutover

Cut every existing URL/image/file producer to final ordinary Nodes and the
built-in URI field adapters. Paste, drop, picker, clipboard image, launcher, import, and
loose-preview Add to Outline capture files as managed exact revisions by default.
An explicit Link file action creates a live external Source instead. The later
`outline-source-preview` feature owns the new bare-URL editor paste and context-
menu entry affordances; this protocol PR supplies the atomic operation they use.

Clipboard/drop `File` objects are snapshotted during the event and admitted
independently in source order. An empty target row retains its identity as the
first successful resource; remaining files become ordered siblings. A non-empty
paste inserts siblings after the row, while drop preserves normal before/inside/
after placement. Failed admission creates no dangling Node, successful siblings
remain, and document-settlement failure releases the newly uncommitted managed
relationship through the existing lease/reconciliation boundary.

`/attachment`, `/image`, picker, clipboard image, external drop, loose-preview
Add to Outline, launcher capture, and import all use the same ordinary-Node
constructor and URI field adapter. Their task-oriented names no longer select a
Node variant. **Link file** records the exact-file grant and adds a `file:` URI
without capturing bytes; moving, replacing, denying, or deleting that external
file changes only availability and never causes Tenon to delete it.

`HAS_MEDIA`, `HAS_IMAGE`, `HAS_AUDIO`, and `HAS_VIDEO` aggregate authoritative
managed metadata or deterministic remote classification over every built-in URI value,
independent of local selection. Missing metadata yields unknown/unavailable,
never a guessed type or projection failure. Managed liveness derives from
canonical managed-asset URIs under `field:source` plus existing icon/banner
relationships, never from
retired Node fields. Duplicating or referencing a resource Node adds logical
relationships rather than copying bytes; AssetRecord thumbnail relationships
remain store metadata and are not duplicated onto Nodes.

### Accessible media naming

The former `inline-media-alt-text` task is absorbed here because `mediaAlt` is
deleted with special image Nodes. Editable Node content is the user-authored
accessible name for an image-backed Source. When content is empty, presentation
may fall back to the derived filename/provider label without writing it into the
document. Import/paste producers that already receive deliberate alt text map it
to Node content rather than preserving a second media-only field. Preview and
reference surfaces use the same naming rule.

Every resource reference remains an ordinary Node reference. Authored Node
content is its label when non-empty; an empty label may use the selected/default
Source's derived filename, host, or provider fallback without mutating content.

### Dependencies and collision boundary

This is the next architectural claim. It starts from the #592 Runtime baseline
and the #590 canonical reference URI contract. `outline-source-preview`, the
Host composition chain, Agent resource lifecycle, Outline CLI efficiency, core
mutation-index work, and atomic tagged extraction all consume its final types or
commands and begin only after it merges.

### Verification

The PR proves ordinary field/value encoding, generic and convenience mutation
parity, single-target ChangeSet normalization/lowering, public CLI admission,
two-replica convergence for every operation pair, managed-asset settlement,
complete-owner clone behavior,
exact-file grant restart/revoke/relink/replacement and adversarial path races,
impossible-state degradation, search/query classification, and a desktop round
trip for valid, invalid, unsupported, denied, unavailable, and secondary Source
values. A generated responsibility queue must reach zero for retired special
Node producers and consumers. Namespace-aware guards distinguish retired Outline
variants from retained Agent attachments, model image parts, rich-text syntax,
PreviewTargets, AssetRecords, and ContentStore concepts.

### Acceptance criteria

- A URL or file capture creates an ordinary Node plus built-in URI value; no special
  image/attachment Node survives in protocol, state, projection, or UI logic.
- New Nodes have no URI entry. The first value lazily creates an unlocked normal
  entry; values use ordinary RichText Nodes, and deleting the entry or final
  value removes the field from that owner.
- The visible definition is `URI`; its stable internal ID is `field:source`.
  Users may create an unrelated `Source` field without it gaining preview,
  search, authorization, or asset-liveness semantics.
- URI values accept generic text and tree mutations. Editing a URL stores the
  exact replacement and re-derives preview state without rollback; the entire
  URI entry can be deleted through normal field UI.
- Every public Source state is visible and manageable in the desktop baseline.
- Source convenience updates accept only one owner and owner-local direct value/
  anchor references, while generic field operations remain equally valid.
- Concurrent add/reorder/remove/clear/replace cases converge according to normal
  field-entry and RichText rules, without a Source-specific settlement layer.
- Multi-file capture preserves source order, retains successful siblings, creates
  no Node for failed admission, and releases any uncommitted managed relationship.
- Removing the selected value falls back deterministically; removing the final
  value deletes the empty URI entry and clears only preview-local view state.
- Invalid or unauthorized text stays exact, editable, durable, and locally
  degraded without aborting projection.
- External-file authorization never widens beyond the exact selected file.
- Grant corruption, revocation, relink mismatch, symlink retarget, or path race
  denies only the affected Source and never falls back to path-only Open/Reveal.
- Imported image alt text remains editable through ordinary Node content, and
  renderer accessibility does not depend on the retired `mediaAlt` field.
- The generated mature-preview responsibility queue reaches zero with equivalent
  Source-backed behavior and no renderer-visible file/network authority.
- Fresh-userData verification finds no legacy decoder, alias, dual writer, or
  retired special-node command.

## Open questions

None. Implementation-library choices are local provided they preserve the
protocol, authority, convergence, and clean-cut boundaries above.

## Implementation checklist

- [ ] Regenerate the producer/consumer queue from `rg` and live PR scopes.
- [ ] Land final Core types, commands, codecs, Runtime/CLI schemas, and guards.
- [ ] Cut every producer, consumer, liveness path, query, and preview adapter.
- [ ] Ship the complete content-first desktop management baseline.
- [ ] Fold current behavior into the relevant specs and run the required Core,
      renderer, E2E, docs, convergence, security, and clean-userData checks.
