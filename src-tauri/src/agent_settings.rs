use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use thiserror::Error;

const PROVIDERS_FILE: &str = "agent-providers.json";
const SECRETS_FILE: &str = "agent-secrets.json";

#[derive(Debug, Error)]
pub enum AgentSettingsError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("failed to resolve app data directory")]
    AppDataDir,
    #[error("providerId is required")]
    ProviderIdRequired,
    #[error("modelId is required")]
    ModelIdRequired,
    #[error("provider not found: {0}")]
    ProviderNotFound(String),
}

impl Serialize for AgentSettingsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AgentSettingsResult<T> = Result<T, AgentSettingsError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProviderConfig {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "baseUrl", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProviderConfigInput {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProviderConfigView {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    pub enabled: bool,
    #[serde(rename = "hasApiKey")]
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProviderSettingsView {
    #[serde(rename = "activeProviderId", skip_serializing_if = "Option::is_none")]
    pub active_provider_id: Option<String>,
    pub providers: Vec<AgentProviderConfigView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProviderSecretStatus {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "hasApiKey")]
    pub has_api_key: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct ProviderConfigFile {
    #[serde(
        rename = "activeProviderId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    active_provider_id: Option<String>,
    #[serde(default)]
    providers: Vec<AgentProviderConfig>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SecretFile {
    #[serde(default)]
    keys: BTreeMap<String, String>,
}

pub fn get_provider_settings(app: &AppHandle) -> AgentSettingsResult<AgentProviderSettingsView> {
    let providers = read_provider_file(app)?;
    let secrets = read_secret_file(app)?;
    Ok(to_settings_view(providers, &secrets))
}

pub fn upsert_provider_config(
    app: &AppHandle,
    input: AgentProviderConfigInput,
) -> AgentSettingsResult<AgentProviderSettingsView> {
    let config = normalize_config(input)?;
    let mut file = read_provider_file(app)?;

    if let Some(existing) = file
        .providers
        .iter_mut()
        .find(|provider| provider.provider_id == config.provider_id)
    {
        *existing = config;
    } else {
        file.providers.push(config);
    }

    file.providers
        .sort_by(|left, right| left.provider_id.cmp(&right.provider_id));

    if file.active_provider_id.is_none() {
        file.active_provider_id = file
            .providers
            .first()
            .map(|provider| provider.provider_id.clone());
    }

    write_provider_file(app, &file)?;
    get_provider_settings(app)
}

pub fn delete_provider_config(
    app: &AppHandle,
    provider_id: String,
) -> AgentSettingsResult<AgentProviderSettingsView> {
    let provider_id = normalize_provider_id(provider_id)?;
    let mut file = read_provider_file(app)?;
    let previous_len = file.providers.len();
    file.providers
        .retain(|provider| provider.provider_id != provider_id);

    if previous_len == file.providers.len() {
        return Err(AgentSettingsError::ProviderNotFound(provider_id));
    }

    if file.active_provider_id.as_deref() == Some(provider_id.as_str()) {
        file.active_provider_id = file
            .providers
            .first()
            .map(|provider| provider.provider_id.clone());
    }

    write_provider_file(app, &file)?;
    let mut secrets = read_secret_file(app)?;
    if secrets.keys.remove(&provider_id).is_some() {
        write_secret_file(app, &secrets)?;
    }
    get_provider_settings(app)
}

pub fn set_active_provider(
    app: &AppHandle,
    provider_id: String,
) -> AgentSettingsResult<AgentProviderSettingsView> {
    let provider_id = normalize_provider_id(provider_id)?;
    let mut file = read_provider_file(app)?;
    if !file
        .providers
        .iter()
        .any(|provider| provider.provider_id == provider_id)
    {
        return Err(AgentSettingsError::ProviderNotFound(provider_id));
    }
    file.active_provider_id = Some(provider_id);
    write_provider_file(app, &file)?;
    get_provider_settings(app)
}

pub fn set_provider_api_key(
    app: &AppHandle,
    provider_id: String,
    api_key: String,
) -> AgentSettingsResult<AgentProviderSecretStatus> {
    let provider_id = normalize_provider_id(provider_id)?;
    let mut secrets = read_secret_file(app)?;
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        secrets.keys.remove(&provider_id);
    } else {
        secrets.keys.insert(provider_id.clone(), api_key.clone());
    }
    write_secret_file(app, &secrets)?;
    Ok(AgentProviderSecretStatus {
        provider_id,
        has_api_key: !api_key.is_empty(),
    })
}

pub fn delete_provider_api_key(
    app: &AppHandle,
    provider_id: String,
) -> AgentSettingsResult<AgentProviderSecretStatus> {
    let provider_id = normalize_provider_id(provider_id)?;
    let mut secrets = read_secret_file(app)?;
    secrets.keys.remove(&provider_id);
    write_secret_file(app, &secrets)?;
    Ok(AgentProviderSecretStatus {
        provider_id,
        has_api_key: false,
    })
}

pub fn get_provider_secret_status(
    app: &AppHandle,
    provider_id: String,
) -> AgentSettingsResult<AgentProviderSecretStatus> {
    let provider_id = normalize_provider_id(provider_id)?;
    let secrets = read_secret_file(app)?;
    Ok(AgentProviderSecretStatus {
        has_api_key: secrets.keys.contains_key(&provider_id),
        provider_id,
    })
}

fn to_settings_view(file: ProviderConfigFile, secrets: &SecretFile) -> AgentProviderSettingsView {
    AgentProviderSettingsView {
        active_provider_id: file.active_provider_id,
        providers: file
            .providers
            .into_iter()
            .map(|provider| AgentProviderConfigView {
                has_api_key: secrets.keys.contains_key(&provider.provider_id),
                provider_id: provider.provider_id,
                model_id: provider.model_id,
                base_url: provider.base_url,
                enabled: provider.enabled,
            })
            .collect(),
    }
}

fn normalize_config(input: AgentProviderConfigInput) -> AgentSettingsResult<AgentProviderConfig> {
    let provider_id = normalize_provider_id(input.provider_id)?;
    let model_id = input.model_id.trim().to_string();
    if model_id.is_empty() {
        return Err(AgentSettingsError::ModelIdRequired);
    }

    let base_url = input.base_url.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    Ok(AgentProviderConfig {
        provider_id,
        model_id,
        base_url,
        enabled: input.enabled,
    })
}

fn normalize_provider_id(provider_id: String) -> AgentSettingsResult<String> {
    let provider_id = provider_id.trim().to_string();
    if provider_id.is_empty() {
        return Err(AgentSettingsError::ProviderIdRequired);
    }
    Ok(provider_id)
}

fn read_provider_file(app: &AppHandle) -> AgentSettingsResult<ProviderConfigFile> {
    read_json_or_default(&provider_file_path(app)?)
}

fn write_provider_file(app: &AppHandle, file: &ProviderConfigFile) -> AgentSettingsResult<()> {
    write_json_file(&provider_file_path(app)?, file, FilePrivacy::Normal)
}

fn read_secret_file(app: &AppHandle) -> AgentSettingsResult<SecretFile> {
    read_json_or_default(&secret_file_path(app)?)
}

fn write_secret_file(app: &AppHandle, file: &SecretFile) -> AgentSettingsResult<()> {
    write_json_file(&secret_file_path(app)?, file, FilePrivacy::Private)
}

fn provider_file_path(app: &AppHandle) -> AgentSettingsResult<PathBuf> {
    Ok(app_data_dir(app)?.join(PROVIDERS_FILE))
}

fn secret_file_path(app: &AppHandle) -> AgentSettingsResult<PathBuf> {
    Ok(app_data_dir(app)?.join(SECRETS_FILE))
}

fn app_data_dir(app: &AppHandle) -> AgentSettingsResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|_| AgentSettingsError::AppDataDir)
}

fn read_json_or_default<T>(path: &Path) -> AgentSettingsResult<T>
where
    T: Default + for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

#[derive(Clone, Copy)]
enum FilePrivacy {
    Normal,
    Private,
}

fn write_json_file<T>(path: &Path, value: &T, privacy: FilePrivacy) -> AgentSettingsResult<()>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        if matches!(privacy, FilePrivacy::Private) {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
    }

    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write(path, &bytes)?;

    #[cfg(unix)]
    if matches!(privacy, FilePrivacy::Private) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)?;
    Ok(())
}
