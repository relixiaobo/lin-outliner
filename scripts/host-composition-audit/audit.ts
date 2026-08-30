import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

interface Baseline {
  readonly commit: string;
  readonly tree: string;
  readonly sourceRoot: string;
  readonly sourceTreeSha256: string;
}

type EffectKind = 'construction' | 'ipc' | 'listener' | 'mutable-global' | 'protocol' | 'session' | 'timer';
const listenerRegistrationIdentity = Symbol('listenerRegistrationIdentity');

interface Effect {
  readonly id: string;
  readonly kind: EffectKind;
  readonly path: string;
  readonly line: number;
  readonly expression: string;
  readonly owner: string | null;
  readonly [listenerRegistrationIdentity]?: string;
}

interface Disposition extends Effect {
  readonly disposition: string;
  readonly transport: boolean;
}

interface BaselineEquivalence {
  readonly baselineKey: string;
  readonly currentKey: string | null;
  readonly disposition: string;
}

const root = resolve(import.meta.dir, '../..');
const auditRoot = resolve(import.meta.dir);
const baselinePath = join(auditRoot, 'baseline.json');
const inventoryPath = join(auditRoot, 'baseline-inventory.jsonl');
const dispositionsPath = join(auditRoot, 'baseline-dispositions.jsonl');
const equivalencesPath = join(auditRoot, 'baseline-equivalences.json');
const reportRoot = join(root, 'tmp/host-composition-audit');
const writeBaseline = process.argv.includes('--write-baseline');

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
const actualCommit = git(['rev-parse', baseline.commit]);
const actualTree = git(['rev-parse', `${baseline.commit}^{tree}`]);
const baselinePaths = git(['ls-tree', '-r', '--name-only', baseline.commit, '--', baseline.sourceRoot])
  .split('\n')
  .filter((path) => path.endsWith('.ts'));
const baselineSources = baselinePaths.map((path) => ({
  path,
  source: git(['show', `${baseline.commit}:${path}`]),
}));
const actualSourceSha = sourceTreeHash(baselineSources);
assertEqual('baseline commit', actualCommit, baseline.commit);
assertEqual('baseline tree', actualTree, baseline.tree);
assertEqual('baseline source tree hash', actualSourceSha, baseline.sourceTreeSha256);

const baselineInventory = baselineSources.flatMap(({ path, source }) => collectEffects(source, path));
const baselineDispositions = baselineInventory.map(dispositionForBaseline);
const baselineEffectKeys = new Set(baselineInventory.map(effectKey));
if (writeBaseline) {
  writeJsonLines(inventoryPath, baselineInventory);
  writeJsonLines(dispositionsPath, baselineDispositions);
} else {
  assertGeneratedJsonLines(inventoryPath, baselineInventory);
  assertGeneratedJsonLines(dispositionsPath, baselineDispositions);
}

const currentSourceRoot = join(root, baseline.sourceRoot);
const currentSources = (readdirSync(currentSourceRoot, { recursive: true }) as string[])
  .filter((path) => path.endsWith('.ts'))
  .map((path) => ({
    path: join(baseline.sourceRoot, path).replaceAll('\\', '/'),
    source: readFileSync(join(currentSourceRoot, path), 'utf8'),
  }));
const currentInventory = currentSources.flatMap(({ path, source }) => collectEffects(source, path));
const currentListenerReleaseCounts = collectListenerReleaseCounts(currentSources);
const currentDispositions = currentInventory.map((effect) => (
  dispositionForCurrent(effect, currentListenerReleaseCounts)
));
const baselineEquivalences = readBaselineEquivalences(equivalencesPath);
validateBaselineEquivalences(baselineEquivalences, baselineDispositions, currentDispositions);
const unownedTransport = currentDispositions.filter((entry) => entry.transport && entry.owner === null
  && !entry.disposition.startsWith('retained:'));
const duplicateTransport = duplicateKeys(currentDispositions.filter((entry) => entry.transport));
const missingBaselineTransport = missingBaselineTransportEffects(
  baselineDispositions,
  currentDispositions,
  baselineEquivalences,
);
runNegativeFixtures();

