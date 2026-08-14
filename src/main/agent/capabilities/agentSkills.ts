import type { AgentTool } from '../runtime/kernel/types';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  SkillCatalogContextPayload,
  SkillInvocationContextPayload,
  TurnStatus,
} from '../../../core/agent/protocol';
import type { SkillDefinition } from '../../../core/types';
// Runtime-only cycle: agentSkillAuthoring imports the shared resolver/hash from this
// module; we import its validator for the undo restore path. Neither side touches the
// other's bindings at module-evaluation time, so the cycle is safe under ESM.
import { AgentSkillAuthoringError, isValidSkillName, validateAgentSkillContentWrite } from './agentSkillAuthoring';
import {
  canonicalPathPreservingSuffixAsync,
  isPathInside as isPathInsideOrEqual,
} from './agentAttachmentMaterialization';
import {
  BUILT_IN_SKILL_RESOURCE_DIR_NAME,
  BUILT_IN_SKILL_SOURCE_DIR,
} from '../../builtInSkillConfig';
import {
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import { runAgentToolProcess } from './agentToolProcess';

export const SKILL_TOOL_NAME = 'skill';

const SKILL_FILE_NAME = 'SKILL.md';
const DEFAULT_SKILL_LISTING_CHAR_BUDGET = 8_000;
const MAX_LISTING_DESCRIPTION_CHARS = 250;
const MIN_NON_EMPTY_DESCRIPTION_CHARS = 20;
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
    '   - Inspect the current Thread for the repeatable process, inputs, outputs, constraints, user corrections, required artifacts, tool needs, and success criteria.',
    '   - Do not over-interview. For a simple explicit request, ask only for missing name, storage, or trigger details. For ambiguous or broad workflows, run a short structured interview.',
    '   - Use `request_user_input` when available for real choices; otherwise ask one concise question in the Thread.',
    '',
    '2. Choose the Tenon skill identity and storage target.',
    '   - Store personal workflows at `~/.agents/skills/<skill-name>/SKILL.md` and repo/workspace workflows at `<workspace>/.agents/skills/<skill-name>/SKILL.md`.',
    '   - Normalize `<skill-name>` to a stable directory name. Do not write `name:` frontmatter; identity comes from the directory name.',
    '   - Use only Tenon skill paths and the lowercase `skill` tool semantics. Do not mention or use other product namespaces or legacy command paths.',
    '   - Never edit built-in skills.',
    '',
    '3. Draft the supported `SKILL.md` shape.',
    '   - Use YAML frontmatter only for supported fields: `description`, `when_to_use`, `argument-hint`, `arguments`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `execution`, `shell`, and `paths`.',
    '   - Write a concise `description` and a precise `when_to_use` that includes positive examples and negative guidance for when not to auto-invoke.',
    '   - Add arguments only when future invocations need variable input.',
    '   - Default to `execution: inline`. Use `execution: isolated` only for self-contained work that benefits from context isolation.',
    '   - Keep instructions step-by-step with success criteria, expected artifacts, hard rules, and human checkpoints where they matter.',
    '',
    '4. Keep creation and update paths distinct.',
    '   - For a new skill, draft one complete `SKILL.md` at the chosen skill path.',
    '   - For an existing skill, resolve and read the current `SKILL.md` first. Preserve existing frontmatter unless the user explicitly asked to change it or the workflow requires the change.',
    '   - Prefer a focused `file_edit` patch for existing skills. Use `file_write` for new skills, major rewrites, or malformed files that cannot be safely patched.',
    '',
    '5. Treat `allowed-tools` as an authored runtime contract.',
    '   - Separate authoring tools from runtime tools: tools used to create the skill are not automatically visible to a future isolated child Thread.',
    '   - For `execution: isolated`, list every tool the child Thread needs; omitted `allowed-tools` creates a tool-free child Thread.',
    '   - `allowed-tools` selects whole tools, not command patterns. Inline skills keep the parent Turn catalog unchanged and cannot contain embedded shell expansion.',
    '   - Embedded shell expansion is isolated execution only and supports `shell: bash` (the default).',
    '   - Flag broad `allowed-tools` in the preview summary.',
    '',
    '6. Resolve ambiguity, then write.',
    '   - When the explicit request and Thread context determine the skill contract, write it directly without a second confirmation.',
    '   - Ask only for a missing identity, storage target, trigger, or behavioral choice that cannot be inferred. Do not ask merely because the skill is persistent or agent-authored.',
    '   - For materially ambiguous requests, show the complete `SKILL.md` or a focused update diff only when that preview is needed to obtain the missing decision.',
    '',
    '7. Write, report, and explain provenance.',
    '   - Use `file_write` or `file_edit` after the contract is determined. The file-tool gateway validates skill content, records rollback metadata in tool details, and hot-reloads the skill registry.',
    '   - After writing, report the exact path and how to invoke it as `/<skill-name> ...`.',
    '   - Agent-written skills and workspace skills are available immediately: slash invocation works immediately, and model-invocable skills can appear in the automatic listing without a separate approval prompt.',
    '   - If validation fails, repair the draft and show the corrected preview again when the change is material.',
    '',
    'Do not write executable or binary support files in this workflow. Do not copy secrets into skills.',
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



export interface SkillLoadOptions {
  localRoot?: string;
  includeUserSkills?: boolean;
  enabledSkills?: readonly string[];
  additionalSkillDirectories?: string[];
  builtInSkillDirectories?: string[];
  builtInSkillRoots?: string[];
  builtInSkills?: BuiltInSkillInput[];
  threadId?: string;
  executeSkillShell?: SkillShellExecutor;
  executeIsolatedSkill?: SkillIsolatedExecutor;
  provenanceStore?: AgentSkillProvenanceStore;
  managedSkillRoots?: () => Promise<Array<{
    id: string;
    name: string;
    rootDir: string;
    contentHash: string;
  }>>;
  managedSkillContentRoot?: string;
  assertManagedSkillInvocable?: (skillId: string, expectedContentHash: string) => Promise<void>;
}

export interface BuiltInSkillResourceRootOptions {
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
}

/**
 * The per-skill provenance record, keyed by resolved skill file path: who produced
 * the current bytes, and the one version before that, so an agent edit can be
 * undone.
 *
 * It used to carry an accepted-content hash too, half of a trust model whose other
 * half was a permission gate — a Skill could not be invoked until the user
 * accepted it. That gate is an approval policy, which Tenon does not have
 * (`agent-tool-permissions.md`, #410), and it had been hardcoded open for so long
 * that neither half was reachable. Both are gone; provenance is what remains,
 * because Undo genuinely needs it.
 */
export interface AgentSkillProvenanceRecord {
  /** sha256 of the last SKILL.md content written through the agent file-tool path. */
  agentHash?: string;
  /** The one version preceding the last agent edit, for single-step undo. */
  previousVersion?: AgentSkillPreviousVersion;
}

export interface AgentSkillPreviousVersion {
  hash: string;
  content: string;
  /**
   * The agent-write hash that applied while this previous content was current
   * (undefined = the previous bytes were human-produced). Restored on undo so a
   * later edit can still identify who produced the current bytes.
   */
  agentHash?: string;
}

/**
 * Persists agent-write provenance and one undo version per Skill. The registry also
 * keeps an in-memory record so Undo remains available when persistence fails.
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
  paths?: string[];
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
  trigger: 'agent' | 'slash' | 'runtime';
  parentToolCallId?: string;
  invokedAt?: number;
  signal?: AbortSignal;
}

export interface SkillIsolatedExecutionInput {
  skill: SkillDefinition;
  renderedContent: string;
  args: string;
  trigger: 'agent' | 'slash' | 'runtime';
  parentToolCallId?: string;
}

export interface SkillIsolatedExecutionResult {
  threadId: string;
  agentRole: string;
  status: Exclude<TurnStatus, 'inProgress'>;
  result?: string;
  /** Account layer: the child transcript artifact, absent when the write failed (A12). */
  transcriptPath?: string;
  error?: string;
}

