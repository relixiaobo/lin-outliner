import type {
  AgentEditorView,
  AgentProfileDraft,
  AgentRoleDraft,
  AssetMetadata,
  Backlink,
  AgentProviderConfigInput,
  AgentProviderSecretStatus,
  AgentProviderStoredApiKey,
  AgentProviderSettingsView,
  AgentImageGenerationSettingsInput,
  AgentRuntimeSettingsInput,
  AgentCapabilitySettingsPatchInput,
  AgentCapabilitySettingsView,
  SkillDefinition,
  ManagedSkillCatalogView,
  ManagedSkillCommandResult,
  ManagedSkillDiscoveryView,
  ManagedSkillErrorView,
  ManagedSkillUpdatePreviewView,
  ManagedSkillView,
  CommandResult,
  CreateNodeTree,
  BatchMoveNodeInput,
  PasteRowMeta,
  DocumentProjection,
  ProjectionSnapshot,
  FieldConfigPatch,
  FieldSlotMutation,
  FieldType,
  FilterOperator,
  FilterValueLogic,
  IconKind,
  RichText,
  RichTextPatch,
  SearchHit,
  SplitNodeOptions,
  SortDirection,
  TagConfigPatch,
  TagTemplateBackfillPreview,
  ViewMode,
} from './types';
import { replaceAllRichTextPatch } from './types';
import type {
  AgentCoreMethod,
  RendererAgentCoreNotification,
  AgentCoreRequestByMethod,
  RendererAgentCoreResponseByMethod,
  ThreadResourceReference,
} from '../../core/agent/protocol';
import type {
  MemoryFeatureMode,
  MemorySettingsView,
  ThreadMemoryMode,
} from '../../core/agent/memory';
import type {
  AutomationMethod,
  AutomationNotification,
  AutomationRequestByMethod,
  AutomationResponseByMethod,
} from '../../core/agent/automation';
import type {
  PreviewAuthorizeLinkedFileResult,
  PreviewForgetLinkedFileResult,
  PreviewListDirectoryResult,
  PreviewReadBytesResult,
  PreviewReadTextResult,
  PreviewResolveSourceResult,
  PreviewTarget,
} from '../../core/preview';
import {
  URL_PAGE_TRANSLATE_COMMAND,
  URL_PAGE_TRANSLATION_CANCEL_COMMAND,
  type UrlPageTranslationCancelResponse,
  type UrlPageTranslationRequest,
  type UrlPageTranslationResponse,
} from '../../core/urlPageTranslation';
import { outlineDocumentApi } from './outlineIntents';

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (window.lin) return window.lin.invoke<T>(name, args);
  return Promise.reject(new Error('Tenon desktop bridge is unavailable'));
}

export class ManagedSkillCommandError extends Error {
  constructor(readonly error: ManagedSkillErrorView) {
    super(error.code);
    this.name = 'ManagedSkillCommandError';
  }
}

export function managedSkillErrorFromUnknown(error: unknown): ManagedSkillErrorView {
  return error instanceof ManagedSkillCommandError ? error.error : { code: 'unexpected_error' };
}

async function managedCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const result = await command<ManagedSkillCommandResult<T>>(name, args);
  if (result.ok) return result.value;
  throw new ManagedSkillCommandError(result.error);
}

function bridge<T>(fn: (lin: NonNullable<typeof window.lin>) => Promise<T>): Promise<T> {
  if (window.lin) return fn(window.lin);
  return Promise.reject(new Error('Tenon desktop bridge is unavailable'));
}

