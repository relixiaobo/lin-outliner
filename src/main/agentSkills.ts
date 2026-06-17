import { coerceString, parseBoolean } from '../core/agentMarkdown';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { AgentMessage, TextContent, UserMessage } from '../core/agentTypes';
import type { SkillDefinition } from '../core/types';
import { systemReminder } from '../core/agentAttachments';
// Runtime-only cycle: agentSkillAuthoring imports the shared resolver/hash from this
// module; we import its validator for the undo restore path. Neither side touches the
// other's bindings at module-evaluation time, so the cycle is safe under ESM.
import { AgentSkillAuthoringError, validateAgentSkillContentWrite } from './agentSkillAuthoring';
import {
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

export const SKILL_TOOL_NAME = 'skill';

const SKILL_FILE_NAME = 'SKILL.md';
const BUILT_IN_SKILL_RESOURCE_DIR_NAME = 'built-in-skills';
const BUILT_IN_SKILL_SOURCE_DIR = 'src/main/builtInSkills';
const SKILL_LISTING_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_SKILL_LISTING_CHAR_BUDGET = 8_000;
const MAX_LISTING_DESCRIPTION_CHARS = 250;
const MIN_NON_EMPTY_DESCRIPTION_CHARS = 20;
const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000;
const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000;
const SKILL_LISTING_STATE_MARKER = 'The following skills have already been listed to the agent in this session:';
const execFile = promisify(execFileCallback);
const requireForElectron = createRequire(import.meta.url);
const DEFAULT_BUILT_IN_SKILLS: readonly BuiltInSkillInput[] = [{
  name: 'skillify',
  description: 'Create or update a local agent skill from an explicit user workflow request.',
  whenToUse: 'Use when the user asks to save, update, or turn a workflow into a reusable skill.',
  body: [
    'Skillify v2 workflow:',
    '',
    'Use this workflow only when the user explicitly asks to save, create, update, or fix a reusable Tenon skill. Do not silently curate skills in the background.',
    '',
    '1. Understand before asking.',
    '   - Inspect the current conversation for the repeatable process, inputs, outputs, constraints, user corrections, required artifacts, tool needs, and success criteria.',
    '   - Do not over-interview. For a simple explicit request, ask only for missing name, storage, or trigger details. For ambiguous or broad workflows, run a short structured interview.',
    '   - Use `ask_user_question` when available for real choices; otherwise ask concise plain-language questions in the conversation.',
    '',
    '2. Choose the Tenon skill identity and storage target.',
    '   - Store personal workflows at `~/.agents/skills/<skill-name>/SKILL.md` and repo/workspace workflows at `<workspace>/.agents/skills/<skill-name>/SKILL.md`.',
    '   - Normalize `<skill-name>` to a stable directory name. Do not write `name:` frontmatter; identity comes from the directory name.',
    '   - Use only Tenon skill paths and the lowercase `skill` tool semantics. Do not mention or use other product namespaces or legacy command paths.',
    '   - Never edit built-in skills.',
    '',
    '3. Draft the supported `SKILL.md` shape.',
    '   - Use YAML frontmatter only for supported fields: `description`, `when_to_use`, `argument-hint`, `arguments`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `execution`, `agent`, and `paths`.',
    '   - Write a concise `description` and a precise `when_to_use` that includes positive examples and negative guidance for when not to auto-invoke.',
    '   - Add arguments only when future invocations need variable input.',
    '   - Default to `execution: inline`. Use `execution: isolated` only for self-contained work that benefits from context isolation, and set `agent` only when a specific agent definition is essential.',
    '   - Keep instructions step-by-step with success criteria, expected artifacts, hard rules, and human checkpoints where they matter.',
    '',
    '4. Keep creation and update paths distinct.',
    '   - For a new skill, draft one complete `SKILL.md` at the chosen skill path.',
    '   - For an existing skill, resolve and read the current `SKILL.md` first. Preserve existing frontmatter unless the user explicitly asked to change it or the workflow requires the change.',
    '   - Prefer a focused `file_edit` patch for existing skills. Use `file_write` for new skills, major rewrites, or malformed files that cannot be safely patched.',
    '',
    '5. Treat `allowed-tools` as an authored runtime contract.',
    '   - Separate authoring tools from runtime tools: tools used to create the skill are not automatically tools the future skill should preapprove.',
    '   - Omit `allowed-tools` when the future workflow does not need preapproval.',
    '   - Prefer narrow read/search rules. Keep writes, bash, external actions, and irreversible operations out of preapproval unless the workflow requires them and the rule can be narrow.',
    '   - Flag broad `allowed-tools` in the preview summary.',
    '',
    '6. Preview and confirm before writing.',
    '   - Show the complete `SKILL.md` for creation, or a focused diff for updates.',
    '   - Include a short review summary: storage target, slash invocation form, model invocation state, future `allowed-tools`, inline or isolated execution, and trust state.',
    '   - Ask "Save this skill?" with Save, revise, or cancel choices through `ask_user_question` when available. File permission only answers whether a write may happen; Skillify confirmation answers whether the reusable process is right.',
    '',
    '7. Write, report, and explain trust.',
    '   - Use `file_write` or `file_edit` only after confirmation. The file-tool gateway validates skill content, records rollback metadata in tool details, and hot-reloads the skill registry.',
    '   - After writing, report the exact path and how to invoke it as `/<skill-name> ...`.',
    '   - Agent-written skills and workspace skills are available immediately: slash invocation works immediately, and model-invocable skills can appear in the automatic listing without a separate trust prompt.',
    '   - If validation fails, repair the draft and show the corrected preview again when the change is material.',
    '',
    'Do not write executable or binary support files in this workflow. Do not copy secrets into skills.',
  ].join('\n'),
}, {
  name: 'create-agent',
  description: 'Create or edit a reusable local Tenon agent from an explicit user request.',
  whenToUse: 'Use when the user asks to create, build, draft, save, edit, update, revise, or turn instructions into a reusable custom agent.',
  argumentHint: '<agent purpose or instructions>',
  argumentNames: ['request'],
  body: [
    'Create-agent workflow:',
    '',
    'Use this workflow only when the user explicitly asks to create, build, draft, save, edit, update, revise, or turn instructions into a reusable Tenon agent. Do not silently create or modify agents in the background.',
    '',
    '1. Understand the requested agent before writing.',
    '   - Identify the agent purpose, when it should be used, expected inputs, normal outputs, tool needs, tone, constraints, and success criteria.',
    '   - Do not over-interview. For a simple explicit request, ask only for missing purpose, name, tool, or routing details. For broad or ambiguous requests, run a short structured interview.',
    '   - Use `ask_user_question` when available for real choices; otherwise ask concise plain-language questions in the conversation.',
    '',
    '2. Choose the Tenon agent identity and storage target.',
    '   - Store repo/workspace agents at `<workspace>/.agents/agents/<agent-name>/AGENT.md` by default.',
    '   - Store personal agents at `~/.agents/agents/<agent-name>/AGENT.md` only when the user explicitly asks for a personal/global agent and the file permission flow grants that write scope.',
    '   - Normalize `<agent-name>` to a stable lowercase directory name with letters, numbers, dots, underscores, or hyphens.',
    '   - Do not use reserved built-in names such as `assistant`, `fork`, or `neva`.',
    '   - For a new agent, choose a new directory.',
    '   - For an existing agent, resolve and read the current `AGENT.md` first. Prefer a focused `file_edit` patch. Use `file_write` only for a full replacement after reading the current file.',
    '   - Do not delete, move, rename, or create support files in this workflow.',
    '',
    '3. Draft a complete `AGENT.md`.',
    '   - Start with YAML frontmatter. Required fields: `name`, `description`, and `permission-mode: restricted`.',
    '   - Optional fields: `tools`, `disallowed-tools`, `skills`, `model`, `effort`, and `max-turns`.',
    '   - Do not set `background`; chat-authored agents cannot enable background mode.',
    '   - Keep optional frontmatter bounded: no broad `tools: ["*"]`, no giant lists, and `max-turns` must be 1-50 when present.',
    '   - Keep `description` routing-grade: one concise line explaining when to use this agent.',
    '   - Treat `tools` as a catalog filter, not a permission grant. Prefer narrow tool lists only when the agent truly should not see unrelated tools.',
    '   - Bind existing skills by name in `skills` only when they are essential to the agent identity.',
    '   - Write focused Markdown body instructions: role, operating style, workflow, constraints, interaction rules, and reporting format.',
    '',
    '4. Preview and confirm before writing.',
    '   - For new agents, show the complete `AGENT.md` and a short review summary: storage target, routing description, tool filter, bound skills, model/effort, and restricted permission mode.',
    '   - For existing agents, show a focused diff plus the post-edit summary, and call out any changes to routing description, tool filter, bound skills, model/effort, or body behavior.',
    '   - Ask "Create this agent?" or "Update this agent?" with create/update, revise, or cancel choices through `ask_user_question` when available. File permission only answers whether the write may happen; create-agent confirmation answers whether this is the right reusable agent.',
    '',
    '5. Write and report.',
    '   - Use `file_write` or `file_edit` only after confirmation.',
    '   - Write exactly one file: `<target>/.agents/agents/<agent-name>/AGENT.md`.',
    '   - The file-tool gateway validates the AGENT.md, rejects support files/deletes/trusted permission mode/reserved names/unsafe metadata, and hot-reloads the agent registry.',
    '   - After writing, report the exact path and say that the agent is available for future DMs, Channels, and delegation. The agent remains restricted and globally gated.',
    '',
    'Do not write agent support files. Do not copy secrets into agent definitions.',
  ].join('\n'),
}, {
  name: 'research',
  description: 'Research or explore a question in an isolated read-only child run.',
  whenToUse: 'Use when the user asks to research, explore, inspect, map, survey, or verify context before deciding or editing. Examples: "research this area", "explore how backlinks work", "verify this assumption", "find the relevant files". Do not use for direct implementation or edits.',
  argumentHint: '<question or area to research>',
  argumentNames: ['question'],
  execution: 'isolated',
  readOnlyIsolated: true,
  allowedTools: [
    'node_search',
    'node_read',
    'file_read',
    'file_glob',
    'file_grep',
    'web_search',
    'web_fetch',
    'recall',
  ],
  body: [
    'You are a codebase research specialist running in an isolated child run of the current Tenon agent. You excel at thoroughly navigating and exploring existing context.',
    '',
    '=== CRITICAL: READ-ONLY MODE - NO MODIFICATIONS ===',
    'This is a read-only exploration task. You are strictly prohibited from:',
    '- Creating new files or support artifacts anywhere, including temporary files',
    '- Modifying, deleting, moving, or copying existing files or outliner nodes',
    '- Changing settings, installing dependencies, committing, or running shell commands',
    '- Invoking skills or spawning, messaging, or stopping child agents',
    '',
    'Your role is exclusively to search, read, analyze, and report. The runtime also narrows your tool catalog to read-only tools; if a task needs edits, report the relevant findings and stop.',
    '',
    'Your strengths:',
    '- Rapidly finding relevant files, nodes, specs, tests, and prior context',
    '- Searching code and text with multiple keyword, symbol, and naming strategies',
    '- Reading and connecting several files or nodes to understand architecture and behavior',
    '- Investigating complex questions that require multi-step exploration',
    '',
    'Guidelines:',
    '1. Restate the concrete research question and scope before searching.',
    '2. Prefer local evidence first: node_search/node_read for outline context, file_glob for broad file pattern matching, file_grep for content and regex search, file_read when you know the specific path, and recall for relevant memory.',
    '3. Start broad and narrow down. Use multiple search strategies if the first one does not find the right files; check related names, conventions, tests, specs, and call sites.',
    '4. Adapt thoroughness to the caller: quick means basic targeted searches; medium means moderate exploration across likely locations; very thorough means comprehensive analysis across multiple locations and naming conventions.',
    '5. Make efficient use of read/search tools. When independent searches or reads do not depend on each other, issue them in parallel.',
    '6. Use web_search/web_fetch only when the question needs current or external information, or cannot be answered from local context.',
    '7. Distinguish direct evidence from inference. Cite file paths, node references, memory references, or web URLs for every important finding.',
    '8. Keep the result compact and useful to the caller. Do not include a tool-by-tool diary.',
    '',
    'Return this shape:',
    '',
    'Findings',
    '- ...',
    '',
    'Evidence',
    '- ...',
    '',
    'Confidence',
    '- High/medium/low, with the reason.',
    '',
    'Open questions',
    '- ...',
    '',
    'Next probes',
    '- ...',
  ].join('\n'),
}];

const SKILL_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['skill'],
  properties: {
    skill: {
      type: 'string',
      minLength: 1,
      description: 'The skill name, for example "commit", "review-pr", or "pdf". A leading slash is accepted.',
    },
    args: {
      type: 'string',
      description: 'Optional arguments to pass to the skill.',
    },
  },
};



