# Agent Result And Resource Reference Lifecycle

**Shape:** (a) ONE complete feature in one PR after #584 and #587 land. The
Agent resource-reference cutover, conversation workspace and final-citation
contract, and delegated-handoff projection are foundation-first build stages in
that PR. #584 separately establishes the shared captured-revision store as part
of its complete Outliner Runtime feature; #587 remains a complete composer-
history feature over an opaque current resource handle.

## Goal

Give Tenon one clean model for files, generated outputs, attachments, Outline
assets, final Agent citations, and delegated results without assigning a file an
intrinsic category or owner:

- a canonical consumer stores a resource reference, not ownership of a file;
- one reference may resolve through a live location, a captured immutable
  revision, both representations, or neither when unavailable;
- the Host resolves a reference for a particular caller and use intent, rather
  than treating a path or opaque ID as sufficient authority;
- one app-level ContentStore keeps captured revisions, integrity state,
  retention anchors, and physical collection, but does not define logical files
  or product objects;
- an Agent terminal result remains model-authored plain text and identifies
  delivered files through the existing `[[file:label^path]]` markup;
- ordinary root conversations receive isolated Host-managed workspaces without
  requiring the user to choose a `cwd`, and children inherit the same workspace
  binding; and
- a delegated Agent may produce a complete long answer while only the
  projection inserted into its parent's provider context is bounded.

The governing question is not whether a file is mutable, captured, private,
published, or owned. It is: given a canonical reference, caller, and use intent,
can the Host resolve an authorized representation with honest version and
availability semantics?

## Non-goals

- No global logical `Resource` object, universal file identity, application-wide
  product-object namespace, or assertion that a path and a captured revision are
  the same continuing file.
- No mutable-versus-durable file taxonomy and no promotion pipeline. A live
  location and a captured revision are independent representations that may
  coexist and change independently.
- No Agent/Outline ownership of physical bytes, ownership transfer, or publish
  move. Canonical records reference representations; sharing adds another
  reference and retention anchor without moving bytes.
- No `AgentResult`, JSON result schema, required artifact manifest, dedicated
  artifact-creation tool, generic managed output directory, or filesystem-diff
  discovery of important files.
- No automatic conversion of a long answer into a file and no output-length
  threshold that changes an Agent result. Read-only Agents may complete with
  text alone.
- No raw digest, retention-anchor ID, canonical blob path, or Host-private
  resource-reference ID as renderer, CLI, model, ChangeSet, or file-tool
  authority.
- No automatic recursive directory capture. A directory reference remains a
  verified live navigation reference; durable directory delivery requires an
  explicitly created archive or index file.
- No requirement that every live location be captured. Capture is required only
  where the use contract needs stable replay, handoff, or delivery and remains
  subject to explicit admission limits.
- No migration, legacy reader, dual write, format conversion, or automatic
  startup deletion. Before cutover verification, stop Tenon and manually reset
  installed and clone-scoped userData.
- No migration of transaction state, Agent databases, rollout logs, internal
  text/context/diagnostic payloads, transcripts, preferences, secrets, caches,
  installed Skills or Browser Pilot runtime, import sources, export destinations,
  worktrees, or build files into ContentStore merely because they are files.

## Design

### Requirements

- **FR-1:** Represent every durable file relationship as a canonical resource
  reference whose Host-private record may contain a scoped live location, a
  captured-revision handle, both, or neither. Resolution reports unavailable
  states explicitly rather than inventing a representation.
- **FR-2:** Resolve a reference using the requesting principal, Thread/runtime
  scope, requested action, and version intent. A reference ID or path alone
  grants no access.
- **FR-3:** Store each captured byte revision once per digest in the neutral
  multi-process ContentStore. Retention anchors express only that a committed
  reference still requires the revision; they do not express ownership.
- **FR-4:** Preserve live locations as scoped locators. Revalidate root
  admission, canonical path, symlinks, opened-file identity, and action
  permission at each use.
- **FR-5:** Derive final-citation requests only from unescaped
  `[[file:...]]` occurrences in terminal assistant text. Persist Host binding
  metadata without rewriting the model-authored text.
- **FR-6:** Capture exact revisions when stable replay is required: Outline
  attachments, submitted Composer bytes without a durable source, submitted
  local attachments, canonical generated/web/Browser Pilot/Skill/tool file
  results, final regular-file delivery, and cross-domain reference creation.
