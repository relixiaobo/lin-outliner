# Agent Delegation

Tenon presents one root Agent to the user. Delegated work is background tool
work owned by that root, not another visible participant. The built-in
`delegate` Skill teaches the root to invoke a packaged CLI through `bash`; the
CLI binds each request to an isolated Agent Session and the generic Tool Task
runtime owns process execution, cancellation, recovery, and completion.

Delegation is experimental and disabled by default. The former Subagent tools,
Agent tree, Agent IDs, peer messaging, Role-backed Agent types, and generic
isolated-Skill execution do not coexist with it.

## Product Surface

When the experiment and configured Runner are enabled, the root may load the
built-in `delegate` Skill. The Skill exposes no new model tool. It directs the
root to use exact `delegate` commands through ordinary `bash`:

```text
delegate run --input - --output json
delegate send --task TASK_ID --input - --output json
delegate send --session SESSION_ID --input - --output json
delegate close --session SESSION_ID --output json
```

Task text travels only through `bash.stdin` as a closed JSON object. It never
appears in the command string, environment, temporary file, process list, or
capability token. Each state-changing command must use the canonical spelling
and argument order above; shell composition, aliases, redirection, wrappers,
and extra arguments run as ordinary shell commands and receive no privileged
delegation admission.

`delegate doctor`, `delegate schema`, and `delegate version` are read-only CLI
diagnostics. They do not create a Session, change policy, or prove that a future
launch will be admitted. The root user Thread receives the packaged CLI directory
and launcher metadata through its ordinary Bash environment. Delegation Threads
receive neither, which keeps nested delegation unavailable by construction.

The UI has no delegated-Agent roster, tree, chip, transcript, or navigation.
Each invocation appears as the same Bash Item and generic Tool Task row used by
any other long-running command. Completion is pushed through the Tool Task
delivery path. `task_status` is for explicit inspection or recovery, not a
polling loop; `task_stop` accepts only a Tool Task ID.

## Vocabulary And Ownership

- A **root Agent** is the only user-visible collaborator and owns synthesis,
  user communication, verification, integration, and recovery.
- An **Agent Session** is a root-owned binding to one hidden canonical Thread.
  It owns ordered input, a frozen Runner policy, continuation state, and
  settlement links. It does not own process status or another transcript.
- A **Runner** adapts one execution environment. The initial release contains
  only the internal Runner, which reuses Tenon's normal provider and tool
  kernel. External harness adapters are independent future capabilities.
- A **Task Profile** is one of `general`, `explore`, or `plan`. It describes
  intent and constrains access; it is not an Agent type, persona, model, or
  nesting policy.
- A **Tool Task** is the generic background process aggregate. It alone owns
  scheduling, process identity, output, progress, stop, timeout, terminal
  status, artifacts, and root delivery.

Tenon-managed delegation has exactly one level. A delegated Session cannot
delegate, manage Automations or Goals, request user input, inspect root Thread
history, manage Tool Tasks, or start background Bash. Arbitrary child processes
started by a Runner do not become Tenon Agent Sessions.

## Settings And Admission

Settings own all policy that can change account, cost, or authority:

- experiment enabled state;
- default Runner and per-Runner enabled state;
- model and reasoning effort, each nullable to inherit the invoking root;
- maximum access, timeout, pool, and per-Runner/pool concurrency;
- global and per-root running and queued limits.

The model cannot select a Runner, model, effort, concurrency limit, timeout, or
fallback through the CLI input. A launch snapshots the effective settings and
their revision. A changed revision invalidates an unconsumed launch capability.
The generic Tool Task admission freezes the configured global, per-root,
running, and queued limits for that invocation; queued execution retains the
same snapshot when capacity becomes available. Ordinary Bash uses the generic
defaults and does not enter a separate delegation scheduler.

The internal Runner inherits the root's provider-qualified model and effort
when its settings are null. An explicit model must resolve through the current
provider catalog, and the chosen effort must be supported. Missing credentials,
an unavailable explicit model, or an unsupported effort rejects admission
before Session creation or provider I/O. There is no silent fallback, retry,
Runner failover, or replacement Session.

`delegate run` accepts exactly:

```json
{
  "version": 1,
  "prompt": "Inspect the recovery path and report concrete risks.",
  "profile": "explore",
  "access": "read-only"
}
```

