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
