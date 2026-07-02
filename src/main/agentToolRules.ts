const TOOL_NAME_ALIASES: Record<string, string> = {
  read: 'file_read',
  glob: 'file_glob',
  grep: 'file_grep',
  edit: 'file_edit',
  write: 'file_write',
};

export function normalizeAgentToolRuleName(rule: string): string | null {
  const raw = rule.trim();
  if (!raw) return null;
  if (raw === '*') return '*';
  const name = raw.split('(')[0]!.trim().toLowerCase().replace(/-/g, '_');
  return TOOL_NAME_ALIASES[name] ?? name;
}

export function normalizeAgentToolNames(rules: readonly string[] | undefined): string[] | undefined {
  if (!rules) return undefined;
  const names = rules
    .map((rule) => normalizeAgentToolRuleName(rule))
    .filter((name): name is string => Boolean(name));
  return names.includes('*') ? ['*'] : [...new Set(names)];
}

export function isAgentToolAllowedByRules(
  toolName: string,
  allowedRules: readonly string[] | undefined,
  disallowedRules: readonly string[] | undefined,
): boolean {
  const name = normalizeAgentToolRuleName(toolName);
  if (!name) return false;
  const allowed = normalizeAgentToolNames(allowedRules);
  const disallowed = normalizeAgentToolNames(disallowedRules);
  if (allowed && !allowed.includes('*') && !allowed.includes(name)) return false;
  if (disallowed?.includes('*') || disallowed?.includes(name)) return false;
  return true;
}
