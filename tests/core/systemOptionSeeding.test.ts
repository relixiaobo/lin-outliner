import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import {
  SCHEMA_ID,
  SCHEMA_FIELD_TYPES_ID,
  systemOptionNodeId,
} from '../../src/core/types';
import { allSystemOptionNodeIds, ENUM_DOMAINS } from '../../src/core/configSchema';
import { isInternalConfigNode } from '../../src/core/configSchema';

describe('system option seeding (Stage 4)', () => {
  test('bootstrap seeds every enum domain container + option with stable ids', () => {
    const core = Core.new();
    const byId = new Map(core.projection().nodes.map((node) => [node.id, node]));

    // Each domain container lives under SCHEMA and is a systemOption node.
    for (const domain of Object.values(ENUM_DOMAINS)) {
      const container = byId.get(domain.subtreeId);
      expect(container?.type).toBe('systemOption');
      expect(container?.parentId).toBe(SCHEMA_ID);

      // Options sit under their container in registry order, with derived ids.
      domain.values.forEach((value, index) => {
        const optionId = systemOptionNodeId(domain.subtreeId, value);
        const option = byId.get(optionId);
        expect(option?.type).toBe('systemOption');
        expect(option?.parentId).toBe(domain.subtreeId);
        expect(option?.content.text).toBe(value);
        expect(container?.children[index]).toBe(optionId);
      });
    }

    // A representative stable id resolves (guards against accidental renames).
    const numberOption = byId.get(systemOptionNodeId(SCHEMA_FIELD_TYPES_ID, 'number'));
    expect(numberOption?.content.text).toBe('number');

    // Every registry option id is present exactly once.
    for (const id of allSystemOptionNodeIds()) {
      expect(byId.has(id)).toBe(true);
    }
  });

  test('seeded option nodes are internal (excluded from consumers)', () => {
    const core = Core.new();
    const byId = new Map(core.projection().nodes.map((node) => [node.id, node]));
    for (const id of allSystemOptionNodeIds()) {
      expect(isInternalConfigNode(byId.get(id)!)).toBe(true);
    }
  });

  test('re-bootstrap on reload is idempotent (no duplicate options)', () => {
    const first = Core.new();
    const raw = first.serializeState();
    const reloaded = Core.fromState(Core.deserializeState(raw));

    const ids = reloaded.projection().nodes.map((node) => node.id);
    for (const optionId of allSystemOptionNodeIds()) {
      expect(ids.filter((id) => id === optionId).length).toBe(1);
    }
  });
});
