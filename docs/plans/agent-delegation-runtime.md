# Agent Delegation

**Shape:** A SET of complete features. Generic background Tool Tasks ship first
as an independently useful Bash capability. Internal delegation then ships as a
complete experimental capability while retiring Subagents and isolated Skills
in the same cutover. Each external Runner is a separate complete adapter, not
part of the foundation PR.

## Goal

Keep the two useful properties of Subagents, parallel execution and fresh
context, while removing Agent trees, nesting, peer messaging, and model-owned
Runner policy.

The root Agent loads the built-in `delegate` Skill and invokes a packaged CLI
through background `bash`. One invocation creates an isolated Agent Session and
runs its first Turn as a generic Tool Task. The root may later add context to the
same Session through a short `delegate send` Bash call; each continued execution
is another Tool Task with its own immutable result. Delegation therefore uses the
same background-task capability as video generation, builds, exports, and any
other long Bash command without reducing a multi-Turn Agent conversation to one
process result.

- **OBJ-1:** The user has one root collaborator; delegated work is ordinary tool
  work that the root eventually integrates or takes over.
- **Clean-slate answer:** Bash owns generic process execution, Tool Tasks own
  execution lifecycle, Agent Sessions own isolated context and ordered messages,
  the delegation CLI owns admission and session commands, and Runners own only
  harness adaptation.
- **Selected brownfield answer:** Reuse the current Agent execution kernel,
  tools, provider adapters, artifacts, worktrees, and Host-started Turns while
  deleting Subagent-specific identity, ledgers, routing, and UI.
- **Minimum acceptable outcome:** The existing Subagent product and generic
  isolated-Skill mode are completely retired. With the experiment enabled, the
  internal Runner restores parallel execution, fresh-context isolation, and
  root-owned continuation through the new path; with it disabled, the root works
  locally and no legacy delegation surface remains.

**PM decision (2026-09-03):** this is a direct pre-release cutover, not a
coexistence experiment. The internal delegation cutover deletes the existing
Subagent capability even though Delegation remains experimental and off by
default. Generic Skill `execution: isolated` retires in the same cut because no
bundled Skill uses it, it has no independent executor, and pre-release custom
Skills have no compatibility guarantee. A default user therefore has no
delegation capability until enabling the experiment. Measurement informs later
graduation of Delegation; it is not a gate that preserves or restores the old
system. External harness discovery is automatic and read-only; use remains
explicitly authorized by the user.

**PM correction (2026-09-03):** retiring the Subagent product does not retire
multi-Turn delegation. A root must be able to add information to running work and
continue the same isolated context after a Turn settles. The replacement keeps
that capability through a root-owned hidden Thread plus Skill-guided CLI
commands, without restoring Agent trees, peer messaging, nesting, or Subagent UI.

## Non-goals

- No model-visible delegation, Agent, spawn, send, wait, inbox, or roster tool.
  Invocation is `skill` -> `bash` -> `delegate`.
- No addressable child Agent, user-visible or navigable child Thread, generation
  tree, peer-to-peer messaging, delegated-to-root message route, or more than one
  Tenon-managed delegation level. A root-owned Agent Session handle identifies a
  restricted hidden Thread, not an Agent entity or tree node.
- No model-selected Runner, model, effort, concurrency, local scheduling limit,
  retry, fallback, or worktree policy. Runner selection belongs only to
  Settings.
- No silent retry, model fallback, Runner failover, or replacement task.
- No promise that added context mutates a model request or tool invocation already
  in flight. Steering is durably queued and consumed only at a Runner-safe Turn
  boundary.
- No coexistence period, legacy Subagent fallback, or experiment-result rollback
  to the retired system.
- No generic `execution: isolated` Skill mode, isolated-Skill child Thread, or
  compatibility path for pre-release Skills that declared it. Inline Skills
  remain; future context-isolated Agent work uses Delegation.
- No background system specialized for delegation. The generic layer contains
  no Runner, model, Agent, profile, or delegation field.
- No claim that delegation saves time or cost without complete-workflow evidence.
- No discovery or inference of API keys, accounts, Provider concurrency limits,
  cross-application usage, or credential sharing between Runners.
- No remote A2A service, general workflow engine, or arbitrary shell-template
  adapter.
- No external harness plugins, hooks, user MCP servers, custom Agent packs, or
  background Agents in the first external adapters.
- No public inbound API that lets Claude Code, Codex, OpenClaw, or another
  external harness invoke Tenon's internal Runner. That requires a separate
  user-authorized ownership, billing, permission, and result-routing design.
- No migration for pre-release Subagent execution data or isolated Skill
  definitions.

## Design

### Decision summary, constraints, and alternatives

The binding constraints are:

- the model invokes the CLI only through existing Bash;
- the user owns enabled Runners, the default Runner, and model policy through
  Settings; a model-controlled CLI argument cannot change them;
- an unavailable explicit model rejects before execution;
- Tenon itself creates and manages only one delegation level; arbitrary shell
  executables are not classified as Agent processes;
- the root remains responsive and owns final synthesis; and
- Tenon may bound only the work it starts locally; actual Provider and API-key
  concurrency remains unknown until a request succeeds or fails.

Rejected alternatives:

- A model-visible `delegate` tool duplicates Bash background semantics and puts
  changing Runner policy back into a model schema.
- A model-controlled `--runner` argument cannot prove user authority and may
  select a different account or cost boundary, so `delegate run` uses only the
  Host-bound Settings selection.
- A Delegated Task ledger beside a background Bash ledger creates competing
  completion, cancellation, and notification truth. The Agent Session is instead
  a restricted role of the existing Thread/Turn aggregate plus a thin binding
  for ordered message delivery and cross-aggregate settlement identity; neither
  owns process or Tool Task terminal state. The settlement journal contains only
  IDs, digests, and commit state, never a third copy of transcript or result data.
- Treating a remote protocol or external harness session as the task makes local
  failure and result recovery depend on vendor semantics.
- Shipping every external harness with internal delegation makes the core design
  depend on three unrelated CLIs before its value is known.
- Keeping the legacy Subagent path until experimental metrics pass would avoid a
  default capability break, but the PM explicitly chose a clean pre-release
  retirement instead of carrying two execution systems.

### Evidence and assumptions

- Production background Bash ownership now uses the durable `ToolTaskService`
  shipped in #623. The retained in-memory `backgroundTasks` helper is confined
  to direct test/custom tool construction outside `ThreadService`; it is not a
  product execution authority. Every remaining delegation unit consumes the
  durable generic task contract rather than reopening this foundation gap.
- The injected `KernelAgentOptions` boundary in `NativeAgentRuntime` supports a
  headless model gateway and tool set. The internal Runner reuses this kernel;
  it does not copy `PiTurnExecutor` or its Electron-backed Settings/tool wiring.
- Local executable evidence confirms non-interactive entry points for Claude and
  Codex CLIs and an ACP entry point for OpenClaw. Continuation, permission
  closure, and exact flags remain version-bound Adapter fixtures, not permanent
  assumptions in this plan.
- PR #619's real Agent replay is the design precedent for a one-call common
  path, one contract registry, closed-loop receipts, and task-corpus-first CLI
  design.
- The delivery-batch prepare/commit/reconcile protocol shipped in #612 and the
  immutable failure/delivery truth shipped in #614 are retained as generic Tool
  Task behavior rather than deleted with Subagent identity.
- Live inspection on 2026-09-03 found that the bundled `outline` Skill and every
  Skill in the active user/project search roots are inline. `execution: isolated`
  remains a documented public authoring contract today, so its parser,
  validation, runtime, specs, and tests must be removed explicitly rather than
  left to fail after its executor is deleted.

### Main flow and ownership

```text
root Agent
  -> `delegate` Skill
  -> background bash(command: "delegate run --input - --output json")
       -> Host delegation-launch admission
       -> generic process supervisor, direct-exec mode
       -> delegate CLI runtime (no parent shell)
            -> root-owned Agent Session
                 -> internal Tenon Runner
                 -> external harness Runner
  -> generic background completion
  -> root synthesis, `delegate send`, or ownership recovery
```

| Owner | Responsibility |
| --- | --- |
| Bash | Model-visible command/stdin surface, generic foreground/background execution, process sandbox, and routing of an exact admitted delegation launch. |
| Tool Task | Background identity, process truth, output, artifacts, cancel, recovery, delivery. |
| `delegate` Skill | When to delegate work to another Agent and how to form task intent. |
| Agent Session | A restricted hidden Thread that owns stable context, ordered root messages, Runner binding, settlement links, continuation, and closure. |
| Delegation launch admission | Recognizes the complete closed state-changing command, rejects shell composition from the privileged path, and lowers it to an attested direct-exec process specification. |
| `delegate` CLI | Capability admission, policy resolution, session commands, local scheduling lease, Runner lifecycle, normalized result. |
| Runner | One internal kernel Session or adapted external harness Session. |
| Root Agent | User communication, added context, verification, integration, and ownership recovery. |

Each CLI process and process group is one execution Turn and one Tool Task. There
is no app-owned Delegated Task beside it. The Agent Session is the existing
Thread/Turn conversation aggregate in a restricted hidden role; it is not a new
parallel transcript store. It may outlive a process so the root can continue
with the same context, but owns no execution status, cancellation result,
completion delivery, or process receipt. Runner session IDs and logs are Session
state or Tool Task evidence, never independent execution authorities.

