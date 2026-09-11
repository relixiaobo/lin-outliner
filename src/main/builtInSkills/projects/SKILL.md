---
name: projects
description: Inspect or manage Projects, their source folders, and a conversation's durable work folder. Use when the user asks to associate a chat with a directory, change where future work defaults, organize chats into a Project, or create, edit, move, unbind, or delete a Project. A one-off operation elsewhere uses a local tool cwd instead.
user-invocable: false
---

# Projects and Work Folders

Use foreground Bash with the exact command below and a separate literal JSON
`stdin` value. The Host binds authority to this exact command, input, and active
Thread/Turn/Item. Shell wrappers, pipelines, environment variables, or IDs cannot
supply authority. This interface is available without enabling delegation.

```text
delegate project --input - --output json
```

Start with `{"action":"inspect"}`. The response identifies the invoking chat,
its membership and work-folder revisions, application default, selected Project,
source-folder availability, and a page of at most 50 Projects. Continue using
`offset: nextOffset` and the returned `catalogRevision`; if it changes, restart
at zero. Project sources are references, not an instruction to scan every folder.

To change the saved default on explicit user instruction, send:

```json
{"action":"manage","operationId":"unique-setting-request","request":{"operation":"setWorkFolder","threadId":"ID_FROM_INSPECT","path":"/absolute/existing/folder","expectedRevision":0}}
```

Use the inspected work-folder revision, not a guessed zero. `path: null` clears
the saved folder to the application default even when Project membership remains.
No extra confirmation is needed for this explicit setting change. If the saved
folder is unavailable, use a valid explicit Bash `cwd` (for example the inspected
application default) to execute the repair command.

Project operations use the same `manage` envelope and a fresh `operationId`:

- Create: `{"operation":"create","name":"Work","folders":["/repo","/references"],"primaryFolder":"/repo"}`.
- Edit: `{"operation":"update","projectId":"ID","expectedRevision":1,"name":"Work","folders":[],"primaryFolder":null}`.
- Membership only: `{"operation":"bind","threadId":"ID","projectId":"PROJECT_ID","expectedRevision":1,"expectedMembershipRevision":0}`.
- Membership plus an explicitly requested default: add `"workFolder":{"path":"/repo","expectedRevision":0}` to the bind request. Both settings commit atomically. Use the selected Project's inspected primary folder when the user asks to work there.
- Unbind: use `projectId: null` and `expectedRevision: null`; retain the inspected membership revision. The saved folder stays unchanged.
- Delete: `{"operation":"delete","projectId":"ID","expectedRevision":1}`. Chats, files, tasks, and their folder settings remain. Referencing Automations must be updated first.

Project proposals receive native confirmation with canonical folder identities,
Project name and affected conversation. Cancellation or a stale revision commits
nothing. Empty Projects organize chats; nonempty Projects require exactly one
explicit primary from their duplicate-free folder list. Changing a Project never
redirects existing conversations or already admitted tasks. A new chat in a
Project copies its primary folder; forks copy their parent's saved folder.

Keep each operation ID stable for its exact request. If a response is lost,
query `{"action":"receipt","operationId":"THE_SAME_ID"}`. `applied` includes the
committed result, `pending` means wait, and `not_committed` means there is no
committed change. Retrying the exact request with the same ID cannot duplicate
creation. Never blindly retry with a new ID. Report create and later selection
as separate outcomes if one succeeds and the other fails. Inspection shows the
current accepted state; a receipt describes that operation's historical result.
