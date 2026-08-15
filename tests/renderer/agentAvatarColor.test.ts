import { describe, expect, test } from 'bun:test';
import {
  MAIN_AVATAR_IDENTITY,
  agentAvatarColor,
  agentAvatarInitial,
} from '../../src/renderer/agent/agentAvatarColor';

describe('participant avatar identity colour', () => {
  test('is stable for one identity and drawn from the shared identity palette', () => {
    const first = agentAvatarColor('01910000-0000-7000-8000-0000000000a1');
    expect(agentAvatarColor('01910000-0000-7000-8000-0000000000a1')).toEqual(first);
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
      (_, index) => agentAvatarColor(`01910000-0000-7000-8000-${String(index).padStart(12, '0')}`).text,
    ));
    expect(assigned.has('var(--identity-tint-0)')).toBe(false);
    // The rotation is genuinely used rather than collapsing onto one hue.
    expect(assigned.size).toBe(7);
  });

  test('keys on identity rather than name, so same-named siblings can differ', () => {
    // The case the colour exists for: one task description, several children,
    // hence one shared initial. Keying on the id is what lets them differ at
    // all — though two ids may still land on one hue, which is why the NAME
    // beside the disc stays the identity of record and the disc is never the
    // only thing distinguishing two participants.
    const siblings = ['b1', 'b2', 'b3', 'b4'].map(
      (suffix) => agentAvatarColor(`01910000-0000-7000-8000-00000000000${suffix}`).text,
    );
    expect(new Set(siblings).size).toBeGreaterThan(1);
    expect(new Set(['count spec Markdown', 'count spec Markdown'].map(agentAvatarInitial)).size).toBe(1);
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
