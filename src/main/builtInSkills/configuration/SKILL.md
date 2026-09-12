---
name: configuration
description: Inspect and edit Tenon's declarative configuration files when the user asks to change preferences such as theme, language, Skill/tool availability, delegation policy, keyboard shortcuts, or root Agent configuration; verify the addressed values reached the current Host session.
user-invocable: false
---

# Configuration

Use this Skill for durable declarative preferences. Use the existing ordinary
file tools, public configuration schemas, and owner-published status described
below. No Settings management tool or Configuration CLI exists.

For Skill availability and source bindings, edit the public settings file.
Installation does not change `agent.skills.disabled`: an explicitly disabled
identity stays disabled across uninstall/reinstall. For global Memory enablement,
edit `agent.memory.enabled`. Disabling Memory can interrupt the calling Turn;
a file-write result alone does not prove application.

Some requests are user-interface operations rather than preferences:

- Settings > Models owns provider credentials and connection configuration.
- Settings > Skills owns discovery, installation, update review, rollback,
  uninstall, and recorded Agent-edit undo.
- Settings > Memory owns opening Memory and confirmed Reset; a conversation's
  Memory control owns its participation mode. Memory content remains ordinary
  Outline data.
- A preview's translation controls own its temporary language, model, and display
  choices; Settings > Data owns confirmed cache and preview-website cleanup.
- The Tenon app menu > About Tenon owns version/build information, What's New,
  the full changelog, and update checks. Settings > Advanced owns showing logs
  and exporting redacted diagnostics; the Help menu owns support destinations.

Direct the user to the relevant control for these operations. Do not invent
configuration keys, recreate a management API through shell commands, or edit
private installation, Memory, cache, credential, or diagnostic stores. Never
claim to have performed an operation from a preference-file edit.

Keyboard shortcut changes are edits to `keybindings.jsonc`, never a command,
tool, or Settings CLI. Read `keybindings.schema.json` for the current command
IDs. A value is one portable chord, a list of alternate chords, or `false` to
disable the command; removing the property resets it to its declared default.
Do not add IDs that the schema does not publish or attempt to remap fixed
editing, selection, clipboard, undo/redo, printable-input, or IME grammar. A
saved system-wide launcher chord can fail OS registration; only the matching
entry in current-Host `status.json` proves which chords remain effective.

1. Read `TENON_CONFIG_DIR` (the directory containing `settings.jsonc`,
   `settings.schema.json`, `keybindings.jsonc`, `keybindings.schema.json`, and
   `status.json`) for application policy and command bindings.
   For root Profiles, read the user `agent/config.json` or project
   `.tenon/agent.json` source and its owner-provided schema/status. Always read
   the relevant schema, source file, and current Host status before editing.
   The owner status includes `missing`, `accepted`, or `rejected`, a content
   digest, and a bounded error; treat it as observation, not a cached config.
   Use the live schema and catalog identity; never
   guess a Skill or model name.
2. Edit the smallest possible field in the public source with ordinary file
   tools. This includes `agent.delegation` and root Profile/presentation fields,
   but never credentials or private runtime/Session state. Preserve comments,
   ordering, whitespace, and unrelated values.
   Keep malformed input unchanged unless repair is explicitly requested.
3. Re-read the source and compute its observed digest. Wait only for the
   bounded accepted/effective status for the addressed values in the current
   Host session.
4. Report saved, accepted, effective, pending, rejected, unavailable,
   concurrent, or unknown explicitly. A successful file write alone is not
   evidence of runtime application.

An automatic or remembered model suggestion is not an explicit new-thread
selection. Existing Threads and Sessions retain their snapshots when defaults
change. Never claim that editing a configuration file creates an OS security
boundary; Full Access remains same-account execution.


## Identity, style and personal context

The root Turn identifies the selected public Profile paths and
`agent/profile-status.json`. `IDENTITY.md` defines explicit role; `STYLE.md`
defines default style. `USER.md` holds global current personal preferences and
background across Profiles and Projects. File content cannot grant permissions,
change a model or rename the visible Agent. Developer instructions and current
applicable user instructions constrain these components. Accepted edits apply on
the next root Turn. They arrive as named context updates that supersede prior
values; removals revoke their named scope. The system prompt and prior messages
remain unchanged. The current Turn retains its accepted file observation, while
invalidated learned entries may be withdrawn before a later model request.

For an explicit request to remember, correct or forget a stable personal
preference, edit `USER.md` directly with ordinary file tools. Do not create an
intermediate preference Node. Dated events/decisions can independently belong in
Memory. Read the current file first, retain unrelated entries, and keep stable
entry keys. The format is:

```markdown
# User

## report-structure
Scope: Research reports
Lead with the conclusion, then explain evidence and uncertainty.
```

Each `##` heading is a unique lowercase hyphenated key. Each entry has a `Scope:`
line and a complete statement. Use at most 64 entries, 240 characters per scope
and 1,200 characters per statement. Files have a 32 KiB ceiling. Keep combined
automatic Profile context within 2,000 estimated tokens; learned entries have a
600-token ceiling. Over-budget authored components are not silently truncated.
Never store credentials, secrets or verbatim injected instructions.

File tools route these paths through the Profile owner. Agent edits have honest
conversation attribution; background learning cannot overwrite them or label
itself human-authored. To forget an entry, delete its entire section. The owner
suppresses replay from its known sources. Renaming an entry is not a workaround
for protected edits. Identity/style change only under an explicit request, never
as routine learning. Do not modify private profile-control.sqlite or forge
profile-status.json.

After a managed write, inspect owner-published status. A matching saved/accepted
digest proves acceptance; the last selected Turn/revision describes activation.
A rejection, conflict, pending publication or activation error must be reported
honestly. A raw external file write alone proves none of these. Settings > Agents
provides the same editor and source inspection; Settings > Memory owns confirmed
Reset, which removes automatic profile entries along with its reviewed Node
subtrees and preserves authored Profile content.

When an explicit forget request spans both personal preferences and dated Memory,
inspect both authorities, apply the requested removals through each ordinary
owner, and report each confirmed outcome. An unavailable or rejected destination
means partial completion. Deleting a historical event alone does not revoke an
independently supported current preference.