### Generic background Tool Tasks

This foundation applies to every explicit-background Bash command and to any
foreground command whose cancelled process group still requires observable
teardown. Delegation is only its first demanding consumer.

`ToolTaskService` replaces the in-memory background-process map with a durable,
domain-neutral record containing:

- Host task ID, owner Thread, source Turn and Tool Item;
- command digest and display description, never duplicate command text;
- cwd, process identity, start and terminal timestamps;
- execution status and factual exit information;
- bounded stdout/stderr, declared output artifacts, and optional public progress;
- cancellation and timeout facts; and
- root-delivery claim and delivery Turn reference.

Its execution states are:

```text
running -> settling -> succeeded | failed | cancelled | timed_out | lost
running -----------> succeeded | failed | cancelled | timed_out | lost
```

`settling` is optional and domain-neutral: a producer result is prepared, the
process has exited, or teardown/reconciliation is pending, but process-group
quiescence and the final receipt are not both committed yet. Plain commands
normally move directly from `running` to a terminal state after quiescence. A
prepared result cannot be replaced; `task_stop` during `settling` forces process
group teardown without erasing that evidence. Terminal state and result are
immutable. Delivery is separately `pending | delivering | delivered | blocked`;
it never means handled, accepted, or used.

The Host runs each background command through a generic supervisor wrapper. The
supervisor owns the process group, durable output files, a nonce-bound process
identity, and atomic prepared-result/final-process receipts. A cooperative
producer may call `ToolTaskService.prepareResult` to store opaque bounded result
bytes and their digest while its process is still alive. The supervisor writes
the final receipt only after the main PID and every descendant in the owned
process group are absent or have been terminated; it records exit code or
signal, timeout/stop provenance, quiescence time, and the prepared-result digest.
`commitTerminal` refuses without that quiescent final receipt and alone moves the
Tool Task to its immutable terminal state. Plain Bash needs no prepared result
and reaches the same final-receipt boundary directly. After app restart, the
Host reattaches to a matching live supervisor or reads its receipts. Authenticated
process absence without a final receipt becomes one `lost` final receipt with
preserved partial output; the command is never replayed.

The supervisor is a standalone bundled Node entry, not an Electron-main module
path guessed by its caller. A generic runtime resolver selects the TypeScript
entry plus `bun` in source runs and
`resourcesPath/tool-task/tool-task-supervisor.mjs` plus the packaged Tenon
executable under `ELECTRON_RUN_AS_NODE=1` in packaged runs. The Tool Task build
step emits that bundle before `electron-builder`; `extraResources` copies it as
an unpacked resource. The supervisor is Host-private and never enters the model
tool `PATH`. Resolver tests cover source and packaged layouts, and the packaged
Tool Task smoke starts a benign command through the real bundle, observes its
quiescent final receipt, relaunches the Host, and proves reattachment or terminal
reconciliation.

Background Bash supports the same bounded `stdin` as foreground Bash. The Host
creates capture and task state first, starts the supervisor, writes and closes
stdin with backpressure, and returns the task handle only after the input was
accepted. Early exit or write failure settles that same task.

Background execution is explicit, not inferred from elapsed wall-clock time.
Omitted or false `run_in_background` waits for the same Tool Task to reach a
terminal state regardless of duration, because later Agent work commonly depends
on its result. True returns the durable task handle immediately. The Host never
changes a successful foreground control flow after an arbitrary timer. If a
cancelled foreground task remains nonterminal while its process group settles,
the Host promotes that same task to background visibility so cancellation and
recovery remain observable; this is a teardown safeguard, not automatic
background execution.

Ordinary commands require no integration. Cooperative CLIs may emit bounded
generic progress events such as a phase, message, or producer-supplied fraction.
The service validates and stores them without interpreting domain payloads.
Delegation never invents a percentage or exposes hidden reasoning; a future
video CLI may report a factual render percentage through the same channel.

All producer-controlled content has one authority boundary. Raw stdout, stderr,
progress text, artifact content, and Runner text are always
`untrusted/observation`; they cannot supply user intent, approval, or Host
instructions. Immutable task ID, state, timestamps, exit facts, and resource
references are `application/observation`. Only Host-authored handling rules are
`application/instruction`. Capture performs the existing bounded secret and
output scan exactly once before durable projection, and later delivery references
that stabilized content with `systemContext` provenance instead of
reclassifying or interpolating it into instructions.

Tool naming deliberately has two layers. Producer tools keep their domain names,
such as `bash`, and may return a `task_id` when execution becomes asynchronous.
The `task_*` control namespace operates that shared handle regardless of which
tool produced it. There is no `task_start` because Task control does not create
domain work.

`task_status` reads any Tool Task owned by the current Thread and returns its
state, bounded progress, and terminal result when available. Its guidance
forbids polling because completion is pushed; it exists for an explicit user
status request or recovery. `task_stop` remains the generic cancellation tool,
accepts only required `task_id`, and drops Agent-ID routing and deprecated
`shell_id`.

Stopping a running or settling task terminates its process group. A race with
natural exit preserves the first quiescent final receipt and its provenance.
Stopping a terminal task returns its factual result without rewriting it. If
the supervisor cannot prove process-group quiescence, the task remains
`settling`, retains its scheduler lease, stays ineligible for delivery, and
reports the teardown problem through `task_status`; uncertainty is never called
terminal. These semantics apply equally to a delegated review, video generation,
a build, or a plain shell script.

At the owning root Thread's next idle boundary, the Host selects one bounded,
ordered batch of pending terminal results. A durable `ToolTaskDeliveryBatch`
stores stable batch identity, target Thread, ordered task IDs and terminal
digests, reserved Turn ID, envelope digest, and stable client identity. One
transaction prepares the batch and moves only its members from `pending` to
`delivering`; a partial prepare commits nothing.

The Host then starts one completion Turn with empty canonical user input, the
reserved Turn ID, and the typed authority-separated context above. The canonical
`turn/started` event carrying matching batch identity and envelope digest is the
delivery commit point. Linking the prepared batch to that committed Turn changes
its members to `delivered` without claiming that the root handled or accepted
them.

Startup reconciliation handles every crash window:

- no matching canonical Turn rolls every still-current member back to `pending`;
- a matching Turn and digest links every matching member to `delivered`;
- stale membership or any identity/digest mismatch blocks only the affected
  member, retains its evidence, and reports the invariant failure; and
- a committed completion Turn that later fails remains the single delivery.
  Continue or Rerun from the #612 recovery contract consumes the original
  canonical envelope; it never creates a second Tool Task claim.

User-authored Turns win idle-boundary arbitration. Busy roots, renderer reloads,
and app crashes preserve prepared or pending work through reconciliation without
duplicate delivery.

Tool Task lifecycle is explicit:

| Event | Running process | Delivery and retained data |
| --- | --- | --- |
| Window close, navigation, or renderer reload | Continues. | State remains visible when the owner Thread returns. |
| Unexpected Host crash | Supervisor continues ordinary work when its nonce-bound identity remains valid; delegated work follows the broker-loss teardown rule. | Startup reattaches or reads the quiescent final receipt; authenticated process absence creates one `lost` receipt, while ambiguous identity remains `settling` and occupied. |
| Orderly application Quit | Host closes admission and asks every supervisor to terminate its process group. A supervisor that exceeds the bounded drain continues teardown, not domain work. | Records `cancelled` only after a quiescent final receipt; otherwise the task remains `settling` for startup reconciliation. Internal and external runs follow the same rule. |
| Archive owner Thread | Refused while a task is nonterminal, delivering, or awaiting delivery. | After delivery, archive keeps terminal history and artifacts under normal retention. |
| Delete owner Thread | Refused while a task is active or a changed worktree is retained. | After explicit stop/cleanup, deletion releases task-owned resource references and terminal records with the Thread. |
| Owner missing during recovery | Terminates any matching process and blocks delivery. | Retains bounded diagnostics and changed worktrees for explicit recovery; never starts an orphan Turn. |

Retention separates compact history from expandable detail. The terminal state,
delivery reference, bounded final envelope, and expired-detail marker remain with
the owning Thread until Thread deletion. Captured stdout/stderr/progress and
Tenon-managed task artifacts are detail bytes: at most 64 MiB aggregate per task,
1 GiB of logical detail bytes per owner Thread, and 8 GiB of physical detail
bytes across the application. Content-addressed bytes count once globally and at
their full logical length for each linked Thread. External cwd files and retained
worktrees are references, not copied detail bytes, and do not count toward these
quotas.

Hidden Session transcript resources and native resume state count toward the
owner root Thread's logical quota and the application physical quota. Context
required by an open Session is protected from pressure and age eviction, so a new
execution may refuse at reservation rather than destroy resumability. Closing the
Session removes that protection; the existing delivery-based clocks then make
old detail immediately eligible when its 30-day TTL has already elapsed.

The transition to `delivered` starts a 30-day detail TTL regardless of task
outcome. Pending, delivering, blocked, and undelivered terminal tasks are never
age-collected. Quota pressure may evict otherwise eligible delivered detail
oldest-first before 30 days; shared bytes remain while another canonical
reference owns them. Every new background task reserves its 64 MiB ceiling
before its process starts and releases unused reservation on terminal
settlement. If eligible collection cannot satisfy the Thread or application
reservation, the same task settles before spawn with a typed storage-limit
error. Its row reports required, reclaimable, and protected bytes and offers a
confirmed Host-owned action to clear eligible delivered details. An expired or
cleared row says that detailed output is unavailable but retains its compact
result and delivery truth.

