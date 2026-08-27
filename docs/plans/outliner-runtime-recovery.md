# Outliner Runtime Recovery

## Goal

Recover the mature desktop editing, field, projection, search, import, and
persistence behavior that existed at `8a1d5855`, while retaining the standalone
Runtime, public CLI, transactional Operation log, ContentStore, Agent/Skill
integration, and canonical reference URI work that shipped afterward.

The recovery uses `8a1d5855` as a behavior and source baseline, not as a branch
that permanently diverges from `main`. The implementation branch starts from
current `main`, restores the pre-cutover responsibilities deliberately, and
rebuilds later capabilities on top. The resulting diff must make every
retirement, replacement, and retained capability explicit.

This plan has shape **(a): ONE complete recovery in one PR**. Internal build
checkpoints are not independently mergeable. The PR is complete only when the
desktop experience, Runtime/CLI contracts, persistence, security boundaries,
Agent integrations, ContentStore, and reference URI behavior pass together.

## Non-goals

- No direct reset, force-push, or history rewrite of `main`.
- No mechanical cherry-pick of `90991b7f`, `3a4f49a2`, or later compensating
  commits whose implementation assumes the cutover architecture.
- No second writable document authority, renderer-owned document, dual write,
  compatibility reader, or migration path.
- No performance experiment or speculative cache. Historical mechanisms are
  restored first; existing probes verify that the recovered path stays
  O(changed) and does not wait on persistence I/O.
- No silent revival of explicitly retired Agent-specific scopes, legacy native
  Node tools, the old import-pack writer, or Document Beliefs. Each retirement
  remains explicit and covered unless a separate PM decision restores it.
- No implementation of the post-#584 Host composition plan in parallel. Its
  dependency and shutdown graph must be regenerated from the recovered system.

## Design

### Recovery baseline and evidence

`8a1d5855` is the last pre-cutover commit. It already contains the first ten
#584 commits: public contract, exact Core transaction patches, transactional
storage, standalone process, CLI shell and command surface, ChangeSet execution,
transactional assets, and the initial desktop transport. The next commit,
`90991b7f`, replaces the desktop document stack across 187 files, deleting the
incremental read model, accepted/durable saver, command settlement path, and
cooperative import wiring.

The recovery treats these pre-cutover behaviors as invariants:

| Responsibility | Required recovered behavior |
| --- | --- |
| Text editing | Patch-first typing is O(changed), keeps stable draft identity and IME handoff, and never forks or projects the whole document per keystroke. |
| Structural Enter | A middle split atomically replaces the source prefix, creates the suffix Node, removes the stale suffix from the source DOM, and focuses the new Node without a duplicate draft. |
| Fields | Create, convert, reuse, rename, value materialization, append, commit, and Enter share the `update_field_slot` settlement model and preserve virtual slot identity. |
| Projection | Core deltas are projected once, folded incrementally, and delivered as one contiguous revision chain; a reply and its event cannot produce two logical applies. |
| Read/search | A long-lived read model, sparse Node projection, and incremental text index serve launcher, Agent, saved-search, and main-process reads without whole-projection rebuilds. |
| Persistence | Ordinary desktop edits return at accepted, save off the input path, track accepted and durable frontiers, surface failures, and drain through a linearizable quit barrier. |
| Import | Large tree creation and search-index refresh yield cooperatively while remaining one undoable atomic intent. |
| Security | Renderer IPC exposes a bounded desktop capability set. Renderer callers cannot path-ingest or export arbitrary local files through the generic Runtime command surface. |

### One Runtime authority with two settlement contracts

The standalone Runtime remains the only writable owner of one live `Core`.
Electron main, renderer, CLI, Agents, Skills, and import helpers never open the
workspace store directly.

The pre-cutover `DocumentService`, `DocumentReadModel`, `WorkspaceSaver`, and
`DocumentSystem` mechanisms are extracted into Electron-free Runtime services
instead of being restored as a second main-process authority. The service owns:

