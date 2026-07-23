import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SELF = 'tests/core/agentCodexLegacyResidue.test.ts';

// Main archives these superseded or destructive plans together with its board
// update at the integration gate. Active code, tests, and specs have no such
// exception.
const PLANS_WITH_SCOPED_LEGACY_ASSERTIONS = new Set([
  'docs/plans/agent-codex-core.md',
  'docs/plans/agent-codex-automations.md',
  'docs/plans/agent-codex-memory.md',
  'docs/plans/agent-conversation-model.md',
  'docs/plans/agent-data-model.md',
  'docs/plans/agent-memory-foundations.md',
  'docs/plans/agent-program.md',
]);

const LEGACY_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  {
    label: 'legacy identity field',
    pattern: /\b(?:activeConversationId|conversationId|runId|issueId|channelId)\b/,
  },
  {
    label: 'legacy domain identifier',
    pattern: /\b(?:AgentChatPanel|AgentRunsPanel|AgentIssuesPanel|AgentRunDetailsPanel|ChannelConfigWindow|DreamLauncher|DreamHistoryGroup|AgentPastChats\w*|AgentDream\w*|AgentIssue\w*|AgentRunLedger|AgentRunProfiles|AgentRunStateMachine)\b/,
  },
  {
    label: 'legacy domain type',
    pattern: /\b(?:AgentDefinition|AgentSessionState|AgentSession|AgentRunMeta|AgentRunRecord|AgentRunStatus|AgentRunProfileId)\b/,
  },
  {
    label: 'legacy module identifier',
    pattern: /\bagent(?:Channel|Conversation|EventLog|Issue|Dream|PastChats|RunLedger|RunProfiles|RunStateMachine)\w*\b/,
  },
  {
    label: 'legacy CSS surface',
    pattern: /\bagent-(?:composer|debug|issue|channel|dream|run-detail|runtime|transcript)\b|\bsettings-(?:agents|memory)\b/,
  },
  {
    label: 'legacy persisted storage',
    pattern: /\b(?:conversations|runs|principals)\/|\bissue-operations\.jsonl\b/,
  },
  {
    label: 'legacy model tool',
    pattern: /\b(?:ask_user_question|agent_session_start|agent_session_read|agent_session_send_message|agent_session_stop|past_chats|internal_delegation)\b/,
  },
  {
    label: 'legacy profile terminology',
    pattern: /\bagent[- ]profiles?\b/i,
  },
  {
    label: 'legacy Run working-directory terminology',
    pattern: /\brun[- ]workdir\b/i,
  },
  {
    label: 'legacy Run execution scope terminology',
    pattern: /\b(?:node-scoped run|run scope|run receives)\b/i,
  },
];

describe('Agent Core clean replacement', () => {
  test('keeps active source, tests, specs, and non-superseded plans free of legacy model residue', () => {
    const violations: string[] = [];
    for (const file of scanFiles()) {
      const rel = relative(ROOT, file);
      if (
        rel === SELF
        || rel.startsWith('docs/plans/archive/')
        || PLANS_WITH_SCOPED_LEGACY_ASSERTIONS.has(rel)
      ) continue;
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        for (const { label, pattern } of LEGACY_PATTERNS) {
          if (pattern.test(line)) violations.push(`${rel}:${index + 1} ${label}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('keeps retained main-process capabilities under the canonical agent ownership tree', () => {
    const flatAgentModules = readdirSync(join(ROOT, 'src', 'main'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^agent[A-Z].*\.ts$/.test(entry.name))
      .map((entry) => entry.name);
    expect(flatAgentModules).toEqual([]);
  });
});

function scanFiles(): string[] {
  return [
    ...walk(join(ROOT, 'src')),
    ...walk(join(ROOT, 'tests')),
    ...walk(join(ROOT, 'docs', 'spec')),
    ...walk(join(ROOT, 'docs', 'plans')),
  ];
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && /\.(?:css|md|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
