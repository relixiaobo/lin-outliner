import { describe, expect, test } from 'bun:test';
import {
  formatProviderName,
  providerInitial,
} from '../../src/renderer/ui/agent/providerNames';

describe('provider names', () => {
  test('presents the pi-ai 0.84 providers with stable product names', () => {
    expect(formatProviderName('baseten')).toBe('Baseten');
    expect(formatProviderName('qwen-token-plan-individual')).toBe('Qwen Token Plan Individual');
    expect(providerInitial('qwen-token-plan-individual')).toBe('Q');
  });
});