mkdirSync(reportRoot, { recursive: true });
writeJson(join(reportRoot, 'current-inventory.json'), currentInventory);
writeJson(join(reportRoot, 'current-dispositions.json'), currentDispositions);
writeJson(join(reportRoot, 'unowned-transport.json'), unownedTransport);
writeJson(join(reportRoot, 'duplicate-transport.json'), duplicateTransport);
writeJson(join(reportRoot, 'missing-baseline-transport.json'), missingBaselineTransport);

console.log(`baseline effects: ${baselineInventory.length}`);
console.log(`baseline transport effects: ${baselineDispositions.filter((entry) => entry.transport).length}`);
console.log(`current effects: ${currentInventory.length}`);
console.log(`unowned transport effects: ${unownedTransport.length}`);
console.log(`duplicate transport effects: ${duplicateTransport.length}`);
console.log(`missing baseline transport effects: ${missingBaselineTransport.length}`);
console.log(`reports: ${relative(root, reportRoot)}`);

if (unownedTransport.length > 0 || duplicateTransport.length > 0 || missingBaselineTransport.length > 0) {
  process.exitCode = 1;
}

function collectEffects(source: string, path: string): Effect[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const effects: Effect[] = [];
  const add = (kind: EffectKind, node: ts.Node, expression: string, owner: string | null) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const stableExpression = expression.replace(/\s+/g, ' ').trim();
    effects.push({
      id: `${path}:${kind}:${line}:${sha256(stableExpression).slice(0, 12)}`,
      kind,
      path,
      line,
      expression: stableExpression,
      owner,
      ...(kind === 'listener'
        ? { [listenerRegistrationIdentity]: listenerIdentity(path, node, file) ?? undefined }
        : {}),
    });
  };

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Let) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      add('mutable-global', declaration, declaration.name.getText(file), null);
    }
  }

  const visit = (node: ts.Node, inheritedOwner: string | null): void => {
    const owner = ownerDeclaredBy(node, file) ?? ownerDeclaredByFunction(node) ?? inheritedOwner;
    if (ts.isNewExpression(node)) {
      add('construction', node, node.expression.getText(file), owner);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(file);
      const kind = effectKind(expression);
      if (kind) add(kind, node, effectIdentity(node, file), owner);
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  visit(file, null);
  return effects.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

function ownerDeclaredByFunction(node: ts.Node): string | null {
  if (!ts.isFunctionDeclaration(node)) return null;
  const owners: Readonly<Record<string, string>> = {
    configureSessionSecurity: 'default-session-security',
    registerOutlineTransport: 'outline',
    registerUpdateTransport: 'updates',
    registerActionTransport: 'actions',
    registerAgentTransport: 'agent-memory-automation',
    registerSourcePreviewTransport: 'source-assets-preview',
    registerWindowSettingsTransport: 'windows-settings-launcher-providers',
    registerDiagnosticsTransport: 'diagnostics',
    registerNativeFileTransport: 'native-files',
    registerAgentResourceTransport: 'agent-resources',
  };
  return node.name ? owners[node.name.text] ?? null : null;
}

function ownerDeclaredBy(node: ts.Node, file: ts.SourceFile): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression.getText(file);
  if (!/(?:registerIpcOwner|registerProtocolOwner|registerOwner|createTransportOwner)$/.test(callee)) return null;
  const name = node.arguments[0];
  return name && ts.isStringLiteral(name) ? name.text : null;
}

function effectKind(expression: string): EffectKind | null {
  if (/ipcMain\.(?:handle|on)$/.test(expression)) return 'ipc';
  if (/protocol\.(?:handle|registerSchemesAsPrivileged)$/.test(expression)) return 'protocol';
  if (/\.(?:setPermissionRequestHandler|setPermissionCheckHandler)$/.test(expression)
    || /\.webRequest\.onHeadersReceived$/.test(expression)
    || /^(?:configureSessionSecurity|configureUrlPreviewSession)$/.test(expression)) return 'session';
  if (/^(?:setInterval|setTimeout)$/.test(expression)) return 'timer';
  if (/\.(?:on|once|addListener|setWindowOpenHandler)$/.test(expression)) return 'listener';
  return null;
}

function effectIdentity(node: ts.CallExpression, file: ts.SourceFile): string {
  const callee = node.expression.getText(file);
  const first = node.arguments[0]?.getText(file) ?? '';
  return `${callee}(${first})`;
}

function dispositionForBaseline(effect: Effect): Disposition {
  if (effect.kind === 'ipc') return { ...effect, transport: true, disposition: `owner:${baselineIpcOwner(effect)}` };
  if (effect.kind === 'protocol') {
    const retained = effect.expression.includes('registerSchemesAsPrivileged');
    return { ...effect, transport: true, disposition: retained ? 'retained:pre-ready-bootstrap' : 'owner:source-preview-protocols' };
  }
  if (effect.kind === 'session') {
    const capabilityOwned = effect.path === 'src/main/agent/capabilities/agentTools.ts';
    return {
      ...effect,
      transport: true,
      disposition: capabilityOwned ? 'retained:agent-web-fetch-capability' : 'owner:session-security',
    };
  }
  if (effect.kind === 'listener') {
    if (/^(?:app|process|powerMonitor)\./.test(effect.expression)) {
      return { ...effect, transport: true, disposition: 'owner:process-lifecycle' };
    }
    return { ...effect, transport: true, disposition: 'retained:capability-or-window-surface' };
  }
  if (effect.kind === 'timer') {
    return { ...effect, transport: false, disposition: 'successor:host-domain-or-platform-composition' };
  }
  return { ...effect, transport: false, disposition: 'successor:host-domain-composition' };
}

function dispositionForCurrent(effect: Effect, listenerReleaseCounts: Map<string, number>): Disposition {
  const lifecycleListener = isLifecycleListener(effect);
  const inferredOwner = lifecycleListener
    ? consumeLifecycleListenerRelease(effect, listenerReleaseCounts)
      ? effect.owner ?? inferredLifecycleOwner(effect)
      : null
    : effect.owner ?? currentTypedEdgeOwner(effect);
  if (effect.kind === 'ipc' || effect.kind === 'protocol' || effect.kind === 'session') {
    const retained = effect.expression.includes('registerSchemesAsPrivileged');
    return {
      ...effect,
      owner: inferredOwner,
      transport: true,
      disposition: inferredOwner ? `owner:${inferredOwner}` : retained ? 'retained:pre-ready-bootstrap' : 'unclassified',
    };
  }
  if (effect.kind === 'listener') {
    const retainedBaselineEffect = baselineEffectKeys.has(effectKey(effect));
    return {
      ...effect,
      owner: inferredOwner,
      transport: true,
      disposition: inferredOwner
        ? `owner:${inferredOwner}`
        : lifecycleListener || !retainedBaselineEffect ? 'unclassified' : 'retained:capability-or-window-surface',
    };
  }
  return dispositionForBaseline(effect);
}

function effectKey(effect: Effect): string {
  return `${effect.path}:${effect.kind}:${effect.expression}`;
}

function currentTypedEdgeOwner(effect: Effect): string | null {
  if (effect.path === 'src/main/outlineClient/ipc.ts') return 'outline';
  if (effect.path === 'src/main/urlPreviewSession.ts') return 'url-preview-session-security';
  if (effect.path === 'src/main/hostTransport/ownership.ts') return 'typed-registration-edge';
  if (effect.path === 'src/main/agent/capabilities/agentTools.ts' && effect.kind === 'session') {
    return 'agent-web-fetch-capability';
  }
  return null;
}

function isLifecycleListener(effect: Effect): boolean {
  return effect.kind === 'listener' && /^(?:app|process|powerMonitor)\./.test(effect.expression);
}

function inferredLifecycleOwner(effect: Effect): string | null {
  return effect.expression.startsWith("app.on('") ? 'app-lifecycle' : null;
}

function consumeLifecycleListenerRelease(effect: Effect, listenerReleaseCounts: Map<string, number>): boolean {
  const identity = effect[listenerRegistrationIdentity];
  if (!identity) return false;
  const releaseCount = listenerReleaseCounts.get(identity) ?? 0;
  if (releaseCount === 0) return false;
  listenerReleaseCounts.set(identity, releaseCount - 1);
  return true;
}

function listenerIdentity(path: string, node: ts.CallExpression, file: ts.SourceFile): string | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (!['on', 'once', 'addListener'].includes(node.expression.name.text)) return null;
  const event = node.arguments[0];
  const listener = node.arguments[1];
  if (!event || !listener) return null;
  return `${path}\0${node.expression.expression.getText(file)}\0${event.getText(file)}\0${listener.getText(file)}`;
}

