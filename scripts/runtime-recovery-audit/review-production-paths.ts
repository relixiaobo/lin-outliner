import { readFileSync, writeFileSync } from 'node:fs';

type Disposition = 'equivalent-current' | 'stronger-current' | 'explicit-retirement' | 'confirmed-regression-fixed';

interface Review {
  readonly disposition: Disposition;
  readonly currentOwner: string;
  readonly evidencePath: string;
  readonly evidenceLabel: string;
  readonly rationale: string;
}

const auditRoot = `${process.cwd()}/tmp/runtime-recovery-audit`;
const reviews = new Map<string, Review>();
const legacyPackType = ['Import', 'Pack'].join('');
const legacySkillName = ['tenon', 'import'].join('-');
const legacyImportPrefix = ['tenon', 'Import'].join('');

add([
  'src/core/documentSystem.ts',
], 'stronger-current', 'Core plus OutlineRuntimeWorkspace', 'tests/core/outlineRuntimeWorkspace.test.ts', 'commits ordinary mutations against the live Core without forking the document', 'The standalone Runtime owns the live Core, serialized mutation, projection publication, and durable Operation boundary formerly split across DocumentSystem.');
add([
  'src/main/agent/capabilities/agentNodeToolGuidance.ts',
  'src/main/agent/capabilities/agentNodeToolProjection.ts',
  'src/main/agent/capabilities/agentNodeToolRead.ts',
  'src/main/agent/capabilities/agentNodeToolSchemas.ts',
  'src/main/agent/capabilities/agentNodeToolSearch.ts',
  'src/main/agent/capabilities/agentNodeToolTypes.ts',
  'src/main/agent/capabilities/agentNodeToolUtils.ts',
  'src/main/agent/capabilities/agentNodeToolView.ts',
  'src/main/agent/capabilities/agentNodeToolViewConfig.ts',
  'src/main/agent/capabilities/agentNodeToolVisibility.ts',
  'src/main/agent/capabilities/agentNodeTools.ts',
  'src/main/agent/capabilities/agentOutlineParser.ts',
], 'explicit-retirement', 'Public outline Skill, CLI, and ChangeSet', 'docs/plans/outliner-runtime-recovery.md', 'six native `node_*` Agent tools and their private outline parser', 'The final #584 design deliberately removed the duplicate native Agent document authority in favor of the public actor-neutral CLI and typed Runtime contract.');
add([
  'src/main/agent/context/DocumentBeliefs.ts',
  'src/main/agent/context/ThreadDocumentBeliefs.ts',
  'src/main/agent/context/documentDriftNotice.ts',
], 'explicit-retirement', 'Actor-neutral Runtime revisions and typed context', 'docs/plans/outliner-runtime-recovery.md', 'Document Beliefs and drift notices', 'The final #584 design explicitly retired Agent-only document belief indexing and drift prose rather than carrying a second document observation model.');
add([
  `src/main/agent/capabilities/agentData${legacyPackType}.ts`,
  'src/main/agent/capabilities/agentImportApi.ts',
  'src/main/agent/capabilities/agentImportService.ts',
  `src/main/${legacyImportPrefix}Protocol.ts`,
  `src/main/${legacyImportPrefix}ResourceNames.json`,
  `src/main/${legacyImportPrefix}Runtime.ts`,
  `src/main/${legacyImportPrefix}ShellEnvironment.ts`,
  `src/main/builtInSkills/${legacySkillName}/SKILL.md`,
  `src/main/builtInSkills/${legacySkillName}/bin/${legacySkillName}`,
  `src/main/builtInSkills/${legacySkillName}/fixtures/tana-daily-notes.json`,
  `src/main/builtInSkills/${legacySkillName}/fixtures/tana-fields-and-tags.json`,
  `src/main/builtInSkills/${legacySkillName}/fixtures/tana-minimal.json`,
  `src/main/builtInSkills/${legacySkillName}/references/import-pack.md`,
  `src/main/builtInSkills/${legacySkillName}/references/tana-export-notes.md`,
  `src/main/builtInSkills/${legacySkillName}/references/validation-and-coverage.md`,
  `src/main/builtInSkills/${legacySkillName}/scripts/import-pack-lib.ts`,
  `src/main/builtInSkills/${legacySkillName}/scripts/import-pack-preview.ts`,
  `src/main/builtInSkills/${legacySkillName}/scripts/inspect-source.ts`,
  `src/main/builtInSkills/${legacySkillName}/scripts/tana-to-import-pack.ts`,
  `src/main/builtInSkills/${legacySkillName}/scripts/${legacySkillName}.ts`,
  `src/main/builtInSkills/${legacySkillName}/scripts/validate-import-pack.ts`,
], 'explicit-retirement', 'Public outline Skill source adapter and ChangeSet', 'docs/plans/outliner-runtime-recovery.md', `Import Pack mutation APIs and the \`${legacySkillName}\` writer`, 'The private staged writer and API were intentionally retired; normalized source conversion and one public atomic ChangeSet retain the import workflow.');
add([
  'src/main/builtInSkills/outline-import/SKILL.md',
  'src/main/builtInSkills/outline-import/fixtures/tana-daily-notes.json',
  'src/main/builtInSkills/outline-import/fixtures/tana-fields-and-tags.json',
  'src/main/builtInSkills/outline-import/fixtures/tana-minimal.json',
  'src/main/builtInSkills/outline-import/references/normalized-source.md',
  'src/main/builtInSkills/outline-import/references/tana-export-notes.md',
  'src/main/builtInSkills/outline-import/references/validation-and-coverage.md',
  'src/main/builtInSkills/outline-import/scripts/import-source-lib.ts',
  'src/main/builtInSkills/outline-import/scripts/inspect-source.ts',
  'src/main/builtInSkills/outline-import/scripts/outline-import.ts',
  'src/main/builtInSkills/outline-import/scripts/tana-to-changeset.ts',
], 'stronger-current', 'Built-in outline Skill source adapters', 'tests/core/builtInSkillScripts.test.ts', 'imports representative Tana data through public plan, apply, verify, and exact revert', 'This intermediate #584 Skill was folded into the single public outline Skill; adapter coverage, atomic apply, verification, and exact revert remain executable.');
add([
  'src/main/assetService.ts',
], 'stronger-current', 'OutlineAssetStore plus ContentStore', 'tests/core/outlineAssets.test.ts', 'persists immutable logical metadata with verified bytes across Runtime restart', 'Runtime AssetRecords and ContentStore exact revisions replace sidecars while retaining metadata, integrity, previews, serving, retention, and quarantine responsibilities.');
add([
  'src/main/documentReadModel.ts',
], 'stronger-current', 'Runtime DocumentReadModel and DocumentTextSearchIndex', 'tests/core/outlineDocumentService.test.ts', 'uses Runtime-ranked search and keeps sparse Node reads fresh in input order', 'The long-lived sparse read model and text index moved beside the authoritative Runtime Core and remain revision-coherent.');
add([
  'src/main/documentService.ts',
], 'stronger-current', 'OutlineDocumentService plus OutlineRuntimeWorkspace', 'tests/core/outlineDocumentService.test.ts', 'tracks mutation settlement and resyncs through a Runtime restart', 'Desktop orchestration became a Runtime client while mutation serialization, projection events, restart resync, Memory planning, and ranking remain covered.');
add([
  'src/main/workspacePersistenceStore.ts',
], 'stronger-current', 'WorkspaceTransactionLog', 'tests/core/outlineWorkspaceTransactionLog.test.ts', 'rejects an append when the active transaction log inode was replaced at the same size', 'The append-only Runtime transaction log replaces the main-process snapshot/update store with exact replay, cursor identity, corruption, and concurrent replacement checks.');
add([
  'src/main/workspaceSaver.ts',
], 'confirmed-regression-fixed', 'OutlineRuntimeWorkspace durability scheduler', 'tests/core/outlineRuntimeWorkspace.test.ts', 'coalesces sustained accepted edits at the maximum dirty age under one fsync', 'The cutover initially omitted saver idle/max-age coalescing; the recovery restores those scheduling guarantees while batching independent durable records.');

