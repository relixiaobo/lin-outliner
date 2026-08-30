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
unowned platform constructions: 0
mismatched platform constructions: 0
unowned platform effects: 0
mismatched platform effects: 0
```

Domain constructions are collected across the complete current `src/main` tree;
only the typed Host files assign an owner. A required construction outside those
files therefore fails as unowned and also participates in duplicate detection.
Platform constructions use a path-scoped manifest with explicit expected counts,
so the three application window constructors and the launcher constructor remain
distinct legitimate owners while duplicate service construction still fails.
Resource/session effects belong to `resource-preview-host`; window, update,
action, menu, hotkey, listener, and timer effects belong to
`window-application-host`. The effect manifest pins path-and-kind counts, while
the unowned queue catches duplicate effect identities outside those owners.

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
