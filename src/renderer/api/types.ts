export type {
  AssetMetadata,
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentProviderCapabilityModelOption,
  AgentModelOption,
  AgentProviderOption,
  AgentReasoningLevel,
  AgentRuntimeSettings,
  AgentRuntimeSettingsInput,
  AgentImageGenerationSettings,
  AgentImageGenerationSettingsInput,
  AgentSlashCommandView,
  AgentProviderSecretStatus,
  AgentProviderStoredApiKey,
  AgentProviderSettingsView,
  AgentProviderAuthKind,
  ProviderAuthView,
  OAuthLoginEvent,
  OAuthLoginEventEnvelope,
  AgentDefinition,
  SkillDefinition,
  ManagedSkillCatalogView,
  ManagedSkillDiscoveryCandidateView,
  ManagedSkillDiscoveryView,
  ManagedSkillUpdatePreviewView,
  ManagedSkillView,
  AgentConversation,
  AgentCreateConversationOptions,
  AgentConversationListMeta,
  Backlink,
  BatchMoveNodeInput,
  CommandResult,
  CreateNodeTree,
  DocumentProjection,
  DocumentProjectionChangedEvent,
  ProjectionUpdate,
  ProjectionSnapshot,
  AutoInitStrategy,
  FieldConfigPatch,
  FieldType,
  FilterOperator,
  FilterValueLogic,
  FocusPlacement,
  FocusHint,
  FocusSurface,
  HideFieldMode,
  IconKind,
  InlineRef,
  InlineRefCursorBias,
  NodeId,
  NodeProjection,
  NodeType,
  ParsedPasteField,
  PasteRowMeta,
  QueryLogic,
  QueryOp,
  ReferenceTarget,
  RichText,
  RichTextPatch,
  RichTextPatchOp,
  SearchHit,
  SplitNodeOptions,
  SortDirection,
  TagConfigPatch,
  TextMark,
  TextMarkKind,
  ViewFieldRef,
  ViewMode,
} from '../../core/types';

export type {
  AgentCapabilityRequestView,
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentRunDetailPayload,
  AgentRunListEntry,
  AgentRunTranscriptPayload,
  AgentStorageLocation,
} from '../../core/agentTypes';

export type {
  Activity,
  AgentIssue,
  AgentRecurringIssue,
  AgentSession,
  AgentSessionReadInput,
  AgentSessionReadResult,
  AgentSessionTranscriptResult,
  IssueReadInput,
  IssueReadResult,
  IssueSearchInput,
  IssueSearchResult,
  IssueSearchRow,
  IssueTargetRef,
  TenonAgentToolResult,
} from '../../core/agentIssue';

export type {
  AgentDreamReadiness,
  AgentRenderDreamRunEntity,
} from '../../core/agentRenderProjection';

export interface AgentCapabilitySettingsView {
  folders: string[];
  blocks: string[];
  diagnostics: Array<{
    ruleValue: string;
    code: string;
    message: string;
  }>;
}

export interface AgentCapabilitySettingsPatchInput {
  revokeFolders: string[];
  removeBlocks: string[];
}

export interface AgentPickCapabilityFolderResult {
  canceled: boolean;
  path?: string;
  folder?: string;
  settings: AgentCapabilitySettingsView;
}

export { EMPTY_RICH_TEXT, plainText, replaceAllRichTextPatch } from '../../core/types';
export {
  inlineRefNodeId,
  nodeReferenceTarget,
  referenceTargetsEqual,
} from '../../core/types';
export {
  dateFieldEndpointDate,
  dateFieldEndpointHasTime,
  dateFieldEndpointTime,
  formatDateFieldEndpoint,
  formatDateFieldInput,
  formatDateFieldValue,
  normalizeDateFieldValue,
  normalizedDateFieldEndpoint,
  orderDateFieldEndpoints,
  parseDateFieldValue,
  parseDateFieldValueRange,
  type DateFieldValue,
  type DateFieldValueRange,
} from '../../core/dateFieldValue';
export {
  addLocalDays,
  isoLocalDate,
  offsetIsoLocalDate,
  parseIsoLocalDate,
  todayIsoLocalDate,
} from '../../core/localDate';