Changed or crash-ambiguous worktrees are never age- or pressure-collected. A
successfully integrated worktree is removed through ordinary root Bash/git and
reconciled as cleaned; task details provide a separate Host-owned confirmed
cleanup action for a rejected retained worktree. No cleanup action is added to
the model tool catalog.

### Root-owned Agent Sessions

Delegation is multi-Turn even though every execution remains an ordinary Tool
Task. An Agent Session is the existing persistent Thread/Turn conversation model
used in a restricted hidden role, not a second transcript aggregate. A new
`delegation` Thread source replaces the overloaded `subagent` source. Its direct
`parentThreadId` is an ownership edge to one interactive root Thread, never a
recursive collaboration tree; delegated Threads cannot own another Session and
are excluded from Thread lists, navigation, Agent UI, cross-Thread references,
memory, and user-authored renderer admission.

The Thread owns normalized prompt history, Turn history, configuration, context
compaction, and transcript resources. A thin `DelegationSessionBinding` owns only
facts that do not belong to a generic Thread or Tool Task: the Settings-resolved
Runner and Task Profile snapshot, initial capability ceiling, current/previous
Tool Task links, execution-settlement identities and digests, adapter session
identity, ordered root-message commits, the user-stop resume fence, and Session
worktree disposition. It does not duplicate Turn content, process state, terminal
results, delivery claims, or Tool Task output.

The opaque CLI `SESSION_ID` is the hidden Thread's existing `id`; no second
public identity is minted. The Thread's existing `sessionId` remains an internal
Host-runtime binding and is not exposed as the delegation handle. Generic
background Bash returns its `TASK_ID` immediately, so the root can use
`delegate send --task` before the first execution settles. Every terminal
delegation envelope includes `SESSION_ID` for later `send --session` or `close`.

A Session is only `open` or `closed`. Whether it is running, queued, failed, or
cancelled is derived from its linked Tool Tasks rather than copied into Session
state. At most one execution Tool Task is active for a Session. Closing an idle
Session is irreversible and makes its managed context eligible for ordinary
retention; closing while its Tool Task is nonterminal is refused until
`task_stop` or natural settlement. An open Session may be continued after a
successful, failed, timed-out, cancelled, or lost execution, but failure and
user cancellation never start that continuation automatically.

Every delegated Turn preallocates one durable `DelegationExecutionSettlement`
identity. The coordination record contains the Session ID, hidden Turn ID, Tool
Task ID, ordered request/message-sequence digest, prepared terminal-envelope
digest, final process-receipt digest, and
`awaiting_result | prepared | context_committed | committed | blocked` state. It
contains no transcript content, process result, or copied terminal status. The
same identity and request digest are committed on hidden `turn/started`, so
replay cannot attach a Tool Task to a different Turn or message prefix.

Delegated termination is a prepare/commit/reconcile protocol:

1. The CLI submits its normalized final Turn material and terminal envelope over
   the authenticated broker. The supervisor durably writes the opaque prepared
   result and digest; the Tool Task becomes `settling` but is not successful.
2. The Host reconstructs the final Turn only from the canonical item stream and
   prepared envelope, then appends hidden `turn/completed` carrying the settlement
   identity, request/message digest, and terminal-envelope digest. This rollout
   append is the canonical Session-context commit.
3. The Host acknowledges that context commit to the CLI. The CLI closes its
   Runner and exits; the supervisor enforces a bounded exit grace, terminates a
   hung CLI or remaining descendants, and writes the final process receipt only
   after proving process-group quiescence.
4. Only a matching canonical completion plus that quiescent final receipt lets
   `ToolTaskService.commitTerminal` commit the immutable Tool Task result and
   make root delivery eligible.

A clean expected CLI exit preserves the prepared envelope's normalized outcome.
A nonzero exit, signal, exit-grace timeout, forced descendant teardown, or broker
loss after the hidden Turn commit makes the Tool Task `failed`, `timed_out`, or
`cancelled` according to factual provenance; it never reports `succeeded`.
Already committed Session content is retained as partial evidence rather than
rolled back. Explicit continuation remains admissible only after quiescence and
digest reconciliation prove the canonical context is intact, and still obeys a
user-stop fence. Inability to prove quiescence keeps the Tool Task `settling`,
holds its lease, blocks delivery, and blocks Session continuation.

Startup keeps Session continuation and Tool Task delivery closed while it
reconciles both evidence stores. A prepared receipt without `turn/completed` is
replayed into that same preallocated Turn commit, never through another Runner
call. A matching completion with a live process waits for the supervisor's
quiescence proof; a matching final receipt with a nonterminal Tool Task finishes
the original Tool Task commit. If neither process nor prepared result survives,
the Host records one factual `lost` final receipt and commits the original hidden
Turn as failed. A canonical completion without its matching prepared receipt, a
duplicate identity, or a digest mismatch marks only that settlement `blocked`,
preserves the Thread and supervisor evidence, reports an invariant failure
rather than success, and refuses continuation. After process-group quiescence is
proven, it terminalizes the Tool Task as a Host coordination failure; before
then, it remains `settling` and occupied. There is no reachable terminal Tool
Task whose process group may still be alive, and no successful Tool Task whose
hidden Turn is incomplete.

The recovery matrix has one action per durable boundary:

| Last verified boundary | Recovery action |
| --- | --- |
| No prepared result; delegated process still exists | Treat broker loss as failure, terminate the process group, and wait for its quiescent final receipt. |
| Prepared result; no matching hidden completion | Commit the same preallocated `turn/completed`; never rerun the Runner. |
| Hidden completion; process or descendants still exist | Keep `settling`, retain the lease, and finish or force teardown without delivery. |
| Quiescent final receipt; Tool Task nonterminal | Validate both digests and commit the original Tool Task with the receipt's factual outcome. |
| Tool Task terminal; delivery uncommitted | Use only the generic delivery-batch reconciliation path. |
| Any identity/digest mismatch | Preserve both evidence sets, block Session continuation, prove teardown, then fail the Tool Task without success delivery. |

A delegated CLI and its Runner require the Host broker for canonical history.
Unlike an ordinary background command, they do not continue unattended after
broker loss. The surviving supervisor terminates their process group. If a
prepared result already exists, restart completes or recognizes the original
hidden Turn commit and waits for a quiescent `host_broker_lost` final receipt
before failing the Tool Task; otherwise the supervisor prepares the failure
envelope first. An external harness never outlives the only authority able to
commit its Session, and broker loss never makes its task terminal before teardown.

`delegate run` creates the hidden Thread and first execution idempotently from
the source Tool Item, Tool Task, request digest, and preallocated Session ID. A
replayed call resolves the same identities. Failure before the Session commit
leaves only the same failed Tool Task; failure after it leaves one recoverable
open Session and never creates another Thread or Runner execution.

The root may add context without exposing a model-native Agent messaging tool.
`delegate send` accepts bounded stdin and targets either an active Tool Task or
an existing Session handle owned by the current root Thread. The Host capability
binds the target, exact message bytes and digest, source root Turn and Tool Item,
current root capability ceiling, and Session revision. A different root,
delegated Runner, user shell, external Agent, stale revision, closed Session, or
unknown target is refused before the message or Provider is reached.

Messages are persisted before `delegate send` acknowledges them. Each has a
monotonic Session sequence, immutable digest, source provenance, and
`queued | committed | blocked` delivery state. A per-Session gate linearizes a
message racing execution settlement:

- when committed before the active Turn's close boundary, it is added once at
  the next Runner-safe boundary before another model request;
- when the active Turn closes first, the `delegate send` invocation starts one
  new Turn and Tool Task on the same hidden Thread;
- when the active Tool Task fails, times out, is cancelled, or is lost before a
  queued message commits to a model request, the message becomes `blocked` and
  returns to the root with the failure evidence; it never becomes a silent retry;
  and
- after Host restart, the Thread transcript plus message sequence/digest decides
  whether a message was already committed, so recovery neither drops nor repeats
  it.

Steering never claims to mutate a Provider request or tool invocation already in
flight. It changes only a later model boundary in the same Turn or an explicit
continued Turn. Root-produced message text is typed delegated-task context: it
may refine the assignment, but cannot prove user approval, raise the Session's
tool ceiling, change Runner/model/effort/worktree policy, or override Host
instructions. Several pending messages are delivered in sequence as one bounded
context block with their individual provenance preserved.

User cancellation creates an authority fence, not merely a Skill instruction.
Each newly accepted renderer-authored root Turn receives a monotonically
increasing `rootUserIntentRevision`; automatic completion, feature, continuation,
recovery, and Rerun Turns do not mint one. Before acknowledging a user-originated
stop, the same per-Session gate persists its stop provenance, cancelled Tool Task
ID, and `minimumResumeRevision = current root revision + 1` on the Session
binding. Process termination happens only after that fence is durable.

A later `delegate send` capability binds its source root Turn's canonical user
intent revision. Host admission refuses a stopped Session unless the source is a
fresh renderer-authored Turn whose revision meets the fence. The first admitted
post-fence continuation records that Turn and revision while advancing the
Session revision; old capabilities and Tool Items remain stale. The automatic
cancellation-completion Turn has no user revision, and Continue/Rerun of an old
Turn preserves its old revision, so neither can clear the fence or start another
paid Turn. Replay returns the original refusal or admission outcome rather than
re-evaluating it against a later revision.

