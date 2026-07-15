import type {
  AgentIssue,
  IssueDueDate,
  IssueInputScope,
  IssueOutputPolicy,
  IssueRecurrenceContext,
  IssueTrigger,
  ResolvedIssueInput,
  ValidationMessage,
} from '../core/agentIssue';
import {
  DAILY_NOTES_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
  type DocumentProjection,
  type NodeProjection,
} from '../core/types';
import { isInternalConfigNode } from '../core/configSchema';
import {
  indexProjection,
  isInTrash,
  isSystemNodeId,
} from './agentNodeToolProjection';
import { resolveIssueInputScopeFromProjection } from './agentIssueInputResolver';
import {
  formatRecurringIssueWindowDate,
  normalizeRecurringIssueTimeZone,
} from './agentIssueSchedule';

export interface IssueNodeDefinition {
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  noteNodeIds?: string[];
  dueDate?: IssueDueDate;
  recurrence?: IssueRecurrenceContext;
  trigger?: IssueTrigger;
}

export interface IssueDailyNoteDate {
  isoDate: string;
  year: number;
  month: number;
  day: number;
  timeZone: string;
  basis: 'session-date' | 'due-date';
}

export interface PreparedIssueExecution {
  issueRevision: string;
  mode: 'preview' | 'request';
  inputSnapshot?: ResolvedIssueInput;
  outputSnapshot?: IssueOutputPolicy;
  warnings: ValidationMessage[];
}

export type IssueExecutionPreparationResult =
  | { ok: true; prepared: PreparedIssueExecution }
  | { ok: false; validation: ValidationMessage[] };

export interface IssueExecutionPreparationOptions {
  mode: 'preview' | 'request';
  ensureDailyNote?: (date: IssueDailyNoteDate) => Promise<string>;
  getProjection?: () => DocumentProjection;
}

export function validateIssueNodeDefinition(
  definition: IssueNodeDefinition,
  projection: DocumentProjection,
  options: { materializedRecurring?: boolean } = {},
): ValidationMessage[] {
  const index = indexProjection(projection);
  const validation: ValidationMessage[] = [];
  const input = definition.input;
  if (input) {
    switch (input.type) {
      case 'none':
        break;
      case 'selected-nodes':
        input.nodeIds.forEach((nodeId, indexInScope) => {
          validation.push(...validateActiveNode(
            index.nodes.get(nodeId),
            nodeId,
            `input.nodeIds.${indexInScope}`,
            index,
            'input',
          ));
        });
        break;
      case 'node-children':
        validation.push(...validateActiveNode(
          index.nodes.get(input.nodeId),
          input.nodeId,
          'input.nodeId',
          index,
          'input root',
        ));
        break;
      case 'tag-query': {
        const tag = resolveActiveTagDefinition(input.tag, projection);
        if (tag.status === 'missing') {
          validation.push({
            path: 'input.tag',
            code: 'input_tag_not_found',
            message: `Issue input tag is missing or in Trash: ${input.tag}.`,
          });
        } else if (tag.status === 'ambiguous') {
          validation.push({
            path: 'input.tag',
            code: 'input_tag_ambiguous',
            message: `Issue input tag matches multiple active definitions; use an exact tag definition id: ${tag.nodeIds.join(', ')}.`,
          });
        }
        break;
      }
      case 'saved-query':
        validation.push({
          path: 'input',
          code: 'saved_query_not_supported',
          message: 'Saved-query Issue inputs are not executable until saved-query resolution is implemented.',
        });
        break;
    }
  }

  for (const [noteIndex, nodeId] of (definition.noteNodeIds ?? []).entries()) {
    validation.push(...validateActiveNode(
      index.nodes.get(nodeId),
      nodeId,
      `noteNodeIds.${noteIndex}`,
      index,
      'attached note',
    ));
  }

  const output = definition.output;
  if (output) {
    switch (output.type) {
      case 'activity-only':
        break;
      case 'daily-note':
        if (
          output.datePolicy === 'due-date'
          && !definition.dueDate
          && !definition.recurrence
          && options.materializedRecurring !== true
        ) {
          validation.push({
            path: 'output.datePolicy',
            code: 'daily_note_due_date_missing',
            message: 'Daily-note due-date output requires an Issue due date.',
          });
        }
        if (definition.dueDate && !isValidDateInstant(definition.dueDate.targetAt)) {
          validation.push({
            path: 'dueDate.targetAt',
            code: 'daily_note_date_invalid',
            message: 'Daily-note output requires a valid JavaScript Issue due date.',
          });
        }
        if (
          !definition.dueDate
          && definition.recurrence
          && !isValidDateInstant(definition.recurrence.windowStartAt)
        ) {
          validation.push({
            path: 'recurrence.windowStartAt',
            code: 'daily_note_date_invalid',
            message: 'Daily-note output requires a valid JavaScript recurrence window date.',
          });
        }
        if (
          definition.dueDate?.timeZone
          && !normalizeRecurringIssueTimeZone(definition.dueDate.timeZone)
        ) {
          validation.push({
            path: 'dueDate.timeZone',
            code: 'daily_note_time_zone_invalid',
            message: 'Daily-note output requires a valid IANA due-date time zone.',
          });
        }
        if (
          definition.recurrence?.timeZone
          && !normalizeRecurringIssueTimeZone(definition.recurrence.timeZone)
        ) {
          validation.push({
            path: 'recurrence.timeZone',
            code: 'daily_note_time_zone_invalid',
            message: 'Daily-note output requires a valid IANA recurrence time zone.',
          });
        }
        if (
          output.datePolicy === 'session-date'
          && definition.trigger?.type === 'scheduled'
          && !normalizeRecurringIssueTimeZone(definition.trigger.timeZone)
        ) {
          validation.push({
            path: 'trigger.timeZone',
            code: 'daily_note_time_zone_invalid',
            message: 'Daily-note output requires a valid IANA schedule time zone.',
          });
        }
        break;
      case 'append-to-node':
      case 'create-child-under-node':
        validation.push(...validateOutputParent(output.nodeId, 'output.nodeId', projection));
        break;
      case 'per-input-child':
        validation.push(...validateOutputParent(output.parentNodeId, 'output.parentNodeId', projection));
        break;
      case 'replace-input':
        validation.push({
          path: 'output',
          code: 'replace_input_confirmation_unavailable',
          message: 'Replace-input output is not executable until a trusted per-Session confirmation channel is implemented.',
        });
        break;
    }
  }
  return validation;
}

