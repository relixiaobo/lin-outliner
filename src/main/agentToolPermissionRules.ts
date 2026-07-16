import path from 'node:path';
import {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  actionKindFromRuleValue,
  type AgentPermissionFloorKind,
  type AgentToolActionKind,
} from '../core/agentPermissionModel';

export {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  type AgentPermissionFloorKind,
  type AgentToolActionKind,
} from '../core/agentPermissionModel';

export type ToolPermissionOutcome = 'allow' | 'folder_required' | 'blocked';
export type ToolAccessScope = 'allowed_file_area' | 'outside_allowed_file_area' | 'external_system' | 'none';

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
  floor?: AgentPermissionFloorKind;
  platformHardBlock?: boolean;
}

export type AgentPermissionBlock =
  | { kind: 'action'; actionKind: AgentToolActionKind }
  | { kind: 'command'; form: string };

export interface GlobalToolPermissionBlockRule {
  ruleValue: string;
  block: AgentPermissionBlock;
}

export interface GlobalToolPermissionRuleDiagnostic {
  ruleValue: string;
  code: 'invalid_block' | 'unsupported_block';
  message: string;
}

export interface GlobalToolPermissionConfig {
  folders: string[];
  blocks: GlobalToolPermissionBlockRule[];
  diagnostics: GlobalToolPermissionRuleDiagnostic[];
}

export interface GlobalToolPermissionSettings {
  folders?: unknown;
  blocks?: unknown;
}

const SUPPORTED_ACTION_KIND_SET = new Set<string>(SUPPORTED_AGENT_TOOL_ACTION_KINDS);

export function parseGlobalToolPermissionSettings(input: unknown): GlobalToolPermissionConfig {
  if (looksParsedGlobalToolPermissionConfig(input)) return input;
  const settings = isRecord(input) ? input as GlobalToolPermissionSettings : {};
  const folders = normalizedStrings(settings.folders).map((folder) => path.resolve(folder));
  const blocks: GlobalToolPermissionBlockRule[] = [];
  const diagnostics: GlobalToolPermissionRuleDiagnostic[] = [];
  const blockEntries = Array.isArray(settings.blocks) ? settings.blocks : [];

  for (const entry of blockEntries) {
    if (typeof entry !== 'string') {
      diagnostics.push({
        ruleValue: String(entry),
        code: 'invalid_block',
        message: 'Permission block rules must be strings.',
      });
      continue;
    }
    const parsed = parseGlobalToolPermissionBlock(entry);
    if ('diagnostic' in parsed) diagnostics.push(parsed.diagnostic);
    else blocks.push(parsed.rule);
  }

  return { folders: compactPaths(folders), blocks, diagnostics };
}

export function globalToolPermissionConfigToSettings(
  config: GlobalToolPermissionConfig,
): Required<GlobalToolPermissionSettings> {
  return {
    folders: [...config.folders],
    blocks: config.blocks.map((block) => block.ruleValue),
  };
}

export function matchingBlockForDescriptor(
  descriptor: ToolActionDescriptor,
  configInput?: unknown,
): GlobalToolPermissionBlockRule | null {
  const config = normalizePermissionConfig(configInput);
  return config.blocks.find((rule) => blockMatchesDescriptor(rule.block, descriptor)) ?? null;
}

export function normalizePermissionToolName(value: string): string {
  return value.trim().replace(/-/g, '_').toLowerCase();
}

function parseGlobalToolPermissionBlock(
  ruleValueInput: string,
): { rule: GlobalToolPermissionBlockRule } | { diagnostic: GlobalToolPermissionRuleDiagnostic } {
  const ruleValue = ruleValueInput.trim();
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\(([\s\S]*)\)$/.exec(ruleValue);
  if (!match) {
    return diagnostic(ruleValue, 'invalid_block', 'Permission blocks must use Action(...) or Command(...).');
  }
  const kind = normalizePermissionToolName(match[1] ?? '');
  const rawValue = (match[2] ?? '').trim();
  if (!rawValue || rawValue === '*') {
    return diagnostic(ruleValue, 'unsupported_block', 'Broad or empty permission blocks are not supported.');
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
  return diagnostic(ruleValue, 'unsupported_block', `Unsupported permission block kind: ${kind}.`);
}

function blockMatchesDescriptor(block: AgentPermissionBlock, descriptor: ToolActionDescriptor): boolean {
  if (block.kind === 'action') return block.actionKind === descriptor.actionKind;
  if (block.kind === 'command') {
    return Boolean(descriptor.command) && commandsEqual(block.form, descriptor.command ?? '');
  }
  return false;
}

function commandsEqual(left: string, right: string): boolean {
  return normalizeCommandForPermissionMatch(left) === normalizeCommandForPermissionMatch(right);
}

function normalizeCommandForPermissionMatch(command: string): string {
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

function compactPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const candidate of [...new Set(paths)].sort((left, right) => left.length - right.length)) {
    if (result.some((root) => isPathInside(root, candidate))) continue;
    result.push(candidate);
  }
  return result;
}

function isPathInside(rootInput: string, candidateInput: string): boolean {
  const root = path.resolve(rootInput);
  const candidate = path.resolve(candidateInput);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((candidate) => (
    typeof candidate === 'string' && candidate.trim() ? [candidate.trim()] : []
  )))];
}

function diagnostic(
  ruleValue: string,
  code: GlobalToolPermissionRuleDiagnostic['code'],
  message: string,
): { diagnostic: GlobalToolPermissionRuleDiagnostic } {
  return { diagnostic: { ruleValue, code, message } };
}

function normalizePermissionConfig(input?: unknown): GlobalToolPermissionConfig {
  return looksParsedGlobalToolPermissionConfig(input)
    ? input
    : parseGlobalToolPermissionSettings(input);
}

function looksParsedGlobalToolPermissionConfig(value: unknown): value is GlobalToolPermissionConfig {
  return isRecord(value)
    && Array.isArray(value.folders)
    && Array.isArray(value.blocks)
    && Array.isArray(value.diagnostics)
    && (value.blocks.length === 0 || isParsedBlockRule(value.blocks[0]));
}

function isParsedBlockRule(value: unknown): value is GlobalToolPermissionBlockRule {
  return isRecord(value)
    && typeof value.ruleValue === 'string'
    && isRecord(value.block)
    && typeof value.block.kind === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