export interface InvokedSkillRecord {
  skillName: string;
  skillPath: string;
  skillRoot?: string;
  content: string;
  invokedAt: number;
}

export interface SkillLoadOptions {
  localRoot?: string;
  includeUserSkills?: boolean;
  additionalSkillDirectories?: string[];
  builtInSkillDirectories?: string[];
  builtInSkills?: BuiltInSkillInput[];
  conversationId?: string;
  permissionScopeProvider?: () => string | null;
  executeSkillShell?: SkillShellExecutor;
  executeIsolatedSkill?: SkillIsolatedExecutor;
  provenanceStore?: AgentSkillProvenanceStore;
}

export interface BuiltInSkillResourceRootOptions {
  isPackaged?: boolean;
  resourcesPath?: string;
  moduleDir?: string;
}

/**
 * The single per-skill trust record, keyed by resolved skill file path. Provenance
 * (who produced the current bytes) and acceptance (which bytes the user accepted)
 * live side by side; ratification is derived from them, never stored.
 */
export interface AgentSkillProvenanceRecord {
  /** sha256 of the last SKILL.md content written through the agent file-tool path. */
  agentHash?: string;
  /** sha256 of the content the user explicitly accepted for automatic model use. */
  acceptedHash?: string;
  /** The one version preceding the last agent edit, for single-step undo. */
  previousVersion?: AgentSkillPreviousVersion;
}

export interface AgentSkillPreviousVersion {
  hash: string;
  content: string;
  /**
   * The agent-write hash that applied while this previous content was current
   * (undefined = the previous bytes were human-produced). Restored on undo so the
   * ratification derivation re-derives the pre-edit state.
   */
  agentHash?: string;
}

/**
 * Persists per-skill trust records (agent-write provenance, user acceptance, one undo
 * version), so ratification survives a restart. The registry always keeps an in-memory
 * record as well, so within a conversation the gate holds even without a wired store.
 */
export interface AgentSkillProvenanceStore {
  load(): Promise<Record<string, AgentSkillProvenanceRecord>>;
  /** Persist one record verbatim; `null` deletes the key. */
  save(skillFile: string, record: AgentSkillProvenanceRecord | null): Promise<void>;
}

export interface BuiltInSkillInput {
  name: string;
  description: string;
  body: string;
  whenToUse?: string;
  userInvocable?: boolean;
  modelInvocable?: boolean;
  allowedTools?: string[];
  argumentHint?: string;
  argumentNames?: string[];
  version?: string;
  model?: string;
  effort?: string;
  execution?: 'inline' | 'isolated';
  agent?: string;
  paths?: string[];
  readOnlyIsolated?: boolean;
}

export interface SkillShellExecutionInput {
  skill: SkillDefinition;
  command: string;
  shell: string;
  signal?: AbortSignal;
}

export type SkillShellExecutor = (input: SkillShellExecutionInput) => Promise<string>;

interface InvokeSkillInput {
  skill: string;
  args?: string;
  trigger: 'agent' | 'slash';
  parentToolCallId?: string;
  signal?: AbortSignal;
}

export interface SkillIsolatedExecutionInput {
  skill: SkillDefinition;
  renderedContent: string;
  args: string;
  trigger: 'agent' | 'slash';
  parentToolCallId?: string;
  readOnlyIsolated?: boolean;
}

export interface SkillIsolatedExecutionResult {
  agentId: string;
  agentType: string;
  status: string;
  result?: string;
  error?: string;
}

export type SkillIsolatedExecutor = (input: SkillIsolatedExecutionInput) => Promise<SkillIsolatedExecutionResult>;

export interface SkillListingReservation {
  text: string;
  skillNames: string[];
  entries: SkillListingStateEntry[];
}

export interface SkillListingStateEntry {
  name: string;
  identity?: string;
}

type SkillInvocationResult =
  | {
    ok: true;
    execution: 'inline' | 'isolated';
    skill: SkillDefinition;
    renderedContent: string;
    message: UserMessage;
    isolated?: SkillIsolatedExecutionResult;
  }
  | {
    ok: false;
    code: string;
    message: string;
    skill?: SkillDefinition;
  };

export interface SkillToolData {
  success: boolean;
  skill: string;
  status?: 'loaded' | 'isolated';
  allowedTools?: string[];
  model?: string;
  effort?: string;
  agent_id?: string;
  agent_type?: string;
  result?: string;
  error?: string;
}

export interface SkillTurnEffect {
  skill: string;
  model?: string;
  effort?: string;
}

class SkillListingState {
  private readonly entriesByName = new Map<string, string | null>();

  clear(): void {
    this.entriesByName.clear();
  }

  has(skill: SkillDefinition): boolean {
    const current = this.entriesByName.get(skill.name);
    if (current === undefined) return false;
    return current === null || current === skillListingIdentity(skill);
  }

  reserve(skills: readonly SkillDefinition[]): SkillListingStateEntry[] {
    const entries = skills.map((skill): SkillListingStateEntry => ({
      name: skill.name,
      identity: skillListingIdentity(skill),
    }));
    for (const entry of entries) {
      this.entriesByName.set(entry.name, entry.identity ?? null);
    }
    return entries;
  }

  release(entries: readonly SkillListingStateEntry[]): void {
    for (const entry of entries) {
      const normalized = normalizeSkillName(entry.name);
      if (!normalized) continue;
      const expectedIdentity = entry.identity ?? null;
      const current = this.entriesByName.get(normalized);
      if (current === expectedIdentity || expectedIdentity === null) {
        this.entriesByName.delete(normalized);
      }
    }
  }

  restore(entry: SkillListingStateEntry): void {
    const normalized = normalizeSkillName(entry.name);
    if (!normalized) return;
    const identity = entry.identity?.trim() || null;
    const current = this.entriesByName.get(normalized);
    if (current && !identity) return;
    this.entriesByName.set(normalized, identity);
  }