- one serialized mutation admission gate and one live Core;
- command execution and trusted document transactions;
- text-edit undo grouping and eager draft materialization;
- one incremental projection/read/search generation;
- accepted and durable persistence frontiers; and
- mutation freeze, drain, recovery, and close.

Public CLI mutations keep the shipped durable contract: success is returned
only after the transaction record, Operation, recovery patch, idempotency result,
asset delta, and public Event are durable.

Desktop transport is a private two-stage contract. `accepted` is returned after
the Core mutation, focus result, and exact projection delta are committed in
memory; `durable` follows from the Runtime persistence frontier. Ordinary typing
and structural editing never await fsync, snapshot compaction, or another
process round trip before applying the accepted delta. Persistence failure
freezes further mutation admission, remains visible, and is retried or resolved
before clean quit; it is never reported as durable success. Trusted cross-store
transactions and explicit CLI calls continue to await durable settlement.

The Runtime transaction log adopts the old saver's scheduling guarantees:
incremental capture runs outside the mutation queue, sustained typing has a
maximum dirty-age checkpoint, compaction stays off the foreground path, and a
durable waiter can force progress. Operation identity and recovery data are
assigned at acceptance and become externally successful only at durability.

### Desktop command and projection path

The desktop bridge is a typed capability adapter over Runtime service methods,
not a renderer-accessible generic CLI router. Ordinary editor commands execute
directly against the live Core. Forking is reserved for explicit preview,
reviewed Diff, exact-revert validation, and deterministic planning; direct apply
must not serialize, parse, and rebuild the document.

The service builds one `ProjectionUpdate` from the Core transaction delta and
updates the read model and text index from that same change set. The initiating
desktop request receives the accepted update and focus. Other windows receive
the same revision through the desktop event stream. Revision state advances only
when the update is folded; held or buffered events never advance the mutation
base ahead of renderer projection state.

Focused editors distinguish a causal accepted replacement from unrelated
presentation refresh. A split or external semantic replacement must update the
focused ProseMirror document from the accepted content revision, while a target
rename or color change updates inline-reference presentation without replacing
local semantic edits. #590's canonical `[[node://...]]` / `[[file:///...]]`
codec and dynamic display-name behavior are replayed explicitly on this model.

Every field entry path lowers through the same field-slot command service. A
field-name Enter that also creates a sibling is one admitted desktop intent with
one ordered accepted update and focus outcome, not two independently settled
Runtime calls. Diff/apply remains available for explicitly reviewed or
destructive field operations, not as an accidental difference between create,
rename, append, and value editing.

### Read models, import, lifecycle, and security

The Runtime keeps a long-lived `DocumentReadModel` and incremental text-search
index. `projectionNodesByIds` delegates to Core sparse projection, launcher and
action reads reuse the read model, and search updates preserve both the previous
and next generations where Trash and dependency closure require them.

Cooperative Core APIs are wired through Runtime ChangeSet execution and import
porcelain. Large tree creation, search refresh, and source normalization keep
one transaction and rollback frontier while yielding on bounded work units.

Quit freezes mutation admission at the Runtime, records the latest accepted
frontier across desktop, CLI, Agent, automation, and import callers, drains that
frontier to durable, and only then permits Electron teardown. Closing the desktop
watch or client cannot abort an admitted mutation before the barrier settles.

Desktop IPC uses an explicit allowlist. Buffer upload, picker-mediated ingest,
asset lookup/open/reveal, and scoped preview stay available. Path ingest/export
is admitted only at CLI, trusted Agent workspace, or Host-owned picker
boundaries; a compromised renderer cannot turn a generic Runtime request into
an arbitrary filesystem read.

### Later capability reconstruction

The shipped Runtime/CLI capability remains authoritative at the domain level:
Selector, Projection, ChangeSet, Diff, Operation, Event, exact revert,
idempotency recovery, porcelain commands, schema/help/completion generation,
standalone discovery and replacement, Agent causation, Outline and import
Skills, neutral ContentStore, asset retention anchors, and canonical reference
URIs.