export type SkillIsolatedExecutor = (input: SkillIsolatedExecutionInput) => Promise<SkillIsolatedExecutionResult>;

export type SkillInvocationResult =
  | {
    ok: true;
    execution: 'inline' | 'isolated';
    skill: SkillDefinition;
    renderedContent: string;
    evidence: SkillInvocationContextPayload;
    isolated?: SkillIsolatedExecutionResult;
  }
  | {
    ok: false;
    code: string;
    message: string;
    skill?: SkillDefinition;
  };

export interface PreloadedSkillResolution {
  readonly invocations: readonly SkillInvocationContextPayload[];
  readonly diagnostics: readonly string[];
}

export interface SkillToolData {
  success: boolean;
  skill: string;
  invocationEvidence?: SkillInvocationContextPayload;
  status?: 'loaded' | 'isolated';
  outcome?: Exclude<TurnStatus, 'inProgress'>;
  allowedTools?: string[];
  model?: string;
  effort?: string;
  threadId?: string;
  agentRole?: string;
  result?: string;
  transcriptPath?: string;
  error?: string;
}

export class AgentSkillRuntime {
  private readonly registry: SkillRegistry;
  private readonly threadId: string;
  private readonly executeSkillShell?: SkillShellExecutor;
  private readonly executeIsolatedSkill?: SkillIsolatedExecutor;
  private readonly assertManagedSkillInvocable?: SkillLoadOptions['assertManagedSkillInvocable'];
  private readonly enabledSkills: ReadonlySet<string> | null;
  private catalogRefreshVersion = 0;
  private catalogRefreshAcknowledgedVersion = 0;
  private disabledSkills: string[] = [];

  constructor(options: SkillLoadOptions = {}) {
    this.registry = new SkillRegistry(options);
    this.threadId = options.threadId?.trim() || 'lin-agent-thread';
    this.executeSkillShell = options.executeSkillShell;
    this.executeIsolatedSkill = options.executeIsolatedSkill;
    this.assertManagedSkillInvocable = options.assertManagedSkillInvocable;
    this.enabledSkills = options.enabledSkills === undefined || options.enabledSkills.includes('*')
      ? null
      : new Set(options.enabledSkills.map(normalizeSkillName).filter(Boolean));
  }

  updateAdditionalSkillDirectories(directories: readonly string[]): void {
    if (this.registry.updateAdditionalSkillDirectories(directories)) {
      this.requestCatalogRefresh();
    }
  }

  updateDisabledSkills(disabledSkills: string[]): void {
    const normalized = [...new Set(disabledSkills)].sort(compareStableText);
    if (sameStringList(this.disabledSkills, normalized)) return;
    this.disabledSkills = normalized;
    this.requestCatalogRefresh();
  }

  async buildSkillCatalogSnapshot(): Promise<SkillCatalogContextPayload> {
    this.registry.reloadAll();
    const skills = (await this.registry.getModelInvocableSkills())
      .filter((skill) => this.isEnabledByConfiguration(skill) && !this.isDisabledByRuntimeSettings(skill))
      .sort((left, right) => compareStableText(left.name, right.name));
    const descriptions = boundedSkillCatalogDescriptions(skills);
    const entries = skills.map((skill) => ({
      change: 'available' as const,
      name: skill.name,
      displayName: skill.displayName?.trim() || skill.name,
      source: skill.source,
      identity: skillListingIdentity(skill),
      contentHash: skill.contentHash ?? codeRegisteredSkillContentHash(skill),
      description: descriptions.get(skill.name) ?? '',
    }));
    const catalogHash = createHash('sha256').update(JSON.stringify(entries.map((entry) => ({
      name: entry.name,
      displayName: entry.displayName,
      source: entry.source,
      identity: entry.identity,
      contentHash: entry.contentHash,
      description: entry.description,
    })))).digest('hex');
    return {
      schemaVersion: 1,
      kind: 'skillCatalog',
      mode: 'baseline',
      previousCatalogHash: null,
      catalogHash,
      entries,
    };
  }

  async notifyFileTouched(filePaths: string[]): Promise<void> {
    const changed = await this.registry.activateForFilePaths(filePaths);
    if (changed) this.requestCatalogRefresh();
  }

  async notifySkillContentWritten(filePaths: string[]): Promise<void> {
    if (filePaths.length > 0 && filePaths.every((filePath) => path.basename(filePath) !== SKILL_FILE_NAME)) {
      return;
    }
    this.registry.reloadAll();
    this.requestCatalogRefresh();
  }

  catalogRefreshCheckpoint(): number | null {
    return this.catalogRefreshVersion > this.catalogRefreshAcknowledgedVersion
      ? this.catalogRefreshVersion
      : null;
  }

  acknowledgeCatalogRefresh(checkpoint: number): void {
    if (!Number.isSafeInteger(checkpoint) || checkpoint <= 0 || checkpoint > this.catalogRefreshVersion) {
      throw new Error('Invalid Skill catalog refresh checkpoint.');
    }
    this.catalogRefreshAcknowledgedVersion = Math.max(
      this.catalogRefreshAcknowledgedVersion,
      checkpoint,
    );
  }

  async resolveSkillTarget(filePath: string): Promise<AgentSkillContentTarget | null> {
    return this.registry.resolveSkillTarget(filePath);
  }

  async recordAgentSkillWrite(
    skillFile: string,
    contentHash: string,
    previous?: { hash: string; content: string } | null,
  ): Promise<void> {
    await this.registry.recordAgentSkillWrite(skillFile, contentHash, previous);
  }


  async undoLastAgentSkillEdit(name: string): Promise<void> {
    await this.registry.undoLastAgentEdit(name);
  }

  /**
   * Reload provenance after another runtime restores Skill bytes through Undo, then
   * schedule a canonical catalog refresh before the next provider request.
   */
  async refreshProvenanceRecords(): Promise<void> {
    this.registry.refreshProvenanceRecords();
    this.requestCatalogRefresh();
  }

  async getSkill(name: string): Promise<SkillDefinition | null> {
    return this.registry.resolveSkill(name);
  }