- **FR-7:** Give each ordinary root conversation an isolated managed workspace;
  let children inherit it; and treat worktrees as execution overlays rather than
  file identities or retention authorities.
- **FR-8:** Retain complete child answers in child Threads and transcripts while
  budgeting only parent-context text, accessible reference projections, and
  fallback coverage.
- **FR-9:** Classify every current and future file producer/consumer by its
  reference, resolution, capture, materialization, or explicit import/export
  behavior. No tool name, directory name, file size, or origin implies a class.
- **NFR-1:** Admission fails closed before a corrupt revision or anchor enters
  ContentStore. Resolution, capture, projection, and maintenance faults degrade
  to typed availability states without rewriting an Agent result or killing an
  otherwise useful Turn.
- **NFR-2:** Concurrent Electron-main and Outliner-Runtime capture, anchor,
  release, reconciliation, and GC cannot delete a revision required by a
  committed or in-flight canonical reference.

### Decisions And Constraints

- **DEC-1:** The terminal result contract is plain text plus optional citations
  in that text. Host binding and coverage metadata are derived access state, not
  a second result.
- **DEC-2:** A file has no intrinsic mutable/captured class and no unique owner.
  Live and captured representations may coexist; canonical records merely
  reference what they can later resolve.
- **DEC-3:** A final citation to a regular file attempts a bounded exact capture
  while retaining an authorized live locator when one remains useful. Opening
  the delivered result prefers the captured revision; revealing or editing the
  source requires the live locator. A live-only result is reported as live, not
  misrepresented as stable.
- **DEC-4:** ContentStore anchors are mechanical retention facts. Their namespace
  and record key exist only for settlement and reconciliation; they carry no
  product identity, permission, or ownership meaning.
- **DEC-5:** The PM ratified a pre-release clean cut on 2026-08-26. Existing
  `~/Library/Application Support/Tenon/` and clone-scoped
  `~/.lin-outliner-*` data may be manually cleared after all Tenon processes
  stop. The product carries no compatibility or automatic deletion code.
- **CON-1:** Outliner Runtime and Electron main are separate processes that may
  access ContentStore concurrently.
- **CON-2:** Agent canonical Items and Outliner Runtime transactions remain in
  their domain stores, so no cross-database atomic transaction is available.
- **CON-3:** Ordinary renderer-created conversations do not ask the user for a
  working directory. Explicit project/automation bindings remain supported.
- **CON-4:** Read-only delegated roles must complete without filesystem writes.
- **CON-5:** #584 is the first production consumer of the captured-revision
  kernel; #587 must not wait for the later Agent reference cutover.

The accepted cross-store tradeoff is conservative retention after interruption,
repaired later, rather than any deletion race that loses a revision required by
a committed reference.

### 1. Reference And Representation Model

There is deliberately no global logical file object. Each product domain keeps
its own canonical record and references only the representations it needs:

```text
Outline AssetRecord --------------------------+
                                               |
Agent ResourceReferenceRecord ----------------+--> resolve(caller, intent)
  ^         ^               ^                 |      |- live location
  |         |               |                 |      |- captured revision
Item link  tool link  final-citation binding  |      |- materialization
                                               |      `- unavailable
                                               |
Captured representation ----------------------+--> retention anchor -> ContentStore
Live representation --------------------------+--> scoped filesystem location
```

An Outline AssetRecord is Outline's canonical reference. An Agent
`ResourceReferenceRecord` is a Host-private Agent reference carrying display
metadata and zero or one representation of each kind:

```ts
interface LiveLocation {
  readonly scopeId: string;
  readonly relativePath: string;
  readonly expectedKind: 'file' | 'directory';
}

interface CapturedRevisionReference {
  readonly anchorId: string;
  readonly byteLength: number;
}

