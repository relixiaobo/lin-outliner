import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SELF = 'tests/core/agentCodexLegacyResidue.test.ts';

// Standing authorities under `plans/reference/` record the arc that replaced the
// legacy model, so they name it by design. Listed one by one rather than
// exempting the directory: a new reference document gets no free pass. Terminal
// plans under `plans/archive/` are covered by the prefix rule below. Active
// code, tests, and specs have no such exception.
const PLANS_WITH_SCOPED_LEGACY_ASSERTIONS = new Set([
  'docs/plans/reference/agent-conversation-model.md',
  'docs/plans/reference/agent-data-model.md',
  'docs/plans/reference/agent-memory-foundations.md',
  'docs/plans/reference/agent-program.md',
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
    label: 'legacy scheduled-agent identity',
    pattern: /\b(?:AgentRecurringIssue\w*|RecurringIssue\w*|recurringIssue\w*)\b|['"]recurring-issue['"]/,
  },
  {
    label: 'legacy model tool',
    pattern: /\b(?:ask_user_question|agent_session_start|agent_session_read|agent_session_send_message|agent_session_stop|past_chats|internal_delegation)\b/,
  },
  {
    // Automations were ported from the Codex app, and its `codex_app.` tool
    // namespace came along into our own catalog. Host tools carry no vendor
    // namespace; `namespace` exists for MCP servers and plugins. No `\b`: the
    // flat provider form `codex_app__automation_update` is the string the
    // provider's 400 named, and `_` is a word character, so a trailing word
    // boundary matches the canonical form only.
    label: 'vendor-namespaced host tool',
    pattern: /codex_app/,
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
  // A moved or renamed plan turns its exemption into dead config that silently
  // stops covering anything — which is how the `plans/reference/` split broke
  // this guard. Fail on the stale path instead of on the residue it lets through.
  test('keeps every scoped legacy-assertion exemption pointing at a real plan', () => {
    const missing = [...PLANS_WITH_SCOPED_LEGACY_ASSERTIONS]
      .filter((rel) => !existsSync(join(ROOT, rel)))
      .sort();
    expect(missing).toEqual([]);
  });

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

  test('keeps scheduled agent execution under the canonical Automation owner', () => {
    const scheduledAgentModules = walk(join(ROOT, 'src', 'main'))
      .map((file) => relative(ROOT, file))
      .filter((file) => (
        /agent.*(?:schedule|recurr)|(?:schedule|recurr).*agent/i.test(file)
      ))
      .sort();
    expect(scheduledAgentModules).toEqual([
      'src/main/agent/automations/AutomationSchedule.ts',
      'src/main/agent/automations/AutomationScheduler.ts',
    ]);
  });
});

// Active surface only: `src`, `tests`, and the two documentation trees that
// describe current behavior. `docs/TASKS.md` and `CHANGELOG.md` are records of
// what happened rather than statements of what is true now, so a retired name
// survives there by design and this guard deliberately does not reach them.
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
