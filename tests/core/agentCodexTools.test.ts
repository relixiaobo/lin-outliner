import { describe, expect, test } from 'bun:test';
import {
  AGENT_MESSAGE_INPUT_SCHEMA,
  AGENT_MESSAGE_TOOL_DESCRIPTION,
  AGENT_TASK_TOOL_NAMES,
  AGENT_TOOL_DESCRIPTION,
  MODEL_TOOL_ACTION_KINDS,
  MODEL_TOOL_CATALOG,
  REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS,
  REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS,
  TASK_STOP_INPUT_SCHEMA,
  TASK_STOP_TOOL_DESCRIPTION,
  agentInputSchema,
  assembleModelToolRegistry,
  canonicalModelToolKey,
  decodeProviderToolName,
  encodeProviderToolName,
  modelToolActionKinds,
  modelToolActionKindFromRule,
  modelToolContract,
  modelToolCommandsMatch,
  normalizeAgentMessageToolInput,
  normalizeAgentToolInput,
  normalizeModelToolCommandForBlockMatch,
  normalizeRequestUserInputToolInput,
  normalizeTaskStopToolInput,
  normalizeUpdatePlanToolInput,
} from '../../src/core/agent/tools';

describe('Codex Agent Core model-tool contract', () => {
  test('uses one collision-free canonical registry with exactly three Agent task tools', () => {
    const keys = MODEL_TOOL_CATALOG.map((tool) => canonicalModelToolKey(tool.identity));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => AGENT_TASK_TOOL_NAMES.includes(key as typeof AGENT_TASK_TOOL_NAMES[number])))
      .toEqual(AGENT_TASK_TOOL_NAMES);
    expect(keys).not.toContain('bash_stop');
    for (const retired of [
      'collaboration.spawn_agent',
      'collaboration.send_message',
      'collaboration.followup_task',
      'collaboration.wait_agent',
      'collaboration.list_agents',
      'collaboration.interrupt_agent',
    ]) expect(keys).not.toContain(retired);
    expect(keys).toContain('request_user_input');
    expect(keys).toContain('update_plan');
    expect(keys).toContain('get_goal');
    expect(keys).toContain('create_goal');
    expect(keys).toContain('update_goal');
    expect(keys).toContain('skill');
    expect(modelToolContract('codex_app.automation_update')?.description).toContain(
      'This tool manages definitions only',
    );
    expect(modelToolContract('codex_app.automation_update')?.description).toContain(
      'Never use shell sleep or polling',
    );
    expect(modelToolContract('agent')?.description).toBe(AGENT_TOOL_DESCRIPTION);
    expect(modelToolContract('agent_message')?.description).toBe(AGENT_MESSAGE_TOOL_DESCRIPTION);
    expect(modelToolContract('task_stop')?.description).toBe(TASK_STOP_TOOL_DESCRIPTION);
  });

  test('round-trips canonical and flat provider encodings without aliases', () => {
    for (const name of AGENT_TASK_TOOL_NAMES) {
      const identity = { namespace: null, name } as const;
      expect(encodeProviderToolName(identity, 'canonical')).toBe(name);
      expect(encodeProviderToolName(identity, 'flat')).toBe(name);
      expect(decodeProviderToolName(name, 'flat')).toEqual(identity);
    }
    for (const retired of [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'list_agents',
      'interrupt_agent',
      'collaboration__spawn_agent',
      'collaboration__send_message',
      'collaboration__followup_task',
      'collaboration__wait_agent',
      'collaboration__list_agents',
      'collaboration__interrupt_agent',
      'bash_stop',
    ]) expect(decodeProviderToolName(retired, 'flat')).toBeNull();
  });

  test('freezes the exact Agent task schemas and property ordering', () => {
    const agent = agentInputSchema(['model-b', 'model-a', 'model-b']);
    expect(Object.keys(agent)).toEqual(['$schema', 'type', 'properties', 'required', 'additionalProperties']);
    expect(Object.keys(agent.properties as object)).toEqual([
      'description',
      'prompt',
      'subagent_type',
      'model',
      'run_in_background',
      'isolation',
    ]);
    expect(agent).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      required: ['description', 'prompt'],
      additionalProperties: false,
      properties: { model: { enum: ['model-b', 'model-a'] } },
    });
    expect(agentInputSchema([]).properties).not.toHaveProperty('model');
    expect(() => agentInputSchema([''])).toThrow('only non-empty');
    expect(Object.keys(AGENT_MESSAGE_INPUT_SCHEMA.properties as object)).toEqual(['to', 'summary', 'message']);
    expect(AGENT_MESSAGE_INPUT_SCHEMA).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      required: ['to', 'message'],
      properties: {
        to: { pattern: '^[^\\n\\r]{0,200}$' },
        summary: { maxLength: 200 },
      },
    });
    expect(Object.keys(TASK_STOP_INPUT_SCHEMA.properties as object)).toEqual(['task_id', 'shell_id']);
    expect(TASK_STOP_INPUT_SCHEMA).not.toHaveProperty('required');
  });

  test('normalizes Agent task defaults and message previews before exact admission', () => {
    expect(normalizeAgentToolInput({ description: 'Inspect code', prompt: 'Review the implementation.' }))
      .toEqual({
        description: 'Inspect code',
        prompt: 'Review the implementation.',
        subagent_type: 'general-purpose',
        run_in_background: true,
      });
    expect(normalizeAgentToolInput({
      description: 'Inspect code',
      prompt: 'Review it.',
      subagent_type: 'explore',
      run_in_background: false,
    })).toMatchObject({ subagent_type: 'explore', run_in_background: false });

    expect(normalizeAgentMessageToolInput({ to: ' agent-1 ', message: '  First line\nSecond line  ' }))
      .toEqual({ to: ' agent-1 ', message: '  First line\nSecond line  ', summary: 'First line' });
    expect(normalizeAgentMessageToolInput({ to: 'agent-1', summary: '  ', message: 'One line' }).summary)
      .toBe('One line');
    expect(normalizeAgentMessageToolInput({
      to: 'agent-1',
      summary: 'x'.repeat(201),
      message: 'Body',
    }).summary).toBe(`${'x'.repeat(199)}…`);
    expect(() => normalizeAgentMessageToolInput({ to: '   ', message: 'Body' }))
      .toThrow('<tool_use_error>to must not be empty</tool_use_error>');
    expect(() => normalizeAgentMessageToolInput({ to: 'agent-1', message: 'Body', extra: true }))
      .toThrow('unknown fields');

    expect(normalizeTaskStopToolInput({ shell_id: 'shell-1' })).toEqual({ shell_id: 'shell-1' });
    expect(normalizeTaskStopToolInput({ task_id: 'agent-1', shell_id: 'shell-1' }))
      .toEqual({ task_id: 'agent-1', shell_id: 'shell-1' });
    expect(() => normalizeTaskStopToolInput({})).toThrow('Missing required parameter: task_id');
  });

  test('requires retained schemas and accepts namespaced extension tools', () => {
    expect(() => assembleModelToolRegistry([])).toThrow('Missing model-tool schemas');
    const contributions = MODEL_TOOL_CATALOG
      .filter((contract) => contract.inputSchema === null)
      .map((contract) => ({
        identity: contract.identity,
        owner: contract.schemaOwner as 'capability' | 'configuration',
        inputSchema: { type: 'object', additionalProperties: false },
      }));
    const extensionTool = {
      identity: { namespace: 'project_ext', name: 'knowledge_lookup' },
      description: 'Look up project knowledge.',
      scope: 'rootThread',
      schemaOwner: 'extension',
      inputSchema: { type: 'object', additionalProperties: false },
      actionKinds: ['agent.plan.update'],
    } as const;
    const registry = assembleModelToolRegistry(contributions, [extensionTool]);
    expect(registry.every((contract) => contract.inputSchema !== null)).toBe(true);
    expect(encodeProviderToolName(extensionTool.identity, 'flat', registry)).toBe('project_ext__knowledge_lookup');
    expect(decodeProviderToolName('project_ext__knowledge_lookup', 'flat', registry)).toEqual(extensionTool.identity);
    expect(() => assembleModelToolRegistry(contributions, [{
      ...extensionTool,
      schemaOwner: 'core',
    }])).toThrow('must be owned by extension');
    expect(() => assembleModelToolRegistry(contributions, [{
      ...extensionTool,
      identity: { namespace: 'foo__bar', name: 'baz' },
    }])).toThrow('reserved flat-provider separator');
    expect(() => assembleModelToolRegistry(contributions, [{
      ...extensionTool,
      identity: { namespace: 'foo', name: 'bar__baz' },
    }])).toThrow('reserved flat-provider separator');
  });

  test('keeps request_user_input root-only and normalizes its bounded contract', () => {
    expect(modelToolContract('request_user_input')?.scope).toBe('rootThread');
    expect(JSON.stringify(modelToolContract('request_user_input')?.inputSchema))
      .toContain('Put the recommended option first and suffix its label with \\"(Recommended)\\"');
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
    expect(normalizeRequestUserInputToolInput({
      questions: [{
        id: 'delivery_mode',
        header: 'Delivery',
        question: 'How?',
        options: [
          { label: 'Direct', description: 'A' },
          { label: 'Pause', description: 'B' },
        ],
      }],
    }).questions[0]?.options[0]?.label).toBe('Direct');
    expect(normalizeRequestUserInputToolInput({
      questions: [{
        id: 'automation_type',
        header: '\u81ea\u52a8\u5316\u7c7b\u578b',
        question: '\u4f60\u60f3\u6d4b\u8bd5\u54ea\u4e00\u79cd\u81ea\u52a8\u5316\u4efb\u52a1\uff1f',
        options: [
          {
            label: '\u5b9a\u65f6\u63d0\u9192\uff08\u63a8\u8350\uff09',
            description: '\u5728\u6307\u5b9a\u65f6\u95f4\u89e6\u53d1\u4e00\u6761\u63d0\u9192\u3002',
          },
          {
            label: '\u5468\u671f\u4efb\u52a1',
            description: '\u6309\u56fa\u5b9a\u65f6\u95f4\u91cd\u590d\u6267\u884c\u3002',
          },
        ],
      }],
    }).questions[0]?.options[0]?.label).toBe('\u5b9a\u65f6\u63d0\u9192\uff08\u63a8\u8350\uff09');
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
    expect(modelToolActionKinds('agent')).toEqual(['agent.subagent.spawn']);
    expect(modelToolActionKinds('agent_message')).toEqual(['agent.subagent.send']);
    expect(modelToolActionKinds('task_stop')).toEqual(['agent.subagent.interrupt', 'shell.stop']);
    expect(modelToolActionKindFromRule('Action(agent.subagent.read)')).toBeNull();
    expect(modelToolActionKindFromRule('Action(agent.session.read)')).toBeNull();
    expect(modelToolActionKindFromRule('agent.subagent.read')).toBeNull();
  });
});
