import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, valid } from 'semver';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = process.argv[2];
assert(version && valid(version), 'Usage: check-release-compatibility <release-version> [--local]');
const repository = process.env.GITHUB_REPOSITORY ?? 'relixiaobo/lin-outliner';
const local = process.argv.includes('--local');
const root = resolve(process.env.TENON_COMPATIBILITY_DIR ?? join(repo, 'release-compatibility'));
const currentFixture = join(root, 'current-fixture');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const results: { readonly sourceVersion: string; readonly sourceRevision: string; readonly sourceApplicationVersion: string; readonly report: string }[] = [];
const current = runChecker(['--fixture-output', currentFixture]);
const currentMetadata = await readFixtureMetadata(currentFixture);
assert.equal(currentMetadata.applicationVersion, version, `Current fixture is ${currentMetadata.applicationVersion}, release is ${version}`);
await copyReport(current.report, 'current-report.json');

if (!local) {
  const releases = readReleases();
  const assets = releases
    .filter((release) => release.tag_name.startsWith('v') && release.draft !== true && release.prerelease !== true)
    .filter((release) => {
      const releaseVersion = valid(release.tag_name.slice(1));
      return releaseVersion !== null && compare(releaseVersion, version) < 0;
    })
    .flatMap((release) => release.assets
      .filter((asset) => /^tenon-data-fixture-v\d+\.\d+\.\d+\.tar\.gz$/u.test(asset.name))
      .map((asset) => ({ release, asset })));
  const seenVersions = new Set<string>();
  for (const { release, asset } of assets) {
    const sourceVersion = valid(release.tag_name.slice(1));
    assert(sourceVersion, `Invalid fixture release tag ${release.tag_name}`);
    assert(!seenVersions.has(sourceVersion), `Multiple compatibility fixtures found for ${sourceVersion}`);
    seenVersions.add(sourceVersion);
    const directory = join(root, `source-${sourceVersion}`);
    const downloadDirectory = join(root, 'downloads');
    await mkdir(directory, { recursive: true }); await mkdir(downloadDirectory, { recursive: true });
    execFileSync('gh', ['release', 'download', release.tag_name, '--repo', repository, '--pattern', asset.name, '--dir', downloadDirectory, '--clobber'], { cwd: repo, stdio: 'inherit' });
    const archive = join(downloadDirectory, asset.name);
    verifyArchiveEntries(execFileSync('tar', ['-tzf', archive], { cwd: repo, encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', archive, '-C', directory], { cwd: repo, stdio: 'inherit' });
    const metadata = await readFixtureMetadata(directory);
    assert.equal(metadata.applicationVersion, sourceVersion, `Fixture metadata does not match ${release.tag_name}`);
    const checked = runChecker(['--fixture', directory]);
    const report = `report-${sourceVersion}.json`;
    await copyReport(checked.report, report);
    results.push({ sourceVersion, sourceRevision: metadata.sourceRevision, sourceApplicationVersion: metadata.applicationVersion, report });
  }
}

const fixtureArchive = `tenon-data-fixture-v${version}.tar.gz`;
execFileSync('tar', ['-czf', join(root, fixtureArchive), '-C', currentFixture, '.'], { cwd: repo, stdio: 'inherit' });
const matrix = {
  version: 1, targetVersion: version, repository, baseline: results.length === 0, generatedAt: new Date().toISOString(),
  currentFixture: { sourceRevision: currentMetadata.sourceRevision, applicationVersion: currentMetadata.applicationVersion, loroVersion: currentMetadata.loroVersion },
  upgrades: results,
  assertions: ['physical compatibility', 'populated backup', 'restore', 'identity', 'conversations', 'projects', 'profile', 'memory', 'tasks', 'schedules', 'delegation', 'attachment bytes', 'execution fence'],
};
await writeFile(join(root, 'compatibility-matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, targetVersion: version, baseline: matrix.baseline, sourceFixtures: results.length, directory: root, matrix: join(root, 'compatibility-matrix.json'), fixture: join(root, fixtureArchive) }));

function runChecker(args: readonly string[]): { readonly report: string } {
  let output: string;
  try { output = execFileSync('bun', ['scripts/check-data-lifecycle.ts', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
  catch (error) { throw new Error(`Data lifecycle compatibility check failed for ${args.join(' ')}`, { cause: error }); }
  const line = output.trim().split('\n').at(-1);
  assert(line, 'Data lifecycle checker returned no JSON result');
  const result = JSON.parse(line) as { passed?: boolean; report?: string };
  assert.equal(result.passed, true);
  assert(typeof result.report === 'string' && result.report.startsWith(join(repo, 'tmp') + sep), 'Checker report escaped its temporary root');
  return { report: result.report };
}

function readReleases(): readonly Release[] {
  const value = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases`], { cwd: repo, encoding: 'utf8' })) as readonly (readonly Release[])[];
  return value.flat();
}

async function readFixtureMetadata(directory: string): Promise<FixtureMetadata> {
  const metadata = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8')) as FixtureMetadata;
  assert.equal(metadata.kind, 'tenon-data-fixture'); assert.equal(metadata.version, 1);
  assert(valid(metadata.applicationVersion), `Invalid fixture application version in ${directory}`);
  assert(typeof metadata.sourceRevision === 'string' && /^[0-9a-f]{40}$/u.test(metadata.sourceRevision), 'Invalid fixture source revision');
  return metadata;
}

async function copyReport(source: string, name: string): Promise<void> { await cp(source, join(root, name)); }
function verifyArchiveEntries(listing: string): void {
  for (const entry of listing.split('\n').filter(Boolean)) if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`Compatibility fixture archive escapes its extraction root: ${entry}`);
}

interface FixtureMetadata { kind: 'tenon-data-fixture'; version: 1; applicationVersion: string; sourceRevision: string; sourceDirty: boolean; loroVersion: string }
interface Release { readonly tag_name: string; readonly draft?: boolean; readonly prerelease?: boolean; readonly assets: readonly { readonly name: string }[] }