  entries(): SkillListingStateEntry[] {
    return [...this.entriesByName.entries()]
      .map(([name, identity]) => ({ name, identity: identity ?? undefined }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

export class AgentSkillRuntime {
  private readonly registry: SkillRegistry;
  private readonly conversationId: string;
  private readonly permissionScopeProvider?: () => string | null;
  private readonly executeSkillShell?: SkillShellExecutor;
  private readonly executeIsolatedSkill?: SkillIsolatedExecutor;
  private readonly listedSkills = new SkillListingState();
  private readonly pendingSteeringMessages: UserMessage[] = [];
  private readonly defaultActivePermissionRules = new Set<string>();
  private readonly activePermissionRulesByScope = new Map<string, Set<string>>();
  private pendingTurnEffect: SkillTurnEffect | null = null;
  private readonly invokedSkills = new Map<string, InvokedSkillRecord>();
  private disabledSkills: string[] = [];

  constructor(options: SkillLoadOptions = {}) {
    this.registry = new SkillRegistry(options);
    this.conversationId = options.conversationId?.trim() || 'lin-agent-conversation';
    this.permissionScopeProvider = options.permissionScopeProvider;
    this.executeSkillShell = options.executeSkillShell;
    this.executeIsolatedSkill = options.executeIsolatedSkill;
  }

  updateAdditionalSkillDirectories(directories: readonly string[]): void {
    this.registry.updateAdditionalSkillDirectories(directories);
  }

  updateDisabledSkills(disabledSkills: string[]): void {
    this.disabledSkills = disabledSkills;
  }

  resetConversationState(): void {
    this.listedSkills.clear();
    this.pendingSteeringMessages.length = 0;
    this.defaultActivePermissionRules.clear();
    this.activePermissionRulesByScope.clear();
    this.pendingTurnEffect = null;
    this.invokedSkills.clear();
  }

  resetRunPermissionRules(scope = this.currentPermissionScope()): void {
    if (scope) {
      this.activePermissionRulesByScope.delete(scope);
      return;
    }
    this.defaultActivePermissionRules.clear();
  }

  getActivePermissionRules(): string[] {
    return [...this.activePermissionRuleSet()];
  }

  async getActiveSkillReadRoots(): Promise<string[]> {
    const trustedRootsBySkill = new Map<string, string>();
    for (const skill of await this.registry.listAllSkills()) {
      const skillRoot = skillDirectoryForPrompt(skill);
      const skillName = normalizeSkillName(skill.name);
      if (skillRoot && skillName) trustedRootsBySkill.set(skillName, skillRoot);
    }
    const roots = new Set<string>();
    for (const skill of this.invokedSkills.values()) {
      const skillName = normalizeSkillName(skill.skillName);
      const expectedRoot = skillName ? trustedRootsBySkill.get(skillName) : undefined;
      if (expectedRoot && skill.skillRoot === expectedRoot) roots.add(expectedRoot);
    }
    return [...roots];
  }

  restoreInvokedSkillsFromMessages(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      for (const text of messageTextParts(message)) {
        for (const skillName of parseListedSkillNamesFromText(text)) {
          this.listedSkills.restore({ name: skillName });
        }
        for (const entry of parseListedSkillStateEntriesFromText(text)) {
          this.listedSkills.restore(entry);
        }
        for (const skill of parseInvokedSkillsFromText(text)) {
          this.invokedSkills.set(skill.skillName, skill);
        }
        const loaded = parseLoadedSkillFromText(text);
        if (loaded) this.invokedSkills.set(loaded.skillName, loaded);
      }
    }
  }

  async buildSkillListingMessage(contextWindowTokens?: number | null): Promise<UserMessage | null> {
    const text = await this.buildSkillListingReminderText(contextWindowTokens);
    return text ? createHiddenUserMessage(text) : null;
  }

  async buildSkillListingReminderText(contextWindowTokens?: number | null): Promise<string | null> {
    return (await this.reserveSkillListingReminderText(contextWindowTokens))?.text ?? null;
  }

  async reserveSkillListingReminderText(contextWindowTokens?: number | null): Promise<SkillListingReservation | null> {
    const skills = await this.registry.getModelInvocableSkills();
    const newSkills = skills.filter((skill) => !this.listedSkills.has(skill) && !this.disabledSkills.includes(skill.name));
    if (newSkills.length === 0) return null;

    const content = formatSkillListing(newSkills, contextWindowTokens ?? undefined);
    if (!content) return null;

    const entries = this.listedSkills.reserve(newSkills);
    return {
      text: `The following skills are available for use with the ${SKILL_TOOL_NAME} tool:\n\n${content}`,
      skillNames: entries.map((entry) => entry.name),
      entries,
    };
  }

  releaseSkillListingReservation(reservation: SkillListingReservation): void {
    this.listedSkills.release(reservation.entries);
  }

  async buildSkillListingContent(contextWindowTokens?: number | null): Promise<TextContent | null> {
    const message = await this.buildSkillListingMessage(contextWindowTokens);
    const first = Array.isArray(message?.content) ? message.content[0] : null;
    return first?.type === 'text' ? first : null;
  }

  enqueueSteeringMessage(message: UserMessage): void {
    this.pendingSteeringMessages.push(message);
  }

  drainSteeringMessages(): UserMessage[] {
    const messages = this.pendingSteeringMessages.slice();
    this.pendingSteeringMessages.length = 0;
    return messages;
  }

  consumePendingTurnEffect(): SkillTurnEffect | null {
    const effect = this.pendingTurnEffect;
    this.pendingTurnEffect = null;
    return effect;
  }

  async notifyFileTouched(filePaths: string[]): Promise<void> {
    const changed = await this.registry.activateForFilePaths(filePaths);
    if (!changed) return;
    const listing = await this.buildSkillListingMessage();
    if (listing) this.enqueueSteeringMessage(listing);
  }

  async notifySkillContentWritten(_filePaths: string[]): Promise<void> {
    this.registry.reloadAll();
    const listing = await this.buildSkillListingMessage();
    if (listing) this.enqueueSteeringMessage(listing);
  }

  resolveSkillTarget(filePath: string): AgentSkillContentTarget | null {
    return this.registry.resolveSkillTarget(filePath);
  }

  async recordAgentSkillWrite(
    skillFile: string,
    contentHash: string,
    previous?: { hash: string; content: string } | null,
  ): Promise<void> {
    await this.registry.recordAgentSkillWrite(skillFile, contentHash, previous);
  }

  async acceptSkill(name: string, expectedHash: string): Promise<void> {
    await this.registry.acceptSkill(name, expectedHash);
  }

  async revokeSkillAcceptance(name: string): Promise<void> {
    await this.registry.revokeSkillAcceptance(name);
  }

  async undoLastAgentSkillEdit(name: string): Promise<void> {
    await this.registry.undoLastAgentEdit(name);
  }

  /**
   * Re-derive trust from the persisted store after a trust change made through a
   * different runtime (the Settings panel runs conversationless). A freshly ratified
   * skill is steered into the conversation's model listing like any skill write.
   */
  async refreshTrustRecords(): Promise<void> {
    this.registry.refreshTrustRecords();
    const listing = await this.buildSkillListingMessage();
    if (listing) this.enqueueSteeringMessage(listing);
  }

  async getSkill(name: string): Promise<SkillDefinition | null> {
    return this.registry.resolveSkill(name);
  }

  async listUserInvocableSkills(): Promise<SkillDefinition[]> {
    const skills = await this.registry.getUserInvocableSkills();
    return skills.filter((skill) => !this.disabledSkills.includes(skill.name));
  }

  async listAllSkills(): Promise<SkillDefinition[]> {
    return this.registry.listAllSkills();
  }

  async invokeSkill(input: InvokeSkillInput): Promise<SkillInvocationResult> {
    const requestedName = normalizeSkillName(input.skill);
    if (!requestedName) {
      return { ok: false, code: 'invalid_skill', message: `Invalid skill format: ${input.skill}` };
    }

    let skill = await this.registry.resolveSkill(requestedName);
    if (!skill) {
      return { ok: false, code: 'unknown_skill', message: `Unknown skill: ${requestedName}` };
    }
    if (this.disabledSkills.includes(skill.name)) {
      return { ok: false, code: 'skill_disabled', message: `Skill ${skill.name} is currently disabled in settings.` };
    }
    if (input.trigger === 'agent' && !skill.modelInvocable) {
      return {
        ok: false,
        code: 'model_invocation_disabled',
        message: `Skill ${skill.name} cannot be used with the ${SKILL_TOOL_NAME} tool due to disable-model-invocation.`,
        skill,
      };
    }
    if (input.trigger === 'slash' && !skill.userInvocable) {
      return {
        ok: false,
        code: 'user_invocation_disabled',
        message: `This skill can only be invoked by the agent, not directly by users. Ask the agent to use the "${skill.name}" skill for you.`,
        skill,
      };
    }
    let renderedContent: string;
    try {
      renderedContent = await renderSkillContent(skill, input.args ?? '', this.conversationId, this.executeSkillShell, input.signal);
    } catch (error) {
      return {
        ok: false,
        code: 'skill_shell_failed',
        message: error instanceof Error ? error.message : String(error),
        skill,
      };
    }

    if (skill.execution === 'isolated') {
      if (!this.executeIsolatedSkill) {
        return {
          ok: false,
          code: 'isolated_execution_not_supported',
          message: `Skill ${skill.name} requests isolated execution, but no isolated executor is available in this runtime.`,
          skill,
        };
      }
      try {
        const isolated = await this.executeIsolatedSkill({
          skill,
          renderedContent,
          args: input.args ?? '',
          trigger: input.trigger,
          parentToolCallId: input.parentToolCallId,
          readOnlyIsolated: this.registry.isBuiltInReadOnlyIsolatedSkill(skill),
        });
        return {
          ok: true,
          execution: 'isolated',
          skill,
          renderedContent,
          message: createIsolatedSkillResultMessage(skill, isolated, input.trigger === 'slash'),
          isolated,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          code: 'isolated_execution_failed',
          message,
          skill,
        };
      }
    }

    this.recordInvokedSkill(skill, renderedContent);
    this.recordPermissionRules(skill);
    this.recordTurnEffect(skill);
    return {
      ok: true,
      execution: 'inline',
      skill,
      renderedContent,
      message: createSkillLoadedMessage(skill, renderedContent, input.trigger === 'slash'),
    };
  }

  createSlashPromptMessage(
    originalInput: string,
    invocation: Extract<SkillInvocationResult, { ok: true }>,
    turnReminder?: string | null,
  ): UserMessage {
    const hidden = messageText(invocation.message);
    const content: TextContent[] = [{ type: 'text', text: hidden }];
    if (turnReminder) {
      content.push({ type: 'text', text: systemReminder(turnReminder) });
    }
    content.push({ type: 'text', text: originalInput.trim() });
    return {
      role: 'user',
      timestamp: Date.now(),
      content,
    };
  }

  createInvokedSkillsReminder(): UserMessage | null {
    const skills = buildInvokedSkillsForReminder(this.invokedSkills);
    if (skills.length === 0) return null;
    const content = skills
      .map((skill) => `### Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`)
      .join('\n\n---\n\n');
    return createHiddenUserMessage(
      `The following skills were invoked in this session. Continue to follow these guidelines:\n\n${content}`,
    );
  }

  createSkillListingStateReminder(): UserMessage | null {
    const entries = this.listedSkills.entries();
    if (entries.length === 0) return null;
    return createHiddenUserMessage([
      SKILL_LISTING_STATE_MARKER,
      '',
      ...entries.map(formatPersistedListingStateEntry),
    ].join('\n'));
  }

  private recordInvokedSkill(skill: SkillDefinition, renderedContent: string): void {
    const skillRoot = skillDirectoryForPrompt(skill) ?? undefined;
    this.invokedSkills.set(skill.name, {
      skillName: skill.name,
      skillPath: skillPathForPrompt(skill),
      ...(skillRoot ? { skillRoot } : {}),
      content: renderedContent,
      invokedAt: Date.now(),
    });
  }

  private recordPermissionRules(skill: SkillDefinition): void {
    const rules = this.activePermissionRuleSet();
    for (const rule of skill.allowedTools) {
      rules.add(rule);
    }
  }

  private recordTurnEffect(skill: SkillDefinition): void {
    if (!skill.model && !skill.effort) return;
    this.pendingTurnEffect = mergeSkillTurnEffects(this.pendingTurnEffect, {
      skill: skill.name,
      model: skill.model,
      effort: skill.effort,
    });
  }

  private currentPermissionScope(): string | null {
    return this.permissionScopeProvider?.() ?? null;
  }

  private activePermissionRuleSet(): Set<string> {
    const scope = this.currentPermissionScope();
    if (!scope) return this.defaultActivePermissionRules;
    let scoped = this.activePermissionRulesByScope.get(scope);
    if (!scoped) {
      scoped = new Set();
      this.activePermissionRulesByScope.set(scope, scoped);
    }
    return scoped;
  }
}

function mergeSkillTurnEffects(previous: SkillTurnEffect | null, next: SkillTurnEffect): SkillTurnEffect {
  if (!previous) return { ...next };
  return {
    skill: next.skill,
    model: next.model ?? previous.model,
    effort: next.effort ?? previous.effort,
  };
}

export function createSkillTool(runtime: AgentSkillRuntime): AgentTool<any, ToolEnvelope<SkillToolData>> {
  return {
    name: SKILL_TOOL_NAME,
    label: 'Skill',
    description: [
      'Execute a skill within the main conversation',
      'When users ask you to perform tasks, check if any available skills match. Skills provide specialized capabilities and domain knowledge.',
      'When users reference a slash skill or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.',
      'How to invoke:',
      '- Use this tool with the skill name and optional arguments',
      '- Examples:',
      '  - `skill: "pdf"` - invoke the pdf skill',
      '  - `skill: "commit", args: "-m \'Fix bug\'"` - invoke with arguments',
      '  - `skill: "review-pr", args: "123"` - invoke with arguments',
      'Important:',
      '- Available skills are listed in system-reminder messages in the conversation.',
      `- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant ${SKILL_TOOL_NAME} tool BEFORE generating any other response about the task.`,
      '- NEVER mention a skill without actually calling this tool.',
      '- Do not invoke a skill that is already running.',
      '- Do not use this tool for built-in commands.',
      '- If you see a <skill-name> tag in the current conversation turn, the skill has already been loaded. Follow the loaded instructions instead of calling this tool again.',
    ].join('\n'),
    parameters: SKILL_TOOL_PARAMETERS,
    executionMode: 'sequential',
    execute: async (toolCallId, rawParams: unknown, signal?: AbortSignal) => {
      const params = normalizeSkillToolParams(rawParams);
      const invocation = await runtime.invokeSkill({
        skill: params.skill,
        args: params.args,
        trigger: 'agent',
        parentToolCallId: toolCallId,
        signal,
      });

      if (!invocation.ok) {
        return {
          content: [{ type: 'text', text: invocation.message }],
          details: errorEnvelope<SkillToolData>(SKILL_TOOL_NAME, invocation.code, invocation.message, {
            data: { success: false, skill: normalizeSkillName(params.skill) || params.skill },
            instructions: 'Use only skills listed in the current skill listing reminder, or continue without a skill.',
          }),
        };
      }

      const data: SkillToolData = {
        success: true,
        skill: invocation.skill.name,
        status: invocation.execution === 'isolated' ? 'isolated' : 'loaded',
        allowedTools: invocation.skill.allowedTools.length > 0 ? invocation.skill.allowedTools : undefined,
        model: invocation.skill.model,
        effort: invocation.skill.effort,
        agent_id: invocation.isolated?.agentId,
        agent_type: invocation.isolated?.agentType,
        result: invocation.isolated?.result,
        error: invocation.isolated?.error,
      };
      if (invocation.execution === 'isolated') {
        const text = formatIsolatedSkillToolResult(invocation.skill, invocation.isolated);
        return {
          content: [{ type: 'text', text }],
          details: successEnvelope(SKILL_TOOL_NAME, data),
        };
      }

      runtime.enqueueSteeringMessage(invocation.message);
      return {
        content: [{ type: 'text', text: `Launching skill: ${invocation.skill.name}` }],
        details: successEnvelope(SKILL_TOOL_NAME, data),
      };
    },
  };
}

export function parseSkillSlashCommand(input: string): { skill: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return {
    skill: match[1] ?? '',
    args: match[2] ?? '',
  };
}

export async function createSlashSkillPrompt(
  runtime: AgentSkillRuntime,
  input: string,
  turnReminder?: string | null,
): Promise<UserMessage | null> {
  const parsed = parseSkillSlashCommand(input);
  if (!parsed) return null;
  const skill = await runtime.getSkill(parsed.skill);
  if (!skill) return null;

  const invocation = await runtime.invokeSkill({
    skill: parsed.skill,
    args: parsed.args,
    trigger: 'slash',
  });
  if (!invocation.ok) {
    throw new Error(invocation.message);
  }
  return runtime.createSlashPromptMessage(input, invocation, turnReminder);
}

export async function createUserSkillPrompt(
  runtime: AgentSkillRuntime,
  input: string,
  turnReminder?: string | null,
): Promise<UserMessage | null> {
  const slashPrompt = await createSlashSkillPrompt(runtime, input, turnReminder);
  if (slashPrompt || input.trim().startsWith('/')) return slashPrompt;

  const naturalLanguageSkill = parseNaturalLanguageSkillifyRequest(input);
  if (!naturalLanguageSkill) return null;

  const invocation = await runtime.invokeSkill({
    skill: naturalLanguageSkill.skill,
    args: naturalLanguageSkill.args,
    trigger: 'slash',
  });
  if (!invocation.ok) {
    return null;
  }
  return runtime.createSlashPromptMessage(input, invocation, turnReminder);
}

export function parseNaturalLanguageSkillifyRequest(input: string): { skill: 'skillify'; args: string } | null {
  const args = input.trim();
  if (!args || args.startsWith('/')) return null;

  const normalized = args.toLowerCase().replace(/\s+/g, ' ');
  if (!/\bskills?\b/.test(normalized) && !/\bskillify\b/.test(normalized)) return null;
  if (isSkillQuestion(normalized)) return null;

  // Update/fix requires a singular skill artifact; plural "skills" is usually
  // human capability or ordinary outline content, not a Tenon skill file.
  const explicitSkillAuthoring = [
    /^(?:please\s+)?skillify\b/,
    /\b(?:can you|could you|would you|please|let's)\s+skillify\b/,
    /\b(?:save|capture|record|preserve)\b.{0,120}\bas\s+(?:a\s+)?(?:reusable\s+)?skill\b/,
    /\bturn\b.{0,120}\binto\s+(?:a\s+)?(?:reusable\s+)?skill\b/,
    /\b(?:create|make|write|draft|author)\b.{0,80}\b(?:a|an|the|new|reusable|local|tenon)\s+skill\b(?!\s+(?:tree|check|list|sheet|section|node|outline|matrix|map))/,
    /\b(?:update|patch|amend|revise|improve|fix|repair)\b.{0,80}\b(?:the|this|that|my|our|existing|current)\s+(?:[a-z0-9-]+\s+){0,4}skill\b(?!\s+(?:tree|check|list|sheet|section|node|outline|matrix|map))/,
  ].some((pattern) => pattern.test(normalized));

  return explicitSkillAuthoring ? { skill: 'skillify', args } : null;
}

function isSkillQuestion(input: string): boolean {
  return /^(?:how|what|why|when|where|which)\b/.test(input)
    || /\b(?:how do i|how can i|what is|what are|do we have|is there|are there)\b.{0,120}\bskills?\b/.test(input)
    || /\b(?:tell me about|explain|describe)\b.{0,80}\b(?:skillify|skills?)\b/.test(input);
}

class SkillRegistry {
  private readonly root: string;
  private readonly includeUserSkills: boolean;
  private readonly builtInSkillDirectories: string[];
  private readonly builtInSkills: BuiltInSkillInput[];
  private readonly builtInReadOnlyIsolatedSkills: Set<string>;
  private additionalSkillDirectories: string[];
  private loaded = false;
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly conditionalSkills = new Map<string, SkillDefinition>();
  private readonly checkedDynamicSkillDirs = new Set<string>();
  private readonly seenSkillFileIds = new Set<string>();
  private loadPromise: Promise<void> | null = null;
  private loadGeneration = 0;
  // Per-skill trust records: agent-write provenance, user acceptance, one undo
  // version. Ratification is derived from these in addLoadedSkill, never stored.
  private readonly provenance = new Map<string, AgentSkillProvenanceRecord>();
  private readonly provenanceStore?: AgentSkillProvenanceStore;
  private provenanceLoaded = false;

  constructor(options: SkillLoadOptions) {
    this.root = path.resolve(options.localRoot ?? process.cwd());
    this.includeUserSkills = options.includeUserSkills ?? true;
    this.builtInSkillDirectories = normalizeBuiltInSkillDirectories(
      options.builtInSkillDirectories ?? [resolveBuiltInSkillResourceRoot()],
      this.root,
    );
    this.builtInSkills = options.builtInSkills ?? [...DEFAULT_BUILT_IN_SKILLS];
    this.builtInReadOnlyIsolatedSkills = new Set(
      this.builtInSkills
        .filter((skill) => skill.readOnlyIsolated === true)
        .map((skill) => normalizeSkillName(skill.name)),
    );
    this.additionalSkillDirectories = normalizeAdditionalSkillDirectories(options.additionalSkillDirectories, this.root);
    this.provenanceStore = options.provenanceStore;
  }

  isBuiltInReadOnlyIsolatedSkill(skill: SkillDefinition): boolean {
    return skill.source === 'built-in' && this.builtInReadOnlyIsolatedSkills.has(normalizeSkillName(skill.name));
  }

  async recordAgentSkillWrite(
    skillFile: string,
    contentHash: string,
    previous?: { hash: string; content: string } | null,
  ): Promise<void> {
    await this.ensureProvenanceLoaded();
    const normalized = path.resolve(skillFile);
    const existing = this.provenance.get(normalized);
    const record: AgentSkillProvenanceRecord = {
      agentHash: contentHash,
      // Acceptance is byte-keyed: a stale acceptedHash simply stops matching, so
      // a re-patched accepted skill clears accepted state without blocking use.
      ...(existing?.acceptedHash ? { acceptedHash: existing.acceptedHash } : {}),
      // Single-step undo keeps only the version preceding THIS write; a create
      // (previous == null) has nothing to restore.
      ...(previous
        ? { previousVersion: { hash: previous.hash, content: previous.content, ...(existing?.agentHash ? { agentHash: existing.agentHash } : {}) } }
        : {}),
    };
    this.provenance.set(normalized, record);
    try {
      await this.provenanceStore?.save(normalized, record);
    } catch {
      // The in-memory record still guards this conversation; a persistence failure must
      // not fail the skill write itself.
    }
  }

  async acceptSkill(name: string, expectedHash: string): Promise<void> {
    const skill = await this.resolveMutableSkill(name);
    // Closes the accept TOCTOU: the user accepts the bytes they SAW, not whatever is
    // loaded at execution time. An agent write landing between render and click
    // changes the hash and the accept is refused instead of ratifying sight-unseen.
    if (expectedHash !== skill.contentHash) {
      throw new Error(`Skill ${skill.name} changed since it was displayed. Review the skill again before accepting.`);
    }
    const normalized = path.resolve(skill.skillFile);
    const record: AgentSkillProvenanceRecord = {
      ...(this.provenance.get(normalized) ?? {}),
      acceptedHash: skill.contentHash,
    };
    // Acceptance exists to be durable: persist first and surface a failure instead
    // of holding an in-memory-only "accepted" state that silently vanishes on restart.
    await this.provenanceStore?.save(normalized, record);
    this.provenance.set(normalized, record);
    this.reloadAll();
  }

  async revokeSkillAcceptance(name: string): Promise<void> {
    const skill = await this.resolveMutableSkill(name);
    const normalized = path.resolve(skill.skillFile);
    const { acceptedHash: _cleared, ...rest } = this.provenance.get(normalized) ?? {};
    const record = rest.agentHash || rest.previousVersion ? rest : null;
    await this.provenanceStore?.save(normalized, record);
    if (record) {
      this.provenance.set(normalized, record);
    } else {
      this.provenance.delete(normalized);
    }
    this.reloadAll();
  }

  /**
   * Single-step undo of the last agent edit: restore the one previous version the
   * gateway captured, through the same validator as agent writes, then re-derive
   * ratification from the restored provenance facts. Strictly one-shot — the
   * previous-version slot is consumed; deeper history is git's job.
   */
  async undoLastAgentEdit(name: string): Promise<void> {
    const skill = await this.resolveMutableSkill(name);
    const normalized = path.resolve(skill.skillFile);
    const existing = this.provenance.get(normalized);
    const previous = existing?.previousVersion;
    if (!previous) {
      throw new Error(`Skill ${skill.name} has no recorded previous version to restore.`);
    }
    // Undo may only overwrite the agent's own bytes. After a user hand-edit the
    // previous-version record lingers, but restoring over it would silently destroy
    // user content with no way back — so the gate re-reads the file and requires the
    // on-disk content to still be exactly the last agent write (fresher than the
    // loaded snapshot, which also closes the render-to-click race).
    const currentRaw = await readFile(skill.skillFile, 'utf8');
    if (existing.agentHash === undefined || existing.agentHash !== skillContentHash(currentRaw)) {
      throw new Error(`Skill ${skill.name} was edited after the last agent write; undo would overwrite those edits.`);
    }
    const target = this.resolveSkillTarget(skill.skillFile);
    if (!target?.isSkillFile) {
      throw new Error(`Skill file for ${skill.name} no longer resolves to a governed skill path.`);
    }
    try {
      validateAgentSkillContentWrite({
        target,
        content: previous.content,
        previousContent: currentRaw,
        operation: 'file_write',
      });
    } catch (error) {
      if (error instanceof AgentSkillAuthoringError) {
        throw new Error(`Cannot restore the previous version of ${skill.name}: ${error.message}`);
      }
      throw error;
    }
    await writeFile(skill.skillFile, previous.content, 'utf8');
    // The file write is the primary mutation; provenance restore is best-effort like
    // the agent-write path (the in-memory record still guards this conversation).
    const record: AgentSkillProvenanceRecord = {
      ...(previous.agentHash ? { agentHash: previous.agentHash } : {}),
      ...(existing?.acceptedHash ? { acceptedHash: existing.acceptedHash } : {}),
    };
    const persisted = record.agentHash || record.acceptedHash ? record : null;
    if (persisted) {
      this.provenance.set(normalized, persisted);
    } else {
      this.provenance.delete(normalized);
    }
    try {
      await this.provenanceStore?.save(normalized, persisted);
    } catch {
      // Best-effort persistence; the restored file and in-memory record stand.
    }
    this.reloadAll();
  }

  private async resolveMutableSkill(name: string): Promise<SkillDefinition> {
    // Unlike invocation, trust actions must also reach paths:-conditional skills
    // that have not been activated yet — the Skills panel lists them (listAllSkills)
    // with full trust derivation, so their Accept/Revoke/Undo must resolve too.
    await this.ensureLoaded();
    const normalized = normalizeSkillName(name);
    const skill = normalized
      ? this.skills.get(normalized)
        ?? this.conditionalSkills.get(normalized)
        ?? [...this.skills.values(), ...this.conditionalSkills.values()]
          .find((candidate) => candidate.displayName === normalized)
        ?? null
      : null;
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    if (skill.source === 'built-in' || !skill.contentHash) {
      throw new Error(`Skill ${skill.name} is built-in and has no trust record to manage.`);
    }
    return skill;
  }

  /**
   * Re-derive trust for this registry from the persisted store: drop the in-memory
   * trust map and reload. Used to propagate a trust change made through ANOTHER
   * registry instance over the same store (each live conversation holds its own). The
   * in-memory-newer-wins merge is intentionally bypassed — after an explicit trust
   * action the store IS the newest state.
   */
  refreshTrustRecords(): void {
    this.provenance.clear();
    this.provenanceLoaded = false;
    this.reloadAll();
  }

  private async ensureProvenanceLoaded(): Promise<void> {
    if (this.provenanceLoaded) return;
    this.provenanceLoaded = true;
    if (!this.provenanceStore) return;
    try {
      for (const [skillFile, record] of Object.entries(await this.provenanceStore.load())) {
        // In-memory entries are newer than the persisted snapshot; don't overwrite.
        if (!this.provenance.has(path.resolve(skillFile))) {
          this.provenance.set(path.resolve(skillFile), record);
        }
      }
    } catch {
      // A corrupt provenance store must not break skill loading; the in-memory
      // record still guards the current conversation.
    }
  }

  updateAdditionalSkillDirectories(directories: readonly string[]): void {
    const normalized = normalizeAdditionalSkillDirectories(directories, this.root);
    if (sameStringList(this.additionalSkillDirectories, normalized)) return;
    this.additionalSkillDirectories = normalized;
    this.reloadAll();
  }

  resolveSkillTarget(filePath: string): AgentSkillContentTarget | null {
    return resolveSkillContentTarget(filePath, {
      root: this.root,
      includeUserSkills: this.includeUserSkills,
      additionalSkillDirectories: this.additionalSkillDirectories,
      builtInSkillDirectories: this.builtInSkillDirectories,
    });
  }

  reloadAll(): void {
    this.loaded = false;
    this.loadGeneration += 1;
    this.skills.clear();
    this.conditionalSkills.clear();
    this.checkedDynamicSkillDirs.clear();
    this.seenSkillFileIds.clear();
  }

  async getModelInvocableSkills(): Promise<SkillDefinition[]> {
    await this.ensureLoaded();
    return [...this.skills.values()].filter((skill) => skill.modelInvocable && skill.ratified);
  }

  async getUserInvocableSkills(): Promise<SkillDefinition[]> {
    await this.ensureLoaded();
    return [...this.skills.values()].filter((skill) => skill.userInvocable);
  }

  async listAllSkills(): Promise<SkillDefinition[]> {
    await this.ensureLoaded();
    return [...this.skills.values(), ...this.conditionalSkills.values()]
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async resolveSkill(name: string): Promise<SkillDefinition | null> {
    await this.ensureLoaded();
    const normalized = normalizeSkillName(name);
    if (!normalized) return null;
    return this.skills.get(normalized)
      ?? [...this.skills.values()].find((skill) => skill.displayName === normalized)
      ?? null;
  }

  async activateForFilePaths(filePaths: string[]): Promise<boolean> {
    await this.ensureLoaded();
    let changed = false;
    const nestedDirs = await this.discoverSkillDirsForPaths(filePaths);
    for (const dir of nestedDirs) {
      // Nested .agents/skills dirs are always under the work root → project source.
      const loaded = await loadSkillsFromDir(dir, 'project');
      for (const skill of loaded) {
        if (await this.addLoadedSkill(skill)) changed = true;
      }
    }

    for (const skill of [...this.conditionalSkills.values()]) {
      if (!skill.paths?.length) continue;
      if (filePaths.some((filePath) => skillMatchesPath(skill, filePath, this.root))) {
        this.conditionalSkills.delete(skill.name);
        this.skills.set(skill.name, skill);
        changed = true;
      }
    }
    return changed;
  }

  private async ensureLoaded(): Promise<void> {
    while (!this.loaded) {
      const loadPromise = this.loadPromise ?? this.performLoad(this.loadGeneration);
      this.loadPromise = loadPromise;
      try {
        await loadPromise;
      } finally {
        if (this.loadPromise === loadPromise) {
          this.loadPromise = null;
        }
      }
    }
  }

  private async performLoad(loadGeneration: number): Promise<void> {
    await this.ensureProvenanceLoaded();
    this.skills.clear();
    this.conditionalSkills.clear();
    this.checkedDynamicSkillDirs.clear();
    this.seenSkillFileIds.clear();
    try {
      for (const dir of this.builtInSkillDirectories) {
        const loaded = await loadSkillsFromDir(dir, 'built-in');
        for (const skill of loaded) {
          await this.addLoadedSkill(skill);
        }
      }
      for (const skill of this.builtInSkills.map(createBuiltInSkillDefinition)) {
        await this.addLoadedSkill(skill);
      }
      const roots = skillSearchDirs(this.root, this.includeUserSkills, this.additionalSkillDirectories);
      for (const { dir, source } of roots) {
        const loaded = await loadSkillsFromDir(dir, source);
        for (const skill of loaded) {
          await this.addLoadedSkill(skill);
        }
      }
      if (this.loadGeneration === loadGeneration) {
        this.loaded = true;
      }
    } catch (error) {
      this.loaded = false;
      this.skills.clear();
      this.conditionalSkills.clear();
      this.checkedDynamicSkillDirs.clear();
      this.seenSkillFileIds.clear();
      throw error;
    }
  }

  private async addLoadedSkill(skill: SkillDefinition): Promise<boolean> {
    const existing = this.skills.get(skill.name) ?? this.conditionalSkills.get(skill.name);
    if (existing?.source === 'built-in') {
      if (skill.source === 'built-in') {
        throw new Error(`Duplicate built-in skill "${skill.name}" from ${skillPathForPrompt(existing)} and ${skillPathForPrompt(skill)}.`);
      }
      return false;
    }
    const fileId = skill.source === 'built-in'
      ? skillPathForPrompt(skill)
      : await skillFileIdentity(skill.skillFile);
    if (this.seenSkillFileIds.has(fileId)) return false;
    this.seenSkillFileIds.add(fileId);
    const record = this.provenance.get(path.resolve(skill.skillFile));
    const trust = deriveSkillTrust(skill, record);
    const skillWithIdentity = {
      ...skill,
      identity: normalizePathForPrompt(fileId),
      ratified: trust.ratified,
      accepted: trust.accepted,
      // Undo is offered only while the file still holds exactly the agent's bytes:
      // the previous-version record lingers after a user hand-edit, but restoring
      // over user content would silently destroy it (the action enforces the same
      // gate against the live file).
      canUndoLastAgentEdit: record?.previousVersion !== undefined
        && record.agentHash !== undefined
        && record.agentHash === skill.contentHash,
    };
    if (skill.paths?.length && skill.source !== 'built-in') {
      this.conditionalSkills.set(skill.name, skillWithIdentity);
    } else {
      this.skills.set(skill.name, skillWithIdentity);
    }
    return true;
  }

  private async discoverSkillDirsForPaths(filePaths: string[]): Promise<string[]> {
    const discovered: string[] = [];
    for (const filePath of filePaths) {
      const absolute = path.resolve(filePath);
      let current = path.dirname(absolute);
      while (isPathInside(current, this.root) && current !== this.root) {
        const skillDir = path.join(current, '.agents', 'skills');
        if (!this.checkedDynamicSkillDirs.has(skillDir)) {
          if (await directoryExists(skillDir)) {
            this.checkedDynamicSkillDirs.add(skillDir);
            if (!(await isGitIgnored(this.root, skillDir))) {
              discovered.push(skillDir);
            }
          }
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    return discovered.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  }
}

function deriveSkillTrust(
  skill: SkillDefinition,
  record: AgentSkillProvenanceRecord | undefined,
): { ratified: boolean; accepted: boolean } {
  const accepted = record?.acceptedHash !== undefined && record.acceptedHash === skill.contentHash;
  return { ratified: true, accepted };
}

export function resolveBuiltInSkillResourceRoot(options: BuiltInSkillResourceRootOptions = {}): string {
  const isPackaged = options.isPackaged ?? appIsPackaged();
  if (isPackaged) {
    const resourcesPath = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!resourcesPath) {
      throw new Error('Cannot resolve packaged built-in skill resources without process.resourcesPath.');
    }
    return path.join(resourcesPath, BUILT_IN_SKILL_RESOURCE_DIR_NAME);
  }
  const moduleDir = options.moduleDir ?? fileURLToPath(new URL('.', import.meta.url));
  return path.resolve(moduleDir, '../../', BUILT_IN_SKILL_SOURCE_DIR);
}

function appIsPackaged(): boolean {
  try {
    const electron = requireForElectron('electron') as typeof import('electron');
    return Boolean(electron.app?.isPackaged);
  } catch {
    return false;
  }
}

function skillSearchDirs(
  root: string,
  includeUserSkills: boolean,
  additionalSkillDirectories: readonly string[] = [],
): Array<{ dir: string; source: SkillDefinition['source'] }> {
  const dirs: Array<{ dir: string; source: SkillDefinition['source'] }> = [
    ...(includeUserSkills ? [
      { dir: path.join(homedir(), '.agents', 'skills'), source: 'user' },
    ] as Array<{ dir: string; source: SkillDefinition['source'] }> : []),
    { dir: path.join(root, '.agents', 'skills'), source: 'project' },
    ...additionalSkillDirectories.map((dir): { dir: string; source: SkillDefinition['source'] } => ({
      dir,
      source: isPathInside(dir, root) ? 'project' : 'user',
    })),
  ];
  const seen = new Set<string>();
  return dirs.filter((entry) => {
    const normalized = path.resolve(entry.dir);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/** A `.agents/skills/<name>/...` write target, resolved against the live skill-dir set. */
export interface AgentSkillContentTarget {
  skillName: string;
  skillRoot: string;
  skillsDir: string;
  source: SkillDefinition['source'];
  relativePath: string;
  isSkillFile: boolean;
}

/** Config that defines the skill-dir set. Shared by the loader and write governance. */
export interface SkillDirConfig {
  root: string;
  includeUserSkills: boolean;
  additionalSkillDirectories: readonly string[];
  builtInSkillDirectories?: readonly string[];
}

function targetInsideSkillsDir(
  filePath: string,
  skillsDirInput: string,
  source: SkillDefinition['source'],
): AgentSkillContentTarget | null {
  const skillsDir = path.resolve(skillsDirInput);
  if (!isPathInside(filePath, skillsDir)) return null;
  const parts = path.relative(skillsDir, filePath).split(path.sep).filter(Boolean);
  if (parts.length < 2) return null;
  const skillName = parts[0] ?? '';
  return {
    skillName,
    skillRoot: path.join(skillsDir, skillName),
    skillsDir,
    source,
    relativePath: parts.slice(1).join('/'),
    isSkillFile: parts.length === 2 && parts[1] === SKILL_FILE_NAME,
  };
}

/**
 * The single source of truth for "is this file a skill-content write, and which skill?".
 * Both the loader (via the registry) and write governance (the file-tool gateway and the
 * permission layer) resolve through this, so the two can never disagree. Built-in skills
 * are code-registered and have no writable directory, so a target is never `built-in`.
 */
export function resolveSkillContentTarget(
  filePathInput: string,
  config: SkillDirConfig,
): AgentSkillContentTarget | null {
  const filePath = path.resolve(filePathInput);
  const filePathIdentity = canonicalDirectoryIdentity(filePath);
  for (const dir of config.builtInSkillDirectories ?? []) {
    const builtInDir = path.resolve(dir);
    if (filePathIdentity === builtInDir || isPathInside(filePathIdentity, builtInDir)) return null;
  }
  // 1. The configured skill-dir set the loader enumerates (defaults + additional dirs).
  for (const { dir, source } of skillSearchDirs(config.root, config.includeUserSkills, config.additionalSkillDirectories)) {
    const target = targetInsideSkillsDir(filePath, dir, source);
    if (target) return target;
  }
  // 2. Nested .agents/skills under the work root (project) — matched by path so a
  //    brand-new nested skill dir is still governed on its first write.
  const root = path.resolve(config.root);
  if (!isPathInside(filePath, root)) return null;
  const parts = filePath.split(path.sep);
  for (let index = parts.length - 3; index >= 0; index -= 1) {
    if (parts[index] !== '.agents' || parts[index + 1] !== 'skills') continue;
    const skillsDir = parts.slice(0, index + 2).join(path.sep) || path.sep;
    const target = targetInsideSkillsDir(filePath, skillsDir, 'project');
    if (target) return target;
  }
  return null;
}

async function loadSkillsFromDir(
  skillsDir: string,
  source: SkillDefinition['source'],
): Promise<SkillDefinition[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const rootDir = path.join(skillsDir, entry.name);
    const skillFile = path.join(rootDir, SKILL_FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(skillFile, 'utf8');
    } catch {
      continue;
    }

    try {
      const parsed = parseSkillMarkdown(raw);
      skills.push(createSkillDefinition({
        name: entry.name,
        rootDir,
        skillFile,
        source,
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        contentHash: skillContentHash(raw),
      }));
    } catch (error) {
      console.warn(`Skipping invalid skill ${skillFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return skills;
}

/**
 * The canonical skill content hash, used by BOTH the provenance record (gateway, over
 * in-memory normalized content) and the loader (over raw disk bytes). Both sides must
 * hash the same domain or the ratification gate fails open: file tools normalize to
 * BOM-stripped LF in memory while writeTextFile restores the file's original CRLF/BOM
 * on disk, so hashing raw disk bytes would never match the recorded hash for a
 * CRLF/BOM skill an agent edited. Normalizing here is a no-op for LF files.
 */
export function skillContentHash(content: string): string {
  return createHash('sha256')
    .update(content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
    .digest('hex');
}

function createSkillDefinition(input: {
  name: string;
  rootDir: string;
  skillFile: string;
  source: SkillDefinition['source'];
  body: string;
  frontmatter: Record<string, unknown>;
  contentHash?: string;
}): SkillDefinition {
  const description = compactInlineText(
    coerceString(input.frontmatter.description)
      ?? extractDescriptionFromMarkdown(input.body, input.name),
  );
  const argumentNames = parseArgumentNames(input.frontmatter.arguments);
  const whenToUse = coerceString(input.frontmatter.when_to_use)
    ?? coerceString(input.frontmatter['when-to-use']);
  return {
    name: input.name,
    displayName: input.source === 'built-in' ? undefined : coerceString(input.frontmatter.name),
    source: input.source,
    rootDir: input.rootDir,
    skillFile: input.skillFile,
    description,
    hasUserSpecifiedDescription: coerceString(input.frontmatter.description) !== undefined,
    whenToUse: whenToUse ? compactInlineText(whenToUse) : undefined,
    userInvocable: parseBooleanFrontmatter(input.frontmatter['user-invocable'], true),
    modelInvocable: !parseBooleanFrontmatter(input.frontmatter['disable-model-invocation'], false),
    // Trust default; the registry flips this to false when the content hash matches a
    // recorded agent write (addLoadedSkill).
    ratified: true,
    contentHash: input.contentHash,
    allowedTools: parseToolListFromFrontmatter(input.frontmatter['allowed-tools']),
    argumentHint: coerceString(input.frontmatter['argument-hint']),
    argumentNames,
    version: coerceString(input.frontmatter.version),
    model: coerceString(input.frontmatter.model) === 'inherit'
      ? undefined
      : coerceString(input.frontmatter.model),
    effort: coerceString(input.frontmatter.effort),
    shell: coerceString(input.frontmatter.shell),
    execution: parseSkillExecutionFrontmatter(input.frontmatter),
    agent: coerceString(input.frontmatter.agent),
    paths: parsePathsFrontmatter(input.frontmatter.paths),
    contentLength: input.body.length,
    body: input.body,
  };
}

function createBuiltInSkillDefinition(input: BuiltInSkillInput): SkillDefinition {
  const frontmatter: Record<string, unknown> = {
    description: input.description,
    ...(input.whenToUse ? { when_to_use: input.whenToUse } : {}),
    ...(input.userInvocable === false ? { 'user-invocable': false } : {}),
    ...(input.modelInvocable === false ? { 'disable-model-invocation': true } : {}),
    ...(input.allowedTools?.length ? { 'allowed-tools': input.allowedTools } : {}),
    ...(input.argumentHint ? { 'argument-hint': input.argumentHint } : {}),
    ...(input.argumentNames?.length ? { arguments: input.argumentNames.join(' ') } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.execution === 'isolated' ? { execution: 'isolated' } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.paths?.length ? { paths: input.paths } : {}),
  };
  return createSkillDefinition({
    name: input.name,
    rootDir: `built-in/${input.name}`,
    skillFile: `built-in/${input.name}/${SKILL_FILE_NAME}`,
    source: 'built-in',
    body: input.body,
    frontmatter,
  });
}

export function parseSkillMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { frontmatter: {}, body: normalized };
  }
  const lineEnd = normalized.startsWith('---\r\n') ? '\r\n' : '\n';
  const endMarker = `${lineEnd}---${lineEnd}`;
  const end = normalized.indexOf(endMarker, 3);
  if (end < 0) return { frontmatter: {}, body: normalized };
  const frontmatterText = normalized.slice(3 + lineEnd.length, end).trim();
  const body = normalized.slice(end + endMarker.length);
  return {
    frontmatter: parseSkillFrontmatter(frontmatterText),
    body,
  };
}

function parseSkillFrontmatter(text: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(text);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SKILL_SHELL_BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
const SKILL_SHELL_INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm;

async function renderSkillContent(
  skill: SkillDefinition,
  args: string,
  conversationId: string,
  executeSkillShell?: SkillShellExecutor,
  signal?: AbortSignal,
): Promise<string> {
  const skillDir = skillDirectoryForPrompt(skill);
  let content = skillDir
    ? `Base directory for this skill: ${skillDir}\n\n${skill.body}`
    : skill.body;
  content = substituteArguments(content, args, true, skill.argumentNames);
  if (skillDir) {
    content = content.replace(/\$\{AGENT_SKILL_DIR\}/g, skillDir);
  }
  content = content.replace(/\$\{AGENT_CONVERSATION_ID\}/g, conversationId);
  return executeShellCommandsInSkillContent(content, skill, executeSkillShell, signal);
}

function skillDirectoryForPrompt(skill: SkillDefinition): string | null {
  if (skill.source !== 'built-in') return normalizePathForPrompt(skill.rootDir);
  return isResourceBackedBuiltInSkill(skill)
    ? normalizePathForPrompt(skill.rootDir)
    : null;
}

function skillPathForPrompt(skill: SkillDefinition): string {
  return skill.source === 'built-in'
    ? `built-in:${skill.name}`
    : normalizePathForPrompt(skill.skillFile);
}

function isResourceBackedBuiltInSkill(skill: SkillDefinition): boolean {
  return skill.source === 'built-in' && skill.contentHash !== undefined;
}

async function executeShellCommandsInSkillContent(
  content: string,
  skill: SkillDefinition,
  executeSkillShell?: SkillShellExecutor,
  signal?: AbortSignal,
): Promise<string> {
  const matches = collectSkillShellMatches(content);
  if (matches.length === 0) return content;

  const shell = (skill.shell ?? 'bash').trim().toLowerCase();
  if (shell !== 'bash') {
    throw new Error(`Skill ${skill.name} requests unsupported shell "${skill.shell}". Tenon currently supports bash skill shell expansion only.`);
  }
  if (!executeSkillShell) {
    throw new Error(`Skill ${skill.name} contains embedded shell commands, but skill shell execution is not available.`);
  }

  let rendered = '';
  let cursor = 0;
  for (const match of matches) {
    rendered += content.slice(cursor, match.index);
    const output = await executeSkillShell({ skill, command: match.command, shell, signal });
    rendered += output;
    cursor = match.index + match.raw.length;
  }
  return rendered + content.slice(cursor);
}

function collectSkillShellMatches(content: string): Array<{ raw: string; command: string; index: number }> {
  const matches: Array<{ raw: string; command: string; index: number; kind: 'block' | 'inline' }> = [];
  for (const match of content.matchAll(SKILL_SHELL_BLOCK_PATTERN)) {
    const command = match[1]?.trim();
    if (!command || match.index === undefined) continue;
    matches.push({ raw: match[0], command, index: match.index, kind: 'block' });
  }
  if (content.includes('!`')) {
    for (const match of content.matchAll(SKILL_SHELL_INLINE_PATTERN)) {
      const command = match[1]?.trim();
      if (!command || match.index === undefined) continue;
      matches.push({ raw: match[0], command, index: match.index, kind: 'inline' });
    }
  }

  matches.sort((a, b) => a.index - b.index || (a.kind === 'block' ? -1 : 1));
  const nonOverlapping: Array<{ raw: string; command: string; index: number }> = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    nonOverlapping.push(match);
    cursor = match.index + match.raw.length;
  }
  return nonOverlapping;
}

function createSkillLoadedMessage(skill: SkillDefinition, renderedContent: string, includeMetadata: boolean): UserMessage {
  const includeIdentityMetadata = includeMetadata || isResourceBackedBuiltInSkill(skill);
  if (!includeIdentityMetadata) return createHiddenUserMessage(renderedContent);
  const metadata = [
    ...(includeMetadata ? [`<skill-message>${skill.name}</skill-message>`] : []),
    `<skill-name>${skill.name}</skill-name>`,
    ...(includeMetadata ? ['<skill-format>true</skill-format>'] : []),
    `<skill-path>${skillPathForPrompt(skill)}</skill-path>`,
  ].join('\n');
  return createHiddenUserMessage(`${metadata}\n\n${renderedContent}`);
}

function createIsolatedSkillResultMessage(
  skill: SkillDefinition,
  result: SkillIsolatedExecutionResult,
  includeMetadata: boolean,
): UserMessage {
  const metadata = includeMetadata
    ? [
        `<skill-message>${skill.name}</skill-message>`,
        `<skill-name>${skill.name}</skill-name>`,
        '<skill-format>true</skill-format>',
      ].join('\n')
    : '';
  const body = [
    metadata,
    `Skill ${skill.name} ran in an isolated child run.`,
    `agent_id: ${result.agentId}`,
    `agent_type: ${result.agentType}`,
    '',
    '<skill-result>',
    result.result || result.error || 'Skill execution completed without a text result.',
    '</skill-result>',
  ].filter(Boolean).join('\n');
  return createHiddenUserMessage(body);
}

function formatIsolatedSkillToolResult(
  skill: SkillDefinition,
  result: SkillIsolatedExecutionResult | undefined,
): string {
  if (!result) return `Skill ${skill.name} completed in an isolated child run.`;
  return [
    `Skill ${skill.name} completed in an isolated child run.`,
    `agent_id: ${result.agentId}`,
    `agent_type: ${result.agentType}`,
    result.error ? `error: ${result.error}` : '',
    '',
    result.result || 'Skill execution completed without a text result.',
  ].filter(Boolean).join('\n');
}

function createHiddenUserMessage(text: string): UserMessage {
  return {
    role: 'user',
    timestamp: Date.now(),
    content: [{ type: 'text', text: systemReminder(text) }],
  };
}

function messageText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function messageTextParts(message: AgentMessage): string[] {
  if (message.role === 'assistant') {
    return message.content
      .filter((part): part is TextContent => part.type === 'text')
      .map((part) => part.text);
  }
  if (typeof message.content === 'string') return [message.content];
  return message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text);
}

function parseInvokedSkillsFromText(text: string): InvokedSkillRecord[] {
  const body = unwrapSystemReminder(text);
  const marker = 'The following skills were invoked in this session. Continue to follow these guidelines:';
  const start = body.indexOf(marker);
  if (start < 0) return [];
  return body
    .slice(start + marker.length)
    .trim()
    .split(/\n\n---\n\n/g)
    .flatMap((section): InvokedSkillRecord[] => {
      const match = /^### Skill: ([^\n]+)\nPath: ([^\n]+)\n\n([\s\S]*)$/.exec(section.trim());
      if (!match) return [];
      const skillRoot = skillRootFromRenderedContent(match[3]!);
      return [{
        skillName: match[1]!.trim(),
        skillPath: match[2]!.trim(),
        ...(skillRoot ? { skillRoot } : {}),
        content: match[3]!.trim(),
        invokedAt: Date.now(),
      }];
    });
}

function parseListedSkillNamesFromText(text: string): string[] {
  const body = unwrapSystemReminder(text);
  return [
    ...parsePersistedListingStateEntries(body).map((entry) => entry.name),
    ...parseLiveSkillListing(body),
  ];
}

function parseListedSkillStateEntriesFromText(text: string): SkillListingStateEntry[] {
  return parsePersistedListingStateEntries(unwrapSystemReminder(text));
}

function parsePersistedListingStateEntries(body: string): SkillListingStateEntry[] {
  const start = body.indexOf(SKILL_LISTING_STATE_MARKER);
  if (start < 0) return [];
  const section = body.slice(start + SKILL_LISTING_STATE_MARKER.length);
  return section
    .split(/\r?\n/)
    .map(parsePersistedListingStateLine)
    .filter((entry): entry is SkillListingStateEntry => entry !== null);
}

function parsePersistedListingStateLine(line: string): SkillListingStateEntry | null {
  const match = /^-\s+([^\s\[]+)(?:\s+\[skill-file:\s*([^\]]+)\])?\s*$/.exec(line.trim());
  const name = normalizeSkillName(match?.[1] ?? '');
  if (!name) return null;
  const identity = match?.[2]?.trim();
  return identity ? { name, identity } : { name };
}

function parseLiveSkillListing(body: string): string[] {
  if (!body.includes('The following skills are available for use with the skill tool')
    && !body.includes('The following skills are available for use with the Skill tool')) {
    return [];
  }
  return body
    .split(/\r?\n/)
    .map((line) => /^-\s+([^:\s]+)(?::|\s|$)/.exec(line)?.[1]?.trim() ?? '')
    .map(normalizeSkillName)
    .filter((skillName): skillName is string => Boolean(skillName));
}

function parseLoadedSkillFromText(text: string): InvokedSkillRecord | null {
  const body = unwrapSystemReminder(text);
  if (body.includes('<skill-result>')) return null;
  const explicitName = /<skill-name>([^<]+)<\/skill-name>/.exec(body)?.[1]?.trim();
  const explicitPath = /<skill-path>([^<]+)<\/skill-path>/.exec(body)?.[1]?.trim();
  const baseDir = /^Base directory for this skill:\s*(.+)$/m.exec(body)?.[1]?.trim();
  if (!explicitName && !baseDir) return null;
  const skillName = normalizeSkillName(explicitName || (baseDir ? path.basename(baseDir) : ''));
  if (!skillName) return null;
  return {
    skillName,
    skillPath: explicitPath || baseDir || `built-in:${skillName}`,
    ...(baseDir ? { skillRoot: baseDir } : {}),
    content: body.trim(),
    invokedAt: Date.now(),
  };
}

function skillRootFromRenderedContent(content: string): string | null {
  return /^Base directory for this skill:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? null;
}

function unwrapSystemReminder(text: string): string {
  const trimmed = text.trim();
  const start = '<system-reminder>';
  const end = '</system-reminder>';
  if (!trimmed.startsWith(start)) return trimmed;
  const endIndex = trimmed.lastIndexOf(end);
  return (endIndex >= 0 ? trimmed.slice(start.length, endIndex) : trimmed.slice(start.length)).trim();
}

function formatSkillListing(skills: SkillDefinition[], contextWindowTokens?: number): string {
  if (skills.length === 0) return '';
  const budget = getSkillListingCharBudget(contextWindowTokens);
  const entries = skills.map((skill) => ({
    skill,
    full: `- ${skill.name}: ${formatSkillDescription(skill)}`,
  }));
  const fullTotal = entries.reduce((sum, entry) => sum + entry.full.length, 0) + entries.length - 1;
  if (fullTotal <= budget) return entries.map((entry) => entry.full).join('\n');

  const nameOverhead = skills.reduce((sum, skill) => sum + skill.name.length + 4, 0) + skills.length - 1;
  const maxDescription = Math.floor((budget - nameOverhead) / skills.length);
  if (maxDescription < MIN_NON_EMPTY_DESCRIPTION_CHARS) {
    return skills.map((skill) => `- ${skill.name}`).join('\n');
  }
  return skills
    .map((skill) => `- ${skill.name}: ${truncate(formatSkillDescription(skill), maxDescription)}`)
    .join('\n');
}

function formatPersistedListingStateEntry(entry: SkillListingStateEntry): string {
  return entry.identity
    ? `- ${entry.name} [skill-file: ${entry.identity}]`
    : `- ${entry.name}`;
}

function skillListingIdentity(skill: SkillDefinition): string {
  return skill.identity ?? skillPathForPrompt(skill);
}

function formatSkillDescription(skill: SkillDefinition): string {
  const description = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  return truncate(description, MAX_LISTING_DESCRIPTION_CHARS);
}

function getSkillListingCharBudget(contextWindowTokens?: number): number {
  const override = Number(process.env.AGENT_SKILL_LISTING_CHAR_BUDGET);
  if (Number.isFinite(override) && override > 0) return override;
  if (!contextWindowTokens) return DEFAULT_SKILL_LISTING_CHAR_BUDGET;
  return Math.floor(contextWindowTokens * CHARS_PER_TOKEN * SKILL_LISTING_CONTEXT_PERCENT);
}

function buildInvokedSkillsForReminder(records: Map<string, InvokedSkillRecord>): Array<{ name: string; path: string; content: string }> {
  let usedTokens = 0;
  return [...records.values()]
    .sort((a, b) => b.invokedAt - a.invokedAt)
    .map((skill) => ({
      name: skill.skillName,
      path: skill.skillPath,
      content: truncateToTokens(skill.content, POST_COMPACT_MAX_TOKENS_PER_SKILL),
    }))
    .filter((skill) => {
      const tokens = estimateTokens(skill.content);
      if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) return false;
      usedTokens += tokens;
      return true;
    });
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function truncateToTokens(value: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

function normalizeAdditionalSkillDirectories(value: readonly string[] | undefined, root: string): string[] {
  if (!value?.length) return [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const item of value) {
    const expanded = expandConfiguredPath(item, root);
    if (!expanded || seen.has(expanded)) continue;
    seen.add(expanded);
    dirs.push(expanded);
  }
  return dirs;
}

function normalizeBuiltInSkillDirectories(value: readonly string[] | undefined, root: string): string[] {
  if (!value?.length) return [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const item of value) {
    const expanded = expandConfiguredPath(item, root);
    if (!expanded) continue;
    const normalized = canonicalDirectoryIdentity(expanded);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dirs.push(normalized);
  }
  return dirs;
}

function canonicalDirectoryIdentity(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expandConfiguredPath(value: string, root: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return path.join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith('$HOME/')) return path.join(homedir(), trimmed.slice('$HOME/'.length));
  if (trimmed.startsWith('${HOME}/')) return path.join(homedir(), trimmed.slice('${HOME}/'.length));
  return path.resolve(root, trimmed);
}

function normalizeSkillToolParams(raw: unknown): { skill: string; args?: string } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Skill tool input must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const skill = typeof record.skill === 'string' ? record.skill : '';
  if (!skill.trim()) throw new Error('Skill tool input requires a non-empty skill name.');
  return {
    skill,
    args: typeof record.args === 'string' ? record.args : undefined,
  };
}

function normalizeSkillName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
}

function parseBooleanFrontmatter(value: unknown, fallback: boolean): boolean {
  return parseBoolean(value) ?? fallback;
}

function parseSkillExecutionFrontmatter(frontmatter: Record<string, unknown>): SkillDefinition['execution'] {
  const rawExecution = coerceString(frontmatter.execution);
  const execution = rawExecution?.toLowerCase();
  if (execution === 'isolated') return 'isolated';
  if (execution === 'inline') return 'inline';
  if (rawExecution !== undefined) {
    throw new Error(`Invalid skill execution value "${rawExecution}". Use "inline" or "isolated".`);
  }
  // Legacy alias retained for existing skills authored before the public DSL
  // described skill execution as `context: fork`.
  if (coerceString(frontmatter.context) === 'fork') return 'isolated';
  return 'inline';
}

function parseArgumentNames(value: unknown): string[] {
  const names = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/)
      : [];
  return names
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item && !/^\d+$/.test(item));
}

function parsePathsFrontmatter(value: unknown): string[] | undefined {
  const patterns = splitFrontmatterList(value)
    .map((pattern) => normalizePathForPrompt(pattern).replace(/\/+$/, ''))
    .filter(Boolean);
  if (patterns.length === 0 || patterns.every((pattern) => pattern === '**')) return undefined;
  return patterns;
}

export function parseToolListFromFrontmatter(value: unknown): string[] {
  const tools = splitFrontmatterList(value);
  const result: string[] = [];
  for (const toolString of tools) {
    let current = '';
    let inParens = false;
    for (const char of toolString) {
      if (char === '(') inParens = true;
      if (char === ')') inParens = false;
      if ((char === ',' || char === ' ') && !inParens) {
        if (current.trim()) result.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) result.push(current.trim());
  }
  return result;
}

function splitFrontmatterList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function extractDescriptionFromMarkdown(markdown: string, name: string): string {
  const line = markdown
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'));
  if (!line) return `${name} skill`;
  return line
    .replace(/^[-*>#\s]+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_LISTING_DESCRIPTION_CHARS);
}

function compactInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder: boolean,
  argumentNames: string[],
): string {
  if (args === undefined || args === null) return content;
  const parsedArgs = parseArguments(args);
  const original = content;
  for (let index = 0; index < argumentNames.length; index += 1) {
    const name = argumentNames[index];
    if (!name) continue;
    content = content.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'), parsedArgs[index] ?? '');
  }
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => parsedArgs[Number(index)] ?? '');
  content = content.replace(/\$(\d+)(?!\w)/g, (_match, index: string) => parsedArgs[Number(index)] ?? '');
  content = content.replaceAll('$ARGUMENTS', args);
  if (content === original && appendIfNoPlaceholder && args) {
    return `${content}\n\nARGUMENTS: ${args}`;
  }
  return content;
}

function parseArguments(args: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const char of args) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) result.push(current);
  return result;
}

function skillMatchesPath(skill: SkillDefinition, filePath: string, root: string): boolean {
  const relative = path.relative(root, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const normalized = normalizePathForPrompt(relative);
  return (skill.paths ?? []).some((pattern) => globMatches(pattern, normalized));
}

function globMatches(pattern: string, value: string): boolean {
  const normalized = normalizePathForPrompt(pattern);
  if (!/[?*]/.test(normalized)) {
    return value === normalized || value.startsWith(`${normalized}/`);
  }
  if (normalized.endsWith('/**')) {
    const base = normalized.slice(0, -3);
    return value === base || value.startsWith(`${base}/`);
  }
  const regex = new RegExp(`^${globToRegExpSource(normalized)}$`);
  return regex.test(value);
}

async function skillFileIdentity(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function globToRegExpSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    const next = pattern[index + 1] ?? '';
    if (char === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
        continue;
      }
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(char);
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePathForPrompt(value: string): string {
  return process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function isGitIgnored(root: string, candidate: string): Promise<boolean> {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    await execFile('git', ['-C', root, 'check-ignore', '-q', '--', normalizePathForPrompt(relative)]);
    return true;
  } catch {
    return false;
  }
}