export const api = {
  agentCoreRequest: <Method extends AgentCoreMethod>(
    method: Method,
    input: AgentCoreRequestByMethod[Method],
  ): Promise<RendererAgentCoreResponseByMethod[Method]> => {
    if (window.lin) return window.lin.agentCoreRequest(method, input);
    return Promise.reject(new Error('Tenon desktop bridge is unavailable'));
  },
  /**
   * Configuration changed somewhere — including in the settings window. The
   * dock listens so an Agent renamed or re-skinned in the editor is renamed in
   * the transcript at once, rather than at the next conversation switch.
   */
  onSettingsChanged: (listener: () => void) => (
    window.lin?.onSettingsChanged(listener) ?? (() => undefined)
  ),
  onAgentCoreNotification: (listener: (notification: RendererAgentCoreNotification) => void) => (
    window.lin?.onAgentCoreNotification(listener) ?? (() => undefined)
  ),
  automationRequest: <Method extends AutomationMethod>(
    method: Method,
    input: AutomationRequestByMethod[Method],
  ): Promise<AutomationResponseByMethod[Method]> => bridge((lin) => lin.automationRequest(method, input)),
  onAutomationNotification: (listener: (notification: AutomationNotification) => void) => (
    window.lin?.onAutomationNotification(listener) ?? (() => undefined)
  ),
  ...outlineDocumentApi,
  recordNodeAccess: (nodeId: string) => bridge((lin) => lin.recordNodeAccess(nodeId)),
  // The ingest bridge: copy+freeze an agent working file into the asset store. The
  // path is path-ingested in main but only if it resolves inside the agent's trusted
  // roots (workdir/scratch) -- the same gate that backs previewing these chips -- so
  // this is not the arbitrary-path read the buffer-only rule above guards against.
  // Returns null when the path is not a trusted file (e.g. GC'd working file).
  ingestLocalFileToAsset: (path: string) =>
    command<AssetMetadata | null>('ingest_local_file', { path }),
  ingestThreadResourceToAsset: (threadId: string, resourceRef: ThreadResourceReference) =>
    command<AssetMetadata | null>('ingest_thread_resource', { threadId, resourceRef }),
  lookupAsset: (id: string) => command<AssetMetadata | null>('lookup_asset', { id }),
  pickImageFiles: () => command<AssetMetadata[]>('pick_image_files'),
  pickAttachmentFiles: () => command<AssetMetadata[]>('pick_attachment_files'),
  openAsset: (id: string) => command<{ opened: boolean }>('open_asset', { id }),
  revealAsset: (id: string) => command<{ revealed: boolean }>('reveal_asset', { id }),
  copyAssetFile: (id: string) => command<{ copied: boolean }>('copy_asset_file', { id }),
  openExternalUrl: (url: string) => command<{ opened: boolean }>('open_external_url', { url }),
  translateUrlPageBlocks: (request: UrlPageTranslationRequest) =>
    command<UrlPageTranslationResponse>(URL_PAGE_TRANSLATE_COMMAND, { ...request }),
  cancelUrlPageTranslation: (sessionId: string) =>
    command<UrlPageTranslationCancelResponse>(URL_PAGE_TRANSLATION_CANCEL_COMMAND, { sessionId }),
  resolvePreviewSource: (target: PreviewTarget) =>
    command<PreviewResolveSourceResult>('preview_resolve_source', { target }),
  readPreviewText: (target: PreviewTarget) =>
    command<PreviewReadTextResult>('preview_read_text', { target }),
  readPreviewBytes: (target: PreviewTarget) =>
    command<PreviewReadBytesResult>('preview_read_bytes', { target }),
  listPreviewDirectory: (target: PreviewTarget) =>
    command<PreviewListDirectoryResult>('preview_list_directory', { target }),
  authorizeLinkedFile: (target: Extract<PreviewTarget, { kind: 'linked-file' }>) =>
    command<PreviewAuthorizeLinkedFileResult>('preview_authorize_linked_file', { target }),
  forgetLinkedFile: (target: Extract<PreviewTarget, { kind: 'linked-file' }>) =>
    command<PreviewForgetLinkedFileResult>('preview_forget_linked_file', { target }),
  linkFileSource: (ownerId: string) =>
    command<CommandResult | null>('preview_link_file_source', { ownerId }),
  replaceSourceWithFile: (ownerId: string, sourceValueId: string) =>
    command<CommandResult | null>('preview_replace_source_with_file', { ownerId, sourceValueId }),
  agentGetProviderSettings: () =>
    command<AgentProviderSettingsView>('agent_get_provider_settings'),
  memorySettings: (threadId?: string) =>
    command<MemorySettingsView>('memory_settings_get', threadId ? { threadId } : undefined),
  memorySetFeatureMode: (mode: MemoryFeatureMode) =>
    command<MemorySettingsView>('memory_feature_mode_set', { mode }),
  memorySetThreadMode: (threadId: string, mode: ThreadMemoryMode) =>
    command<MemorySettingsView>('memory_thread_mode_set', { threadId, mode }),
  memoryOpen: () => command<MemorySettingsView>('memory_open'),
  memoryReset: () => command<MemorySettingsView>('memory_reset'),
  agentRefreshProviderModels: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_refresh_provider_models', { providerId }),
  agentUpdateRuntimeSettings: (settings: AgentRuntimeSettingsInput) =>
    command<AgentProviderSettingsView>('agent_update_runtime_settings', { settings }),
  agentUpdateImageGenerationSettings: (settings: AgentImageGenerationSettingsInput) =>
    command<AgentProviderSettingsView>('agent_update_image_generation_settings', { settings }),
  agentGetCapabilitySettings: () =>
    command<AgentCapabilitySettingsView>('agent_get_capability_settings'),
  agentApplyCapabilitySettingsPatch: (patch: AgentCapabilitySettingsPatchInput) =>
    command<AgentCapabilitySettingsView>('agent_apply_capability_settings_patch', { patch }),
  agentAppendCapabilityBlock: (ruleValue: string) =>
    command<AgentCapabilitySettingsView>('agent_append_capability_block', { ruleValue }),
  agentUpsertProviderConfig: (
    provider: AgentProviderConfigInput,
    options?: { probeConnection?: boolean },
  ) => command<AgentProviderSettingsView>('agent_upsert_provider_config', {
    provider,
    probeConnection: options?.probeConnection === true,
  }),
  agentDeleteProviderConfig: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_delete_provider_config', { providerId }),
  agentSetActiveProvider: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_set_active_provider', { providerId }),
  agentSetProviderApiKey: (providerId: string, apiKey: string) =>
    command<AgentProviderSecretStatus>('agent_set_provider_api_key', { providerId, apiKey }),
  agentDeleteProviderApiKey: (providerId: string) =>
    command<AgentProviderSecretStatus>('agent_delete_provider_api_key', { providerId }),
  agentGetProviderSecretStatus: (providerId: string) =>
    command<AgentProviderSecretStatus>('agent_get_provider_secret_status', { providerId }),
  agentGetProviderApiKey: (providerId: string) =>
    bridge((lin) => lin.getProviderApiKey(providerId)),
  agentOAuthLogin: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_oauth_login', { providerId }),
  agentOAuthLogout: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_oauth_logout', { providerId }),
  agentOAuthRespond: (requestId: string, value: string | undefined) =>
    command<void>('agent_oauth_respond', { requestId, value }),
  agentOAuthCancel: (providerId: string) =>
    command<void>('agent_oauth_cancel', { providerId }),
  agentTestProviderConnection: (options: { providerId: string; baseUrl?: string; apiKey?: string }) =>
    command<{ success: boolean; message: string; statusCode?: number }>('agent_test_provider_connection', options),
  agentListAllSkills: () =>
    command<SkillDefinition[]>('agent_list_all_skills'),
  /**
   * Opens the native directory picker. Returns null when the user cancels.
   * `isSkillFolder` means the chosen folder is itself a Skill rather than a
   * folder of Skills, and `nameValid` whether its name can be a Skill identity.
   */
  agentPickSkillDirectory: () =>
    command<{ path: string | null; isSkillFolder?: boolean; nameValid?: boolean }>('agent_pick_skill_directory'),
  agentRevealSkillDirectory: (path: string) =>
    command<{ revealed: boolean }>('agent_reveal_skill_directory', { path }),
  /**
   * The changed paths in an Agent's retained worktree. The renderer names the
   * Agent, never a path: main resolves the directory from the execution record,
   * so no renderer-supplied path can turn these into an arbitrary filesystem
   * read or a Finder window anywhere on disk.
   */
  readAgentWorktreeChanges: (agentId: string) =>
    command<{ available: boolean; paths: readonly string[]; total: number }>(
      'agent_worktree_changes',
      { agentId },
    ),
  revealAgentWorktree: (agentId: string) =>
    command<{ revealed: boolean }>('agent_reveal_worktree', { agentId }),
  agentListUserInvocableSkills: () =>
    command<SkillDefinition[]>('agent_list_all_skills', { userInvocableOnly: true }),
  agentUndoSkillAgentEdit: (skillName: string) =>
    command<SkillDefinition[]>('agent_undo_skill_agent_edit', { skillName }),
  /**
   * The Agents editor's view: every identity the transcript can draw, plus the
   * Roles a user may actually change. `cwd` names the conversation being
   * edited from, so a project's own layer is included; main resolves it and
   * ignores anything that is not a real directory.
   */
  agentIdentityCatalog: (cwd?: string) =>
    command<AgentEditorView>('agent_identity_catalog', { cwd }),
  agentWriteRole: (input: {
    layer: 'user' | 'project';
    cwd?: string;
    /** `create` refuses a name that already exists instead of replacing it. */
    mode: 'create' | 'update';
    role: AgentRoleDraft;
  }) =>
    command<AgentEditorView>('agent_write_role', input),
  agentDeleteRole: (input: { layer: 'user' | 'project'; cwd?: string; name: string }) =>
    command<AgentEditorView>('agent_delete_role', input),
  /**
   * The conversation agent's own configuration — standing instructions and the
   * capability ceiling its Subagents are narrowed from.
   */
  agentWriteProfile: (input: {
    layer: 'user' | 'project';
    cwd?: string;
    name: string;
    profile: AgentProfileDraft;
    /** The same agent's re-skin, applied in the same validated edit. */
    agentType?: string;
    presentation?: { persona?: string; color?: string };
  }) => command<AgentEditorView>('agent_write_profile', input),
  agentWritePresentation: (input: {
    layer: 'user' | 'project';
    cwd?: string;
    agentType: string;
    presentation: { persona?: string; color?: string };
  }) => command<AgentEditorView>('agent_write_presentation', input),
  agentManagedSkillCatalog: () =>
    managedCommand<ManagedSkillCatalogView>('agent_managed_skill_catalog'),
  agentManagedSkillDiscover: (input: { sourceUrl?: string; catalogId?: string }) =>
    managedCommand<ManagedSkillDiscoveryView>('agent_managed_skill_discover', input),
  agentManagedSkillInstall: (input: { discoveryId: string; candidateId: string; expectedCommit: string }) =>
    managedCommand<ManagedSkillView>('agent_managed_skill_install', input),
  agentManagedSkillList: () =>
    managedCommand<ManagedSkillView[]>('agent_managed_skill_list'),
  /**
   * `ambient: true` marks a check the user did not ask for (opening the pane),
   * which main throttles on each record's lastCheckedAt. An explicit "check for
   * updates" leaves it off, because that must always actually check.
   */
  agentManagedSkillCheckUpdates: (skillId?: string, options?: { ambient?: boolean }) =>
    managedCommand<ManagedSkillView[]>('agent_managed_skill_check_updates', {
      ...(skillId ? { skillId } : {}),
      ...(options?.ambient ? { ambient: true } : {}),
    }),
  agentManagedSkillPreviewUpdate: (skillId: string, expectedActiveHash: string) =>
    managedCommand<ManagedSkillUpdatePreviewView>('agent_managed_skill_preview_update', { skillId, expectedActiveHash }),
  agentManagedSkillApplyUpdate: (input: {
    skillId: string;
    previewId: string;
    expectedActiveHash: string;
    expectedCandidateHash: string;
  }) => managedCommand<ManagedSkillView>('agent_managed_skill_apply_update', input),
  agentManagedSkillSetEnabled: (skillId: string, enabled: boolean, expectedActiveHash: string) =>
    managedCommand<ManagedSkillView>('agent_managed_skill_set_enabled', { skillId, enabled, expectedActiveHash }),
  agentManagedSkillRollback: (skillId: string, expectedActiveHash: string, expectedPreviousHash: string) =>
    managedCommand<ManagedSkillView>('agent_managed_skill_rollback', { skillId, expectedActiveHash, expectedPreviousHash }),
  agentManagedSkillUninstall: (skillId: string, expectedActiveHash: string) =>
    managedCommand<ManagedSkillView[]>('agent_managed_skill_uninstall', { skillId, expectedActiveHash }),
};
