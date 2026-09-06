# Settings Root Configuration

## Goal

Ship Settings Control Plane Unit C as one complete, file-first root
configuration and delegation-policy feature. Users and the built-in Agent
configuration Skill can discover, inspect, and edit the surviving root Profile,
presentation override, Runner defaults, and access policy through their owning
files and operations, with the same effective values and precedence. Existing
Threads and Agent Sessions keep their frozen snapshots.

## Non-goals

- No Settings or Configuration CLI and no universal settings setter.
- No Agent-type/Role editor, per-Agent execution namespace, or isolated-Skill
  configuration.
- No migration or compatibility reader for retired configuration shapes; invalid
  legacy fields remain rejected and pre-release userData is reset.
- No credential, Provider/model identity, Skill acquisition, Memory, Shortcut,
  or unified Settings search redesign.
- No rewriting of existing Thread/Profile or delegation Session snapshots when
  a source file changes.

## Design

### Root configuration source

Keep the existing layered sources: user root configuration at
`<userData>/agent/config.json` and project configuration at
`<cwd>/.tenon/agent.json`. Extend the configuration owner around
`AgentConfigurationLoader` and `AgentConfigurationWriter` with a bounded source
inspection/status contract and structural edits for `defaultProfile`, Profile
fields, and `presentationOverrides.main`. User values remain the base layer;
project values replace same-name Profiles and the main presentation override.
All reads use the existing strict decoder, reject retired keys, and degrade only
inspection/runtime reads at the user-path boundary. Writes validate the complete
candidate before an atomic commit and preserve unrelated source content and
comments through the JSONC syntax-tree writer.

The configuration Skill exposes source paths, schema, effective layer, and
bounded status, then edits only the addressed structural fields. It reports
accepted, applied, rejected, concurrent, or unavailable outcomes and never
handles credentials or domain operations. The native Agents surface uses the
same owner contract; it does not keep a second draft or duplicate resolved
configuration.

### Delegation policy

Move durable delegation policy fields out of the private `agent-model-state.json`
runtime snapshot and into the public settings source under `agent.delegation`:
experiment enabled state, default Runner, Runner enablement/model/effort/access,
timeouts, and global/per-root running and queued limits. Keep connection probes,
generation, active provider state, Session bindings, revisions, and in-flight
leases private to their existing owners. The decoder applies bounded defaults and
exact keys; the delegation resolver consumes one normalized settings object and
its revision, so CLI admission and the human editor cannot disagree.

An edited policy applies to future delegation admissions. A Session freezes its
resolved Runner/model/effort/access and scheduling snapshot across continuation
and restart; changing the source never mutates or silently fails over an existing
Session. Explicit unavailable Runner/model/effort/access requests reject before
process or Session creation.

### Access operations

Expose access inspection, persistent block listing, and block removal through the
existing Access owner and typed Agent operations. The configuration Skill may
discover and request these operations but cannot write private access stores as
ordinary settings. Every result is bounded, owner-authoritative, and safe for
renderer display; no access decision is inferred from a stale configuration view.

### Verification

Add loader/writer tests for layered source discovery, JSONC preservation,
concurrent/rejected writes, retired-key rejection, and effective precedence.
Add delegation tests for file round-trip, bounded normalization, revision
invalidation, future-admission behavior, frozen Session snapshots, and restart
recovery. Add renderer/Skill coverage for structural edits, status states,
delegation controls, and access inspection/block operations. Update the root
configuration, delegation, Agent integration, and configuration Skill specs in
the same change. Run typecheck, focused Core/renderer tests, docs checks, and
the relevant E2E/visual checks.

## Open questions

None. The existing root source paths and delegation/access owners are retained;
this unit only makes their public configuration and inspection boundaries
file-first and convergent.
