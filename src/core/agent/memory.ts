import type { ThreadId, ThreadItemId, TurnId } from './protocol';
import {
  MEMORY_TAG_DEFINITIONS,
  type MemoryCategory,
} from '../memoryDefinitions';

export {
  MEMORY_DOCUMENT_NAMESPACE,
  MEMORY_TAG_DEFINITIONS,
  memoryTagDefinitionForId,
  type MemoryCategory,
} from '../memoryDefinitions';

export const MEMORY_EXTENSION_ID = 'memory' as const;
export type MemoryFeatureMode = 'enabled' | 'disabled';
export type ThreadMemoryMode = 'enabled' | 'disabled';

export interface MemoryAdmissionSnapshot {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly featureModeAtAdmission: MemoryFeatureMode;
  readonly threadModeAtAdmission: ThreadMemoryMode;
  readonly eligibleAtAdmission: boolean;
  readonly featureModeGeneration: number;
  readonly resetEpoch: number;
  readonly memoryVisibilityGeneration: number;
  readonly admittedAt: number;
}

export interface MemoryStatus {
  readonly featureMode: MemoryFeatureMode;
  readonly featureModeGeneration: number;
  readonly resetEpoch: number;
  readonly memoryVisibilityGeneration: number;
  readonly lastSuccessfulRunAt: number | null;
  readonly lastError: string | null;
  readonly pendingJobs: number;
  readonly strayTaggedNodeCount: number;
}

export interface ThreadMemoryStatus {
  readonly threadId: ThreadId;
  readonly mode: ThreadMemoryMode;
}

export interface MemorySettingsView {
  readonly status: MemoryStatus;
  readonly thread: ThreadMemoryStatus | null;
}

export interface MemoryStage1EvidenceItem {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
  readonly originItemId: ThreadItemId;
  readonly sourceDate: string;
  readonly kind: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface MemoryStage1Statement {
  readonly text: string;
  readonly originItemIds: readonly ThreadItemId[];
}

export interface MemoryStage1CategoryOutput {
  readonly beliefs: readonly MemoryStage1Statement[];
  readonly questions: readonly MemoryStage1Statement[];
  readonly guidance: readonly MemoryStage1Statement[];
}

export interface MemoryStage1DateOutput extends MemoryStage1CategoryOutput {
  readonly sourceDate: string;
  readonly headline: MemoryStage1Statement;
  readonly episode: MemoryStage1Statement;
}

export interface MemoryStage1Output {
  readonly dates: readonly MemoryStage1DateOutput[];
}

export interface MemoryConsolidationNode {
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly category: MemoryCategory;
  readonly sourceDate: string;
  readonly text: string;
  readonly generated: boolean;
  readonly fingerprint: string;
  readonly supportingOriginItemIds: readonly ThreadItemId[];
}

export interface MemoryConsolidationKeepChange {
  readonly nodeId: string;
  readonly action: 'keep';
}

export interface MemoryConsolidationUpdateChange {
  readonly nodeId: string;
  readonly action: 'update';
  readonly text: string;
  readonly sourceNodeIds: readonly string[];
}

export interface MemoryConsolidationDeleteChange {
  readonly nodeId: string;
  readonly action: 'delete';
}

export interface MemoryConsolidationCreateChange {
  readonly temporaryId: string;
  readonly action: 'create';
  readonly parentId: string;
  readonly category: Exclude<MemoryCategory, 'memory'>;
  readonly text: string;
  readonly sourceNodeIds: readonly string[];
}

export type MemoryConsolidationChange =
  | MemoryConsolidationKeepChange
  | MemoryConsolidationUpdateChange
  | MemoryConsolidationDeleteChange
  | MemoryConsolidationCreateChange;

export interface MemoryConsolidationOutput {
  readonly changes: readonly MemoryConsolidationChange[];
}

export function memoryTagId(category: MemoryCategory): string {
  const definition = MEMORY_TAG_DEFINITIONS.find((entry) => entry.category === category);
  if (!definition) throw new Error(`Unknown Memory category: ${category}`);
  return definition.tagId;
}

export function memoryCategoryForTagId(tagId: string): MemoryCategory | null {
  return MEMORY_TAG_DEFINITIONS.find((entry) => entry.tagId === tagId)?.category ?? null;
}

export function decodeMemoryFeatureMode(value: unknown): MemoryFeatureMode {
  if (value === 'enabled' || value === 'disabled') return value;
  throw new Error('Memory feature mode must be enabled or disabled');
}

export function decodeThreadMemoryMode(value: unknown): ThreadMemoryMode {
  if (value === 'enabled' || value === 'disabled') return value;
  throw new Error('Thread Memory mode must be enabled or disabled');
}

export function decodeMemoryStage1Output(value: unknown): MemoryStage1Output {
  const record = exactRecord(value, ['dates'], 'Memory Stage 1 output');
  const dates = array(record.dates, 'Memory Stage 1 dates').map((entry, index) => {
    const item = exactRecord(
      entry,
      ['sourceDate', 'headline', 'episode', 'beliefs', 'questions', 'guidance'],
      `Memory Stage 1 dates[${index}]`,
    );
    const sourceDate = string(item.sourceDate, 'sourceDate');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) throw new Error(`Invalid Memory source date: ${sourceDate}`);
    return Object.freeze({
      sourceDate,
      headline: stage1Statement(item.headline, 'headline', 160),
      episode: stage1Statement(item.episode, 'episode', 2_000),
      beliefs: stage1StatementList(item.beliefs, 'beliefs', 12, 800),
      questions: stage1StatementList(item.questions, 'questions', 8, 800),
      guidance: stage1StatementList(item.guidance, 'guidance', 12, 800),
    });
  });
  if (dates.length > 14) throw new Error('Memory Stage 1 output exceeds the date limit');
  if (new Set(dates.map((entry) => entry.sourceDate)).size !== dates.length) {
    throw new Error('Memory Stage 1 output contains duplicate source dates');
  }
  return Object.freeze({ dates: Object.freeze(dates) });
}

