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

interface Effect {
  readonly id: string;
  readonly kind: EffectKind;
  readonly path: string;
  readonly line: number;
  readonly expression: string;
  readonly owner: string | null;
}

interface Disposition extends Effect {
  readonly disposition: string;
  readonly transport: boolean;
}

const root = resolve(import.meta.dir, '../..');
const auditRoot = resolve(import.meta.dir);
const baselinePath = join(auditRoot, 'baseline.json');
const inventoryPath = join(auditRoot, 'baseline-inventory.jsonl');
const dispositionsPath = join(auditRoot, 'baseline-dispositions.jsonl');
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
const currentDispositions = currentInventory.map(dispositionForCurrent);
const unownedTransport = currentDispositions.filter((entry) => entry.transport && entry.owner === null
  && !entry.disposition.startsWith('retained:'));
const duplicateTransport = duplicateKeys(currentDispositions.filter((entry) => entry.transport));

mkdirSync(reportRoot, { recursive: true });
writeJson(join(reportRoot, 'current-inventory.json'), currentInventory);
writeJson(join(reportRoot, 'current-dispositions.json'), currentDispositions);
writeJson(join(reportRoot, 'unowned-transport.json'), unownedTransport);
writeJson(join(reportRoot, 'duplicate-transport.json'), duplicateTransport);

console.log(`baseline effects: ${baselineInventory.length}`);
console.log(`baseline transport effects: ${baselineDispositions.filter((entry) => entry.transport).length}`);
console.log(`current effects: ${currentInventory.length}`);
console.log(`unowned transport effects: ${unownedTransport.length}`);
console.log(`duplicate transport effects: ${duplicateTransport.length}`);
console.log(`reports: ${relative(root, reportRoot)}`);

if (unownedTransport.length > 0 || duplicateTransport.length > 0) process.exitCode = 1;

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

function dispositionForCurrent(effect: Effect): Disposition {
  const inferredOwner = effect.owner ?? currentTypedEdgeOwner(effect);
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
    const lifecycle = /^(?:app|process|powerMonitor)\./.test(effect.expression);
    const retainedBaselineEffect = baselineEffectKeys.has(effectKey(effect));
    return {
      ...effect,
      owner: inferredOwner,
      transport: true,
      disposition: inferredOwner
        ? `owner:${inferredOwner}`
        : lifecycle || !retainedBaselineEffect ? 'unclassified' : 'retained:capability-or-window-surface',
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
  if (effect.kind !== 'listener') return null;
  if (effect.expression.startsWith("app.on('")) return 'app-lifecycle';
  return null;
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
