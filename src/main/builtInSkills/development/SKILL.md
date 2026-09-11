---
description: Run development commands with explicit directories, inspect actual process isolation, and manage supervised background Tasks.
when_to_use: Use for project development, local servers, long-running checks, or requests involving interactive command-line sessions.
user-invocable: true
---

# Development Processes

Every `task_control` call wraps its action fields inside `request`, for example
`{"request":{"task_id":"<task>","operation_id":"<operation>","action":"acknowledge","event_id":"<event>"}}`.
Only include fields allowed by that action. `acknowledge` has no
`expected_revision`; changing an operation ID does not fix invalid arguments.

A request to start an application means its required frontend and backend must
work together, unless the person explicitly requests only one component.
"Do not start or repair the backend" forbids backend lifecycle changes; it does
not waive read-only verification. Do not redefine the request as frontend-only
to avoid a failed or unverified dependency. If verification itself is prohibited,
report that limitation and leave the application unverified.

Keeping the frontend running does **not** require handoff. If a required backend
check fails or remains unavailable, do **not** call `task_control` with
`action: "handoff"` for this application, even when the person asks to leave the
frontend running. Keep the current process and unfinished launch responsibility,
and report partial startup. Do not select only the successful frontend Item to
bypass failed application verification.

1. Inspect the project instructions and choose the intended Bash `cwd`. Use the
   conversation default, capability and worktree assignment. Always pass the
   intended explicit `cwd` for launch: shell `cd` does not change the Host
   admission directory. A worktree redirects relative
   work; it does not contain arbitrary absolute-path shell effects.
2. Run finite dependent commands in the foreground. Independent finite jobs may
   use `run_in_background: true`; omitted `completion_agreement` means they still
   owe a result. For an application or server the user wants to use, explicitly
   set `completion_agreement: {"kind":"service"}` with `run_in_background: true`.
   Omit `timeout` to leave it running; explicit timeouts terminate background work.
   Keep its Task ID and launch `evidence` reference. Never daemonize or append `&`.
3. Inspect the Task with `task_status`. Requested policy, observed OS isolation,
   capability, and worktree identity are different facts. `unsandboxed` is normal
   Full Access. The macOS write sandbox does not restrict network access.
   `unavailable` or `rejected` requires addressing the reported requirement; do
   not rerun unrestricted or broaden roots implicitly.
4. Verify the behavior the person requested with a completed application check.
   Address the exact running application's isolated root and advertised endpoint;
   the Agent Host's default Runtime or another healthy clone cannot verify it.
   Running logs, process existence, a listening frontend, and typechecks alone do
   not establish usable startup. For Tenon, use its installed `outline` CLI with
   explicit `TENON_OUTLINE_RUNTIME_ROOT=<target-userData>/outline-runtime`
   and `TENON_CONTENT_ROOT=<target-userData>/content`, plus `--no-start`:
   inspect `status`, then `get @library --depth 0` (or the requested exact Node)
   to prove that this document Runtime serves content.
   Check both command success and returned application data; a stopped status is
   a limitation, not a healthy workspace. Read the project's root convention
   first. Do not let inspection start, repair or redirect the target Runtime.
   For a bounded Tenon document check use
   `TENON_OUTLINE_RUNTIME_ROOT="<target-userData>/outline-runtime" TENON_CONTENT_ROOT="<target-userData>/content" outline --no-start --json get @library --depth 0`.
   Inspect its application result; do not mask failures with a pipeline to `head`.
   Preserve the advertised hostname/address family: an IPv4 refusal while the
   service listens on IPv6 is not evidence of a crash. Quote the full URL,
   including IPv6 brackets, when passing it to the shell. Do not broaden listeners.
   A Bash check may use a different independently authorized `cwd`, including
   after the conversation default changes. It still checks the original service;
   neither handoff nor a folder edit redirects an existing process or grants new
   permissions. Retain its returned `evidence` Item reference. Bound checks;
   avoid blind sleeps and unchanged retries. If the frontend is healthy but the
   Runtime or workspace fails, report partial startup and the concrete error,
   preserve available evidence, and leave launch responsibility unfinished.