These capabilities are reattached to the recovered service instead of bringing
back the cutover adapters. The following retirements remain deliberate:

- six native `node_*` Agent tools and their private outline parser;
- Import Pack mutation APIs and the `tenon-import` writer;
- Agent-specific Node scopes and reduced projection schemas;
- Document Beliefs and drift notices; and
- Memory mutation authorization as a second Outliner permission model.

Each retired path needs a guard or replacement-coverage test proving that its
supported user workflow exists through the CLI/Skill/Runtime contract. A deleted
test suite is not evidence that the responsibility became unnecessary.

### Complete #584 commit disposition

| Pre-rebase commit | Rebased commit | Recovery disposition |
| --- | --- | --- |
| `c4db77e9` | `1a400ec6` | Claim metadata only; replace with the recovery claim. |
| `0dfa1ee8` | `ef709ecf` | Keep and reconcile the public contract with accepted desktop settlement. |
| `799fca6d` | `0966aaea` | Keep exact Core transaction patches. |
| `0ee94bbe` | `df0149d7` | Keep transactional storage; rebuild foreground scheduling and frontiers around it. |
| `0478242c` | `3abcfabc` | Keep the standalone Runtime process. |
| `9e7bd3a1` | `d60d04e0` | Keep the CLI protocol shell. |
| `f6b5e154` | `3f3fc145` | Keep atomic ChangeSets; restrict Core forks to planning and reviewed paths. |
| `b117abef` | `9686a29e` | Keep the complete CLI command surface. |
| `10f010a6` | `eab28256` | Keep transactional asset semantics and reconcile them with ContentStore. |
| `8a1d5855` | `2722c62c` | Use the original as the desktop transport baseline; rebuild the adapter with a narrow capability map. |
| `90991b7f` | `3a4f49a2` | Do not cherry-pick; replace the cutover with the recovered Runtime service architecture. |
| `738b7de5` | `9342184a` | Reapply contract-gap fixes against the recovered service. |
| `b6d5e8ad` | `8c85c94a` | Reapply CLI product-contract completion. |
| `74079799` | `d0e17124` | Reapply Skill/import convergence with cooperative execution restored. |
| `20435fd0` | `9c1f53f0` | Reapply process, timeout, and protocol boundary hardening. |
| `9f273f6b` | `e31338d5` | Re-evaluate every review fix; port behavior, not adapter assumptions. |
| `22b75c09` | `9b47bfb9` | Reapply porcelain workflow and schema/help completion. |
| `28aa7999` | `e57ac218` | Reapply CLI review-gap fixes. |
| `4e4f60ae` | `a78fc9e5` | Keep bounded read semantics, implemented through sparse projection and the live read model. |
| `79f5201a` | `06528a1d` | Keep deterministic selector coverage without weakening assertions. |
| `4c38e804` | `58eee658` | Reapply startup reconciliation through the recovered persistence service. |
| `2f5a1831` | `7cf2daf5` | Reapply Skill authority and startup Event correctness. |
| `5e3214cf` | `59afec13` | Reapply isolated Skill shell observation. |
| `0c4e6a57` | `114dbe09` | Reapply Agent authority and workflow hardening; audit every retired responsibility. |
| `81969e70` | `5dd4e10d` | Reapply incompatible Runtime replacement and identity checks. |
| `6effedc5` | `380e4df2` | Keep reviewed text-replacement classification. |
| `f123c5a3` | `35ddc00d` | Replace the compensating direct path with the recovered live-Core command service. |
| `519bfd3b` | `dba9b0cb` | Replace the compensating renderer path with historical editor settlement and explicit tests. |
| `d36dc81b` | `ea2bb5e1`, `0819a9a0`, `5a280cbb` | Keep canonical #590-era ContentStore integration, abandoned staging recovery, and durable cleanup on the recovered service. |

### Implementation surface

Expected shared and infrastructure scope includes:

- `src/core/core.ts`, `src/core/commands.ts`, `src/core/types.ts`, projection,
  field-slot, search, persistence-capture, and cooperative-import helpers;