function collectListenerReleaseCounts(
  sources: readonly { path: string; source: string }[],
): Map<string, number> {
  const releases = new Map<string, number>();
  for (const { path, source } of sources) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'removeListener') {
        const event = node.arguments[0];
        const listener = node.arguments[1];
        if (event && listener) {
          const identity = `${path}\0${node.expression.expression.getText(file)}\0${event.getText(file)}\0${listener.getText(file)}`;
          releases.set(identity, (releases.get(identity) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return releases;
}

function readBaselineEquivalences(path: string): BaselineEquivalence[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { equivalences?: unknown };
  if (!Array.isArray(parsed.equivalences)) throw new Error('Baseline equivalences must contain an array.');
  return parsed.equivalences.map((value, index) => {
    if (!isRecord(value)
      || typeof value.baselineKey !== 'string'
      || (value.currentKey !== null && typeof value.currentKey !== 'string')
      || typeof value.disposition !== 'string'
      || !/^(?:equivalent|removed):/.test(value.disposition)) {
      throw new Error(`Invalid baseline equivalence at index ${index}.`);
    }
    return value as unknown as BaselineEquivalence;
  });
}

function validateBaselineEquivalences(
  equivalences: readonly BaselineEquivalence[],
  baselineDispositions: readonly Disposition[],
  currentDispositions: readonly Disposition[],
): void {
  const baselineTransport = new Map(
    baselineDispositions.filter((entry) => entry.transport).map((entry) => [effectKey(entry), entry]),
  );
  const currentTransport = new Map(
    currentDispositions.filter((entry) => entry.transport).map((entry) => [effectKey(entry), entry]),
  );
  const seen = new Set<string>();
  for (const equivalence of equivalences) {
    if (seen.has(equivalence.baselineKey)) {
      throw new Error(`Duplicate baseline equivalence: ${equivalence.baselineKey}`);
    }
    seen.add(equivalence.baselineKey);
    const baselineEffect = baselineTransport.get(equivalence.baselineKey);
    if (!baselineEffect) throw new Error(`Baseline equivalence source is not a transport effect: ${equivalence.baselineKey}`);
    if (equivalence.currentKey === null) {
      if (!equivalence.disposition.startsWith('removed:')) {
        throw new Error(`Baseline removal requires a removed disposition: ${equivalence.baselineKey}`);
      }
      continue;
    }
    const currentEffect = currentTransport.get(equivalence.currentKey);
    if (!currentEffect) throw new Error(`Baseline equivalence target is not a current transport effect: ${equivalence.currentKey}`);
    if (baselineEffect.kind !== currentEffect.kind) {
      throw new Error(`Baseline equivalence changes effect kind: ${equivalence.baselineKey}`);
    }
    if (!equivalence.disposition.startsWith('equivalent:')) {
      throw new Error(`Baseline replacement requires an equivalent disposition: ${equivalence.baselineKey}`);
    }
  }
}

function missingBaselineTransportEffects(
  baselineDispositions: readonly Disposition[],
  currentDispositions: readonly Disposition[],
  equivalences: readonly BaselineEquivalence[],
): Disposition[] {
  const currentKeys = new Set(
    currentDispositions.filter((entry) => entry.transport).map(effectKey),
  );
  const dispositionKeys = new Set(equivalences.map((entry) => entry.baselineKey));
  return baselineDispositions.filter((entry) => (
    entry.transport && !currentKeys.has(effectKey(entry)) && !dispositionKeys.has(effectKey(entry))
  ));
}

function runNegativeFixtures(): void {
  const missingBaseline = collectEffects(
    "ipcMain.handle('fixture:known', () => undefined);",
    'src/main/fixture.ts',
  ).map(dispositionForBaseline);
  const missing = missingBaselineTransportEffects(missingBaseline, [], []);
  if (missing.length !== 1) throw new Error('Negative fixture failed to detect a missing baseline handler.');

  const unreleasedSource = [
    'const handleActivate = () => undefined;',
    "app.on('activate', handleActivate);",
    "app.on('activate', handleActivate);",
    "app.removeListener('activate', handleActivate);",
  ].join('\n');
  const unreleasedSources = [{ path: 'src/main/fixture.ts', source: unreleasedSource }];
  const fixtureReleaseCounts = collectListenerReleaseCounts(unreleasedSources);
  const unreleased = collectEffects(unreleasedSource, unreleasedSources[0]!.path)
    .map((effect) => dispositionForCurrent(effect, fixtureReleaseCounts))
    .filter((entry) => entry.transport && entry.owner === null && !entry.disposition.startsWith('retained:'));
  if (unreleased.length !== 1) throw new Error('Negative fixture failed to detect an unreleased app listener.');

  const scopedUnreleasedSource = [
    "createTransportOwner('app-lifecycle', () => {",
    '  const focusMainWindow = () => undefined;',
    "  app.on('second-instance', focusMainWindow);",
    '});',
  ].join('\n');
  const scopedUnreleasedSources = [{ path: 'src/main/fixture.ts', source: scopedUnreleasedSource }];
  const scopedReleaseCounts = collectListenerReleaseCounts(scopedUnreleasedSources);
  const scopedEffects = collectEffects(scopedUnreleasedSource, scopedUnreleasedSources[0]!.path);
  const scopedListener = scopedEffects.find(isLifecycleListener);
  if (scopedListener?.owner !== 'app-lifecycle') {
    throw new Error('Negative fixture failed to inherit the declared lifecycle owner.');
  }
  const scopedUnreleased = scopedEffects
    .map((effect) => dispositionForCurrent(effect, scopedReleaseCounts))
    .filter((entry) => entry.transport && entry.owner === null && !entry.disposition.startsWith('retained:'));
  if (scopedUnreleased.length !== 1) {
    throw new Error('Negative fixture failed to detect an owned-scope app listener without a release.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function baselineIpcOwner(effect: Effect): string {
  if (effect.path === 'src/main/outlineClient/ipc.ts') return 'outline';
  if (/APP_UPDATE/.test(effect.expression)) return 'updates';
  if (/ACTION_/.test(effect.expression)) return 'actions';
  if (/AUTOMATION_|AGENT_CORE_|THREAD_MESSAGE_CONTEXT/.test(effect.expression)) return 'agent-memory-automation';
  if (/diagnostic|DIAGNOSTIC|APP_INFO|RENDERER_ERROR/i.test(effect.expression)) return 'diagnostics';
  if (/attachment-upload|attachment-resource/.test(effect.expression)) return 'agent-resources';
  if (/local-file/.test(effect.expression)) return 'native-files';
  if (/lin:invoke|record-node-access|TRANSLATION_GUEST/.test(effect.expression)) return 'source-assets-preview';
  return 'windows-settings-launcher-providers';
}

function duplicateKeys(effects: readonly Disposition[]): string[] {
  const counts = new Map<string, number>();
  for (const effect of effects) {
    if (effect.kind !== 'ipc' && effect.kind !== 'protocol' && effect.kind !== 'session') continue;
    const key = `${effect.kind}:${effect.expression}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort();
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trimEnd();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceTreeHash(sources: readonly { path: string; source: string }[]): string {
  return sha256(sources.map(({ path, source }) => `${path}\0${source}\0`).join(''));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(path: string, values: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

function assertGeneratedJsonLines(path: string, values: readonly unknown[]): void {
  const expected = `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
  const actual = readFileSync(path, 'utf8');
  if (actual !== expected) throw new Error(`${relative(root, path)} is stale; run audit.ts --write-baseline.`);
}

function assertEqual(label: string, actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
}