5. Before reporting availability, call `task_control` with `action: "handoff"`,
   the exact `task_id`, a fresh `operation_id`, current `expected_revision` from
   `task_status.continuation`, and `readiness: [evidence]` from completed successful
   checks after launch. Check the receipt's status. Handoff keeps the process,
   output, isolation, and Stop ownership, and ends only the launch responsibility.
   It does not end a watch. A later exit of an unwatched handed-over service is
   silent, including nonzero or uncertain exits; do not start unsolicited repair.
6. Watch only when explicitly requested. At launch, add
   `watchRequest: "current_request"` to the service agreement to bind that reader
   request. To watch an already live service, obtain the exact reader
   `requestReference` from `task_status`, then call `task_control` with
   `action: "start_watch"`, `request`, and the current revision. Retain its returned
   `watchId`. To stop watching while keeping it running, use `action: "revoke_watch"`
   with that `watch_id` and revision. A later watch requires a newer explicit
   reader request. A watch grants no periodic polling or extra permissions.
7. When an active Turn inspects and handles a terminal result, call `task_control`
   with `action: "acknowledge"` and the exact `event_id` from
   `task_status.continuation.event` before finishing the response. Acceptance binds
   that result to this Turn; it does not claim success or user receipt. A failed
   or interrupted handling Turn retains that ownership through ordinary recovery.
   An event already admitted to a completion Turn keeps its existing handler.
8. Every control call includes an operation ID. After an uncertain reply, inspect
   `task_status` with that `operation_id`; retry identical input under the same ID.
   Reusing an ID for different input rejects. A conflict returns bounded current
   facts; reread before making a new decision. Old watch retries never restore or
   cancel another watch. Status reads and natural-language replies do not mutate
   responsibility. At most 256 distinct control receipts are retained per Task;
   existing receipts remain replayable at that bound.
9. Use `task_stop` only for authorized process Stop or necessary explained cleanup,
   not to finish a reply, collect output, or stop watching. Stop revokes pending
   responsibilities even if exit already occurred, without stealing an admitted
   handling Turn. Orderly application Quit also stops live owned processes.
   Exit code, signal, known Stop source, and earlier stderr are separate facts;
   an external application's close initiator may be unknown. Logs do not prove it.
10. A background Task does not reserve its directory. Use ordinary coordination
    and separate worktrees where appropriate. Reconcile the original Task after
    restart or compaction before any new launch. Retained output can expire while
    compact ownership and receipts remain. Finite results, unfinished launches,
    and explicit watches continue within their recorded request; events do not
    grant restart, replacement, or broader authority on their own.
11. For an explicitly authorized reset, retain available stderr, startup failures
    and exact target/root identity before deletion. Stop the target through its
    owner. Managed Skill contents are intentionally read-only; use their existing
    lifecycle cleanup owner when available. If the authorized whole-data deletion
    requires permission repair, restrict it to that exact disposable tree, never
    shared/global Skill sources. Verify removal with `test ! -e <exact-path>`,
    not `ls` of the removed directory. Successful deletion is not proof of repair;
    repeat the application check after the authorized restart.

## Interactive tmux Experiment

tmux is an optional external dependency, not a bundled terminal capability.
Check its availability; do not silently install or substitute another daemon.
The measured macOS workflow is **not a supported persistent terminal**:

- Default detached tmux outlives its completed Task and is not stopped by stopping
  that Task.
- A foreground `tmux -D` server can be owned by a Task. Same-directory control
  commands are admitted independently; that does not confer ownership of panes.
- Terminal pane contents are not the server Task's stdout. Only explicit
  `capture-pane` calls create retained Tool Task output.
- The required macOS write profile rejects pane creation in the measured build.
  Do not relax the sandbox or use an unrestricted server to bypass this failure.

For an explicitly requested diagnostic experiment, use a private socket and a
session name derived from the owner Thread, canonical execution directory, and
worktree identity. Record them with the owning Task. Set `new-session -c` explicitly;
tmux clients can otherwise change the pane's starting directory. Client commands
use `-N -S <private socket>` so a missing server cannot be implicitly restarted.
Check the exact existing session before creation; a duplicate name is a refusal.
Capture a bounded tail (`capture-pane -p -S -20`) and respect the output budget.
Stop and verify only this experiment's server and panes. Never attach to, kill,
or adopt an unrelated user's tmux server. The repository probe records failures
as well as successes; these limitations require a separate design before any
native persistent-session feature.
