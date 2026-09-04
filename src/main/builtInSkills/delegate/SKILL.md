---
name: delegate
description: Delegate an independent task to another internal or external Agent and return its result to the current Agent. Use for substantial work that benefits from parallel execution or a fresh context; do not use for a small known lookup or work whose understanding must remain in the current context.
user-invocable: false
---

# Delegate

Delegate only a substantial, independently specifiable task. Keep final
synthesis, user communication, verification, and integration in the current
Agent.

Start every delegated Turn through background Bash. Pass the request as literal
JSON in Bash's separate `stdin` field; do not put task text in the command or a
temporary file.

```text
delegate run --input - --output json
```

```json
{
  "version": 1,
  "prompt": "Inspect the recovery path and report concrete correctness risks.",
  "profile": "explore",
  "access": "read-only"
}
```

Profiles are `general`, `explore`, and `plan`. `explore` and `plan` are
read-only. Use `workspace-write` only with `general` and only when isolated
changes are necessary.

- Set `run_in_background: true` for every delegated execution and return control
  immediately. Completion is pushed; do not poll with `task_status`.
- Use only the Runner and model policy selected in Settings. Never add an
  override to the command or input. If the user requests another Runner, explain
  that the default must be changed first.
- Do not repeat delegated work locally while it is running. Create only the few
  independent tasks allowed by the current Thread's configured outstanding-work
  limit.
- When new context materially changes active work, send it to the existing task:

```text
delegate send --task TASK_ID --input - --output json
```

  Pass `{"version":1,"message":"..."}` through Bash `stdin`. After an
  execution settles, continue its returned Session with `delegate send
  --session SESSION_ID --input - --output json` instead of creating a duplicate
  Session.
- After a non-user-initiated failure, preserve verified evidence and take
  ownership of the unfinished task. Continue the same Session or work locally
  only when that is safe; never retry or create a replacement Session
  automatically.
- After user cancellation, acknowledge the cancellation and do not continue the
  work without a new user request.
- Close an idle Session with `delegate close --session SESSION_ID --output json`
  after its result and any retained worktree have been resolved. Closing does not
  stop active work or integrate files.

Do not run `delegate doctor` or `delegate schema` as speculative preflight. Use
them only to diagnose an actual admission or validation failure.
