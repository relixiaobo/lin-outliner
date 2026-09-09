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