Every Session resolves Runner, effective model/effort, Task Profile, maximum
access, cwd, and worktree policy once at creation. Settings changes affect new
Sessions only. Every continued Turn revalidates live model authorization and
intersects the original Session ceiling with the root's current ceiling, so it
may narrow but never widen authority. An unavailable pinned model or disabled
Runner blocks that Turn before Provider I/O without changing the Session binding
or silently selecting another Runner.

Writable Sessions own one dedicated worktree across all Turns. Each Tool Task
reports independently computed current patch evidence, but the worktree remains
attached until the root closes and integrates or explicitly rejects the Session.
This lets the root request corrections against the same isolated state. Idle
Sessions hold no scheduler lease or process. An open Session auto-closes after
30 days without an active Tool Task or committed root message; owner Thread
archive closes its idle Sessions, and owner deletion follows the Tool Task and
changed-worktree refusal rules before deleting their hidden Threads.

### Skill and CLI

The built-in `delegate` Skill is inline and model-only. It appears in an
interactive root catalog whenever delegation is enabled; Runner readiness is an
admission state, not Skill-catalog membership. It is absent from delegated
execution and automations. This lets the root explain a disabled, missing, or
stale Runner configuration instead of silently losing the capability when the
user explicitly asks for delegation.

Its catalog description is direct: `Delegate an independent task to another
internal or external Agent and return its result to the current Agent.`

Its complete routing policy is:

- delegate only a substantial, independently specifiable task;
- use background Bash for every delegated run and return control immediately;
- use only the Settings-selected default Runner; when the user asks for another
  Runner, explain that they must change the default rather than implying the
  current run can override it;
- do not duplicate running delegated work locally;
- create only the few independent tasks that fit the Thread's configured local
  outstanding-work limit;
- rely on Host completion instead of polling;
- when new user context materially changes an active assignment, send it to the
  existing Session instead of duplicating the work or starting a fresh Session;
- after a non-user-initiated failure, keep verified evidence and return task
  ownership to the root; continue locally only when the root can do so safely;
- after user cancellation, acknowledge cancellation and do not continue the
  cancelled work without a new user request.

Each initial or continued Turn uses one background Bash call. The model sends
the input through `bash.stdin`; no prompt or path enters command source. Bash is
the model-visible invocation surface, not a promise that every admitted command
runs through a shell. A send to an active Tool Task normally settles after
durable queue acknowledgement; a send to an idle Session remains the background
execution for its newly admitted Turn.

```text
delegate run --input - [--output text|json]
delegate send (--task TASK_ID | --session SESSION_ID) --input - [--output text|json]
delegate close --session SESSION_ID [--output text|json]
delegate doctor [RUNNER_ID] [--output text|json]
delegate schema [run|message|result]
delegate version
```

Run stdin uses the versioned task-intent envelope shown below. Send stdin is the
smaller versioned message envelope
`{"version":1,"message":"Inspect the newly reported race as well."}`. Neither
form accepts conversation history, Runner policy, a Session identity, or an
authority claim inside its content.

There is no `delegate status`, cancel, Runner-list, or configuration command.
Status and cancellation are generic Tool Task operations; Session continuation
and closure are Agent-domain commands; Runner policy belongs in Settings.
`delegate run` and `delegate send` accept no Runner, model, effort, access, or
scheduling override and v1 rejects every input source except `-`. `delegate
close` never stops a Tool Task or cleans a changed worktree. `doctor` may inspect
a named Adapter but cannot change run policy. `schema` and `doctor` are
diagnostics, never common-path preflight.

`delegate` has one executable wrapper and one bundled CLI entry. The
source resolver selects `src/delegate/bin/delegate`, the TypeScript CLI entry,
and `bun`; the packaged resolver selects
`resourcesPath/delegate/bin/delegate`,
`resourcesPath/delegate/delegate.mjs`, and the packaged Tenon executable under
`ELECTRON_RUN_AS_NODE=1`. A dedicated build step emits the CLI bundle before
`electron-builder`; `extraResources` copies the bundle and executable wrapper.
The root's per-Turn Bash environment adds the resolved bin directory only while
Delegation is enabled. Delegated Runner environments always remove it. The
wrapper resolves the private runtime entry for unprivileged diagnostics and
direct-invocation refusal; it never receives or forwards a launch capability. A
user shell or external Agent that discovers the wrapper may run its read-only
diagnostics, but every directly invoked state-changing command has no launch
capability and is refused before Runner, worktree, or Provider activity;
executable presence is not an inbound Agent API.

State-changing commands have a narrower path. The shared command registry emits
a Host-side parser for the exact complete `delegate run`, `send`, and `close`
forms above. The parser accepts only the canonical bare command, fixed option
order, and lexically valid task/session IDs. It accepts no quoting, environment
assignment, path-qualified executable, redirection, pipe, separator, expansion,
command substitution, grouping, background operator, or trailing command. On a
full match the Bash Tool call remains the visible Tool Item, but the Host lowers
the parsed argv and captured stdin to a generic direct-exec supervisor process
specification. The supervisor starts the resolved CLI runtime directly with
`shell: false`; neither the user's shell nor the executable wrapper is an
ancestor. Any non-match follows ordinary unprivileged Bash execution with no
launch capability, so an embedded or composed `delegate run|send|close` reaches
the wrapper only to be refused. Read-only `doctor`, `schema`, and `version`
remain ordinary shell commands and cannot acquire state-changing authority.
After an exact match, any parser/runtime-resolution, process-specification, pipe,
spawn, or capability-verification failure settles that Tool Task explicitly and
never falls back to shell execution.

The versioned run input contains only task intent:

```json
{
  "version": 1,
  "prompt": "Inspect the recovery path and report concrete correctness risks.",
  "profile": "explore",
  "access": "read-only"
}
```

Bash `description` is the single display summary. `profile` is `general`,
`explore`, or `plan`. These are Runner-independent Task Profiles, not Agent
types, personas, or model containers. `explore` and `plan` enforce read-only;
`plan` also prohibits implementation. `general` may request read-only or
workspace-write within the root's ceiling.

One registry generates schema, parsing, normalization, help, admission
lowering, message and result envelopes, and permission classification. An
execution-owning CLI invocation writes progress to the supervisor's generic
event channel, emits one terminal envelope to stdout, and exits with a stable
code. A queue-only send emits one durable acknowledgement and exits. The CLI
never exposes credentials or reads Tool Task persistence directly. Its
nonce-authenticated Host broker is also the only route for loading and committing
hidden Session Turns and root messages; the CLI never opens the application's
Thread database.

For every admitted state-changing command, the Host supplies a short-lived,
one-use capability bound to the root Thread, Tool Item, cwd, exact normalized
argv, digest and byte length of the captured Bash `stdin`, effective capability
ceiling, and configuration revision. Send capabilities also bind the source
Turn's canonical user-intent revision or its absence and the current user-stop
fence. Run capabilities additionally bind the Settings-selected Runner,
model/effort policy, local scheduling policy, and preallocated Session identity;
send/close capabilities bind the target Session revision and prove ownership.
The Host seals the capability to the attested process specification and
transfers it to the trusted supervisor through a one-shot inherited control pipe
rather than the persisted supervisor config. The supervisor verifies the sealed
process specification, writes the capability once through a distinct child-only
pipe on a fixed extra file descriptor, and closes both pipes after CLI admission.
Neither process places the capability, broker credential, or descriptor number
in argv, stdin, an environment variable, an output file, or a shell-visible
process. The supervisor separately writes the exact already-hashed input bytes
to CLI stdin. The CLI consumes one bounded stdin stream, verifies its digest
against the capability, and closes the capability descriptor before starting a
Runner. It never opens a task file or follows a task-input path, and Runner stdio
cannot inherit the closed descriptor.

`delegate run`, `send`, or `close` without the matching capability is refused. A
Settings change or mismatched request digest makes an unused capability stale
and requires a new root Tool call rather than substituting authority. The
capability is unavailable to the delegated Runner, so knowing the CLI path or
Session ID cannot create, steer, resume, or close Tenon-managed work. Tool-call
replay resolves the existing command outcome by source Tool Item and request
digest; a mismatched replay fails closed.

### Internal Tenon Runner

The internal Runner imports the same Agent execution kernel used by the app into
a headless CLI session. It does not recursively launch the Electron app or use
`SubagentCollaboration`.

The Session receives the delegated prompt, later committed root messages, Task
Profile, repository instructions, admitted resources, and effective access. It
does not receive the root conversation. Its normalized conversation is the
hidden Thread's canonical Turn history; Runner-native transcripts and logs are
bounded Tool Task or Session resources. It has no routable child Agent identity
and never appears in the Thread list.

Effective tools are:

```text
root capability ceiling
  intersect Task Profile
  intersect requested access
  intersect delegated-run hard blocks
```

It may reuse current file, foreground Bash, Web, inline Skill, MCP, and extension
tools when admitted by every layer. It cannot delegate, ask the user, manage
automations, control the root, start background Bash, or call
`task_status`/`task_stop`. These are runtime blocks, not prompt advice.
The delegated process environment also removes known Agent-harness executables
from `PATH` as defense in depth. Foreground Bash can still execute an arbitrary
absolute binary, so the claimed invariant is deliberately narrower: the session
has no Tenon launch capability or admitted Tenon/native harness delegation tool;
Tenon does not claim to classify every executable as Agent software.