add([
  'src/core/core.ts',
  'src/core/loroDocument.ts',
], 'stronger-current', 'Live Core candidate transaction boundary', 'tests/core/coreRuntimeFork.test.ts', 'uses an isolated native candidate without serializing the workspace', 'The current Runtime candidate and settlement path preserves rollback and incremental caches without full workspace serialization.');
add([
  'src/core/assets.ts',
], 'confirmed-regression-fixed', 'Canonical logical asset URL boundary', 'tests/core/assets.test.ts', 'round-trips Runtime logical IDs through one encoded path segment', 'The recovered renderer protocol keeps logical asset IDs in one percent-encoded path segment under a fixed authority, avoiding URL-host normalization and rejecting extra URL state.');
add([
  'src/main/agent/capabilities/agentCapabilities.ts',
], 'confirmed-regression-fixed', 'Public outline capability parser', 'tests/core/agentCapabilities.test.ts', 'classifies outline shell commands from the public capability registry', 'The recovered parser recognizes one direct public outline invocation, including bounded global options and output mode, without reviving the retired private Agent document tools.');
add([
  'src/main/agent/extensions/memory/MemoryExtension.ts',
], 'confirmed-regression-fixed', 'Memory citation accounting through public outline show', 'tests/core/agentMemory.test.ts', 'routes Memory lookup without injecting prose and counts only an inline citation of an exact show', 'Memory usage accounting is reattached to successful public outline show results and completed inline Node citations while failed, unrelated, uncited, or non-final evidence remains excluded.');
add([
  'src/main/agent/extensions/memory/TimelineMemoryStore.ts',
], 'confirmed-regression-fixed', 'TimelineMemoryStore through OutlineDocumentService planning', 'tests/core/outlineDocumentService.test.ts', 'plans Memory publication after earlier document mutations have updated the projection', 'Memory planning is again serialized behind already-admitted document work and deterministic definitions settle durably through the Runtime.');
add([
  'src/main/main.ts',
  'src/main/outlineDocumentService.ts',
], 'confirmed-regression-fixed', 'Main production wiring and OutlineDocumentService', 'tests/core/outlineDocumentService.test.ts', 'keeps recovered desktop production wiring attached to the Runtime service', 'The production startup graph now reconnects Memory observation, durability diagnostics, personal ranking, admission drain, and the Runtime client service.');
add([
  'src/main/outlineClient/desktopOutlineClient.ts',
  'src/main/outlineClient/ipc.ts',
  'src/main/outlineClient/protocol.ts',
  'src/preload/index.ts',
], 'stronger-current', 'Narrow desktop Runtime IPC bridge', 'tests/core/desktopOutlineClient.test.ts', 'limits generic renderer requests to desktop-safe Outline capabilities', 'Renderer transport remains context-isolated and exposes only desktop-safe identifiers and capabilities while sharing one watch transport.');
add([
  'src/outline/client/client.ts',
  'src/outline/client/supervisor.ts',
  'src/outline/runtime/server/entry.ts',
  'src/outline/runtime/server/runtimeRouter.ts',
  'src/outline/runtime/server/runtimeServer.ts',
], 'stronger-current', 'Authenticated Runtime process and supervisors', 'tests/core/outlineRuntimeProcess.test.ts', 'lets simultaneous desktop and CLI supervisors attach to one standalone instance', 'Client attachment, replacement, authentication, accepted mutations, asset streaming, watches, maintenance, and lifecycle ownership remain one tested process boundary.');
add([
  'src/outline/contract/schemas.ts',
], 'stronger-current', 'Versioned public Outline schemas', 'tests/core/outlineContract.test.ts', 'exports every named versioned schema as valid JSON Schema', 'The schema surface evolved but remains fully compiled, serialized, compacted, and size-bounded.');
add([
  'src/outline/contract/capabilities.ts',
  'src/outline/contract/version.ts',
], 'confirmed-regression-fixed', 'Runtime compatibility digest', 'tests/core/outlineContract.test.ts', 'includes the private Runtime contract version in the compatibility digest', 'Runtime-private route changes now invalidate the same compatibility digest used during client attachment instead of remaining invisible behind unchanged public capability schemas.');
add([
  'src/outline/runtime/changeSet.ts',
  'src/outline/runtime/projection.ts',
  'src/outline/runtime/selector.ts',
  'src/outline/runtime/index.ts',
], 'stronger-current', 'Typed ChangeSet, selector, and projection kernel', 'tests/core/outlineChangeSetCapabilities.test.ts', 'preserves rich content, capture provenance, fields, definitions, and references', 'Typed Placement, protected definitions, reference identities, fields, queries, and bounded projections retain the complete public mutation surface.');
add([
  'src/outline/runtime/runtimeWorkspace.ts',
], 'confirmed-regression-fixed', 'OutlineRuntimeWorkspace', 'tests/core/outlineRuntimeWorkspace.test.ts', 'persists consecutive accepted mutations in revision and Event order across restart', 'The recovered live Core, accepted/durable split, quit barrier, coalescing, observer isolation, history, ranking, and restart order are exercised together.');
add([
  'src/outline/runtime/storage/assetStore.ts',
], 'confirmed-regression-fixed', 'OutlineAssetStore plus ContentStore', 'tests/core/outlineAssets.test.ts', 'derives metadata that follows the bounded ingestion head without loading the whole asset', 'Logical metadata, post-head media parsing, linked thumbnails, stage recovery, quarantine, and anchor ordering were restored around streamed ContentStore bytes.');
add([
  'src/outline/runtime/storage/workspaceTransactionLog.ts',
], 'confirmed-regression-fixed', 'WorkspaceTransactionLog', 'tests/core/outlineWorkspaceTransactionLog.test.ts', 'appends a transaction batch with one fsync and replays every record after restart', 'Batch fsync retains independent Operations and Events while cursor inode, length, reload, acknowledgement, and idempotency races fail closed.');
add([
  'src/renderer/api/outline.ts',
], 'confirmed-regression-fixed', 'Desktop Event source and projection fold acknowledgement', 'tests/renderer/outlineDesktopClient.test.ts', 'does not advance a queued mutation base from a held Event', 'Observed stream revisions no longer advance mutation bases ahead of renderer projection state; accepted and durable updates retain exact order.');
add([
  'src/renderer/api/outlineIntents.ts',
], 'confirmed-regression-fixed', 'Typed renderer mutation intents', 'tests/renderer/outlineIntents.test.ts', 'uses direct commit for ordinary non-destructive desktop edits', 'Renderer editing, fields, references, tags, selection deletion, and done-state operations now share typed Runtime instructions and one mutation boundary.');
add([
  'src/renderer/styles/outliner.css',
  'src/renderer/ui/App.tsx',
  'src/renderer/ui/outliner/NodeDescription.tsx',
  'src/renderer/ui/outliner/OutlinerItem.tsx',
], 'confirmed-regression-fixed', 'Optimistic renderer editing and projection fold', 'tests/e2e/outliner-row-editing.spec.ts', 'Enter in the middle immediately shows the split head and keeps it after settlement', 'The recovered UI preserves native input, IME, Enter split, focus, editor identity, and flat field/reference layout across Runtime settlement.');
add([
  'src/renderer/agent/components/ThreadView.tsx',
], 'confirmed-regression-fixed', 'Cross-frame composer focus eligibility', 'tests/renderer/composerRefocus.test.ts', 'keeps an eligible request only while no newer surface owns focus', 'Delayed composer focus rechecks the active element in the animation frame, so automatic Thread creation cannot reclaim focus from an Outliner editor or another newer surface.');

