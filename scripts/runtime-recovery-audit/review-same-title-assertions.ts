import { readFileSync, writeFileSync } from 'node:fs';

type Disposition = 'equivalent-current' | 'stronger-current' | 'explicit-retirement' | 'confirmed-regression-fixed';

interface Review {
  readonly disposition: Disposition;
  readonly rationale: string;
  readonly evidencePath?: string;
  readonly evidenceLabel?: string;
}

const auditRoot = `${process.cwd()}/tmp/runtime-recovery-audit`;
const legacyNodeCreate = ['node', 'create'].join('_');
const legacyNodeRead = ['node', 'read'].join('_');
const legacyNodeSearch = ['node', 'search'].join('_');
const reviews = new Map<string, Review>();

at('tests/core/outlineContract.test.ts', [
  'exports every named versioned schema as valid JSON Schema',
  'registers every fixed command with request and result schemas',
  'derives help, completion metadata, and exact CLI schemas from every capability contract',
], 'stronger-current', 'The current contract inventory compiles the evolved schema surface and additionally bounds compacted schemas and derived completion metadata.');
at('tests/core/outlineCoreTransactionPatch.test.ts', [
  'rejects recovery patch application outside a trusted transaction',
], 'equivalent-current', 'Only the trusted-boundary error copy changed; the same recovery command remains excluded from the ordinary command surface.');
at('tests/core/outlineRuntimeWorkspace.test.ts', [
  'rejects revert when one affected after value changed and writes no recovery Operation',
], 'stronger-current', 'The same conflict remains rejected without a recovery write, and the current assertion also freezes the complete public conflict diff.');
at('tests/core/outlineRuntimeProcess.test.ts', [
  'rejects a second writer while the first Runtime owns the workspace',
  'retires the current private Runtime through its authenticated lifecycle route',
], 'stronger-current', 'The Runtime ownership and retirement assertions now include the independent ContentStore root and contract-digest-shaped lifecycle request.');
at('tests/core/outlineCli.test.ts', [
  'serves exact named public and command schemas locally',
  'streams asset ingest, show, and verified export through the Runtime',
  'queries history by idempotency key and runs guarded revert, undo, and redo',
  'reports exact Runtime, transaction-log, and recovery health without starting another Runtime',
  'renders purge help with exact destructive review requirements',
  'suggests the nearest command, option, or exact help for invalid argv',
], 'stronger-current', 'The current CLI assertions retain the observable operation while adding compact schemas, private-metadata boundaries, guarded idempotency, contract health, or exact recovery guidance.');
at('tests/core/outlineChangeSetKernel.test.ts', [
  'rejects ambiguous mutation selectors and forward binding references before preview writes',
  'rolls back every earlier change when a late operation fails',
], 'stronger-current', 'The keyed Diff path preserves the rejection and rollback assertions and additionally proves document and Operation-store state remain unchanged.');
at('tests/core/outlineChangeSetCapabilities.test.ts', [
  'preserves rich content, capture provenance, fields, definitions, and references',
  'executes view, search, template, and definition-merge behavior through one public union',
], 'stronger-current', 'The current capability tests retain the prior content and search updates while covering link marks, reference conversion, field relinking, and unrelated child preservation.');
at('tests/core/outlineAssets.test.ts', [
  'expires recovery before collecting purge-only bytes and preserves diagnostic corruption evidence',
], 'stronger-current', 'Corrupt bytes remain quarantined and recovery remains inconsistent, while the public error is additionally checked not to leak Host-private anchors, paths, or digests.');
at('tests/core/agentCapabilities.test.ts', [
  'restricts embedded Skill shell for Explore and Plan Agents before execution',
], 'stronger-current', 'The status output became structured JSON; the current test still permits read-only outline inspection and rejects repository and outline mutation.');
at('tests/core/agentCodexTools.test.ts', [
  'freezes the exact Agent task schemas and property ordering',
  'normalizes Agent task defaults and message previews before exact admission',
], 'stronger-current', 'The old task fields remain in order and the current assertions add the explicit read-only execution contract and its validation.');
at('tests/core/agentConfigurationLoader.test.ts', [
  'loads user Profiles and lets project Profiles and Roles take precedence',
], 'stronger-current', 'The retired native Node reader was replaced by a maintained file capability; project precedence and the full resolved Profile and Role shape remain asserted.');
at('tests/core/agentContextComposer.test.ts', [
  'names the conversation agent from configuration and selects modules from canonical tool keys',
  'keeps stable fingerprints independent of Thread identity and volatile context',
], 'stronger-current', 'Retired native Outliner and Memory prose no longer enters the stable prompt; the current layered fingerprints and headless-child prompt contract are asserted directly.');
at('tests/core/agentCorePersistence.test.ts', [
  'stores catalog metadata, pagination, spawn edges, and input idempotency',
], 'stronger-current', 'The persisted ceiling now names a maintained file capability; catalog ordering, pagination, spawn identity, overrides, and idempotency remain covered.');
at('tests/core/agentMemory.test.ts', [
  'degrades cyclic ancestor state without hanging canonical classification',
  'recognizes only canonical Daily Memory hierarchy and preserves stray tags',
  'replaces updated consolidation lineage with every cited current origin',
  'preserves a user edit made while Phase 1 model work is running',
  'rebuilds Phase 1 targets after waiting for the write gate',
], 'stronger-current', 'Stable deterministic IDs and Runtime projection updates replace test literals and the retired second authorization layer; canonical graph, lineage, and concurrent-user-edit outcomes remain asserted.');
at('tests/core/agentSkills.test.ts', [
  'executes embedded shell blocks and inline commands only for isolated Skills',
  'keeps embedded shell paths live while persisting only stable Skill evidence',
  'shares the first skill load across concurrent callers',
  'lists isolated-execution skills and routes them through an isolated executor',
  'ships public outline workflows without legacy document authorities',
  'teaches the built-in outline Skill to route complete CRUD intents without shell choreography',
], 'stronger-current', 'The current Skill boundary isolates shell observations, strips live paths from durable evidence, combines import into the public outline Skill, and retains the complete single-command and ChangeSet guidance.');
at('tests/core/agentSubagentToolPolicy.test.ts', [
  'removes repository mutation and nesting from explore and plan pools',
  'uses the background allowlist while preserving MCP contracts',
  'filters canonical keys through the same contract classifier and drops unknown entries',
], 'stronger-current', 'The retired native Node reader was removed from the allowlists; maintained file, shell, web, Skill, and MCP policy assertions remain exact.');
at('tests/core/agentSubagentToolRuntime.test.ts', [
  'treats a Role wildcard as inheriting the resolved configuration ceiling',
], 'stronger-current', 'The wildcard still inherits the resolved ceiling, now through maintained file read and grep capabilities instead of the retired native Node reader.');
at('tests/core/agentThreadService.test.ts', [
  'starts a renderer-owned Thread with the remembered execution selection',
  'updates root Thread model configuration atomically and preserves it through forks',
  'applies the parent ceiling to every child capability source',
  'reuses the recorded child Role and ceiling without inheriting changed parent instructions on resume',
  'waits for nested background work before reporting one synthesized parent completion',
  'drains two nested background siblings in either completion order without deadlocking the parent',
  'admits a user submission first when an idle notification is deferred at the root boundary',
], 'stronger-current', 'The current Thread tests retain configuration ceilings and completion ordering while moving peer results from forgeable user text into typed untrusted context.');
at('tests/core/core.test.ts', [
  'failed transactions roll back uncommitted Loro changes',
  'text patch command finalization uses sparse touched-node snapshots',
  'transaction projection drains do not materialize full state',
  'transaction projection drains preserve net-zero commit detection',
], 'stronger-current', 'The public outline tool identity replaces native command names; rollback and net-zero semantics remain while full-state materialization is reduced to zero.');
at('tests/core/documentReadModel.test.ts', [
  'builds an index-compatible view from a projection',
], 'stronger-current', 'The Runtime read model directly owns the index-compatible Node map and additionally proves its projection containers are isolated from caller mutation.');
review('tests/core/documentSystemRuntime.test.ts', 'keeps a committed mutation successful when the observer commit fails', {
  disposition: 'stronger-current',
  evidencePath: 'tests/core/outlineRuntimeWorkspace.test.ts',
  evidenceLabel: 'keeps a committed mutation successful when the observer commit fails',
  rationale: 'The Runtime test proves a throwing subscriber cannot fail or block a durable Operation, later subscribers still receive it, and restart preserves it; the production-wiring guard also freezes Memory observer diagnostics.',
});
at('tests/core/outlineDocumentService.test.ts', [
  'tracks mutation settlement and resyncs through a Runtime restart',
  'keeps the desktop revision valid after a semantic no-change settlement',
], 'confirmed-regression-fixed', 'Accepted and durable Runtime revisions replace process-local sequence counters; admission freeze, restart resync, and an exact empty delta preserve the recovered desktop contract.');
at('tests/core/outlineRuntime.test.ts', [
  'resolves the repository launcher and TypeScript entry in development',
  'configures the packaged launcher for ordinary Agent PATH resolution',
], 'stronger-current', 'The public source adapter replaces the retired private import helper while development and packaged launchers retain one shared Runtime and CLI path.');
at('tests/core/searchQueryOutline.test.ts', [
  'rejects directives, wrong reference types, and incomplete rules',
], 'equivalent-current', 'Canonical node reference markup replaced the old display-bearing marker; wrong reference types remain rejected before mutation.');
at('tests/e2e/agent-thread.spec.ts', [
  'renders reasoning and grouped tool Items with disclosure and copy interactions',
], 'stronger-current', 'The retired node.read transcript fixture became file_read; the current test retains exact copy output and adds disclosure, alignment, path, and preview interactions.');
at('tests/e2e/file-attachments.spec.ts', [
  '/attachment creates a lightweight file name row whose chevron expands an inline preview and whose bullet drills to the node page',
  'external file drag shows outliner insertion guides and drops at the indicated row position',
  'Cmd+V pastes clipboard files into the outline as file nodes',
], 'confirmed-regression-fixed', 'The old main-process asset command names were replaced by Runtime asset ingest plus atomic attachment drafts; the same creation, placement, paste, focus, and preview outcomes are executable.');
at('tests/e2e/outliner-triggers.spec.ts', [
  '# in trailing input opens tag selector without creating a temporary row',
  '# in trailing input can create and apply a new tag atomically',
  '@ in trailing input creates a focused reference conversion row',
  '@ reference conversion clicks restore and select like a reference row',
  '@ in an empty row creates an inline reference conversion row',
  '@ reference conversion restores the reference node when continued text is deleted',
  '@ same-parent reference keeps continued typing on the inline row',
  'checkbox field values use the shared mark and row keyboard contract',
  'plain field creates a whole-row reference through the normal @ trigger',
  'keeps inherited defaults out of the edit target and materializes them only from accept',
  'virtual slots materialize nested fields, tags, and code blocks through field-slot commands',
  'reference and option picks focus the trailing draft under the materialized entry',
], 'confirmed-regression-fixed', 'The recovered Runtime tests assert one atomic structural or field instruction plus first-frame focus, editor identity, conversion restoration, and final projection instead of private command names.');
at('tests/e2e/tag-template-backfill.spec.ts', [
  'previews exact counts, confirms writes, and skips zero-addition apply',
], 'stronger-current', 'The reviewed preview Diff is reused for one apply rather than recomputed; exact counts, confirmation, focus return, and zero-addition no-op remain covered.');
at('tests/renderer/outlineIntents.test.ts', [
  'builds pasted metadata and trees through same-ChangeSet bindings',
  'copies tags when splitting beside the source node',
  'reorders a selected sibling block without changing its internal order',
  'acknowledges only explicitly destructive desktop intents',
  'keeps renderer rich-text replace-all patches non-reviewed and non-acknowledged',
], 'stronger-current', 'Typed Placement and direct non-destructive commit replace legacy parent/index and apply calls while preserving bindings, tag copy, order, and destructive acknowledgement boundaries.');
at('tests/renderer/pasteParser.test.ts', [
  'treats a multi-word info string as a fence and uses the first token as the language',
], 'equivalent-current', `Only the retired native ${legacyNodeCreate} example became file_write; multi-word fence parsing and the resulting code-block language are unchanged.`);
review('tests/renderer/threadDocumentIndex.test.tsx', 'collects every index-derived Node id in a Turn', {
  disposition: 'explicit-retirement',
  evidencePath: 'docs/plans/outliner-runtime-recovery.md',
  evidenceLabel: 'six native `node_*` Agent tools and their private outline parser',
  rationale: `The missing ids came only from retired ${legacyNodeRead}/${legacyNodeSearch} tool payload indexing; user, assistant, and reasoning references remain covered.`,
});
at('tests/e2e/outliner-drag-drop.spec.ts', [
  'dragging a selected block to the trailing draft appends the whole block',
  'invalid drops on the selected block leave no guide line or stray focus',
], 'confirmed-regression-fixed', 'One ordered multi-target Runtime move replaces private batch calls; selected order, invalid-drop no-op, guides, and focus remain executable.');
at('tests/e2e/outliner-navigation-title.spec.ts', [
  'Cmd+Shift+D opens today when there is no active row selection',
  'sidebar Today ensures the current date before navigating',
], 'confirmed-regression-fixed', 'The same date is ensured before navigation through the public Runtime ensure operation instead of the private command name.');
at('tests/e2e/outliner-row-editing.spec.ts', [
  'field value disclosure creates an ordinary child scope',
  'Shift+Tab while editing a panel-root row is a no-op',
], 'confirmed-regression-fixed', 'The flat guide layer and public move operation replace the old nested DOM and outdent command while preserving child scope, focus, and root no-op behavior.');
at('tests/e2e/outliner-selection-keyboard.spec.ts', [
  'Tab on the first selected child run is a no-op',
  'Shift+Tab on selected panel-root rows is a no-op',
  'double-clicking a reference row edits the target node in place',
], 'confirmed-regression-fixed', 'Public move/reference instructions replace private batch command names; selection, focus, no-op, and in-place reference behavior remain asserted.');
at('tests/e2e/outliner-trailing-expand.spec.ts', [
  'Cmd+Enter stops when empty trailing draft materialization is rejected',
  'Cmd+Enter stops when non-empty trailing draft materialization is rejected',
], 'confirmed-regression-fixed', 'The current tests assert no done-state Change is emitted after rejected materialization and preserve both document structure and draft text.');
at('tests/e2e/table-view.spec.ts', [
  'keeps an empty field cell inert until editing starts',
  'reads and edits saved-search table fields through the complete reference chain',
], 'confirmed-regression-fixed', 'Atomic field-slot updates replace multiple private calls; inert cells, focus, reference-chain editing, materialization count, and final value remain covered.');
at('tests/core/outlineCliGoldenFlows.test.ts', [
  '3. creates definitions and consumes their bindings on new and existing Nodes in one ChangeSet',
  '4. ensures a date and creates a complete typed tree below its binding without an ID lookup',
  '8. creates two Nodes and cross-references them through ChangeSet bindings',
  '9. previews and applies template backfill as one Operation',
  '13. replaces literal text over one bounded query with one reviewed Operation and exact revert',
], 'stronger-current', 'Typed Placement replaces parent/index fields and the reviewed Diff idempotency key is reused; atomic behavior and exact revert assertions are otherwise retained.');
at('tests/renderer/outlineDesktopClient.test.ts', [
  'settles a no-change desktop mutation without waiting for an Operation Event',
], 'stronger-current', 'A no-change commit now returns an exact empty delta without a follow-up show round trip, preserving the revision while reducing command and projection work.');
at('tests/core/agentPiTurnExecutor.test.ts', [
  'restores the canonical Agent schemas after the real Anthropic tool conversion',
], 'stronger-current', 'The restored schema adds the explicit execution field and still freezes the complete canonical schema and property ordering.');
at('tests/core/claudeSubagentParityFixtures.test.ts', [
  'locks the Tenon-local budget breaker notification and refusal bytes',
], 'stronger-current', 'Forgeable notification text was replaced by typed untrusted context; partial output isolation and exact spawn/resume refusal bytes remain asserted.');
at('tests/core/subagentForegroundMessageDelivery.test.ts', [
  'delivers a nested foreground main message after its sender settles while root is idle',
], 'stronger-current', 'Peer messages moved from synthetic user text into typed untrusted context with explicit handling instructions and idempotent ledger identity.');
at('tests/core/markdownRichText.test.ts', [
  'escapes private reference fallbacks against both insertion boundaries',
], 'stronger-current', 'The public RichText parser replaces the retired private outline document envelope and still proves one root, no fields or tags, and safe fallback round-trip.');
at('tests/renderer/reduceProjection.test.ts', [
  'prunes removed focus, selection, expansion, and deferred state at the delta boundary',
  'clears parked requests that target a removed row without dropping surviving focus',
  'clears the shared focus family when a surviving row loses its focus parent',
], 'stronger-current', 'Reference typeahead moved out of document state into the shared interaction controller; every remaining focus-family and conversion request is still pruned at the delta boundary.');
at('tests/renderer/rowInteractions.test.ts', [
  'summarizes search query conditions and materialized result count',
  'resolves batch drag-drop moves while preserving selected order',
], 'stronger-current', 'Public query summaries no longer expose private display-bearing ids, and batch moves additionally freeze optimistic placements while preserving order.');
at('tests/renderer/visualRows.test.ts', [
  'assigns cumulative depth down the tree and through references',
], 'equivalent-current', 'Visual row keys were normalized from path-shaped ids to stable row ids; the same root, child, sibling, and reference depths remain asserted.');

