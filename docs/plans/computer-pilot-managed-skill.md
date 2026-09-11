# Computer Pilot Managed Skill

**Shape:** ONE complete macOS computer-use capability in one PR.

## Goal

Ship Computer Pilot as an ordinary managed Skill (`computer-pilot`) backed by
the `cu` CLI, with the Host environment, PATH, per-execution output scope, durable
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

**FR-1 — Managed acquisition and availability.** Add one pinned managed catalog
entry following `DEFAULT_MANAGED_SKILLS` and the current Browser Pilot acquisition,
update and integrity owners. Availability is
the current file-backed Skill/tool configuration plus lifecycle admission, not a
new persisted enabled field on a managed-Skill record.

**FR-2 — Admitted execution and isolated outputs.** Use
`ManagedSkillShellEnvironmentRegistry` and its existing contributor contract
for the `cu` PATH segment, required environment and declared output root. Its
current Host callback resolves eligible managed roots in a Skill-capable Turn;
eligibility is not proof that the model explicitly loaded that particular Skill.
Preserve that existing admission meaning rather than inventing a new usage gate.
The contribution creates one output directory per exact Thread/Turn/execution
identity, as `BrowserPilotHost.processEnvironment` already does. Concurrent Bash
Items cannot share a writable screenshot directory or collect each other's
outputs. It does not mutate global process state or run at startup.

Skill-content integrity and executable acquisition are separate facts. Pin and
verify the CLI artifact/install mechanism as well as the initial Skill commit;
having a readable SKILL.md or an arbitrary `cu` on ambient PATH does not prove the
managed executable is ready. Missing or invalid CLI state returns the existing
bounded recovery route without weakening shell or OS admission.

Computer Pilot executes through ordinary Bash/process admission. macOS TCC/
Accessibility failures remain explicit tool results with recovery guidance; the
Skill never claims permission it cannot prove. Visual results reach the model
through existing `file_read` image observation.

**FR-3 — Durable visual results.** Completed declared outputs use the final
canonical tool-Item resource contract from `agent-result-and-file-lifecycle`;
execution paths remain temporary access
handles. Fork, rollback, deletion, and cleanup follow that resource lifecycle,
not a Computer-Pilot-specific registry.

Image observations preserve the captured screenshot pixels after canonical
resource adoption, including when the stored source uses a `.blob` filename.
Use the common bounded image normalization boundary defined in
[Agent Image Evidence and Service Readiness](agent-evidence-and-service-readiness.md);
do not substitute an OS file icon or add a Computer-Pilot-specific decoder.
Source/observation geometry must describe the actual image used by the model.

### Dependencies and collisions

Consume the Host/environment and canonical Agent resource contracts delivered
in #603/#607, plus the current file-backed Skill availability and lifecycle owners
from #640/#643/#644/#656. Repeat the live Skill/Agent Host claim check, including
record publication/resource changes, before implementation; no retired Role,
isolated-Skill or Settings-management-tool surface is restored.

### Verification

Packaged macOS tests cover first acquisition, disabled state, integrity failure,
PATH/environment contribution only when active, missing CLI, missing TCC consent,
one successful screenshot/visual read, declared output durability, restart,
fork/rollback/deletion cleanup, and no capability gain in constrained children.
The visual fixture contains distinguishable content and checks the actual
provider-bound observation after resource adoption and reopening. A nonempty
image, valid dimensions or successful CLI exit alone does not establish visual
fidelity. CLI/acquisition preparation can proceed independently; final visual
acceptance consumes the shared pixel normalization rather than duplicating it.

### Acceptance criteria

- **AC-1:** Enabling the managed Skill makes `cu` available only to eligible Turns.
- **AC-2:** Execution still passes current tool/action capability, effective Thread
  configuration, delegated ceilings and OS permission checks.
- **AC-3:** Visual output is observable through existing image reading and durable output
  uses canonical Agent resource references. A marked screenshot remains recognizable
  after `.blob` storage, reopening and provider projection, with the correct
  observation-to-source geometry; a generic file icon cannot pass this criterion.
- **AC-4:** Disable/integrity/missing-runtime states fail explicitly without global PATH
  mutation or startup work.
- **AC-5:** No Computer-Pilot-specific tool protocol or artifact store is introduced.
- **AC-6:** Concurrent Bash Items in one Turn receive distinct declared output roots;
  output adoption and cleanup retain the exact Item's canonical resource identity.
- **AC-7:** Skill installation alone cannot claim CLI readiness; both pinned acquisition
  and the admitted executable are verified, including missing/invalid cases.

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
