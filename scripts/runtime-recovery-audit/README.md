# Runtime Recovery Audit

This directory contains the durable driver and semantic dispositions for the
#584-to-runtime-recovery completeness audit. Run it from any repository path:

```sh
bash scripts/runtime-recovery-audit/audit.sh
```

The driver writes generated evidence to `tmp/runtime-recovery-audit/` and fails
closed if any historical responsibility, changed test body, missing assertion,
production path, document path, production wiring responsibility, or lost
snapshot overlap lacks a current disposition.

Every baseline that was lost during the rebase is reproducible without a private
branch or reflog. The driver applies compressed binary patches to reachable
rebased commits or the reachable #584 tip and verifies the original tree
identities before auditing them:

| Historical snapshot | Reachable anchor | Expected tree |
| --- | --- | --- |
| `8a1d5855` | `2722c62c` | `b57d07604e227715b3141196d7cffd7ef6ca59a0` |
| `90991b7f` | `3a4f49a2` | `daa8428f51c118a01d9e611a2182d4b305139f98` |
| `519bfd3b` | `5a280cbb` | `ddd3ceda81c4d74df0dfb88996e4fb57e08fcab1` |
| `d36dc81b` | reconstructed `519bfd3b` | `c755e9e26d8bfd4d7a62f8175d7717c923cc98cf` |

A successful run currently reports 2,307 classified responsibilities with zero
unclassified; 87/87 changed test bodies; 239/239 missing assertions across 111
groups; 17 production wiring dispositions; 87/87 production paths; 9/9 document
paths; and 26/26 lost-snapshot overlaps.
