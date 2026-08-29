# Computer Pilot Managed Skill

**Shape:** ONE complete macOS computer-use capability in one PR.

## Goal

Ship Computer Pilot as an ordinary managed Skill (`computer-pilot`) backed by
the `cu` CLI, with the Host environment, PATH, per-Turn output scope, durable
result resources, and visual observation path needed for an Agent to use it
end to end.

## Non-goals

- No new Computer Control tool family, native protocol, renderer automation
  bridge, or special Agent execution entity.
- No bypass of ordinary Skill selection, shell/process permissions, explicit
  blocks, OS accessibility consent, or capability ceilings.
- No separate screenshot/file artifact store or path-as-durable-identity model.
- No Windows/Linux support in this PR.

## Design

Add one immutable managed catalog entry following the Browser Pilot acquisition,
enable/disable, update, and integrity pattern. A
`ManagedSkillShellEnvironment` contributor supplies only the `cu` executable
PATH segment, required environment, and one execution-scoped output directory
for Turns where the Skill is active. It does not mutate global process state or
run at startup.

Computer Pilot executes through ordinary Bash/process admission. macOS TCC/
Accessibility failures remain explicit tool results with recovery guidance; the
Skill never claims permission it cannot prove. Visual results reach the model
through existing `file_read` image observation.

Completed declared outputs use the final canonical tool-Item resource contract
from `agent-result-and-file-lifecycle`; execution paths remain temporary access
handles. Fork, rollback, deletion, and cleanup follow that resource lifecycle,
not a Computer-Pilot-specific registry.

### Dependencies and collisions

`desktop-host-cutover` supplies final Agent Host/environment contributors and
`agent-result-and-file-lifecycle` supplies final durable outputs. Waiting for
both avoids building on the #582 resource shape immediately before its planned
cutover. Repeat the live Skill/Agent Host claim check before implementation.

### Verification

Packaged macOS tests cover first acquisition, disabled state, integrity failure,
PATH/environment contribution only when active, missing CLI, missing TCC consent,
one successful screenshot/visual read, declared output durability, restart,
fork/rollback/deletion cleanup, and no capability gain in constrained children.

### Acceptance criteria

- Enabling the managed Skill makes `cu` available only to eligible Turns.
- Execution still passes ordinary tool, action-block, Role, and OS permission
  checks.
- Visual output is observable through existing image reading and durable output
  uses canonical Agent resource references.
- Disable/integrity/missing-runtime states fail explicitly without global PATH
  mutation or startup work.
- No Computer-Pilot-specific tool protocol or artifact store is introduced.

## Open questions

Pin the initial `cu` acquisition/version source using the existing managed-Skill
integrity policy. The implementation must record the packaged/runtime probe and
reject a source that cannot be verified reproducibly.

## Implementation checklist

- [ ] Add the managed catalog entry and scoped environment contributor.
- [ ] Route execution through ordinary Bash/capability/TCC admission.
- [ ] Bind declared outputs to final canonical Agent resources.
- [ ] Update current Skill/tool specs and run packaged, security, lifecycle,
      docs, and end-to-end visual observation checks.