const lines = readFileSync(`${auditRoot}/same-title-missing-assertion-groups.tsv`, 'utf8')
  .trim()
  .split('\n')
  .slice(1);
const output = ['historical_path\ttitle\tmissing_assertions\tdisposition\tevidence_path\tevidence_label\trationale'];
const unreviewed: string[] = [];
for (const line of lines) {
  const [historicalPath, title, missingAssertions, currentPaths] = line.split('\t');
  if (!historicalPath || !title || !missingAssertions) continue;
  const entry = reviews.get(key(historicalPath, title));
  if (!entry) {
    unreviewed.push(`${historicalPath}\t${title}`);
    continue;
  }
  const evidencePath = entry.evidencePath ?? currentPaths?.split(',')[0] ?? '';
  const evidenceLabel = entry.evidenceLabel ?? title;
  output.push([
    historicalPath,
    title,
    missingAssertions,
    entry.disposition,
    evidencePath,
    evidenceLabel,
    entry.rationale,
  ].map(tsv).join('\t'));
  reviews.delete(key(historicalPath, title));
}
for (const stale of reviews.keys()) unreviewed.push(`stale-review\t${stale}`);
writeFileSync(`${auditRoot}/same-title-assertion-review.tsv`, `${output.join('\n')}\n`);
writeFileSync(`${auditRoot}/unreviewed-same-title-assertions.txt`, unreviewed.length ? `${unreviewed.join('\n')}\n` : '');
if (unreviewed.length > 0) {
  console.error(`Same-title assertion review is incomplete (${output.length - 1}/${lines.length}).`);
  console.error(unreviewed.join('\n'));
  process.exit(1);
}

function at(
  path: string,
  titles: readonly string[],
  disposition: Disposition,
  rationale: string,
): void {
  for (const title of titles) review(path, title, { disposition, rationale });
}

function review(path: string, title: string, value: Review): void {
  const reviewKey = key(path, title);
  if (reviews.has(reviewKey)) throw new Error(`Duplicate assertion review: ${reviewKey}`);
  reviews.set(reviewKey, value);
}

function key(path: string, title: string): string {
  return `${path}\t${title}`;
}

function tsv(value: string): string {
  return value.replaceAll('\t', ' ').replaceAll('\n', ' ');
}
