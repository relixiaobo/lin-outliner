---
name: configuration
description: Inspect and edit Tenon's declarative configuration files when the user asks to change preferences such as theme, language, Skill/tool availability, delegation policy, or root Agent configuration; verify the addressed values reached the current Host session.
user-invocable: false
---

# Configuration

Use this Skill for durable declarative preferences only. Do not use it for
provider login, credential reveal, model connection tests, Skill installation,
memory reset, data deletion, diagnostics export, or other domain operations;
route those requests to the owning operation.

For Skills, `skill_inspect` provides live library identities, provenance, source
discovery, update previews, and supported next actions. Use `skill_manage` for
install, update, rollback, uninstall, or undoing a recorded Agent edit. Follow
the available tool schema and exact targets from inspection; do not reconstruct
private paths or copy a remembered schema. If the required tool is absent,
report that limitation instead of editing an installation index or provenance
store. Human review is owned by the operation, not an `approved` argument or
a `request_user_input` prompt.

Enable/disable and source bind/unbind remain configuration file edits, never
lifecycle commands. Installation does not change `agent.skills.disabled`: an
explicitly disabled identity stays disabled across uninstall/reinstall. A
committed installation is not proof that its instructions are invocable; report
the operation's observed availability and runtime refresh separately.

1. Read `TENON_CONFIG_DIR` (the directory containing `settings.jsonc`,
   `settings.schema.json`, and `status.json`) for application/delegation policy.
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