export async function prepareIssueExecution(
  issue: AgentIssue,
  projection: DocumentProjection,
  now: number,
  options: IssueExecutionPreparationOptions,
): Promise<IssueExecutionPreparationResult> {
  const validation = validateIssueNodeDefinition(issue, projection);
  if (validation.length > 0) return { ok: false, validation };

  const inputSnapshot = issue.input
    ? resolveIssueInputScopeFromProjection(issue.input, issue, projection, now)
    : undefined;
  const warnings: ValidationMessage[] = [];
  if (
    issue.input?.type === 'tag-query'
    && (inputSnapshot?.nodeIds?.length ?? 0) === 0
  ) {
    warnings.push({
      path: 'input',
      code: 'input_query_empty',
      message: `Issue input tag currently matches no active nodes: ${issue.input.tag}.`,
    });
  }

  let outputSnapshot = issue.output;
  if (issue.output?.type === 'daily-note') {
    const date = resolveDailyNoteDate(issue, now);
    if (!date.ok) return { ok: false, validation: [date.validation] };
    const existingDayId = findCanonicalDayNodeId(projection, date.date);
    if (options.mode === 'preview') {
      outputSnapshot = existingDayId
        ? { type: 'create-child-under-node', nodeId: existingDayId }
        : issue.output;
    } else {
      if (!options.ensureDailyNote) {
        return {
          ok: false,
          validation: [{
            path: 'output',
            code: 'daily_note_resolver_unavailable',
            message: 'Daily-note output requires the document date-node resolver.',
          }],
        };
      }
      let dayNodeId: string;
      try {
        dayNodeId = await options.ensureDailyNote(date.date);
      } catch (error) {
        return {
          ok: false,
          validation: [{
            path: 'output',
            code: 'daily_note_resolution_failed',
            message: `Daily-note destination could not be created: ${errorMessage(error)}`,
          }],
        };
      }
      const latestProjection = options.getProjection?.() ?? projection;
      if (findCanonicalDayNodeId(latestProjection, date.date) !== dayNodeId) {
        return {
          ok: false,
          validation: [{
            path: 'output',
            code: 'daily_note_resolution_invalid',
            message: `Daily-note resolver returned a non-canonical date node: ${dayNodeId}.`,
          }],
        };
      }
      outputSnapshot = { type: 'create-child-under-node', nodeId: dayNodeId };
    }
  }

  return {
    ok: true,
    prepared: {
      issueRevision: issue.revision,
      mode: options.mode,
      ...(inputSnapshot ? { inputSnapshot } : {}),
      ...(outputSnapshot ? { outputSnapshot } : {}),
      warnings,
    },
  };
}

