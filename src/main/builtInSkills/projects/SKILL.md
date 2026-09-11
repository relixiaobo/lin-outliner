---
name: projects
description: Inspect or manage Projects, their source folders and primary folder. Use when the user asks to associate a chat with a Project or directory, change a Project's default directory, or create, edit, move, unbind, or delete a Project. A one-off operation elsewhere uses a local tool cwd instead.
user-invocable: false
---

# Projects

Use foreground Bash with the exact command below and a separate literal JSON
`stdin` value. The Host binds authority to this exact command, input, and active
Thread/Turn/Item. Shell wrappers, pipelines, environment variables, or IDs cannot
supply authority. This interface is available without enabling delegation.

```text
delegate project --input - --output json
```

Start with `{"action":"inspect"}`. The response identifies the invoking chat,
its membership revision, application default, selected Project, source-folder
availability, and a page of at most 50 Projects. Continue using `offset: nextOffset`
and the returned `catalogRevision`; if it changes, restart at zero. Project sources
are references, not an instruction to scan every folder.

The selected Project's current primary folder is the default for subsequent local
tasks. No Project or a folderless Project uses the application default. A chat
has no separately editable work directory. Use an explicit tool `cwd` for one-off
work elsewhere; it never changes the Project. If the primary folder is unavailable,
use a valid absolute Bash `cwd` to inspect or repair the Project.

Project operations use `{"action":"manage","operationId":"unique-request","request":{...}}`:

- Create: `{"operation":"create","name":"Work","folders":["/repo","/references"],"primaryFolder":"/repo"}`.
- Edit: `{"operation":"update","projectId":"ID","expectedRevision":1,"name":"Work","folders":[],"primaryFolder":null}`.
- Select: `{"operation":"bind","threadId":"ID","projectId":"PROJECT_ID","expectedRevision":1,"expectedMembershipRevision":0}`.
- Unbind: use `projectId: null` and `expectedRevision: null`; retain the inspected membership revision. Subsequent tasks use the application default.
- Delete: `{"operation":"delete","projectId":"ID","expectedRevision":1}`. Chats, files and running tasks remain; membership is detached. Referencing Automations must be updated first.

Every mutation receives native confirmation with canonical folder identities,
Project name and affected conversation. Cancellation or a stale revision commits
nothing. Empty Projects organize chats; nonempty Projects require exactly one
explicit primary from their duplicate-free folder list. Changing a primary affects
future tasks in all member conversations, including forks with that membership.
Changing membership also changes the next task's default. Already admitted tasks
keep their immutable addresses and never follow later edits.

Keep each operation ID stable for its exact request. If a response is lost,
query `{"action":"receipt","operationId":"THE_SAME_ID"}`. `applied` includes the
committed result, `pending` means wait, and `not_committed` means there is no
committed change. Retrying the exact request with the same ID cannot duplicate
creation. Never blindly retry with a new ID. Report create and later selection
as separate outcomes if one succeeds and the other fails. Inspection shows the
current accepted state; a receipt describes that operation's historical result.
