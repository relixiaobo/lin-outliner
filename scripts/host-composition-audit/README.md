# Host Composition Audit

This audit freezes the exact `src/main/**/*.ts` dependency tip used by the Host plan chain,
derives its effect inventory from the Git tree, and verifies current transport ownership.
The tracked baseline inventory and disposition ledger are generated artifacts, not
checklists.

Run from the repository root:

```sh
bun scripts/host-composition-audit/audit.ts
```

Expected completion has all transport and domain-composition queues at zero:

```text
unowned transport effects: 0
duplicate transport effects: 0
missing baseline transport effects: 0
unowned domain constructions: 0
duplicate domain constructions: 0
missing domain constructions: 0
```

Reports are written to `tmp/host-composition-audit/`. To reproduce in a GitHub
single-branch clone, fetch the PR branch normally; the pinned baseline is its
reachable ancestor. If Git omitted it, fetch the exact object before running:

```sh
git fetch origin d4ca47250598419d14b372da8861b7213cfae26b
bun scripts/host-composition-audit/audit.ts
```

Only the first Host plan creates the baseline. Successor plans extend disposition
rules and the exact domain-construction manifest against this same commit and
tree. `--write-baseline` is reserved for
reconstructing the two tracked generated files from the already pinned source; it
does not change `baseline.json`.