- `src/outline/contract/`, `src/outline/runtime/`, `src/outline/client/`, CLI,
  import, server, transaction-log, and ContentStore integration;
- `src/main/main.ts`, Outliner service/action/asset adapters, Agent/Memory hosts,
  preload, packaging, and quit coordination;
- `src/renderer/api/`, document/revision state, editor, outliner, field, search,
  launcher, reference, and multi-window event consumers;
- relevant `tests/core/`, `tests/renderer/`, `tests/e2e/`, smoke probes, fixtures,
  and architecture guards; and
- `docs/spec/architecture.md`, `docs/spec/commands.md`,
  `docs/spec/ui-behavior.md`, Agent/Skill/permission/search/reference specs, and
  the archived #584 design where historical statements need clarification.

No dependency addition is expected. Any `package.json`, build, protocol, or
shared Core surface change is isolated and called out before implementation.

### Collision result

The open plan-only PR #591 overlaps startup readiness, Runtime ownership,
desktop transport, quit coordination, and resource disposal. Its post-#584 graph
is invalidated by this recovery. #591 must pause and be regenerated after the
recovery architecture settles; reusable static-composition decisions may be
carried forward, but its current implementation premise cannot run in parallel.

Open PR #587 covers Agent composer input history. It has no direct ownership of
the document Runtime, editor row settlement, field system, persistence, or
ContentStore. Its Agent files and current reference contracts still require a
file-level rebase check before the recovery PR moves from Draft.

### Verification and acceptance

- Restore the deleted `DocumentService`, `DocumentReadModel`, text-index,
  saver, cooperative-import, and projection-routing semantic tests against the
  new Runtime service rather than copying obsolete implementation assertions.
- Add renderer integration coverage for rapid typing, eager materialization,
  middle split, consecutive Enter, IME handoff, focused external replacement,
  and #590 inline-reference presentation refresh.
- Add one field matrix covering create, row conversion, reuse, rename, virtual
  value materialization, append, clear/dematerialize, name Enter, value Enter,
  sibling focus, and stable slot identity through one settlement path.
- Prove direct desktop typing and field edits do not call `forkCore`, full
  projection, complete text-index rebuild, Diff, or fsync on the accepted path.
- Prove sparse launcher/action reads and incremental search remain fresh across
  content, tag, field, reference, Trash, restore, and dependency changes.
- Prove a large import yields, remains atomic, stays searchable, and is one
  undoable/revertible Operation.
- Prove quit drains every admitted caller, a cancelled quit leaves services
  usable, teardown cannot abort an admitted write, and a failed save cannot be
  reported durable.
- Prove renderer IPC rejects path ingest/export while CLI and trusted Agent
  paths retain their intended capabilities.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, focused
  Electron E2E in `dev:codex`, `bun run docs:check`, the existing Runtime probe,
  and the typing hot-path render probe. Compare perceived editing and probe
  bounds to `8a1d5855`; do not substitute a current-branch relative improvement
  for baseline parity.
- Perform light/dark visual verification for row, field, reference, focus, and
  split behavior because the recovery touches UI state even when styling is not
  intended to change.

## Open questions

- PM ratification is required for the private desktop `accepted` / public
  `durable` settlement split. This deliberately restores the shipped typing
  contract while keeping CLI and trusted transactions durable.
- PM confirmation is required to pause #591 and regenerate it after recovery.
- The explicitly listed Agent/Memory retirements remain retired by default. A
  different product decision should be separated from this recovery rather than
  hidden inside compatibility work.

## Build checklist

- Establish baseline behavior tests and the no-fork/no-fsync hot-path guards.
- Extract the mature document/read/search/save mechanisms into the Runtime.
- Reconnect desktop text, structure, field, projection, and multi-window paths.
- Reconnect import, lifecycle, assets, security, launcher, Agent, Memory, and Skills.
- Replay #590 reference behavior and post-rebase ContentStore fixes explicitly.
- Run the full acceptance matrix and remove superseded cutover adapters only
  after every retained responsibility has a replacement.