`general` may request `read-only` or `workspace-write`; `explore` and `plan`
require `read-only`. The resolved access is the narrower of the request and the
Runner's configured maximum. `delegate send` accepts only
`{"version":1,"message":"..."}`. All public input and output schemas are
closed, versioned, size-bounded, and derived from the same contract registry as
CLI help and parsing.

## Capability Boundary

The Host recognizes a canonical state-changing command only while preparing a
root-owned Bash Tool Task. It freezes the source Thread, Turn, and Item; task ID
and supervisor nonce; exact stdin digest; cwd; process digest; settings
revision; tool-ceiling digest; scheduling-policy digest; Runner/model/access
policy; and Session admission precondition.

The Host then issues a short-lived, single-use capability over a private file
descriptor. The capability contains an opaque bearer token and the private
broker socket path, but no prompt or provider credential. The direct-exec child
receives only an allow-listed process environment. The broker socket is created
under the app's private data directory with owner-only permissions.

The local broker consumes the capability before executing the request. It
rejects unknown, expired, reused, modified, revision-stale, or command-mismatched
capabilities. Expired records are pruned on issuance and consumption; launch
failure or task cancellation explicitly revokes any unconsumed capability.
Stopping the Host clears all capabilities, aborts active broker requests,
destroys connections, and removes the socket.

## Session And Thread Lifecycle

`delegate run` preallocates one UUIDv7 Session ID, creates the Session binding,
and ensures one canonical Thread with `threadSource: "delegation"`. That Thread
uses its Session ID and records the root as `parentThreadId`, but the relationship
is ownership only, not a navigable Agent tree.

Delegation Threads are absent from root Thread lists, navigation, user-created
resume/fork/delete flows, cross-Thread search and explicit reference resolution,
Memory eligibility, Automation continuity, and renderer projections and
notifications. Only privileged Host methods may create, start, interrupt, read,
or close them. Their Turns use feature provenance for `delegation`; they never
synthesize reader-authored input or the retired Agent author kind.

The internal Runner executes each delegated Turn through the same
`PiTurnExecutor`, provider gateway, canonical context projector, Item recording,
tool runtime, compaction, transcript, and diagnostics as an ordinary Thread.
The Session freezes the resolved model, effort, profile, access, and Runner
identity across continuation. Changing the default Runner affects only new
Sessions. Every `send` revalidates the Session's frozen Runner identity, version,
model, and effort against live availability, and rejects without fallback when
they are no longer runnable. Current timeout and scheduling limits come from that
same Session Runner at each command admission. `close` does not require its
Runner or model to remain runnable.

A `workspace-write` Session durably records a planned Host-managed worktree
intent before creation, then records the complete admitted worktree identity.
The hidden Thread's cwd and writable sandbox boundary are that worktree; the
source checkout remains unchanged. Every terminal Turn independently inspects
the current tree against its frozen base revision. Tracked and untracked files
become a binary patch resource owned by the root Thread, a changed-file
manifest, and a generic Tool Task artifact. Ignored content and nested Git
repositories fail inspection because they cannot be represented by complete
patch evidence.

`delegate close` succeeds only for an idle, open, root-owned Session. It closes
the binding and hidden Thread, but does not stop active work, erase a Tool Task,
or integrate files. An unchanged managed worktree is removed on close. A
changed worktree is retained, while uncertain creation, recovery, or inspection
is recorded as ambiguous and retained for explicit resolution.

## Ordered Messages And Continuation

Each root message has a stable ID, monotonically increasing sequence, rolling
prefix digest, source Tool Task/Turn/Item, optional root-intent revision, and one
of `queued`, `committed`, or `blocked`.

Sending to an active Session durably queues the message and returns a receipt.
The internal Runner does not claim that an in-flight provider request or tool
call accepted it. A later explicit `delegate send` execution consumes the
ordered queued prefix at a Turn boundary. Sending by Tool Task resolves the
Session from the task's settlement; sending by Session ID continues a settled
Session without creating a duplicate.

Admission uses expected Session revisions and a user-stop resume fence. A stale
revision, wrong owner, closed Session, blocked settlement, or insufficient new
root intent rejects without starting a Turn. Message bytes remain available
only while queued; after commit or block the store retains identity, sequence,
digests, provenance, and disposition rather than a second transcript copy.

## Settlement And Failure

One settlement links one Session Turn to one Tool Task. It records request and
message-prefix digests, prepared-result and final-receipt digests, and the
states `awaiting_result`, `prepared`, `context_committed`, `committed`, or
`blocked`. The canonical Thread remains the transcript authority and the Tool
Task remains process authority.

