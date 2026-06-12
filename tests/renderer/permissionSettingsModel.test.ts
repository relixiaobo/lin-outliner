import { describe, expect, test } from 'bun:test';
import { actionKindRuleValue } from '../../src/core/agentPermissionModel';
import {
  buildPermissionExceptionRows,
  permissionSettingsWithDecision,
} from '../../src/renderer/ui/agent/permissionSettingsModel';
import type { AgentToolPermissionSettingsView } from '../../src/renderer/api/types';

function settings(permissions: AgentToolPermissionSettingsView['permissions']): AgentToolPermissionSettingsView {
  return { permissions, diagnostics: [] };
}

describe('permission settings model', () => {
  test('hides redundant action rules that match the active mode', () => {
    const rows = buildPermissionExceptionRows({
      allow: [actionKindRuleValue('web.fetch')],
      ask: [],
      deny: [],
    }, 'full_access');

    expect(rows).toEqual([]);
  });

  test('keeps raw non-action rules as advanced exceptions', () => {
    const rows = buildPermissionExceptionRows({
      allow: [],
      ask: [],
      deny: ['Tool(web_fetch)'],
    }, 'full_access');

    expect(rows).toEqual([{
      ruleValue: 'Tool(web_fetch)',
      decision: 'deny',
      kind: 'raw',
    }]);
  });

  test('does not persist decisions that equal the active mode default', () => {
    const result = permissionSettingsWithDecision(
      settings({ allow: [], ask: [], deny: [] }),
      actionKindRuleValue('web.fetch'),
      'allow',
      'full_access',
    );

    expect(result.permissions).toEqual({ allow: [], ask: [], deny: [] });
  });
});
