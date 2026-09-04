import { describe, expect, test } from 'bun:test';
import {
  DELEGATE_MAX_MESSAGE_BYTES,
  canonicalDelegateArgv,
  canonicalDelegateCommand,
  decodeDelegateMessageInput,
  decodeDelegateRunInput,
  parseDelegateCommand,
  parsePrivilegedDelegateCommand,
} from '../../src/delegate/contract';

const TASK_ID = 'task_550e8400-e29b-41d4-a716-446655440000';
const SESSION_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abd';

describe('delegate command contract', () => {
  test('normalizes every state-changing command through one registry grammar', () => {
    const commands = [
      parseDelegateCommand(['run', '--input', '-']),
      parseDelegateCommand(['run', '--input', '-', '--output', 'json']),
      parseDelegateCommand(['send', '--task', TASK_ID, '--input', '-', '--output', 'json']),
      parseDelegateCommand(['send', '--session', SESSION_ID, '--input', '-']),
      parseDelegateCommand(['close', '--session', SESSION_ID]),
    ];

    expect(commands).toEqual([
      { name: 'run', input: '-', output: 'text' },
      { name: 'run', input: '-', output: 'json' },
      { name: 'send', target: { kind: 'task', id: TASK_ID }, input: '-', output: 'json' },
      { name: 'send', target: { kind: 'session', id: SESSION_ID }, input: '-', output: 'text' },
      { name: 'close', sessionId: SESSION_ID, output: 'text' },
    ]);
    for (const command of commands) {
      if (command.name !== 'run' && command.name !== 'send' && command.name !== 'close') continue;
      expect(parsePrivilegedDelegateCommand(canonicalDelegateCommand(command))).toEqual(command);
      expect(canonicalDelegateArgv(command)[0]).toBe(command.name);
    }
  });

  test('keeps diagnostics unprivileged and state-changing command parsing fail-closed', () => {
    expect(parseDelegateCommand(['doctor', 'internal', '--output', 'json'])).toEqual({
      name: 'doctor', runnerId: 'internal', output: 'json',
    });
    expect(parseDelegateCommand(['schema', 'run'])).toEqual({ name: 'schema', schema: 'run' });
    expect(parseDelegateCommand(['version'])).toEqual({ name: 'version' });
    expect(parsePrivilegedDelegateCommand('delegate doctor internal')).toBeNull();

    const hostile = [
      ' delegate run --input - --output json',
      'delegate  run --input - --output json',
      'delegate run --output json --input -',
      'delegate run --input "-" --output json',
      '/tmp/delegate run --input - --output json',
      'env X=1 delegate run --input - --output json',
      'delegate run --input - --output json; echo forged',
      'delegate run --input - --output json | tee result',
      'delegate run --input - --output json > result',
      'delegate run --input - --output json &',
      'delegate send --task task_not-an-id --input - --output json',
      `delegate send --session ${SESSION_ID} --output json --input -`,
      `delegate close --session ${SESSION_ID} --output yaml`,
    ];
    for (const command of hostile) expect(parsePrivilegedDelegateCommand(command)).toBeNull();
  });

  test('validates the task corpus without accepting policy or authority fields', () => {
    expect(decodeDelegateRunInput({
      version: 1,
      prompt: 'Inspect the recovery path and report concrete correctness risks.',
      profile: 'explore',
      access: 'read-only',
    })).toEqual({
      version: 1,
      prompt: 'Inspect the recovery path and report concrete correctness risks.',
      profile: 'explore',
      access: 'read-only',
    });
    expect(() => decodeDelegateRunInput({
      version: 1,
      prompt: 'Implement the change.',
      profile: 'plan',
      access: 'workspace-write',
    })).toThrow('plan delegation requires read-only access');
    expect(() => decodeDelegateRunInput({
      version: 1,
      prompt: 'Use a different model.',
      profile: 'general',
      access: 'read-only',
      model: 'override',
    })).toThrow('Invalid delegation run input');
    expect(() => decodeDelegateRunInput({
      version: 1,
      prompt: 'Use a different Runner.',
      profile: 'general',
      access: 'read-only',
      runner: 'external',
    })).toThrow('Invalid delegation run input');
  });

  test('bounds root messages by UTF-8 bytes rather than JavaScript length', () => {
    expect(decodeDelegateMessageInput({ version: 1, message: 'Inspect the newly reported race.' }))
      .toEqual({ version: 1, message: 'Inspect the newly reported race.' });
    const oversized = '\u754c'.repeat(Math.floor(DELEGATE_MAX_MESSAGE_BYTES / 3) + 1);
    expect(() => decodeDelegateMessageInput({ version: 1, message: oversized }))
      .toThrow('message exceeds');
  });
});
