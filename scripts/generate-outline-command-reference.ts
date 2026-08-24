import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderOutlineCommandReference } from '../src/outline/contract/commandReference';

const repoRoot = path.resolve(import.meta.dir, '..');
const output = path.join(
  repoRoot,
  'src',
  'main',
  'builtInSkills',
  'outline',
  'references',
  'commands.md',
);
const rendered = renderOutlineCommandReference();

if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8').catch(() => '');
  if (current !== rendered) {
    console.error('Outline command reference is stale. Run: bun scripts/generate-outline-command-reference.ts');
    process.exit(1);
  }
  console.log('Outline command reference matches the capability registry.');
} else {
  await writeFile(output, rendered, 'utf8');
  console.log(`Generated ${path.relative(repoRoot, output)}`);
}