Provider calls use a Host broker scoped by the consumed launch capability, so
credentials never enter CLI or Runner argv, environment, or files. Broker
disconnect cancels the active internal call and causes the supervisor to
terminate the full delegated process group.
The prepared-result protocol preserves any already committed hidden Turn, while
the quiescent final receipt records the Tool Task as `host_broker_lost`; no hidden
app-side or external run continues after broker loss, and no Tool Task
terminalizes before teardown.

The model and effort default to **Inherit parent**. Settings may pin a currently
available model and supported effort. If an explicit choice disappears or loses
authorization, admission refuses before provider I/O. It never inherits,
upgrades, falls back, or changes Runner silently.

### External Runners

An external Runner is a child of the trusted `delegate` process and uses its
harness's native model loop and a proven subset of built-in tools. Tenon does not
translate each external tool call. The Adapter probes compatibility, maps the
effective parent capability ceiling to a closed native configuration, builds
safe argv, normalizes session events and final output, persists only the minimum
resume identity, and propagates cancellation.

The CLI still owns cwd/worktree, access ceiling, sanitized environment, local
scheduling lease, per-Turn timeout, bounded output, and the final result. It
starts the harness in the same process group, disables vendor cloud/background
execution and native Agent/Subagent features, and kills descendants on terminal
exit. Continuation uses only a Tenon-bound local resume identity; no unattended
vendor session or process survives a Tool Task.

Every Adapter publishes a version-bound `AdapterCapabilityMap` from Tenon action
kinds to exact harness flags and native tools. Admission proves that each enabled
native capability is a subset of the effective root ceiling after Task Profile,
requested access, and delegated hard blocks. Missing disable controls,
unclassified native tools, or a harness default that can widen shell, filesystem,
network, MCP, Skill, extension, or external-action authority makes the Adapter
Not Ready for that request.

External runs use a closed configuration. Plugins, hooks, user MCP servers,
custom skills, custom Agents, and unchecked config are disabled. Tenon resolves
repository instructions and passes them explicitly. The first adapter may admit
only file-read tools with shell and network disabled; broader native tools ship
only when their subset mapping is proven. Broader extension support is a later
capability, not arbitrary settings passthrough.

Adapter readiness requires version-bound proof of machine-readable terminal
output, cwd, effective-capability subset, cancellation, session continuation,
safe local resume identity and closure, and disabling the harness's native
Agent/Subagent features. The Adapter declares whether an active message can be
consumed at an in-process safe boundary or only as the next resumed Turn; Tenon
never advertises immediate steering when only continuation is available. Prompt
rules do not count. Known Agent executables are removed from child `PATH` as
defense in depth, but arbitrary foreground shell execution is not represented as
a structural no-nesting guarantee. Unsupported versions remain Detected but Not
Ready.

Candidate adapters are:

- **Claude CLI:** non-interactive machine-readable streaming plus a version-bound
  local continuation path, safe config, explicit capability-subset tools, and the
  `Agent` tool denied.
- **Codex CLI:** non-interactive JSON execution plus a version-bound local
  continuation path only when explicit sandbox and closed-config controls prove
  the admitted subset, with multi-agent capability disabled.
- **ACP Runner Adapter:** ACP Client support only after negotiation proves
  access, cancellation, sequential prompt continuation, native Agent-feature
  disablement, and the effective capability subset. ACP v1 does not standardize
  mutation of an already active prompt, so queued context becomes the next
  `session/prompt` unless a separately proven extension supplies a safe boundary.
  OpenClaw is one possible ACP Agent, not the protocol itself; installed
  `openclaw acp` alone is not enough.

Authentication remains the harness's responsibility. Discovery never logs in,
installs, updates, starts a paid call, or reads credential contents. Expired auth
after readiness is a normal Runner failure.

### User policy and local admission

Settings -> Agent -> Delegation contains:

- an **Experimental delegation** switch, off by default;
- default Runner;
- per-Runner Detected, Ready, Enabled, version, and diagnostic state;
- internal **Inherit parent** or a live model and supported effort;
- external **Harness default**, plus explicit models only when the Adapter can
  enumerate and validate a finite live catalog;
- maximum access, with external Runners read-only by default;
- bounded per-Turn run duration; and
- Advanced global, per-Thread outstanding, per-Runner, and local scheduling-pool
  limits.

Startup detects known executable names and saved paths with a bounded version
probe. Detection does not authorize use. Turning on the experiment enables the
internal Runner and selects it by default; every external Runner requires its
own enable action. Disabling a Runner blocks new runs but does not discard an
active Tool Task. It also blocks continuation of an idle Session bound to that
Runner; the Session remains inspectable and closable and never switches Runner.

The experiment switch controls only the new Delegation capability. It does not
restore legacy Subagent tools when off. The cutover removes
`agent`/`agent_message` and their UI for every user; with the experiment off,
`delegate` is absent, no delegation control appears, and the root performs work
locally. Tenon does not show an unavailable legacy fallback or block ordinary
root work. Settings is the only Runner-selection authority. Changing the default
affects future Sessions only, never an admitted or existing Session.

Runner and model choices come from live provider or Adapter capabilities, never
from a model schema or static model list. A pinned unavailable Runner or model
makes that configuration Not Ready and causes one actionable refusal. A Tool
Task may already exist because Bash creates generic task state before launching
the CLI, but refusal starts no delegated session, Provider request, harness, or
worktree and the same Tool Task settles immediately with the admission error.

Before starting a Runner, the CLI acquires global, Thread, Runner, and local-pool
leases from a generic Host admission scheduler. These are user-configured or
conservative product limits over processes Tenon starts, not discovered Provider
capacity. Internal runs and root provider Turns may share one local pool, where
root work has priority over delegated work that has not started. Active requests
are never preempted. External Runners default to a conservative isolated local
limit; users may manually group Runners they believe share an account or other
constraint without Tenon inspecting credentials or asserting that the grouping
matches Provider reality.

Every acquired lease is a durable record bound to its Tool Task ID, supervisor
nonce, Runner, Thread, pool, and configuration revision. Startup keeps all new
admission closed while Tool Task recovery authenticates every nonterminal
supervisor or final process receipt. It then reconstructs global, Thread, Runner,
and pool occupancy in one transaction before reopening admission. A matching live
supervisor consumes its reconstructed lease; a committed quiescent final receipt,
including authenticated `lost`, releases it exactly once. An identity-ambiguous
process remains occupied and blocks capacity until recovery terminates or settles
it; restart never treats uncertainty as a free slot. Root provider work cannot
survive its Host broker, so only a newly admitted recovery Turn acquires root
occupancy. An idle Agent Session owns no scheduler lease; every continued
execution reacquires admission without changing the Session's pinned Runner
policy.

A saturated local limit waits and reports a generic public phase. A full bounded
Thread or global queue refuses before Runner start. Tenon cannot observe use by
other applications, infer an API key's real concurrency, or guarantee that a
locally admitted request will succeed. Provider rate limits after start are
factual failures: no automatic retry, failover, model change, adaptive limit
change, or credential inference follows. The result may suggest that the user
lower a local limit, but never claims a diagnosed account capacity.

### Workspace, failure, and result

Read-only work uses the root cwd under a Host-enforced read-only ceiling. Every
workspace-write Session gets one dedicated git worktree before its first Runner
Turn. All continued Turns use that same worktree. Non-git or unisolatable
writable work is refused. The worktree remains Session-owned while continuation
is possible; unchanged worktrees are removed when the Session closes. Changed or
crash-ambiguous worktrees remain artifacts and are never merged or copied
automatically.

For every changed worktree at each Turn boundary, the CLI computes the base revision, changed-file
manifest, normalized patch, retained worktree path, and reported verification
evidence independently of Runner prose. Runner success means only that the
isolated run settled successfully; it never means those changes reached the
root workspace. The root inspects the evidence, applies or reconstructs accepted
changes only after closing the Session, verifies the integrated result, and then
removes the worktree. Before closure it may instead send corrections against the
same isolated state. Conflict, rejection, or uncertain recovery keeps the
worktree and patch available and produces no integration claim.

Admission refusal starts no Runner, provider call, harness, worktree, retry, or
fallback. Once an execution starts, success, failure, timeout, cancellation,
malformed output, auth/rate-limit failure, or process loss produces one CLI
envelope, an optional prepared-result receipt, and one final process receipt.
The envelope includes the stable Session handle, Turn identity, committed
root-message sequence, and whether continuation remains admissible; it never
rewrites an earlier Tool Task result. The Tool Task is terminal and deliverable
only after the final receipt proves process-group quiescence.

The result includes terminal status, Runner/version, effective model when
reported, duration, bounded final text or actionable error, partial-evidence
status, transcript and artifact references, worktree disposition, and factual
usage/cost when available. Missing usage is `unknown`, never zero. Runner output
is untrusted observation.

Background settlement updates the Tool Task immediately and notifies the root at
its next idle boundary. The conversation stays interactive. After a failure,
timeout, or loss, the root preserves verified partial evidence, makes no
unsupported completion claim, and takes ownership of the unfinished user goal.
It may explicitly continue the same open Session with corrective context or work
locally when feasible; otherwise it reports the blocking fact and recovery
options. It does not create a replacement Session or retry automatically. A
user-cancelled task remains cancelled and triggers no automatic continuation or
local takeover; a later user request may explicitly continue its open Session.