  async listUserInvocableSkills(): Promise<SkillDefinition[]> {
    const skills = await this.registry.getUserInvocableSkills();
    return skills.filter((skill) => (
      this.isEnabledByConfiguration(skill) && !this.isDisabledByRuntimeSettings(skill)
    ));
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
    if (!this.isEnabledByConfiguration(skill)) {
      return {
        ok: false,
        code: 'skill_not_enabled',
        message: `Skill ${skill.name} is outside this Thread's configured Skill ceiling.`,
        skill,
      };
    }
    if (this.isDisabledByRuntimeSettings(skill)) {
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
    if (skill.source === 'managed') {
      if (!skill.managedContentHash || !this.assertManagedSkillInvocable) {
        return {
          ok: false,
          code: 'managed_skill_unavailable',
          message: `Managed skill ${skill.name} has no active integrity contract.`,
          skill,
        };
      }
      try {
        await this.assertManagedSkillInvocable(skill.name, skill.managedContentHash);
      } catch (error) {
        this.registry.reloadAll();
        return {
          ok: false,
          code: 'managed_skill_unavailable',
          message: error instanceof Error ? error.message : String(error),
          skill,
        };
      }
    }
    let renderedContent: string;
    try {
      renderedContent = await renderSkillContent(skill, input.args ?? '', this.threadId, this.executeSkillShell, input.signal);
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
        });
        return {
          ok: true,
          execution: 'isolated',
          skill,
          renderedContent,
          evidence: skillInvocationEvidence(skill, renderedContent, input),
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

    return {
      ok: true,
      execution: 'inline',
      skill,
      renderedContent,
      evidence: skillInvocationEvidence(skill, renderedContent, input),
    };
  }

  private isDisabledByRuntimeSettings(skill: SkillDefinition): boolean {
    return !isSkillEnabled(skill, {
      disabledSkills: this.disabledSkills,
      activeManagedSkillNames: this.registry.activatedManagedSkillNames(),
    });
  }

  private isEnabledByConfiguration(skill: SkillDefinition): boolean {
    return this.enabledSkills === null || this.enabledSkills.has(normalizeSkillName(skill.name));
  }

  private requestCatalogRefresh(): void {
    this.catalogRefreshVersion += 1;
  }

}

/**
 * Resolve Role-declared startup Skills without turning an unavailable entry into
 * a failed Agent spawn. Preloading is instruction admission, so one-shot isolated
 * Skills are intentionally skipped rather than executed as a side effect.
 */
export async function resolvePreloadedSkillInvocations(
  runtime: AgentSkillRuntime,
  names: readonly string[],
  invokedAt: number,
  skillToolAvailable = true,
): Promise<PreloadedSkillResolution> {
  if (!skillToolAvailable) {
    return {
      invocations: [],
      diagnostics: names.length === 0
        ? []
        : ['Role-preloaded Skills were skipped because the skill tool is unavailable.'],
    };
  }
  const invocations: SkillInvocationContextPayload[] = [];
  const diagnostics: string[] = [];
  for (const requestedName of names) {
    try {
      const skill = await runtime.getSkill(requestedName);
      if (!skill) {
        diagnostics.push(`Role-preloaded Skill "${requestedName}" is unavailable and was skipped.`);
        continue;
      }
      if (skill.execution === 'isolated') {
        diagnostics.push(`Role-preloaded Skill "${skill.name}" uses isolated execution and was skipped.`);
        continue;
      }
      const invocation = await runtime.invokeSkill({
        skill: skill.name,
        args: '',
        trigger: 'runtime',
        invokedAt,
      });
      if (!invocation.ok) {
        diagnostics.push(`Role-preloaded Skill "${skill.name}" was skipped: ${invocation.message}`);
        continue;
      }
      invocations.push(invocation.evidence);
    } catch (error) {
      diagnostics.push(
        `Role-preloaded Skill "${requestedName}" was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { invocations, diagnostics };
}

function skillInvocationEvidence(
  skill: SkillDefinition,
  renderedContent: string,
  input: InvokeSkillInput,
): SkillInvocationContextPayload {
  return {
    schemaVersion: 1,
    kind: 'skillInvocation',
    name: skill.name,
    displayName: skill.displayName?.trim() || skill.name,
    source: skill.source,
    identity: skillListingIdentity(skill),
    resourceRoot: skillDirectoryForPrompt(skill),
    contentHash: skill.contentHash ?? codeRegisteredSkillContentHash(skill),
    instructions: renderedContent,
    arguments: input.args ?? '',
    execution: skill.execution,
    invocationSource: input.trigger === 'agent' ? 'model' : input.trigger === 'slash' ? 'user' : 'runtime',
    constraints: skill.execution === 'isolated'
      ? {
          allowedTools: [...skill.allowedTools],
          model: skill.model ?? null,
          effort: skill.effort ?? null,
        }
      : { allowedTools: [], model: null, effort: null },
    invokedAt: input.invokedAt ?? Date.now(),
  };
}

export interface SkillEnablementInput {
  /** User setting, keyed by skill name, applying to every source. */
  disabledSkills: readonly string[];
  /**
   * The managed index's activation flag, as the set of activated managed skill
   * names. Only `managed` skills consult it.
   */
  activeManagedSkillNames: ReadonlySet<string>;
}

/**
 * The single meaning of "on" — available to the model right now:
 *
 *     enabled(skill) = activation(skill) && !disabledSkills.includes(skill.name)
 *
 * `activation` is the managed index's per-record flag for `managed` skills and
 * constant-true for every other source.
 *
 * The two writers stay separate on purpose. `disabledSkills` is a user setting
 * keyed by name; the managed activation flag is per-installed-record and
 * participates in install / rollback / uninstall (it is what makes "install, but
 * do not enable yet" possible). Merging the stores would either put managed
 * lifecycle state into settings or put settings into an index that does not own
 * the skills they describe — so only the predicate is unified, not the storage.
 *
 * Both terms are evaluated explicitly rather than inferred from catalog
 * membership, so a deactivated managed skill still resolves correctly when it is
 * loaded for display rather than for use.
 */
export function isSkillEnabled(
  skill: Pick<SkillDefinition, 'name' | 'source'>,
  input: SkillEnablementInput,
): boolean {
  const activated = skill.source !== 'managed'
    || input.activeManagedSkillNames.has(normalizeSkillName(skill.name));
  return activated && !input.disabledSkills.includes(skill.name);
}

export function createSkillTool(runtime: AgentSkillRuntime): AgentTool<any, ToolEnvelope<SkillToolData>> {
  return {
    name: SKILL_TOOL_NAME,
    label: 'Skill',
    description: [
      'Execute a skill within the current Thread',
      'When users ask you to perform tasks, check if any available skills match. Skills provide specialized capabilities and domain knowledge.',
      'When users reference a slash skill or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.',
      'How to invoke:',
      '- Use this tool with the skill name and optional arguments',
      '- Examples:',
      '  - `skill: "pdf"` - invoke the pdf skill',
      '  - `skill: "commit", args: "-m \'Fix bug\'"` - invoke with arguments',
      '  - `skill: "review-pr", args: "123"` - invoke with arguments',
      'Important:',
      '- Available skills are listed in the current Skill catalog context.',
      `- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant ${SKILL_TOOL_NAME} tool BEFORE generating any other response about the task.`,
      '- NEVER mention a skill without actually calling this tool.',
      '- Do not invoke a skill that is already running.',
      '- Do not use this tool for built-in commands.',
      '- If the current context already contains a matching Skill invocation, follow the loaded instructions instead of calling this tool again.',
      '- An isolated Skill runs once in one child Thread; its catalog entry states whether Subagent fan-out must stay in the parent.',
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
            instructions: 'Use only Skills listed in the current Skill catalog context, or continue without a Skill.',
          }),
        };
      }

      const data: SkillToolData = {
        success: true,
        skill: invocation.skill.name,
        invocationEvidence: invocation.evidence,
        status: invocation.execution === 'isolated' ? 'isolated' : 'loaded',
        outcome: invocation.isolated?.status,
        allowedTools: invocation.skill.allowedTools.length > 0 ? invocation.skill.allowedTools : undefined,
        model: invocation.skill.model,
        effort: invocation.skill.effort,
        threadId: invocation.isolated?.threadId,
        agentRole: invocation.isolated?.agentRole,
        result: invocation.isolated?.result,
        transcriptPath: invocation.isolated?.transcriptPath,
        error: invocation.isolated?.error,
      };
      if (invocation.execution === 'isolated') {
        const text = formatIsolatedSkillToolResult(invocation.skill, invocation.isolated);
        return {
          content: [{ type: 'text', text }],
          details: successEnvelope(SKILL_TOOL_NAME, data),
        };
      }

      return {
        content: [{ type: 'text', text: `Loaded Skill: ${invocation.skill.name}` }],
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

export async function resolveUserSkillInvocation(
  runtime: AgentSkillRuntime,
  input: string,
  options: { readonly invokedAt?: number } = {},
): Promise<SkillInvocationResult | null> {
  const slash = parseSkillSlashCommand(input);
  const requested = slash ?? parseNaturalLanguageSkillifyRequest(input);
  if (!requested) return null;
  const skill = await runtime.getSkill(requested.skill);
  if (!skill || skill.execution === 'isolated') return null;
  const invocation = await runtime.invokeSkill({
    skill: requested.skill,
    args: requested.args,
    trigger: 'slash',
    invokedAt: options.invokedAt,
  });
  if (!invocation.ok) {
    if (slash) throw new Error(invocation.message);
    return null;
  }
  return invocation;
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

interface LoadedSkillAdmission {
  registryChanged: boolean;
  ownsMutableRoot: boolean;
}

class SkillRegistry {
  private readonly root: string;
  private readonly includeUserSkills: boolean;
  private readonly builtInSkillDirectories: string[];
  private readonly builtInSkillRoots: string[];
  private readonly builtInSkills: BuiltInSkillInput[];
  private additionalSkillDirectories: string[];
  private loadedBoundSkillRoots: LoadedBoundSkillRoot[] = [];
  private loadedSkillSearchDirectories: SkillSearchDirectory[] = [];
  private loaded = false;
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly conditionalSkills = new Map<string, SkillDefinition>();
  private readonly activatedConditionalSkillIds = new Set<string>();
  private readonly dynamicSkillDirectories = new Set<string>();
  private readonly checkedDynamicSkillDirs = new Set<string>();
  private readonly seenSkillFileIds = new Set<string>();
  private loadPromise: Promise<void> | null = null;
  private loadGeneration = 0;
  // Per-Skill agent-write provenance and one undo version.
  private readonly provenance = new Map<string, AgentSkillProvenanceRecord>();
  private readonly provenanceStore?: AgentSkillProvenanceStore;
  private readonly managedSkillRoots?: SkillLoadOptions['managedSkillRoots'];
  private readonly managedSkillContentRoot?: string;
  // Names of the managed skills the last load activated. The managed index owns
  // this flag; the runtime mirrors it so the enable predicate can evaluate
  // activation explicitly instead of inferring it from catalog membership.
  private activeManagedSkillNames: ReadonlySet<string> = new Set();
  private provenanceLoaded = false;

  constructor(options: SkillLoadOptions) {
    this.root = path.resolve(options.localRoot ?? process.cwd());
    this.includeUserSkills = options.includeUserSkills ?? true;
    this.builtInSkillDirectories = normalizeBuiltInSkillDirectories(
      options.builtInSkillDirectories ?? [resolveBuiltInSkillResourceRoot()],
      this.root,
    );
    this.builtInSkillRoots = normalizeBuiltInSkillDirectories(
      options.builtInSkillRoots ?? [],
      this.root,
    );
    this.builtInSkills = options.builtInSkills ?? [...DEFAULT_BUILT_IN_SKILLS];
    this.additionalSkillDirectories = normalizeAdditionalSkillDirectories(options.additionalSkillDirectories, this.root);
    this.provenanceStore = options.provenanceStore;
    this.managedSkillRoots = options.managedSkillRoots;
    this.managedSkillContentRoot = options.managedSkillContentRoot
      ? path.resolve(options.managedSkillContentRoot)
      : undefined;
  }

  /** The managed index's activation flag as of the last load. */
  activatedManagedSkillNames(): ReadonlySet<string> {
    return this.activeManagedSkillNames;
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
      // The in-memory record still guards this Thread; a persistence failure must
      // not fail the skill write itself.
    }
  }

  /**
   * Single-step undo of the last agent edit: restore the one previous version the
   * gateway captured, through the same validator as agent writes, then restore
   * the provenance facts that belonged to those bytes. Strictly one-shot — the
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
    const target = await this.resolveSkillTarget(skill.skillFile);
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
    // the agent-write path (the in-memory record still guards this Thread).
    const record: AgentSkillProvenanceRecord = {
      ...(previous.agentHash ? { agentHash: previous.agentHash } : {}),
    };
    const persisted = record.agentHash ? record : null;
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
    // Unlike invocation, Undo must also reach paths:-conditional skills
    // that have not been activated yet — the Skills panel lists them (listAllSkills)
    // and exposes Undo before they match a file.
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
    if (skill.source === 'built-in' || skill.source === 'managed' || !skill.contentHash) {
      throw new Error(`Skill ${skill.name} is ${skill.source} and has no editable provenance record.`);
    }
    return skill;
  }

  /**
   * Reload provenance for this registry after another registry instance restores
   * Skill bytes through Undo. The in-memory-newer-wins merge is bypassed because
   * the shared store now describes the restored file.
   */
  refreshProvenanceRecords(): void {
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
      // record still guards the current Thread.
    }
  }

  updateAdditionalSkillDirectories(directories: readonly string[]): boolean {
    const normalized = normalizeAdditionalSkillDirectories(directories, this.root);
    if (sameStringList(this.additionalSkillDirectories, normalized)) return false;
    this.additionalSkillDirectories = normalized;
    this.reloadAll();
    return true;
  }

  async resolveSkillTarget(filePath: string): Promise<AgentSkillContentTarget | null> {
    while (true) {
      await this.ensureLoaded();
      const generation = this.loadGeneration;
      const target = await resolveSkillContentTarget(filePath, {
        root: this.root,
        includeUserSkills: this.includeUserSkills,
        additionalSkillDirectories: [...this.additionalSkillDirectories],
        loadedBoundSkillRoots: [...this.loadedBoundSkillRoots],
        skillSearchDirectories: [...this.loadedSkillSearchDirectories],
        builtInSkillDirectories: this.builtInSkillDirectories,
        builtInSkillRoots: this.builtInSkillRoots,
        managedSkillContentRoot: this.managedSkillContentRoot,
      });
      if (this.loaded && this.loadGeneration === generation) return target;
    }
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
    return [...this.skills.values()].filter((skill) => skill.modelInvocable);
  }

  async getUserInvocableSkills(): Promise<SkillDefinition[]> {
    await this.ensureLoaded();
    return [...this.skills.values()].filter((skill) => skill.userInvocable);
  }

  async listAllSkills(): Promise<SkillDefinition[]> {
    await this.ensureLoaded();
    return [...this.skills.values(), ...this.conditionalSkills.values()]
      .sort((left, right) => compareStableText(left.name, right.name));
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
        if ((await this.addLoadedSkill(skill)).registryChanged) changed = true;
      }
    }

    for (const skill of [...this.conditionalSkills.values()]) {
      if (!skill.paths?.length) continue;
      if (filePaths.some((filePath) => skillMatchesPath(skill, filePath, this.root))) {
        this.conditionalSkills.delete(skill.name);
        this.skills.set(skill.name, skill);
        if (skill.identity) this.activatedConditionalSkillIds.add(skill.identity);
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

  /**
   * The activated managed roots, or none.
   *
   * Managed skills are one source among five, and the only one behind a
   * user-writable JSON index. Letting that index's decode failure propagate made
   * every skill load throw — slash commands, the Skill library, and any turn that
   * touches skills — and the catch below clears built-in and workspace skills too,
   * so one unreadable managed index took out the whole skill system (A12). It
   * degrades to "no managed skills" instead; the store heals the index itself.
   */
  private async loadManagedSkillRoots(): Promise<Array<{ id: string; name: string; rootDir: string; contentHash: string }>> {
    if (!this.managedSkillRoots) return [];
    try {
      return await this.managedSkillRoots();
    } catch (error) {
      console.warn(`Loading managed skills failed; continuing without them: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async performLoad(loadGeneration: number): Promise<void> {
    await this.ensureProvenanceLoaded();
    const nextLoadedBoundSkillRoots: LoadedBoundSkillRoot[] = [];
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
      for (const dir of this.builtInSkillRoots) {
        const skill = await loadSkillFromRoot(dir, 'built-in');
        if (!skill) {
          throw new Error(`Configured built-in skill root is missing a valid ${SKILL_FILE_NAME}: ${dir}.`);
        }
        await this.addLoadedSkill(skill);
      }
      for (const skill of this.builtInSkills.map(createBuiltInSkillDefinition)) {
        await this.addLoadedSkill(skill);
      }
      const managedRoots = await this.loadManagedSkillRoots();
      // The service hands back only the activated records, so this set is the
      // managed index's activation flag as of this load.
      this.activeManagedSkillNames = new Set(managedRoots.map((managed) => normalizeSkillName(managed.name)));
      for (const managed of managedRoots) {
        // A12: a managed root that no longer holds a readable SKILL.md is one
        // broken install, not a reason to leave the user with no skills at all.
        // Skipping it keeps built-in, user, and project skills loadable, and the
        // Skill library still shows the record with its own diagnostic.
        let skill: SkillDefinition | null;
        try {
          skill = await loadSkillFromRoot(managed.rootDir, 'managed', managed.name, managed.contentHash);
        } catch (error) {
          console.warn(`Skipping managed skill ${managed.name}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (!skill) {
          console.warn(`Skipping managed skill ${managed.name}: missing a valid ${SKILL_FILE_NAME}.`);
          continue;
        }
        await this.addLoadedSkill(skill);
      }
      const roots = await skillSearchDirs(this.root, this.includeUserSkills, this.additionalSkillDirectories);
      for (const root of roots) {
        const { dir, source, policy } = root;
        const loaded = await loadSkillsFromDir(dir, source);
        for (const skill of loaded) {
          const admission = await this.addLoadedSkill(skill);
          if (policy !== 'bound' || !admission.ownsMutableRoot) continue;
          const skillRootIdentity = await canonicalPathPreservingSuffixAsync(skill.rootDir);
          for (const alias of root.aliases) {
            nextLoadedBoundSkillRoots.push({
              skillName: skill.name,
              skillRoot: path.join(alias.dir, path.basename(skill.rootDir)),
              skillRootIdentity,
              skillsDir: alias.dir,
              skillsDirIdentity: root.identity,
              source: alias.source,
            });
          }
        }
      }
      for (const dir of this.dynamicSkillDirectories) {
        const loaded = await loadSkillsFromDir(dir, 'project');
        for (const skill of loaded) {
          await this.addLoadedSkill(skill);
        }
      }
      if (this.loadGeneration === loadGeneration) {
        this.loadedBoundSkillRoots = await retainAdmittedBoundSkillRoots({
          previous: this.loadedBoundSkillRoots,
          next: nextLoadedBoundSkillRoots,
          searchDirectories: roots,
          immutableSkillNames: new Set(
            [...this.skills.values(), ...this.conditionalSkills.values()]
              .filter((skill) => skill.source === 'built-in')
              .map((skill) => skill.name),
          ),
        });
        this.loadedSkillSearchDirectories = roots;
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

  private async addLoadedSkill(skill: SkillDefinition): Promise<LoadedSkillAdmission> {
    const existing = this.skills.get(skill.name) ?? this.conditionalSkills.get(skill.name);
    if (existing?.source === 'built-in') {
      if (skill.source === 'built-in') {
        throw new Error(`Duplicate built-in skill "${skill.name}" from ${skillPathForPrompt(existing)} and ${skillPathForPrompt(skill)}.`);
      }
      return { registryChanged: false, ownsMutableRoot: false };
    }
    const fileId = skill.source === 'built-in'
      ? skillPathForPrompt(skill)
      : await skillFileIdentity(skill.skillFile);
    if (this.seenSkillFileIds.has(fileId)) {
      return {
        registryChanged: false,
        ownsMutableRoot: skill.source === 'user' || skill.source === 'project',
      };
    }
    this.seenSkillFileIds.add(fileId);
    const record = this.provenance.get(path.resolve(skill.skillFile));
    const skillWithIdentity = {
      ...skill,
      identity: normalizePathForPrompt(fileId),
      // Undo is offered only while the file still holds exactly the agent's bytes:
      // the previous-version record lingers after a user hand-edit, but restoring
      // over user content would silently destroy it (the action enforces the same
      // gate against the live file).
      canUndoLastAgentEdit: record?.previousVersion !== undefined
        && record.agentHash !== undefined
        && record.agentHash === skill.contentHash,
    };
    if (
      skill.paths?.length
      && skill.source !== 'built-in'
      && !this.activatedConditionalSkillIds.has(skillWithIdentity.identity)
    ) {
      this.conditionalSkills.set(skill.name, skillWithIdentity);
    } else {
      this.skills.set(skill.name, skillWithIdentity);
    }
    return {
      registryChanged: true,
      ownsMutableRoot: skill.source === 'user' || skill.source === 'project',
    };
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
              this.dynamicSkillDirectories.add(skillDir);
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


export function resolveBuiltInSkillResourceRoot(options: BuiltInSkillResourceRootOptions = {}): string {
  const isPackaged = options.isPackaged ?? appIsPackaged();
  if (isPackaged) {
    const resourcesPath = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!resourcesPath) {
      throw new Error('Cannot resolve packaged built-in skill resources without process.resourcesPath.');
    }
    return path.join(resourcesPath, BUILT_IN_SKILL_RESOURCE_DIR_NAME);
  }
  return path.resolve(options.appPath ?? developmentAppPath(), BUILT_IN_SKILL_SOURCE_DIR);
}

function appIsPackaged(): boolean {
  try {
    const electron = requireForElectron('electron') as typeof import('electron');
    return Boolean(electron.app?.isPackaged);
  } catch {
    return false;
  }
}

function developmentAppPath(): string {
  try {
    const electron = requireForElectron('electron') as typeof import('electron');
    return electron.app?.getAppPath() ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

type SkillSearchDirectoryPolicy = 'convention' | 'bound';

interface SkillSearchDirectoryAlias {
  dir: string;
  source: 'user' | 'project';
}

export interface SkillSearchDirectory {
  dir: string;
  identity: string;
  source: 'user' | 'project';
  policy: SkillSearchDirectoryPolicy;
  aliases: SkillSearchDirectoryAlias[];
}

async function skillSearchDirs(
  root: string,
  includeUserSkills: boolean,
  additionalSkillDirectories: readonly string[] = [],
): Promise<SkillSearchDirectory[]> {
  const dirs: Array<Omit<SkillSearchDirectory, 'identity' | 'aliases'>> = [
    ...(includeUserSkills ? [
      { dir: path.join(homedir(), '.agents', 'skills'), source: 'user', policy: 'convention' },
    ] as Array<Omit<SkillSearchDirectory, 'identity' | 'aliases'>> : []),
    { dir: path.join(root, '.agents', 'skills'), source: 'project', policy: 'convention' },
    ...additionalSkillDirectories.map((dir): Omit<SkillSearchDirectory, 'identity' | 'aliases'> => ({
      dir,
      source: isPathInside(dir, root) ? 'project' : 'user',
      policy: 'bound',
    })),
  ];
  const identities = await Promise.all(dirs.map((entry) => canonicalPathPreservingSuffixAsync(entry.dir)));
  const grouped = new Map<string, SkillSearchDirectory>();
  for (const [index, entry] of dirs.entries()) {
    const identity = identities[index] ?? path.resolve(entry.dir);
    const existing = grouped.get(identity);
    if (existing) {
      if (!existing.aliases.some((alias) => path.resolve(alias.dir) === path.resolve(entry.dir))) {
        existing.aliases.push({ dir: path.resolve(entry.dir), source: entry.source });
      }
      continue;
    }
    grouped.set(identity, {
      ...entry,
      dir: path.resolve(entry.dir),
      identity,
      aliases: [{ dir: path.resolve(entry.dir), source: entry.source }],
    });
  }
  return [...grouped.values()];
}

/** One mutable Skill-content target resolved through the current ownership policy. */
export interface AgentSkillContentTarget {
  skillName: string;
  skillRoot: string;
  skillsDir: string;
  source: Exclude<SkillDefinition['source'], 'built-in' | 'managed'>;
  relativePath: string;
  isSkillFile: boolean;
  ownership: 'convention' | 'loaded-bound' | 'bound-admission';
}

/** A mutable physical Skill root admitted from an explicitly bound container. */
export interface LoadedBoundSkillRoot {
  skillName: string;
  skillRoot: string;
  skillRootIdentity?: string;
  skillsDir: string;
  skillsDirIdentity?: string;
  source: Exclude<SkillDefinition['source'], 'built-in' | 'managed'>;
}

/** Config that defines convention namespaces and the last admitted bound roots. */
export interface SkillDirConfig {
  root: string;
  includeUserSkills: boolean;
  additionalSkillDirectories: readonly string[];
  loadedBoundSkillRoots?: readonly LoadedBoundSkillRoot[];
  skillSearchDirectories?: readonly SkillSearchDirectory[];
  builtInSkillDirectories?: readonly string[];
  builtInSkillRoots?: readonly string[];
  managedSkillContentRoot?: string;
}

function targetInsideSkillsDir(
  filePath: string,
  skillsDirInput: string,
  source: Exclude<SkillDefinition['source'], 'built-in' | 'managed'>,
  ownership: AgentSkillContentTarget['ownership'],
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
    ownership,
  };
}

function targetInsideLoadedBoundSkillRoot(
  filePath: string,
  filePathIdentity: string,
  owner: LoadedBoundSkillRoot,
  skillRootIdentity: string,
): AgentSkillContentTarget | null {
  if (!isPathInside(filePathIdentity, skillRootIdentity)) return null;
  const parts = path.relative(skillRootIdentity, filePathIdentity).split(path.sep).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    skillName: owner.skillName,
    skillRoot: path.resolve(owner.skillRoot),
    skillsDir: path.resolve(owner.skillsDir),
    source: owner.source,
    relativePath: parts.join('/'),
    isSkillFile: parts.length === 1 && parts[0] === SKILL_FILE_NAME,
    ownership: 'loaded-bound',
  };
}

/**
 * The single source of truth for "is this file a Skill-content write, and which
 * Skill owns it?" Convention namespaces govern by path shape. Explicitly bound
 * containers govern support content only through roots admitted by the loader;
 * their exact SKILL.md path remains a governed admission attempt. Built-in and
 * managed Skills have no writable target.
 */
export async function resolveSkillContentTarget(
  filePathInput: string,
  config: SkillDirConfig,
): Promise<AgentSkillContentTarget | null> {
  const filePath = path.resolve(filePathInput);
  const filePathIdentity = await canonicalPathPreservingSuffixAsync(filePath);
  const builtInDirs = await Promise.all(
    [...(config.builtInSkillDirectories ?? []), ...(config.builtInSkillRoots ?? [])]
      .map((dir) => canonicalPathPreservingSuffixAsync(dir)),
  );
  for (const builtInDir of builtInDirs) {
    if (filePathIdentity === builtInDir || isPathInside(filePathIdentity, builtInDir)) return null;
  }
  if (config.managedSkillContentRoot) {
    const managedRoot = await canonicalPathPreservingSuffixAsync(config.managedSkillContentRoot);
    if (filePathIdentity === managedRoot || isPathInside(filePathIdentity, managedRoot)) return null;
  }
  const searchDirs = config.skillSearchDirectories
    ?? await skillSearchDirs(config.root, config.includeUserSkills, config.additionalSkillDirectories);
  const candidates: AgentSkillContentTarget[] = [];

  // 1. Convention directories are dedicated Skill namespaces. Path shape owns
  //    prospective content so a first SKILL.md write is never ungoverned.
  for (const { source, policy, aliases } of searchDirs) {
    if (policy !== 'convention') continue;
    for (const alias of aliases) {
      const target = targetInsideSkillsDir(filePath, alias.dir, source, 'convention');
      if (target) candidates.push(target);
    }
  }

  // 2. A bound container is ordinary user content except for physical Skill
  //    roots admitted by the last complete registry load. Filter the snapshot
  //    through current settings so unbinding drops ownership immediately.
  const activeBoundDirIdentities = new Set(
    searchDirs
      .filter((entry) => entry.policy === 'bound')
      .map((entry) => entry.identity),
  );
  for (const owner of config.loadedBoundSkillRoots ?? []) {
    const skillsDirIdentity = owner.skillsDirIdentity
      ?? await canonicalPathPreservingSuffixAsync(owner.skillsDir);
    if (!activeBoundDirIdentities.has(skillsDirIdentity)) continue;
    const skillRootIdentity = owner.skillRootIdentity
      ?? await canonicalPathPreservingSuffixAsync(owner.skillRoot);
    const target = targetInsideLoadedBoundSkillRoot(filePath, filePathIdentity, owner, skillRootIdentity);
    if (target) candidates.push(target);
  }

  // 3. The definition itself is an admission attempt. Keep exact SKILL.md
  //    creation and repair behind the existing identity/content validators,
  //    without claiming sibling support paths for a Skill that did not load.
  for (const { policy, aliases } of searchDirs) {
    if (policy !== 'bound') continue;
    for (const alias of aliases) {
      const target = targetInsideSkillsDir(filePath, alias.dir, alias.source, 'bound-admission');
      if (target?.isSkillFile) candidates.push(target);
    }
  }

  // 4. Nested .agents/skills under the work root (project) — matched by path so a
  //    brand-new nested skill dir is still governed on its first write.
  const root = path.resolve(config.root);
  if (isPathInside(filePath, root)) {
    const parts = filePath.split(path.sep);
    for (let index = parts.length - 3; index >= 0; index -= 1) {
      if (parts[index] !== '.agents' || parts[index + 1] !== 'skills') continue;
      const skillsDir = parts.slice(0, index + 2).join(path.sep) || path.sep;
      const target = targetInsideSkillsDir(filePath, skillsDir, 'project', 'convention');
      if (target) candidates.push(target);
    }
  }
  return mostSpecificSkillContentTarget(candidates, filePath);
}

function mostSpecificSkillContentTarget(
  candidates: readonly AgentSkillContentTarget[],
  filePath: string,
): AgentSkillContentTarget | null {
  let selected: AgentSkillContentTarget | null = null;
  let selectedScore = '';
  for (const candidate of candidates) {
    const logicalRoot = path.resolve(candidate.skillRoot);
    const lexicalMatch = filePath === logicalRoot || isPathInside(filePath, logicalRoot);
    const depth = logicalRoot.split(path.sep).filter(Boolean).length;
    const ownershipRank = candidate.ownership === 'loaded-bound'
      ? 2
      : candidate.ownership === 'convention' ? 1 : 0;
    const score = `${lexicalMatch ? '1' : '0'}:${String(depth).padStart(6, '0')}:${ownershipRank}:${logicalRoot}`;
    if (selected && score <= selectedScore) continue;
    selected = candidate;
    selectedScore = score;
  }
  return selected;
}

function deduplicateLoadedBoundSkillRoots(roots: readonly LoadedBoundSkillRoot[]): LoadedBoundSkillRoot[] {
  const seen = new Set<string>();
  const result: LoadedBoundSkillRoot[] = [];
  for (const root of roots) {
    const identity = `${path.resolve(root.skillsDir)}\0${path.resolve(root.skillRoot)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(root);
  }
  return result;
}

async function retainAdmittedBoundSkillRoots(input: {
  previous: readonly LoadedBoundSkillRoot[];
  next: readonly LoadedBoundSkillRoot[];
  searchDirectories: readonly SkillSearchDirectory[];
  immutableSkillNames: ReadonlySet<string>;
}): Promise<LoadedBoundSkillRoot[]> {
  const activeBoundDirIdentities = new Set(
    input.searchDirectories
      .filter((entry) => entry.policy === 'bound')
      .map((entry) => entry.identity),
  );
  const retained = [...input.next];
  for (const owner of input.previous) {
    if (input.immutableSkillNames.has(owner.skillName)) continue;
    const skillsDirIdentity = owner.skillsDirIdentity
      ?? await canonicalPathPreservingSuffixAsync(owner.skillsDir);
    if (!activeBoundDirIdentities.has(skillsDirIdentity)) continue;
    const skillRootIdentity = owner.skillRootIdentity
      ?? await canonicalPathPreservingSuffixAsync(owner.skillRoot);
    const currentIdentity = await canonicalPathPreservingSuffixAsync(owner.skillRoot);
    if (currentIdentity !== skillRootIdentity) continue;
    const rootStat = await stat(owner.skillRoot).catch(() => null);
    if (!rootStat?.isDirectory()) continue;
    retained.push({ ...owner, skillRootIdentity, skillsDirIdentity });
  }
  return deduplicateLoadedBoundSkillRoots(retained);
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
    // Admission, not resolution (A12). Canonical identity IS the directory
    // name, so a directory that cannot supply a valid one cannot become a
    // Skill. Refusing it here means no loaded Skill can have an identity the
    // authoring validator rejects; refusing at write-resolution time instead
    // produced a Skill that loaded, listed and ran while its own SKILL.md
    // resolved to no target at all — an ungoverned write.
    if (!isValidSkillName(entry.name)) {
      console.warn(`Skipping skill directory ${rootDir}: "${entry.name}" is not a valid skill name.`);
      continue;
    }
    const skill = await loadSkillFromRoot(rootDir, source, entry.name);
    if (skill) skills.push(skill);
  }
  return skills;
}

async function loadSkillFromRoot(
  rootDir: string,
  source: SkillDefinition['source'],
  name = path.basename(rootDir),
  managedContentHash?: string,
): Promise<SkillDefinition | null> {
  const skillFile = path.join(rootDir, SKILL_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(skillFile, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = parseSkillMarkdown(raw);
    return createSkillDefinition({
      name,
      rootDir,
      skillFile,
      source,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      contentHash: skillContentHash(raw),
      managedContentHash,
    });
  } catch (error) {
    console.warn(`Skipping invalid skill ${skillFile}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The canonical skill content hash, used by BOTH the provenance record (gateway, over
 * in-memory normalized content) and the loader (over raw disk bytes). Both sides must
 * hash the same domain or the Undo safety check stops recognizing agent-written bytes:
 * file tools normalize to
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
  managedContentHash?: string;
}): SkillDefinition {
  const description = compactInlineText(
    coerceString(input.frontmatter.description)
      ?? extractDescriptionFromMarkdown(input.body, input.name),
  );
  const argumentNames = parseArgumentNames(input.frontmatter.arguments);
  const whenToUse = coerceString(input.frontmatter.when_to_use)
    ?? coerceString(input.frontmatter['when-to-use']);
  const { execution, allowedTools, model, effort, shell } = parseSkillExecutionContract(
    input.frontmatter,
    input.body,
  );
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
    contentHash: input.contentHash,
    managedContentHash: input.managedContentHash,
    allowedTools,
    argumentHint: coerceString(input.frontmatter['argument-hint']),
    argumentNames,
    version: coerceString(input.frontmatter.version)
      ?? (isPlainRecord(input.frontmatter.metadata) ? coerceString(input.frontmatter.metadata.version) : undefined),
    model,
    effort,
    shell,
    execution,
    paths: parsePathsFrontmatter(input.frontmatter.paths),
    contentLength: input.body.length,
    body: input.body,
  };
}

export function parseSkillExecutionContract(frontmatter: Record<string, unknown>, body = ''): {
  readonly execution: 'inline' | 'isolated';
  readonly allowedTools: string[];
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly shell: string | undefined;
} {
  const execution = parseSkillExecutionFrontmatter(frontmatter);
  const allowedTools = parseToolListFromFrontmatter(frontmatter['allowed-tools']);
  const model = coerceString(frontmatter.model) === 'inherit'
    ? undefined
    : coerceString(frontmatter.model);
  const effort = coerceString(frontmatter.effort);
  const shell = coerceString(frontmatter.shell)?.trim().toLowerCase();
  if (
    execution === 'inline'
    && (
      allowedTools.length > 0
      || model !== undefined
      || effort !== undefined
      || shell !== undefined
      || containsEmbeddedSkillShell(body)
    )
  ) {
    throw new Error('Inline Skills cannot declare allowed-tools, model, effort, shell, or embedded shell commands; use execution: isolated.');
  }
  if (shell !== undefined && shell !== 'bash') {
    throw new Error(`Unsupported Skill shell "${shell}". Tenon supports shell: bash only.`);
  }
  return { execution, allowedTools, model, effort, shell };
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

function containsEmbeddedSkillShell(content: string): boolean {
  return collectSkillShellMatches(content).length > 0;
}

async function renderSkillContent(
  skill: SkillDefinition,
  args: string,
  threadId: string,
  executeSkillShell?: SkillShellExecutor,
  signal?: AbortSignal,
): Promise<string> {
  const skillDir = skillDirectoryForPrompt(skill);
  let content = skillDir
    ? `Base directory for this skill: ${skillDir}\n\n${skill.body}`
    : skill.body;
  content = substituteArguments(content, args, true, skill.argumentNames);
  if (skillDir) {
    content = content
      .replace(/\$\{AGENT_SKILL_DIR\}/g, skillDir)
      .replace(/\{baseDir\}/g, skillDir);
  }
  content = content.replace(/\$\{AGENT_THREAD_ID\}/g, threadId);
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

function formatIsolatedSkillToolResult(
  skill: SkillDefinition,
  result: SkillIsolatedExecutionResult | undefined,
): string {
  if (!result) return `Skill ${skill.name} finished in an isolated child Thread without a recorded outcome.`;
  const completed = result.status === 'completed';
  return [
    `Skill ${skill.name} finished in an isolated child Thread.`,
    `outcome: ${result.status}`,
    `threadId: ${result.threadId}`,
    `agentRole: ${result.agentRole}`,
    result.transcriptPath ? `transcriptPath: ${result.transcriptPath}` : '',
    result.error ? `error: ${result.error}` : '',
    '',
    completed
      ? 'The child already executed this Skill. Synthesize the completed result below; do not repeat covered work unless it reports a gap or independent verification is explicitly required.'
      : 'Treat the text below as partial evidence only; the isolated Skill did not complete successfully.',
    result.transcriptPath
      ? 'To verify or debug it, read or grep the child transcript at transcriptPath with the file tools.'
      : '',
    '',
    '<skill-result>',
    result.result || 'Skill execution produced no text result.',
    '</skill-result>',
  ].filter(Boolean).join('\n');
}

function skillListingIdentity(skill: SkillDefinition): string {
  return skill.identity ?? skillPathForPrompt(skill);
}

function formatSkillDescription(
  skill: SkillDefinition,
  maxChars = MAX_LISTING_DESCRIPTION_CHARS,
): string {
  const budget = Math.max(0, Math.min(maxChars, MAX_LISTING_DESCRIPTION_CHARS));
  if (budget === 0) return '';
  const authored = authoredSkillDescription(skill);
  if (skill.execution !== 'isolated') return truncate(authored, budget);
  const constraint = isolatedSkillExecutionContract(skill);
  if (budget <= constraint.length) return truncate(constraint, budget);
  const authoredBudget = budget - constraint.length - 1;
  return `${truncate(authored, authoredBudget)} ${constraint}`.trim();
}

function boundedSkillCatalogDescriptions(
  skills: readonly SkillDefinition[],
): ReadonlyMap<string, string> {
  if (skills.length === 0) return new Map();
  const full = skills.map((skill) => [
    skill.name,
    formatSkillDescription(skill, MAX_LISTING_DESCRIPTION_CHARS),
  ] as const);
  const fullLength = full.reduce((total, [name, description]) => total + name.length + description.length + 4, 0);
  if (fullLength <= DEFAULT_SKILL_LISTING_CHAR_BUDGET) return new Map(full);
  const nameOverhead = skills.reduce((total, skill) => total + skill.name.length + 4, 0);
  const contractOverhead = skills.reduce((total, skill) => (
    total + (skill.execution === 'isolated'
      ? isolatedSkillExecutionContract(skill).length + 1
      : 0)
  ), 0);
  const authoredBudget = Math.max(0, DEFAULT_SKILL_LISTING_CHAR_BUDGET - nameOverhead - contractOverhead);
  const perAuthoredDescription = Math.floor(authoredBudget / skills.length);
  return new Map(skills.map((skill) => [
    skill.name,
    skill.execution === 'isolated'
      ? formatSkillDescription(
          skill,
          isolatedSkillExecutionContract(skill).length + 1 + perAuthoredDescription,
        )
      : perAuthoredDescription < MIN_NON_EMPTY_DESCRIPTION_CHARS
        ? ''
        : truncate(authoredSkillDescription(skill), Math.min(perAuthoredDescription, MAX_LISTING_DESCRIPTION_CHARS)),
  ]));
}

function authoredSkillDescription(skill: SkillDefinition): string {
  return skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
}

function isolatedSkillExecutionContract(skill: SkillDefinition): string {
  return skill.allowedTools.includes('agent')
    ? 'Isolated child; Subagent spawn declared; parent ceiling applies.'
    : 'Isolated child; no Subagents; parent handles fan-out.';
}

function codeRegisteredSkillContentHash(skill: SkillDefinition): string {
  return createHash('sha256').update(JSON.stringify({
    name: skill.name,
    displayName: skill.displayName ?? null,
    description: skill.description,
    whenToUse: skill.whenToUse ?? null,
    allowedTools: skill.allowedTools,
    argumentHint: skill.argumentHint ?? null,
    argumentNames: skill.argumentNames,
    model: skill.model ?? null,
    effort: skill.effort ?? null,
    execution: skill.execution,
    body: skill.body,
  })).digest('hex');
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
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

/**
 * Canonicalises one configured Skill directory. The setting may hold `~/skills`,
 * `./skills`, or a trailing-slash path; the loader expands these before use, so
 * anything comparing a stored value against a loaded Skill's rootDir must expand
 * it the same way or it will match nothing.
 */
export function expandSkillDirectory(value: string, root: string): string {
  return expandConfiguredPath(value, root);
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
  return 'inline';
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

/**
 * Strict containment — this file's callers treat the root itself as outside, unlike the
 * shared predicate, which admits it. The adapter carries only that contract difference
 * (and the argument order these call sites read in); the predicate has one implementation.
 */
function isPathInside(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate !== resolvedRoot && isPathInsideOrEqual(resolvedRoot, resolvedCandidate);
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function isGitIgnored(
  root: string,
  candidate: string,
): Promise<boolean> {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const result = await runAgentToolProcess(
    'git',
    ['-C', root, 'check-ignore', '-q', '--', normalizePathForPrompt(relative)],
    root,
    5_000,
    {
      maxStdoutChars: 1_024,
      maxStderrChars: 1_024,
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
    },
  );
  return result.exitCode === 0;
}
