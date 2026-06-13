import {
  actionKindFromRuleValue,
  actionKindRuleValue,
  safetyModeDefaultActionDecision,
  type AgentToolActionKind,
  type GlobalToolPermissionDecision,
} from '../../../core/agentPermissionModel';
import type { Messages } from '../../../core/i18n';
import type { AgentSafetyMode } from '../../../core/types';
import type { AgentToolPermissionSettingsView } from '../../api/types';

export type PermissionRuleId =
  | 'readOutsideArea'
  | 'readSensitivePaths'
  | 'fetchWeb'
  | 'deleteFiles'
  | 'runProjectScripts'
  | 'installDependencies'
  | 'publishGitRemotes'
  | 'deployPublish'
  | 'networkWrite';

export interface CommonPermissionRule {
  id: PermissionRuleId;
  actionKind: AgentToolActionKind;
  ruleValue: string;
}

export interface PermissionExceptionRow {
  ruleValue: string;
  decision: GlobalToolPermissionDecision;
  kind: 'action' | 'raw';
}

export const COMMON_PERMISSION_RULES: readonly CommonPermissionRule[] = [
  permissionRule('readOutsideArea', 'file.read.outside_allowed_file_area'),
  permissionRule('readSensitivePaths', 'file.read.sensitive_local_path'),
  permissionRule('fetchWeb', 'web.fetch'),
  permissionRule('deleteFiles', 'file.delete.allowed_file_area'),
  permissionRule('runProjectScripts', 'shell.project_script'),
  permissionRule('installDependencies', 'shell.dependency_install'),
  permissionRule('publishGitRemotes', 'git.publish_remote'),
  permissionRule('deployPublish', 'deploy.publish_remote'),
  permissionRule('networkWrite', 'shell.network_write'),
];

const COMMON_PERMISSION_RULE_BY_VALUE = new Map(COMMON_PERMISSION_RULES.map((rule, index) => [
  rule.ruleValue,
  { rule, index },
]));

function permissionRule(id: PermissionRuleId, actionKind: AgentToolActionKind): CommonPermissionRule {
  return { id, actionKind, ruleValue: actionKindRuleValue(actionKind) };
}

export function buildPermissionExceptionRows(
  permissions: AgentToolPermissionSettingsView['permissions'],
  safetyMode: AgentSafetyMode,
): PermissionExceptionRow[] {
  return uniqueStrings([...permissions.deny, ...permissions.ask, ...permissions.allow])
    .map((ruleValue): PermissionExceptionRow | null => {
      const decision = explicitRuleDecision(ruleValue, permissions);
      if (!decision) return null;
      const actionKind = actionKindFromRuleValue(ruleValue);
      if (!actionKind) return { ruleValue, decision, kind: 'raw' };
      const modeDefault = safetyModeDefaultActionDecision(actionKind, safetyMode);
      if (decision === modeDefault) return null;
      return { ruleValue, decision, kind: 'action' };
    })
    .filter((row): row is PermissionExceptionRow => row !== null)
    .sort(comparePermissionExceptionRows);
}

export function explicitRuleDecision(
  ruleValue: string,
  permissions: AgentToolPermissionSettingsView['permissions'],
): GlobalToolPermissionDecision | null {
  if (permissions.deny.includes(ruleValue)) return 'deny';
  if (permissions.ask.includes(ruleValue)) return 'ask';
  if (permissions.allow.includes(ruleValue)) return 'allow';
  return null;
}

export function permissionRuleCopy(ruleValue: string, t: Messages) {
  const known = COMMON_PERMISSION_RULE_BY_VALUE.get(ruleValue);
  if (known) return t.settings.permissions.rules[known.rule.id];
  const actionKind = actionKindFromRuleValue(ruleValue);
  if (actionKind) {
    return {
      label: actionKind,
      description: t.settings.permissions.rawActionDescription({ action: actionKind }),
    };
  }
  return {
    label: ruleValue,
    description: t.settings.permissions.rawRuleDescription,
  };
}

export function safetyModeLabel(mode: AgentSafetyMode, t: Messages): string {
  if (mode === 'ask_first') return t.settings.permissions.askFirstMode;
  if (mode === 'full_access') return t.settings.permissions.fullAccessMode;
  return t.settings.permissions.balancedMode;
}

export function permissionDecisionLabel(decision: GlobalToolPermissionDecision, t: Messages): string {
  if (decision === 'allow') return t.settings.permissions.allowOption;
  if (decision === 'deny') return t.settings.permissions.denyOption;
  return t.settings.permissions.askOption;
}

export function permissionSettingsWithoutRule(
  settings: AgentToolPermissionSettingsView,
  ruleValue: string,
): AgentToolPermissionSettingsView {
  return {
    ...settings,
    permissions: {
      allow: uniqueStrings(removeRule(settings.permissions.allow, ruleValue)),
      ask: uniqueStrings(removeRule(settings.permissions.ask, ruleValue)),
      deny: uniqueStrings(removeRule(settings.permissions.deny, ruleValue)),
    },
  };
}

export function permissionSettingsWithDecision(
  settings: AgentToolPermissionSettingsView,
  ruleValue: string,
  decision: GlobalToolPermissionDecision | 'default',
  safetyMode: AgentSafetyMode,
): AgentToolPermissionSettingsView {
  const next = permissionSettingsWithoutRule(settings, ruleValue);
  if (decision === 'default') return next;

  const actionKind = actionKindFromRuleValue(ruleValue);
  const modeDefault = actionKind ? safetyModeDefaultActionDecision(actionKind, safetyMode) : null;
  if (decision === modeDefault) return next;

  const allow = [...next.permissions.allow];
  const ask = [...next.permissions.ask];
  const deny = [...next.permissions.deny];
  if (decision === 'allow') allow.push(ruleValue);
  else if (decision === 'deny') deny.push(ruleValue);
  else ask.push(ruleValue);
  return {
    ...next,
    permissions: {
      allow: uniqueStrings(allow),
      ask: uniqueStrings(ask),
      deny: uniqueStrings(deny),
    },
  };
}

function comparePermissionExceptionRows(left: PermissionExceptionRow, right: PermissionExceptionRow): number {
  const leftIndex = commonPermissionRuleIndex(left.ruleValue);
  const rightIndex = commonPermissionRuleIndex(right.ruleValue);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return left.ruleValue.localeCompare(right.ruleValue);
}

function commonPermissionRuleIndex(ruleValue: string): number {
  return COMMON_PERMISSION_RULE_BY_VALUE.get(ruleValue)?.index ?? Number.MAX_SAFE_INTEGER;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function removeRule(values: readonly string[], ruleValue: string): string[] {
  return values.filter((value) => value !== ruleValue);
}
