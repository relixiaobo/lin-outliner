import type { ConfigurationWindowSurface } from '../../core/settingsWindow';

type ConfigurationSender = ConfigurationWindowSurface | 'main' | 'provider-config' | null;
const MODEL_READ = ['agent_get_provider_settings'];
const MODEL_WRITE = ['agent_refresh_provider_models', 'agent_update_image_generation_settings', 'agent_update_model_default',
  'agent_upsert_provider_config', 'agent_delete_provider_config', 'agent_set_active_provider'];
const CREDENTIALS = ['agent_get_provider_secret_status', 'agent_set_provider_api_key', 'agent_delete_provider_api_key',
  'agent_oauth_login', 'agent_oauth_logout', 'agent_oauth_respond', 'agent_oauth_cancel', 'agent_test_provider_connection'];
const SKILLS = ['agent_get_skill_settings', 'agent_update_skill_settings', 'agent_pick_skill_directory',
  'agent_reveal_skill_directory', 'agent_list_all_skills', 'agent_skill_curation_report', 'agent_skill_manage',
  'agent_managed_skill_catalog', 'agent_managed_skill_discover', 'agent_managed_skill_list',
  'agent_managed_skill_check_updates', 'agent_managed_skill_preview_update'];
const SETTINGS_COMMANDS = [...MODEL_READ, ...MODEL_WRITE, ...SKILLS,
  'agent_update_runtime_settings', 'agent_identity_catalog', 'agent_write_profile',
  'agent_get_capability_settings', 'agent_apply_capability_settings_patch', 'agent_append_capability_block',
  'memory_inspect', 'memory_manage', 'memory_enabled_update'];
const COMMANDS: Partial<Record<Exclude<ConfigurationSender, null | 'main'>, readonly string[]>> = {
  // Navigation is presentation inside one trusted renderer. Admission remains an
  // explicit configuration-operation allowlist, never the whole application bridge.
  settings: SETTINGS_COMMANDS,
  'provider-config': [...MODEL_READ, ...MODEL_WRITE, ...CREDENTIALS, 'open_external_url'],
};

/** Fail closed before dispatch, including commands accidentally added to the generic bridge. */
export function configurationCommandAllowed(sender: ConfigurationSender, command: string): boolean {
  if (!sender) return false;
  if (CREDENTIALS.includes(command)) return sender === 'provider-config';
  if (sender === 'main') return true;
  return COMMANDS[sender]?.includes(command) === true;
}

export function isModelConfigurationCommand(command: string): boolean {
  return MODEL_READ.includes(command) || MODEL_WRITE.includes(command) || CREDENTIALS.includes(command);
}