function resolveDailyNoteDate(
  issue: AgentIssue,
  now: number,
): { ok: true; date: IssueDailyNoteDate } | { ok: false; validation: ValidationMessage } {
  const output = issue.output;
  if (output?.type !== 'daily-note') {
    throw new Error('resolveDailyNoteDate requires daily-note output.');
  }
  const fallbackTimeZone = normalizeRecurringIssueTimeZone('Local') ?? 'UTC';
  const recurrenceTimeZone = issue.recurrence?.timeZone
    ? normalizeRecurringIssueTimeZone(issue.recurrence.timeZone) ?? fallbackTimeZone
    : fallbackTimeZone;
  const scheduledTimeZone = issue.trigger.type === 'scheduled'
    ? normalizeRecurringIssueTimeZone(issue.trigger.timeZone) ?? fallbackTimeZone
    : fallbackTimeZone;
  const dueTimeZone = issue.dueDate?.timeZone
    ? normalizeRecurringIssueTimeZone(issue.dueDate.timeZone) ?? scheduledTimeZone
    : issue.recurrence
      ? recurrenceTimeZone
      : scheduledTimeZone;
  const targetAt = output.datePolicy === 'due-date'
    ? issue.dueDate?.targetAt ?? issue.recurrence?.windowStartAt
    : now;
  if (targetAt === undefined || !isValidDateInstant(targetAt)) {
    return {
      ok: false,
      validation: {
        path: 'output.datePolicy',
        code: targetAt === undefined ? 'daily_note_due_date_missing' : 'daily_note_date_invalid',
        message: targetAt === undefined
          ? 'Daily-note due-date output requires an Issue due date.'
          : 'Daily-note output requires a valid JavaScript calendar date.',
      },
    };
  }
  const timeZone = output.datePolicy === 'due-date'
    ? dueTimeZone
    : issue.trigger.type === 'scheduled'
      ? scheduledTimeZone
      : issue.recurrence
        ? recurrenceTimeZone
        : fallbackTimeZone;
  let isoDate: string;
  try {
    isoDate = formatRecurringIssueWindowDate(targetAt, timeZone);
  } catch {
    return {
      ok: false,
      validation: {
        path: 'output.datePolicy',
        code: 'daily_note_date_invalid',
        message: 'Daily-note output requires a valid calendar date.',
      },
    };
  }
  const [year, month, day] = isoDate.split('-').map(Number);
  return {
    ok: true,
    date: {
      isoDate,
      year: year!,
      month: month!,
      day: day!,
      timeZone,
      basis: output.datePolicy,
    },
  };
}

function validateActiveNode(
  node: NodeProjection | undefined,
  nodeId: string,
  path: string,
  index: ReturnType<typeof indexProjection>,
  label: string,
): ValidationMessage[] {
  if (!node) {
    return [{
      path,
      code: 'node_not_found',
      message: `Issue ${label} node was not found: ${nodeId}.`,
    }];
  }
  if (isInTrash(index, nodeId)) {
    return [{
      path,
      code: 'node_in_trash',
      message: `Issue ${label} node is in Trash: ${nodeId}.`,
    }];
  }
  return [];
}

function validateOutputParent(
  nodeId: string,
  path: string,
  projection: DocumentProjection,
): ValidationMessage[] {
  const index = indexProjection(projection);
  const node = index.nodes.get(nodeId);
  const activeValidation = validateActiveNode(node, nodeId, path, index, 'output parent');
  if (activeValidation.length > 0 || !node) return activeValidation;
  if (node.type === 'reference') {
    return [{
      path,
      code: 'reference_output_ambiguous',
      message: `Issue output cannot target a reference instance without explicitly choosing its target: ${nodeId}.`,
    }];
  }
  if (isSystemNodeId(nodeId) || isInternalConfigNode(node) || node.type !== undefined) {
    return [{
      path,
      code: 'invalid_output_parent',
      message: `Issue output parent cannot contain ordinary generated content: ${nodeId}.`,
    }];
  }
  return [];
}

function resolveActiveTagDefinition(
  rawTag: string,
  projection: DocumentProjection,
):
  | { status: 'resolved'; node: NodeProjection }
  | { status: 'missing' }
  | { status: 'ambiguous'; nodeIds: string[] } {
  const index = indexProjection(projection);
  const direct = index.nodes.get(rawTag);
  if (direct?.type === 'tagDef' && !isInTrash(index, direct.id)) {
    return { status: 'resolved', node: direct };
  }
  const normalized = normalizeTag(rawTag);
  const matches = projection.nodes.filter((node) => (
    node.type === 'tagDef'
    && !isInTrash(index, node.id)
    && normalizeTag(node.content.text) === normalized
  ));
  if (matches.length === 0) return { status: 'missing' };
  if (matches.length > 1) {
    return { status: 'ambiguous', nodeIds: matches.map((node) => node.id) };
  }
  return { status: 'resolved', node: matches[0]! };
}

function findCanonicalDayNodeId(
  projection: DocumentProjection,
  date: IssueDailyNoteDate,
): string | undefined {
  const index = indexProjection(projection);
  const yearNode = childWithNameAndTag(
    index,
    DAILY_NOTES_ID,
    String(date.year),
    TAG_YEAR_ID,
  );
  const weekNode = yearNode && childWithNameAndTag(
    index,
    yearNode.id,
    `W${String(isoWeekNumber(date.year, date.month, date.day)).padStart(2, '0')}`,
    TAG_WEEK_ID,
  );
  return weekNode
    ? childWithNameAndTag(index, weekNode.id, date.isoDate, TAG_DAY_ID)?.id
    : undefined;
}

function childWithNameAndTag(
  index: ReturnType<typeof indexProjection>,
  parentId: string,
  name: string,
  tagId: string,
): NodeProjection | undefined {
  return (index.nodes.get(parentId)?.children ?? [])
    .map((nodeId) => index.nodes.get(nodeId))
    .find((node) => (
      node?.content.text === name
      && node.tags.includes(tagId)
      && !isInTrash(index, node.id)
    ));
}

function isoWeekNumber(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/u, '').toLocaleLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidDateInstant(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}