interface ResourceReferenceRecord {
  readonly referenceId: string;
  readonly displayName: string;
  readonly mediaType: string | null;
  readonly live: LiveLocation | null;
  readonly captured: CapturedRevisionReference | null;
}
```

These shapes state the minimum semantic boundary, not public DTO authority.
`referenceId`, `scopeId`, and `anchorId` are Host-private and individually grant
nothing. Canonical Agent Items, settled drafts, tool records, final citations,
forks, and handoffs link to a reference record. Those links are reachability
facts, not ownership edges.

The ContentStore under `src/content/` knows only physical revision facts:

- digest, byte length, staged/published/deleting/quarantined state;
- admission lease identity and expiry;
- retention-anchor identity, reconciliation namespace, and opaque record key;
- publication/deletion journal state; and
- physical integrity results.

It does not know Thread, Item, Node, asset, attachment, result, workspace,
filename, MIME presentation, or who owns content. A digest is an implementation
deduplication key, never logical identity or authority.

### 2. Resolution Semantics

All use goes through a Host resolver with three inputs:

```text
resolve(reference, access context, use intent)
```

The access context identifies the principal, Thread/root subtree, admitted
filesystem scopes, and any exact handoff grant. The intent selects the version
and action semantics:

| Intent | Preferred representation | Required behavior |
| --- | --- | --- |
| Open delivered result or replay canonical attachment | captured | Return the exact referenced revision; never silently substitute newer live bytes |
| Read current source | live, then explicitly reported captured fallback if allowed | Revalidate the live locator; report which representation was returned |
| Edit or reveal source | live only | Require current scope and file identity; a captured revision is not an editable source |
| Provider/model observation of canonical content | captured, materialized exactly when a path is required | Materialization is scoped scratch and carries no new canonical reference |
| Provider/model observation of current workspace work | live | Require active execution scope; do not imply stable replay |
| Add another durable domain reference | captured | Reuse a captured revision or capture the live file first |
| Navigate a directory | live only | Revalidate the directory; never recursively capture |

Resolution returns representation kind and availability explicitly. The common
states are `captured`, `live`, `capturedFallback`, `pending`, `unavailable`, and
`denied`; callers must not collapse them into a bare path.

A live locator is relative to a Host-admitted scope, never a raw ambient path.
Every use rechecks canonical containment, symlinks, opened identity, expected
file kind, and action permission. A replaced file may still be a valid current
source, but it is not the file captured for an earlier final citation.

### 3. Capture, Anchors, Reconciliation, And GC

#### FLOW-1: Capture An Exact Revision

1. The calling domain mints its future canonical record/reference ID and opens
   a bounded admission lease in `{userData}/content/state.sqlite`.
2. ContentStore streams bytes into `staging/`, computing digest and length. For
   live files, the Host opens the file and records identity before reading.
3. After the read, the Host verifies the opened identity and relevant metadata
   did not change. A changed-during-read source is retried within the bounded
   operation or remains live-only/unavailable; mixed bytes are never published.
4. Under the domain's mutation/reconciliation barrier, ContentStore fsyncs and
   publishes or verifies the revision, then creates a retention anchor for the
   future record while consuming the admission lease.
5. While still holding that barrier, the domain commits the canonical reference
   containing the returned captured-revision handle.
6. If domain commit fails, it requests anchor release. A crash may leak the
   anchor but cannot expose an incomplete record or lose a committed revision.

Bytes without a durable live locator, including clipboard images, browser
`File`s, generated large-paste files, and canonical generated media, enter this
flow at admission. Existing captured content creates another reference through
`cloneAnchor(sourceAnchor, targetRecord)`; callers never submit a digest.

#### FLOW-2: Add Or Remove A Canonical Reference

Adding an Outline reference to an Agent-cited revision, or an Agent reference to
an Outline revision, does not publish, transfer, move, or copy a file:

1. authorize and resolve the source captured representation;
2. clone a retention anchor for the future target record under the target
   domain barrier; and
3. commit the target domain reference.

If the source has only a live location, capture it first. Removing a canonical
link may make its Agent reference record unreachable. The domain then deletes
that record and releases its anchor after the domain commit. Live locations are
not deleted by reference release.

#### FLOW-3: Reconcile Retention Anchors

Each anchor namespace owns a mutation/reconciliation barrier. Reconciliation
enumerates verified `(recordKey, anchorId)` pairs from that namespace and
releases only anchors absent from a complete successful snapshot. If the domain
store is unavailable, corrupt, or cannot finish enumeration, it releases
nothing. Namespace coordinates support repair; they do not establish ownership.

#### FLOW-4: Collect Captured Revisions

In one SQLite transaction, ContentStore selects revisions with no active
admission lease and no retention anchor and marks them `deleting`. New capture
or anchor cloning cannot attach to that state. GC unlinks the bytes and settles
the deletion journal; startup finishes or rolls back interrupted states.

Both processes use the same WAL/busy-retry and per-digest publication protocol.
Atomic filesystem rename alone is not the concurrency protocol.

#### FLOW-5: Detect Corruption And Unavailability

- A digest/length mismatch quarantines that captured revision and makes every
  reference to it unavailable consistently.
- Invalid domain metadata degrades only that canonical reference and never
  moves valid shared bytes.
- A missing live source does not corrupt a captured revision.
- A missing captured revision may still leave an explicitly live reference,
  but delivered-version resolution remains unavailable rather than silently
  returning newer bytes.
- Resolver or materialization failure records a typed state and does not rewrite
  the original Agent text or fail an otherwise useful Turn.

### 4. Physical Layout And Container Lifecycles

The clean target layout is:

```text
{userData}/content/
  state.sqlite                     revisions, leases, anchors, journals
  blobs/{sha256}.blob              immutable captured bytes, deduplicated
  staging/                         incomplete capture, never canonical
  quarantine/                      failed-integrity captured bytes

