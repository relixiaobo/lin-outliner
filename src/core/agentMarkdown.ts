// The AGENT.md format layer: serialize an authoring input to frontmatter+body
// and parse it back. The SERIALIZE side is shared by main's write surface
// (`agentAuthoring.ts`) and the renderer's Form ⇄ Raw editor, so a UI-authored
// file is written one way. NOTE: the registry loader (`agentDelegation.ts`
// `parseAgentMarkdown` / `createAgentDefinition`) still carries its OWN parser
// copy — it does not yet consume `parseAgentAuthoringInput` here. The two parsers
// are byte-equivalent today but CAN drift; consolidating the loader onto this
// module is a tracked follow-up (see [[agent-authoring]]). Pure — only `yaml`, no fs.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentAuthoringInput } from './agentTypes';
import type { AgentPermissionMode } from './types';

/**
 * Serialize an authoring input to `AGENT.md` text. Only set fields are emitted;
 * frontmatter keys are the canonical kebab-case forms the parser reads back.
 */
export function serializeAgentMarkdown(input: AgentAuthoringInput): string {
  const frontmatter: Record<string, unknown> = {};
  frontmatter.name = input.name.trim();
  const description = input.description.trim();
  if (description) frontmatter.description = description;
  if (input.model && input.model.trim() && input.model !== 'inherit') frontmatter.model = input.model.trim();
  if (input.effort && input.effort.trim()) frontmatter.effort = input.effort.trim();
  if (input.permissionMode) frontmatter['permission-mode'] = input.permissionMode;
  if (typeof input.maxTurns === 'number' && Number.isInteger(input.maxTurns) && input.maxTurns > 0) {
    frontmatter['max-turns'] = input.maxTurns;
  }
  const tools = cleanList(input.tools);
  if (tools) frontmatter.tools = tools;
  const disallowedTools = cleanList(input.disallowedTools);
  if (disallowedTools) frontmatter['disallowed-tools'] = disallowedTools;
  const skills = cleanList(input.skills);
  if (skills) frontmatter.skills = skills;
  if (input.background) frontmatter.background = true;

  const yaml = stringifyYaml(frontmatter).trimEnd();
  const body = input.body.trim();
  return `---\n${yaml}\n---\n\n${body}\n`;
}

/** Split a raw `AGENT.md` into its frontmatter record and markdown body. */
export function parseAgentMarkdownDocument(raw: string): { frontmatter: Record<string, unknown>; body: string } {
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
  return { frontmatter: parseFrontmatter(frontmatterText), body };
}

/**
 * Parse a raw `AGENT.md` into the editable authoring shape — the inverse of
 * {@link serializeAgentMarkdown}. Identity/location fields are NOT here (the
 * registry derives them from the storage location). Used by the renderer's Raw
 * editor mode to round-trip into the structured form.
 */
export function parseAgentAuthoringInput(raw: string): AgentAuthoringInput {
  const { frontmatter, body } = parseAgentMarkdownDocument(raw);
  return {
    name: coerceString(frontmatter.name) ?? '',
    description: coerceString(frontmatter.description) ?? '',
    body: body.trim(),
    model: normalizeModelField(coerceString(frontmatter.model)),
    effort: coerceString(frontmatter.effort),
    permissionMode: parsePermissionMode(frontmatter['permission-mode'] ?? frontmatter.permissionMode),
    maxTurns: parsePositiveInteger(frontmatter['max-turns'] ?? frontmatter.maxTurns),
    tools: parseStringList(frontmatter.tools),
    disallowedTools: parseStringList(frontmatter['disallowed-tools'] ?? frontmatter.disallowedTools),
    skills: parseStringList(frontmatter.skills),
    background: parseBoolean(frontmatter.background),
  };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(text);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanList(value: string[] | undefined): string[] | undefined {
  if (!value?.length) return undefined;
  const items = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

export function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
    return items.length > 0 ? [...new Set(items)] : undefined;
  }
  if (typeof value === 'string') {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? [...new Set(items)] : undefined;
  }
  return undefined;
}

export function parsePermissionMode(value: unknown): AgentPermissionMode | undefined {
  return value === 'trusted' || value === 'restricted' ? value : undefined;
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return undefined;
}

export function parsePositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

export function normalizeModelField(value: string | undefined): string | undefined {
  return !value || value === 'inherit' ? undefined : value;
}

export function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
