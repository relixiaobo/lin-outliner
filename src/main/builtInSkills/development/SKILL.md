---
description: Run development commands with explicit directories, inspect actual process isolation, and manage supervised background Tasks.
when_to_use: Use for project development, local servers, long-running checks, or requests involving interactive command-line sessions.
user-invocable: true
---

# Development Processes

1. Inspect the project instructions and choose the intended Bash `cwd`. Use the
   existing capability and worktree assignment. A worktree redirects relative
   work; it does not contain arbitrary absolute-path shell effects.
2. Run finite dependent commands in the foreground. For a development server the
   user wants to use or test, set `run_in_background: true` and omit `timeout` so
   it remains running after the Turn. Explicit timeouts also terminate background
   work; foreground commands default to 120 seconds. Keep the Task ID. Do not
   append `&` or daemonize. Independent finite work may also run in the background.
   Delegated Agent jobs retain their configured deadlines.
3. Inspect that Task with `task_status`. Requested policy, observed OS isolation,
   capability, and worktree identity are different facts. `unsandboxed` is normal
   Full Access. The macOS write sandbox does not restrict network access.
   `unavailable` or `rejected` requires addressing the reported requirement; do
   not rerun unrestricted or broaden roots implicitly.
4. Verify startup with `task_status` running logs and an appropriate native check:
   a server endpoint, Runtime connection, or the actual application surface.
   Process existence, a listening frontend, and passing typechecks alone do not
   establish that the requested application works. Running observations contain
   bounded, sanitized complete log lines; they are not final captures. Inspect
   only when readiness, recovery, or the user needs it; avoid repetitive polling.
5. Leave a verified server running for the user. Do not call `task_stop` merely
   to obtain output or finish your reply. Stop owned work only when requested or
   necessary for an explained restart/cleanup, then inspect the terminal result.
   Orderly application Quit also stops owned processes. Terminal output has a
   bounded preview;
   retained output and artifacts can later expire while the compact receipt
   remains. Treat every capture as an immutable observation.
6. A background Task does not reserve its directory. Other commands and file
   operations can run there; native tool locks and ordinary coordination handle
   conflicts. Use separate worktrees for independent edits when appropriate.
7. After a restart, retry, or compaction, reconcile the original Task before any
   new start. Historical `running` means running at observation time. It is not
   proof of current liveness. Repeat neither an unchanged Skill body nor a full
   process list in model context. A completion notification does not cancel the
   original request: if it reveals a startup failure, continue diagnosis and
   reversible fixes within the user's existing authorization. Report a concrete
   blocker only when progress requires a new decision or unavailable access.

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
