import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { OutlinerToolHost } from './agentNodeTools';
import { LocalToolFailure, type AgentLocalWorkspaceContext } from './agentLocalTools';
import { agentToolResult, errorEnvelope, successEnvelope, type ToolEnvelope } from './agentToolEnvelope';
import { elapsed, errorMessage, jsonByteLength } from './agentNodeToolUtils';
import {
  AgentImportService,
  ImportServiceFailure,
  visibleImportServiceResult,
  type ImportServiceResult,
} from './agentImportService';

interface DataImportInput {
  pack_file?: string;
  mode?: 'stage';
  parent_id?: string;
  dry_run?: boolean;
  confirmed_preview_id?: string;
}

interface DataImportToolOptions {
  workspace?: AgentLocalWorkspaceContext;
  localFileRoot?: string;
}

const DATA_IMPORT_TOOL = 'data_import';

export const DATA_IMPORT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['pack_file'],
  properties: {
    pack_file: {
      type: 'string',
      minLength: 1,
      description: 'Path to an Import Pack v1 JSON file produced by a data-cleanup adapter.',
    },
    mode: {
      type: 'string',
      enum: ['stage'],
      description: 'Import mode. v1 supports only stage, which creates one explicit staging root.',
    },
    parent_id: {
      type: 'string',
      minLength: 1,
      description: "Destination parent node id. Omit to stage under today's journal node.",
    },
    dry_run: {
      type: 'boolean',
      description: 'Validate and preview only; do not mutate the document.',
    },
    confirmed_preview_id: {
      type: 'string',
      minLength: 1,
      description: 'Preview id returned by a matching dry-run after the user approves the preview.',
    },
  },
} as const;

export function createDataImportTool(host: OutlinerToolHost, options: DataImportToolOptions = {}): AgentTool<any, ToolEnvelope<ImportServiceResult>> {
  const service = new AgentImportService(host, {
    localFileRoot: options.localFileRoot,
    workspace: options.workspace,
    toolName: DATA_IMPORT_TOOL,
  });

  return {
    name: DATA_IMPORT_TOOL,
    label: 'Data Import',
    description: [
      'Internal compatibility adapter for Import Pack v1 commits.',
      'The model-visible import path is tenon-import CLI/API; ordinary runs should not receive this tool.',
    ].join(' '),
    parameters: DATA_IMPORT_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeDataImportInput(rawParams);
      if ('error' in params) {
        return agentToolResult(errorEnvelope<ImportServiceResult>(DATA_IMPORT_TOOL, 'invalid_args', params.error, {
          instructions: 'Use tenon-import preview and tenon-import commit for the public workflow.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      try {
        const data = params.dry_run
          ? await service.previewFromFile({
            packFile: params.pack_file,
            mode: params.mode,
            ...(params.parent_id ? { parentId: params.parent_id } : {}),
          })
          : await service.commitFromFile({
            packFile: params.pack_file,
            mode: params.mode,
            ...(params.parent_id ? { parentId: params.parent_id } : {}),
            ...(params.confirmed_preview_id ? { previewId: params.confirmed_preview_id } : {}),
          });
        return agentToolResult(successEnvelope(DATA_IMPORT_TOOL, data, {
          status: params.dry_run ? 'unchanged' : 'success',
          warnings: data.warnings.map((warning) => `${warning.code}: ${warning.message}`),
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }), visibleImportServiceResult(data));
      } catch (error) {
        const failure = normalizeImportError(error);
        return agentToolResult(errorEnvelope<ImportServiceResult>(DATA_IMPORT_TOOL, failure.code, failure.message, {
          data: failure.data,
          instructions: failure.instructions,
          warnings: failure.warnings ? [...failure.warnings] : undefined,
          metrics: { durationMs: elapsed(started), outputBytes: failure.data ? jsonByteLength(failure.data) : undefined },
        }), failure.data ? visibleImportServiceResult(failure.data) : undefined);
      }
    },
  };
}

function normalizeDataImportInput(rawParams: unknown): Required<Pick<DataImportInput, 'pack_file' | 'mode' | 'dry_run'>> & Pick<DataImportInput, 'parent_id' | 'confirmed_preview_id'> | { error: string } {
  const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? rawParams as DataImportInput : {};
  const packFile = typeof params.pack_file === 'string' ? params.pack_file.trim() : '';
  if (!packFile) return { error: 'pack_file is required.' };
  const mode = params.mode ?? 'stage';
  if (mode !== 'stage') return { error: 'mode must be "stage".' };
  const parentId = typeof params.parent_id === 'string' && params.parent_id.trim() ? params.parent_id.trim() : undefined;
  const confirmedPreviewId = typeof params.confirmed_preview_id === 'string' && params.confirmed_preview_id.trim()
    ? params.confirmed_preview_id.trim()
    : undefined;
  return {
    pack_file: packFile,
    mode,
    dry_run: params.dry_run === true,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(confirmedPreviewId ? { confirmed_preview_id: confirmedPreviewId } : {}),
  };
}

function normalizeImportError(error: unknown): {
  code: string;
  message: string;
  instructions?: string;
  data?: ImportServiceResult;
  warnings?: readonly string[];
} {
  if (error instanceof ImportServiceFailure) {
    return {
      code: error.code,
      message: error.message,
      instructions: error.instructions,
      data: error.data,
      warnings: error.warnings,
    };
  }
  if (error instanceof LocalToolFailure) {
    return {
      code: error.code,
      message: error.message,
      instructions: error.instructions,
    };
  }
  return {
    code: 'import_failed',
    message: errorMessage(error),
    instructions: 'Inspect the Import Pack and rerun tenon-import preview before retrying.',
  };
}
