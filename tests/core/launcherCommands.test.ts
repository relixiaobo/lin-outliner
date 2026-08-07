import { describe, expect, test } from 'bun:test';
import { formatHotkey } from '../../src/core/launcher/commands';

// `formatHotkey` lives in core because two surfaces render the registered
// accelerator: the launcher footer's identity zone and Settings → General.

describe('formatHotkey', () => {
  test('renders an Electron accelerator as macOS key symbols', () => {
    expect(formatHotkey('CommandOrControl+Shift+Space')).toBe('⌘⇧Space');
    expect(formatHotkey('Option+Enter')).toBe('⌥↵');
  });
  test('passes unknown tokens through and handles null', () => {
    expect(formatHotkey('F5')).toBe('F5');
    expect(formatHotkey(null)).toBeNull();
  });
});