The Runner result is prepared into the Tool Task before process exit. A result
can be committed only after the supervisor's quiescent final receipt matches
the prepared digest and the canonical Turn is terminal. Reconciliation is
idempotent: matching evidence advances the same settlement, while mismatched or
incomplete identity/digest evidence blocks it rather than fabricating success.

Only `succeeded` leaves queued input eligible for a later explicit continuation.
`failed`, `timed_out`, `cancelled`, and `lost` block every uncommitted message
before releasing the active execution and waking senders. A failed execution
therefore cannot automatically consume queued input or start another Turn.
Verified partial text remains evidence but never changes the terminal outcome.

There is no automatic retry. After non-user failure the root may inspect the
result and either take over locally or explicitly continue when the Session is
safe. After user stop, a fence requires a later root intent revision before
continuation; stale queued messages are blocked. Cancellation aborts the active
delegated Turn and the owning Tool Task still settles through generic process
teardown.

## Tool Policy

A delegated Session starts from the root's effective canonical tool ceiling and
narrows it with its frozen profile/access policy. Root-scoped tools and these
actions are always absent: user input, Goal create/read/update, Automation
management, background process start, task inspect/stop, and Thread-history
search/read.

Session-local plan updates and inline Skill invocation may remain. A writable
`general` Session may use other admitted tools within the inherited ceiling.
Read-only Sessions retain only read-only actions; Bash is reclassified at every
execution and rejects unknown or mutating behavior before spawn. Delegated Bash
is always foreground. No Skill can widen the effective tool ceiling.

## Persistence And Recovery

`delegation.sqlite` stores only Session bindings, ordered root-message control
records, and cross-aggregate settlement facts. It is not a transcript or task
ledger. Foreign keys bind messages and settlements to Sessions; revisions and
unique identities make replay idempotent.

Startup reconciliation compares Session settlement state, prepared Tool Task
results, final supervisor receipts, and canonical Turns. It never replays a
command. Exact matching evidence resumes commit; known process loss becomes a
factual terminal outcome; ambiguity or digest mismatch blocks the affected
settlement and preserves evidence for recovery.

Startup also revalidates every open Session and closes an idle Session after 30
days without an active Tool Task or queued root message. One failed recovery is
reported and deferred without blocking the rest of Agent startup.

Archiving a root refuses blocking Tool Tasks and closes its idle Sessions.
Deleting a root first refuses active or queued Session work, proves each
managed worktree clean, and closes only Sessions admitted for deletion. A
changed, retained, or ambiguous worktree keeps its Session and owner root
intact. Only after admission succeeds does deletion remove owned delegation
Threads, Session control state, Tool Tasks, transcripts, and resources through
their existing owners. Fresh pre-release data has no compatibility reader for
the retired Subagent ledgers or isolated-Skill child records.

## Retirement Boundary

The canonical model catalog contains no `agent` or `agent_message`. `task_stop`
has no Agent-ID or deprecated shell-ID route. Configuration contains root
Profiles and main-conversation presentation only; it contains no Roles, Agent
types, per-Agent execution selection, nesting depth/concurrency, or Subagent
token budget.

Skills are inline instruction packages. `execution`, `allowed-tools`, `model`,
`effort`, `shell`, and embedded-shell execution metadata are rejected by local
and managed Skill validation; unsupported Skills are unavailable with a
diagnostic and never silently run inline.

Canonical Thread/Turn/Item, provider, tool, transcript, resource, worktree,
Automation, Memory, and generic Tool Task primitives remain. Delegation reuses
them without restoring legacy Agent identity, routing, ledgers, or UI.

## Verification

Coverage must prove:

- exact CLI parsing, JSON schemas, text/JSON output, source and packaged runtime
  resolution, and packaged smoke execution;
- production composition starts/stops the broker, closes its store, injects the
  exact Bash runtime, and hides delegation when the experiment is off;
- capability single use, expiry pruning, explicit revocation, process/env
  binding, changed-settings refusal, and broker teardown;
- explicit-model and effort refusal with no fallback;
- one hidden Thread per Session, ordered send/continue/close, root ownership,
  user-stop fencing, and restart reconciliation;
- failed, timed-out, cancelled, and lost outcomes block queued input and never
  trigger continuation;
- delegated tool/access ceilings and the absence of nested delegation;
- generic Tool Task completion, status, stop, recovery, and renderer behavior;
  and
- residue guards for every retired schema, field, store, route, UI component,
  configuration key, Skill execution field, and current spec term.