### User experience

The transcript shows ordinary Skill and Bash Items. Delegated work always
appears in a generic Tool Task strip shared by delegation, video generation,
builds, and other commands. Each row has description, running/terminal state,
elapsed time, public progress when supplied, cancel, and failure indication.
Details show bounded output, artifacts, diagnostics, and retained worktree.
After a producer result is prepared, the row remains nonterminal as `Finishing`
until process-group teardown is proven; cancel remains available and no root
completion is emitted. An abnormal post-result exit shows a failed task with the
prepared answer retained as partial evidence and states whether the Session may
be continued.

There is no Agent roster, child tree, generation count, peer-message UI,
Agent-specific resume control, or child Thread navigation. Internal and external
Runners look the same at the Tool Task layer. A task detail may show its opaque
Session reference plus factual queued/committed/blocked context counts so the
root and user can verify a requested update without exposing an Agent hierarchy.

An invalid explicit model does not spin or silently switch. Settings shows the
Runner as Not Ready; if invoked, the generic Bash task settles immediately with
an actionable admission error and no delegated session starts. A running failure
updates the same generic task row and produces the same Host completion as any
failed long-running command. User cancellation reports cancellation without
asking the root to continue the work. Several results that become deliverable at
one idle boundary appear in one root completion Turn, not a burst of autonomous
Turns. Sending added context produces an immediate durable
queued/continued/refused result through the ordinary Bash Item; it never merely
says that the Agent was notified.

The Bash Item and task details show the Settings-selected Runner. If the user
asks for a different Runner, the root explains how to change the default instead
of pretending it can authorize a per-run override. An isolated external Runner
uses the Adapter's closed capability subset, not the user's full interactive
harness configuration. Writable success is described as changes ready for root
review until the root actually integrates and verifies them.

### Retirement and delivery units

| Current surface | End state |
| --- | --- |
| `agent` | Removed; experimental delegation is available only through Skill + Bash + CLI when enabled. |
| `agent_message` | Removed from the model tool catalog; root-to-owned-Session steer/resume moves to `delegate send`, while peer and delegated-to-root routes disappear. |
| `bash` | Preserved; gains generic durable background execution and stdin. Internal delegation later adds strict routing from an exact state-changing CLI command to a Host-attested direct-exec process, without adding a model-visible tool. |
| `task_status` | Added for any owned Tool Task; never used for polling. |
| `task_stop` | Preserved for the current Tool Task only; it never deletes or silently resumes an Agent Session, and Agent-ID/`shell_id` routing is removed. |
| `skill` | Preserved for inline Skills; gains the root-only inline `delegate` Skill. |
| Skill `execution: isolated` | Removed from parsing, validation, authoring, catalogs, runtime, persistence, and specs. |
| Agent types | Removed as addressable/configurable entities; task profiles retain only intent semantics. |
| Subagent UI | Removed; generic Tool Task presentation replaces it. |
| Subagent child Thread | Replaced by a restricted hidden `delegation` Thread that reuses canonical Thread/Turn context without Agent-tree projection or nested ownership. |

`SubagentCollaboration`, Subagent execution/request ledgers, recursive generation
routing, nesting budgets, Role-derived spawn definitions, peer/main messaging,
Agent delivery, and Agent-tree presentation are deleted. Root-owned continuation
is rebuilt narrowly on canonical hidden Threads, privileged Turn steering, the
thin `DelegationSessionBinding`, and `delegate send`; no Subagent record or UI is
retained. `spawnIsolatedSkillThread`, isolated-Skill task paths, frontmatter and
managed-install admission, child-result projection, and isolated-Skill tests/spec
text are deleted with them. Skill `execution`, `allowed-tools`, `model`, `effort`,
`shell`, and embedded-shell execution metadata are no longer accepted. A
managed, user, or project Skill declaring any retired field is unavailable with
an actionable validation diagnostic; it never silently becomes inline.
Domain-neutral provider, tool, Thread/Turn, transcript, artifact, worktree, and
Host-turn primitives remain.

This retirement is unconditional. Feature-off tests assert that legacy Agent
tools and UI do not return when Delegation is disabled. Existing pre-release
Subagent execution data and managed isolated-Skill records have no compatibility
reader and are removed by the documented dev userData reset. Workspace Skill
files remain user-owned but must remove retired fields before they load again.

The delivery order is:

1. **Generic background Tool Tasks:** Durable supervised Bash tasks, stdin,
   restart recovery, `task_status`, generic completion, artifacts, cancellation,
   and generic task UI. This is complete and useful without delegation.
2. **Internal delegation and legacy retirement:** CLI, Skill, exact Bash-command
   admission and direct-exec lowering, private command capabilities, hidden
   multi-Turn Agent Sessions, root message queue, provider broker, local
   admission scheduling, internal Runner, Settings, worktree handoff and
   integration evidence, experiment, and total Subagent plus isolated-Skill
   retirement in one PR.
3. **Claude CLI adapter:** One complete external Runner with fixtures and real
   run evidence.
4. **Codex CLI adapter:** The equivalent complete Codex Runner.
5. **ACP Runner adapter:** The protocol adapter after its capability gate passes;
   OpenClaw is one separately verified ACP Agent candidate.

The complete Generic Tool Task feature is the shared-interface-first owner: its
protocol, codec, persistence, Host lifecycle, and renderer projection land
together as one useful feature before any delegation consumer. A separate
unused interface-only scaffold would violate the repository's complete-feature
rule. The internal delegation unit starts only after that merged contract and
owns the one-cut Subagent and isolated-Skill deletion; external adapters start
only after the internal Runner registry and capability map merge.

| Delivery unit | Primary files and symbols | Main risks and collision order |
| --- | --- | --- |
| Generic Background Tool Tasks | `src/main/agent/capabilities/agentLocalTools.ts` (`backgroundTasks`, Bash execution); `src/main/agent/runtime/ToolRuntime.ts`; new `src/main/agent/tasks/*`, including the supervisor entry and source/packaged resolver; `src/main/agent/ThreadService.ts`; `src/main/agent/thread/TurnLifecycle.ts`; `src/core/agent/protocol.ts`, `codec.ts`, `rendererProjection.ts`, and `tools.ts`; `src/main/hostDomain/agentHost.ts` and `compositionLifecycle.ts`; `src/renderer/agent/components/ThreadDock.tsx`, `store/threadStore.ts`, and a generic task strip/detail surface; `package.json` build/`app:build`/`extraResources`; a packaged Tool Task smoke; corresponding Core/renderer/E2E tests and current Agent specs. | Owns the shared task/delivery interface and its runnable packaged supervisor first. Risks are orphan processes, source/package path drift, duplicate/lost delivery, authority confusion, unbounded retention, and quit/delete races. Starts after #622 releases `package.json`, then takes a coordinated infrastructure claim. |
| Internal delegation and Subagent/isolated-Skill retirement | New `src/delegate/contract/*`, `cli/*`, `bin/delegate`, and `runners/internal/*`; new `src/main/delegateRuntime.ts`; new `src/main/agent/delegation/*` for the thin Session binding, ordered root-message commits, and root-only command admission; `src/main/builtInSkills/delegate/SKILL.md`; `src/main/agent/runtime/kernel/NativeAgentRuntime.ts` and `kernel/types.ts`; `src/main/agent/ThreadService.ts`; `src/main/agent/thread/ThreadCatalogOps.ts`, `TurnLifecycle.ts`, `ThreadResourceOps.ts`, `ThreadHistoryReference.ts`, `ThreadTranscriptWriter.ts`, and `ThreadTrajectoryProjection.ts`; `src/main/agent/persistence/ThreadMetadataStore.ts`; `src/main/agent/AgentConfigurationLoader.ts`, `AgentConfigurationWriter.ts`, `agentExecutionSelection.ts`, and `worktree/AgentWorktree.ts`; `src/main/hostDomain/agentHost.ts`; `src/core/agent/configuration.ts`, `tools.ts`, `protocol.ts`, `codec.ts`, and `rendererProjection.ts`; `src/renderer/ui/agent/AgentSettingsView.tsx`, `SettingsAgentSection.tsx`, and `AgentsSettings.tsx`; `src/main/agent/capabilities/agentLocalTools.ts`, `agentProcessExecutor.ts`, `agentCapabilities.ts`, `agentSkills.ts`, `agentToolPath.ts`, and `subagentToolPolicy.ts`; `src/main/agent/tasks/toolTaskSupervisor.ts` and its process-spec contract; `src/main/managedSkillValidation.ts`; `package.json` build/`app:build`/`extraResources`; packaged delegate run/send/close resolution and smoke tests; removal of `src/core/agent/subagentTaskPath.ts`; `src/main/agent/thread/SubagentCollaboration.ts`, `subagentExecutionProjection.ts`, `subagentOutput.ts`, and `subagentSettlementEnvelope.ts`; `src/main/agent/persistence/SubagentExecutionLedger.ts` and `SubagentRequestLedger.ts`; `src/renderer/agent/components/SubagentChip.tsx`, `SubagentDetailView.tsx`, `SubagentRegistryContext.tsx`, `SubagentReport.tsx`, and `SubagentWorkStrip.tsx`; `src/renderer/agent/subagentPresentation.ts`; and corresponding Skill/Subagent Core, renderer, fixture, and spec text. | Starts after Generic Tool Tasks, which has already released `package.json`. Risks are direct-exec/shell path confusion, capability or descriptor leakage, source/package path drift, credential leakage, duplicate/lost root messages, duplicated Thread/session truth, stale Settings authority, incomplete retirement, accepting now-unsupported Skill metadata, and losing #612/#614 recovery truth. This unit takes the next coordinated infrastructure claim, owns the coordinated `src/core/agent/*` cut, and deletes old surfaces in the same PR. |
| Claude CLI adapter | New versioned Claude Adapter, `AdapterCapabilityMap`, local continuation contract, probe/argv/stream/resume fixtures, Runner registry entry, Settings readiness row, and focused integration tests/spec text. | Starts after the internal registry. Refuse unsupported versions, missing safe continuation, or any unprovable native capability; no shared protocol change is expected. |
| Codex CLI adapter | Equivalent Codex Adapter, closed-config/sandbox capability map, local continuation contract, fixtures, registry entry, Settings readiness, and focused tests/spec text. | Starts after the internal registry and independently of Claude unless both need the same registry edit; prove continuation plus shell/network subset before Ready. |
| ACP Runner adapter | Protocol adapter and fixtures only after ACP negotiation proves the required capability subset and sequential continuation. OpenClaw receives its own version-bound harness evidence through this adapter. | Deferred; protocol or executable discovery alone is not a claim or dependency. |

