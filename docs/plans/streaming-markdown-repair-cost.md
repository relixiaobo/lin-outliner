# Streaming Markdown Repair Cost

**Shape:** (a) ONE complete performance feature in one PR. The PR preserves the
current streaming Markdown output while replacing the superlinear repair stage
with an output-equivalent linear stage.

## Goal

Keep a streaming Markdown commit below a frame budget as an answer grows. The
shipped bounded-tail lexer already limits Marked work, but `remend` still scans
the complete source and repeatedly rescans preceding math context from its
italic handlers. On a representative answer containing ordinary currency and
balanced emphasis, the current path costs about 22 ms at 20 KB and 81 ms at
40 KB in `remend` alone.

The repaired text and the blocks returned by
`createStreamingMarkdownBlockParser` must remain byte-for-byte equivalent to
the existing full `remend` path after every append.

## Non-goals

- No Markdown renderer, syntax, throttling, or block-identity change.
- No relaxation of the full-repair differential oracle or existing fallback
  rules for edits, definitions, lexer failures, and unsafe token boundaries.
- No `remend` dependency fork, package patch, version change, or package/lockfile
  edit.
- No worker or asynchronous rendering protocol.

## Design

### Preserve handler order while linearizing the expensive stage

Add a renderer-local `repairStreamingMarkdown` adapter. It runs the structural
handlers that precede emphasis repair through `remend`, applies an
output-equivalent local emphasis stage with one-pass syntax context, then runs
the handlers that follow emphasis repair through `remend`. The split follows
`remend@1.3.0` handler priority, including its incomplete-link early return; the
adapter does not reinterpret CommonMark or substitute a new repair policy.

The local stage carries fenced/inline-code, math, link-URL, HTML-tag, escape,
and delimiter context while scanning. It derives the same valid marker counts
and first-marker decisions that the upstream emphasis handlers use, without
calling a prefix scanner once per marker. Bold-italic, bold,
double-underscore, single-asterisk, single-underscore, half-closer,
trailing-newline, and nested underscore-before-bold outcomes retain the
upstream order and output. Bold-italic is included because its unmatched-marker
path delegates to the same single-asterisk scan and would otherwise retain a
rarer version of the superlinear cost.

Inputs without both math and emphasis markers stay on canonical `remend`, so
ordinary prose and non-math Markdown do not pay to build the richer context.
When the local stage is needed, one context map is reused through its synthetic
closing-marker appends: those markers inherit the frozen end state and cannot
change code, math, link, or HTML context. The final underscore insertion is the
last emphasis handler and therefore needs no successor context.

`appendStreamingMarkdown` and `parseFullStreamingMarkdown` call the adapter in
place of `remend`; the existing lex boundary and fallback mechanism remain
unchanged. Full source still enters repair, but its cost becomes O(source)
rather than O(markers x preceding math context). This avoids relying on a
compact frozen-prefix summary: differential exploration found that `remend` is
not compositional at an arbitrary lexer-safe boundary because balanced earlier
markers and its code-state heuristics can still change a tail-only decision.

### Make equivalence executable

Direct adapter tests compare `repairStreamingMarkdown` with canonical `remend`
across named boundary cases, deterministic adversarial streams, and a disjoint
fragment alphabet. The fuzz records positive coverage for inputs where italic
repair changes the source, so a generator that exercises only the fast no-op
path cannot pass silently. Existing tests headed `streaming Thread Markdown
blocks` continue comparing every parser commit with full repaired lexing.

A standalone probe measures canonical `remend`, the adapter, and a warmed
`createStreamingMarkdownBlockParser` append at fixed answer sizes. It reports
medians rather than enforcing machine-dependent timing in CI. The acceptance
measurement uses the same dollar-plus-emphasis workload that reproduces the
gate profile; output equality is checked before any timing result is accepted.

### Keep the current specification authoritative

Update `agent-thread-rendering.md` to replace the superlinear full-`remend`
profile with the split repair contract and measured post-change curve. The spec
continues to state that repair sees complete source and that bounded lexing is a
separate mechanism.

## Open Questions

None. If differential coverage exposes a `remend` behavior that cannot be
reproduced without copying a materially larger part of the package, stop and
return to the PM rather than weakening equivalence.

## Verification

- `bun run typecheck`
- `bun run test:renderer`
- `bun run docs:check`
- `bun run scripts/probe-streaming-markdown-repair.ts`
- `git diff --check`
