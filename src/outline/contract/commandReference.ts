import {
  OUTLINE_CAPABILITIES,
  OUTLINE_COMMAND_FAMILIES,
  OUTLINE_GLOBAL_OPTIONS,
  type OutlineCapability,
} from './capabilities';
import type { CommandOptionHelp } from './porcelain';

const GENERATED_NOTICE = '<!-- Generated from the Outline capability registry. Do not edit by hand. -->';

export function renderOutlineCommandReference(): string {
  const topLevelFamilies = OUTLINE_COMMAND_FAMILIES.filter((family) => !family.name.includes(' '));
  const directCommands = OUTLINE_CAPABILITIES.filter((capability) => !capability.name.includes(' '));
  const lines = [
    GENERATED_NOTICE,
    '',
    '# Outline Command Guide',
    '',
    'Use this guide to understand the complete public CLI surface and choose a command.',
    'Run `outline COMMAND --help` for the same command contract at runtime and',
    '`outline schema COMMAND` for its exact structured request and result schemas.',
    '',
    '## Choose an Execution Shape',
    '',
    '| Intent | Public shape |',
    '|---|---|',
    '| Read one known resource | `outline show` with an exact ID or stable alias |',
    '| Discover resources | `outline find` with a bounded text or structured query |',
    '| Create one complete resource | One porcelain `create` or `add` invocation |',
    '| Supply complex state for one resource | The same porcelain command with `--input FILE|-` |',
    '| Update one resource | One convergent `set`, `configure`, or leaf-edit invocation |',
    '| Change multiple dependent resources | One ChangeSet, one `diff`, and one `apply` |',
    '| Perform a bounded bulk mutation | One bounded selector or one ChangeSet; never a shell mutation loop |',
    '| Perform destructive or high-impact work | Preview and apply only the exact reviewed Diff |',
    '| Import external data | `import inspect`, `import plan`, exact `apply`, then `import verify` |',
    '| Recover a completed mutation | Inspect `log`, then `revert OPERATION_ID` |',
    '',
    '## Mutation Semantics',
    '',
    '- `create` and `add` explicitly create new semantic state.',
    '- Patch commands preserve omitted properties.',
    '- Replacement happens only through an explicitly documented replacement form.',
    '- Repeated `set`, `configure`, and `ensure` calls converge or return semantic no-change.',
    '- Every successful mutation returns one visible Operation or semantic no-change result.',
    '- Every `many` mutation is bounded by an explicit maximum.',
    '',
    '## Global Options',
    '',
    'Place global options before the command:',
    '',
    ...OUTLINE_GLOBAL_OPTIONS.map((option) => `- ${renderCompactOption(option)}: ${option.description}`),
    '',
    '## Command Families',
    '',
    '| Family | Purpose |',
    '|---|---|',
    ...topLevelFamilies.map((family) => `| \`${family.name}\` | ${family.summary} |`),
    '',
    'Root commands cover discovery, direct Node operations, ChangeSets, history, and lifecycle.',
    '',
    '## Root Commands',
    '',
    ...renderCapabilityTable(directCommands),
  ];

  for (const family of topLevelFamilies) {
    const commands = OUTLINE_CAPABILITIES.filter((capability) => (
      capability.name.startsWith(`${family.name} `)
    ));
    lines.push(
      `## ${titleCase(family.name)}`,
      '',
      family.summary,
      '',
      ...renderCapabilityTable(commands),
    );
  }

  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()}\n`;
}

function renderCapabilityTable(capabilities: readonly OutlineCapability[]): string[] {
  return [
    '| Command | Semantics | Purpose | Common syntax |',
    '|---|---|---|---|',
    ...capabilities.map(renderCapabilityRow),
    '',
  ];
}

function renderCapabilityRow(capability: OutlineCapability): string {
  const help = capability.help;
  const semantics = [
    help.behavior,
    help.idempotent ? 'idempotent' : 'not idempotent',
    help.destructive ? 'destructive review required' : undefined,
  ].filter(Boolean).join('; ');
  return `| \`outline ${capability.name}\` | ${escapeTable(semantics)} | ${escapeTable(help.summary)} | \`outline ${escapeTable(help.usage)}\` |`;
}

function renderCompactOption(option: CommandOptionHelp): string {
  const metadata = [
    option.default ? `default ${option.default}` : undefined,
    option.repeatable ? 'repeatable' : undefined,
  ].filter(Boolean).join(', ');
  return `\`--${option.name}${option.value ? ` ${option.value}` : ''}\`${metadata ? ` (${metadata})` : ''}`;
}

function titleCase(value: string): string {
  return value.split(' ').map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join(' ');
}

function escapeTable(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}
