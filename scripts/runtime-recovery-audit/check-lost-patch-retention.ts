import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const auditRoot = `${root}/tmp/runtime-recovery-audit`;
const lostParent = requiredEnvironmentValue('RUNTIME_RECOVERY_LOST_PARENT');
const lostSnapshot = requiredEnvironmentValue('RUNTIME_RECOVERY_LOST_SNAPSHOT');
const rows: string[] = [];

for (const line of readFileSync(`${auditRoot}/lost-snapshot-disposition.tsv`, 'utf8').trim().split('\n')) {
  const [change, state, path] = line.split('\t');
  if (state !== 'evolved' || !change || !path) continue;
  const patch = execFileSync('git', ['diff', '--binary', `${lostParent}..${lostSnapshot}`, '--', path], {
    cwd: root,
    encoding: 'utf8',
  });
  const check = spawnSync('git', ['apply', '--reverse', '--check', '-'], {
    cwd: root,
    input: patch,
    encoding: 'utf8',
  });
  rows.push(`${check.status === 0 ? 'patch-retained' : 'overlap-review'}\t${change}\t${path}`);
}

writeFileSync(`${auditRoot}/lost-snapshot-patch-retention.tsv`, `${rows.join('\n')}\n`);
console.log(rows.join('\n'));

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