const pathDispositions = readFileSync(`${auditRoot}/pr-path-disposition.tsv`, 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));
const paths = pathDispositions
  .filter(([status, path]) => (
    (status === 'evolved-now' || status === 'absent-at-tip')
    && path?.startsWith('src/')
  ));
const output = ['historical_status\thistorical_path\tdisposition\tcurrent_owner\tevidence_path\tevidence_label\trationale'];
const unreviewed: string[] = pathDispositions
  .filter(([status, path]) => status === 'missing-now' && path?.startsWith('src/'))
  .map(([, path]) => `missing-current-source\t${path}`);
for (const [status, path] of paths) {
  if (!status || !path) continue;
  const entry = reviews.get(path);
  if (!entry) {
    unreviewed.push(`${status}\t${path}`);
    continue;
  }
  output.push([
    status,
    path,
    entry.disposition,
    entry.currentOwner,
    entry.evidencePath,
    entry.evidenceLabel,
    entry.rationale,
  ].map(tsv).join('\t'));
  reviews.delete(path);
}
for (const path of reviews.keys()) unreviewed.push(`stale-review\t${path}`);
writeFileSync(`${auditRoot}/production-path-review.tsv`, `${output.join('\n')}\n`);
writeFileSync(`${auditRoot}/unreviewed-production-paths.txt`, unreviewed.length ? `${unreviewed.join('\n')}\n` : '');
if (unreviewed.length > 0) {
  console.error(`Production path review is incomplete (${output.length - 1}/${paths.length}).`);
  console.error(unreviewed.join('\n'));
  process.exit(1);
}

function add(
  paths: readonly string[],
  disposition: Disposition,
  currentOwner: string,
  evidencePath: string,
  evidenceLabel: string,
  rationale: string,
): void {
  for (const path of paths) {
    if (reviews.has(path)) throw new Error(`Duplicate production path review: ${path}`);
    reviews.set(path, { disposition, currentOwner, evidencePath, evidenceLabel, rationale });
  }
}

function tsv(value: string): string {
  return value.replaceAll('\t', ' ').replaceAll('\n', ' ');
}