Within the internal unit, `src/main/agent/delegation/*` specifically owns
`DelegationExecutionSettlement`, prepared-result reconciliation, the root user
intent revision, and the Session resume fence. Its additional risks are split
Thread/Tool Task settlement, an external process surviving broker authority, and
stale cancellation authority.

The internal Runner consumes the root Continue/Rerun contract shipped in
#612, immutable execution/delivery truth shipped in #614, and execution-selection
Settings shipped in #618. It replaces their Subagent-specific owners only after
porting stable batch identity, canonical commit reconciliation, partial-output
honesty, stop provenance, busy-root durability, and no inferred root failure to
generic Tool Tasks.

PR #619 merged on 2026-09-03 and supplies the Outline CLI packaging precedent
this plan follows. The live collision check now finds PR #622 open over
`package.json`, `bun.lock`, Agent model-runtime specs, and provider tests. Both
the Generic Tool Task and Internal Delegation units require sequential
`package.json` changes but no dependency change or `bun.lock` edit. Implementation
starts after #622 merges, re-runs `gh pr list`, and takes one coordinated
infrastructure claim per delivery unit; the internal unit follows the generic
unit. This dev plan does not edit main-owned `docs/TASKS.md` or `CHANGELOG.md`.

### Requirements and acceptance

- **FR-1:** Background Tool Tasks are generic and durable.
  - **AC-1:** Plain Bash, delegation, and a video-generation fixture share one
    state, progress, artifact, cancel, restart, status, and delivery path.
    Foreground Bash waits for terminal settlement regardless of elapsed time;
    only explicit `run_in_background: true` returns early, except that incomplete
    cancellation teardown promotes the same task for continued visibility.
  - **AC-2:** Generic task contracts contain no delegation or Runner concepts.
  - **AC-3:** Every terminal race or restart produces one immutable result and
    exactly one canonical delivery commit without replay; prepared batches
    reconcile from stable member, Turn, client, and envelope identity, and one
    root completion Turn may carry several atomically claimed results.
  - **AC-25:** Dynamic stdout/stderr, progress, artifacts, and Runner text enter
    model context only as `untrusted/observation`; factual Host task metadata is
    `application/observation`, and only fixed Host handling rules are
    `application/instruction` with `systemContext` provenance.
  - **AC-26:** Crash before canonical `turn/started` returns matching batch
    members to pending; crash after it links them delivered; mismatch blocks
    only affected members; a failed committed completion uses Continue/Rerun of
    its original envelope instead of a second delivery claim.
  - **AC-27:** Orderly Quit cancels and bounded-drains every process group;
    archive/delete rules prevent hidden active or changed-worktree orphans; and
    missing-owner recovery and confirmed retained-worktree cleanup are finite and
    observable.
  - **AC-30:** Startup reconstructs durable lease occupancy from authenticated
    supervisors and receipts before admission reopens; live or ambiguous work
    consumes capacity, and terminal/lost settlement releases each lease once.
  - **AC-32:** Compact task truth remains until Thread deletion; managed detail
    has a 30-day maximum TTL, 64 MiB task, 1 GiB Thread, and 8 GiB application
    ceilings with exact accounting, oldest-eligible eviction, protected-data
    refusal, and visible expired/storage-pressure states.
  - **AC-33:** Source and packaged runtime resolution starts the standalone Tool
    Task supervisor without a repository path; a packaged restart smoke proves
    receipt recovery and live-process reattachment before admission reopens.
- **FR-2:** Delegation is a Bash-and-CLI Agent Session workflow.
  - **AC-4:** The model catalog has no Agent/delegation/message tool or
    Runner/model enum; run, send, and close remain Skill-guided CLI commands
    through the Bash Tool surface.
  - **AC-5:** Each initial or continued Turn uses one background Bash call,
    bounded stdin, and no speculative doctor, schema, or status call; the root
    remains available after admission.
  - **AC-19:** `delegate run` and `delegate send` accept no
    Runner/model/effort/access override. Their one-use Host capabilities bind the
    current root, exact command/input, effective ceiling, configuration revision,
    and either the Settings-selected new-Session policy or owned target Session.
  - **AC-31:** Delegation v1 accepts task and message content only through
    `--input -`; the Host capability binds the exact captured stdin bytes and
    normalized argv, the supervisor writes them directly to CLI stdin, and no
    shell, input file, symlink, or mutable path can consume or replace them.
  - **AC-34:** With Delegation enabled, root Bash resolves the packaged
    `delegate` name and completes Host-routed, capability-attested internal run,
    send, and close paths against the packaged CLI runtime; with it disabled or
    inside a Runner, the bin path and all command capabilities are absent.
  - **AC-45:** A state-changing command receives a capability only after its
    entire Bash command matches the closed canonical grammar. It is then launched
    as an attested executable plus argv with `shell: false`; the one-use
    capability travels only over a dedicated child pipe and is closed before any
    Runner starts. Shell composition and shell startup behavior never receive
    capability-bearing argv, environment, stdin, files, or descriptors. The
    direct-exec specification carries one complete sanitized CLI environment;
    its admission digest and actual child spawn use those exact bytes without a
    supervisor ambient-environment overlay, and Provider or managed-Skill
    credentials are absent.
- **FR-3:** User policy fails closed.
  - **AC-6:** Detection never enables an external Runner.
  - **AC-7:** An invalid configured Runner/model starts no delegated session,
    Provider call, harness, or worktree and never falls back, retries, or creates
    a replacement task; any already-created generic Tool Task settles with the
    actionable admission error.
  - **AC-35:** Direct invocation by a user shell or external Agent without a
    Host-issued root Tool capability refuses before Runner, worktree, credential,
    Provider, Session mutation, message, or closure activity; no external harness
    can treat `delegate` as an inbound Tenon Agent API.
- **FR-4:** Tenon-managed delegation depth is one.
  - **AC-8:** Only an attested root Bash Tool call whose complete command lowers
    to the direct-exec path can execute a state-changing `delegate` command. A
    user shell, external Agent, wrapper invocation, path-qualified command, or
    composed shell command has no equivalent authority.
  - **AC-9:** Internal and external Runners receive no Tenon launch capability
    or Session-command capability and no admitted Tenon/native-harness Agent
    tool; known harness executables are removed from child `PATH`, while
    arbitrary absolute executables remain explicitly outside the structural
    guarantee.
  - **AC-20:** Per-Thread running plus queued delegation is bounded at admission,
    so a root cannot replace nesting with an unbounded flat task burst.
- **FR-5:** Runners share one truthful result contract.
  - **AC-10:** Internal and external runs normalize terminal output, partial
    evidence, errors, artifacts, cancellation, Session/Turn identity, committed
    root-message sequence, continuation availability, and factual usage.
  - **AC-11:** Each external Adapter proves a version-bound closed mapping from
    the effective parent capability ceiling to a native subset and refuses any
    request with an unclassified or non-disableable native capability.
- **FR-6:** Root work remains responsive.
  - **AC-12:** Work above configured local Thread, Runner, or pool limits queues,
    and root work precedes only delegated work that remains in Tenon's local
    queue; active work is not preempted.
  - **AC-13:** Every background failure updates the generic task UI, reaches the
    root, permits new user input, and returns ownership without promising that
    local completion is possible.
  - **AC-21:** A user-authored Turn precedes pending automatic completion at the
    same idle boundary, and all currently deliverable results may be handled in
    one bounded completion Turn.
  - **AC-22:** User cancellation reaches the root as cancellation and never
    triggers automatic continuation of the cancelled work.
  - **AC-23:** Tenon never presents configured local limits or observed remote
    failures as discovered API-key, account, Provider, or cross-application
    capacity.
