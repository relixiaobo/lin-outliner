import { describe, expect, test } from 'bun:test';
import {
  COLLABORATION_NAMESPACE,
  COLLABORATION_TOOL_NAMES,
  MODEL_TOOL_ACTION_KINDS,
  MODEL_TOOL_CATALOG,
  REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS,
  REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS,
  assembleModelToolRegistry,
  canonicalModelToolKey,
  decodeProviderToolName,
  encodeProviderToolName,
  modelToolActionKinds,
  modelToolActionKindFromRule,
  modelToolContract,
  modelToolCommandsMatch,
  normalizeModelToolCommandForBlockMatch,
  normalizeRequestUserInputToolInput,
  normalizeUpdatePlanToolInput,
} from '../../src/core/agent/tools';

describe('Codex Agent Core model-tool contract', () => {
  test('uses one collision-free canonical registry with fixed collaboration namespace', () => {
    const keys = MODEL_TOOL_CATALOG.map((tool) => canonicalModelToolKey(tool.identity));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => key.startsWith(`${COLLABORATION_NAMESPACE}.`))).toEqual(
      COLLABORATION_TOOL_NAMES.map((name) => `${COLLABORATION_NAMESPACE}.${name}`),
    );
    expect(keys).toContain('request_user_input');
    expect(keys).toContain('update_plan');
    expect(keys).toContain('get_goal');
    expect(keys).toContain('create_goal');
    expect(keys).toContain('update_goal');
    expect(keys).toContain('skill');
  });

  test('has no legacy aliases or removed Issue and AgentSession tools', () => {
    const removedNames = [
      'issue_search',
      'issue_read',
      'issue_create',
      'issue_update',
      'agent_session_start',
      'agent_session_read',
      'agent_session_send_message',
      'agent_session_stop',
      'past_chats',
      'ask_user_question',
      'internal_delegation',
      'send_input',
      'resume_agent',
      'close_agent',
      'assign_task',
    ];
    for (const name of removedNames) expect(modelToolContract(name)).toBeNull();
    const serialized = JSON.stringify(MODEL_TOOL_CATALOG);
    expect(serialized).not.toContain('waitingOnApproval');
    expect(serialized).not.toContain('approvalPolicy');
    expect(serialized).not.toContain('sandboxPolicy');
    expect(serialized).not.toContain('permissionProfile');
  });

  test('round-trips canonical and flat provider encodings without aliases', () => {
    const identity = { namespace: COLLABORATION_NAMESPACE, name: 'spawn_agent' } as const;
    expect(encodeProviderToolName(identity, 'canonical')).toBe('collaboration.spawn_agent');
    expect(encodeProviderToolName(identity, 'flat')).toBe('collaboration__spawn_agent');
    expect(decodeProviderToolName('collaboration__spawn_agent', 'flat')).toEqual(identity);
    expect(decodeProviderToolName('spawn_agent', 'flat')).toBeNull();
    expect(decodeProviderToolName('multi_agent_v1__spawn_agent', 'flat')).toBeNull();
  });

  test('requires retained schemas and accepts non-reserved extension tools', () => {
    expect(() => assembleModelToolRegistry([])).toThrow('Missing model-tool schemas');
    const contributions = MODEL_TOOL_CATALOG
      .filter((contract) => contract.inputSchema === null)
      .map((contract) => ({
        identity: contract.identity,
        owner: contract.schemaOwner as 'capability' | 'configuration',
        inputSchema: { type: 'object', additionalProperties: false },
      }));
    const automation = {
      identity: { namespace: 'codex_app', name: 'automation_update' },
      description: 'Create or update one Automation.',
      scope: 'rootThread',
      schemaOwner: 'extension',
      inputSchema: { type: 'object', additionalProperties: false },
      actionKinds: ['agent.plan.update'],
    } as const;
    const registry = assembleModelToolRegistry(contributions, [automation]);
    expect(registry.every((contract) => contract.inputSchema !== null)).toBe(true);
    expect(encodeProviderToolName(automation.identity, 'flat', registry)).toBe('codex_app__automation_update');
    expect(decodeProviderToolName('codex_app__automation_update', 'flat', registry)).toEqual(automation.identity);
    expect(() => assembleModelToolRegistry(contributions, [{
      ...automation,
      identity: { namespace: 'collaboration', name: 'automation_update' },
    }])).toThrow('namespace is reserved');
    expect(() => assembleModelToolRegistry(contributions, [{
      ...automation,
      schemaOwner: 'core',
    }])).toThrow('must be owned by extension');
    expect(() => assembleModelToolRegistry(contributions, [{
      ...automation,
      identity: { namespace: 'foo__bar', name: 'baz' },
    }])).toThrow('reserved flat-provider separator');
    expect(() => assembleModelToolRegistry(contributions, [{
      ...automation,
      identity: { namespace: 'foo', name: 'bar__baz' },
    }])).toThrow('reserved flat-provider separator');
  });

  test('keeps request_user_input root-only and normalizes its bounded contract', () => {
    expect(modelToolContract('request_user_input')?.scope).toBe('rootThread');
    const normalized = normalizeRequestUserInputToolInput({
      questions: [{
        id: 'delivery_mode',
        header: 'Delivery',
        question: 'How should this ship?',
        options: [
          { label: 'Direct (Recommended)', description: 'Ship the complete replacement.' },
          { label: 'Pause', description: 'Wait for another decision.' },
        ],
      }],
      autoResolutionMs: 1,
    });
    expect(normalized.autoResolutionMs).toBe(REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS);
    expect(normalizeRequestUserInputToolInput({
      ...normalized,
      autoResolutionMs: Number.MAX_SAFE_INTEGER,
    }).autoResolutionMs).toBe(REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS);
    expect(normalizeRequestUserInputToolInput({
      ...normalized,
      autoResolutionMs: 60_000.5,
    }).autoResolutionMs).toBe(60_001);
    expect(() => normalizeRequestUserInputToolInput({ questions: [] })).toThrow('one to three');
    expect(() => normalizeRequestUserInputToolInput({
      questions: [{
        id: 'delivery-mode',
        header: 'Delivery',
        question: 'How?',
        options: [
          { label: 'A', description: 'A' },
          { label: 'Other', description: 'Other' },
        ],
      }],
    })).toThrow('snake_case');
    expect(() => normalizeRequestUserInputToolInput({
      questions: [{
        id: 'delivery_mode',
        header: 'Delivery',
        question: 'How?',
        options: [
          { label: 'Direct', description: 'A' },
          { label: 'Pause', description: 'B' },
        ],
      }],
    })).toThrow('recommended choice');
    expect(() => normalizeRequestUserInputToolInput({
      questions: [
        {
          id: 'delivery_mode',
          header: 'Delivery',
          question: 'How?',
          options: [
            { label: 'Direct (Recommended)', description: 'A' },
            { label: 'Pause', description: 'B' },
          ],
        },
        {
          id: 'delivery_mode',
          header: 'Timing',
          question: 'When?',
          options: [
            { label: 'Now (Recommended)', description: 'A' },
            { label: 'Later', description: 'B' },
          ],
        },
      ],
    })).toThrow('question ids must be unique');
    expect(() => normalizeRequestUserInputToolInput({
      questions: [{
        id: 'delivery_mode',
        header: 'Longer than 12',
        question: 'How?',
        options: [
          { label: 'Direct (Recommended)', description: 'A' },
          { label: 'Pause', description: 'B' },
        ],
      }],
    })).toThrow('must not exceed 12 characters');
  });

  test('normalizes update_plan and permits at most one active step', () => {
    const normalized = normalizeUpdatePlanToolInput({
      explanation: 'Continue the replacement.',
      plan: [
        { step: 'Define interfaces', status: 'completed' },
        { step: 'Replace runtime', status: 'in_progress' },
        { step: 'Audit residue', status: 'pending' },
      ],
    });
    expect(normalized.plan).toHaveLength(3);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.plan)).toBe(true);
    expect(Object.isFrozen(normalized.plan[0])).toBe(true);
    expect(() => normalizeUpdatePlanToolInput({
      plan: [
        { step: 'Replace runtime', status: 'in_progress' },
        { step: 'Replace renderer', status: 'in_progress' },
      ],
    })).toThrow('at most one in_progress');
    expect(() => normalizeUpdatePlanToolInput({
      plan: [{ step: '', status: 'pending' }],
    })).toThrow('must be a non-empty string');
  });

  test('normalizes command whitespace only outside quotes for explicit blocks', () => {
    expect(normalizeModelToolCommandForBlockMatch('  git   push\norigin   main  ')).toBe('git push origin main');
    expect(normalizeModelToolCommandForBlockMatch('printf "a   b"   file')).toBe('printf "a   b" file');
    expect(normalizeModelToolCommandForBlockMatch("printf 'a   b'   file")).toBe("printf 'a   b' file");
    expect(modelToolCommandsMatch('git   push origin main', ' git push origin  main ')).toBe(true);
    expect(modelToolCommandsMatch('printf "a  b"', 'printf "a b"')).toBe(false);
  });

  test('maps only canonical action kinds and handles outline undo dynamically', () => {
    expect(new Set(MODEL_TOOL_ACTION_KINDS).size).toBe(MODEL_TOOL_ACTION_KINDS.length);
    expect(MODEL_TOOL_ACTION_KINDS.some((kind) => kind.includes('.issue.'))).toBe(false);
    expect(MODEL_TOOL_ACTION_KINDS.some((kind) => kind.includes('.session.'))).toBe(false);
    expect(modelToolActionKinds('outline_undo_stack', { action: 'list' })).toEqual(['outline.read']);
    expect(modelToolActionKinds('outline_undo_stack', { action: 'undo' })).toEqual(['outline.edit']);
    expect(modelToolActionKinds('collaboration.list_agents')).toEqual(['agent.subagent.read']);
    expect(modelToolActionKindFromRule('Action(agent.subagent.read)')).toBe('agent.subagent.read');
    expect(modelToolActionKindFromRule('Action(agent.session.read)')).toBeNull();
    expect(modelToolActionKindFromRule('agent.subagent.read')).toBeNull();
  });
});
