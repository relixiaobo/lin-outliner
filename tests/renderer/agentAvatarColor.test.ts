import { describe, expect, test } from 'bun:test';
import {
  MAIN_AVATAR_IDENTITY,
  agentAvatarColor,
  agentAvatarInitial,
} from '../../src/renderer/agent/agentAvatarColor';

describe('participant avatar identity colour', () => {
  test('is stable for one type and drawn from the shared identity palette', () => {
    const first = agentAvatarColor('general-purpose');
    expect(agentAvatarColor('general-purpose')).toEqual(first);
    // Tokens, not literals: the hue follows the theme's palette rather than a
    // baked colour, and the disc mixes it toward the live content surface so it
    // is a soft wash in both themes instead of a glaring puck on dark.
    expect(first.text).toMatch(/^var\(--identity-tint-[1-7]\)$/u);
    expect(first.background).toBe(`color-mix(in srgb, ${first.text} 14%, var(--bg-content))`);
  });

  test('never assigns the danger-adjacent red', () => {
    // An Agent whose avatar reads as an error every time it speaks is a worse
    // trade than one fewer hue, so tint 0 is out of the rotation entirely.
    const assigned = new Set(Array.from(
      { length: 500 },
      (_, index) => agentAvatarColor(`agent-type-${index}`).text,
    ));
    expect(assigned.has('var(--identity-tint-0)')).toBe(false);
    // The rotation is genuinely used rather than collapsing onto one hue.
    expect(assigned.size).toBe(7);
  });

  test('gives one type one avatar, however many Agents wear it', () => {
    // Two `general-purpose` siblings share one NAME in this stream, so giving
    // them different discs would say they were different kinds of participant.
    // What tells them apart is the task on each one's report.
    expect(agentAvatarColor('general-purpose')).toEqual(agentAvatarColor('general-purpose'));
    expect(agentAvatarColor('general-purpose')).not.toEqual(agentAvatarColor(MAIN_AVATAR_IDENTITY));
    // Derived, not enumerated: a project can name a type anything at all, and
    // it still gets a fixed avatar without this file knowing about it.
    const custom = agentAvatarColor('deployment-auditor');
    expect(custom).toEqual(agentAvatarColor('deployment-auditor'));
    expect(custom.text).toMatch(/^var\(--identity-tint-[1-7]\)$/u);
  });

  test('pins the conversation\'s own agent to a name, not to a Thread id', () => {
    // `main` is the one participant that is always there. A hue rehashed from
    // each new conversation's Thread id would make it a different participant
    // every time the reader opened a chat.
    expect(agentAvatarColor(MAIN_AVATAR_IDENTITY)).toEqual(agentAvatarColor('main'));
  });

  test('reads the initial by code point and folds case', () => {
    expect(agentAvatarInitial('research')).toBe('R');
    expect(agentAvatarInitial('  audit trail ')).toBe('A');
    expect(agentAvatarInitial('统计 spec Markdown')).toBe('统');
    // One astral code point, not half a surrogate pair.
    expect(agentAvatarInitial('🛠 build')).toBe('🛠');
    expect(agentAvatarInitial('   ')).toBe('?');
  });
});