{userData}/agent/
  state.sqlite
  thread_history.sqlite
  goals.sqlite
  memories.sqlite
  automations.sqlite
  rollouts/{thread-id}.jsonl
  payloads/{thread-id}/            internal text/context/diagnostics only
  resource_references.sqlite       Agent references, links, final bindings
  workspaces/{root-thread-id}/     live files for one root conversation subtree
  worktrees/subagents/             Host-managed execution overlays
  worktrees/automations/           automation execution overlays
  automation-snapshots/            internal patch/recovery records
  scratch/                         reproducible/ephemeral materializations
  transcripts/{thread-id}.md       rebuildable Host projections
```

Outliner Runtime keeps document transactions, recovery bytes, snapshots,
AssetRecords, asset staging references, and reachability under its Runtime root.
AssetRecords retain captured revisions through anchors in `{userData}/content/`;
Runtime owns no second physical blob root. Both roots come from the shared
userData resolver, never `cwd` or `dirname(runtimeRoot)`.

Container lifecycle remains separate from per-file reference semantics:

- a managed workspace directory follows the complete root conversation subtree;
- a worktree follows its execution/worktree controller;
- an external scope remains user-controlled and Tenon never deletes it;
- scratch materializations follow Turn/operation TTL;
- transcripts are rebuilt from canonical Turns; and
- captured revisions follow leases and retention anchors only.

Deleting a managed workspace removes its live files. Any reference with a
captured revision remains resolvable for delivered-version use; a live-only
reference becomes unavailable. The Host therefore finalizes pending captures
before workspace/worktree cleanup, but it does not scan uncited files or decide
which files are important.

The current `agent-workdir`, `agent-scratch`, `thread-transcripts`, per-Thread
binary-resource directories, `agent/subagent-worktrees`,
`agent/automation-worktrees`, and `agent/automation-worktree-snapshots` roots are
removed after the manual clean cut. Worktrees and automation snapshots remain
ordinary container/internal files, not ContentStore revisions unless a specific
canonical use captures a regular file.

### 5. Scenario Contract

Every known producer and consumer follows the same reference rules:

| Scenario | Initial representation | Canonical transition | Later resolution and cleanup |
| --- | --- | --- | --- |
| `file_write`, `file_edit`, shell/Skill file in execution directory | live | none until submitted, retained by a canonical tool result, or finally cited | current-work intent reads live; container cleanup removes it |
| Composer picker/drop/local mention | live while selecting when available | successful submission captures exact bytes and links the Item | replay/model use resolves captured; source reveal uses live if retained |
| Clipboard image, browser `File`, large paste | transient bytes | capture during bounded admission | draft/Item links retain revision; discard releases its link |
| Outline attachment/imported media | live or incoming bytes | capture before AssetRecord settlement | Outline replay resolves captured; source locator is optional metadata |
| Remote URL | external link or fetch input, not a filesystem live location | capture and create a resource reference only when the product action requires stable/offline bytes | ordinary link opening follows URL policy; replayable bytes resolve through the captured revision |
| Generated image, retained web binary/image | scratch/transient bytes | canonical tool result captures and links | observation materializes from captured revision |
| Browser Pilot screenshot/download | scratch or execution output | capture only when retained by canonical tool result or final citation | uncaptured output follows scratch/operation cleanup |
| Declared Skill file output | execution-directory live file | bounded declared-output capture when the tool result retains it | output root is never recursively promoted |
| Shell stdout/stderr or large textual tool output | internal text | persist in internal payload store, not as a file reference | follows canonical Item dependency graph |
| PDF page/image/provider materialization | derived scratch | no canonical capture unless separately cited/retained | exact scoped path expires with materialization |
| Final regular-file citation | live, captured, or existing reference | reuse existing reference or attempt exact capture; retain authorized live locator | Open Delivered prefers captured; Reveal/Edit Source requires live |
| Final directory citation | live directory | bind live only | revalidate on navigation; never recursively capture |
| Agent-to-Outline or Outline-to-Agent use | captured source reference | clone target retention anchor and commit target reference | source and target links are independent; bytes stay deduplicated |
| Fork, Retry, composer history | existing reference IDs | copy/preserve canonical links, never bytes | release affects only removed links |
| Import source | user-owned live path | only imported domain content is captured | Tenon never deletes source |
| Export/diagnostics destination | user-selected live path | write explicitly; no automatic capture | user controls destination; later citation may create a reference |
| Read-only delegated Agent | no file required | text-only completion is valid | no write or capture prerequisite |

A static/test guard derives the inventory from registered capabilities and
canonical root constructors. It fails on an unclassified producer/consumer,
ambient raw-path bypass, recursive directory capture, or runtime artifact
registry. This is a verification mechanism, not a new product object registry.

#### Build Stage 1: Agent Resource-Reference Cutover

After #584 and #587 land, reuse `src/content/` as the captured-revision store.
Add the Agent resource-reference store and resolver; replace binary-resource
methods in `ToolPayloadStore`, `ThreadResourceOps`, and `ToolArtifactSink`; and
cut over Composer admissions, large paste, durable Outline references,
generated images, retained web/Browser Pilot/Skill/tool files, and provider
materialization.

Canonical Items, settled drafts, tool results, history, fork, Retry, rollback,
deletion, and quota retain reference links rather than physical copies. Remove
digest-bearing public/renderer handles and all per-Thread binary directories.
Keep internal text/context/diagnostic payloads, mutable execution files,
installed tools, caches, and transient materializations outside ContentStore.

### 6. Conversation Workspace And Final Citations

A normal root Thread receives `agent/workspaces/{root-thread-id}`. An explicit
project or automation root may instead bind an admitted external directory. A
child inherits the root binding; a retained worktree overlays execution without
changing reference identity.

The Host derives an `AgentFilesystemScope` for each execution from the active
workspace/external binding, active worktree, exact materializations, and exact
directed grants such as a child transcript. Ordinary conversations never
receive blanket absolute-host authority. Shell Items still record factual `cwd`
for audit, but `cwd` is not identity, retention, or authorization.

The Agent decides whether a deliverable is worth citing by ordinary judgment:
cite it when the user will keep, open, edit, or re-reference it; otherwise answer
in text. Length alone is irrelevant. No result schema or validator decides.

#### FLOW-6: Bind A Final Citation

When terminal assistant text is sealed:

1. persist the model-authored text unchanged;
2. parse unescaped file markers and create pending rows keyed by immutable
   `{threadId, itemId, markerOrdinal}`;
3. authorize and resolve each marker against the Thread's current filesystem
   scope or an existing exact Agent reference;
4. for a regular live file, perform bounded identity-safe capture while retaining
   the authorized live locator; for an existing captured reference, link it; for
   a directory, bind live only;
5. commit `captured`, `live`, `capturedAndLive`, `unavailable`, or `denied`
   binding state without changing the text or Turn outcome; and
6. delay workspace/worktree cleanup only through the bounded binding-finalization
   barrier.

A crash-interrupted pending citation becomes unavailable at startup unless a
completed reference and anchor prove the exact capture. Startup never captures
later bytes and presents them as the originally delivered revision.

The marker parser remains Markdown-independent and supports the literal escape
`\[[file:...]]`. Renderer Preview/Open resolves the Host binding and defaults to
captured delivery. Reveal/Edit Source resolves the live locator. UI presentation
must distinguish stable, live-only, unavailable, and denied states; it never
trusts the marker path.

Uncited workspace files are not scanned, captured, attached, or retained as
hidden artifacts. Root deletion drains active descendants and pending captures,
then removes the workspace container. Surviving captured references remain;
external files remain untouched.

#### Build Stage 2: Workspace And Citation Cutover

Replace the global default workdir with root-conversation bindings; consolidate
worktree, scratch, and transcript roots; add final-citation links and resolution
joins; and route Preview/Open/Reveal/Edit through intent-aware resolver calls.
Update local tools, scopes, Skill and Browser Pilot execution, subagent/worktree
resolution, fork/rollback/deletion, transcript access, codecs, renderer states,
and current specs in the same PR.

### 7. Context-Aware Delegated Handoff

Do not impose a Tenon-specific cap on a child's stored answer. Provider/model
limits still apply naturally. The complete terminal text and reference bindings
remain in the child Thread and rebuildable transcript.

Generalize fair-share/head-tail settlement into one
`SubagentHandoffProjector` for foreground `agent` results, background
notifications, explicit-generation carry-forward, and settlement continuations.
It receives remaining provider capacity after canonical parent history, stable
prompt, tools, mandatory framing, output reserve, and a small control frame.

The projector operates over terminal text plus child-accessible reference
bindings:

- include complete text and references when they fit;
- otherwise allocate capacity fairly and emit marked excerpts/omissions with
  source generation and durable coverage metadata;
- project only references the parent is authorized to resolve;
- create a parent-accessible reference to the same captured revision without
  exposing paths, anchors, or child-private IDs;
- grant a live locator only when the parent's inherited scope independently
  authorizes it;
- count omitted, live-only, unavailable, and denied citations inside the same
  budget; and
- add one bounded exact child-transcript resolver when text or reference
  coverage is incomplete.

The transcript fallback is an exact Host-derived reference, not a globally
known output path and not a captured user-content blob. It grants the parent
read/grep access to that child transcript only.

Foreground `agent` calls reserve a minimum settlement frame before spawning.
Background/carry-forward delivery remains pending until that frame fits. If
ordinary compaction still cannot fit an admitted foreground settlement, the Host
records typed incomplete coverage and the transcript fallback without another
failing provider retry. Projection faults are data states, never thrown runtime
invariants.

Token usage, duration, tool counts, anchor IDs, internal reference IDs, and
constant transcript paths remain in diagnostics unless a specific UI requires
them. `agent_message("main")` remains for progress, blockers, questions, and
urgent findings; terminal output is delivered by the runtime and is not
duplicated through that tool.

#### Build Stage 3: Delegated-Handoff Cutover

Replace delivery-specific renderers with the shared projector, add authorized
parent reference projection, remove constant usage/output-path noise from model
input, correct `agent_message` guidance, and update delegated-result specs and
fixtures. Verify full/excerpted/omitted text, mixed reference states, more
citations than capacity, read-only children, shared and unshared live scopes,
transcript fallback, foreground reservation, pending background delivery, and
exhausted-settlement degradation.

### 8. Sequencing And Verification

The dependency order is fixed:

1. merge this architecture plan;
2. #584 rebases and implements neutral captured revisions plus Outline
   AssetRecord references and retention anchors;
3. after #584 merges, #587 rebases and finishes Composer history over the
   current opaque resource handle without inventing the later store; and
4. after both are on `main`, implement this plan's three internal stages in one
   complete PR.

#584 must not implement Agent resource records, final citations, or handoff.
#587 must not create a new physical store, inspect its digest-shaped handle, or
add physical copies for history navigation.

Verification includes:

- two-process capture/anchor/GC races and crash injection at every
  anchor/domain-record boundary;
- changed-during-read, symlink replacement, missing, oversized, denied, live-
  only, captured-only, captured-and-live, and corrupt-revision resolution;
- exact delivered-version replay after live source changes or disappears;
- current-source edit/reveal without substituting a captured path;
- reference sharing across Agent/Outline without byte copies or transfer;
- independent fork/Retry/history/deletion links;
- root workspace isolation, child inheritance, worktree overlay, external scope,
  directory navigation, and safe container cleanup;
- every scenario-table producer/consumer and an empty unclassified-surface
  guard;
- bounded child text/reference projection and exact transcript fallback;
- a fresh installed and development userData tree matching the target layout;
  and
- source/dependency guards proving no legacy layout, `AgentPrivateContentStore`,
  physical ownership claim, public digest/anchor, migration reader, automatic
  deletion path, or runtime artifact registry remains.

The implementation updates current `docs/spec/` authority in the same change and
runs `bun run typecheck`, relevant Core/renderer/E2E suites,
`bun run docs:check`, and `git diff --check`.

## Open questions

None. The plain-text result contract, reference/representation model,
intent-aware resolution, exact-capture default for final regular files,
directory live-only behavior, container cleanup, clean data reset, and bounded
delegated handoff are fixed for implementation.

Concrete byte/count ceilings, capture retry count, maintenance cadence, and
quota charging are reversible policy values. Preserve today's stricter limits
and record exact values in current specs; changing them requires a separate
decision.

## Acceptance Criteria

- **AC-1:** Agent terminal results remain byte-for-byte model-authored plain
  text. Only unescaped explicit file markers request Host bindings, and binding
  faults never rewrite that text or fail an otherwise useful Turn.
- **AC-2:** No product API or record classifies a file as intrinsically mutable,
  captured, Agent-owned, or Outline-owned. A canonical reference may expose
  live, captured, both, or unavailable representations independently.
- **AC-3:** Every use resolves through caller context and intent. Raw paths,
  digests, anchor IDs, blob paths, and Host-private reference IDs are
  insufficient public/model/renderer/CLI authority.
- **AC-4:** Concurrent capture, anchor settlement, release, reconciliation, and
  GC cannot delete a revision required by a committed or in-flight reference;
  interruptions may leak anchors and later reconciliation repairs them.
- **AC-5:** Captured corruption affects all references to that revision
  consistently; invalid domain metadata affects only its reference; missing live
  sources never corrupt captured bytes.
- **AC-6:** Agent-to-Outline and Outline-to-Agent use adds a target reference and
  retention anchor over the same revision without copying, moving, publishing,
  or deleting the source relationship.
- **AC-7:** Two root conversations have isolated live filesystem scopes; a child
  inherits its root scope; a worktree is an execution overlay; and no ordinary
  renderer Thread supplies `cwd` or receives ambient host access.
- **AC-8:** Final regular-file citations distinguish captured, live,
  captured-and-live, pending, unavailable, and denied states. Open Delivered
  never substitutes later live bytes; Reveal/Edit Source never substitutes a
  captured materialization. Directories remain live-only.
- **AC-9:** Fork, Retry, rollback, history, message/Thread/root deletion, and
  reference sharing change only canonical links and retention anchors; they
  never copy bytes, delete external files, or invalidate another surviving link.
- **AC-10:** Oversized delegated answers remain complete in child Threads.
  Parent projection fairly budgets text and authorized references, records
  coverage, and provides an exact scoped transcript fallback when incomplete.
- **AC-11:** Read-only Agents complete with text alone, and
  `agent_message("main")` is neither required nor used to duplicate terminal
  delivery.
- **AC-12:** After the documented stopped-process manual reset, first packaged
  and development launches create only the target ContentStore, Agent reference,
  workspace/worktree/scratch/transcript, and Runtime layouts. No legacy binary
  directory, migration reader, or automatic startup deletion remains.
- **AC-13:** Every registered file producer/consumer and canonical filesystem
  root appears in the scenario contract. The disk-derived guard reports no
  unclassified surface, ambient-path bypass, recursive directory capture,
  filesystem-diff artifact discovery, or runtime resource registry.
- **AC-14:** Composer inputs, retained tool outputs, final citations, and
  cross-domain references capture only when their use contract requires a
  stable revision. Uncited work, textual payloads, temporary materializations,
  live directories, and external sources are not captured merely because they
  exist, are large, or were Agent-created.
- **AC-15:** Document/runtime state, Agent databases and rollouts, internal
  payloads, transcripts, preferences, secrets, caches, diagnostics, Chromium
  partitions, installed Skills/Browser Pilot, import/export paths, worktrees,
  automation snapshots, and build files retain independent roots and cleanup
  rules; none becomes a captured revision without an explicit canonical use.

## Implementation Checklist

- [ ] Implement the neutral captured-revision/retention-anchor kernel in #584
  and align Outline AssetRecords without public physical authority.
- [ ] Rebase #587 after #584 and preserve current Agent handles opaquely with no
  navigation-time byte copy or later-store implementation.
- [ ] Add Agent resource-reference records, canonical links, resolver intents,
  exact capture, materialization, reconciliation, and focused crash/concurrency
  tests; delete per-Thread binary storage and digest-bearing public handles.
- [ ] Replace the global workdir with root scopes, consolidate physical roots,
  implement final-citation states and intent-aware Preview/Open/Reveal/Edit, and
  verify every scenario and cleanup boundary.
- [ ] Implement the shared delegated-handoff projector with authorized reference
  grants, bounded coverage, and exact transcript fallback.
- [ ] Fold shipped behavior into current specs, run the file-surface and legacy
  retirement guards, manually reset stopped-process test stores, verify fresh
  packaged/dev layouts, and run all plan-required checks.
