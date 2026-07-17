import {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  actionKindFromRuleValue,
  type AgentToolActionKind,
} from '../core/agentActionCatalog';

export {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  type AgentToolActionKind,
} from '../core/agentActionCatalog';
export type ToolAccessScope = 'local_system' | 'external_system' | 'none';

export interface ToolActionDescriptor {
  toolName: string;
  actionKind: AgentToolActionKind;
  accessScope: ToolAccessScope;
  title: string;
  summary: string;
  consequence: string;
  command?: string;
  targetPath?: string;
  code?: string;
}

export type AgentCapabilityBlock =
  | { kind: 'action'; actionKind: AgentToolActionKind }
  | { kind: 'command'; form: string };

export interface AgentCapabilityBlockRule {
  ruleValue: string;
  block: AgentCapabilityBlock;
}

export interface AgentCapabilityRuleDiagnostic {
  ruleValue: string;
  code: 'invalid_block' | 'unsupported_block';
  message: string;
}

export interface AgentCapabilityConfig {
  blocks: AgentCapabilityBlockRule[];
  diagnostics: AgentCapabilityRuleDiagnostic[];
}

export interface AgentCapabilitySettings {
  blocks?: unknown;
}

export interface NormalizedAgentCapabilitySettings {
  blocks: string[];
}

const SUPPORTED_ACTION_KIND_SET = new Set<string>(SUPPORTED_AGENT_TOOL_ACTION_KINDS);

export function parseAgentCapabilitySettings(input: unknown): AgentCapabilityConfig {
  if (looksParsedAgentCapabilityConfig(input)) return input;
  const settings = isRecord(input) ? input as AgentCapabilitySettings : {};
  const blocks: AgentCapabilityBlockRule[] = [];
  const diagnostics: AgentCapabilityRuleDiagnostic[] = [];
  const blockEntries = Array.isArray(settings.blocks) ? settings.blocks : [];

  for (const entry of blockEntries) {
    if (typeof entry !== 'string') {
      diagnostics.push({
        ruleValue: String(entry),
        code: 'invalid_block',
        message: 'Block rules must be strings.',
      });
      continue;
    }
    const parsed = parseAgentCapabilityBlock(entry);
    if ('diagnostic' in parsed) diagnostics.push(parsed.diagnostic);
    else blocks.push(parsed.rule);
  }

  return { blocks, diagnostics };
}

export function agentCapabilityConfigToSettings(
  config: AgentCapabilityConfig,
): NormalizedAgentCapabilitySettings {
  return {
    blocks: config.blocks.map((block) => block.ruleValue),
  };
}

export function matchingBlockForDescriptor(
  descriptor: ToolActionDescriptor,
  configInput?: unknown,
): AgentCapabilityBlockRule | null {
  const config = normalizeCapabilityConfig(configInput);
  return config.blocks.find((rule) => blockMatchesDescriptor(rule.block, descriptor)) ?? null;
}

export function normalizeCapabilityToolName(value: string): string {
  return value.trim().replace(/-/g, '_').toLowerCase();
}

function parseAgentCapabilityBlock(
  ruleValueInput: string,
): { rule: AgentCapabilityBlockRule } | { diagnostic: AgentCapabilityRuleDiagnostic } {
  const ruleValue = ruleValueInput.trim();
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\(([\s\S]*)\)$/.exec(ruleValue);
  if (!match) {
    return diagnostic(ruleValue, 'invalid_block', 'Blocks must use Action(...) or Command(...).');
  }
  const kind = normalizeCapabilityToolName(match[1] ?? '');
  const rawValue = (match[2] ?? '').trim();
  if (!rawValue || rawValue === '*') {
    return diagnostic(ruleValue, 'unsupported_block', 'Broad or empty blocks are not supported.');
  }

  if (kind === 'action') {
    const actionKind = actionKindFromRuleValue(`Action(${rawValue})`);
    if (!actionKind || !SUPPORTED_ACTION_KIND_SET.has(actionKind)) {
      return diagnostic(ruleValue, 'unsupported_block', `Unsupported action kind: ${rawValue}.`);
    }
    return { rule: { ruleValue, block: { kind: 'action', actionKind } } };
  }
  if (kind === 'command') {
    return { rule: { ruleValue, block: { kind: 'command', form: rawValue } } };
  }
  return diagnostic(ruleValue, 'unsupported_block', `Unsupported block kind: ${kind}.`);
}

function blockMatchesDescriptor(block: AgentCapabilityBlock, descriptor: ToolActionDescriptor): boolean {
  if (block.kind === 'action') return block.actionKind === descriptor.actionKind;
  if (block.kind === 'command') {
    return Boolean(descriptor.command) && commandsEqual(block.form, descriptor.command ?? '');
  }
  return false;
}

function commandsEqual(left: string, right: string): boolean {
  return normalizeCommandForBlockMatch(left) === normalizeCommandForBlockMatch(right);
}

function normalizeCommandForBlockMatch(command: string): string {
  const trimmed = command.trim();
  let normalized = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let pendingSpace = false;
  for (const char of trimmed) {
    if (escaped) {
      normalized += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (pendingSpace && normalized) normalized += ' ';
      pendingSpace = false;
      normalized += char;
      escaped = true;
      continue;
    }
    if (quote) {
      normalized += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      if (pendingSpace && normalized) normalized += ' ';
      pendingSpace = false;
      quote = char;
      normalized += char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (normalized) pendingSpace = true;
      continue;
    }
    if (pendingSpace && normalized) normalized += ' ';
    pendingSpace = false;
    normalized += char;
  }
  return normalized;
}

function diagnostic(
  ruleValue: string,
  code: AgentCapabilityRuleDiagnostic['code'],
  message: string,
): { diagnostic: AgentCapabilityRuleDiagnostic } {
  return { diagnostic: { ruleValue, code, message } };
}

function normalizeCapabilityConfig(input?: unknown): AgentCapabilityConfig {
  return looksParsedAgentCapabilityConfig(input)
    ? input
    : parseAgentCapabilitySettings(input);
}

function looksParsedAgentCapabilityConfig(value: unknown): value is AgentCapabilityConfig {
  return isRecord(value)
    && Array.isArray(value.blocks)
    && Array.isArray(value.diagnostics)
    && (value.blocks.length === 0 || isParsedBlockRule(value.blocks[0]));
}

function isParsedBlockRule(value: unknown): value is AgentCapabilityBlockRule {
  return isRecord(value)
    && typeof value.ruleValue === 'string'
    && isRecord(value.block)
    && typeof value.block.kind === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