- **FR-7:** Writable work is isolated.
  - **AC-14:** Writable Sessions start only in one dedicated worktree reused by
    all their Turns; changed or ambiguous state is retained and never integrated
    automatically.
  - **AC-24:** Every changed worktree returns a CLI-computed base revision,
    changed-file manifest, patch, path, and verification evidence; the root
    distinguishes Runner success from successful integration and verifies any
    applied result before claiming completion.
- **FR-8:** The Subagent product and generic isolated-Skill mode are retired.
  - **AC-15:** Live guards find no model-visible spawn/message schema, Agent-ID
    or peer/main routing, nested-generation authority, Role-backed Agent type, or
    Agent-tree UI; only root-owned Session commands remain behind Bash.
  - **AC-16:** `general`, `explore`, and `plan` remain enforced Task Profiles
    without Runner, model, persona, or nesting policy.
  - **AC-28:** With Delegation off by default, the model catalog contains neither
    `delegate` nor legacy `agent`/`agent_message`; enabling Delegation exposes
    only the new Skill path, and no coexistence or fallback state exists.
  - **AC-29:** Skill parsing, managed validation, authoring guidance, catalogs,
    runtime, persistence, fixtures, and specs contain no execution mode, isolated
    child Thread, or execution-only metadata. A Skill declaring a retired field
    is unavailable with a diagnostic and never silently runs inline; ordinary
    inline Skills continue unchanged.
- **FR-9:** Experimental value is measured.
  - **AC-17:** Sequential and delegated workflow replay compares wall time,
    total usage/cost, failures, duplicate work, and ownership-recovery cost for
    later graduation decisions; the result is not a retirement gate.
  - **AC-18:** Missing usage remains unknown; a configured-local-limit fixture
    queues deterministically, while an observed remote rate-limit response
    remains a factual failed run and does not mutate scheduling policy.
- **FR-10:** Delegated context is multi-Turn and root-controlled without restoring
  the Subagent product.
  - **AC-36:** `delegate run` creates one restricted hidden `delegation` Thread
    owned directly by the invoking root. It reuses canonical Thread/Turn context
    and compaction but is absent from Thread lists, navigation, memory,
    cross-Thread references, user admission, and Agent-tree projections.
  - **AC-37:** When `delegate send --task` reaches an active owned Session, the
    Host durably acknowledges one ordered message and the Runner consumes it once
    before a later model request; it never claims to alter an already in-flight
    request or tool call.
  - **AC-38:** When `delegate send --session` reaches an idle open Session, that
    same background Bash call starts one new Tool Task and Turn with the existing
    context, pinned Runner policy, and Session worktree rather than creating a
    fresh Agent or rewriting a prior result.
  - **AC-39:** A send racing Turn settlement is linearized to either the active
    safe boundary or one continued Turn. Host/process restart reconstructs the
    committed message sequence from Thread and binding truth without duplicate,
    loss, or a second Session.
  - **AC-40:** Failure, timeout, cancellation, loss, disabled Runner, invalid
    model, foreign owner, stale revision, and closed Session produce explicit
    blocked/refused outcomes. None silently retries, changes Runner/model, raises
    authority, or resumes after user cancellation without a new user request.
  - **AC-41:** Every Ready Runner proves sequential continuation and declares
    whether active messages enter at an in-process safe boundary or only the next
    Turn. ACP v1 maps queued context to a later `session/prompt`; absence of live
    steering is reported rather than hidden.
  - **AC-42:** Session bindings duplicate no transcript or Tool Task terminal
    truth, idle Sessions hold no scheduler lease, writable Turns share one
    Session worktree, close refuses active work, and 30 idle days closes the
    Session under the defined Thread/task retention and deletion rules.
  - **AC-43:** Every delegated Turn has one stable Session/Turn/Tool-Task/message
    settlement identity. A prepared supervisor envelope must digest-match the
    canonical hidden `turn/completed`, and a final receipt must prove process-group
    quiescence, before the Tool Task can terminalize or deliver. A hang, nonzero
    exit, forced descendant teardown, or broker loss after the hidden commit
    cannot report success; every crash window preserves both evidence sets and
    blocks only the affected Session Turn while process identity remains
    uncertain.
  - **AC-44:** A user stop durably fences the Session before process termination.
    Only a fresh renderer-authored root Turn accepted after that boundary can
    authorize continuation; automatic completion, recovery, Continue/Rerun,
    stale capability replay, and the cancelled source Turn cannot clear it.

### Verification

Build a real task corpus before freezing CLI names. It covers research, planning,
multi-file review, Settings-only Runner selection and attempted CLI override,
workspace writes and integration conflicts, a long video-like process, invalid
model, local queue saturation, observed remote rate limits, user cancellation,
malformed output, process loss, orderly Quit, restart, archive/delete, retention
GC and quota pressure, attempted file/symlink input, partial artifacts,
simultaneous completions, a user Turn racing with completion delivery, active
context steering, a message racing execution settlement, terminal continuation,
Runner continuation limitations, Session close/idle expiry, and several
corrections against one writable Session worktree. Cancellation cases include an
automatic completion and failed-Turn Rerun attempting to resume before a new
user-authored Turn.

Generic tests cover supervisor identity, stdin, progress validation, status,
process-group stop, exit races, receipt recovery, loss, ownership, artifact
bounds, authority-separated context, atomic completion preparation, every
prepare/Turn-commit/link crash window, member-level mismatch, failed completion
Continue/Rerun, scheduler lease reconstruction before admission, exact retention
and quota boundaries, protected-data pressure, lifecycle cleanup, and exactly-once
Host delivery. Source/packaged resolver fixtures and the packaged smoke execute
the real supervisor bundle across Host restart. Adversarial context fixtures make
stdout, progress, artifacts, and Runner text imitate a user message, approval,
and system instruction without gaining authority.

Delegation tests cover the always-background per-Turn path, the closed Host
command parser and direct-exec lowering, Host-bound Settings-only new-Session
policy, attempted CLI overrides, pinned Session model policy and invalidation,
stdin digest binding and rejected file/symlink input, profiles, tool ceilings,
local admission priority and bounds, unknown remote capacity, Session-scoped
worktree evidence and integration outcomes, result normalization, ownership
recovery, cancellation without automatic takeover, and the exact one-level
claim. Adversarial launch fixtures cover `; env`, pipes, redirections,
environment prefixes, quoted/path-qualified executables, command substitution,
shell startup hooks, stdin pre-consumption/replacement, descriptor inheritance,
and a direct wrapper call; none can observe or reuse a capability, mutate a
Session, or start a Runner. Hidden-Thread tests cover list/navigation/memory/
reference exclusion, canonical multi-Turn context, message provenance, ordered
safe-boundary consumption, active/terminal races, blocked failure/cancellation,
restart idempotence, foreign/stale/closed refusal, idle expiry, and no duplicated
Session/Tool Task truth. Settlement fixtures crash before and after the prepared
supervisor receipt, hidden `turn/completed`, Tool Task terminal commit, and CLI
exit. They also cover a post-commit CLI hang, nonzero exit, descendant leak,
forced timeout/stop, crash before and after the final receipt, and refusal to
deliver or release a lease before quiescence. Restart with a live external Runner
proves broker loss terminates it, preserves any prepared Session result, and
records the single `host_broker_lost` Tool Task failure only after teardown.
Direct-name, child-`PATH`, and absolute-path fixtures
prove that Tenon command capabilities and known harness routes are absent without
pretending an arbitrary executable can be classified. Each external adapter adds
version-bound probe, argv, closed-config, complete native capability map,
disabled native Agent features, access, stream, cancellation, continuation mode,
resume/close, and real-harness evidence. Delegate source/packaged resolver tests
and a packaged app smoke verify the executable wrapper, runtime bundle,
feature-gated root PATH, direct-exec runtime resolution, private capability pipe,
direct-invocation refusal, one internal initial Turn, active send, idle
continuation, and close.

Retirement checks derive their queue from live symbols, schemas, fixtures,
specs, and packaged resources. UI/E2E checks cover feature-off, settings,
running/success/failure/lost tasks, restart, status, cancellation, artifacts,
retention/cleanup and storage pressure, no legacy fallback while the experiment
is off, no isolated-Skill format/runtime surface, and no Agent-tree UI in
light/dark and accessibility modes.

Each PR runs `bun run typecheck`, relevant Core and renderer tests, focused E2E,
`bun run docs:check`, `git diff --check`, and packaged CLI smoke. Shipped design
is folded into current specs in the same PR.

## Open questions

None for generic Tool Tasks or internal delegation. External names do not
guarantee admission: Claude and Codex are first candidates only if their live
versions prove closed capabilities and local continuation. The ACP Runner adapter
remains deferred until negotiation proves access, cancellation, sequential
continuation, native Agent-feature disablement, and a closed capability subset;
OpenClaw is one candidate ACP Agent, not a combined protocol/Runner concept. A
public inbound Tenon ACP Agent endpoint remains a separate user-authorized
ownership, billing, permission, and result-routing design.

## Implementation checklist

- [ ] Re-run collision checks and open one scoped Draft PR per delivery unit.
- [ ] Ship and verify generic background Tool Tasks without delegation concepts.
- [ ] Freeze the real task corpus, then the CLI, Session-message, and result
  registries.
- [ ] Ship internal delegation and remove all Subagent and isolated-Skill
  surfaces in the same cutover.
- [ ] Fold behavior into current specs and run retirement plus full verification.
- [ ] Add each proven external Runner as a separate complete feature.