function stage1Statement(value: unknown, field: string, charLimit: number): MemoryStage1Statement {
  const record = exactRecord(value, ['text', 'originItemIds'], `Memory Stage 1 ${field}`);
  const originItemIds = stringList(record.originItemIds, `${field}.originItemIds`, 64, 200);
  if (originItemIds.length === 0 || new Set(originItemIds).size !== originItemIds.length) {
    throw new Error(`${field}.originItemIds must contain distinct evidence IDs`);
  }
  return Object.freeze({
    text: boundedString(record.text, `${field}.text`, charLimit),
    originItemIds: originItemIds as readonly ThreadItemId[],
  });
}

function stage1StatementList(
  value: unknown,
  field: string,
  limit: number,
  charLimit: number,
): readonly MemoryStage1Statement[] {
  const values = array(value, field);
  if (values.length > limit) throw new Error(`${field} exceeds its item limit`);
  return Object.freeze(values.map((entry) => stage1Statement(entry, field, charLimit)));
}

export function decodeMemoryConsolidationOutput(value: unknown): MemoryConsolidationOutput {
  const record = exactRecord(value, ['changes'], 'Memory consolidation output');
  const changes = array(record.changes, 'Memory consolidation changes').map((entry, index) => {
    const item = recordValue(entry, `Memory consolidation changes[${index}]`);
    const action = item.action;
    if (action !== 'keep' && action !== 'update' && action !== 'delete' && action !== 'create') {
      throw new Error(`Invalid Memory consolidation action: ${String(action)}`);
    }
    if (action === 'create') {
      assertExactKeys(
        item,
        ['temporaryId', 'action', 'parentId', 'category', 'text', 'sourceNodeIds'],
        `Memory consolidation changes[${index}]`,
      );
      const temporaryId = string(item.temporaryId, 'temporaryId');
      if (!/^new:[A-Za-z0-9_-]{1,64}$/.test(temporaryId)) {
        throw new Error(`Invalid Memory consolidation temporary ID: ${temporaryId}`);
      }
      const category = item.category;
      if (category !== 'episode' && category !== 'belief' && category !== 'question' && category !== 'guidance') {
        throw new Error(`Invalid created Memory category: ${String(category)}`);
      }
      const sourceNodeIds = distinctSourceNodeIds(item.sourceNodeIds, 'Created Memory Node');
      return Object.freeze({
        temporaryId,
        action,
        parentId: string(item.parentId, 'parentId'),
        category,
        text: boundedString(item.text, 'text', 2_000),
        sourceNodeIds,
      });
    }
    const allowed = action === 'update'
      ? ['nodeId', 'action', 'text', 'sourceNodeIds']
      : ['nodeId', 'action'];
    assertExactKeys(item, allowed, `Memory consolidation changes[${index}]`);
    const nodeId = string(item.nodeId, 'nodeId');
    if (action === 'update') {
      const sourceNodeIds = distinctSourceNodeIds(item.sourceNodeIds, 'Updated Memory Node');
      return Object.freeze({
        nodeId,
        action,
        text: boundedString(item.text, 'text', 2_000),
        sourceNodeIds,
      });
    }
    return Object.freeze({ nodeId, action });
  });
  if (changes.length > 500) throw new Error('Memory consolidation output exceeds the change limit');
  const identities = changes.map((entry) => entry.action === 'create' ? entry.temporaryId : entry.nodeId);
  if (new Set(identities).size !== changes.length) {
    throw new Error('Memory consolidation output contains duplicate Node IDs');
  }
  return Object.freeze({ changes: Object.freeze(changes) });
}

function distinctSourceNodeIds(value: unknown, owner: string): readonly string[] {
  const sourceNodeIds = stringList(value, 'sourceNodeIds', 24, 200);
  if (sourceNodeIds.length === 0 || new Set(sourceNodeIds).size !== sourceNodeIds.length) {
    throw new Error(`${owner} must have distinct source Node IDs`);
  }
  return sourceNodeIds;
}

function stringList(value: unknown, field: string, limit: number, charLimit: number): readonly string[] {
  const values = array(value, field);
  if (values.length > limit) throw new Error(`${field} exceeds its item limit`);
  return Object.freeze(values.map((entry) => boundedString(entry, field, charLimit)));
}

function boundedString(value: unknown, field: string, limit: number): string {
  const result = string(value, field).trim();
  if (!result) throw new Error(`${field} must not be empty`);
  if (result.length > limit) throw new Error(`${field} exceeds ${limit} characters`);
  return result;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const record = recordValue(value, field);
  assertExactKeys(record, keys, field);
  return record;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${field} contains unknown field: ${unknown}`);
  const missing = keys.find((key) => !(key in record));
  if (missing) throw new Error(`${field} is missing field: ${missing}`);
}
